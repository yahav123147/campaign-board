import type { ChildProcess } from "node:child_process";
import path from "node:path";

interface TrackedChild {
  readonly process: ChildProcess;
  readonly label: string;
  readonly processGroup: boolean;
  readonly supervisedProcessTree: boolean;
}

interface ShutdownOptions {
  graceMs?: number;
  killWaitMs?: number;
}

const globalForChildren = globalThis as unknown as {
  __councilChildren?: Set<TrackedChild>;
  __councilShutdownHooksInstalled?: boolean;
  __councilShutdownPromise?: Promise<void>;
};

const children = globalForChildren.__councilChildren ?? new Set<TrackedChild>();
globalForChildren.__councilChildren = children;

const PROCESS_TREE_PROTOCOL = "campaign-council-process-tree-v1";
const PROCESS_TREE_SCRIPT = path.resolve(
  process.cwd(),
  "scripts/process-tree-supervisor.mjs",
);

export interface SupervisedProcessTreeLaunch {
  readonly command: string;
  readonly args: readonly string[];
}

/**
 * Put an untrusted/finite command behind a trusted POSIX process-group owner.
 *
 * The supervisor remains alive until every process in the command's group has
 * received TERM and then KILL. Callers must add `"ipc"` to the spawned
 * process's stdio array and register it with `supervisedProcessTree: true`.
 * Windows deliberately fails closed until a Job Object implementation exists.
 */
export function supervisedProcessTreeLaunch(
  command: string,
  args: readonly string[],
): SupervisedProcessTreeLaunch {
  if (process.platform === "win32") {
    throw new Error(
      "Process-tree execution is unsupported on Windows without a Job Object",
    );
  }
  if (!command || command.includes("\0")) {
    throw new Error("Supervised process command is invalid");
  }
  if (args.some((arg) => arg.includes("\0"))) {
    throw new Error("Supervised process arguments are invalid");
  }
  return {
    command: process.execPath,
    args: [PROCESS_TREE_SCRIPT, "outer", "--", command, ...args],
  };
}

function isAlive(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function sendSupervisorSignal(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.connected) return;
  try {
    child.send(
      { protocol: PROCESS_TREE_PROTOCOL, type: "signal", signal },
      () => {
        // A closed IPC channel means the supervisor already completed cleanup.
      },
    );
  } catch {
    // The supervisor may have disconnected after the liveness check.
  }
}

/** Signal a tracked child without ever targeting a stale supervised PGID. */
export function signalTrackedChildProcess(
  child: ChildProcess,
  signal: NodeJS.Signals,
): void {
  const entry = [...children].find((candidate) => candidate.process === child);
  if (!entry || !isAlive(child)) return;
  if (entry.supervisedProcessTree) {
    sendSupervisorSignal(child, signal);
    return;
  }
  try {
    if (entry.processGroup && process.platform !== "win32" && child.pid) {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch {
    // The process may have exited after the liveness check.
  }
}

function signalChild(entry: TrackedChild, signal: NodeJS.Signals): void {
  signalTrackedChildProcess(entry.process, signal);
}

function waitForExit(entries: readonly TrackedChild[], timeoutMs: number): Promise<void> {
  const active = entries.filter((entry) => isAlive(entry.process));
  if (active.length === 0) return Promise.resolve();
  return Promise.race([
    Promise.all(active.map((entry) => new Promise<void>((resolve) => {
      if (!isAlive(entry.process)) return resolve();
      entry.process.once("close", () => resolve());
      if (entry.supervisedProcessTree) entry.process.once("exit", () => resolve());
      entry.process.once("error", () => resolve());
    }))).then(() => undefined),
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      timer.unref();
    }),
  ]);
}

/** Register a child immediately after spawn so process shutdown can reap it. */
export function trackChildProcess(
  child: ChildProcess,
  label: string,
  options: { processGroup?: boolean; supervisedProcessTree?: boolean } = {},
): ChildProcess {
  if (options.supervisedProcessTree && !child.connected) {
    try {
      child.kill("SIGKILL");
    } catch {
      // Spawn may already have failed.
    }
    throw new Error("A supervised process tree requires an IPC stdio channel");
  }
  const entry: TrackedChild = {
    process: child,
    label: label.slice(0, 120),
    processGroup: options.processGroup === true && !options.supervisedProcessTree,
    supervisedProcessTree: options.supervisedProcessTree === true,
  };
  children.add(entry);
  const remove = () => children.delete(entry);
  child.once("close", remove);
  if (entry.supervisedProcessTree) child.once("exit", remove);
  child.once("error", remove);
  return child;
}

/**
 * Stop every registered child, including detached process groups. Calls are
 * idempotent so SIGINT and SIGTERM arriving together cannot start two reapers.
 */
export function shutdownTrackedChildren(options: ShutdownOptions = {}): Promise<void> {
  if (globalForChildren.__councilShutdownPromise) {
    return globalForChildren.__councilShutdownPromise;
  }
  const graceMs = options.graceMs ?? 3_000;
  const killWaitMs = options.killWaitMs ?? 1_000;
  if (!Number.isSafeInteger(graceMs) || graceMs < 0 || graceMs > 30_000) {
    return Promise.reject(new RangeError("Child shutdown grace period is invalid"));
  }
  if (!Number.isSafeInteger(killWaitMs) || killWaitMs < 0 || killWaitMs > 30_000) {
    return Promise.reject(new RangeError("Child shutdown kill wait is invalid"));
  }

  const shutdown = (async () => {
    const snapshot = [...children];
    for (const entry of snapshot) signalChild(entry, "SIGTERM");
    await waitForExit(snapshot, graceMs);
    const survivors = snapshot.filter((entry) => isAlive(entry.process));
    for (const entry of survivors) signalChild(entry, "SIGKILL");
    await waitForExit(survivors, killWaitMs);
  })().finally(() => {
    if (globalForChildren.__councilShutdownPromise === shutdown) {
      globalForChildren.__councilShutdownPromise = undefined;
    }
  });
  globalForChildren.__councilShutdownPromise = shutdown;
  return shutdown;
}

function installShutdownHooks(): void {
  if (globalForChildren.__councilShutdownHooksInstalled) return;
  globalForChildren.__councilShutdownHooksInstalled = true;
  const handle = (signal: "SIGHUP" | "SIGINT" | "SIGTERM", exitCode: number) => {
    process.once(signal, () => {
      void shutdownTrackedChildren().finally(() => process.exit(exitCode));
    });
  };
  handle("SIGINT", 130);
  handle("SIGTERM", 143);
  handle("SIGHUP", 129);
}

installShutdownHooks();
