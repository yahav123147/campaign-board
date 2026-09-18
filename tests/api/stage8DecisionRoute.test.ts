import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Run } from "@/types";
import { stage8ReportSha256 } from "@/orchestrator/stage89Safety";

const { finalizeMock, startStageMock } = vi.hoisted(() => ({
  finalizeMock: vi.fn(async () => {}),
  startStageMock: vi.fn(),
}));

vi.mock("@/orchestrator/runStage", () => ({
  finalizeStageIfComplete: finalizeMock,
  startStageExecution: startStageMock,
}));

import { POST as decideSubTask } from "@/app/api/runs/[id]/stages/[n]/subtasks/[subId]/decide/route";
import { POST as decideStage } from "@/app/api/runs/[id]/stages/[n]/decide/route";
import {
  __resetRegistryForTests,
  createRun,
  flushPersistence,
  getRun,
} from "@/orchestrator/runRegistry";

let runsRoot: string;

function stage8Run(id: string, ready: boolean): Run {
  const output = ready ? "# Typed verification\n\nRESULT: PASS" : "# Typed verification\n\nRESULT: FAIL";
  return {
    id,
    slug: id,
    brief: "A sufficiently long Stage 8 decision test brief",
    createdAt: "2026-08-28T10:00:00.000Z",
    status: "approved",
    currentRound: null,
    messages: [],
    currentStage: 8,
    stages: [{
      number: 8,
      title: "Typed read-only verification",
      ownerSlug: "avishai-campaigner",
      status: "running",
      output: "",
      feedbackHistory: [],
      subTasks: [{
        id: "8",
        title: "Typed verification",
        status: "awaiting-decision",
        output,
        feedbackHistory: [],
        metaVerification: {
          schemaVersion: 1,
          ready,
          reportSha256: stage8ReportSha256(output),
          checkedAt: "2026-08-28T10:01:00.000Z",
        },
      }],
    }],
  };
}

function request(url: string, body: Record<string, unknown>): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  runsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "council-stage8-decision-"));
  process.env.RUNS_DIR_OVERRIDE = runsRoot;
  __resetRegistryForTests();
  finalizeMock.mockClear();
  startStageMock.mockReset();
});

afterEach(async () => {
  await flushPersistence();
  __resetRegistryForTests();
  delete process.env.RUNS_DIR_OVERRIDE;
});

describe("Stage 8 sealed approval", () => {
  it("rejects manual report edits without consuming the review state", async () => {
    const id = "stage8-edit-rejected";
    createRun(stage8Run(id, true));
    await flushPersistence();

    const response = await decideSubTask(request(
      `http://127.0.0.1:3000/api/runs/${id}/stages/8/subtasks/8/decide`,
      { action: "edit", editedOutput: "edited" },
    ), { params: Promise.resolve({ id, n: "8", subId: "8" }) });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringMatching(/sealed/i) });
    expect(getRun(id)?.stages?.[0].subTasks[0]).toMatchObject({
      status: "awaiting-decision",
      metaVerification: { ready: true },
    });
  });

  it("rejects a failed receipt and an output changed after verification", async () => {
    const failedId = "stage8-failed-rejected";
    createRun(stage8Run(failedId, false));
    await flushPersistence();
    const failed = await decideSubTask(request(
      `http://127.0.0.1:3000/api/runs/${failedId}/stages/8/subtasks/8/decide`,
      { action: "approve" },
    ), { params: Promise.resolve({ id: failedId, n: "8", subId: "8" }) });
    expect(failed.status).toBe(409);
    await expect(failed.json()).resolves.toMatchObject({ error: expect.stringMatching(/passes/i) });

    const changedId = "stage8-changed-rejected";
    const changedRun = stage8Run(changedId, true);
    changedRun.stages![0].subTasks[0].output += "\nmanual change";
    createRun(changedRun);
    await flushPersistence();
    const changed = await decideSubTask(request(
      `http://127.0.0.1:3000/api/runs/${changedId}/stages/8/subtasks/8/decide`,
      { action: "approve" },
    ), { params: Promise.resolve({ id: changedId, n: "8", subId: "8" }) });
    expect(changed.status).toBe(409);
    await expect(changed.json()).resolves.toMatchObject({ error: expect.stringMatching(/edited/i) });
  });

  it("accepts the exact passing receipt and completes the stage", async () => {
    const id = "stage8-pass-approved";
    createRun(stage8Run(id, true));
    await flushPersistence();

    const response = await decideSubTask(request(
      `http://127.0.0.1:3000/api/runs/${id}/stages/8/subtasks/8/decide`,
      { action: "approve" },
    ), { params: Promise.resolve({ id, n: "8", subId: "8" }) });

    expect(response.status).toBe(200);
    expect(getRun(id)?.stages?.[0]).toMatchObject({ status: "approved" });
    expect(getRun(id)?.currentStage).toBeNull();
    expect(finalizeMock).toHaveBeenCalledWith(id, expect.any(String), 8);
  });

  it("applies the same seal to the legacy stage-level decision route", async () => {
    const id = "stage8-stage-route-rejected";
    const run = stage8Run(id, true);
    run.stages![0].status = "awaiting-decision";
    run.stages![0].output = `${run.stages![0].subTasks[0].output}\nchanged`;
    createRun(run);
    await flushPersistence();

    const response = await decideStage(request(
      `http://127.0.0.1:3000/api/runs/${id}/stages/8/decide`,
      { action: "approve" },
    ), { params: Promise.resolve({ id, n: "8" }) });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringMatching(/edited/i) });
    expect(startStageMock).not.toHaveBeenCalled();
  });
});
