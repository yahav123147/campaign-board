import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileP = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "..", "..");

/**
 * setup.sh checked that python3 exists, not which one. A stock Mac ships
 * 3.9.6, the README asks for 3.10+, and the pinned numpy needs 3.10+: the
 * install got past the first line and died inside pip with no useful message.
 */
async function runSetupWith(pythonVersion: string): Promise<{ code: number; out: string }> {
  const bin = await fs.mkdtemp(path.join(os.tmpdir(), "council-setup-gate-"));
  const stub = async (name: string, body: string) => {
    const file = path.join(bin, name);
    await fs.writeFile(file, `#!/bin/sh\n${body}\n`);
    await fs.chmod(file, 0o755);
  };
  // Every command setup.sh probes before pip must resolve to something local,
  // so the test never touches the developer's tools and never reaches npm ci.
  await stub("python3", `echo "Python ${pythonVersion}"`);
  await stub("claude", "exit 0");
  await stub("node", "exit 0");
  await stub("npm", 'echo "npm ci must not run when the Python gate fails" >&2; exit 99');
  // This test is only about the Python gate: force macOS so setup.sh's Linux
  // block (bubblewrap check) never activates. On a real Linux host with no
  // bwrap, an unstubbed uname would let that block run the real apt-get.
  await stub("uname", 'echo "Darwin"');
  try {
    const { stdout, stderr } = await execFileP("bash", [path.join(ROOT, "setup.sh")], {
      cwd: ROOT,
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: bin, LANG: "en_US.UTF-8", NODE_ENV: "test" },
    });
    return { code: 0, out: stdout + stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? 1, out: `${failed.stdout ?? ""}${failed.stderr ?? ""}` };
  } finally {
    await fs.rm(bin, { recursive: true, force: true });
  }
}

describe("setup.sh Python gate", () => {
  it("stops before installing anything when python3 is older than 3.10", async () => {
    const result = await runSetupWith("3.9.6");
    expect(result.code).toBe(1);
    expect(result.out).toContain("3.10");
    expect(result.out).toContain("3.9.6");
    expect(result.out).not.toContain("npm ci must not run");
  });

  it("lets a 3.10+ interpreter through to the install", async () => {
    // Reaching the npm stub (which exits 99) is the proof the gate opened.
    const result = await runSetupWith("3.12.4");
    expect(result.code).toBe(99);
    expect(result.out).toContain("npm ci must not run");
  });
});
