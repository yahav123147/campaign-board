import { getRun, mutateRun, updateRun } from "./runRegistry";
import { getStageDef } from "./stageRegistry";
import { runSubTask } from "./runSubTask";
import { eventBus } from "./eventBus";
import { runStage8PixelVerify } from "./runStage8PixelVerify";
import { runStage9MetaCampaign } from "./runStage9MetaCampaign";
import { stageRequiresExplicitStart } from "./stage89Safety";
import type { StageNumber } from "@/types";
import { saveRunArtifact } from "@/lib/runStore";
import {
  startManagedExecution,
  subTaskExecutionTarget,
  type ExecutionControl,
  type StartManagedExecutionResult,
} from "./executionService";

export function startStageExecution(
  runId: string,
  runDir: string,
  stageNumber: StageNumber,
  feedback?: string,
): Promise<StartManagedExecutionResult> {
  const runForStart = getRun(runId);
  const first = getStageDef(stageNumber, runForStart?.assetType, runForStart?.pipeline).subTasks[0];
  if (!first) throw new Error(`Stage ${stageNumber} has no execution target`);
  return startManagedExecution(
    subTaskExecutionTarget(runId, stageNumber, first.id),
    (control) => runStage(runId, runDir, stageNumber, feedback, control),
  );
}

export async function runStage(
  runId: string,
  runDir: string,
  stageNumber: StageNumber,
  feedback?: string,
  control?: ExecutionControl,
): Promise<void> {
  control?.throwIfAborted();
  const run = getRun(runId);
  if (!run) throw new Error(`Run ${runId} not found`);
  if (!run.stages) throw new Error(`Run ${runId} has no stages initialized`);

  const stageDef = getStageDef(stageNumber, run.assetType, run.pipeline);

  // Mark stage as running and set the first sub-task as the current one
  const stages = run.stages.map((s) =>
    s.number === stageNumber
      ? {
          ...s,
          status: "running" as const,
          startedAt: new Date().toISOString(),
          feedbackHistory: feedback ? [...s.feedbackHistory, feedback] : s.feedbackHistory,
          currentSubTaskId: s.subTasks[0]?.id,
        }
      : s,
  );
  updateRun(runId, { stages, currentStage: stageNumber });
  eventBus.emit(runId, { type: "stage-started", runId, stageNumber });

  // Hand off to specialized executors for stages 8, 9. Stage 5 starts with its
  // brand-brief sub-task and reaches the builder through runSubTask.
  if (stageNumber === 8) return runStage8PixelVerify(runId, runDir, feedback, control);
  if (stageNumber === 9) return runStage9MetaCampaign(runId, runDir, feedback, control);

  // Generic flow: run the first pending sub-task.
  // Subsequent sub-tasks fire on approval (via the per-sub-task decide route).
  const first = stageDef.subTasks[0];
  if (!first) {
    eventBus.emit(runId, {
      type: "stage-error",
      runId,
      stageNumber,
      errorMessage: "No sub-tasks defined",
    });
    return;
  }
  await runSubTask(runId, runDir, stageNumber, first.id, feedback, control);
}

export async function finalizeStageIfComplete(
  runId: string,
  runDir: string,
  stageNumber: StageNumber,
): Promise<void> {
  const finalized = await mutateRun(runId, (run) => {
    const stage = run.stages?.find((candidate) => candidate.number === stageNumber);
    if (!stage || !run.stages || !stage.subTasks.every((task) => task.status === "approved")) {
      return { run, value: null };
    }
    const assembledOutput = stage.subTasks.map((task) => task.output).join("\n\n---\n\n");
    const stages = run.stages.map((candidate) => candidate.number === stageNumber
      ? {
          ...candidate,
          status: "approved" as const,
          output: assembledOutput,
          completedAt: candidate.completedAt ?? new Date().toISOString(),
          currentSubTaskId: undefined,
          errorMessage: undefined,
        }
      : candidate);
    const next = stages.find(
      (candidate) => candidate.status === "pending" && candidate.number > stageNumber,
    );
    return {
      run: { ...run, stages, currentStage: next?.number ?? null },
      value: { assembledOutput, nextStage: next?.number ?? null },
    };
  });
  if (!finalized) return;

  await saveRunArtifact(runDir, `stage-${stageNumber}.md`, finalized.assembledOutput).catch(
    (error) => console.error(`[runStage] failed to save stage ${stageNumber} artifact:`, error),
  );

  eventBus.emit(runId, {
    type: "stage-completed",
    runId,
    stageNumber,
    content: finalized.assembledOutput,
  });

  // Stage 9 is a planning boundary with no external executor. It must be
  // started explicitly by the user and is never chained from Stage 8.
  if (finalized.nextStage) {
    if (stageRequiresExplicitStart(finalized.nextStage)) return;
    const started = await startStageExecution(runId, runDir, finalized.nextStage);
    if (!started.ok) {
      console.warn(`Stage ${finalized.nextStage} did not start: ${started.error}`);
    }
  }
}
