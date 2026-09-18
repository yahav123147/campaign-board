import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Run, Stage } from "@/types";

const mocks = vi.hoisted(() => ({
  currentRun: null as Run | null,
  startManagedExecution: vi.fn(),
  emit: vi.fn(),
}));

vi.mock("@/orchestrator/runRegistry", () => ({
  getRun: () => mocks.currentRun,
  updateRun: (_id: string, patch: Partial<Run>) => {
    if (mocks.currentRun) mocks.currentRun = { ...mocks.currentRun, ...patch };
  },
  mutateRun: async <T,>(
    _id: string,
    mutation: (run: Run) => { run: Run; value: T },
  ): Promise<T | undefined> => {
    if (!mocks.currentRun) return undefined;
    const result = mutation(mocks.currentRun);
    mocks.currentRun = result.run;
    return result.value;
  },
}));

vi.mock("@/orchestrator/executionService", () => ({
  startManagedExecution: mocks.startManagedExecution,
  subTaskExecutionTarget: vi.fn(() => "target"),
}));

vi.mock("@/orchestrator/eventBus", () => ({
  eventBus: { emit: mocks.emit },
}));

import { finalizeStageIfComplete } from "@/orchestrator/runStage";

function stage(number: Stage["number"], status: Stage["status"]): Stage {
  return {
    number,
    title: `Stage ${number}`,
    ownerSlug: "avishai-campaigner",
    status,
    output: "",
    feedbackHistory: [],
    subTasks: [
      {
        id: String(number),
        title: "task",
        status: status === "pending" ? "pending" : "approved",
        output: status === "pending" ? "" : "approved output",
        feedbackHistory: [],
      },
    ],
  };
}

describe("Stage 9 explicit-start boundary", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "stage9-explicit-"));
    mocks.startManagedExecution.mockReset();
    mocks.emit.mockReset();
    mocks.currentRun = {
      id: "2026-08-27-1200-explicit-stage-nine",
      slug: "explicit-stage-nine",
      brief: "brief",
      createdAt: "2026-08-27T12:00:00.000Z",
      status: "approved",
      currentRound: null,
      messages: [],
      currentStage: 8,
      stages: [stage(8, "running"), stage(9, "pending")],
    };
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("finishes Stage 8 but leaves Stage 9 pending without starting it", async () => {
    await finalizeStageIfComplete(mocks.currentRun!.id, directory, 8);

    expect(mocks.currentRun?.stages?.find((item) => item.number === 8)?.status).toBe("approved");
    expect(mocks.currentRun?.stages?.find((item) => item.number === 9)?.status).toBe("pending");
    expect(mocks.currentRun?.currentStage).toBe(9);
    expect(mocks.startManagedExecution).not.toHaveBeenCalled();
  });
});
