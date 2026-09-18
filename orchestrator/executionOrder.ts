import type { Run, Stage, StageNumber, SubTask } from "@/types";
import type { ExecutionClaimIntent, ExecutionTarget } from "./executionManager";

function isComplete(status: Stage["status"]): boolean {
  return status === "approved" || status === "skipped";
}

function stageByNumber(run: Run, stageNumber: StageNumber): Stage | undefined {
  return run.stages?.find((stage) => stage.number === stageNumber);
}

function earlierStageBlocker(run: Run, stageNumber: StageNumber): Stage | undefined {
  return [...(run.stages ?? [])]
    .filter((stage) => stage.number < stageNumber)
    .sort((a, b) => a.number - b.number)
    .find((stage) => !isComplete(stage.status));
}

function progressedLaterStage(run: Run, stageNumber: StageNumber): Stage | undefined {
  return [...(run.stages ?? [])]
    .filter((stage) => stage.number > stageNumber)
    .sort((a, b) => a.number - b.number)
    .find((stage) => stage.status !== "pending");
}

export function activeExecutionViolation(run: Run): string | undefined {
  const active = Object.values(run.executionAttempts ?? {}).find(
    (attempt) => attempt.state === "running",
  );
  return active
    ? `Execution attempt ${active.attemptId} is still running for this run.`
    : undefined;
}

/**
 * Validate the authoritative stage frontier. `currentStage` is intentionally
 * not consulted: it is a UI cursor and may be stale after recovery, whereas
 * persisted stage statuses describe which dependencies are actually complete.
 */
export function stageOrderViolation(
  run: Run,
  stageNumber: StageNumber,
): string | undefined {
  if (run.status !== "approved") {
    return `Stage ${stageNumber} cannot run while the run is '${run.status}'.`;
  }

  const stage = stageByNumber(run, stageNumber);
  if (!stage) return undefined;

  const earlier = earlierStageBlocker(run, stageNumber);
  if (earlier) {
    return `Stage ${stageNumber} is out of order; stage ${earlier.number} must finish first.`;
  }

  const later = progressedLaterStage(run, stageNumber);
  if (later) {
    return `Stage ${stageNumber} cannot change after stage ${later.number} has progressed.`;
  }
  return undefined;
}

/** Only the first non-complete sub-task in the current stage may be acted on. */
export function subTaskOrderViolation(
  run: Run,
  stageNumber: StageNumber,
  subTaskId: string,
): string | undefined {
  const stageIssue = stageOrderViolation(run, stageNumber);
  if (stageIssue) return stageIssue;

  const stage = stageByNumber(run, stageNumber);
  const targetIndex = stage?.subTasks.findIndex((task) => task.id === subTaskId) ?? -1;
  if (!stage || targetIndex < 0) return undefined;

  const earlier = stage.subTasks
    .slice(0, targetIndex)
    .find((task) => !isComplete(task.status));
  if (earlier) {
    return `SubTask ${subTaskId} is out of order; ${earlier.id} must finish first.`;
  }

  const later = stage.subTasks
    .slice(targetIndex + 1)
    .find((task) => task.status !== "pending");
  if (later) {
    return `SubTask ${subTaskId} cannot change after ${later.id} has progressed.`;
  }
  return undefined;
}

/**
 * Reopening deliberately invalidates this task and later tasks in its stage.
 * It is safe only before any later stage has started, otherwise downstream
 * approved output would silently remain based on stale inputs.
 */
export function reopenOrderViolation(
  run: Run,
  stageNumber: StageNumber,
  subTaskId: string,
): string | undefined {
  if (run.status !== "approved") {
    return `SubTask ${subTaskId} cannot reopen while the run is '${run.status}'.`;
  }

  const stage = stageByNumber(run, stageNumber);
  const targetIndex = stage?.subTasks.findIndex((task) => task.id === subTaskId) ?? -1;
  if (!stage || targetIndex < 0) return undefined;

  const earlierStage = earlierStageBlocker(run, stageNumber);
  if (earlierStage) {
    return `SubTask ${subTaskId} cannot reopen before stage ${earlierStage.number} finishes.`;
  }

  const laterStage = progressedLaterStage(run, stageNumber);
  if (laterStage) {
    return `SubTask ${subTaskId} cannot reopen after stage ${laterStage.number} has progressed.`;
  }

  const earlierTask: SubTask | undefined = stage.subTasks
    .slice(0, targetIndex)
    .find((task) => !isComplete(task.status));
  if (earlierTask) {
    return `SubTask ${subTaskId} cannot reopen before ${earlierTask.id} finishes.`;
  }
  return undefined;
}

/** Re-check the latest frontier inside the same transaction that stores a claim. */
export function executionClaimViolation(
  run: Run,
  target: ExecutionTarget,
): string | undefined {
  if (target.kind === "run") {
    if (run.stages?.length) {
      return "Run-level execution is no longer available after stages were initialized.";
    }
    return ["pending", "awaiting-decision", "error"].includes(run.status)
      ? undefined
      : `Run-level execution cannot start while the run is '${run.status}'.`;
  }

  const orderIssue = subTaskOrderViolation(
    run,
    target.stageNumber as StageNumber,
    target.subTaskId,
  );
  if (orderIssue) return orderIssue;

  const task = stageByNumber(run, target.stageNumber as StageNumber)
    ?.subTasks.find((candidate) => candidate.id === target.subTaskId);
  if (!task) {
    return `Execution target ${target.subTaskId} does not exist in stage ${target.stageNumber}.`;
  }
  return ["pending", "awaiting-decision", "error"].includes(task.status)
    ? undefined
    : `SubTask ${target.subTaskId} cannot start while it is '${task.status}'.`;
}

export type ApplyExecutionClaimIntentResult =
  | { ok: true; run: Run }
  | { ok: false; error: string };

function resetSubTaskForFeedback(
  task: SubTask,
  feedback?: string,
): SubTask {
  return {
    ...task,
    status: "pending",
    output: "",
    startedAt: undefined,
    completedAt: undefined,
    errorMessage: undefined,
    draftOutput: undefined,
    critiques: undefined,
    currentPhase: undefined,
    assetManifestSha256: undefined,
    assetManifestDraftSha256: undefined,
    assetContactSheetFile: undefined,
    assetContactSheetSha256: undefined,
    preparedAssetHashes: undefined,
    pageSourceHashes: undefined,
    landingHeadSha: undefined,
    landingCommitSha: undefined,
    pageSlug: undefined,
    landingWorktreePath: undefined,
    qaVerification: undefined,
    metaVerification: undefined,
    imageMapCheck: undefined,
    feedbackHistory: feedback
      ? [...task.feedbackHistory, feedback]
      : task.feedbackHistory,
  };
}

/**
 * Prepare a feedback-driven rewind against the same authoritative snapshot
 * that will receive the claim. No caller-visible review state changes unless
 * the adapter subsequently stores the returned run and attempt together.
 */
export function applyExecutionClaimIntent(
  run: Run,
  target: ExecutionTarget,
  intent?: ExecutionClaimIntent,
): ApplyExecutionClaimIntentResult {
  if (!intent) return { ok: true, run };

  if (intent.kind !== "rewind-subtasks-for-feedback") {
    return { ok: false, error: "Unsupported execution claim intent." };
  }

  if (
    target.kind !== "subtask"
    || target.stageNumber !== intent.stageNumber
    || target.subTaskId !== intent.fromSubTaskId
  ) {
    return {
      ok: false,
      error: "Feedback rewind does not match the claimed execution target.",
    };
  }

  const feedback = intent.feedback.trim();
  if (!feedback) {
    return { ok: false, error: "Feedback rewind requires non-empty feedback." };
  }

  const stage = stageByNumber(run, intent.stageNumber as StageNumber);
  if (!stage) {
    return {
      ok: false,
      error: `Feedback rewind stage ${intent.stageNumber} does not exist.`,
    };
  }

  const fromIndex = stage.subTasks.findIndex(
    (task) => task.id === intent.fromSubTaskId,
  );
  const triggerIndex = stage.subTasks.findIndex(
    (task) => task.id === intent.triggerSubTaskId,
  );
  if (fromIndex < 0 || triggerIndex < 0 || fromIndex >= triggerIndex) {
    return {
      ok: false,
      error: "Feedback rewind must target an earlier sub-task in the same stage.",
    };
  }

  const orderIssue = subTaskOrderViolation(
    run,
    intent.stageNumber as StageNumber,
    intent.triggerSubTaskId,
  );
  if (orderIssue) return { ok: false, error: orderIssue };

  const trigger = stage.subTasks[triggerIndex];
  if (!["pending", "awaiting-decision", "error"].includes(trigger.status)) {
    return {
      ok: false,
      error: `SubTask ${intent.triggerSubTaskId} cannot accept feedback while it is '${trigger.status}'.`,
    };
  }

  const stages = run.stages?.map((candidate) => {
    if (candidate.number !== intent.stageNumber) return candidate;
    return {
      ...candidate,
      status: "pending" as const,
      output: "",
      startedAt: undefined,
      completedAt: undefined,
      errorMessage: undefined,
      currentSubTaskId: undefined,
      subTasks: candidate.subTasks.map((task, index) => (
        index < fromIndex
          ? task
          : resetSubTaskForFeedback(
              task,
              index === triggerIndex ? feedback : undefined,
            )
      )),
    };
  });

  return {
    ok: true,
    run: {
      ...run,
      stages,
      currentStage: intent.stageNumber as StageNumber,
    },
  };
}
