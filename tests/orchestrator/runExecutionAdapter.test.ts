import { beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RunExecutionAdapter } from "@/orchestrator/runExecutionAdapter";
import {
  executionTargetKey,
  type ExecutionAttempt,
  type ExecutionClaimIntent,
  type ExecutionTarget,
} from "@/orchestrator/executionManager";
import {
  __resetRegistryForTests,
  createRun,
  flushPersistence,
  getRun,
} from "@/orchestrator/runRegistry";
import { getStageDef } from "@/orchestrator/stageRegistry";
import type { Run, Stage } from "@/types";

let testRunsDir: string;
let adapter: RunExecutionAdapter;
const SHA256_A = "a".repeat(64);
const SHA256_B = "b".repeat(64);
const GIT_SHA = "c".repeat(40);

const runTarget = (runId: string): ExecutionTarget => ({ kind: "run", runId });
const subTaskTarget = (runId: string): ExecutionTarget => ({
  kind: "subtask",
  runId,
  stageNumber: 5,
  subTaskId: "5.2",
});

const previewFeedbackIntent = (feedback: string): ExecutionClaimIntent => ({
  kind: "rewind-subtasks-for-feedback",
  stageNumber: 5,
  fromSubTaskId: "5.3",
  triggerSubTaskId: "5.4",
  feedback,
});

function attempt(overrides: Partial<ExecutionAttempt> = {}): ExecutionAttempt {
  return {
    attemptId: "attempt-1",
    ownerId: "test-owner",
    state: "running",
    retrySafety: "safe",
    startedAt: 100,
    heartbeatAt: 100,
    leaseExpiresAt: 1_100,
    deadlineAt: 10_100,
    ...overrides,
  };
}

function makeRun(id: string): Run {
  const stageDef = getStageDef(5);
  return {
    id,
    slug: "test-run",
    brief: "בריף לבדיקה",
    createdAt: "2026-08-27T10:00:00.000Z",
    status: "approved",
    currentRound: null,
    messages: [],
    currentStage: 5,
    stages: [
      {
        number: 5,
        title: "נכסים ודף נחיתה",
        ownerSlug: "daniel-lp-designer",
        status: "running",
        output: "",
        feedbackHistory: [],
        subTasks: stageDef.subTasks.map((subTask) => ({
          id: subTask.id,
          title: subTask.title,
          status: subTask.id === "5.1" ? "approved" as const : "pending" as const,
          output: "",
          feedbackHistory: [],
        })),
      },
    ],
  };
}

async function readSavedRun(id: string): Promise<Run> {
  const raw = await fs.readFile(path.join(testRunsDir, id, "run.json"), "utf8");
  return JSON.parse(raw) as Run;
}

beforeEach(async () => {
  testRunsDir = await fs.mkdtemp(path.join(os.tmpdir(), "council-execution-adapter-"));
  process.env.RUNS_DIR_OVERRIDE = testRunsDir;
  __resetRegistryForTests();
  adapter = new RunExecutionAdapter();
});

describe("RunExecutionAdapter mutations", () => {
  it("loads a disk-only run and durably stores the exact target entry", async () => {
    const run = makeRun("disk-only");
    createRun(run);
    await flushPersistence();
    __resetRegistryForTests();

    const target = subTaskTarget(run.id);
    const entry = attempt();
    await expect(adapter.tryClaim(target, entry)).resolves.toEqual({ ok: true });

    const saved = await readSavedRun(run.id);
    expect(saved.executionAttempts).toEqual({
      [executionTargetKey(target)]: entry,
    });
  });

  it("serializes concurrent mutations and persists the latest result before resolving", async () => {
    const run = makeRun("atomic");
    const target = runTarget(run.id);
    run.executionAttempts = {
      [executionTargetKey(target)]: attempt({ attemptId: "current" }),
    };
    createRun(run);
    await flushPersistence();
    const seen: number[] = [];

    const first = adapter.mutate(target, (current) => {
      seen.push(current?.heartbeatAt ?? -1);
      return { next: { ...current!, heartbeatAt: 200 }, value: "first" };
    });
    const second = adapter.mutate(target, (current) => {
      seen.push(current?.heartbeatAt ?? -1);
      return { next: { ...current!, heartbeatAt: 300 }, value: "second" };
    });

    await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"]);
    expect(seen).toEqual([100, 200]);
    const saved = await readSavedRun(run.id);
    expect(saved.executionAttempts?.[executionTargetKey(target)]).toMatchObject({
      attemptId: "current",
      heartbeatAt: 300,
    });
  });

  it("atomically rejects parallel claims for different targets in the same run", async () => {
    const run = makeRun("cross-target-atomic");
    createRun(run);
    await flushPersistence();
    const firstTarget = subTaskTarget(run.id);
    const secondTarget: ExecutionTarget = {
      kind: "subtask",
      runId: run.id,
      stageNumber: 5,
      subTaskId: "5.3",
    };

    const [first, second] = await Promise.all([
      adapter.tryClaim(firstTarget, attempt({ attemptId: "first" })),
      adapter.tryClaim(secondTarget, attempt({ attemptId: "second" })),
    ]);

    expect(first).toEqual({ ok: true });
    expect(second).toMatchObject({
      ok: false,
      reason: "already-running",
      activeAttemptId: "first",
    });
    const saved = await readSavedRun(run.id);
    expect(Object.values(saved.executionAttempts ?? {}).filter(
      (candidate) => candidate.state === "running",
    )).toEqual([expect.objectContaining({ attemptId: "first" })]);
  });

  it("re-checks the persisted frontier inside the claim transaction", async () => {
    const run = makeRun("claim-order");
    createRun(run);
    await flushPersistence();
    const futureTarget: ExecutionTarget = {
      kind: "subtask",
      runId: run.id,
      stageNumber: 5,
      subTaskId: "5.3",
    };

    await expect(
      adapter.tryClaim(futureTarget, attempt()),
    ).resolves.toMatchObject({
      ok: false,
      reason: "not-runnable",
      error: expect.stringMatching(/5\.2 must finish first/i),
    });
    expect((await readSavedRun(run.id)).executionAttempts ?? {}).toEqual({});
  });

  it("atomically rewinds 5.3 and 5.4 while claiming the 5.3 feedback rebuild", async () => {
    const run = makeRun("preview-feedback-rebuild");
    const stage5 = run.stages![0];
    stage5.status = "awaiting-decision";
    stage5.output = "stale stage summary";
    stage5.startedAt = "2026-08-27T10:01:00.000Z";
    stage5.completedAt = "2026-08-27T10:02:00.000Z";
    stage5.currentSubTaskId = "5.4";

    const brand = stage5.subTasks.find((task) => task.id === "5.1")!;
    brand.output = "approved brand";
    const assets = stage5.subTasks.find((task) => task.id === "5.2")!;
    assets.status = "approved";
    assets.output = "approved assets";
    assets.assetManifestSha256 = SHA256_A;
    assets.assetContactSheetFile = "contact-sheet.html";
    assets.assetContactSheetSha256 = SHA256_B;

    const build = stage5.subTasks.find((task) => task.id === "5.3")!;
    build.status = "approved";
    build.output = "old build";
    build.startedAt = "2026-08-27T10:03:00.000Z";
    build.completedAt = "2026-08-27T10:04:00.000Z";
    build.feedbackHistory = ["older build note"];
    build.assetManifestSha256 = SHA256_A;
    build.preparedAssetHashes = { "hero.webp": SHA256_B };
    build.pageSourceHashes = { "page.tsx": SHA256_A };
    build.landingHeadSha = GIT_SHA;
    build.landingCommitSha = GIT_SHA;
    build.pageSlug = "old-page";
    build.landingWorktreePath = "/tmp/old-worktree";

    const preview = stage5.subTasks.find((task) => task.id === "5.4")!;
    preview.status = "awaiting-decision";
    preview.output = "old preview report";
    preview.startedAt = "2026-08-27T10:05:00.000Z";
    preview.completedAt = "2026-08-27T10:06:00.000Z";
    preview.feedbackHistory = ["older preview note"];

    const stage4Definition = getStageDef(4);
    const previousStage: Stage = {
      number: 4,
      title: stage4Definition.title,
      ownerSlug: stage4Definition.ownerSlug,
      status: "approved",
      output: "approved copy",
      feedbackHistory: ["keep stage 4 history"],
      completedAt: "2026-08-27T10:00:30.000Z",
      subTasks: stage4Definition.subTasks.map((task) => ({
        id: task.id,
        title: task.title,
        status: "approved",
        output: "approved copy task",
        feedbackHistory: [],
      })),
    };
    run.stages!.unshift(previousStage);

    createRun(run);
    await flushPersistence();
    const target: ExecutionTarget = {
      kind: "subtask",
      runId: run.id,
      stageNumber: 5,
      subTaskId: "5.3",
    };
    const feedback = "Move the CTA above the fold";

    await expect(
      adapter.tryClaim(target, attempt(), previewFeedbackIntent(feedback)),
    ).resolves.toEqual({ ok: true });

    const saved = await readSavedRun(run.id);
    expect(saved.stages?.find((stage) => stage.number === 4)).toEqual(previousStage);
    const savedStage = saved.stages!.find((stage) => stage.number === 5)!;
    expect(savedStage).toMatchObject({ status: "pending", output: "" });
    expect(savedStage.currentSubTaskId).toBeUndefined();
    expect(savedStage.startedAt).toBeUndefined();
    expect(savedStage.completedAt).toBeUndefined();
    expect(savedStage.subTasks.find((task) => task.id === "5.1")).toMatchObject({
      status: "approved",
      output: "approved brand",
    });
    expect(savedStage.subTasks.find((task) => task.id === "5.2")).toMatchObject({
      status: "approved",
      output: "approved assets",
      assetManifestSha256: SHA256_A,
      assetContactSheetFile: "contact-sheet.html",
      assetContactSheetSha256: SHA256_B,
    });
    const savedBuild = savedStage.subTasks.find((task) => task.id === "5.3")!;
    expect(savedBuild).toMatchObject({
      status: "pending",
      output: "",
      feedbackHistory: ["older build note"],
    });
    expect(savedBuild.startedAt).toBeUndefined();
    expect(savedBuild.completedAt).toBeUndefined();
    expect(savedBuild.assetManifestSha256).toBeUndefined();
    expect(savedBuild.preparedAssetHashes).toBeUndefined();
    expect(savedBuild.pageSourceHashes).toBeUndefined();
    expect(savedBuild.landingHeadSha).toBeUndefined();
    expect(savedBuild.landingCommitSha).toBeUndefined();
    expect(savedBuild.pageSlug).toBeUndefined();
    expect(savedBuild.landingWorktreePath).toBeUndefined();
    const savedPreview = savedStage.subTasks.find((task) => task.id === "5.4")!;
    expect(savedPreview).toMatchObject({
      status: "pending",
      output: "",
      feedbackHistory: ["older preview note", feedback],
    });
    expect(savedPreview.startedAt).toBeUndefined();
    expect(savedPreview.completedAt).toBeUndefined();
    expect(saved.executionAttempts).toEqual({
      [executionTargetKey(target)]: attempt(),
    });
  });

  it("does not rewind review state when the feedback claim loses the run claim", async () => {
    const run = makeRun("busy-preview-feedback");
    const stage5 = run.stages![0];
    stage5.subTasks.find((task) => task.id === "5.2")!.status = "approved";
    stage5.subTasks.find((task) => task.id === "5.3")!.status = "approved";
    const preview = stage5.subTasks.find((task) => task.id === "5.4")!;
    preview.status = "awaiting-decision";
    preview.output = "keep this preview";
    const owner = runTarget(run.id);
    run.executionAttempts = {
      [executionTargetKey(owner)]: attempt({ attemptId: "current-owner" }),
    };
    createRun(run);
    await flushPersistence();
    const target: ExecutionTarget = {
      kind: "subtask",
      runId: run.id,
      stageNumber: 5,
      subTaskId: "5.3",
    };

    await expect(
      adapter.tryClaim(
        target,
        attempt({ attemptId: "losing-claim" }),
        previewFeedbackIntent("Rebuild this page"),
      ),
    ).resolves.toMatchObject({
      ok: false,
      reason: "already-running",
      activeAttemptId: "current-owner",
    });

    const saved = await readSavedRun(run.id);
    expect(saved.stages?.[0].subTasks.find((task) => task.id === "5.3")?.status)
      .toBe("approved");
    expect(saved.stages?.[0].subTasks.find((task) => task.id === "5.4")).toMatchObject({
      status: "awaiting-decision",
      output: "keep this preview",
      feedbackHistory: [],
    });
    expect(saved.executionAttempts).toEqual(run.executionAttempts);
  });

  it("rejects attempts that bypass the atomic claim boundary", async () => {
    const run = makeRun("no-mutate-claim");
    createRun(run);
    await flushPersistence();

    await expect(
      adapter.mutate(subTaskTarget(run.id), () => ({
        next: attempt(),
        value: undefined,
      })),
    ).rejects.toThrow("must be created through tryClaim");
  });

  it("throws without invoking the mutation when the run is missing", async () => {
    let called = false;
    await expect(
      adapter.mutate(runTarget("missing"), () => {
        called = true;
        return { next: attempt(), value: undefined };
      }),
    ).rejects.toThrow("missing run missing");
    expect(called).toBe(false);
  });

  it("deletes only the requested entry and persists the deletion", async () => {
    const run = makeRun("delete-one");
    const target = subTaskTarget(run.id);
    const otherTarget = runTarget(run.id);
    run.executionAttempts = {
      [executionTargetKey(target)]: attempt(),
      [executionTargetKey(otherTarget)]: attempt({
        attemptId: "keep-me",
        state: "error",
        endedAt: 500,
        failureReason: "execution-error",
        errorMessage: "kept failure",
      }),
    };
    createRun(run);
    await flushPersistence();

    await adapter.mutate(target, (current) => ({
      next: undefined,
      value: current?.attemptId,
    }));

    expect(getRun(run.id)?.executionAttempts).toEqual({
      [executionTargetKey(otherTarget)]: expect.objectContaining({ attemptId: "keep-me" }),
    });
    expect((await readSavedRun(run.id)).executionAttempts).toEqual(
      getRun(run.id)?.executionAttempts,
    );
  });

  it("rejects a loaded run whose embedded id does not match the target", async () => {
    const run = makeRun("directory-id");
    createRun({ ...run, id: "embedded-id" });
    await flushPersistence();
    await fs.rename(
      path.join(testRunsDir, "embedded-id"),
      path.join(testRunsDir, "directory-id"),
    );
    __resetRegistryForTests();

    await expect(
      adapter.mutate(runTarget("directory-id"), () => ({
        next: attempt(),
        value: undefined,
      })),
    ).rejects.toThrow("missing run directory-id");
  });
});

describe("RunExecutionAdapter error projection", () => {
  it("projects a run execution error onto the run in the same durable write", async () => {
    const run = makeRun("run-error");
    run.currentRound = "synthesis";
    run.status = "synthesizing";
    createRun(run);
    await flushPersistence();
    const target = runTarget(run.id);

    await adapter.mutate(target, () => ({
      next: attempt({
        state: "error",
        endedAt: 500,
        failureReason: "deadline-exceeded",
        errorMessage: "deadline reached",
      }),
      value: undefined,
    }));

    const saved = await readSavedRun(run.id);
    expect(saved).toMatchObject({
      status: "error",
      currentRound: null,
      errorMessage: "deadline reached",
    });
    expect(saved.executionAttempts?.[executionTargetKey(target)]).toMatchObject({
      state: "error",
      errorMessage: "deadline reached",
    });
  });

  it("projects a sub-task error and marks its running stage error", async () => {
    const run = makeRun("subtask-error");
    createRun(run);
    await flushPersistence();
    const target = subTaskTarget(run.id);

    await adapter.mutate(target, () => ({
      next: attempt({ state: "error", errorMessage: "worker stopped" }),
      value: undefined,
    }));

    const saved = await readSavedRun(run.id);
    expect(saved.stages?.[0]).toMatchObject({
      status: "error",
      errorMessage: "worker stopped",
    });
    expect(
      saved.stages?.[0].subTasks.find((subTask) => subTask.id === "5.2"),
    ).toMatchObject({
      status: "error",
      errorMessage: "worker stopped",
    });
  });

  it("does not overwrite a non-running stage status when its sub-task fails", async () => {
    const run = makeRun("review-stage");
    run.stages![0].status = "awaiting-decision";
    createRun(run);
    await flushPersistence();

    await adapter.mutate(subTaskTarget(run.id), () => ({
      next: attempt({ state: "error", errorMessage: "late worker error" }),
      value: undefined,
    }));

    const saved = await readSavedRun(run.id);
    const savedSubTask = saved.stages?.[0].subTasks.find((subTask) => subTask.id === "5.2");
    expect(saved.stages?.[0].status).toBe("awaiting-decision");
    expect(savedSubTask).toMatchObject({
      status: "error",
      errorMessage: "late worker error",
    });
  });
});

describe("RunExecutionAdapter running discovery", () => {
  it("returns valid memory attempts and ignores malformed or mismatched keys", async () => {
    const run = makeRun("encoded-run_id");
    const validTarget = subTaskTarget(run.id);
    createRun(run);
    await flushPersistence();
    run.executionAttempts = {
      [executionTargetKey(validTarget)]: attempt(),
      "subtask:%E0%A4%A:5:5.2": attempt({ attemptId: "bad-escape" }),
      "subtask:someone-else:5:5.2": attempt({ attemptId: "wrong-run" }),
      "subtask:encoded-run_id:05:5.2": attempt({ attemptId: "non-canonical" }),
      "subtask:encoded-run_id:not-a-number:5.2": attempt({ attemptId: "bad-stage" }),
      "run:encoded-run_id:extra": attempt({ attemptId: "too-many-parts" }),
    };

    await expect(adapter.listRunning()).resolves.toEqual([
      { target: validTarget, attempt: attempt() },
    ]);
  });

  it("discovers disk-only runs and recovers their stale running attempt as interrupted", async () => {
    const run = makeRun("disk-zombie");
    const target = subTaskTarget(run.id);
    run.executionAttempts = {
      [executionTargetKey(target)]: attempt(),
    };
    createRun(run);
    await flushPersistence();
    __resetRegistryForTests();

    await expect(adapter.listRunning()).resolves.toEqual([]);
    await flushPersistence();
    const saved = await readSavedRun(run.id);
    expect(saved.executionAttempts?.[executionTargetKey(target)]).toMatchObject({
      state: "error",
      failureReason: "process-restarted",
    });
  });
});
