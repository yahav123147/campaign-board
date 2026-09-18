import { describe, expect, it } from "vitest";
import {
  AGENT_TIMEOUT_MARGIN_MS,
  ExecutionService,
  MIN_AGENT_TIMEOUT_MS,
  agentTimeoutMs,
  subTaskExecutionTarget,
  type ExecutionControl,
} from "@/orchestrator/executionService";
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

/**
 * The agent's own timer, against the execution budget that pays for it.
 *
 * The 5.2 acceptance run of 2026-09-16 claimed 90 minutes for the sub-task and
 * then spawned an agent on spawnAgent's 60 minute default, which killed the
 * turn after four of eight screens. The budget and the timer are one number
 * with a margin between them, and this is where that is stated.
 */

const MINUTE = 60_000;

class MemoryAdapter implements ExecutionAdapter {
  readonly attempts = new Map<string, ExecutionAttempt>();

  async tryClaim(target: ExecutionTarget, attempt: ExecutionAttempt): Promise<ExecutionAdapterClaimResult> {
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
    return [];
  }
}

/** The control the real service hands an executor for this target. */
async function controlFor(target: ExecutionTarget): Promise<ExecutionControl> {
  const service = new ExecutionService(new ExecutionManager(new MemoryAdapter()));
  let seen: ExecutionControl | undefined;
  const started = await service.start(target, async (control) => {
    seen = control;
  });
  expect(started.ok).toBe(true);
  if (started.ok) await started.completion;
  expect(seen, "the operation received a control").toBeDefined();
  return seen!;
}

describe("agentTimeoutMs", () => {
  it("leaves the executor its margin for the work after the agent exits", () => {
    expect(agentTimeoutMs({ timeoutMs: 90 * MINUTE })).toBe(75 * MINUTE);
    expect(AGENT_TIMEOUT_MARGIN_MS).toBe(15 * MINUTE);
  });

  it("never squeezes the agent below the floor, however small the budget", () => {
    expect(agentTimeoutMs({ timeoutMs: 40 * MINUTE })).toBe(MIN_AGENT_TIMEOUT_MS);
    expect(agentTimeoutMs({ timeoutMs: 1 * MINUTE })).toBe(MIN_AGENT_TIMEOUT_MS);
  });

  it("leaves spawnAgent its own default when there is no execution at all", () => {
    expect(agentTimeoutMs(undefined)).toBeUndefined();
    expect(agentTimeoutMs({ timeoutMs: 0 })).toBeUndefined();
    expect(agentTimeoutMs({ timeoutMs: Number.NaN })).toBeUndefined();
  });
});

describe("the claimed policy reaches the executor", () => {
  it("gives a stage 5 sub-task its 90 minute budget, and the agent 75 of them", async () => {
    const control = await controlFor(subTaskExecutionTarget("run-1", 5, "5.2"));

    expect(control.timeoutMs).toBe(90 * MINUTE);
    expect(agentTimeoutMs(control)).toBe(75 * MINUTE);
  });

  it("gives 5.3 its two hours, and the agent all but the margin", async () => {
    const control = await controlFor(subTaskExecutionTarget("run-1", 5, "5.3"));

    expect(control.timeoutMs).toBe(120 * MINUTE);
    expect(agentTimeoutMs(control)).toBe(105 * MINUTE);
  });

  it("gives a stage 2 sub-task the default policy, minus the margin", async () => {
    const control = await controlFor(subTaskExecutionTarget("run-1", 2, "2.1"));

    expect(control.timeoutMs).toBe(60 * MINUTE);
    expect(agentTimeoutMs(control)).toBe(45 * MINUTE);
  });

  it("gives a council run its two hours", async () => {
    const control = await controlFor({ kind: "run", runId: "run-1" });

    expect(control.timeoutMs).toBe(120 * MINUTE);
    expect(agentTimeoutMs(control)).toBe(105 * MINUTE);
  });
});
