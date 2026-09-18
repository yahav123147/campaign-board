import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  signalTrackedChildProcess,
  shutdownTrackedChildren,
  supervisedProcessTreeLaunch,
  trackChildProcess,
} from "@/orchestrator/childProcessRegistry";

function waitForClose(child: ReturnType<typeof spawn>, timeoutMs = 5_000): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
}> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("child did not close")), timeoutMs);
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
    child.once("error", reject);
  });
}

function waitForExit(child: ReturnType<typeof spawn>, timeoutMs = 3_000): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
}> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("child did not exit")), timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
    child.once("error", reject);
  });
}

async function waitUntilGone(pid: number, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  return false;
}

describe("child process lifecycle registry", () => {
  it("escalates to SIGKILL when a detached child ignores SIGTERM", async () => {
    if (process.platform === "win32") return;
    const child = spawn(
      process.execPath,
      [
        "-e",
        "process.on('SIGTERM',()=>{});process.stdout.write('ready\\n');setInterval(()=>{},1000)",
      ],
      { detached: true, stdio: ["ignore", "pipe", "ignore"] },
    );
    trackChildProcess(child, "test-stubborn-child", { processGroup: true });
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("child did not become ready")), 2_000);
        child.stdout!.once("data", () => {
          clearTimeout(timeout);
          resolve();
        });
        child.once("error", reject);
      });

      await shutdownTrackedChildren({ graceMs: 50, killWaitMs: 2_000 });
      expect(child.signalCode).toBe("SIGKILL");
    } finally {
      if (child.exitCode === null && child.signalCode === null && child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
    }
  });

  it("reaps a stubborn background descendant after its direct parent exits", async () => {
    if (process.platform === "win32") return;
    const target = [
      "const { spawn } = require('node:child_process');",
      "const descendant = spawn(process.execPath, ['-e', \"process.on('SIGTERM',()=>{});process.stdout.write('ready\\\\n');setInterval(()=>{},1000)\"], { stdio: ['ignore', 'pipe', 'ignore'] });",
      "descendant.stdout.once('data', () => {",
      "  descendant.stdout.destroy();",
      "  descendant.unref();",
      "  process.stdout.write(String(descendant.pid) + '\\n', () => process.exit(0));",
      "});",
    ].join("\n");
    const launch = supervisedProcessTreeLaunch(process.execPath, ["-e", target]);
    const child = spawn(launch.command, [...launch.args], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    trackChildProcess(child, "test-background-descendant", {
      supervisedProcessTree: true,
    });
    let descendantPid: number | undefined;

    try {
      descendantPid = await new Promise<number>((resolve, reject) => {
        let stdout = "";
        const timeout = setTimeout(
          () => reject(new Error("descendant pid was not reported")),
          2_000,
        );
        child.stdout!.on("data", (chunk) => {
          stdout += chunk.toString();
          const line = stdout.split("\n", 1)[0];
          if (!/^\d+$/.test(line)) return;
          clearTimeout(timeout);
          resolve(Number(line));
        });
        child.once("error", reject);
      });

      const result = await waitForClose(child);
      expect(result).toEqual({ code: 0, signal: null });
      expect(await waitUntilGone(descendantPid)).toBe(true);
    } finally {
      signalTrackedChildProcess(child, "SIGKILL");
      if (descendantPid && !(await waitUntilGone(descendantPid, 50))) {
        try {
          process.kill(descendantPid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
    }
  });

  it("reaps the tree when the owning process disconnects", async () => {
    if (process.platform === "win32") return;
    const target = [
      "const { spawn } = require('node:child_process');",
      "process.on('SIGTERM', () => {});",
      "const descendant = spawn(process.execPath, ['-e', \"process.on('SIGTERM',()=>{});process.stdout.write('ready\\\\n');setInterval(()=>{},1000)\"], { stdio: ['ignore', 'pipe', 'ignore'] });",
      "descendant.stdout.once('data', () => {",
      "  descendant.stdout.destroy();",
      "  descendant.unref();",
      "  process.stdout.write(String(descendant.pid) + '\\n');",
      "});",
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const launch = supervisedProcessTreeLaunch(process.execPath, ["-e", target]);
    const child = spawn(launch.command, [...launch.args], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    trackChildProcess(child, "test-owner-disconnect", {
      supervisedProcessTree: true,
    });
    let descendantPid: number | undefined;

    try {
      descendantPid = await new Promise<number>((resolve, reject) => {
        let stdout = "";
        const timeout = setTimeout(
          () => reject(new Error("descendant pid was not reported")),
          2_000,
        );
        child.stdout!.on("data", (chunk) => {
          stdout += chunk.toString();
          const line = stdout.split("\n", 1)[0];
          if (!/^\d+$/.test(line)) return;
          clearTimeout(timeout);
          resolve(Number(line));
        });
        child.once("error", reject);
      });

      child.disconnect();
      // Node does not guarantee a `close` event after a caller explicitly
      // disconnects the IPC fd, but the process exit still proves cleanup.
      const result = await waitForExit(child);
      expect(result).toEqual({ code: 143, signal: null });
      expect(await waitUntilGone(descendantPid)).toBe(true);
    } finally {
      signalTrackedChildProcess(child, "SIGKILL");
      if (descendantPid && !(await waitUntilGone(descendantPid, 50))) {
        try {
          process.kill(descendantPid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
    }
  });
});
