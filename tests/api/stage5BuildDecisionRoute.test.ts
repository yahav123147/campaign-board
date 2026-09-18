import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Run, StageStatus } from "@/types";

const { finalizeMock } = vi.hoisted(() => ({ finalizeMock: vi.fn(async () => {}) }));

vi.mock("@/orchestrator/runStage", () => ({ finalizeStageIfComplete: finalizeMock, startStageExecution: vi.fn() }));
vi.mock("@/orchestrator/runStage5Preview", () => ({ deliverStage5LandingPage: vi.fn() }));
vi.mock("@/orchestrator/runSubTask", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/orchestrator/runSubTask")>()),
  startSubTaskExecution: vi.fn(async () => ({ ok: true as const, attemptId: "attempt-5-4" })),
}));

import { POST } from "@/app/api/runs/[id]/stages/[n]/subtasks/[subId]/decide/route";
import { __resetRegistryForTests, createRun, flushPersistence, getRun } from "@/orchestrator/runRegistry";
import { getStageDef } from "@/orchestrator/stageRegistry";
import { hashPageSourceManifest } from "@/orchestrator/pagePostflight";

let runsDir: string;

function buildRun(id: string): Run {
  const statuses = new Map<string, StageStatus>([["5.1", "approved"], ["5.2", "approved"], ["5.3", "awaiting-decision"]]);
  const run: Run = {
    id, slug: id, brief: "A sufficiently long Stage 5.3 human decision brief",
    createdAt: "2026-09-13T10:00:00.000Z", status: "approved", currentRound: null, messages: [], currentStage: 5,
    stages: [{
      number: 5, title: getStageDef(5).title, ownerSlug: getStageDef(5).ownerSlug, status: "running",
      output: "", feedbackHistory: [],
      subTasks: getStageDef(5).subTasks.map((definition) => ({
        id: definition.id, title: definition.title, status: statuses.get(definition.id) ?? "pending",
        output: `output-${definition.id}`, feedbackHistory: [],
      })),
    }],
  };
  const build = run.stages![0].subTasks.find((task) => task.id === "5.3")!;
  build.startedAt = "2026-09-13T10:00:00.000Z";
  build.imageMapCheck = {
    schemaVersion: 1, passed: false, mappedCount: 1,
    missing: [{ file: "hero.webp", section: "Hero", proves: "כותרת", widths: [390, 1280] }],
    attemptStartedAt: "2026-09-13T10:00:00.000Z", assetManifestSha256: "a".repeat(64),
    pageSourceManifestSha256: "b".repeat(64), checkedAt: "2026-09-13T10:05:00.000Z",
  };
  return run;
}

const PAGE_SOURCES = { "page.tsx": "1".repeat(64) };

/** A 5.3 whose check passed and still belongs to this attempt, manifest and page source. */
function buildPassingRun(id: string): Run {
  const run = buildRun(id);
  const subTasks = run.stages![0].subTasks;
  subTasks.find((task) => task.id === "5.2")!.assetManifestSha256 = "a".repeat(64);
  const build = subTasks.find((task) => task.id === "5.3")!;
  build.assetManifestSha256 = "a".repeat(64);
  build.pageSourceHashes = PAGE_SOURCES;
  build.designReview = { schemaVersion: 1, passed: true, failing: [], silent: [], checkedAt: build.startedAt! };
  build.imageMapCheck = {
    schemaVersion: 1, passed: true, mappedCount: 1, missing: [],
    attemptStartedAt: "2026-09-13T10:00:00.000Z", assetManifestSha256: "a".repeat(64),
    pageSourceManifestSha256: hashPageSourceManifest(PAGE_SOURCES), checkedAt: "2026-09-13T10:05:00.000Z",
  };
  return run;
}

function decide(id: string, body: unknown, n = "5", subId = "5.3") {
  return POST(
    new NextRequest(`http://127.0.0.1:3000/api/runs/${id}/stages/${n}/subtasks/${subId}/decide`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id, n, subId }) },
  );
}

function status53(id: string) {
  return getRun(id)?.stages?.[0].subTasks.find((task) => task.id === "5.3")?.status;
}

beforeEach(async () => {
  runsDir = await fs.mkdtemp(path.join(os.tmpdir(), "council-stage53-decision-"));
  process.env.RUNS_DIR_OVERRIDE = runsDir;
  __resetRegistryForTests();
});

afterEach(async () => {
  await flushPersistence();
  __resetRegistryForTests();
  delete process.env.RUNS_DIR_OVERRIDE;
});

describe("Stage 5.3 human approval", () => {
  it("lets a human approve even when the image map check failed", async () => {
    const id = "stage53-human-approves-failed-map";
    createRun(buildRun(id));
    await flushPersistence();

    const response = await POST(
      new NextRequest(`http://127.0.0.1:3000/api/runs/${id}/stages/5/subtasks/5.3/decide`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "approve" }),
      }),
      { params: Promise.resolve({ id, n: "5", subId: "5.3" }) },
    );

    // Approving 5.3 starts 5.4; the route reads started.ok and answers 202 Accepted.
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ ok: true, nextSubTaskId: "5.4", attemptId: "attempt-5-4" });
    expect(getRun(id)?.stages?.[0].subTasks.find((task) => task.id === "5.3")?.status).toBe("approved");
  });
});

describe("Stage 5.3 express approval binding", () => {
  const binding = { attemptStartedAt: "2026-09-13T10:00:00.000Z", checkedAt: "2026-09-13T10:05:00.000Z" };

  it("refuses express when the persisted design review did not pass despite a current passing map", async () => {
    const id = "stage53-express-silent-critic";
    const run = buildPassingRun(id);
    run.stages![0].subTasks.find((task) => task.id === "5.3")!.designReview = {
      schemaVersion: 1, passed: false, failing: [], silent: ["אורי"], checkedAt: binding.checkedAt,
    };
    createRun(run);
    await flushPersistence();
    const response = await decide(id, { action: "approve", expressImageMapCheck: binding });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining("לא הצביע") });
    expect(status53(id)).toBe("awaiting-decision");
  });

  it("approves an express request bound to the passing, current check", async () => {
    const id = "stage53-express-current";
    createRun(buildPassingRun(id));
    await flushPersistence();

    const response = await decide(id, { action: "approve", expressImageMapCheck: binding });

    expect(response.status).toBe(202);
    expect(status53(id)).toBe("approved");
  });

  it("refuses an express request whose checkedAt no longer matches the stored check", async () => {
    const id = "stage53-express-stale-binding";
    createRun(buildPassingRun(id));
    await flushPersistence();

    const response = await decide(id, {
      action: "approve",
      expressImageMapCheck: { ...binding, checkedAt: "2026-09-13T10:09:00.000Z" },
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining("expressImageMapCheck") });
    expect(status53(id)).toBe("awaiting-decision");
  });

  it("refuses an express request when the stored check failed", async () => {
    const id = "stage53-express-failed-check";
    const run = buildPassingRun(id);
    const build = run.stages![0].subTasks.find((task) => task.id === "5.3")!;
    build.imageMapCheck = {
      ...build.imageMapCheck!,
      passed: false,
      missing: [{ file: "hero.webp", section: "Hero", proves: "כותרת", widths: [390] }],
    };
    createRun(run);
    await flushPersistence();

    const response = await decide(id, { action: "approve", expressImageMapCheck: binding });

    expect(response.status).toBe(409);
    expect(status53(id)).toBe("awaiting-decision");
  });

  it("refuses a malformed binding", async () => {
    const id = "stage53-express-malformed";
    createRun(buildPassingRun(id));
    await flushPersistence();

    const response = await decide(id, { action: "approve", expressImageMapCheck: { ...binding, checkedAt: "x".repeat(65) } });

    expect(response.status).toBe(409);
    expect(status53(id)).toBe("awaiting-decision");
  });

  it("rejects the binding on any other stage or sub-task", async () => {
    const id = "stage53-express-wrong-gate";
    createRun(buildPassingRun(id));
    await flushPersistence();

    const response = await decide(id, { action: "approve", expressImageMapCheck: binding }, "5", "5.4");

    expect(response.status).toBe(400);
  });
});
