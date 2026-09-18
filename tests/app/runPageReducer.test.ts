import { describe, expect, it } from "vitest";
import { completedStageState, stageSnapshotState } from "@/lib/runPageStageState";
import type { Stage } from "@/types";

function stage(number: Stage["number"], status: Stage["status"]): Stage {
  return {
    number,
    title: `Stage ${number}`,
    ownerSlug: "avishai-campaigner",
    status,
    output: status === "approved" ? "approved output" : "",
    feedbackHistory: [],
    subTasks: [{
      id: String(number),
      title: "task",
      status,
      output: "output",
      feedbackHistory: [],
    }],
  };
}

describe("run page state reducer", () => {
  it("preserves approved snapshot statuses and selects the first unfinished stage", () => {
    const stages = [stage(1, "approved"), stage(2, "pending")];
    const state = stageSnapshotState(stages);

    expect(state.stages).toEqual(stages);
    expect(state.stages[0].status).toBe("approved");
    expect(state.currentStageNumber).toBe(2);
  });

  it("treats stage-completed as durable approval and advances the cursor", () => {
    const state = completedStageState(
      [stage(1, "running"), stage(2, "pending")],
      1,
      "assembled",
    );

    expect(state.stages[0]).toMatchObject({ status: "approved", output: "assembled" });
    expect(state.currentStageNumber).toBe(2);
  });
});
