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
import { stageRegistryFor } from "@/orchestrator/stageRegistry";

/**
 * Spec 7.2: an upsell page exists only inside a checkout session, so its run
 * ends when stage 5 builds the page. Finishing stage 5 must close the run
 * (currentStage null) and must not start any ad stage.
 */
describe("an upsell run", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "upsell-run-completion-"));
    mocks.startManagedExecution.mockReset();
    mocks.emit.mockReset();
    // Built the same way the strategy decide route initializes stages.
    const stages: Stage[] = stageRegistryFor("upsell-page").map((def) => ({
      number: def.number,
      title: def.title,
      ownerSlug: def.ownerSlug,
      status: def.number === 5 ? "running" : "approved",
      output: def.number === 5 ? "" : `פלט ${def.number}`,
      feedbackHistory: [],
      subTasks: def.subTasks.map((sub) => ({
        id: sub.id,
        title: sub.title,
        status: "approved",
        output: `פלט ${sub.id}`,
        feedbackHistory: [],
      })),
    }));
    mocks.currentRun = {
      id: "2026-09-12-1200-upsell-completion",
      slug: "upsell-completion",
      brief: "brief",
      createdAt: "2026-09-12T12:00:00.000Z",
      status: "approved",
      currentRound: null,
      messages: [],
      assetType: "upsell-page",
      currentStage: 5,
      stages,
    };
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5 });
  });

  it("reaches currentStage null once stage 5 completes, and starts nothing after it", async () => {
    expect(mocks.currentRun!.stages!.map((stage) => stage.number)).toEqual([1, 2, 3, 4, 5]);

    await finalizeStageIfComplete(mocks.currentRun!.id, directory, 5);

    expect(mocks.currentRun?.stages?.find((stage) => stage.number === 5)?.status).toBe("approved");
    expect(mocks.currentRun?.currentStage).toBeNull();
    expect(mocks.startManagedExecution).not.toHaveBeenCalled();
  });
});
