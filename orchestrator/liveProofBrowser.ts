import { spawn, type ChildProcess } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  signalTrackedChildProcess,
  supervisedProcessTreeLaunch,
  trackChildProcess,
} from "./childProcessRegistry";

/**
 * The live-proof browser: a second Chrome instance the orchestrator owns from
 * launch to reaping, plus the capture script that drives it over CDP.
 *
 * Chrome is spawned as the executable itself under the process-tree
 * supervisor, never through `open`, a shell or Playwright, so cancellation
 * reaches the whole browser tree and never touches the operator's own Chrome.
 */

const CHROME_DEFAULT_MACOS = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
/**
 * The capture refused because a pop-up covered the profile, not because
 * anything failed. The script prints its own diagnostics, which name DOM
 * internals; what the operator can act on is the sheet, so the orchestrator
 * states that itself rather than echoing the script.
 */
export const CAPTURE_EXIT_OBSTRUCTED = 6;
export const CAPTURE_OBSTRUCTED_MESSAGE = "הפרופיל מוסתר על ידי חלון קופץ ולא צולם";
const READY_POLL_MS = 50;
const ENDPOINT_PROBE_MS = 1_000;
/** After TERM, how long the supervisor gets before the KILL fallback. */
const TERM_GRACE_MS = 2_000;

export interface OwnedChrome {
  endpoint: string;
  closeAndWait(): Promise<void>;
}

/**
 * The vendored capture script, resolved from this repository because that is
 * where Playwright is installed; the landing workspace is only its cwd.
 * Overridable so lifecycle tests can inject a fake capture process.
 */
export function igShotScriptPath(): string {
  return process.env.CAMPAIGN_COUNCIL_IG_SHOT_PATH
    || path.join(process.cwd(), "vendor", "landing-skill", "scripts", "ig_shot.mjs");
}

/** The installed Chrome. Overridable so tests can inject a fake executable. */
export function chromeExecutablePath(): string {
  return process.env.CAMPAIGN_COUNCIL_CHROME_PATH || CHROME_DEFAULT_MACOS;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

/**
 * Terminate a supervised child and resolve only after its close event: a timer
 * is not proof that a process exited, and the supervisor needs its own grace
 * to reap the group it owns.
 */
export function terminateAndWait(child: ChildProcess, closed: Promise<unknown>): Promise<void> {
  if (!hasExited(child)) {
    signalTrackedChildProcess(child, "SIGTERM");
    const force = setTimeout(() => signalTrackedChildProcess(child, "SIGKILL"), TERM_GRACE_MS);
    force.unref();
    return closed.then(() => clearTimeout(force)).then(() => undefined);
  }
  return closed.then(() => undefined);
}

/**
 * Shared with the mockup renderer, which owns a browser of its own: the two
 * lifecycles differ, the primitive does not, and a second copy of it would be
 * a second place for the ownership rules to drift.
 */
export function spawnSupervised(
  command: string,
  args: readonly string[],
  cwd: string,
  label: string,
): { child: ChildProcess; closed: Promise<number | null>; stderr: () => string } {
  const launch = supervisedProcessTreeLaunch(command, args);
  const child = spawn(launch.command, [...launch.args], {
    cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  try {
    trackChildProcess(child, label, { supervisedProcessTree: true });
  } catch (error) {
    try {
      child.kill("SIGKILL");
    } catch {
      // The spawn may already have failed.
    }
    throw error;
  }
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr = `${stderr}${String(chunk)}`.slice(-4_000);
  });
  const closed = new Promise<number | null>((resolve) => {
    child.once("close", (code) => resolve(code));
  });
  return { child, closed, stderr: () => stderr };
}

function readDevToolsPort(text: string): number | undefined {
  const first = text.split("\n")[0]?.trim() ?? "";
  if (!/^\d{1,5}$/.test(first)) return undefined;
  const port = Number(first);
  return port > 0 && port <= 65_535 ? port : undefined;
}

async function endpointIsReady(endpoint: string): Promise<boolean> {
  try {
    const response = await fetch(`${endpoint}/json/version`, {
      signal: AbortSignal.timeout(ENDPOINT_PROBE_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Launch Chrome on the given throwaway profile and resolve only once its CDP
 * endpoint answers. The helper owns its supervisor from the moment spawn
 * succeeds: a startup failure, an abort or the deadline terminates and awaits
 * that supervisor here, because the caller never received a handle to close.
 */
export async function startSupervisedChrome(args: {
  profileDir: string;
  signal?: AbortSignal;
  deadline: number;
  /** How the supervisor is named in the registry, for the operator's sake. */
  label?: string;
  /** Local mockups may use Playwright Chromium without a signed-in Chrome. */
  executablePath?: string;
  /** Empty-session local mockups do not need a desktop display. */
  headless?: boolean;
}): Promise<OwnedChrome> {
  if (args.signal?.aborted) throw new Error("הפעלת הדפדפן בוטלה");
  const executable = args.executablePath ?? chromeExecutablePath();
  await fs.access(executable, fsConstants.X_OK).catch(() => {
    throw new Error(`לא נמצא דפדפן כרום להרצה ב-${executable}`);
  });

  const { child, closed } = spawnSupervised(
    executable,
    [
      `--user-data-dir=${args.profileDir}`,
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
      "--no-first-run",
      "--no-default-browser-check",
      ...(args.headless ? ["--headless"] : []),
    ],
    process.cwd(),
    args.label ?? "chrome (live proof)",
  );

  let closePromise: Promise<void> | undefined;
  const closeAndWait = (): Promise<void> => {
    closePromise ??= terminateAndWait(child, closed);
    return closePromise;
  };

  try {
    const portFile = path.join(args.profileDir, "DevToolsActivePort");
    for (;;) {
      if (args.signal?.aborted) throw new Error("הפעלת הדפדפן בוטלה");
      if (Date.now() > args.deadline) throw new Error("הדפדפן לא עלה בזמן");
      const port = readDevToolsPort(await fs.readFile(portFile, "utf8").catch(() => ""));
      if (port) {
        const endpoint = `http://127.0.0.1:${port}`;
        if (await endpointIsReady(endpoint)) return { endpoint, closeAndWait };
      }
      // Checked whatever the port file says: a browser that wrote a port and
      // then died must fail within one poll, not hold the run to the deadline.
      if (hasExited(child)) throw new Error("הדפדפן נסגר לפני שנפתחה אליו גישה");
      await delay(READY_POLL_MS);
    }
  } catch (error) {
    await closeAndWait();
    throw error;
  }
}

/** What the capture script validated off the page and wrote to its sidecar. */
export interface InstagramCaptureProof {
  /** The count as the page showed it, normalized: "12.3K". */
  followers: string;
  /** The matched page text the count was read from: "12.3K עוקבים". */
  followersRaw: string;
}

interface SidecarFile {
  handle?: unknown;
  followers?: unknown;
  followersRaw?: unknown;
  capturedAt?: unknown;
}

/**
 * Run the capture-only script against an endpoint this module owns. Unlike a
 * finite tracked script, it never settles on a timer: cancellation and the
 * deadline request termination and then wait for the close event, so the
 * caller can delete the profile knowing nothing is still writing to it.
 *
 * The script validates the page before it saves anything, so a non-zero exit
 * is a refused proof, not a broken run: it comes back as {error} carrying the
 * reason the script printed, and there is no file to show. Cancellation and
 * the deadline still reject, because those are the run's own failures.
 */
export async function runInstagramCapture(args: {
  endpoint: string;
  handle: string;
  out: string;
  cwd: string;
  signal?: AbortSignal;
  deadline: number;
}): Promise<InstagramCaptureProof | { error: string }> {
  if (args.signal?.aborted) throw new Error("צילום האינסטגרם בוטל");
  // Nothing from an earlier attempt survives into this one: the harvest is
  // readable by the asset agent, and an image there is taken for proof.
  await removeCaptureOutputs(args.out);
  const script = igShotScriptPath();
  const { child, closed, stderr } = spawnSupervised(
    process.execPath,
    [script, args.endpoint, args.handle, args.out],
    args.cwd,
    "ig_shot.mjs",
  );

  let failure: Error | undefined;
  const stop = (error: Error) => {
    failure ??= error;
    if (!hasExited(child)) {
      signalTrackedChildProcess(child, "SIGTERM");
      const force = setTimeout(() => signalTrackedChildProcess(child, "SIGKILL"), TERM_GRACE_MS);
      force.unref();
    }
  };
  const onAbort = () => stop(new Error("צילום האינסטגרם בוטל"));
  const timer = setTimeout(
    () => stop(new Error("צילום האינסטגרם חרג מהזמן שהוקצב")),
    Math.max(0, args.deadline - Date.now()),
  );
  timer.unref();
  args.signal?.addEventListener("abort", onAbort, { once: true });
  child.once("error", (error) => stop(new Error(`ig_shot.mjs לא רץ: ${error.message}`)));

  try {
    // Every branch below runs after the close event, so the capture is gone and
    // whatever it left half-written can be removed safely. A cancelled or
    // timed-out capture can have taken the screenshot already: unvalidated, it
    // is not proof, and it must not be found in the harvest.
    const code = await closed;
    if (failure) {
      await removeCaptureOutputs(args.out);
      throw failure;
    }
    if (code !== 0) {
      await removeCaptureOutputs(args.out);
      if (code === CAPTURE_EXIT_OBSTRUCTED) return { error: CAPTURE_OBSTRUCTED_MESSAGE };
      return { error: `ig_shot.mjs נכשל: ${stderr().trim() || `קוד יציאה ${code}`}` };
    }
    const proof = await readCaptureProof(args.out);
    if ("error" in proof) await removeCaptureOutputs(args.out);
    return proof;
  } finally {
    clearTimeout(timer);
    args.signal?.removeEventListener("abort", onAbort);
  }
}

/** The image and its sidecar, removed together: one without the other is not proof. */
async function removeCaptureOutputs(out: string): Promise<void> {
  await fs.rm(out, { force: true }).catch(() => {});
  await fs.rm(`${out}.json`, { force: true }).catch(() => {});
}

/**
 * The sidecar the script writes next to the image. A screenshot without it is
 * not a proof: the count was never validated, so there is nothing to state.
 */
async function readCaptureProof(out: string): Promise<InstagramCaptureProof | { error: string }> {
  const raw = await fs.readFile(`${out}.json`, "utf8").catch(() => "");
  let parsed: SidecarFile | undefined;
  try {
    parsed = raw ? (JSON.parse(raw) as SidecarFile) : undefined;
  } catch {
    parsed = undefined;
  }
  if (typeof parsed?.followers !== "string" || !parsed.followers) {
    return { error: "ig_shot.mjs הסתיים בלי נתוני עוקבים לצד הצילום" };
  }
  return {
    followers: parsed.followers,
    followersRaw: typeof parsed.followersRaw === "string" ? parsed.followersRaw : parsed.followers,
  };
}
