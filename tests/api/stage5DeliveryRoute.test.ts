import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Run, StageStatus, SubTask } from "@/types";

const { deliverMock, finalizeMock } = vi.hoisted(() => ({
  deliverMock: vi.fn(),
  finalizeMock: vi.fn(async () => {}),
}));

vi.mock("@/orchestrator/runStage5Preview", () => ({
  deliverStage5LandingPage: deliverMock,
}));
vi.mock("@/orchestrator/runStage", () => ({
  finalizeStageIfComplete: finalizeMock,
}));

import { POST } from "@/app/api/runs/[id]/stages/[n]/subtasks/[subId]/decide/route";
import {
  __resetRegistryForTests,
  createRun,
  flushPersistence,
  getRun,
} from "@/orchestrator/runRegistry";
import { getStageDef } from "@/orchestrator/stageRegistry";

let testRunsDir: string;

function task(id: string, status: StageStatus): SubTask {
  return { id, title: id, status, output: `output-${id}`, feedbackHistory: [] };
}

function stage5Run(id: string): Run {
  const statuses = new Map<string, StageStatus>([
    ["5.1", "approved"],
    ["5.2", "approved"],
    ["5.3", "approved"],
    ["5.4", "awaiting-decision"],
  ]);
  const run: Run = {
    id,
    slug: id,
    brief: "A sufficiently long Stage 5 delivery test brief",
    createdAt: "2026-08-27T10:00:00.000Z",
    status: "approved",
    currentRound: null,
    messages: [],
    currentStage: 5,
    stages: [{
      number: 5,
      title: getStageDef(5).title,
      ownerSlug: getStageDef(5).ownerSlug,
      status: "running",
      output: "",
      feedbackHistory: [],
      subTasks: getStageDef(5).subTasks.map((definition) => ({
        ...task(definition.id, statuses.get(definition.id) ?? "pending"),
        title: definition.title,
      })),
    }],
  };
  const preview = run.stages![0].subTasks.find((candidate) => candidate.id === "5.4")!;
  preview.qaVerification = {
    schemaVersion: 1,
    ready: true,
    reportSha256: "1".repeat(64),
    pageSourceManifestSha256: "2".repeat(64),
    assetManifestSha256: "3".repeat(64),
    widths: [320, 360, 390, 430, 768, 1280],
    checkedAt: "2026-08-27T10:05:00.000Z",
  };
  return run;
}

function request(id: string): NextRequest {
  return new NextRequest(
    `http://127.0.0.1:3000/api/runs/${id}/stages/5/subtasks/5.4/decide`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "approve" }),
    },
  );
}

beforeEach(async () => {
  testRunsDir = await fs.mkdtemp(path.join(os.tmpdir(), "council-stage5-delivery-"));
  process.env.RUNS_DIR_OVERRIDE = testRunsDir;
  __resetRegistryForTests();
  deliverMock.mockReset();
  finalizeMock.mockClear();
});

afterEach(async () => {
  await flushPersistence();
  __resetRegistryForTests();
  delete process.env.RUNS_DIR_OVERRIDE;
});

describe("Stage 5.4 approval delivery", () => {
  it("persists the delivered commit on 5.3 before approving 5.4", async () => {
    const id = "stage5-delivery-success";
    const run = stage5Run(id);
    createRun(run);
    await flushPersistence();
    const commitSha = "a".repeat(40);
    deliverMock.mockResolvedValue({
      branch: `campaign-council-${id}`,
      slug: "page",
      url: "http://127.0.0.1:4322/page",
      commitSha,
    });

    const response = await POST(request(id), {
      params: Promise.resolve({ id, n: "5", subId: "5.4" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ landingCommitSha: commitSha });
    const stored = getRun(id)?.stages?.[0];
    expect(stored?.status).toBe("approved");
    expect(getRun(id)?.currentStage).toBeNull();
    expect(stored?.subTasks.find((candidate) => candidate.id === "5.3")?.landingCommitSha)
      .toBe(commitSha);
    expect(stored?.subTasks.find((candidate) => candidate.id === "5.4")).toMatchObject({
      status: "approved",
      output: expect.stringContaining(commitSha),
    });
    expect(finalizeMock).toHaveBeenCalledWith(id, expect.any(String), 5);
  });

  it("keeps the review pending when controlled Git delivery fails", async () => {
    const id = "stage5-delivery-failure";
    createRun(stage5Run(id));
    await flushPersistence();
    deliverMock.mockRejectedValue(new Error("delivery rejected"));

    const response = await POST(request(id), {
      params: Promise.resolve({ id, n: "5", subId: "5.4" }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("delivery rejected"),
    });
    expect(getRun(id)?.stages?.[0].subTasks.find((candidate) => candidate.id === "5.4")?.status)
      .toBe("awaiting-decision");
    expect(finalizeMock).not.toHaveBeenCalled();
  });

  it("refuses approval without a passing QA receipt", async () => {
    const id = "stage5-delivery-no-qa";
    const run = stage5Run(id);
    run.stages![0].subTasks.find((candidate) => candidate.id === "5.4")!.qaVerification = undefined;
    createRun(run);
    await flushPersistence();

    const response = await POST(request(id), {
      params: Promise.resolve({ id, n: "5", subId: "5.4" }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("no passing QA receipt"),
    });
    expect(deliverMock).not.toHaveBeenCalled();
  });
});
