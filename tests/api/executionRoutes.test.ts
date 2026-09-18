import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { POST as runFeedback } from "@/app/api/runs/[id]/feedback/route";
import { POST as stageFeedback } from "@/app/api/runs/[id]/stages/[n]/feedback/route";
import { POST as subTaskDecide } from "@/app/api/runs/[id]/stages/[n]/subtasks/[subId]/decide/route";
import { POST as subTaskFeedback } from "@/app/api/runs/[id]/stages/[n]/subtasks/[subId]/feedback/route";
import { executionTargetKey, type ExecutionAttempt } from "@/orchestrator/executionManager";
import { __resetExecutionServiceForTests } from "@/orchestrator/executionService";
import { getStageDef } from "@/orchestrator/stageRegistry";
import {
  __resetRegistryForTests,
  createRun,
  flushPersistence,
  getRun,
} from "@/orchestrator/runRegistry";
import type { Run, Stage, StageNumber, StageStatus, SubTask } from "@/types";

let testRunsDir: string;

function task(id: string, status: StageStatus): SubTask {
  return { id, title: id, status, output: "output", feedbackHistory: [] };
}

function stage(
  number: StageNumber,
  status: StageStatus,
  tasks: SubTask[],
): Stage {
  const definition = getStageDef(number);
  const statusById = new Map(tasks.map((candidate) => [candidate.id, candidate]));
  return {
    number,
    title: definition.title,
    ownerSlug: definition.ownerSlug,
    status,
    output: "",
    feedbackHistory: [],
    subTasks: definition.subTasks.map((candidate) => ({
      ...(statusById.get(candidate.id) ?? task(candidate.id, "pending")),
      title: candidate.title,
    })),
  };
}

function approvedRun(id: string, stages: Stage[]): Run {
  return {
    id,
    slug: id,
    brief: "A sufficiently long route test brief",
    createdAt: "2026-08-27T10:00:00.000Z",
    status: "approved",
    currentRound: null,
    messages: [],
    currentStage: stages.find((candidate) => candidate.status !== "approved")?.number ?? null,
    stages,
  };
}

function activeAttempt(attemptId = "active-attempt"): ExecutionAttempt {
  const now = Date.now();
  return {
    attemptId,
    ownerId: "route-test",
    state: "running",
    retrySafety: "safe",
    startedAt: now,
    heartbeatAt: now,
    leaseExpiresAt: now + 60_000,
    deadlineAt: now + 600_000,
  };
}

function request(url: string, body: object): NextRequest {
  return new NextRequest(`http://127.0.0.1:3000${url}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function store(run: Run): Promise<void> {
  createRun(run);
  await flushPersistence();
}

beforeEach(async () => {
  testRunsDir = await fs.mkdtemp(path.join(os.tmpdir(), "council-execution-routes-"));
  process.env.RUNS_DIR_OVERRIDE = testRunsDir;
  __resetExecutionServiceForTests();
  __resetRegistryForTests();
});

afterEach(async () => {
  await flushPersistence();
  __resetExecutionServiceForTests();
  __resetRegistryForTests();
  delete process.env.RUNS_DIR_OVERRIDE;
});

describe("execution route ordering", () => {
  it("rejects future stages and sub-tasks without creating an attempt", async () => {
    const run = approvedRun("out-of-order-route", [
      stage(5, "running", [task("5.1", "awaiting-decision")]),
      stage(6, "pending", [task("6", "pending")]),
    ]);
    await store(run);

    const laterTaskResponse = await subTaskFeedback(
      request(`/api/runs/${run.id}/stages/5/subtasks/5.2/feedback`, {
        feedback: "Please start later work",
      }),
      { params: Promise.resolve({ id: run.id, n: "5", subId: "5.2" }) },
    );
    const futureStageResponse = await subTaskFeedback(
      request(`/api/runs/${run.id}/stages/6/subtasks/6/feedback`, {
        feedback: "Please start future stage",
      }),
      { params: Promise.resolve({ id: run.id, n: "6", subId: "6" }) },
    );

    expect(laterTaskResponse.status).toBe(409);
    expect(futureStageResponse.status).toBe(409);
    expect(getRun(run.id)?.executionAttempts ?? {}).toEqual({});
    expect(getRun(run.id)?.stages?.[0].subTasks.map((candidate) => candidate.status))
      .toEqual(["awaiting-decision", "pending", "pending", "pending"]);
    expect(getRun(run.id)?.stages?.[1].subTasks[0].status).toBe("pending");
  });

  it("keeps sub-task state unchanged when another target owns the run claim", async () => {
    const run = approvedRun("busy-subtask-route", [
      stage(1, "running", [task("1", "awaiting-decision")]),
    ]);
    const otherTarget = { kind: "run" as const, runId: run.id };
    run.executionAttempts = {
      [executionTargetKey(otherTarget)]: activeAttempt(),
    };
    await store(run);

    const response = await subTaskFeedback(
      request(`/api/runs/${run.id}/stages/1/subtasks/1/feedback`, {
        feedback: "Please revise this output",
      }),
      { params: Promise.resolve({ id: run.id, n: "1", subId: "1" }) },
    );

    expect(response.status).toBe(409);
    expect(getRun(run.id)?.stages?.[0]).toMatchObject({ status: "running" });
    expect(getRun(run.id)?.stages?.[0].subTasks[0]).toMatchObject({
      status: "awaiting-decision",
      output: "output",
    });
  });

  it("keeps run and legacy stage review states unchanged when claim is busy", async () => {
    const strategyRun: Run = {
      id: "busy-run-feedback",
      slug: "busy-run-feedback",
      brief: "A sufficiently long route test brief",
      createdAt: "2026-08-27T10:00:00.000Z",
      status: "awaiting-decision",
      currentRound: null,
      messages: [],
      strategyDoc: "strategy",
    };
    strategyRun.executionAttempts = {
      [executionTargetKey({ kind: "run", runId: strategyRun.id })]: activeAttempt(),
    };
    await store(strategyRun);

    const runResponse = await runFeedback(
      request(`/api/runs/${strategyRun.id}/feedback`, { feedback: "Revise the strategy" }),
      { params: Promise.resolve({ id: strategyRun.id }) },
    );
    expect(runResponse.status).toBe(409);
    expect(getRun(strategyRun.id)).toMatchObject({
      status: "awaiting-decision",
      currentRound: null,
    });

    const legacy = approvedRun("busy-stage-feedback", [
      stage(1, "awaiting-decision", [task("1", "awaiting-decision")]),
    ]);
    legacy.executionAttempts = {
      [executionTargetKey({ kind: "run", runId: legacy.id })]: activeAttempt("legacy-active"),
    };
    await store(legacy);
    const stageResponse = await stageFeedback(
      request(`/api/runs/${legacy.id}/stages/1/feedback`, { feedback: "Revise the stage" }),
      { params: Promise.resolve({ id: legacy.id, n: "1" }) },
    );

    expect(stageResponse.status).toBe(409);
    expect(getRun(legacy.id)?.stages?.[0]).toMatchObject({
      status: "awaiting-decision",
    });
    expect(getRun(legacy.id)?.stages?.[0].subTasks[0].status).toBe("awaiting-decision");
  });

  it("does not approve a sub-task while its worker still owns the claim", async () => {
    const run = approvedRun("busy-decision-route", [
      stage(1, "running", [task("1", "awaiting-decision")]),
    ]);
    const target = {
      kind: "subtask" as const,
      runId: run.id,
      stageNumber: 1,
      subTaskId: "1",
    };
    run.executionAttempts = {
      [executionTargetKey(target)]: activeAttempt(),
    };
    await store(run);

    const response = await subTaskDecide(
      request(`/api/runs/${run.id}/stages/1/subtasks/1/decide`, { action: "approve" }),
      { params: Promise.resolve({ id: run.id, n: "1", subId: "1" }) },
    );

    expect(response.status).toBe(409);
    expect(getRun(run.id)?.stages?.[0].subTasks[0].status).toBe("awaiting-decision");
  });
});
