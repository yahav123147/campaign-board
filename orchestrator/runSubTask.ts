import { loadAgents } from "./loadAgents";
import { spawnAgent } from "./spawnAgent";
import { eventBus } from "./eventBus";
import { getRun, updateRun } from "./runRegistry";
import { getStageDef, getSubTaskDef, stageOutputExcludingFlagged } from "./stageRegistry";
import { appendLog, saveRunArtifact } from "@/lib/runStore";
import { runMiniDiscussion } from "./runMiniDiscussion";
import { runCriticLoopForSubTask } from "./runCriticLoopForSubTask";
import { runStage1Harvest } from "./runStage1Harvest";
import { runStage5LpBuild } from "./runStage5LpBuild";
import { runStage5Preview } from "./runStage5Preview";
import { runStage5Assets } from "./runStage5Assets";
import { runStage7Creatives } from "./runStage7Creatives";
import { runStage8PixelVerify } from "./runStage8PixelVerify";
import { runStage9MetaCampaign } from "./runStage9MetaCampaign";
import type { Run, StageNumber } from "@/types";
import {
  agentTimeoutMs,
  startManagedExecution,
  subTaskExecutionTarget,
  type ExecutionControl,
  type StartManagedExecutionResult,
} from "./executionService";
import type { ExecutionClaimIntent } from "./executionManager";
import { renderClientContext } from "./clientContext";
import { researchPermissionsFor, researchToolsFor } from "./researchTools";

export function startSubTaskExecution(
  runId: string,
  runDir: string,
  stageNumber: StageNumber,
  subTaskId: string,
  feedback?: string,
  claimIntent?: ExecutionClaimIntent,
): Promise<StartManagedExecutionResult> {
  return startManagedExecution(
    subTaskExecutionTarget(runId, stageNumber, subTaskId),
    (control) => runSubTask(runId, runDir, stageNumber, subTaskId, feedback, control),
    undefined,
    claimIntent,
  );
}

export async function runSubTask(
  runId: string,
  runDir: string,
  stageNumber: StageNumber,
  subTaskId: string,
  feedback?: string,
  control?: ExecutionControl,
): Promise<void> {
  control?.throwIfAborted();
  // Stage 5's sub-tasks are not plain text tasks: 5.2 produces real image files
  // and a contact sheet, 5.3 branches the configured workspace and builds the page
  // through design rounds, 5.4 serves it locally and runs the QA gate. Every
  // path that reaches them, the retry button included, hands off to the real
  // executor rather than to a generic agent.
  if (stageNumber === 1 && subTaskId === "1" && getRun(runId)?.pipeline === "direct") return runStage1Harvest(runId, runDir, feedback, control);
  if (stageNumber === 5 && subTaskId === "5.2") return runStage5Assets(runId, runDir, feedback, control);
  if (stageNumber === 5 && subTaskId === "5.3") return runStage5LpBuild(runId, runDir, feedback, control);
  if (stageNumber === 5 && subTaskId === "5.4") return runStage5Preview(runId, runDir, feedback, control);
  if (stageNumber === 7 && subTaskId === "7.5") return runStage7Creatives(runId, runDir, feedback, control);
  // Direct sub-task starts and retries must use the same constrained Stage 8/9
  // executors as stage-level starts. They must never fall through to the
  // generic bypass-permissions agent path.
  if (stageNumber === 8 && subTaskId === "8") return runStage8PixelVerify(runId, runDir, feedback, control);
  if (stageNumber === 9 && subTaskId === "9") return runStage9MetaCampaign(runId, runDir, feedback, control);

  const run = getRun(runId);
  if (!run?.stages) throw new Error("Run or stages missing");

  const stageDef = getStageDef(stageNumber, run.assetType, run.pipeline);
  const subTaskDef = getSubTaskDef(stageNumber, subTaskId, run.assetType, run.pipeline);

  // Mark sub-task running
  const stages = run.stages.map((s) =>
    s.number === stageNumber
      ? {
          ...s,
          status: "running" as const,
          errorMessage: undefined,
          currentSubTaskId: subTaskId,
          subTasks: s.subTasks.map((st) =>
            st.id === subTaskId
              ? {
                  ...st,
                  status: "running" as const,
                  output: "",
                  errorMessage: undefined,
                  startedAt: new Date().toISOString(),
                  feedbackHistory: feedback ? [...st.feedbackHistory, feedback] : st.feedbackHistory,
                  draftOutput: undefined,
                  critiques: undefined,
                  currentPhase: undefined,
                }
              : st,
          ),
        }
      : s,
  );
  updateRun(runId, { stages, currentStage: stageNumber });
  eventBus.emit(runId, { type: "subtask-started", runId, stageNumber, subTaskId });

  // Direct-chain critic-loop path (Task 6/7): one owner plus one scoring critic.
  if (subTaskDef.critic) {
    await runCriticLoopForSubTask(runId, runDir, stageNumber, subTaskId, feedback, control);
    return;
  }

  // Mini-discussion path
  if (subTaskDef.critics && subTaskDef.critics.length > 0) {
    await runMiniDiscussion(runId, runDir, stageNumber, subTaskId, feedback, control);
    return;
  }

  // Plain path: single owner call
  const allAgents = await loadAgents();
  const owner = allAgents.find((a) => a.slug === stageDef.ownerSlug);
  if (!owner) throw new Error(`Owner ${stageDef.ownerSlug} not found`);

  const priorContext = buildPriorContext(run, stageNumber, subTaskId);
  const feedbackBlock = feedback
    ? `\n\n## ⚠️ משוב הלקוח על הריצה הקודמת\n\n> ${feedback}\n\nשפר בהתאם. אסור להתעלם מהמשוב.`
    : "";
  const clientContext = renderClientContext(run.clientProfile);

  const prompt = `${owner.systemPrompt}

---

${clientContext}

---

## ה-Brief המקורי

${run.brief}

---

## מסמך האסטרטגיה

${run.strategyDoc ?? ""}

---

## תוצרים של שלבים קודמים שאושרו

${priorContext}

---

## המשימה שלך

**${subTaskDef.title}**

${subTaskDef.instructions}${feedbackBlock}

תכתוב רק את התוצר. בלי הקדמות.`;

  // Market research and the brand brief are the two turns whose whole job is
  // to bring in something the brief does not already contain.
  const subTaskNeedsResearch = stageNumber === 1
    || (stageNumber === 5 && subTaskId === "5.1");

  const logName = `stage-${stageNumber}-${subTaskId}-${stageDef.ownerSlug}.log`;
  await appendLog(runDir, logName, `# Prompt\n\n${prompt}\n\n# Output\n\n`);

  try {
    const { fullText } = await spawnAgent({
      prompt,
      permissionMode: "default",
      tools: researchToolsFor(subTaskNeedsResearch),
      allowedTools: researchPermissionsFor(subTaskNeedsResearch),
      strictMcpConfig: true,
      settingSources: [],
      disableSlashCommands: true,
      signal: control?.signal,
      timeoutMs: agentTimeoutMs(control),
      onToken: (token) => {
        control?.throwIfAborted();
        eventBus.emit(runId, { type: "subtask-token", runId, stageNumber, subTaskId, token });
        appendLog(runDir, logName, token).catch(() => {});
      },
    });
    control?.throwIfAborted();
    await persistSubTaskFile(runDir, stageNumber, subTaskId, fullText);
    control?.throwIfAborted();
    await markSubTaskAwaitingDecision(runId, stageNumber, subTaskId, fullText);
    eventBus.emit(runId, {
      type: "subtask-completed",
      runId,
      stageNumber,
      subTaskId,
      content: fullText,
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    await markSubTaskError(runId, stageNumber, subTaskId, errorMessage);
    if (!control?.signal.aborted) {
      eventBus.emit(runId, {
        type: "subtask-error",
        runId,
        stageNumber,
        subTaskId,
        errorMessage,
      });
    }
    throw err;
  }
}

export async function markSubTaskAwaitingDecision(
  runId: string,
  stageNumber: StageNumber,
  subTaskId: string,
  output: string,
): Promise<void> {
  const run = getRun(runId);
  if (!run?.stages) return;
  const stages = run.stages.map((s) =>
    s.number === stageNumber
      ? {
          ...s,
          subTasks: s.subTasks.map((st) =>
            st.id === subTaskId
              ? {
                  ...st,
                  status: "awaiting-decision" as const,
                  output,
                  completedAt: new Date().toISOString(),
                  currentPhase: undefined,
                  // כשל קודם באותה תת-משימה לא מציג שגיאה כוזבת ליד תוצר תקין.
                  errorMessage: undefined,
                }
              : st,
          ),
        }
      : s,
  );
  updateRun(runId, { stages });
}

export async function markSubTaskError(
  runId: string,
  stageNumber: StageNumber,
  subTaskId: string,
  errorMessage: string,
): Promise<void> {
  const run = getRun(runId);
  if (!run?.stages) return;
  const stages = run.stages.map((s) =>
    s.number === stageNumber
      ? {
          ...s,
          subTasks: s.subTasks.map((st) =>
            st.id === subTaskId ? { ...st, status: "error" as const, errorMessage } : st,
          ),
        }
      : s,
  );
  updateRun(runId, { stages });
}

export async function persistSubTaskFile(
  runDir: string,
  stageNumber: StageNumber,
  subTaskId: string,
  content: string,
): Promise<void> {
  await saveRunArtifact(runDir, `stage-${stageNumber}/${subTaskId}.md`, content);
}

/**
 * A sub-task flagged excludeFromPage (Task 10: a webinar's thank-you copy)
 * must never reach a later prompt through prior context, exactly like it
 * never reaches the built page. The cross-stage branch below reads through
 * `stageOutputExcludingFlagged` instead of the raw `s.output`; the same-stage
 * branch (an earlier sub-task of the very stage being written) skips flagged
 * ids directly, since it renders one section per sub-task rather than
 * joining a whole stage's output. Either way, the flagged text stays visible
 * only where it belongs: written, critiqued, approved and shown in the run
 * itself.
 */
export function buildPriorContext(
  run: Run,
  stageNumber: StageNumber,
  subTaskId: string,
): string {
  if (!run.stages) return "(אין)";
  const sections: string[] = [];
  for (const s of run.stages) {
    if (s.number > stageNumber) continue;
    if (s.number === stageNumber) {
      // Include earlier approved sub-tasks of the SAME stage.
      const excluded = new Set(
        getStageDef(s.number, run.assetType, run.pipeline).subTasks.filter((def) => def.excludeFromPage).map((def) => def.id),
      );
      for (const st of s.subTasks) {
        if (st.id === subTaskId) break;
        if (excluded.has(st.id)) continue;
        if (st.status === "approved" && st.output) {
          sections.push(`### שלב ${s.number} · ${st.title}\n\n${st.output}`);
        }
      }
      continue;
    }
    if (s.status === "approved") {
      const content = stageOutputExcludingFlagged(run.assetType, s, run.pipeline);
      // The join keeps empty outputs on purpose (it must equal
      // finalizeStageIfComplete), so several empty sub-tasks still give a
      // truthy string of bare separators. Only real content earns a header.
      if (content.split("\n\n---\n\n").some((part) => part.trim())) {
        sections.push(`### שלב ${s.number}: ${s.title}\n\n${content}`);
      }
    }
  }
  return sections.length ? sections.join("\n\n") : "(אין שלבים קודמים)";
}
