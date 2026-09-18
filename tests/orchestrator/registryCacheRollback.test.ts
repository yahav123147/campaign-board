import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as runStore from "@/lib/runStore";
import {
  createRun,
  flushPersistence,
  getRun,
  mutateRun,
  updateRun,
  __resetRegistryForTests,
} from "@/orchestrator/runRegistry";
import type { Run } from "@/types";

let testRunsDir: string;
const RUN_ID = "2026-08-28-1300";

function baseRun(id: string): Run {
  return {
    id,
    slug: "test-run",
    brief: "בריף לבדיקה",
    createdAt: "2026-08-28T09:00:00.000Z",
    status: "approved",
    currentRound: null,
    messages: [],
    currentStage: 1,
    stages: [
      {
        number: 1,
        title: "מחקר שוק",
        ownerSlug: "rafael-researcher",
        status: "running",
        output: "",
        feedbackHistory: [],
        subTasks: [
          { id: "1", title: "מסמך מחקר שוק", status: "running", output: "", feedbackHistory: [] },
        ],
      },
    ],
  };
}

function withFinishedSubTask(run: Run): Run {
  return {
    ...run,
    stages: run.stages!.map((stage) => ({
      ...stage,
      subTasks: stage.subTasks.map((subTask) => ({
        ...subTask,
        status: "awaiting-decision" as const,
        output: "תוצר הסוכן",
      })),
    })),
  };
}

beforeEach(async () => {
  testRunsDir = await fs.mkdtemp(path.join(os.tmpdir(), "council-rollback-"));
  process.env.RUNS_DIR_OVERRIDE = testRunsDir;
  __resetRegistryForTests();
});

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.RUNS_DIR_OVERRIDE;
  await fs.rm(testRunsDir, { recursive: true, force: true });
});

describe("a lock holder never rolls the cache back to an older disk copy", () => {
  /**
   * The trace from a real stage-3 run:
   *   updateRun    -> sub-task awaiting-decision   (no lock held)
   *   lockRefresh  <- disk still says running      (lease heartbeat / complete)
   *   updateRun    -> running                      (the stale copy written back)
   * The finished output was lost and the approve gate answered "SubTask is
   * 'running'". Reproduced here by writing the cache while the lock holder's
   * disk read is in flight.
   */
  it("keeps a finished sub-task that was cached during the lock holder's read", async () => {
    createRun(baseRun(RUN_ID));
    await fs.mkdir(path.join(testRunsDir, RUN_ID), { recursive: true });
    await runStore.saveRunState(path.join(testRunsDir, RUN_ID), baseRun(RUN_ID));

    const realLoad = runStore.loadRunState;
    let injected = false;
    vi.spyOn(runStore, "loadRunState").mockImplementation(async (id, options) => {
      const stale = await realLoad(id, options);
      if (!injected) {
        injected = true;
        // The agent finishes here: markSubTaskAwaitingDecision writes the
        // cache while this read is already holding an older snapshot.
        updateRun(RUN_ID, withFinishedSubTask(getRun(RUN_ID)!));
      }
      return stale;
    });

    // Any lock holder reproduces it. This is the shape the execution manager
    // uses when it completes an attempt and clears the lease.
    await mutateRun(RUN_ID, (run) => ({
      run: { ...run, executionAttempts: {} },
      value: null,
    }));

    expect(getRun(RUN_ID)?.stages?.[0].subTasks[0].status).toBe("awaiting-decision");

    const persisted = await realLoad(RUN_ID, { markInterrupted: false });
    expect(persisted?.stages?.[0].subTasks[0].status).toBe("awaiting-decision");
    expect(persisted?.stages?.[0].subTasks[0].output).toBe("תוצר הסוכן");
    // The lock holder's own change must survive alongside the rescued cache.
    expect(persisted?.executionAttempts).toEqual({});
  });

  it("still refreshes the cache from disk when the cache has nothing pending", async () => {
    createRun(baseRun(RUN_ID));
    // Let this process's own write settle first, or it would race the write
    // below and the test would be measuring its own setup.
    await flushPersistence();
    const runDir = path.join(testRunsDir, RUN_ID);
    // Another process advances the run on disk.
    await runStore.saveRunState(runDir, withFinishedSubTask(baseRun(RUN_ID)));

    await mutateRun(RUN_ID, (run) => ({ run, value: null }));

    expect(getRun(RUN_ID)?.stages?.[0].subTasks[0].status).toBe("awaiting-decision");
  });
});
