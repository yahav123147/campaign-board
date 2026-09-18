import { randomUUID } from "node:crypto";
import type { PersistedExecutionAttempt } from "@/types";

export type ExecutionTarget =
  | { kind: "run"; runId: string }
  | { kind: "subtask"; runId: string; stageNumber: number; subTaskId: string };

/**
 * A state transition that must be committed in the same durable transaction
 * as the execution claim. Keeping this declarative lets the storage adapter
 * validate the latest run frontier before it changes any review state.
 */
export type ExecutionClaimIntent = {
  kind: "rewind-subtasks-for-feedback";
  stageNumber: number;
  fromSubTaskId: string;
  triggerSubTaskId: string;
  feedback: string;
};

export type ExecutionState = PersistedExecutionAttempt["state"];
export type ExecutionRetrySafety = "safe" | "review-required";
export type ExecutionFailureReason =
  | "execution-error"
  | "lease-expired"
  | "deadline-exceeded"
  | "interrupted";

/** Persist this record in `Run.executionAttempts` under `executionTargetKey`. */
export type ExecutionAttempt = PersistedExecutionAttempt;

export interface ExecutionSnapshot {
  target: ExecutionTarget;
  attempt: ExecutionAttempt;
}

export interface ExecutionMutation<T> {
  next: ExecutionAttempt | undefined;
  value: T;
}

export type ExecutionAdapterClaimResult =
  | { ok: true }
  | {
      ok: false;
      reason: "already-running";
      activeAttemptId: string;
      error: string;
    }
  | {
      ok: false;
      reason: "not-runnable";
      activeAttemptId?: undefined;
      error: string;
    };

/**
 * Storage integration boundary.
 *
 * Every operation must be serialized per run, not merely per target.
 * `tryClaim` must inspect every attempt for the run and durably insert the new
 * attempt in the same transaction only when none is running. `mutate` invokes
 * the callback synchronously against the latest authoritative target attempt
 * and durably persists `next` before resolving. Together these are the atomic
 * primitives used for claims, heartbeats and fencing.
 */
export interface ExecutionAdapter {
  tryClaim(
    target: ExecutionTarget,
    attempt: ExecutionAttempt,
    intent?: ExecutionClaimIntent,
  ): Promise<ExecutionAdapterClaimResult>;
  mutate<T>(
    target: ExecutionTarget,
    mutation: (current: ExecutionAttempt | undefined) => ExecutionMutation<T>,
  ): Promise<T>;
  listRunning(): Promise<ExecutionSnapshot[]>;
}

export interface ExecutionPolicy {
  leaseMs?: number;
  timeoutMs?: number;
  retrySafety?: ExecutionRetrySafety;
}

export interface ExecutionClaim {
  target: ExecutionTarget;
  attempt: ExecutionAttempt;
  signal: AbortSignal;
}

export type ClaimResult =
  | ({ ok: true } & ExecutionClaim)
  | {
      ok: false;
      reason: "already-running";
      activeAttemptId: string;
      error: string;
    }
  | {
      ok: false;
      reason: "not-runnable";
      activeAttemptId?: undefined;
      error: string;
    };

export interface WatchdogTickResult {
  checked: number;
  failed: number;
  fenced: number;
}

type WatchdogMutationOutcome =
  | { outcome: "healthy" }
  | { outcome: "fenced" }
  | {
      outcome: "failed";
      failureReason: "lease-expired" | "deadline-exceeded";
    };

export interface ExecutionManagerOptions {
  now?: () => number;
  makeAttemptId?: () => string;
  ownerId?: string;
  defaultLeaseMs?: number;
  defaultTimeoutMs?: number;
  onWatchdogError?: (error: unknown) => void;
}

interface RegisteredController {
  attemptId: string;
  targetKey: string;
  controller: AbortController;
  heartbeatTimer?: ReturnType<typeof setInterval>;
}

export class ExecutionFencedError extends Error {
  readonly name = "ExecutionFencedError";

  constructor(readonly attemptId: string) {
    super(`Execution attempt ${attemptId} is no longer current.`);
  }
}

export class ExecutionWatchdogError extends Error {
  readonly name = "ExecutionWatchdogError";

  constructor(
    readonly attemptId: string,
    readonly failureReason: "lease-expired" | "deadline-exceeded",
  ) {
    super(
      failureReason === "deadline-exceeded"
        ? `Execution attempt ${attemptId} exceeded its deadline.`
        : `Execution attempt ${attemptId} stopped heartbeating before its lease expired.`,
    );
  }
}

function requirePositiveDuration(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive finite number.`);
  }
  return value;
}

function cloneTarget(target: ExecutionTarget): ExecutionTarget {
  return target.kind === "run"
    ? { kind: "run", runId: target.runId }
    : {
        kind: "subtask",
        runId: target.runId,
        stageNumber: target.stageNumber,
        subTaskId: target.subTaskId,
      };
}

function assertValidTarget(target: ExecutionTarget): void {
  if (!target.runId) throw new TypeError("Execution target requires a runId.");
  if (
    target.kind === "subtask" &&
    (!target.subTaskId || !Number.isInteger(target.stageNumber) || target.stageNumber <= 0)
  ) {
    throw new TypeError("Sub-task execution target is invalid.");
  }
}

export function executionTargetKey(target: ExecutionTarget): string {
  assertValidTarget(target);
  if (target.kind === "run") return `run:${encodeURIComponent(target.runId)}`;
  return [
    "subtask",
    encodeURIComponent(target.runId),
    String(target.stageNumber),
    encodeURIComponent(target.subTaskId),
  ].join(":");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Process-local execution coordinator. Durable truth stays in the adapter;
 * AbortControllers are deliberately process-local and are rebuilt only for
 * attempts claimed by this process.
 */
export class ExecutionManager {
  private readonly now: () => number;
  private readonly makeAttemptId: () => string;
  private readonly ownerId: string;
  private readonly defaultLeaseMs: number;
  private readonly defaultTimeoutMs: number;
  private readonly onWatchdogError: (error: unknown) => void;
  private readonly controllers = new Map<string, RegisteredController>();
  private watchdogTimer?: ReturnType<typeof setInterval>;
  private watchdogTickInFlight = false;

  constructor(
    private readonly adapter: ExecutionAdapter,
    options: ExecutionManagerOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.makeAttemptId = options.makeAttemptId ?? randomUUID;
    this.ownerId = options.ownerId ?? `${process.pid}:${randomUUID()}`;
    this.defaultLeaseMs = requirePositiveDuration(
      options.defaultLeaseMs ?? 90_000,
      "defaultLeaseMs",
    );
    this.defaultTimeoutMs = requirePositiveDuration(
      options.defaultTimeoutMs ?? 30 * 60_000,
      "defaultTimeoutMs",
    );
    this.onWatchdogError = options.onWatchdogError ?? ((error) => console.error(error));
  }

  async claim(
    target: ExecutionTarget,
    policy: ExecutionPolicy = {},
    intent?: ExecutionClaimIntent,
  ): Promise<ClaimResult> {
    assertValidTarget(target);
    const leaseMs = requirePositiveDuration(
      policy.leaseMs ?? this.defaultLeaseMs,
      "leaseMs",
    );
    const timeoutMs = requirePositiveDuration(
      policy.timeoutMs ?? this.defaultTimeoutMs,
      "timeoutMs",
    );
    const now = this.now();
    const attemptId = this.makeAttemptId();
    if (!attemptId) throw new TypeError("makeAttemptId returned an empty id.");

    const attempt: ExecutionAttempt = {
      attemptId,
      ownerId: this.ownerId,
      state: "running",
      retrySafety: policy.retrySafety ?? "safe",
      startedAt: now,
      heartbeatAt: now,
      leaseExpiresAt: Math.min(now + leaseMs, now + timeoutMs),
      deadlineAt: now + timeoutMs,
    };

    const claimed = await this.adapter.tryClaim(target, attempt, intent);

    if (!claimed.ok) {
      return claimed;
    }

    const controller = new AbortController();
    const storedTarget = cloneTarget(target);
    this.registerController(storedTarget, attemptId, controller);
    return {
      ok: true,
      target: storedTarget,
      attempt: { ...attempt },
      signal: controller.signal,
    };
  }

  /**
   * Whether this process is still actively running the attempt: it holds the
   * live AbortController for it. Such an attempt cannot be stale, however far
   * the wall clock jumped, because a dead process cannot reach this code.
   */
  private ownsLiveAttempt(target: ExecutionTarget, attemptId: string): boolean {
    const registered = this.controllers.get(target.runId);
    return registered?.attemptId === attemptId
      && registered.targetKey === executionTargetKey(target);
  }

  async heartbeat(claim: ExecutionClaim): Promise<boolean> {
    const now = this.now();
    const previousLeaseMs = Math.max(
      1,
      claim.attempt.leaseExpiresAt - claim.attempt.heartbeatAt,
    );
    // The lease exists to detect an owner process that died. This process is
    // demonstrably alive, and if it still holds the controller then the agent
    // is alive too: a lapsed lease here means our timers were frozen (machine
    // sleep, or the OS throttling a background process), not a dead attempt.
    // Fencing our own live attempt is what killed real runs (F108).
    const stillOurs = this.ownsLiveAttempt(claim.target, claim.attempt.attemptId);
    const applied = await this.adapter.mutate(claim.target, (current) => {
      if (
        current?.state !== "running" ||
        current.attemptId !== claim.attempt.attemptId
      ) {
        return { next: current, value: false };
      }
      const ours = stillOurs && current.ownerId === this.ownerId;
      // Time the heartbeat timer was frozen for. Give it back, so a sleeping
      // laptop does not consume the attempt's deadline budget.
      const frozenMs = Math.max(0, now - current.heartbeatAt - previousLeaseMs);
      const deadlineAt = current.deadlineAt + frozenMs;
      if (now >= deadlineAt || (now >= current.leaseExpiresAt && !ours)) {
        return { next: current, value: false };
      }
      return {
        next: {
          ...current,
          heartbeatAt: now,
          deadlineAt,
          leaseExpiresAt: Math.min(now + previousLeaseMs, deadlineAt),
        },
        value: true,
      };
    });

    if (!applied) {
      this.abortRegistered(
        claim.target,
        claim.attempt.attemptId,
        new ExecutionFencedError(claim.attempt.attemptId),
      );
      this.releaseRegistered(claim.target, claim.attempt.attemptId);
    }
    return applied;
  }

  async complete(claim: ExecutionClaim): Promise<boolean> {
    try {
      return await this.adapter.mutate(claim.target, (current) => {
        if (current?.state !== "running" || current.attemptId !== claim.attempt.attemptId) {
          return { next: current, value: false };
        }
        return {
          // Successful attempts no longer need a lease record. Removing the
          // exact current id is itself fenced by the comparison above.
          next: undefined,
          value: true,
        };
      });
    } finally {
      this.releaseRegistered(claim.target, claim.attempt.attemptId);
    }
  }

  async fail(
    claim: ExecutionClaim,
    error: unknown,
    failureReason: ExecutionFailureReason = "execution-error",
  ): Promise<boolean> {
    const now = this.now();
    try {
      const applied = await this.adapter.mutate(claim.target, (current) => {
        if (current?.state !== "running" || current.attemptId !== claim.attempt.attemptId) {
          return { next: current, value: false };
        }
        return {
          next: {
            ...current,
            state: "error",
            endedAt: now,
            failureReason,
            errorMessage: errorMessage(error),
          },
          value: true,
        };
      });

      if (applied) this.abortRegistered(claim.target, claim.attempt.attemptId, error);
      return applied;
    } catch (failure) {
      this.abortRegistered(claim.target, claim.attempt.attemptId, failure);
      throw failure;
    } finally {
      this.releaseRegistered(claim.target, claim.attempt.attemptId);
    }
  }

  /** Return the process-local signal only when this exact attempt owns it. */
  signalFor(claim: Pick<ExecutionClaim, "target" | "attempt">): AbortSignal | undefined {
    const registered = this.controllers.get(claim.target.runId);
    return registered?.attemptId === claim.attempt.attemptId
      && registered.targetKey === executionTargetKey(claim.target)
      ? registered.controller.signal
      : undefined;
  }

  /**
   * Start automatic heartbeats for a claimed attempt. The returned function is
   * idempotent and completion/failure also clears the timer.
   */
  startHeartbeat(claim: ExecutionClaim, intervalMs?: number): () => void {
    const key = claim.target.runId;
    const targetKey = executionTargetKey(claim.target);
    const registered = this.controllers.get(key);
    if (
      !registered
      || registered.attemptId !== claim.attempt.attemptId
      || registered.targetKey !== targetKey
    ) {
      throw new ExecutionFencedError(claim.attempt.attemptId);
    }

    const leaseMs = Math.max(
      1,
      claim.attempt.leaseExpiresAt - claim.attempt.heartbeatAt,
    );
    const everyMs = requirePositiveDuration(
      intervalMs ?? Math.max(1, Math.floor(leaseMs / 3)),
      "heartbeat interval",
    );
    if (registered.heartbeatTimer) clearInterval(registered.heartbeatTimer);

    let inFlight = false;
    const timer = setInterval(() => {
      if (inFlight) return;
      inFlight = true;
      void this.heartbeat(claim)
        .catch((error) => {
          this.abortRegistered(claim.target, claim.attempt.attemptId, error);
          this.releaseRegistered(claim.target, claim.attempt.attemptId);
          this.onWatchdogError(error);
        })
        .finally(() => {
          inFlight = false;
        });
    }, everyMs);
    timer.unref?.();
    registered.heartbeatTimer = timer;

    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      const current = this.controllers.get(key);
      if (
        current?.attemptId === claim.attempt.attemptId
        && current.targetKey === targetKey
        && current.heartbeatTimer === timer
      ) {
        clearInterval(timer);
        current.heartbeatTimer = undefined;
      }
    };
  }

  async watchdogTick(): Promise<WatchdogTickResult> {
    const snapshots = await this.adapter.listRunning();
    const now = this.now();
    let failed = 0;
    let fenced = 0;

    for (const snapshot of snapshots) {
      const deadlineExceeded = now >= snapshot.attempt.deadlineAt;
      const leaseExpired = now >= snapshot.attempt.leaseExpiresAt;
      if (!deadlineExceeded && !leaseExpired) continue;

      const applied = await this.adapter.mutate<WatchdogMutationOutcome>(snapshot.target, (current) => {
        if (
          current?.state !== "running" ||
          current.attemptId !== snapshot.attempt.attemptId
        ) {
          return { next: current, value: { outcome: "fenced" as const } };
        }
        // listRunning is only a snapshot. A heartbeat may have renewed the
        // same attempt before this CAS acquired the durable run lock.
        const currentDeadlineExceeded = now >= current.deadlineAt;
        const currentLeaseExpired = now >= current.leaseExpiresAt;
        if (!currentDeadlineExceeded && !currentLeaseExpired) {
          return { next: current, value: { outcome: "healthy" as const } };
        }
        const leaseMs = Math.max(1, current.leaseExpiresAt - current.heartbeatAt);
        const frozenMs = Math.max(0, now - current.heartbeatAt - leaseMs);
        const ours = current.ownerId === this.ownerId
          && this.ownsLiveAttempt(snapshot.target, current.attemptId);
        if (ours && now < current.deadlineAt + frozenMs) {
          const deadlineAt = current.deadlineAt + frozenMs;
          return {
            next: {
              ...current,
              heartbeatAt: now,
              deadlineAt,
              leaseExpiresAt: Math.min(now + leaseMs, deadlineAt),
            },
            value: { outcome: "healthy" as const },
          };
        }
        const failureReason = currentDeadlineExceeded
          ? "deadline-exceeded" as const
          : "lease-expired" as const;
        const watchdogError = new ExecutionWatchdogError(current.attemptId, failureReason);
        return {
          next: {
            ...current,
            state: "error",
            endedAt: now,
            failureReason,
            errorMessage: watchdogError.message,
          },
          value: { outcome: "failed" as const, failureReason },
        };
      });

      if (applied.outcome === "healthy") continue;
      if (applied.outcome === "failed") failed += 1;
      else fenced += 1;
      const watchdogError = new ExecutionWatchdogError(
        snapshot.attempt.attemptId,
        applied.outcome === "failed"
          ? applied.failureReason
          : (deadlineExceeded ? "deadline-exceeded" : "lease-expired"),
      );
      this.abortRegistered(snapshot.target, snapshot.attempt.attemptId, watchdogError);
      this.releaseRegistered(snapshot.target, snapshot.attempt.attemptId);
    }

    return { checked: snapshots.length, failed, fenced };
  }

  startWatchdog(intervalMs = 30_000): boolean {
    requirePositiveDuration(intervalMs, "watchdog interval");
    if (this.watchdogTimer) return false;

    this.watchdogTimer = setInterval(() => {
      if (this.watchdogTickInFlight) return;
      this.watchdogTickInFlight = true;
      void this.watchdogTick()
        .catch(this.onWatchdogError)
        .finally(() => {
          this.watchdogTickInFlight = false;
        });
    }, intervalMs);
    this.watchdogTimer.unref?.();
    return true;
  }

  stopWatchdog(): boolean {
    if (!this.watchdogTimer) return false;
    clearInterval(this.watchdogTimer);
    this.watchdogTimer = undefined;
    return true;
  }

  private registerController(
    target: ExecutionTarget,
    attemptId: string,
    controller: AbortController,
  ): void {
    const key = target.runId;
    const targetKey = executionTargetKey(target);
    const existing = this.controllers.get(key);
    if (
      existing
      && (existing.attemptId !== attemptId || existing.targetKey !== targetKey)
    ) {
      if (existing.heartbeatTimer) clearInterval(existing.heartbeatTimer);
      existing.controller.abort(new ExecutionFencedError(existing.attemptId));
    }
    this.controllers.set(key, { attemptId, targetKey, controller });
  }

  private abortRegistered(
    target: ExecutionTarget,
    attemptId: string,
    reason: unknown,
  ): void {
    const registered = this.controllers.get(target.runId);
    if (
      registered?.attemptId === attemptId
      && registered.targetKey === executionTargetKey(target)
      && !registered.controller.signal.aborted
    ) {
      registered.controller.abort(reason);
    }
  }

  private releaseRegistered(target: ExecutionTarget, attemptId: string): void {
    const key = target.runId;
    const registered = this.controllers.get(key);
    if (
      registered?.attemptId !== attemptId
      || registered.targetKey !== executionTargetKey(target)
    ) return;
    if (registered.heartbeatTimer) clearInterval(registered.heartbeatTimer);
    this.controllers.delete(key);
  }
}
