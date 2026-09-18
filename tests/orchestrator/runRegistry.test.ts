import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createRun,
  updateRun,
  getRun,
  ensureRunLoaded,
  listRunSummaries,
  flushPersistence,
  mutateRun,
  withRunFileLock,
  withRunLock,
  PERSIST_FAILURE_PREFIX,
  __resetRegistryForTests,
} from "@/orchestrator/runRegistry";
import { eventBus } from "@/orchestrator/eventBus";
import { getStageDef } from "@/orchestrator/stageRegistry";
import { saveRunState } from "@/lib/runStore";
import type { Run, SSEEvent } from "@/types";
import { runInExecutionContext } from "@/orchestrator/executionContext";

let testRunsDir: string;

const makeRun = (id: string): Run => ({
  id,
  slug: "test-run",
  brief: "בריף לבדיקה",
  createdAt: "2026-08-26T10:00:00.000Z",
  status: "pending",
  currentRound: null,
  messages: [],
});

beforeEach(async () => {
  testRunsDir = await fs.mkdtemp(path.join(os.tmpdir(), "council-registry-"));
  process.env.RUNS_DIR_OVERRIDE = testRunsDir;
  __resetRegistryForTests();
});

describe("runRegistry persistence", () => {
  it("serializes concurrent state transitions for the same run", async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = withRunLock("same-run", async () => {
      order.push("first-start");
      await gate;
      order.push("first-end");
    });
    const second = withRunLock("same-run", async () => {
      order.push("second-start");
      order.push("second-end");
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(order).toEqual(["first-start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first-start", "first-end", "second-start", "second-end"]);
  });

  it("serializes callers that bypass the in-process queue through the filesystem lock", async () => {
    const id = "2026-08-26-file-lock";
    createRun(makeRun(id));
    await flushPersistence();

    const order: string[] = [];
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = withRunFileLock(id, async () => {
      order.push("first-start");
      await gate;
      order.push("first-end");
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    const second = withRunFileLock(id, async () => {
      order.push("second-start");
      order.push("second-end");
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(order).toEqual(["first-start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first-start", "first-end", "second-start", "second-end"]);
    await expect(
      fs.access(path.join(testRunsDir, id, ".run-state.lock")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recovers an abandoned filesystem lock without deleting a live lock", async () => {
    const id = "2026-08-26-stale-lock";
    createRun(makeRun(id));
    await flushPersistence();
    const lockDir = path.join(testRunsDir, id, ".run-state.lock");
    await fs.mkdir(lockDir);
    await fs.writeFile(path.join(lockDir, "owner.json"), JSON.stringify({
      token: "abandoned",
      pid: 99_999_999,
      createdAt: Date.now() - 60_000,
    }));

    let entered = false;
    await withRunFileLock(id, async () => {
      entered = true;
    });

    expect(entered).toBe(true);
    await expect(fs.access(lockDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an unsafe filesystem lock entry", async () => {
    const id = "2026-08-26-unsafe-lock";
    createRun(makeRun(id));
    await flushPersistence();
    const target = path.join(testRunsDir, id, "not-a-lock");
    const lockPath = path.join(testRunsDir, id, ".run-state.lock");
    await fs.writeFile(target, "unsafe");
    await fs.symlink(target, lockPath);

    await expect(withRunFileLock(id, async () => undefined)).rejects.toThrow(
      `Unsafe state lock for run ${id}`,
    );
  });

  it("reloads the authoritative disk state before an atomic mutation", async () => {
    const id = "2026-08-26-fresh-disk";
    const stale = makeRun(id);
    createRun(stale);
    await flushPersistence();
    await saveRunState(path.join(testRunsDir, id), {
      ...stale,
      status: "approved",
      strategyDoc: "written by another server",
    });

    await mutateRun(id, (run) => ({
      run: { ...run, errorMessage: "local mutation" },
      value: undefined,
    }));

    expect(getRun(id)).toMatchObject({
      status: "approved",
      strategyDoc: "written by another server",
      errorMessage: "local mutation",
    });
  });

  it("loads and persists restart recovery inside the cross-process lock", async () => {
    const id = "2026-08-26-locked-load";
    const initial = makeRun(id);
    createRun(initial);
    await flushPersistence();
    __resetRegistryForTests();

    let releaseWriter!: () => void;
    const writerGate = new Promise<void>((resolve) => {
      releaseWriter = resolve;
    });
    let writerEntered!: () => void;
    const writerReady = new Promise<void>((resolve) => {
      writerEntered = resolve;
    });
    const writer = withRunFileLock(id, async () => {
      await saveRunState(path.join(testRunsDir, id), {
        ...initial,
        status: "approved",
        strategyDoc: "newer state from another process",
      });
      writerEntered();
      await writerGate;
    });
    await writerReady;

    let loadFinished = false;
    const loading = ensureRunLoaded(id).then((run) => {
      loadFinished = true;
      return run;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(loadFinished).toBe(false);

    releaseWriter();
    await writer;
    const loaded = await loading;
    expect(loaded).toMatchObject({
      status: "approved",
      strategyDoc: "newer state from another process",
    });
    expect(JSON.parse(
      await fs.readFile(path.join(testRunsDir, id, "run.json"), "utf8"),
    )).toMatchObject({
      status: "approved",
      strategyDoc: "newer state from another process",
    });
  });

  it("fences state writes from an execution attempt after its lease is replaced", async () => {
    const run = makeRun("2026-08-26-lease");
    const targetKey = "subtask:2026-08-26-lease:5:5.2";
    const now = Date.now();
    run.executionAttempts = {
      [targetKey]: {
        attemptId: "current-attempt",
        ownerId: "test",
        state: "running",
        retrySafety: "safe",
        startedAt: now,
        heartbeatAt: now,
        leaseExpiresAt: now + 10_000,
        deadlineAt: now + 20_000,
      },
    };
    createRun(run);

    await runInExecutionContext(
      { runId: run.id, targetKey, attemptId: "current-attempt" },
      async () => {
        expect(updateRun(run.id, { strategyDoc: "accepted" })?.strategyDoc).toBe("accepted");
      },
    );
    updateRun(run.id, {
      executionAttempts: {
        [targetKey]: { ...run.executionAttempts[targetKey], attemptId: "replacement" },
      },
    });
    await runInExecutionContext(
      { runId: run.id, targetKey, attemptId: "current-attempt" },
      async () => {
        expect(updateRun(run.id, { strategyDoc: "stale" })).toBeUndefined();
      },
    );
    expect(getRun(run.id)?.strategyDoc).toBe("accepted");
  });

  it("fences a stalled worker before it can write after its local lease expired", async () => {
    const run = makeRun("2026-08-26-expired-worker");
    const targetKey = "run:2026-08-26-expired-worker";
    run.executionAttempts = {
      [targetKey]: {
        attemptId: "expired-attempt",
        ownerId: "test",
        state: "running",
        retrySafety: "safe",
        startedAt: 1,
        heartbeatAt: 1,
        leaseExpiresAt: 2,
        deadlineAt: 3,
      },
    };
    createRun(run);

    await runInExecutionContext(
      { runId: run.id, targetKey, attemptId: "expired-attempt" },
      async () => {
        expect(updateRun(run.id, { strategyDoc: "stale write" })).toBeUndefined();
      },
    );
    expect(getRun(run.id)?.strategyDoc).toBeUndefined();
  });

  it("createRun writes the run to disk", async () => {
    createRun(makeRun("2026-08-26-1400"));
    await flushPersistence();
    const raw = await fs.readFile(path.join(testRunsDir, "2026-08-26-1400", "run.json"), "utf-8");
    expect(JSON.parse(raw).id).toBe("2026-08-26-1400");
  });

  it("updateRun persists the patched state", async () => {
    createRun(makeRun("2026-08-26-1401"));
    updateRun("2026-08-26-1401", { status: "approved", strategyDoc: "# אסטרטגיה" });
    await flushPersistence();
    const raw = await fs.readFile(path.join(testRunsDir, "2026-08-26-1401", "run.json"), "utf-8");
    const onDisk = JSON.parse(raw);
    expect(onDisk.status).toBe("approved");
    expect(onDisk.strategyDoc).toBe("# אסטרטגיה");
  });

  // Parked item P1: a save that the run-state validator refuses used to be
  // logged to the console and swallowed, after which every later write of the
  // run failed too and the operator saw a run that looked fine and was not.
  /** A record the run-state validator refuses: a message with no agent slug. */
  const refusedRecord = (): Partial<Run> => ({
    messages: [{ round: 1, content: "x" } as unknown as Run["messages"][number]],
  });

  it("marks the run when a save is refused, instead of continuing in silence", async () => {
    const id = "2026-09-16-persist-refused";
    createRun(makeRun(id));
    await flushPersistence();
    const events: SSEEvent[] = [];
    const unsubscribe = eventBus.subscribe(id, (event) => events.push(event));

    updateRun(id, refusedRecord());
    await expect(flushPersistence()).rejects.toBeInstanceOf(Error);
    unsubscribe();

    // The live page reads this event and shows the banner: it is the only
    // surface an operator has while the run is open.
    const failure = events.find((event) => event.type === "error");
    expect(failure?.errorMessage).toContain(PERSIST_FAILURE_PREFIX);
    // And the run's own log keeps the durable record of it.
    const log = await fs.readFile(path.join(testRunsDir, id, "logs", "run-state.log"), "utf8");
    expect(log).toContain(PERSIST_FAILURE_PREFIX);
    expect(getRun(id)?.persistenceError).toContain(PERSIST_FAILURE_PREFIX);
    // And the disk copy, which is the durable one, never took the bad record.
    const onDisk = JSON.parse(await fs.readFile(path.join(testRunsDir, id, "run.json"), "utf8"));
    expect(onDisk.messages).toEqual([]);
  });

  it("keeps a run's own error message when a save is refused", async () => {
    const id = "2026-09-16-persist-keeps-error";
    createRun({ ...makeRun(id), status: "error", errorMessage: "הסוכן נפל" });
    await flushPersistence();

    updateRun(id, refusedRecord());
    await expect(flushPersistence()).rejects.toBeInstanceOf(Error);

    // The failure that actually stopped the run is what the operator is
    // working on; the persistence note travels beside it, never over it.
    expect(getRun(id)?.errorMessage).toBe("הסוכן נפל");
    expect(getRun(id)?.persistenceError).toContain(PERSIST_FAILURE_PREFIX);
  });

  it("clears the marker once a save succeeds, and never writes it to disk", async () => {
    const id = "2026-09-16-persist-recovers";
    createRun(makeRun(id));
    await flushPersistence();
    updateRun(id, refusedRecord());
    await expect(flushPersistence()).rejects.toBeInstanceOf(Error);
    expect(getRun(id)?.persistenceError).toBeDefined();

    updateRun(id, { messages: [], strategyDoc: "# אסטרטגיה" });
    await flushPersistence();

    expect(getRun(id)?.persistenceError).toBeUndefined();
    const onDisk = JSON.parse(await fs.readFile(path.join(testRunsDir, id, "run.json"), "utf8"));
    expect(onDisk.strategyDoc).toBe("# אסטרטגיה");
    expect(onDisk).not.toHaveProperty("persistenceError");
  });

  it("reports a failed write once and still permits a later durable recovery", async () => {
    const id = "2026-08-26-write-recovery";
    createRun(makeRun(id));
    await flushPersistence();

    const invalidRoot = path.join(testRunsDir, "not-a-directory");
    await fs.writeFile(invalidRoot, "blocking file");
    process.env.RUNS_DIR_OVERRIDE = invalidRoot;
    updateRun(id, { strategyDoc: "not durable" });
    await expect(flushPersistence()).rejects.toBeInstanceOf(Error);

    process.env.RUNS_DIR_OVERRIDE = testRunsDir;
    await expect(mutateRun(id, (run) => ({
      run: { ...run, errorMessage: "recovered" },
      value: true,
    }))).resolves.toBe(true);
    expect(getRun(id)).toMatchObject({ errorMessage: "recovered" });
    expect(getRun(id)?.strategyDoc).toBeUndefined();
  });

  it("rejects updates and mutations that try to change the run id", async () => {
    const id = "2026-08-26-fixed-id";
    createRun(makeRun(id));
    await flushPersistence();

    expect(() => updateRun(id, { id: "2026-08-26-other-id" })).toThrow(
      "A run update cannot change its id",
    );
    await expect(
      mutateRun(id, (run) => ({
        run: { ...run, id: "2026-08-26-other-id" },
        value: true,
      })),
    ).rejects.toThrow("A run mutation cannot change its id");
    expect(getRun(id)?.id).toBe(id);
    await expect(fs.access(path.join(testRunsDir, "2026-08-26-other-id"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("ensureRunLoaded brings a run back after the registry is emptied", async () => {
    createRun(makeRun("2026-08-26-1402"));
    updateRun("2026-08-26-1402", { status: "approved" });
    await flushPersistence();

    __resetRegistryForTests();
    expect(getRun("2026-08-26-1402")).toBeUndefined();

    const restored = await ensureRunLoaded("2026-08-26-1402");
    expect(restored?.status).toBe("approved");
    expect(getRun("2026-08-26-1402")?.id).toBe("2026-08-26-1402");
  });

  it("ensureRunLoaded backfills run.json for a run held only in memory", async () => {
    const run = makeRun("2026-08-26-1405");
    // Simulate a run that exists in memory but whose file never made it to disk
    // (started before persistence existed, or an earlier write failed).
    createRun(run);
    await flushPersistence();
    await fs.rm(path.join(testRunsDir, "2026-08-26-1405", "run.json"));

    await ensureRunLoaded("2026-08-26-1405");
    await flushPersistence();

    const raw = await fs.readFile(path.join(testRunsDir, "2026-08-26-1405", "run.json"), "utf-8");
    expect(JSON.parse(raw).id).toBe("2026-08-26-1405");
  });

  it("ensureRunLoaded brings a saved run in line with the current stage registry", async () => {
    const run: Run = {
      ...makeRun("2026-08-26-1406"),
      stages: [
        {
          number: 5,
          title: "עיצוב + בניית דף נחיתה Next.js",
          ownerSlug: "daniel-lp-designer",
          status: "error",
          output: "",
          errorMessage: "Preflight failed",
          feedbackHistory: [],
          subTasks: [
            { id: "5", title: "בניית דף", status: "error", output: "", feedbackHistory: [] },
          ],
        },
      ],
    };
    createRun(run);
    await flushPersistence();
    __resetRegistryForTests();

    const restored = await ensureRunLoaded("2026-08-26-1406");
    expect(restored?.stages?.[0].subTasks.map((st) => st.id)).toEqual(["5.1", "5.2", "5.3", "5.4"]);
    expect(restored?.stages?.[0].status).toBe("pending");
  });

  it("writes the interrupted state back, so the archive stops showing it as running", async () => {
    const run: Run = {
      ...makeRun("2026-08-26-1407"),
      status: "discussing",
      stages: [
        {
          number: 5,
          title: "עיצוב",
          ownerSlug: "daniel-lp-designer",
          status: "running",
          output: "",
          feedbackHistory: [],
          subTasks: getStageDef(5).subTasks.map((st, i) => ({
            id: st.id,
            title: st.title,
            status: i === 1 ? ("running" as const) : ("pending" as const),
            output: "",
            feedbackHistory: [],
          })),
        },
      ],
    };
    createRun(run);
    await flushPersistence();
    __resetRegistryForTests();

    await ensureRunLoaded("2026-08-26-1407");
    await flushPersistence();

    const onDisk = JSON.parse(
      await fs.readFile(path.join(testRunsDir, "2026-08-26-1407", "run.json"), "utf-8"),
    );
    expect(onDisk.stages[0].subTasks[1].status).toBe("error");
  });

  it("ensureRunLoaded returns undefined for a run that never existed", async () => {
    expect(await ensureRunLoaded("2026-01-01-0000")).toBeUndefined();
  });

  it("listRunSummaries lists runs from disk newest first", async () => {
    createRun(makeRun("2026-08-26-1403"));
    createRun(makeRun("2026-08-26-1404"));
    await flushPersistence();
    __resetRegistryForTests();

    const summaries = await listRunSummaries();
    expect(summaries.map((s) => s.id)).toEqual(["2026-08-26-1404", "2026-08-26-1403"]);
  });
});
