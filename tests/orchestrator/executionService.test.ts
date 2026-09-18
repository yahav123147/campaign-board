import { describe, expect, it, vi } from "vitest";
import {
  ExecutionManager,
  executionTargetKey,
  type ExecutionAdapter,
  type ExecutionAdapterClaimResult,
  type ExecutionAttempt,
  type ExecutionMutation,
  type ExecutionSnapshot,
  type ExecutionTarget,
} from "@/orchestrator/executionManager";
import { ExecutionService } from "@/orchestrator/executionService";

class MemoryAdapter implements ExecutionAdapter {
  readonly attempts = new Map<string, ExecutionAttempt>();

  async tryClaim(
    target: ExecutionTarget,
    attempt: ExecutionAttempt,
  ): Promise<ExecutionAdapterClaimResult> {
    const encodedRunId = encodeURIComponent(target.runId);
    const active = [...this.attempts.entries()].find(([key, candidate]) => (
      candidate.state === "running"
      && (key === `run:${encodedRunId}` || key.startsWith(`subtask:${encodedRunId}:`))
    ))?.[1];
    if (active) {
      return {
        ok: false,
        reason: "already-running",
        activeAttemptId: active.attemptId,
        error: "already running",
      };
    }
    this.attempts.set(executionTargetKey(target), { ...attempt });
    return { ok: true };
  }

  async mutate<T>(
    target: ExecutionTarget,
    mutation: (current: ExecutionAttempt | undefined) => ExecutionMutation<T>,
  ): Promise<T> {
    const key = executionTargetKey(target);
    const result = mutation(this.attempts.get(key));
    if (result.next) this.attempts.set(key, { ...result.next });
    else this.attempts.delete(key);
    return result.value;
  }

  async listRunning(): Promise<ExecutionSnapshot[]> {
    return [...this.attempts.entries()]
      .filter(([, attempt]) => attempt.state === "running")
      .map(([key, attempt]) => {
        const [, runId] = key.split(":");
        return { target: { kind: "run" as const, runId }, attempt: { ...attempt } };
      });
  }
}

const target: ExecutionTarget = { kind: "run", runId: "managed-run" };
const differentTargetInSameRun: ExecutionTarget = {
  kind: "subtask",
  runId: "managed-run",
  stageNumber: 5,
  subTaskId: "5.2",
};

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function makeService(adapter: MemoryAdapter, time = { now: 1_000 }) {
  let sequence = 0;
  const errors = vi.fn();
  const manager = new ExecutionManager(adapter, {
    now: () => time.now,
    makeAttemptId: () => `attempt-${++sequence}`,
    ownerId: "service-test",
    defaultLeaseMs: 1_000,
    defaultTimeoutMs: 10_000,
  });
  const service = new ExecutionService(manager, {
    policyForTarget: () => ({ leaseMs: 1_000, timeoutMs: 10_000 }),
    onBackgroundError: errors,
  });
  return { service, manager, errors };
}

describe("ExecutionService", () => {
  it("durably claims before returning and rejects a duplicate starter", async () => {
    const adapter = new MemoryAdapter();
    const { service } = makeService(adapter);
    const gate = deferred();
    const first = await service.start(target, async () => gate.promise);
    expect(first.ok).toBe(true);
    expect(adapter.attempts.get(executionTargetKey(target))).toMatchObject({
      attemptId: "attempt-1",
      state: "running",
    });

    const duplicate = await service.start(target, async () => {});
    expect(duplicate).toMatchObject({
      ok: false,
      reason: "already-running",
      activeAttemptId: "attempt-1",
    });

    gate.resolve();
    if (!first.ok) throw new Error("first start failed");
    await expect(first.completion).resolves.toBeUndefined();
    expect(adapter.attempts.has(executionTargetKey(target))).toBe(false);
  });

  it("does not invoke a different target while the same run is active", async () => {
    const adapter = new MemoryAdapter();
    const { service } = makeService(adapter);
    const gate = deferred();
    const secondOperation = vi.fn(async () => {});
    const first = await service.start(target, async () => gate.promise);
    if (!first.ok) throw new Error("first start failed");

    const second = await service.start(differentTargetInSameRun, secondOperation);

    expect(second).toMatchObject({
      ok: false,
      reason: "already-running",
      activeAttemptId: first.attemptId,
    });
    expect(secondOperation).not.toHaveBeenCalled();

    gate.resolve();
    await expect(first.completion).resolves.toBeUndefined();
  });

  it("persists a worker failure and exposes a rejecting completion", async () => {
    const adapter = new MemoryAdapter();
    const { service, errors } = makeService(adapter);
    const started = await service.start(target, async () => {
      throw new Error("worker exploded");
    });
    if (!started.ok) throw new Error("start failed");

    await expect(started.completion).rejects.toThrow("worker exploded");
    expect(adapter.attempts.get(executionTargetKey(target))).toMatchObject({
      state: "error",
      failureReason: "execution-error",
      errorMessage: "worker exploded",
    });
    expect(errors).toHaveBeenCalledOnce();
  });

  it("aborts expired work and cannot overwrite the watchdog verdict", async () => {
    const adapter = new MemoryAdapter();
    const time = { now: 1_000 };
    const { service, manager } = makeService(adapter, time);
    const started = await service.start(target, async ({ signal }) => {
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    if (!started.ok) throw new Error("start failed");
    // The watchdog fails an attempt whose owner process is gone. An attempt
    // this process is still running survives a frozen clock instead (F108).
    const key = executionTargetKey(target);
    adapter.attempts.set(key, { ...adapter.attempts.get(key)!, ownerId: "dead-process" });

    time.now = 2_001;
    await expect(manager.watchdogTick()).resolves.toEqual({ checked: 1, failed: 1, fenced: 0 });
    await expect(started.completion).rejects.toThrow("lease expired");
    expect(adapter.attempts.get(executionTargetKey(target))).toMatchObject({
      state: "error",
      failureReason: "lease-expired",
    });
  });
});
