import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const mocks = vi.hoisted(() => ({
  startSubTaskExecution: vi.fn(),
}));

vi.mock("@/orchestrator/runSubTask", () => ({
  startSubTaskExecution: mocks.startSubTaskExecution,
}));

import { POST } from "@/app/api/runs/[id]/stages/[n]/subtasks/[subId]/feedback/route";
import { getStageDef } from "@/orchestrator/stageRegistry";
import {
  __resetRegistryForTests,
  createRun,
  flushPersistence,
  getRun,
} from "@/orchestrator/runRegistry";
import type { Run } from "@/types";

let testRunsDir: string;

function previewReviewRun(id: string): Run {
  const definition = getStageDef(5);
  return {
    id,
    slug: id,
    brief: "A sufficiently long Stage 5 feedback route test brief",
    createdAt: "2026-08-27T10:00:00.000Z",
    status: "approved",
    currentRound: null,
    messages: [],
    currentStage: 5,
    stages: [{
      number: 5,
      title: definition.title,
      ownerSlug: definition.ownerSlug,
      status: "awaiting-decision",
      output: "old stage output",
      feedbackHistory: [],
      currentSubTaskId: "5.4",
      subTasks: definition.subTasks.map((task) => ({
        id: task.id,
        title: task.title,
        status: task.id === "5.4" ? "awaiting-decision" : "approved",
        output: `${task.id} old output`,
        feedbackHistory: task.id === "5.4" ? ["older preview note"] : [],
      })),
    }],
  };
}

beforeEach(async () => {
  testRunsDir = await fs.mkdtemp(path.join(os.tmpdir(), "stage5-preview-feedback-route-"));
  process.env.RUNS_DIR_OVERRIDE = testRunsDir;
  __resetRegistryForTests();
  mocks.startSubTaskExecution.mockReset();
  mocks.startSubTaskExecution.mockResolvedValue({
    ok: true,
    attemptId: "rebuild-attempt",
    completion: Promise.resolve(),
  });
});

afterEach(async () => {
  await flushPersistence();
  __resetRegistryForTests();
  delete process.env.RUNS_DIR_OVERRIDE;
});

describe("Stage 5.4 feedback route", () => {
  it("claims a 5.3 rebuild with an atomic rewind intent and forwards the feedback", async () => {
    const run = previewReviewRun("stage5-preview-feedback");
    createRun(run);
    await flushPersistence();
    const feedback = "Increase the hero contrast and move the CTA higher";
    const request = new NextRequest(
      `http://127.0.0.1:3000/api/runs/${run.id}/stages/5/subtasks/5.4/feedback`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ feedback: `  ${feedback}  ` }),
      },
    );

    const response = await POST(request, {
      params: Promise.resolve({ id: run.id, n: "5", subId: "5.4" }),
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      attemptId: "rebuild-attempt",
      startedSubTaskId: "5.3",
    });
    expect(mocks.startSubTaskExecution).toHaveBeenCalledOnce();
    expect(mocks.startSubTaskExecution).toHaveBeenCalledWith(
      run.id,
      path.join(testRunsDir, run.id),
      5,
      "5.3",
      feedback,
      {
        kind: "rewind-subtasks-for-feedback",
        stageNumber: 5,
        fromSubTaskId: "5.3",
        triggerSubTaskId: "5.4",
        feedback,
      },
    );

    // The route only describes the transition. State remains untouched until
    // the execution adapter durably stores the rewind and claim together.
    expect(getRun(run.id)?.stages?.[0].subTasks.map((task) => task.status))
      .toEqual(["approved", "approved", "approved", "awaiting-decision"]);
  });
});
