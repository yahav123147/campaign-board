import path from "node:path";
import { resolveNextCli } from "./runStage5LpBuild";
import os from "node:os";
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { sandboxedNodeLaunch } from "./processSandbox";
import {
  signalTrackedChildProcess,
  supervisedProcessTreeLaunch,
  trackChildProcess,
} from "./childProcessRegistry";
import type { DesertMeasurement, VisibilityProbe } from "./imageMapCheck";

export const LANDING_PAGES_DIR = path.resolve(
  process.env.LANDING_PAGES_DIR ?? path.join(os.homedir(), "landing-pages"),
);
export const PREVIEW_HOST = "127.0.0.1";

/**
 * The board's own preview port. Reserved for this, so it never fights the
 * council itself (4321) or any other project on this machine.
 */
const configuredPreviewPort = Number(process.env.PREVIEW_PORT ?? 4322);
if (!Number.isSafeInteger(configuredPreviewPort) || configuredPreviewPort < 1024 || configuredPreviewPort > 65535) {
  throw new Error("PREVIEW_PORT must be an integer between 1024 and 65535");
}
export const PREVIEW_PORT = configuredPreviewPort;

export function previewUrlFor(slug: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,119}$/.test(slug)) throw new Error("Invalid preview slug");
  return `http://${PREVIEW_HOST}:${PREVIEW_PORT}/${slug}`;
}

/** Survives dev-server hot reloads, so we never orphan a preview process. */
export interface PreviewStartCoordinator {
  inFlight?: Promise<void>;
}

const globalForPreview = globalThis as unknown as {
  __councilPreview?: ChildProcess;
  __councilPreviewCoordinator?: PreviewStartCoordinator;
  __councilPreviewWorkspace?: string;
  __councilPreviewSandboxHome?: string;
  __councilPreviewGeneration?: number;
};
const previewStartCoordinator = globalForPreview.__councilPreviewCoordinator ?? {};
globalForPreview.__councilPreviewCoordinator = previewStartCoordinator;

export const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function waitWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return wait(ms) as Promise<void>;
  if (signal.aborted) return Promise.reject(new Error("Preview wait was aborted"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Preview wait was aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function browserProcessEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    TMPDIR: process.env.TMPDIR,
    PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH,
    NODE_ENV: "production",
    FORCE_COLOR: "0",
  };
}

function signalProcessTree(proc: ChildProcess, signal: NodeJS.Signals): void {
  signalTrackedChildProcess(proc, signal);
}

export function portIsOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: PREVIEW_HOST });
    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
    socket.setTimeout(1000, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

export function stopPreview(): void {
  globalForPreview.__councilPreviewGeneration =
    (globalForPreview.__councilPreviewGeneration ?? 0) + 1;
  const proc = globalForPreview.__councilPreview;
  const sandboxHome = globalForPreview.__councilPreviewSandboxHome;
  const cleanupSandboxHome = () => {
    if (sandboxHome) void fs.rm(sandboxHome, { recursive: true, force: true });
  };
  if (proc && proc.exitCode === null && proc.signalCode === null) {
    signalProcessTree(proc, "SIGTERM");
    const forceKill = setTimeout(() => {
      if (proc.exitCode == null) signalProcessTree(proc, "SIGKILL");
    }, 2_000);
    forceKill.unref();
    proc.once("close", () => {
      clearTimeout(forceKill);
      cleanupSandboxHome();
    });
  } else {
    cleanupSandboxHome();
  }
  globalForPreview.__councilPreview = undefined;
  globalForPreview.__councilPreviewWorkspace = undefined;
  globalForPreview.__councilPreviewSandboxHome = undefined;
}

export async function previewIsOwnedAndOpen(workspaceDir?: string): Promise<boolean> {
  const proc = globalForPreview.__councilPreview;
  const requested = workspaceDir ? path.resolve(workspaceDir) : undefined;
  return Boolean(
    proc &&
    proc.exitCode === null &&
    (!requested || globalForPreview.__councilPreviewWorkspace === requested) &&
    await portIsOpen(PREVIEW_PORT),
  );
}

/** Idempotent: if a preview is already serving, reuse it instead of restarting. */
export async function ensurePreviewServer(
  logFile: string,
  workspaceDir: string = LANDING_PAGES_DIR,
  dependencyWorkspace: string = workspaceDir,
): Promise<void> {
  if (await previewIsOwnedAndOpen(workspaceDir)) return;
  await startPreviewServer(logFile, workspaceDir, dependencyWorkspace);
}

/**
 * Serialize preview startup. Concurrent callers for the same workspace reuse
 * one launch; a caller for another workspace waits, then fails while the first
 * preview owns the port. Exported so the race contract can be tested without
 * spawning a real Next.js server.
 */
export function coordinatePreviewStart(
  coordinator: PreviewStartCoordinator,
  requestedWorkspace: string,
  isOwnedAndOpen: (workspace?: string) => Promise<boolean>,
  startOnce: () => Promise<void>,
): Promise<void> {
  const inFlight = coordinator.inFlight;
  if (inFlight) {
    return inFlight.then(async () => {
      if (await isOwnedAndOpen(requestedWorkspace)) return;
      if (await isOwnedAndOpen()) {
        throw new Error("The preview port is currently serving a different Campaign Council run");
      }
      return coordinatePreviewStart(coordinator, requestedWorkspace, isOwnedAndOpen, startOnce);
    });
  }

  const start = (async () => {
    if (await isOwnedAndOpen(requestedWorkspace)) return;
    if (await isOwnedAndOpen()) {
      throw new Error("The preview port is currently serving a different Campaign Council run");
    }
    await startOnce();
  })();
  const starting = start.finally(() => {
    if (coordinator.inFlight === starting) coordinator.inFlight = undefined;
  });
  coordinator.inFlight = starting;
  return starting;
}

export function startPreviewServer(
  logFile: string,
  workspaceDir: string = LANDING_PAGES_DIR,
  dependencyWorkspace: string = workspaceDir,
): Promise<void> {
  const requested = path.resolve(workspaceDir);
  const dependencies = path.resolve(dependencyWorkspace);
  return coordinatePreviewStart(
    previewStartCoordinator,
    requested,
    previewIsOwnedAndOpen,
    () => startPreviewServerOnce(logFile, requested, dependencies),
  );
}

async function startPreviewServerOnce(
  logFile: string,
  workspaceDir: string,
  dependencyWorkspace: string,
): Promise<void> {
  stopPreview();
  const generation = globalForPreview.__councilPreviewGeneration ?? 0;
  // Give the old process a moment to release the port before rebinding.
  for (let i = 0; i < 10 && (await portIsOpen(PREVIEW_PORT)); i++) await wait(500);
  if (await portIsOpen(PREVIEW_PORT)) {
    throw new Error(
      `Preview port ${PREVIEW_PORT} is occupied by a process not owned by Campaign Council`,
    );
  }

  const sandboxHome = await fs.mkdtemp(path.join(os.tmpdir(), "campaign-council-preview-"));
  await fs.chmod(sandboxHome, 0o700);
  const nodeModules = await fs.realpath(path.join(dependencyWorkspace, "node_modules")).catch(async () => {
    await fs.rm(sandboxHome, { recursive: true, force: true });
    throw new Error(`Landing workspace is not installed: missing node_modules in ${dependencyWorkspace}`);
  });
  const nextScript = await resolveNextCli(nodeModules).catch(async () => {
    await fs.rm(sandboxHome, { recursive: true, force: true });
    throw new Error("Landing workspace is not installed: missing Next.js executable");
  });
  const nextRelative = path.relative(nodeModules, nextScript);
  if (
    nextRelative === ".." ||
    nextRelative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(nextRelative)
  ) {
    await fs.rm(sandboxHome, { recursive: true, force: true });
    throw new Error("The configured Next.js executable escaped node_modules");
  }
  const resolvedLogFile = path.resolve(logFile);
  const nextOutput = path.join(workspaceDir, ".next");
  await fs.mkdir(nextOutput, { recursive: true, mode: 0o700 });
  await fs.mkdir(path.dirname(resolvedLogFile), { recursive: true });
  const launch = await sandboxedNodeLaunch(
    process.execPath,
    [
      "--max-old-space-size=1024",
      nextScript,
      // Serve the production build that runLandingBuild just produced. `next
      // dev` watches the whole worktree and dies with EMFILE (watchpack
      // follows the node_modules symlink); `next start` has no watchers and
      // screenshots exactly what would ship. Every design-round revision runs
      // a rebuild before the next shot, so the served page is always current.
      "start",
      "-H",
      PREVIEW_HOST,
      "-p",
      String(PREVIEW_PORT),
    ],
    {
      readPaths: [workspaceDir, nodeModules, sandboxHome, resolvedLogFile],
      // `next dev` rewrites next-env.d.ts in the project root on start; the
      // file is gitignored in a standard Next.js project, so allowing it does
      // not touch the delivered branch.
      writePaths: [nextOutput, sandboxHome, resolvedLogFile, path.join(workspaceDir, "next-env.d.ts")],
      network: "loopback-server",
    },
  ).catch(async (error) => {
    await fs.rm(sandboxHome, { recursive: true, force: true });
    throw error;
  });
  // Record the exact Seatbelt profile next to the server output, so a sandbox
  // denial can be read from the run's own logs instead of reproduced by hand.
  await fs.appendFile(resolvedLogFile, `\n# sandbox profile\n${launch.profile}\n# end profile\n`, "utf8");
  const processTreeLaunch = supervisedProcessTreeLaunch(launch.command, launch.args);
  const out = await fs.open(
    resolvedLogFile,
    fsConstants.O_WRONLY
      | fsConstants.O_CREAT
      | fsConstants.O_APPEND
      | fsConstants.O_NOFOLLOW
      | fsConstants.O_NONBLOCK,
    0o600,
  ).then(async (handle) => {
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1) {
        throw new Error("Preview log path is not a private regular file");
      }
      await handle.chmod(0o600);
      return handle;
    } catch (error) {
      await handle.close().catch(() => {});
      throw error;
    }
  }).catch(async (error) => {
    await fs.rm(sandboxHome, { recursive: true, force: true });
    throw error;
  });
  let proc: ChildProcess;
  try {
    proc = spawn(
      processTreeLaunch.command,
      [...processTreeLaunch.args],
      {
        cwd: workspaceDir,
        stdio: ["ignore", out.fd, out.fd, "ipc"],
        detached: process.platform !== "win32",
        env: {
          PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
          HOME: sandboxHome,
          LANG: process.env.LANG,
          LC_ALL: process.env.LC_ALL,
          TMPDIR: sandboxHome,
          NODE_ENV: "development",
          NODE_PATH: nodeModules,
          NEXT_TELEMETRY_DISABLED: "1",
        },
      },
    );
  } catch (error) {
    await fs.rm(sandboxHome, { recursive: true, force: true });
    throw error;
  } finally {
    await out.close();
  }
  globalForPreview.__councilPreview = proc;
  trackChildProcess(proc, "landing-preview", { supervisedProcessTree: true });
  globalForPreview.__councilPreviewWorkspace = workspaceDir;
  globalForPreview.__councilPreviewSandboxHome = sandboxHome;
  proc.once("close", () => {
    void fs.rm(sandboxHome, { recursive: true, force: true });
    if (globalForPreview.__councilPreview === proc) {
      globalForPreview.__councilPreview = undefined;
      globalForPreview.__councilPreviewWorkspace = undefined;
      globalForPreview.__councilPreviewSandboxHome = undefined;
    }
  });

  for (let i = 0; i < 120; i++) {
    if ((globalForPreview.__councilPreviewGeneration ?? 0) !== generation) {
      signalProcessTree(proc, "SIGTERM");
      throw new Error("Preview startup was cancelled");
    }
    if (await portIsOpen(PREVIEW_PORT)) return;
    if (proc.exitCode != null) {
      throw new Error(`שרת התצוגה נפל מיד (exit ${proc.exitCode}). ראה ${logFile}`);
    }
    await wait(500);
  }
  stopPreview();
  throw new Error(`שרת התצוגה לא עלה על פורט ${PREVIEW_PORT} תוך 60 שניות`);
}

/** First request compiles the route, which on a cold dev server takes a while. */
export async function waitForPage(url: string, signal?: AbortSignal): Promise<number> {
  let pageUrl: URL;
  try {
    pageUrl = new URL(url);
  } catch {
    throw new Error("Invalid preview page URL");
  }
  if (
    pageUrl.protocol !== "http:" ||
    pageUrl.hostname !== PREVIEW_HOST ||
    pageUrl.port !== String(PREVIEW_PORT) ||
    pageUrl.username ||
    pageUrl.password
  ) {
    throw new Error("Preview readiness checks are restricted to the local preview origin");
  }
  let last = 0;
  for (let i = 0; i < 60; i++) {
    if (signal?.aborted) throw new Error("Preview readiness check was aborted");
    try {
      const requestSignal = signal
        ? AbortSignal.any([signal, AbortSignal.timeout(20_000)])
        : AbortSignal.timeout(20_000);
      const res = await fetch(pageUrl, { signal: requestSignal, redirect: "manual" });
      last = res.status;
      if (res.status < 500) return res.status;
    } catch (error) {
      if (signal?.aborted) throw new Error("Preview readiness check was aborted", { cause: error });
      // still compiling
    }
    await waitWithSignal(3_000, signal);
  }
  return last;
}

/** macOS only: put the page in front of the reviewer instead of relying on a click. */
export function openInBrowser(url: string): boolean {
  if (process.platform !== "darwin") return false;
  try {
    spawn("open", [url], { stdio: "ignore", detached: true }).unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * Full-page screenshots of the rendered page. Returns the files written, so a
 * critic can open what the reader would actually see instead of reading code.
 */
export function shoot(
  url: string,
  outDir: string,
  label: string,
  widths: number[] = [390, 1280],
  signal?: AbortSignal,
): Promise<string[]> {
  let pageUrl: URL;
  try {
    pageUrl = new URL(url);
  } catch {
    return Promise.reject(new Error("Invalid screenshot URL"));
  }
  if (pageUrl.protocol !== "http:" && pageUrl.protocol !== "https:") {
    return Promise.reject(new Error("Screenshot URL must use http or https"));
  }
  if (pageUrl.username || pageUrl.password) {
    return Promise.reject(new Error("Screenshot URL credentials are not allowed"));
  }
  if (!/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(label)) {
    return Promise.reject(new Error("Invalid screenshot label"));
  }
  if (
    widths.length === 0 ||
    widths.length > 4 ||
    widths.some((width) => !Number.isSafeInteger(width) || width < 320 || width > 2_560)
  ) {
    return Promise.reject(new Error("Invalid screenshot widths"));
  }
  if (signal?.aborted) return Promise.reject(new Error("Screenshot capture was aborted"));

  return new Promise((resolve, reject) => {
    const script = path.resolve(process.cwd(), "scripts/shoot.mjs");
    const launch = supervisedProcessTreeLaunch(
      process.execPath,
      [script, pageUrl.href, outDir, label, ...widths.map(String)],
    );
    const proc = spawn(launch.command, [...launch.args], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      shell: false,
      detached: process.platform !== "win32",
      env: browserProcessEnv(),
    });
    trackChildProcess(proc, "preview-screenshot", { supervisedProcessTree: true });
    let out = "";
    let stderr = "";
    let settled = false;
    let closed = false;
    let forceKill: NodeJS.Timeout | undefined;
    const timeoutMs = 180_000;

    const finish = (error?: Error, files?: string[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (closed && forceKill) clearTimeout(forceKill);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(files ?? []);
    };
    const stop = () => {
      if (closed || proc.exitCode != null) return;
      signalProcessTree(proc, "SIGTERM");
      forceKill = setTimeout(() => {
        if (!closed && proc.exitCode == null) signalProcessTree(proc, "SIGKILL");
      }, 2_000);
      forceKill.unref();
    };
    const timeout = setTimeout(() => {
      stop();
      finish(new Error(`Screenshot capture timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timeout.unref();
    const onAbort = () => {
      stop();
      finish(new Error("Screenshot capture was aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();

    proc.stdout!.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString();
      if (Buffer.byteLength(out) + Buffer.byteLength(text) > 64 * 1024) {
        stop();
        finish(new Error("Screenshot process exceeded its output limit"));
        return;
      }
      out += text;
    });
    proc.stderr!.on("data", (chunk: Buffer | string) => {
      if (Buffer.byteLength(stderr) >= 64 * 1024) return;
      stderr += chunk.toString().slice(0, 64 * 1024 - Buffer.byteLength(stderr));
    });
    proc.on("error", (error) => finish(error));
    proc.on("close", async (code) => {
      closed = true;
      if (forceKill) clearTimeout(forceKill);
      if (settled) return;
      if (code !== 0) {
        finish(new Error(`Screenshot process failed (exit ${code}): ${stderr.trim().slice(0, 1_000)}`));
        return;
      }
      const outputRoot = path.resolve(outDir);
      const files = out
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.endsWith(".png"))
        .map((line) => path.resolve(line))
        .filter((file) => file.startsWith(`${outputRoot}${path.sep}`));
      const uniqueFiles = [...new Set(files)];
      if (uniqueFiles.length !== widths.length) {
        finish(new Error(`Screenshot process returned ${uniqueFiles.length} files for ${widths.length} widths`));
        return;
      }
      for (const file of uniqueFiles) {
        const stat = await fs.lstat(file).catch(() => undefined);
        if (!stat?.isFile() || stat.isSymbolicLink()) {
          finish(new Error("Screenshot process returned a missing or unsafe output file"));
          return;
        }
      }
      finish(undefined, uniqueFiles);
    });
  });
}

const ASSET_COLLECTOR_TIMEOUT_MS = 150_000;
const ASSET_COLLECTOR_OUTPUT_LIMIT = 8 * 1024 * 1024;
const ASSET_COLLECTOR_ERROR_LIMIT = 64 * 1024;
const ALLOWED_ASSET_PROTOCOLS = new Set(["http:", "https:", "data:", "blob:"]);
const COLLECTOR_SENTINEL_PROTOCOL = "invalid:";

/**
 * Ask a real browser which image assets a page rendered or requested. The
 * collector runs without a shell and is bounded by time and output size.
 */
export async function collectRenderedAssetUrls(url: string, signal?: AbortSignal): Promise<string[]> {
  let pageUrl: URL;
  try {
    pageUrl = new URL(url);
  } catch {
    throw new Error("Invalid page URL");
  }
  if (pageUrl.protocol !== "http:" && pageUrl.protocol !== "https:") {
    throw new Error("Page URL must use http or https");
  }
  if (pageUrl.username || pageUrl.password) throw new Error("Page URL credentials are not allowed");
  if (signal?.aborted) throw new Error("Rendered asset collection was aborted");

  const script = path.resolve(process.cwd(), "scripts/collect-page-assets.mjs");
  return new Promise<string[]>((resolve, reject) => {
    const launch = supervisedProcessTreeLaunch(process.execPath, [script, pageUrl.href]);
    const proc = spawn(launch.command, [...launch.args], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      shell: false,
      detached: process.platform !== "win32",
      env: browserProcessEnv(),
    });
    trackChildProcess(proc, "preview-asset-collector", { supervisedProcessTree: true });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    let closed = false;
    let forceKill: NodeJS.Timeout | undefined;

    const finish = (error?: Error, urls?: string[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(urls ?? []);
    };

    const stop = () => {
      if (closed || proc.exitCode != null) return;
      signalProcessTree(proc, "SIGTERM");
      forceKill = setTimeout(() => {
        if (!closed && proc.exitCode == null) signalProcessTree(proc, "SIGKILL");
      }, 2_000);
      forceKill.unref();
    };

    const timeout = setTimeout(() => {
      stop();
      finish(new Error(`Rendered asset collection timed out after ${ASSET_COLLECTOR_TIMEOUT_MS}ms`));
    }, ASSET_COLLECTOR_TIMEOUT_MS);
    timeout.unref();
    const onAbort = () => {
      stop();
      finish(new Error("Rendered asset collection was aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();

    proc.stdout!.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (stdout.length + data.length > ASSET_COLLECTOR_OUTPUT_LIMIT) {
        stop();
        finish(new Error("Rendered asset collector exceeded its output limit"));
        return;
      }
      stdout = Buffer.concat([stdout, data]);
    });
    proc.stderr!.on("data", (chunk: Buffer | string) => {
      if (stderr.length >= ASSET_COLLECTOR_ERROR_LIMIT) return;
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = ASSET_COLLECTOR_ERROR_LIMIT - stderr.length;
      stderr = Buffer.concat([stderr, data.subarray(0, remaining)]);
    });
    proc.on("error", (error) => finish(error));
    proc.on("close", (code) => {
      closed = true;
      if (forceKill) clearTimeout(forceKill);
      if (settled) return;
      if (code !== 0) {
        const detail = stderr.toString("utf8").trim();
        finish(new Error(`Rendered asset collector failed (exit ${code})${detail ? `: ${detail}` : ""}`));
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout.toString("utf8"));
      } catch {
        finish(new Error("Rendered asset collector returned invalid JSON"));
        return;
      }
      if (!Array.isArray(parsed)) {
        finish(new Error("Rendered asset collector returned a non-array result"));
        return;
      }

      const unique = new Set<string>();
      for (const value of parsed) {
        if (typeof value !== "string") {
          unique.add("invalid:asset-collector-non-string-output");
          continue;
        }
        if (value.length > 8_192) {
          const separator = value.indexOf(":");
          const protocol = separator > 0 ? value.slice(0, separator) : "unknown";
          unique.add(
            `invalid:asset-collector-oversized-output?protocol=${encodeURIComponent(protocol)}&length=${value.length}`,
          );
          continue;
        }
        try {
          const assetUrl = new URL(value);
          if (
            ALLOWED_ASSET_PROTOCOLS.has(assetUrl.protocol) ||
            assetUrl.protocol === COLLECTOR_SENTINEL_PROTOCOL
          ) {
            unique.add(assetUrl.href);
          } else {
            unique.add(
              `invalid:asset-collector-unsupported-output?protocol=${encodeURIComponent(assetUrl.protocol)}`,
            );
          }
        } catch {
          unique.add("invalid:asset-collector-malformed-output");
        }
      }
      finish(undefined, [...unique]);
    });
  });
}

/**
 * Run a Playwright probe script from scripts/ against one preview URL and return
 * its parsed JSON stdout. Same process supervision as the asset collector.
 */
export async function runBrowserProbe(
  scriptName: string,
  url: string,
  options: { label: string; timeoutMs: number; outputLimit: number },
  signal?: AbortSignal,
): Promise<unknown> {
  const pageUrl = new URL(url);
  if (pageUrl.protocol !== "http:" && pageUrl.protocol !== "https:") throw new Error("Page URL must use http or https");
  if (pageUrl.username || pageUrl.password) throw new Error("Page URL credentials are not allowed");
  if (!/^[a-z0-9-]+\.mjs$/.test(scriptName)) throw new Error("Probe script name is not safe");
  if (signal?.aborted) throw new Error(`${options.label} was aborted`);

  const script = path.resolve(process.cwd(), "scripts", scriptName);
  return new Promise<unknown>((resolve, reject) => {
    const launch = supervisedProcessTreeLaunch(process.execPath, [script, pageUrl.href]);
    const proc = spawn(launch.command, [...launch.args], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      shell: false,
      detached: process.platform !== "win32",
      env: browserProcessEnv(),
    });
    trackChildProcess(proc, options.label, { supervisedProcessTree: true });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    let closed = false;
    let forceKill: NodeJS.Timeout | undefined;

    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(value);
    };
    const stop = () => {
      if (closed || proc.exitCode != null) return;
      signalProcessTree(proc, "SIGTERM");
      forceKill = setTimeout(() => {
        if (!closed && proc.exitCode == null) signalProcessTree(proc, "SIGKILL");
      }, 2_000);
      forceKill.unref();
    };
    const timeout = setTimeout(() => {
      stop();
      finish(new Error(`${options.label} timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs);
    timeout.unref();
    const onAbort = () => {
      stop();
      finish(new Error(`${options.label} was aborted`));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();

    proc.stdout!.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (stdout.length + data.length > options.outputLimit) {
        stop();
        finish(new Error(`${options.label} exceeded its output limit`));
        return;
      }
      stdout = Buffer.concat([stdout, data]);
    });
    proc.stderr!.on("data", (chunk: Buffer | string) => {
      if (stderr.length >= ASSET_COLLECTOR_ERROR_LIMIT) return;
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stderr = Buffer.concat([stderr, data.subarray(0, ASSET_COLLECTOR_ERROR_LIMIT - stderr.length)]);
    });
    proc.on("error", (error) => finish(error));
    proc.on("close", (code) => {
      closed = true;
      if (forceKill) clearTimeout(forceKill);
      if (settled) return;
      if (code !== 0) {
        const detail = stderr.toString("utf8").trim();
        finish(new Error(`${options.label} failed (exit ${code})${detail ? `: ${detail}` : ""}`));
        return;
      }
      try {
        finish(undefined, JSON.parse(stdout.toString("utf8")));
      } catch {
        finish(new Error(`${options.label} returned invalid JSON`));
      }
    });
  });
}

function isProbedImage(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return (item.kind === "img" || item.kind === "background")
    && typeof item.url === "string" && item.url.length <= 8_192
    && typeof item.loaded === "boolean"
    && typeof item.visible === "boolean"
    && typeof item.width === "number" && typeof item.height === "number" && typeof item.areaRatio === "number";
}

export async function collectVisibleImages(url: string, signal?: AbortSignal): Promise<VisibilityProbe> {
  const parsed = await runBrowserProbe(
    "check-visible-images.mjs",
    url,
    { label: "visible-image probe", timeoutMs: 150_000, outputLimit: 8 * 1024 * 1024 },
    signal,
  );
  const record = parsed as Record<string, unknown> | null;
  for (const width of ["390", "1280"]) {
    const items = record?.[width];
    if (!Array.isArray(items) || items.length > 2_000 || !items.every(isProbedImage)) {
      throw new Error(`visible-image probe returned an invalid report for ${width}px`);
    }
  }
  return parsed as VisibilityProbe;
}

export async function measureTextDeserts(url: string, signal?: AbortSignal): Promise<DesertMeasurement> {
  const parsed = await runBrowserProbe(
    "measure-text-deserts.mjs",
    url,
    { label: "text desert probe", timeoutMs: 120_000, outputLimit: 64 * 1024 },
    signal,
  );
  const value = parsed as Record<string, unknown> | null;
  for (const key of ["pageScreens", "worstScreens", "atScreen"]) {
    if (typeof value?.[key] !== "number" || !Number.isFinite(value[key])) {
      throw new Error(`text desert probe returned an invalid ${key}`);
    }
  }
  return parsed as DesertMeasurement;
}
