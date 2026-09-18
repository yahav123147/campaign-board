import { copyStandardBase, readCopyStandard } from "./copyStandard";
import { loadAgents } from "./loadAgents";
import { spawnAgent } from "./spawnAgent";
import { buildAgentPrompt, buildSynthesizerPrompt } from "./promptBuilder";
import { eventBus } from "./eventBus";
import { updateRun, getRun } from "./runRegistry";
import { saveTranscript, saveStrategy, appendLog } from "@/lib/runStore";
import type { Agent, Message, RoundNumber } from "@/types";
import {
  agentTimeoutMs,
  runExecutionTarget,
  startManagedExecution,
  type ExecutionControl,
  type StartManagedExecutionResult,
} from "./executionService";
import { assertAgentQuorum, runAgentPool } from "./agentPool";
import { researchPermissionsFor, researchToolsFor } from "./researchTools";
import type { ClientProfile } from "@/config/clientProfile";

export function minimumAgentQuorum(total: number): number {
  if (!Number.isSafeInteger(total) || total <= 0) throw new RangeError("Agent count must be positive");
  return Math.min(total, Math.max(2, Math.ceil(total * 0.75)));
}

function needsResearch(agent: Agent): boolean {
  return agent.slug === "rafael-researcher";
}

export function startDiscussionExecution(
  runId: string,
  runDir: string,
): Promise<StartManagedExecutionResult> {
  return startManagedExecution(
    runExecutionTarget(runId),
    (control) => runDiscussion(runId, runDir, control),
  );
}

export async function runDiscussion(
  runId: string,
  runDir: string,
  control?: ExecutionControl,
): Promise<void> {
  control?.throwIfAborted();
  const run = getRun(runId);
  if (!run) throw new Error(`Run ${runId} not found`);

  try {
    const allAgents = await loadAgents();
    const speakers = allAgents.filter(a => a.slug !== "synthesizer" && a.active);
    const synthesizer = allAgents.find(a => a.slug === "synthesizer");
    if (!synthesizer) throw new Error("Synthesizer agent not found");

    updateRun(runId, { status: "discussing", currentRound: 1 });

    let messages: Message[] = [];

    const configuredRounds = run.clientProfile?.discussion?.rounds ?? 2;
    // 2 = opening + confrontation (the synthesis converges). A thin client
    // brief needs the adversarial round: in express mode no human sees the
    // strategy before the copy is written (operator decision, 02.09.2026).
    const discussionRounds = [1, 2, 3].slice(0, configuredRounds) as RoundNumber[];
    for (const round of discussionRounds) {
      control?.throwIfAborted();
      eventBus.emit(runId, { type: "round-started", runId, round });
      updateRun(runId, { currentRound: round });

      const roundMessages = await runOneRound({
        runId,
        runDir,
        round,
        brief: run.brief,
        speakers,
        priorMessages: messages,
        clientProfile: run.clientProfile,
        control,
      });

      control?.throwIfAborted();
      messages = [...messages, ...roundMessages];
      updateRun(runId, { messages });
      await persistTranscript(runDir, messages);
    }

    eventBus.emit(runId, { type: "synthesis-started", runId });
    updateRun(runId, { status: "synthesizing", currentRound: "synthesis" });

    const strategyDoc = await runSynthesizer({
      runId,
      runDir,
      brief: run.brief,
      allMessages: messages,
      synthesizer,
      clientProfile: run.clientProfile,
      control,
    });

    control?.throwIfAborted();
    await saveStrategy(runDir, strategyDoc);
    updateRun(runId, { strategyDoc, status: "awaiting-decision", currentRound: null });

    eventBus.emit(runId, { type: "synthesis-completed", runId, content: strategyDoc });
    eventBus.emit(runId, { type: "run-completed", runId });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    updateRun(runId, { status: "error", errorMessage: message });
    if (!control?.signal.aborted) {
      eventBus.emit(runId, { type: "error", runId, errorMessage: message });
    }
    throw err;
  }
}

async function runOneRound(args: {
  runId: string;
  runDir: string;
  round: RoundNumber;
  brief: string;
  speakers: Agent[];
  priorMessages: Message[];
  clientProfile?: ClientProfile;
  control?: ExecutionControl;
}): Promise<Message[]> {
  const { runId, runDir, round, brief, speakers, priorMessages, clientProfile, control } = args;

  const results = await runAgentPool(speakers, async (agent): Promise<Message> => {
    control?.throwIfAborted();
    const startedAt = new Date().toISOString();
    eventBus.emit(runId, { type: "agent-started", runId, agentSlug: agent.slug, round });

    const prompt = buildAgentPrompt({ agent, round, brief, priorMessages, clientProfile });
    const logName = `round-${round}-${agent.slug}.log`;
    await appendLog(runDir, logName, `# Prompt\n\n${prompt}\n\n# Output\n\n`);

    const { fullText } = await spawnAgent({
      prompt,
      permissionMode: "default",
      tools: researchToolsFor(needsResearch(agent)),
      allowedTools: researchPermissionsFor(needsResearch(agent)),
      strictMcpConfig: true,
      settingSources: [],
      disableSlashCommands: true,
      signal: control?.signal,
      timeoutMs: agentTimeoutMs(control),
      onToken: (token) => {
        control?.throwIfAborted();
        eventBus.emit(runId, { type: "agent-token", runId, agentSlug: agent.slug, round, token });
        appendLog(runDir, logName, token).catch(() => {});
      },
    });

    const completedAt = new Date().toISOString();
    control?.throwIfAborted();
    eventBus.emit(runId, {
      type: "agent-completed", runId, agentSlug: agent.slug, round, content: fullText,
    });
    return { agentSlug: agent.slug, round, content: fullText, status: "done", startedAt, completedAt };
  }, { signal: control?.signal });

  const roundMessages = results.map((result, index): Message => {
    if (result.ok) return result.value;
    const agent = speakers[index];
    const errorMessage = result.error instanceof Error ? result.error.message : String(result.error);
    eventBus.emit(runId, {
      type: "agent-completed",
      runId,
      agentSlug: agent.slug,
      round,
      content: "",
      errorMessage,
    });
    return {
      agentSlug: agent.slug,
      round,
      content: "",
      status: "error",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      errorMessage,
    };
  });
  try {
    assertAgentQuorum(results, minimumAgentQuorum(speakers.length));
  } catch (error) {
    const partialMessages = [...priorMessages, ...roundMessages];
    updateRun(runId, { messages: partialMessages });
    await persistTranscript(runDir, partialMessages);
    throw error;
  }
  return roundMessages;
}

async function runSynthesizer(args: {
  runId: string;
  runDir: string;
  brief: string;
  allMessages: Message[];
  synthesizer: Agent;
  clientProfile?: ClientProfile;
  control?: ExecutionControl;
}): Promise<string> {
  const { runId, runDir, brief, allMessages, synthesizer, clientProfile, control } = args;
  control?.throwIfAborted();
  const prompt = buildSynthesizerPrompt({
    brief,
    allMessages,
    synthesizerPrompt: synthesizer.systemPrompt,
    copyStandard: copyStandardBase(await readCopyStandard(clientProfile)),
    clientProfile,
  });
  await appendLog(runDir, "synthesis.log", `# Prompt\n\n${prompt}\n\n# Output\n\n`);

  const { fullText } = await spawnAgent({
    prompt,
    permissionMode: "default",
    tools: [],
    strictMcpConfig: true,
    settingSources: [],
    disableSlashCommands: true,
    signal: control?.signal,
    timeoutMs: agentTimeoutMs(control),
    onToken: (token) => {
      control?.throwIfAborted();
      eventBus.emit(runId, { type: "synthesis-token", runId, token });
      appendLog(runDir, "synthesis.log", token).catch(() => {});
    },
  });

  control?.throwIfAborted();
  return fullText;
}

async function persistTranscript(runDir: string, messages: Message[]): Promise<void> {
  const sections: string[] = [];
  for (let r = 1; r <= 3; r++) {
    const round = messages.filter(m => m.round === r);
    if (round.length === 0) continue;
    sections.push(`# סבב ${r}`, "");
    for (const msg of round) {
      sections.push(`## ${msg.agentSlug}`, "", msg.content || `_(שגיאה: ${msg.errorMessage ?? "ללא"})_`, "");
    }
  }
  await saveTranscript(runDir, sections.join("\n"));
}
