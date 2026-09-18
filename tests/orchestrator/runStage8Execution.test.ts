import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Run } from "@/types";

const mocks = vi.hoisted(() => ({
  currentRun: null as Run | null,
  appendLog: vi.fn(async () => undefined),
  saveRunArtifact: vi.fn(async () => undefined),
  emit: vi.fn(),
}));

vi.mock("@/lib/runStore", () => ({
  appendLog: mocks.appendLog,
  saveRunArtifact: mocks.saveRunArtifact,
}));
vi.mock("@/orchestrator/eventBus", () => ({ eventBus: { emit: mocks.emit } }));
vi.mock("@/orchestrator/runRegistry", () => ({
  getRun: () => mocks.currentRun,
  updateRun: (_id: string, patch: Partial<Run>) => {
    if (mocks.currentRun) mocks.currentRun = { ...mocks.currentRun, ...patch };
  },
}));

import { runStage8PixelVerify } from "@/orchestrator/runStage8PixelVerify";

describe("Stage 8 run profile snapshot", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "stage8-snapshot-"));
    mocks.appendLog.mockClear();
    mocks.emit.mockClear();
    mocks.currentRun = {
      id: "2026-08-27-1200-stage-eight-legacy",
      slug: "stage-eight-legacy",
      brief: "brief",
      createdAt: "2026-08-27T12:00:00.000Z",
      status: "approved",
      currentRound: null,
      messages: [],
      currentStage: 8,
      stages: [
        {
          number: 8,
          title: "verify",
          ownerSlug: "avishai-campaigner",
          status: "pending",
          output: "",
          feedbackHistory: [],
          subTasks: [
            { id: "8", title: "verify", status: "pending", output: "", feedbackHistory: [] },
          ],
        },
      ],
    };
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("fails closed before any Meta request when the run has no profile snapshot", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(runStage8PixelVerify(mocks.currentRun!.id, directory)).rejects.toThrow(
      /no client-profile snapshot/i,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mocks.currentRun?.stages?.[0].status).toBe("error");

    fetchSpy.mockRestore();
  });
});
