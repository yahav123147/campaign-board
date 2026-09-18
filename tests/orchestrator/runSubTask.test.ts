import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runSubTask } from "@/orchestrator/runSubTask";
import { runStage5LpBuild } from "@/orchestrator/runStage5LpBuild";
import { runStage5Preview } from "@/orchestrator/runStage5Preview";
import { runStage5Assets } from "@/orchestrator/runStage5Assets";
import { spawnAgent } from "@/orchestrator/spawnAgent";
import { createRun, __resetRegistryForTests } from "@/orchestrator/runRegistry";
import type { ExecutionControl } from "@/orchestrator/executionService";
import type { Run } from "@/types";

/** The control the execution service hands an executor, with a claimed budget. */
function controlWithBudget(timeoutMs: number): ExecutionControl {
  return {
    attemptId: "attempt-under-test",
    signal: new AbortController().signal,
    timeoutMs,
    heartbeat: async () => {},
    throwIfAborted: () => {},
  };
}

vi.mock("@/orchestrator/runStage5LpBuild", () => ({
  runStage5LpBuild: vi.fn(async () => {}),
}));

vi.mock("@/orchestrator/runStage5Preview", () => ({
  runStage5Preview: vi.fn(async () => {}),
}));

vi.mock("@/orchestrator/runStage5Assets", () => ({
  runStage5Assets: vi.fn(async () => {}),
}));

vi.mock("@/orchestrator/spawnAgent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/orchestrator/spawnAgent")>()),
  spawnAgent: vi.fn(async () => ({ fullText: "output" })),
}));

let testRunsDir: string;

const runWithStage5 = (id: string): Run => ({
  id,
  slug: "test-run",
  brief: "בריף לבדיקה",
  createdAt: "2026-08-26T10:00:00.000Z",
  status: "awaiting-decision",
  currentRound: null,
  messages: [],
  stages: [
    {
      number: 5,
      title: "עיצוב + בניית דף נחיתה Next.js",
      ownerSlug: "daniel-lp-designer",
      status: "error",
      output: "",
      feedbackHistory: [],
      subTasks: [
        { id: "5.1", title: "בריף מותג", status: "approved", output: "פלטה שאושרה", feedbackHistory: [] },
        { id: "5.2", title: "הפקת נכסים", status: "approved", output: "ASSETS_DIR: none", feedbackHistory: [] },
        { id: "5.3", title: "בניית דף נחיתה", status: "error", output: "", feedbackHistory: [] },
        { id: "5.4", title: "תצוגה מקומית", status: "pending", output: "", feedbackHistory: [] },
      ],
    },
  ],
});

beforeEach(async () => {
  testRunsDir = await fs.mkdtemp(path.join(os.tmpdir(), "council-subtask-"));
  process.env.RUNS_DIR_OVERRIDE = testRunsDir;
  await fs.mkdir(path.join(testRunsDir, "logs"), { recursive: true });
  __resetRegistryForTests();
  vi.mocked(runStage5LpBuild).mockClear();
  vi.mocked(spawnAgent).mockClear();
  vi.mocked(runStage5Preview).mockClear();
  vi.mocked(runStage5Assets).mockClear();
});

describe("runSubTask stage 5 dispatch", () => {
  it("sends the build sub-task to the landing page builder, not the generic agent", async () => {
    createRun(runWithStage5("2026-08-26-1500"));

    await runSubTask("2026-08-26-1500", testRunsDir, 5, "5.3", "נסה שוב");

    // The generic path would hand the agent the stageRegistry placeholder
    // "(handled by runStage5LpBuild)" and never touch a default workspace.
    expect(runStage5LpBuild).toHaveBeenCalledWith("2026-08-26-1500", testRunsDir, "נסה שוב", undefined);
    expect(spawnAgent).not.toHaveBeenCalled();
  });

  it("sends the asset sub-task to the asset runner", async () => {
    createRun(runWithStage5("2026-08-26-1503"));

    await runSubTask("2026-08-26-1503", testRunsDir, 5, "5.2");

    expect(runStage5Assets).toHaveBeenCalledWith("2026-08-26-1503", testRunsDir, undefined, undefined);
    expect(spawnAgent).not.toHaveBeenCalled();
  });

  it("sends the preview sub-task to the preview runner", async () => {
    createRun(runWithStage5("2026-08-26-1501"));

    await runSubTask("2026-08-26-1501", testRunsDir, 5, "5.4");

    expect(runStage5Preview).toHaveBeenCalledWith("2026-08-26-1501", testRunsDir, undefined, undefined);
    expect(spawnAgent).not.toHaveBeenCalled();
  });

  it("runs the brand brief sub-task as a normal agent task", async () => {
    createRun(runWithStage5("2026-08-26-1502"));

    await runSubTask("2026-08-26-1502", testRunsDir, 5, "5.1");

    expect(spawnAgent).toHaveBeenCalled();
    expect(runStage5LpBuild).not.toHaveBeenCalled();
    expect(runStage5Preview).not.toHaveBeenCalled();
  });

  // The agent used to run on spawnAgent's own 60 minute default inside a 90
  // minute execution, so a long turn was killed while the budget that paid for
  // it still had half an hour left.
  it("spawns the agent on the claimed budget, minus the executor's margin", async () => {
    createRun(runWithStage5("2026-08-26-1505"));

    await runSubTask("2026-08-26-1505", testRunsDir, 5, "5.1", undefined, controlWithBudget(90 * 60_000));

    expect(vi.mocked(spawnAgent).mock.calls[0][0].timeoutMs).toBe(75 * 60_000);
  });

  it("leaves spawnAgent its own default when nothing claimed a budget", async () => {
    createRun(runWithStage5("2026-08-26-1506"));

    await runSubTask("2026-08-26-1506", testRunsDir, 5, "5.1");

    expect(vi.mocked(spawnAgent).mock.calls[0][0].timeoutMs).toBeUndefined();
  });

  it("gives the brand researcher web tools without exposing the host", async () => {
    createRun(runWithStage5("2026-08-26-1504"));

    await runSubTask("2026-08-26-1504", testRunsDir, 5, "5.1");

    expect(vi.mocked(spawnAgent).mock.calls[0][0]).toMatchObject({
      permissionMode: "default",
      tools: ["WebSearch", "WebFetch"],
      strictMcpConfig: true,
      settingSources: [],
      disableSlashCommands: true,
    });
  });
});
