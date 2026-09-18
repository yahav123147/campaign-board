import { describe, expect, it } from "vitest";
import {
  executionClaimViolation,
  reopenOrderViolation,
  stageOrderViolation,
  subTaskOrderViolation,
} from "@/orchestrator/executionOrder";
import type { Run, Stage, StageNumber, StageStatus, SubTask } from "@/types";

function task(id: string, status: StageStatus): SubTask {
  return { id, title: id, status, output: "", feedbackHistory: [] };
}

function stage(
  number: StageNumber,
  status: StageStatus,
  tasks: SubTask[],
): Stage {
  return {
    number,
    title: `Stage ${number}`,
    ownerSlug: "yoni-strategist",
    status,
    output: "",
    feedbackHistory: [],
    subTasks: tasks,
  };
}

function run(stages: Stage[]): Run {
  return {
    id: "order-run",
    slug: "order-run",
    brief: "A sufficiently long test brief",
    createdAt: "2026-08-27T10:00:00.000Z",
    status: "approved",
    currentRound: null,
    messages: [],
    currentStage: 9,
    stages,
  };
}

describe("execution order", () => {
  it("derives the current stage from statuses and ignores a stale currentStage cursor", () => {
    const current = run([
      stage(1, "approved", [task("1", "approved")]),
      stage(2, "pending", [task("2", "pending")]),
      stage(3, "pending", [task("3", "pending")]),
    ]);

    expect(stageOrderViolation(current, 2)).toBeUndefined();
    expect(subTaskOrderViolation(current, 2, "2")).toBeUndefined();
  });

  it("rejects a future stage until the earlier frontier is complete", () => {
    const current = run([
      stage(1, "running", [task("1", "awaiting-decision")]),
      stage(2, "pending", [task("2", "pending")]),
    ]);

    expect(stageOrderViolation(current, 2)).toMatch(/stage 1 must finish first/i);
    expect(executionClaimViolation(current, {
      kind: "subtask",
      runId: current.id,
      stageNumber: 2,
      subTaskId: "2",
    })).toMatch(/stage 1 must finish first/i);
  });

  it("rejects a later sub-task while an earlier sub-task is unfinished", () => {
    const current = run([
      stage(1, "running", [
        task("1.1", "error"),
        task("1.2", "pending"),
      ]),
      stage(2, "pending", [task("2", "pending")]),
    ]);

    expect(subTaskOrderViolation(current, 1, "1.2"))
      .toMatch(/1\.1 must finish first/i);
  });

  it("re-checks target state at claim time after a concurrent approval", () => {
    const current = run([
      stage(1, "running", [
        task("1.1", "approved"),
        task("1.2", "pending"),
      ]),
    ]);

    expect(executionClaimViolation(current, {
      kind: "subtask",
      runId: current.id,
      stageNumber: 1,
      subTaskId: "1.1",
    })).toMatch(/cannot start while it is 'approved'/i);
  });

  it("blocks reopen after a later stage has progressed", () => {
    const current = run([
      stage(1, "approved", [task("1", "approved")]),
      stage(2, "awaiting-decision", [task("2", "awaiting-decision")]),
    ]);

    expect(reopenOrderViolation(current, 1, "1"))
      .toMatch(/after stage 2 has progressed/i);
  });
});
