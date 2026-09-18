import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ExecutionManager,
  type ExecutionAdapter,
  type ExecutionAdapterClaimResult,
  type ExecutionAttempt,
  type ExecutionMutation,
  type ExecutionSnapshot,
  type ExecutionTarget,
  executionTargetKey,
} from "@/orchestrator/executionManager";

class MemoryExecutionAdapter implements ExecutionAdapter {
  readonly attempts = new Map<string, ExecutionAttempt>();
  private readonly queues = new Map<string, Promise<void>>();

  async tryClaim(
    target: ExecutionTarget,
    attempt: ExecutionAttempt,
  ): Promise<ExecutionAdapterClaimResult> {
    return this.serialize(target.runId, () => {
      const sameRun = [...this.attempts.entries()].filter(
        ([key]) => targetFromKey(key).runId === target.runId,
      );
      const active = sameRun.find(([, candidate]) => candidate.state === "running")?.[1];
      if (active) {
        return {
          ok: false,
          reason: "already-running",
          activeAttemptId: active.attemptId,
          error: "already running",
        };
      }
      if (sameRun.some(([, candidate]) => candidate.attemptId === attempt.attemptId)) {
        throw new Error(`duplicate attempt id ${attempt.attemptId}`);
      }
      this.attempts.set(executionTargetKey(target), structuredClone(attempt));
      return { ok: true };
    });
  }

  async mutate<T>(
    target: ExecutionTarget,
    mutation: (current: ExecutionAttempt | undefined) => ExecutionMutation<T>,
  ): Promise<T> {
    return this.serialize(target.runId, () => {
      const key = executionTargetKey(target);
      const result = mutation(this.attempts.get(key));
      if (result.next) this.attempts.set(key, structuredClone(result.next));
      else this.attempts.delete(key);
      return result.value;
    });
  }

  private async serialize<T>(runId: string, operation: () => T): Promise<T> {
    const previous = this.queues.get(runId) ?? Promise.resolve();
    let release!: () => void;
    const currentTurn = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => {}).then(() => currentTurn);
    this.queues.set(runId, tail);
    await previous.catch(() => {});

    try {
      return operation();
    } finally {
      release();
      if (this.queues.get(runId) === tail) this.queues.delete(runId);
    }
  }

  async listRunning(): Promise<ExecutionSnapshot[]> {
    return [...this.attempts.entries()]
      .filter(([, attempt]) => attempt.state === "running")
      .map(([key, attempt]) => ({
        target: targetFromKey(key),
        attempt: structuredClone(attempt),
      }));
  }
}

function targetFromKey(key: string): ExecutionTarget {
  const [kind, runId, stageNumber, subTaskId] = key.split(":");
  return kind === "run"
    ? { kind: "run", runId: decodeURIComponent(runId) }
    : {
        kind: "subtask",
        runId: decodeURIComponent(runId),
        stageNumber: Number(stageNumber),
        subTaskId: decodeURIComponent(subTaskId),
      };
}

const runTarget: ExecutionTarget = { kind: "run", runId: "run-1" };
const subTaskTarget: ExecutionTarget = {
  kind: "subtask",
  runId: "run-1",
  stageNumber: 5,
  subTaskId: "5.3",
};

function managerAt(adapter: ExecutionAdapter, time: { now: number }) {
  let sequence = 0;
  return new ExecutionManager(adapter, {
    now: () => time.now,
    makeAttemptId: () => `attempt-${++sequence}`,
    ownerId: "test-process",
    defaultLeaseMs: 1_000,
    defaultTimeoutMs: 10_000,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ExecutionManager claim and fencing", () => {
  it("atomically allows only one active attempt for the same target", async () => {
    const adapter = new MemoryExecutionAdapter();
    const time = { now: 1_000 };
    const manager = managerAt(adapter, time);

    const [first, second] = await Promise.all([
      manager.claim(subTaskTarget),
      manager.claim(subTaskTarget),
    ]);

    expect([first.ok, second.ok].sort()).toEqual([false, true]);
    const accepted = first.ok ? first : second.ok ? second : undefined;
    const rejected = first.ok ? second : first;
    expect(accepted?.attempt.attemptId).toBe("attempt-1");
    expect(rejected).toMatchObject({
      ok: false,
      reason: "already-running",
      activeAttemptId: "attempt-1",
    });
  });

  it("atomically allows only one active attempt across different targets in one run", async () => {
    const adapter = new MemoryExecutionAdapter();
    const manager = managerAt(adapter, { now: 1_000 });

    const [run, subTask] = await Promise.all([
      manager.claim(runTarget),
      manager.claim(subTaskTarget),
    ]);

    expect([run.ok, subTask.ok].sort()).toEqual([false, true]);
    const accepted = run.ok ? run : subTask.ok ? subTask : undefined;
    const rejected = run.ok ? subTask : run;
    expect(rejected).toMatchObject({
      ok: false,
      reason: "already-running",
      activeAttemptId: accepted?.attempt.attemptId,
    });
    expect(
      [...adapter.attempts.values()].filter((attempt) => attempt.state === "running"),
    ).toHaveLength(1);
  });

  it("allows active attempts for different runs", async () => {
    const adapter = new MemoryExecutionAdapter();
    const manager = managerAt(adapter, { now: 1_000 });

    const [first, second] = await Promise.all([
      manager.claim(runTarget),
      manager.claim({ ...runTarget, runId: "run-2" }),
    ]);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
  });

  it("persists lease, deadline, owner and attempt metadata at claim time", async () => {
    const adapter = new MemoryExecutionAdapter();
    const manager = managerAt(adapter, { now: 5_000 });

    const claim = await manager.claim(subTaskTarget, {
      leaseMs: 2_000,
      timeoutMs: 20_000,
      retrySafety: "review-required",
    });

    expect(claim.ok).toBe(true);
    expect(adapter.attempts.get(executionTargetKey(subTaskTarget))).toMatchObject({
      attemptId: "attempt-1",
      ownerId: "test-process",
      state: "running",
      retrySafety: "review-required",
      startedAt: 5_000,
      heartbeatAt: 5_000,
      leaseExpiresAt: 7_000,
      deadlineAt: 25_000,
    });
  });

  it("heartbeats only the current attempt and never extends beyond its deadline", async () => {
    const adapter = new MemoryExecutionAdapter();
    const time = { now: 1_000 };
    const manager = managerAt(adapter, time);
    const claim = await manager.claim(subTaskTarget, { leaseMs: 2_000, timeoutMs: 5_000 });
    if (!claim.ok) throw new Error("claim failed");

    time.now = 2_500;
    await expect(manager.heartbeat(claim)).resolves.toBe(true);
    expect(adapter.attempts.get(executionTargetKey(subTaskTarget))).toMatchObject({
      heartbeatAt: 2_500,
      leaseExpiresAt: 4_500,
      deadlineAt: 6_000,
    });

    time.now = 4_499;
    await expect(manager.heartbeat(claim)).resolves.toBe(true);
    expect(adapter.attempts.get(executionTargetKey(subTaskTarget))?.leaseExpiresAt).toBe(6_000);
  });

  it("fences late completion and heartbeat from an older attempt", async () => {
    const adapter = new MemoryExecutionAdapter();
    const time = { now: 1_000 };
    const manager = managerAt(adapter, time);
    const first = await manager.claim(subTaskTarget);
    if (!first.ok) throw new Error("claim failed");

    await expect(manager.fail(first, new Error("first failed"))).resolves.toBe(true);
    time.now = 2_000;
    const second = await manager.claim(subTaskTarget);
    if (!second.ok) throw new Error("second claim failed");

    await expect(manager.complete(first)).resolves.toBe(false);
    await expect(manager.heartbeat(first)).resolves.toBe(false);
    expect(adapter.attempts.get(executionTargetKey(subTaskTarget))).toMatchObject({
      attemptId: second.attempt.attemptId,
      state: "running",
      heartbeatAt: 2_000,
    });
  });

  it("releases the exact controller when an attempt completes", async () => {
    const adapter = new MemoryExecutionAdapter();
    const manager = managerAt(adapter, { now: 1_000 });
    const claim = await manager.claim(subTaskTarget);
    if (!claim.ok) throw new Error("claim failed");

    expect(manager.signalFor(claim)).toBe(claim.signal);
    await expect(manager.complete(claim)).resolves.toBe(true);
    expect(manager.signalFor(claim)).toBeUndefined();
    expect(claim.signal.aborted).toBe(false);
    expect(adapter.attempts.has(executionTargetKey(subTaskTarget))).toBe(false);
  });

  it("releases the controller in finally when completion persistence fails", async () => {
    const adapter = new MemoryExecutionAdapter();
    const manager = managerAt(adapter, { now: 1_000 });
    const claim = await manager.claim(subTaskTarget);
    if (!claim.ok) throw new Error("claim failed");
    vi.spyOn(adapter, "mutate").mockRejectedValueOnce(new Error("disk unavailable"));

    await expect(manager.complete(claim)).rejects.toThrow("disk unavailable");

    expect(manager.signalFor(claim)).toBeUndefined();
    expect(adapter.attempts.get(executionTargetKey(subTaskTarget))?.state).toBe("running");
  });

  it("aborts and releases the controller in finally when failure persistence fails", async () => {
    const adapter = new MemoryExecutionAdapter();
    const manager = managerAt(adapter, { now: 1_000 });
    const claim = await manager.claim(subTaskTarget);
    if (!claim.ok) throw new Error("claim failed");
    vi.spyOn(adapter, "mutate").mockRejectedValueOnce(new Error("disk unavailable"));

    await expect(manager.fail(claim, new Error("worker failed"))).rejects.toThrow("disk unavailable");

    expect(claim.signal.aborted).toBe(true);
    expect(manager.signalFor(claim)).toBeUndefined();
    expect(adapter.attempts.get(executionTargetKey(subTaskTarget))?.state).toBe("running");
  });

  it("starts and stops automatic heartbeats for the exact claim", async () => {
    vi.useFakeTimers();
    const adapter = new MemoryExecutionAdapter();
    const time = { now: 1_000 };
    const manager = managerAt(adapter, time);
    const claim = await manager.claim(subTaskTarget, { leaseMs: 900, timeoutMs: 10_000 });
    if (!claim.ok) throw new Error("claim failed");

    const stop = manager.startHeartbeat(claim, 100);
    time.now = 1_100;
    await vi.advanceTimersByTimeAsync(100);
    expect(adapter.attempts.get(executionTargetKey(subTaskTarget))).toMatchObject({
      heartbeatAt: 1_100,
      leaseExpiresAt: 2_000,
    });

    stop();
    time.now = 1_500;
    await vi.advanceTimersByTimeAsync(300);
    expect(adapter.attempts.get(executionTargetKey(subTaskTarget))?.heartbeatAt).toBe(1_100);
  });
});

describe("ExecutionManager watchdog", () => {
  it("marks an expired lease as error and aborts its registered controller", async () => {
    const adapter = new MemoryExecutionAdapter();
    const time = { now: 1_000 };
    const manager = managerAt(adapter, time);
    const claim = await manager.claim(subTaskTarget, { leaseMs: 1_000, timeoutMs: 10_000 });
    if (!claim.ok) throw new Error("claim failed");
    // The owner process is gone, which is the only thing an expired lease
    // proves. An attempt this process is still running is covered below (F108).
    const ownerlessKey = executionTargetKey(subTaskTarget);
    adapter.attempts.set(ownerlessKey, {
      ...adapter.attempts.get(ownerlessKey)!,
      ownerId: "dead-process",
    });

    time.now = 2_001;
    const result = await manager.watchdogTick();

    expect(result).toEqual({ checked: 1, failed: 1, fenced: 0 });
    expect(adapter.attempts.get(executionTargetKey(subTaskTarget))).toMatchObject({
      attemptId: claim.attempt.attemptId,
      state: "error",
      failureReason: "lease-expired",
      endedAt: 2_001,
    });
    expect(claim.signal.aborted).toBe(true);
  });

  it("uses deadline-exceeded when both the deadline and lease are stale", async () => {
    const adapter = new MemoryExecutionAdapter();
    const time = { now: 1_000 };
    const manager = managerAt(adapter, time);
    const claim = await manager.claim(runTarget, { leaseMs: 5_000, timeoutMs: 1_000 });
    if (!claim.ok) throw new Error("claim failed");

    time.now = 2_001;
    await manager.watchdogTick();

    expect(adapter.attempts.get(executionTargetKey(runTarget))).toMatchObject({
      state: "error",
      failureReason: "deadline-exceeded",
    });
  });

  it("does not mark a replacement attempt from a stale watchdog snapshot", async () => {
    const adapter = new MemoryExecutionAdapter();
    const time = { now: 1_000 };
    const manager = managerAt(adapter, time);
    const first = await manager.claim(subTaskTarget, { leaseMs: 500, timeoutMs: 10_000 });
    if (!first.ok) throw new Error("claim failed");

    time.now = 2_000;
    const replacement: ExecutionAttempt = {
      ...first.attempt,
      attemptId: "replacement",
      heartbeatAt: 2_000,
      leaseExpiresAt: 3_000,
      deadlineAt: 12_000,
    };
    const originalList = adapter.listRunning.bind(adapter);
    adapter.listRunning = async () => {
      const stale = await originalList();
      adapter.attempts.set(executionTargetKey(subTaskTarget), replacement);
      return stale;
    };

    const result = await manager.watchdogTick();

    expect(result).toEqual({ checked: 1, failed: 0, fenced: 1 });
    expect(adapter.attempts.get(executionTargetKey(subTaskTarget))).toEqual(replacement);
    expect(first.signal.aborted).toBe(true);
  });

  it("does not expire the same attempt when a heartbeat renewed a stale snapshot", async () => {
    const adapter = new MemoryExecutionAdapter();
    const time = { now: 1_000 };
    const manager = managerAt(adapter, time);
    const claim = await manager.claim(subTaskTarget, { leaseMs: 500, timeoutMs: 10_000 });
    if (!claim.ok) throw new Error("claim failed");

    time.now = 2_000;
    const originalList = adapter.listRunning.bind(adapter);
    adapter.listRunning = async () => {
      const stale = await originalList();
      const key = executionTargetKey(subTaskTarget);
      adapter.attempts.set(key, {
        ...adapter.attempts.get(key)!,
        heartbeatAt: 2_000,
        leaseExpiresAt: 2_500,
      });
      return stale;
    };

    await expect(manager.watchdogTick()).resolves.toEqual({ checked: 1, failed: 0, fenced: 0 });
    expect(adapter.attempts.get(executionTargetKey(subTaskTarget))).toMatchObject({
      state: "running",
      heartbeatAt: 2_000,
      leaseExpiresAt: 2_500,
    });
    expect(claim.signal.aborted).toBe(false);
  });

  it("keeps healthy attempts running", async () => {
    const adapter = new MemoryExecutionAdapter();
    const time = { now: 1_000 };
    const manager = managerAt(adapter, time);
    const claim = await manager.claim(subTaskTarget, { leaseMs: 2_000, timeoutMs: 10_000 });
    if (!claim.ok) throw new Error("claim failed");

    time.now = 2_000;
    expect(await manager.watchdogTick()).toEqual({ checked: 1, failed: 0, fenced: 0 });
    expect(adapter.attempts.get(executionTargetKey(subTaskTarget))?.state).toBe("running");
    expect(claim.signal.aborted).toBe(false);
  });

  it("starts once, ticks with an injected clock, and stops cleanly", async () => {
    vi.useFakeTimers();
    const adapter = new MemoryExecutionAdapter();
    const time = { now: 1_000 };
    const manager = managerAt(adapter, time);
    const claim = await manager.claim(subTaskTarget, { leaseMs: 500, timeoutMs: 10_000 });
    if (!claim.ok) throw new Error("claim failed");

    const abandonedKey = executionTargetKey(subTaskTarget);
    adapter.attempts.set(abandonedKey, {
      ...adapter.attempts.get(abandonedKey)!,
      ownerId: "dead-process",
    });
    expect(manager.startWatchdog(100)).toBe(true);
    expect(manager.startWatchdog(100)).toBe(false);
    time.now = 2_000;
    await vi.advanceTimersByTimeAsync(100);

    expect(adapter.attempts.get(executionTargetKey(subTaskTarget))?.state).toBe("error");
    expect(manager.stopWatchdog()).toBe(true);
    expect(manager.stopWatchdog()).toBe(false);
  });
});

describe("machine sleep does not kill a live attempt (F108)", () => {
  function managerWithClock(adapter: ExecutionAdapter, clock: { wall: number }) {
    let sequence = 0;
    return new ExecutionManager(adapter, {
      now: () => clock.wall,
      makeAttemptId: () => `attempt-${++sequence}`,
      ownerId: "test-process",
      defaultLeaseMs: 1_000,
      defaultTimeoutMs: 10_000,
    });
  }

  async function running(adapter: MemoryExecutionAdapter, clock: { wall: number }) {
    const manager = managerWithClock(adapter, clock);
    const claim = await manager.claim(subTaskTarget);
    if (!claim.ok) throw new Error("claim failed");
    return { manager, claim };
  }

  it("renews a lapsed lease while this process is still running the attempt", async () => {
    const adapter = new MemoryExecutionAdapter();
    const clock = { wall: 1_000 };
    const { manager, claim } = await running(adapter, clock);

    // The machine sleeps: no heartbeat fires and the wall clock jumps past the lease.
    clock.wall += 5_000;

    expect(await manager.heartbeat(claim)).toBe(true);
    const stored = adapter.attempts.get(executionTargetKey(subTaskTarget))!;
    expect(stored.state).toBe("running");
    expect(stored.leaseExpiresAt).toBeGreaterThan(clock.wall);
  });

  it("gives back the frozen time instead of spending the attempt's deadline", async () => {
    const adapter = new MemoryExecutionAdapter();
    const clock = { wall: 1_000 };
    const { manager, claim } = await running(adapter, clock);
    const deadlineBefore = adapter.attempts.get(executionTargetKey(subTaskTarget))!.deadlineAt;

    clock.wall += 50_000;

    expect(await manager.heartbeat(claim)).toBe(true);
    const stored = adapter.attempts.get(executionTargetKey(subTaskTarget))!;
    // 50s passed with a 1s lease, so 49s of it were frozen and are returned.
    expect(stored.deadlineAt).toBe(deadlineBefore + 49_000);
  });

  it("still fences when the durable owner is a different process", async () => {
    const adapter = new MemoryExecutionAdapter();
    const clock = { wall: 1_000 };
    const { manager, claim } = await running(adapter, clock);
    const key = executionTargetKey(subTaskTarget);
    adapter.attempts.set(key, { ...adapter.attempts.get(key)!, ownerId: "other-process" });

    clock.wall += 5_000;

    expect(await manager.heartbeat(claim)).toBe(false);
  });

  it("still refuses to renew past the attempt's real deadline", async () => {
    const adapter = new MemoryExecutionAdapter();
    const clock = { wall: 1_000 };
    const { manager, claim } = await running(adapter, clock);
    const key = executionTargetKey(subTaskTarget);
    // Heartbeats kept firing on time, so nothing was frozen: the deadline is real.
    adapter.attempts.set(key, {
      ...adapter.attempts.get(key)!,
      heartbeatAt: clock.wall,
      leaseExpiresAt: clock.wall + 1_000,
      deadlineAt: clock.wall - 1,
    });

    expect(await manager.heartbeat(claim)).toBe(false);
  });

  it("leaves an attempt this process is running alone in the watchdog", async () => {
    const adapter = new MemoryExecutionAdapter();
    const clock = { wall: 1_000 };
    const { manager } = await running(adapter, clock);

    clock.wall += 5_000;

    const result = await manager.watchdogTick();
    expect(result.failed).toBe(0);
    expect(adapter.attempts.get(executionTargetKey(subTaskTarget))!.state).toBe("running");
  });

  it("still fails an attempt whose owner process is gone", async () => {
    const adapter = new MemoryExecutionAdapter();
    const clock = { wall: 1_000 };
    const manager = managerWithClock(adapter, clock);
    adapter.attempts.set(executionTargetKey(subTaskTarget), {
      attemptId: "ghost",
      ownerId: "dead-process",
      state: "running",
      retrySafety: "safe",
      startedAt: 0,
      heartbeatAt: 0,
      leaseExpiresAt: 500,
      deadlineAt: 900,
    });

    const result = await manager.watchdogTick();
    expect(result.failed).toBe(1);
    expect(adapter.attempts.get(executionTargetKey(subTaskTarget))!.state).toBe("error");
  });
});
