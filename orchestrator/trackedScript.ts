import { spawn } from "node:child_process";
import { signalTrackedChildProcess, supervisedProcessTreeLaunch, trackChildProcess } from "./childProcessRegistry";

export interface TrackedScriptArgs { command: string; args: string[]; cwd: string; signal?: AbortSignal; timeoutMs: number; label: string }

/**
 * The deadline, as a type rather than a wording: a script whose own output
 * happens to mention a timeout is an ordinary failure, and a caller that has
 * to tell the two apart cannot do it by matching the message.
 */
export class TrackedScriptTimeoutError extends Error {}

/** How long a terminated script has to exit before it is killed outright. */
const TERM_GRACE_MS = 1_000;

/**
 * Run a script the orchestrator owns: under the process-tree supervisor (like
 * every agent), so cancellation signals the script's entire process group.
 * Detached descendants are not covered; Task 9 owns Chrome separately.
 *
 * A cancellation and the deadline terminate the script and then WAIT for its
 * close event before rejecting. The close is the only proof the process is
 * gone, and the caller acts on this promise settling: the mockup renderer
 * deletes the directory the script was writing into, so a script that
 * outlived the rejection would still be writing into a path nobody owns.
 */
export function runTrackedScript(a: TrackedScriptArgs): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (a.signal?.aborted) return reject(new Error(`${a.label}: aborted`));
    const launch = supervisedProcessTreeLaunch(a.command, a.args);
    const child = spawn(launch.command, [...launch.args], { cwd: a.cwd, env: process.env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    trackChildProcess(child, a.label, { supervisedProcessTree: true });
    let stdout = "", stderr = "", settled = false;
    /** Why the script is being stopped, once it is. The close event settles it. */
    let stopping: Error | undefined;
    let force: NodeJS.Timeout | undefined;
    const finish = (fn: () => void) => { if (settled) return; settled = true; clearTimeout(timer); if (force) clearTimeout(force); a.signal?.removeEventListener("abort", onAbort); fn(); };
    const stop = (error: Error) => {
      stopping ??= error;
      signalTrackedChildProcess(child, "SIGTERM");
      if (!force) { force = setTimeout(() => signalTrackedChildProcess(child, "SIGKILL"), TERM_GRACE_MS); force.unref(); }
    };
    const onAbort = () => stop(new Error(`${a.label}: aborted`));
    const timer = setTimeout(() => stop(new TrackedScriptTimeoutError(`${a.label}: timed out after ${Math.round(a.timeoutMs / 1000)} s`)), a.timeoutMs);
    timer.unref();
    a.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout!.on("data", (d) => { stdout += String(d); });
    child.stderr!.on("data", (d) => { stderr += String(d); });
    // A script that never started has no close event to wait for.
    child.on("error", (err) => finish(() => reject(stopping ?? new Error(`${a.label} failed: ${err.message}`))));
    child.on("close", (code) => finish(() => {
      if (stopping) return reject(stopping);
      return code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${a.label} failed: ${stderr.trim() || `exit ${code}`}`));
    }));
  });
}
