import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startSubTaskExecution } from "@/orchestrator/runSubTask";
import { spawnAgent } from "@/orchestrator/spawnAgent";
import { createRun, ensureRunLoaded, __resetRegistryForTests } from "@/orchestrator/runRegistry";
import { __resetExecutionServiceForTests } from "@/orchestrator/executionService";
import { loadRunState } from "@/lib/runStore";
import type { Run } from "@/types";

vi.mock("@/orchestrator/spawnAgent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/orchestrator/spawnAgent")>()),
  spawnAgent: vi.fn(async () => ({ fullText: "תוצר הסוכן", exitCode: 0, durationMs: 1 })),
}));

vi.mock("@/orchestrator/loadAgents", () => ({
  loadAgents: vi.fn(async () => [
    {
      slug: "rafael-researcher",
      name: "רפאל לוי",
      role: "חוקר",
      color: "#06B6D4",
      order: 7,
      active: true,
      systemPrompt: "prompt",
      avatarPath: "avatar.png",
    },
  ]),
}));

let testRunsDir: string;

const RUN_ID = "2026-08-28-1200";

function runAtStage1(id: string): Run {
  return {
    id,
    slug: "test-run",
    brief: "בריף לבדיקה",
    createdAt: "2026-08-28T09:00:00.000Z",
    status: "approved",
    currentRound: null,
    messages: [],
    strategyDoc: "אסטרטגיה",
    currentStage: 1,
    stages: [
      {
        number: 1,
        title: "מחקר שוק",
        ownerSlug: "rafael-researcher",
        status: "pending",
        output: "",
        feedbackHistory: [],
        subTasks: [
          { id: "1", title: "מסמך מחקר שוק", status: "pending", output: "", feedbackHistory: [] },
        ],
      },
    ],
  };
}

beforeEach(async () => {
  testRunsDir = await fs.mkdtemp(path.join(os.tmpdir(), "council-persist-"));
  process.env.RUNS_DIR_OVERRIDE = testRunsDir;
  __resetExecutionServiceForTests();
  __resetRegistryForTests();
  vi.mocked(spawnAgent).mockClear();
});

afterEach(async () => {
  __resetExecutionServiceForTests();
  delete process.env.RUNS_DIR_OVERRIDE;
  await fs.rm(testRunsDir, { recursive: true, force: true });
});

describe("a finished sub-task survives its own execution teardown", () => {
  it("persists awaiting-decision and the agent output after the claim completes", async () => {
    createRun(runAtStage1(RUN_ID));
    const runDir = path.join(testRunsDir, RUN_ID);
    await fs.mkdir(runDir, { recursive: true });

    const started = await startSubTaskExecution(RUN_ID, runDir, 1, "1");
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await started.completion;

    // The artifact is written with await, so it is always on disk. The run
    // state must tell the same story, or the approve gate refuses the work.
    const artifact = await fs.readFile(path.join(runDir, "stage-1", "1.md"), "utf8");
    expect(artifact).toBe("תוצר הסוכן");

    const persisted = await loadRunState(RUN_ID, { markInterrupted: false });
    const subTask = persisted?.stages?.[0].subTasks[0];
    expect(subTask?.status).toBe("awaiting-decision");
    expect(subTask?.output).toBe("תוצר הסוכן");
  });

  it("survives an SSE reader reloading the run while the agent finishes", async () => {
    createRun(runAtStage1(RUN_ID));
    const runDir = path.join(testRunsDir, RUN_ID);
    await fs.mkdir(runDir, { recursive: true });

    // Every browser tab on the run page opens /stream, and each reconnect calls
    // ensureRunLoaded, which takes the run lock and refreshes the cache from
    // disk. That reader must not be able to roll back finished work.
    let readersRunning = true;
    const readers = (async () => {
      while (readersRunning) await ensureRunLoaded(RUN_ID);
    })();

    const started = await startSubTaskExecution(RUN_ID, runDir, 1, "1");
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await started.completion;
    readersRunning = false;
    await readers;

    const persisted = await loadRunState(RUN_ID, { markInterrupted: false });
    const subTask = persisted?.stages?.[0].subTasks[0];
    expect(subTask?.status).toBe("awaiting-decision");
    expect(subTask?.output).toBe("תוצר הסוכן");
  });
});
