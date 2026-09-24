import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProcessSandboxSpec, SandboxedLaunch } from "./processSandbox";

const BWRAP = "/usr/bin/bwrap";
const PYTHON = "/usr/bin/python3";
const FORBIDDEN_TREES = ["/dev", "/proc", "/sys", "/run", "/mnt", "/media", "/init"];

function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export function assertLinuxMountPath(value: string, home = os.homedir()): void {
  if (!path.isAbsolute(value) || /[\0\r\n]/.test(value)) {
    throw new Error("Linux sandbox paths must be absolute and contain no control characters");
  }
  const resolved = path.resolve(value);
  if (["/", "/home", "/root", "/tmp", "/var", "/etc", path.resolve(home)].includes(resolved)
    || FORBIDDEN_TREES.some((root) => within(root, resolved))) {
    throw new Error(`Linux sandbox refuses a broad or host-integration mount: ${resolved}`);
  }
}

async function regularExecutable(value: string): Promise<string> {
  const resolved = await fs.realpath(value).catch(() => {
    throw new Error(`Required Linux sandbox executable is unavailable: ${value}`);
  });
  const stat = await fs.stat(resolved);
  if (!stat.isFile() || (stat.mode & 0o111) === 0) {
    throw new Error(`Required Linux sandbox executable is not executable: ${value}`);
  }
  return resolved;
}

/**
 * Linux permits child executables within the same isolated namespace. Unlike
 * Seatbelt, this does not claim Node-only exec: a dynamic ELF loader would
 * bypass such a Landlock allowlist. No process gains host paths or networking.
 * Experimental: ordinary application calls remain blocked in processSandbox.ts
 * until the complete WSL/Claude pipeline passes acceptance.
 */
export async function linuxSandboxedNodeLaunch(
  nodeExecutable: string,
  nodeArgs: readonly string[],
  spec: ProcessSandboxSpec,
): Promise<SandboxedLaunch> {
  if (spec.network === "https-egress") {
    throw new Error("Linux landing builds require the offline local-font starter; HTTPS egress is not supported by this sandbox");
  }
  if (spec.network === "loopback-server"
    && (!Number.isInteger(spec.loopbackPort) || spec.loopbackPort! < 1024 || spec.loopbackPort! > 65535)) {
    throw new Error("Linux preview sandbox requires an explicit unprivileged loopback port");
  }
  if (!spec.workingDirectory) throw new Error("Linux sandbox requires an explicit working directory");
  const [bwrap, python, node, helper, cwd] = await Promise.all([
    regularExecutable(BWRAP), regularExecutable(PYTHON), regularExecutable(nodeExecutable),
    fs.realpath(path.join(process.cwd(), "scripts", "linux-process-sandbox.py")),
    fs.realpath(spec.workingDirectory),
  ]);
  const readPaths = [...new Set(await Promise.all(spec.readPaths.map(async (value) => {
    assertLinuxMountPath(value);
    const resolved = await fs.realpath(value);
    assertLinuxMountPath(resolved);
    return resolved;
  })))];
  const writePaths = [...new Set(await Promise.all(spec.writePaths.map(async (value) => {
    assertLinuxMountPath(value);
    const resolved = await fs.realpath(value);
    assertLinuxMountPath(resolved);
    if (!readPaths.some((root) => within(root, resolved))) {
      throw new Error(`Linux sandbox write path escaped its declared read roots: ${value}`);
    }
    return resolved;
  })))];
  if (!readPaths.some((root) => within(root, cwd))) {
    throw new Error("Linux sandbox working directory is outside its declared read roots");
  }
  const cleanupPath = await fs.mkdtemp(path.join(os.tmpdir(), "council-linux-launch-"));
  await fs.chmod(cleanupPath, 0o700);
  try {
    if (readPaths.some((root) => within(root, cleanupPath))) {
      throw new Error("Linux sandbox launch state would be visible inside the sandbox");
    }
    const config = {
      version: 1, bwrap, python, helper, node, nodeArgs, cwd, readPaths, writePaths,
      network: spec.network, port: spec.loopbackPort, launchDir: cleanupPath,
    };
    const configPath = path.join(cleanupPath, "launch.json");
    await fs.writeFile(configPath, JSON.stringify(config), { mode: 0o600, flag: "wx" });
    return {
      command: python,
      args: [helper, "outer", configPath],
      profile: JSON.stringify({ backend: "bubblewrap", execution: "confined-child-processes", ...config }, null, 2),
      cleanupPath,
    };
  } catch (error) {
    await fs.rm(cleanupPath, { recursive: true, force: true });
    throw error;
  }
}
