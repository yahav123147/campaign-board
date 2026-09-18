import { describe, expect, it } from "vitest";
import { initialRunPageState, runPageReducer } from "@/lib/runPageReducer";
import type { CriticRound, Stage } from "@/types";

const stage: Stage = { number: 2, title: "קופי", ownerSlug: "maya-lp-copywriter", status: "running", output: "", feedbackHistory: [],
  subTasks: [{ id: "2", title: "קופי", status: "running", output: "טיוטה", feedbackHistory: [] }] };
const round = (n: number, verdict: CriticRound["verdict"]): CriticRound => ({ round: n, verdict, scores: { "מבנה": 8 }, avg: 8, min: 8, fixes: [], at: "2026-09-15T10:00:00.000Z" });

describe("critic round events", () => {
  it("tracks the round in progress and appends completed rounds", () => {
    let s = runPageReducer({ ...initialRunPageState, stages: [stage] }, { type: "critic-round-started", runId: "r", stageNumber: 2, subTaskId: "2", criticRoundNumber: 1 });
    expect(s.stages[0]!.subTasks[0]).toMatchObject({ criticRound: 1, currentPhase: "critic-round", output: "" });
    s = runPageReducer(s, { type: "critic-round-completed", runId: "r", stageNumber: 2, subTaskId: "2", criticRound: round(1, "revise") });
    s = runPageReducer(s, { type: "critic-round-started", runId: "r", stageNumber: 2, subTaskId: "2", criticRoundNumber: 2 });
    s = runPageReducer(s, { type: "critic-round-completed", runId: "r", stageNumber: 2, subTaskId: "2", criticRound: round(2, "approve") });
    expect(s.stages[0]!.subTasks[0]!.criticRounds?.map((r) => r.verdict)).toEqual(["revise", "approve"]);
    s = runPageReducer(s, { type: "subtask-started", runId: "r", stageNumber: 2, subTaskId: "2" });
    expect(s.stages[0]!.subTasks[0]!.criticRounds).toBeUndefined();
  });

  it("applies the harvest metadata carried by the stage 1 completion event, without a refresh", () => {
    const harvestStage: Stage = { ...stage, number: 1, subTasks: [{ id: "1", title: "קציר", status: "running", output: "", feedbackHistory: [] }] };
    const harvest = { schemaVersion: 1 as const, sheetFile: "sheet.jpg" as const, imageCount: 7, harvestedAt: "2026-09-15T10:00:00.000Z" };
    const s = runPageReducer({ ...initialRunPageState, stages: [harvestStage] }, { type: "subtask-completed", runId: "r", stageNumber: 1, subTaskId: "1", content: "טבלה", harvest });
    expect(s.stages[0]!.subTasks[0]).toMatchObject({ status: "awaiting-decision", output: "טבלה", harvest });
  });
});
