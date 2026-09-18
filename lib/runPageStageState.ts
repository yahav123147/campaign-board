import type { Stage, StageNumber } from "@/types";

export function stageSnapshotState(stages: Stage[]): {
  stages: Stage[];
  currentStageNumber: StageNumber | null;
} {
  return {
    stages,
    currentStageNumber: stages.find((stage) => stage.status !== "approved")?.number ?? null,
  };
}

export type StageDotState = "done" | "active" | "pending";

/** "שלב N מתוך M": N is the stage's position in this run's own list (a direct run's stage 5 is its fourth), M the run's stage count. */
export function stageOfTotalLabel(stageNumber: StageNumber, stages: readonly Stage[]): string {
  const position = stages.findIndex((stage) => stage.number === stageNumber);
  return `שלב ${position === -1 ? stageNumber : position + 1} מתוך ${stages.length}`;
}

/** One dot per stage the run actually has. No stages yet means no dots, never a guessed count. */
export function stageProgressDots(stages: readonly Stage[]): StageDotState[] {
  return stages.map((stage) => {
    if (stage.status === "approved") return "done";
    if (stage.status === "running" || stage.status === "awaiting-decision") return "active";
    return "pending";
  });
}

/** The note above the strategy editor, counting the stages this run will actually run. */
export function strategyEditNote(stageCount: number): string {
  return `ערוך את מסמך האסטרטגיה. כל שינוי כאן יזרום לכל ${stageCount} השלבים.`;
}

export function completedStageState(
  stages: Stage[],
  stageNumber: StageNumber,
  content?: string,
): { stages: Stage[]; currentStageNumber: StageNumber | null } {
  return stageSnapshotState(stages.map((stage) => stage.number === stageNumber
    ? { ...stage, status: "approved" as const, output: content ?? stage.output }
    : stage));
}
