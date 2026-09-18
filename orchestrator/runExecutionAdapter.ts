import type { Run, PersistedExecutionAttempt } from "@/types";
import {
  ensureRunLoaded,
  listRuns,
  mutateRun,
} from "./runRegistry";
import { listRunIds } from "@/lib/runStore";
import {
  executionTargetKey,
  type ExecutionAdapter,
  type ExecutionAdapterClaimResult,
  type ExecutionAttempt,
  type ExecutionClaimIntent,
  type ExecutionMutation,
  type ExecutionSnapshot,
  type ExecutionTarget,
} from "./executionManager";
import {
  applyExecutionClaimIntent,
  executionClaimViolation,
} from "./executionOrder";

const FALLBACK_EXECUTION_ERROR = "הריצה נכשלה. אפשר לנסות להפעיל אותה מחדש.";

function cloneAttempt(attempt: ExecutionAttempt): ExecutionAttempt {
  return { ...attempt };
}

function decodeComponent(value: string): string | undefined {
  if (!value) return undefined;
  try {
    const decoded = decodeURIComponent(value);
    return decoded ? decoded : undefined;
  } catch {
    return undefined;
  }
}

/** Decode only keys that could have been produced by `executionTargetKey`. */
function targetFromKey(key: string): ExecutionTarget | undefined {
  const parts = key.split(":");
  let target: ExecutionTarget;

  if (parts[0] === "run" && parts.length === 2) {
    const runId = decodeComponent(parts[1]);
    if (!runId) return undefined;
    target = { kind: "run", runId };
  } else if (parts[0] === "subtask" && parts.length === 4) {
    const runId = decodeComponent(parts[1]);
    const subTaskId = decodeComponent(parts[3]);
    const stageNumber = Number(parts[2]);
    if (
      !runId
      || !subTaskId
      || !Number.isSafeInteger(stageNumber)
      || stageNumber <= 0
    ) {
      return undefined;
    }
    target = { kind: "subtask", runId, stageNumber, subTaskId };
  } else {
    return undefined;
  }

  try {
    return executionTargetKey(target) === key ? target : undefined;
  } catch {
    return undefined;
  }
}

function isRunningAttempt(value: unknown): value is PersistedExecutionAttempt {
  if (!value || typeof value !== "object") return false;
  const attempt = value as Partial<PersistedExecutionAttempt>;
  return (
    attempt.state === "running"
    && typeof attempt.attemptId === "string"
    && attempt.attemptId.length > 0
    && typeof attempt.ownerId === "string"
    && attempt.ownerId.length > 0
    && (attempt.retrySafety === "safe" || attempt.retrySafety === "review-required")
    && typeof attempt.startedAt === "number"
    && Number.isFinite(attempt.startedAt)
    && typeof attempt.heartbeatAt === "number"
    && Number.isFinite(attempt.heartbeatAt)
    && typeof attempt.leaseExpiresAt === "number"
    && Number.isFinite(attempt.leaseExpiresAt)
    && typeof attempt.deadlineAt === "number"
    && Number.isFinite(attempt.deadlineAt)
  );
}

function projectExecutionError(
  run: Run,
  target: ExecutionTarget,
  attempt: ExecutionAttempt,
): Run {
  const errorMessage = attempt.errorMessage || FALLBACK_EXECUTION_ERROR;

  if (target.kind === "run") {
    return {
      ...run,
      status: "error",
      currentRound: null,
      errorMessage,
    };
  }

  const stageIndex = run.stages?.findIndex(
    (stage) => stage.number === target.stageNumber,
  ) ?? -1;
  if (stageIndex < 0 || !run.stages) {
    throw new Error(
      `Execution target ${executionTargetKey(target)} has no matching stage.`,
    );
  }

  const stage = run.stages[stageIndex];
  const subTaskIndex = stage.subTasks.findIndex(
    (subTask) => subTask.id === target.subTaskId,
  );
  if (subTaskIndex < 0) {
    throw new Error(
      `Execution target ${executionTargetKey(target)} has no matching sub-task.`,
    );
  }

  const subTasks = [...stage.subTasks];
  subTasks[subTaskIndex] = {
    ...subTasks[subTaskIndex],
    status: "error",
    errorMessage,
  };
  const stages = [...run.stages];
  stages[stageIndex] = {
    ...stage,
    ...(stage.status === "running"
      ? { status: "error" as const, errorMessage }
      : {}),
    subTasks,
  };
  return { ...run, stages };
}

/**
 * Durable `ExecutionManager` storage backed by each run's `run.json`.
 * `mutateRun` provides the per-run serialization and does not resolve until
 * the resulting state has been persisted.
 */
export class RunExecutionAdapter implements ExecutionAdapter {
  async tryClaim(
    target: ExecutionTarget,
    attempt: ExecutionAttempt,
    intent?: ExecutionClaimIntent,
  ): Promise<ExecutionAdapterClaimResult> {
    if (attempt.state !== "running") {
      throw new TypeError("A newly claimed execution attempt must be running.");
    }

    const key = executionTargetKey(target);
    const stored = await mutateRun<ExecutionAdapterClaimResult>(target.runId, (run) => {
      if (run.id !== target.runId) {
        throw new Error(
          `Execution target run ${target.runId} does not match loaded run ${run.id}.`,
        );
      }

      const attempts = { ...(run.executionAttempts ?? {}) };
      const active = Object.values(attempts).find(
        (candidate) => candidate.state === "running",
      );
      if (active) {
        return {
          run,
          value: {
            ok: false,
            reason: "already-running",
            activeAttemptId: active.attemptId,
            error: `Execution attempt ${active.attemptId} is already running for this run.`,
          },
        };
      }
      const prepared = applyExecutionClaimIntent(run, target, intent);
      if (!prepared.ok) {
        return {
          run,
          value: {
            ok: false,
            reason: "not-runnable",
            error: prepared.error,
          },
        };
      }
      const orderIssue = executionClaimViolation(prepared.run, target);
      if (orderIssue) {
        return {
          run,
          value: {
            ok: false,
            reason: "not-runnable",
            error: orderIssue,
          },
        };
      }
      if (Object.values(attempts).some(
        (candidate) => candidate.attemptId === attempt.attemptId,
      )) {
        throw new Error(`Attempt id ${attempt.attemptId} was already used for run ${target.runId}.`);
      }

      attempts[key] = cloneAttempt(attempt);
      return {
        run: { ...prepared.run, executionAttempts: attempts },
        value: { ok: true },
      };
    });

    if (!stored) {
      throw new Error(`Cannot claim execution state for missing run ${target.runId}.`);
    }
    return stored;
  }

  async mutate<T>(
    target: ExecutionTarget,
    mutation: (current: ExecutionAttempt | undefined) => ExecutionMutation<T>,
  ): Promise<T> {
    const key = executionTargetKey(target);
    const stored = await mutateRun(target.runId, (run) => {
      if (run.id !== target.runId) {
        throw new Error(
          `Execution target run ${target.runId} does not match loaded run ${run.id}.`,
        );
      }

      const attempts = { ...(run.executionAttempts ?? {}) };
      const current = attempts[key];
      const result = mutation(current ? cloneAttempt(current) : undefined);

      if (
        result.next?.state === "running"
        && (
          current?.state !== "running"
          || current.attemptId !== result.next.attemptId
        )
      ) {
        throw new Error("Running execution attempts must be created through tryClaim.");
      }

      if (result.next) attempts[key] = cloneAttempt(result.next);
      else delete attempts[key];

      let updated: Run = {
        ...run,
        executionAttempts: attempts,
      };
      if (result.next?.state === "error") {
        updated = projectExecutionError(updated, target, result.next);
      }

      return {
        run: updated,
        value: { value: result.value },
      };
    });

    if (!stored) {
      throw new Error(`Cannot mutate execution state for missing run ${target.runId}.`);
    }
    return stored.value;
  }

  async listRunning(): Promise<ExecutionSnapshot[]> {
    const runsById = new Map(listRuns().map((run) => [run.id, run]));
    const persistedIds = await listRunIds();

    for (const id of persistedIds) {
      if (runsById.has(id)) continue;
      const loaded = await ensureRunLoaded(id);
      if (loaded?.id === id) runsById.set(id, loaded);
    }

    const snapshots: ExecutionSnapshot[] = [];
    for (const run of runsById.values()) {
      for (const [key, value] of Object.entries(run.executionAttempts ?? {})) {
        const target = targetFromKey(key);
        if (!target || target.runId !== run.id || !isRunningAttempt(value)) continue;
        snapshots.push({
          target,
          attempt: cloneAttempt(value),
        });
      }
    }
    return snapshots;
  }
}

export const runExecutionAdapter = new RunExecutionAdapter();
