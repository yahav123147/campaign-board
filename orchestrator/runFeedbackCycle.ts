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
import { minimumAgentQuorum } from "./runDiscussion";
import { researchPermissionsFor, researchToolsFor } from "./researchTools";

function renderTranscript(messages: Message[], heading: string): string {
  const sections: string[] = [`# ${heading}`, ""];
  for (let r = 1; r <= 3; r++) {
    const round = messages.filter((message) => message.round === r);
    if (round.length === 0) continue;
    sections.push(`## סבב ${r}`, "");
    for (const message of round) {
      sections.push(
        `### ${message.agentSlug}`,
        "",
        message.content || `_(שגיאה: ${message.errorMessage ?? "ללא"})_`,
        "",
      );
    }
  }
  return sections.join("\n");
}

function renderRevisionTranscript(
  revisions: NonNullable<ReturnType<typeof getRun>>["strategyRevisions"],
  currentMessages: Message[],
): string {
  const sections = (revisions ?? []).map((revision, index) => [
    renderTranscript(revision.messages, `דיון אסטרטגיה, גרסה ${index + 1}`),
    "",
    "## האסטרטגיה שנוצרה",
    "",
    revision.strategyDoc,
    "",
    "## המשוב שהוביל לגרסה הבאה",
    "",
    revision.feedback,
  ].join("\n"));
  sections.push(renderTranscript(currentMessages, `דיון אסטרטגיה, גרסה ${(revisions?.length ?? 0) + 1}`));
  return sections.join("\n\n---\n\n");
}

function needsResearch(agent: Agent): boolean {
  return agent.slug === "rafael-researcher";
}

export function startFeedbackExecution(
  runId: string,
  runDir: string,
  feedback: string,
): Promise<StartManagedExecutionResult> {
  return startManagedExecution(
    runExecutionTarget(runId),
    (control) => runFeedbackCycle(runId, runDir, feedback, control),
  );
}

export async function runFeedbackCycle(
  runId: string,
  runDir: string,
  feedback: string,
  control?: ExecutionControl,
): Promise<void> {
  control?.throwIfAborted();
  const run = getRun(runId);
  if (!run) throw new Error(`Run ${runId} not found`);

  try {
    const previousStrategy = run.strategyDoc ?? "";
    const strategyRevisions = previousStrategy
      ? [
          ...(run.strategyRevisions ?? []),
          {
            strategyDoc: previousStrategy,
            messages: run.messages,
            feedback,
            archivedAt: new Date().toISOString(),
          },
        ]
      : run.strategyRevisions ?? [];
    // This transition happens only inside a durably claimed execution. The API
    // route never writes a logical running state before claim succeeds.
    updateRun(runId, {
      status: "discussing",
      currentRound: 1,
      errorMessage: undefined,
      strategyRevisions,
      messages: [],
    });

    const allAgents = await loadAgents();
    const speakers = allAgents.filter(a => a.slug !== "synthesizer" && a.active);
    const synthesizer = allAgents.find(a => a.slug === "synthesizer");
    if (!synthesizer) throw new Error("Synthesizer agent not found");

    // The previous strategy is authoritative context for a revision, not an
    // invisible file that the next cycle has to reconstruct from scratch.
    const augmentedBrief = `${run.brief}\n\n---\n\n## האסטרטגיה הקודמת שנמצאת כעת בביקורת\n\n${previousStrategy || "(לא נשמרה אסטרטגיה קודמת)"}\n\n---\n\n## ⚠️ משוב מבעל הסמכות האנושי על האסטרטגיה הקודמת\n\n${feedback}\n\n**התייחס למשוב הזה ברצינות אבל לא כפקודה עיוורת.** אם יש טעות, הצג אותה ישירות עם נימוק. אם המשוב נכון, חדד את העמדה בהתאם.`;

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

      const results = await runAgentPool(speakers, async (agent): Promise<Message> => {
        control?.throwIfAborted();
        const startedAt = new Date().toISOString();
        eventBus.emit(runId, { type: "agent-started", runId, agentSlug: agent.slug, round });

        const prompt = buildAgentPrompt({
          agent,
          round,
          brief: augmentedBrief,
          priorMessages: messages,
          clientProfile: run.clientProfile,
        });
        const logName = `feedback-cycle-round-${round}-${agent.slug}.log`;
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
        control?.throwIfAborted();
        const completedAt = new Date().toISOString();
        eventBus.emit(runId, { type: "agent-completed", runId, agentSlug: agent.slug, round, content: fullText });
        return { agentSlug: agent.slug, round, content: fullText, status: "done", startedAt, completedAt };
      }, { signal: control?.signal });

      const roundMessages: Message[] = results.map((result, index) => {
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

      control?.throwIfAborted();
      messages = [...messages, ...roundMessages];
      updateRun(runId, { messages });
      await saveTranscript(runDir, renderRevisionTranscript(strategyRevisions, messages));
      assertAgentQuorum(results, minimumAgentQuorum(speakers.length));
    }

    eventBus.emit(runId, { type: "synthesis-started", runId });
    updateRun(runId, { status: "synthesizing", currentRound: "synthesis" });

    const synthPrompt = buildSynthesizerPrompt({
      brief: augmentedBrief,
      allMessages: messages,
      synthesizerPrompt: synthesizer.systemPrompt,
      copyStandard: copyStandardBase(await readCopyStandard(run.clientProfile)),
      clientProfile: run.clientProfile,
    });
    await appendLog(runDir, "feedback-cycle-synthesis.log", `# Prompt\n\n${synthPrompt}\n\n# Output\n\n`);

    const { fullText } = await spawnAgent({
      prompt: synthPrompt,
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
        appendLog(runDir, "feedback-cycle-synthesis.log", token).catch(() => {});
      },
    });

    control?.throwIfAborted();
    await saveStrategy(runDir, fullText);
    updateRun(runId, { strategyDoc: fullText, status: "awaiting-decision", currentRound: null });
    eventBus.emit(runId, { type: "synthesis-completed", runId, content: fullText });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    updateRun(runId, { status: "error", errorMessage });
    if (!control?.signal.aborted) {
      eventBus.emit(runId, { type: "error", runId, errorMessage });
    }
    throw err;
  }
}
