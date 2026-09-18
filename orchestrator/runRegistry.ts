import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { Run } from "@/types";
import { reconcileStages } from "./stageRegistry";
import { currentExecutionContext } from "./executionContext";
import {
  appendLog,
  loadRunState,
  saveRunState,
  runDirFor,
  listRunIds,
  readRunSummary,
  type RunSummary,
} from "@/lib/runStore";
import { eventBus } from "./eventBus";

const globalForRegistry = globalThis as unknown as {
  __councilRuns?: Map<string, Run>;
  __councilRunLocks?: Map<string, Promise<void>>;
};

const runs = globalForRegistry.__councilRuns ?? new Map<string, Run>();
globalForRegistry.__councilRuns = runs;
const runLocks = globalForRegistry.__councilRunLocks ?? new Map<string, Promise<void>>();
globalForRegistry.__councilRunLocks = runLocks;

const FILE_LOCK_NAME = ".run-state.lock";
const FILE_LOCK_OWNER = "owner.json";
const FILE_LOCK_WAIT_MS = 10_000;
const FILE_LOCK_STALE_MS = 30_000;
const FILE_LOCK_POLL_MS = 40;
const FILE_LOCK_MAX_OWNER_BYTES = 4 * 1024;
const NO_FOLLOW = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;

interface FileLockOwner {
  token: string;
  pid: number;
  createdAt: number;
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

async function pathKind(target: string): Promise<"missing" | "directory" | "unsafe"> {
  try {
    const stat = await fs.lstat(target);
    return !stat.isSymbolicLink() && stat.isDirectory() ? "directory" : "unsafe";
  } catch (error) {
    if (isErrno(error, "ENOENT")) return "missing";
    throw error;
  }
}

async function readFileLockOwner(lockDir: string): Promise<FileLockOwner | null> {
  const ownerPath = path.join(lockDir, FILE_LOCK_OWNER);
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    const beforeOpen = await fs.lstat(ownerPath);
    if (beforeOpen.isSymbolicLink() || !beforeOpen.isFile()) return null;
    handle = await fs.open(ownerPath, fsConstants.O_RDONLY | NO_FOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > FILE_LOCK_MAX_OWNER_BYTES) return null;
    const raw = await handle.readFile({ encoding: "utf8" });
    const parsed = JSON.parse(raw) as Partial<FileLockOwner>;
    return (
      typeof parsed.token === "string"
      && parsed.token.length > 0
      && Number.isSafeInteger(parsed.pid)
      && Number(parsed.pid) > 0
      && typeof parsed.createdAt === "number"
      && Number.isFinite(parsed.createdAt)
    )
      ? parsed as FileLockOwner
      : null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isErrno(error, "ESRCH");
  }
}

async function reclaimStaleFileLock(
  runDir: string,
  lockDir: string,
  owner: FileLockOwner | null,
): Promise<boolean> {
  const age = Date.now() - (owner?.createdAt ?? 0);
  if (owner && (age <= FILE_LOCK_STALE_MS || processIsAlive(owner.pid))) return false;

  // A malformed lock is left alone briefly in case its creator is between the
  // atomic mkdir and owner-file write. Afterwards it is treated as abandoned.
  if (!owner) {
    const stat = await fs.lstat(lockDir).catch(() => null);
    if (!stat || Date.now() - stat.mtimeMs <= FILE_LOCK_STALE_MS) return false;
  }

  const quarantine = path.join(
    runDir,
    `.run-state.stale.${process.pid}.${crypto.randomUUID()}`,
  );
  try {
    await fs.rename(lockDir, quarantine);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return true;
    return false;
  }
  await fs.rm(quarantine, { recursive: true, force: true });
  return true;
}

async function acquireRunFileLock(id: string): Promise<(() => Promise<void>) | null> {
  const runDir = runDirFor(id);
  const runDirKind = await pathKind(runDir);
  // `withRunLock` is also a useful process-local primitive before a run exists.
  if (runDirKind === "missing") return null;
  if (runDirKind !== "directory") {
    throw new Error(`Unsafe run directory for ${id}`);
  }

  const lockDir = path.join(runDir, FILE_LOCK_NAME);
  const owner: FileLockOwner = {
    token: crypto.randomUUID(),
    pid: process.pid,
    createdAt: Date.now(),
  };
  const deadline = Date.now() + FILE_LOCK_WAIT_MS;

  while (true) {
    try {
      await fs.mkdir(lockDir, { mode: 0o700 });
      try {
        const ownerPath = path.join(lockDir, FILE_LOCK_OWNER);
        const handle = await fs.open(
          ownerPath,
          fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NO_FOLLOW,
          0o600,
        );
        try {
          await handle.writeFile(JSON.stringify(owner));
          await handle.sync();
        } finally {
          await handle.close();
        }
      } catch (error) {
        await fs.rm(lockDir, { recursive: true, force: true }).catch(() => {});
        throw error;
      }

      return async () => {
        const current = await readFileLockOwner(lockDir);
        if (current?.token !== owner.token) return;
        const released = path.join(
          runDir,
          `.run-state.released.${process.pid}.${crypto.randomUUID()}`,
        );
        try {
          await fs.rename(lockDir, released);
        } catch (error) {
          if (isErrno(error, "ENOENT")) return;
          throw error;
        }
        await fs.rm(released, { recursive: true, force: true });
      };
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
    }

    const kind = await pathKind(lockDir);
    if (kind === "unsafe") {
      throw new Error(`Unsafe state lock for run ${id}`);
    }
    if (kind === "directory") {
      const existingOwner = await readFileLockOwner(lockDir);
      if (await reclaimStaleFileLock(runDir, lockDir, existingOwner)) continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for the state lock for run ${id}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, FILE_LOCK_POLL_MS));
  }
}

/**
 * Serialize a transition across local server processes that share one data
 * directory. The caller's operation must stay short and must not start agents.
 */
export async function withRunFileLock<T>(
  id: string,
  operation: () => Promise<T>,
): Promise<T> {
  const release = await acquireRunFileLock(id);
  try {
    return await operation();
  } finally {
    await release?.();
  }
}

/** Serialize read-check-write transitions for one run locally and on disk. */
export async function withRunLock<T>(id: string, operation: () => Promise<T>): Promise<T> {
  const previous = runLocks.get(id) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  runLocks.set(id, tail);
  await previous;
  try {
    return await withRunFileLock(id, async () => {
      // The filesystem lock only gives us exclusivity. Refresh the process's
      // cache as well, otherwise a second local server could make a perfectly
      // serialized decision using stale memory and overwrite the live owner.
      const hadCachedRun = runs.has(id);
      const cachedBeforeRefresh = runs.get(id);
      await flushPersistence();
      const fromDisk = await loadRunState(id, {
        // A run first seen by this process may have been interrupted by a
        // restart. A cached run is live in this process, so refreshing it must
        // not rewrite its own in-flight state as interrupted.
        markInterrupted: !hadCachedRun,
      });
      // A cache write can land between the flush above and this read. Adopting
      // the disk copy then would roll back work that is already finished, so
      // the newer cache wins and is written out instead.
      // בדיקת הזהות סוגרת מרוץ שסימון persisted לבדו מפספס: עדכון שנכנס אחרי
      // תחילת ה-flush יכול להיכתב לדיסק אחרי שקריאת הדיסק כאן כבר החזירה בייטים
      // ישנים; ברגע ההחלטה הוא מסומן persisted, וההגנה הישנה אימצה את הגרסה
      // הישנה ודרסה תוצר גמור (F101). אם המטמון זז במהלך הרענון, המטמון מנצח.
      if (fromDisk && hadCachedRun && (runs.get(id) !== cachedBeforeRefresh || cacheHasUnpersistedChanges(id))) {
        const cached = runs.get(id)!;
        const current = currentStageShape(cached);
        runs.set(id, current);
        await persist(current);
        return operation();
      }
      if (fromDisk) {
        const current = currentStageShape(fromDisk);
        runs.set(id, current);
        // First-load interruption recovery and schema reconciliation are
        // durable transitions. Persist them while the cross-process lock is
        // still held so a concurrent server cannot be overwritten by a stale
        // read followed by a delayed write.
        if (!hadCachedRun || current !== fromDisk) await persist(current);
        // Adopted straight from the disk, so the cache matches what is stored
        // and the next lock holder may refresh from disk again.
        else persistedSnapshots.set(current, true);
      } else if (hadCachedRun) {
        const cached = runs.get(id);
        if (cached) {
          const current = currentStageShape(cached);
          runs.set(id, current);
          // Backfill a missing legacy run.json at the same durability boundary
          // as every other transition, rather than queueing it after unlock.
          await persist(current);
        }
      }
      return operation();
    });
  } finally {
    release();
    if (runLocks.get(id) === tail) runLocks.delete(id);
  }
}

/**
 * Disk writes are chained, never parallel: two saves of the same run racing
 * each other could rename their temp files out of order and persist stale state.
 */
let pendingWrites: Promise<void> = Promise.resolve();

/**
 * The last snapshot of each run that is known to have reached the disk.
 *
 * `updateRun` writes the cache without holding the run lock, so a lock holder
 * that flushes and then reads can observe a disk copy that is older than the
 * cache. Without this marker it adopts that copy, silently rolling back
 * finished work, and then persists the rollback. Identity comparison is enough
 * because every cache write installs a fresh object.
 */
const persistedSnapshots = new WeakMap<Run, true>();

/**
 * Snapshots whose write failed. They are not durable and must not be rescued:
 * the disk copy stays authoritative so a failed write cannot be resurrected
 * later as if it had succeeded.
 */
const failedSnapshots = new WeakMap<Run, true>();

/** What a run says about itself when a write of it did not reach the disk. */
export const PERSIST_FAILURE_PREFIX = "שמירת מצב הריצה נכשלה";

/** Where a run keeps the record of its own failed writes. */
const PERSIST_LOG_NAME = "run-state.log";

/**
 * The run as the disk may hold it.
 *
 * `persistenceError` is a fact ABOUT saving this run, not part of it: a run
 * read back from disk was, by definition, saved. Stripping it here is what
 * keeps a transient failure from becoming a permanent line in run.json.
 */
function forDisk(run: Run): Run {
  if (run.persistenceError === undefined) return run;
  const copy = { ...run };
  delete copy.persistenceError;
  return copy;
}

/**
 * A write that did not reach the disk, said out loud.
 *
 * From that moment the run in memory and the run on disk disagree: a gate
 * decision, a sealed manifest or a finished sub-task may not survive a
 * restart, and the operator has no other way to learn it. So it is said three
 * times over: to the console with the run id, onto the run's event stream
 * (where the live page renders it as its error banner) and into the run's own
 * log, which outlives the process. On the run itself it lands beside
 * `errorMessage`, never over it: a run that failed for a reason of its own
 * keeps that reason. The marked snapshot is recorded as failed like the one
 * before it, because it is not durable either: the disk copy stays
 * authoritative.
 */
async function reportPersistenceFailure(run: Run, error: unknown): Promise<void> {
  const message = `${PERSIST_FAILURE_PREFIX}: ${error instanceof Error ? error.message : String(error)}`;
  const cached = runs.get(run.id);
  // A repeated identical failure is not new information: it must not install a
  // fresh cache object (identity is how other readers tell movement apart),
  // nor repeat the banner and the log line.
  if (cached?.persistenceError === message) return;
  if (cached) {
    const marked: Run = { ...cached, persistenceError: message };
    runs.set(run.id, marked);
    failedSnapshots.set(marked, true);
  }
  eventBus.emit(run.id, { type: "error", runId: run.id, errorMessage: message });
  // The log is the durable half: an operator who opens the run tomorrow reads
  // it there. It must never turn a failed save into a second failure.
  await appendLog(
    runDirFor(run.id),
    PERSIST_LOG_NAME,
    `${new Date().toISOString()} ${message}\n`,
  ).catch(() => {});
}

/** A save that succeeded clears the marker: the run and the disk agree again. */
function clearPersistenceFailure(id: string): void {
  const cached = runs.get(id);
  if (!cached?.persistenceError) return;
  const cleared = forDisk(cached);
  runs.set(id, cleared);
  // It is exactly what was just written, so it is as persisted as its source.
  if (persistedSnapshots.has(cached)) persistedSnapshots.set(cleared, true);
}

function persist(run: Run): Promise<void> {
  // Validate synchronously before accepting work into the persistence queue.
  // This keeps a malformed id from becoming a silent asynchronous failure.
  runDirFor(run.id);
  const write = pendingWrites
    .catch(() => {})
    .then(() => saveRunState(runDirFor(run.id), forDisk(run)))
    .then(
      () => {
        persistedSnapshots.set(run, true);
        clearPersistenceFailure(run.id);
      },
      // Reported before the rejection reaches anyone, so a caller that waits
      // for the write never observes the failure ahead of the operator.
      async (error: unknown) => {
        failedSnapshots.set(run, true);
        console.error(`[runRegistry] failed to persist run ${run.id}:`, error);
        await reportPersistenceFailure(run, error);
        throw error;
      },
    );
  pendingWrites = write;
  // The queue and flushPersistence carry the rejection; this only keeps a
  // write nobody awaited from surfacing as an unhandled rejection.
  void write.catch(() => {});
  return write;
}

/** Whether the cached run still holds changes that no disk write has taken. */
function cacheHasUnpersistedChanges(id: string): boolean {
  const cached = runs.get(id);
  return cached !== undefined
    && !persistedSnapshots.has(cached)
    && !failedSnapshots.has(cached);
}

/** Resolves once every queued write has hit the disk. */
export async function flushPersistence(): Promise<void> {
  const snapshot = pendingWrites;
  try {
    await snapshot;
  } catch (error) {
    // Report the failed durability boundary once, but do not poison every
    // future recovery/watchdog mutation in this process forever.
    if (pendingWrites === snapshot) pendingWrites = Promise.resolve();
    throw error;
  }
}

export function createRun(run: Run): void {
  runDirFor(run.id);
  if (runs.has(run.id)) throw new Error(`Run ${run.id} already exists in this process`);
  runs.set(run.id, run);
  persist(run);
}

export function getRun(id: string): Run | undefined {
  return runs.get(id);
}

export function updateRun(id: string, patch: Partial<Run>): Run | undefined {
  runDirFor(id);
  if (Object.prototype.hasOwnProperty.call(patch, "id") && patch.id !== id) {
    throw new TypeError("A run update cannot change its id");
  }
  const existing = runs.get(id);
  if (!existing) return undefined;
  const execution = currentExecutionContext();
  if (execution?.runId === id) {
    const active = existing.executionAttempts?.[execution.targetKey];
    if (
      !active
      || active.attemptId !== execution.attemptId
      || active.state !== "running"
      || active.leaseExpiresAt <= Date.now()
      || active.deadlineAt <= Date.now()
    ) {
      console.warn(
        `[runRegistry] fenced stale attempt ${execution.attemptId} for ${execution.targetKey}`,
      );
      return undefined;
    }
  }
  const updated = { ...existing, ...patch };
  runs.set(id, updated);
  persist(updated);
  return updated;
}

export async function mutateRun<T>(
  id: string,
  mutation: (run: Run) => { run: Run; value: T },
): Promise<T | undefined> {
  return withRunLock(id, async () => {
    const existing = runs.get(id);
    if (!existing) return undefined;
    const result = mutation(existing);
    if (result.run.id !== id) {
      throw new TypeError("A run mutation cannot change its id");
    }
    if (result.run === existing) return result.value;
    const updated = updateRun(id, result.run);
    if (!updated) return undefined;
    await flushPersistence();
    return result.value;
  });
}

export function listRuns(): Run[] {
  return Array.from(runs.values()).sort(
    (a, b) => b.createdAt.localeCompare(a.createdAt)
  );
}

/**
 * Get a run, reading it back from disk when it is not in memory — which is
 * every run that started before the current server process.
 */
export async function ensureRunLoaded(id: string): Promise<Run | undefined> {
  return withRunLock(id, async () => runs.get(id));
}

/**
 * A run saved under an older stage layout keeps sub-task ids that no longer
 * have instructions behind them. Bring it up to date before anyone acts on it.
 */
function currentStageShape(run: Run): Run {
  if (!run.stages) return run;
  const stages = reconcileStages(run.stages, run.assetType, run.pipeline);
  const changed = stages.some((s, i) => s !== run.stages![i]);
  if (!changed) return run;
  return { ...run, stages };
}

/** Every run ever saved, newest first, for the archive. */
export async function listRunSummaries(): Promise<RunSummary[]> {
  const ids = await listRunIds();
  return Promise.all(ids.map((id) => readRunSummary(id)));
}

/** Test-only: drop in-memory state so a test can simulate a server restart. */
export function __resetRegistryForTests(): void {
  runs.clear();
  runLocks.clear();
  pendingWrites = Promise.resolve();
}
