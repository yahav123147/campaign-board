import fs from "node:fs/promises";
import path from "node:path";
import fsSync from "node:fs";
import { linuxLandingAccepted } from "./platformAcceptance";
import { linuxSandboxedNodeLaunch } from "./linuxProcessSandbox";

export type SandboxNetworkMode = "none" | "loopback-server" | "https-egress";

export interface ProcessSandboxSpec {
  readonly readPaths: readonly string[];
  readonly writePaths: readonly string[];
  readonly network: SandboxNetworkMode;
  /** Explicit namespace server port; Linux never shares the host network. */
  readonly loopbackPort?: number;
  readonly workingDirectory?: string;
}

export interface SandboxedLaunch {
  readonly command: string;
  readonly args: readonly string[];
  readonly profile: string;
  /** Private host-only launch state. Remove only after the supervised child closes. */
  readonly cleanupPath?: string;
}

/** Linux bind mounts require existing targets. Never follow a file symlink. */
export async function prepareLinuxSandboxFiles(paths: readonly string[]): Promise<void> {
  if (process.platform !== "linux") return;
  for (const value of paths) {
    const file = await fs.open(value, fsSync.constants.O_WRONLY | fsSync.constants.O_CREAT
      | fsSync.constants.O_NOFOLLOW | fsSync.constants.O_NONBLOCK, 0o600);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1) throw new Error(`Unsafe Linux sandbox output file: ${value}`);
    } finally {
      await file.close();
    }
  }
}

const MAC_SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const SYSTEM_READ_PATHS = [
  "/System",
  "/usr",
  "/Library",
  "/private/etc",
  "/private/var/db/timezone",
  "/private/var/db/dyld",
] as const;
const DEVICE_READ_PATHS = ["/dev/null", "/dev/random", "/dev/urandom"] as const;

function quoteSandboxString(value: string): string {
  if (/\0|\r|\n/.test(value)) throw new Error("Sandbox paths cannot contain control characters");
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/**
 * Seatbelt matches rules against real paths. macOS hands out aliases such as
 * `/var/folders/...` (really `/private/var/folders/...`) and `/tmp`, so a rule
 * written with the alias never matches and every write in the sandbox home is
 * denied with EPERM. Resolve what exists; keep the literal for paths that do
 * not exist yet. Verified on Darwin 25 on 30.08.2026.
 */
function realpathOrSelf(value: string): string {
  const resolved = path.resolve(value);
  try {
    return fsSync.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function normalizedPaths(values: readonly string[]): string[] {
  return [...new Set(values.map(realpathOrSelf))].sort();
}

function pathRules(operation: string, paths: readonly string[]): string[] {
  return paths.map((value) => `(${operation} (subpath ${quoteSandboxString(value)}))`);
}

/** Build a deny-by-default Seatbelt profile for generated Next.js code. */
export function buildMacProcessSandboxProfile(
  nodeExecutable: string,
  spec: ProcessSandboxSpec,
): string {
  const executable = path.resolve(nodeExecutable);
  const readPaths = normalizedPaths([...SYSTEM_READ_PATHS, executable, ...spec.readPaths]);
  const writePaths = normalizedPaths(spec.writePaths);
  const lines = [
    "(version 1)",
    "(deny default)",
    "(allow process-fork)",
    `(allow process-exec (literal ${quoteSandboxString(executable)}))`,
    "(allow signal (target self))",
    // `next build` runs its compile and page-data steps in worker processes and
    // signals them when it is done; without this every build ends in kill EPERM.
    "(allow signal (target children))",
    "(allow sysctl-read)",
    "(allow ipc-posix-shm)",
    // Directory traversal metadata is required by Node's module resolver. File
    // contents remain restricted to the explicit read paths below.
    "(allow file-read-metadata)",
    '(allow file-read* (literal "/"))',
    ...pathRules("allow file-read*", readPaths),
    ...DEVICE_READ_PATHS.map((value) =>
      `(allow file-read* (literal ${quoteSandboxString(value)}))`),
    ...pathRules("allow file-write*", writePaths),
    `(allow file-write* (literal ${quoteSandboxString("/dev/null")}))`,
  ];
  if (spec.network === "https-egress") {
    // `next build` resolves next/font/google at build time by fetching CSS and
    // font files from Google. Seatbelt cannot filter by hostname, so this
    // opens outbound TCP 443 plus macOS DNS (mDNSResponder socket) and nothing
    // else: no inbound, no other ports. The page source itself is still
    // checked by the static postflight before it is ever built.
    lines.push(
      '(allow network-outbound (remote tcp "*:443"))',
      '(allow network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))',
    );
  }
  if (spec.network === "loopback-server") {
    // sandbox-exec only accepts `*` or `localhost` as the host in a network
    // address; a literal "127.0.0.1" makes the whole profile invalid and the
    // preview server dies with exit 65 before Next.js starts. `localhost:*`
    // covers 127.0.0.1 binds.
    lines.push(
      '(allow network-bind (local ip "localhost:*"))',
      '(allow network-inbound (local ip "localhost:*"))',
    );
  }
  return lines.join("\n");
}

export interface SandboxLaunchOptions {
  readonly platform?: NodeJS.Platform;
  readonly linuxAccepted?: boolean;
}

/**
 * Wrap a Node command in the native OS sandbox. Unsupported or unavailable
 * platforms fail closed instead of silently running generated code directly.
 */
export async function sandboxedNodeLaunch(
  nodeExecutable: string,
  nodeArgs: readonly string[],
  spec: ProcessSandboxSpec,
  options: SandboxLaunchOptions = {},
): Promise<SandboxedLaunch> {
  const platform = options.platform ?? process.platform;
  if (platform === "linux") {
    if (!(options.linuxAccepted ?? linuxLandingAccepted())) {
      throw new Error("Linux/WSL landing execution is awaiting acceptance (config/platform-acceptance.json)");
    }
    return linuxSandboxedNodeLaunch(nodeExecutable, nodeArgs, spec);
  }
  if (platform !== "darwin") {
    throw new Error(
      "Generated landing-page execution requires macOS or a supported Linux sandbox; native Windows is unsupported",
    );
  }
  const sandboxStat = await fs.lstat(MAC_SANDBOX_EXEC).catch(() => undefined);
  if (!sandboxStat?.isFile()) {
    throw new Error("The required macOS sandbox-exec binary is unavailable");
  }
  const executableStat = await fs.lstat(nodeExecutable).catch(() => undefined);
  if (!executableStat?.isFile() || executableStat.isSymbolicLink()) {
    throw new Error("The Node executable for sandboxed page execution is unsafe");
  }
  const executable = await fs.realpath(nodeExecutable);
  const profile = buildMacProcessSandboxProfile(executable, spec);
  return {
    command: MAC_SANDBOX_EXEC,
    args: ["-p", profile, executable, ...nodeArgs],
    profile,
  };
}
