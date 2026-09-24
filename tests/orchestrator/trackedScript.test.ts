import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { TrackedScriptTimeoutError, runTrackedScript } from "@/orchestrator/trackedScript";

describe("runTrackedScript", () => {
  it("returns stdout on success and fails with stderr on a non-zero exit", async () => {
    await expect(runTrackedScript({ command: "python3", args: ["-c", "print('hi')"], cwd: process.cwd(), timeoutMs: 10_000, label: "ok" })).resolves.toMatchObject({ stdout: "hi\n" });
    await expect(runTrackedScript({ command: "python3", args: ["-c", "import sys; sys.stderr.write('boom'); sys.exit(2)"], cwd: process.cwd(), timeoutMs: 10_000, label: "bad" })).rejects.toThrow(/bad failed: boom/);
  });
  it("kills the whole process tree on abort and on timeout, grandchildren included", async () => {
    const marker = `council-tracked-${process.pid}-${Date.now()}`;
    // A parent that spawns a child sleeper carrying a unique marker in its argv, then sleeps itself.
    const tree = `import subprocess, sys, time; subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60) # ${marker}"]); time.sleep(60)`;
    const alive = () => {
      // A shell command containing the marker matches its own ancestor on
      // Linux. Invoke pgrep directly so this checks only the fixture processes.
      const result = spawnSync("pgrep", ["-f", marker], { encoding: "utf8" });
      if (result.error) throw result.error;
      if (result.status === 1) return false;
      if (result.status !== 0) throw new Error(`pgrep failed: ${result.stderr}`);
      return result.stdout.trim() !== "";
    };
    const controller = new AbortController();
    const running = runTrackedScript({ command: "python3", args: ["-c", tree], cwd: process.cwd(), signal: controller.signal, timeoutMs: 60_000, label: "tree" });
    await new Promise((r) => setTimeout(r, 700));
    expect(await alive()).toBe(true);
    controller.abort();
    await expect(running).rejects.toThrow(/tree: aborted/);
    await new Promise((r) => setTimeout(r, 1_500));
    expect(await alive()).toBe(false);
    await expect(runTrackedScript({ command: "python3", args: ["-c", "import time; time.sleep(30)"], cwd: process.cwd(), timeoutMs: 300, label: "slow" })).rejects.toThrow(/slow: timed out/);
    // The deadline is a type, not a wording: a script whose own stderr says
    // "timed out" is an ordinary failure and must not be read as the deadline.
    await expect(runTrackedScript({ command: "python3", args: ["-c", "import time; time.sleep(30)"], cwd: process.cwd(), timeoutMs: 300, label: "slow" })).rejects.toBeInstanceOf(TrackedScriptTimeoutError);
    await expect(runTrackedScript({ command: "python3", args: ["-c", "import sys; sys.stderr.write('upstream timed out'); sys.exit(2)"], cwd: process.cwd(), timeoutMs: 10_000, label: "noisy" })).rejects.not.toBeInstanceOf(TrackedScriptTimeoutError);
  }, 20_000);

  /**
   * Minor 6. The caller acts the moment this promise settles: the mockup
   * renderer removes the directory the script was writing into. A script that
   * ignores SIGTERM must therefore be killed and REAPED before the rejection,
   * not merely signalled, or a python keeps writing into a path nobody owns.
   */
  it("waits for a script that ignores SIGTERM to actually stop before rejecting", async () => {
    const log = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "council-tracked-")), "alive.log");
    const stubborn = [
      "import signal, sys, time",
      "signal.signal(signal.SIGTERM, lambda *args: None)",
      "handle = open(sys.argv[1], 'a')",
      "while True:",
      "    handle.write('still here\\n')",
      "    handle.flush()",
      "    time.sleep(0.05)",
    ].join("\n");

    await expect(runTrackedScript({
      command: "python3",
      args: ["-c", stubborn, log],
      cwd: process.cwd(),
      // Long enough that the interpreter is certainly up and has written at
      // least one line before the deadline. A short deadline raced Python's
      // own startup: under a loaded machine the process was killed before it
      // wrote anything, and the assertion below read an empty log. What this
      // test pins is that the process is reaped before the rejection, not the
      // length of the deadline, so the deadline is the part that gives.
      timeoutMs: 2_000,
      label: "stubborn",
    })).rejects.toBeInstanceOf(TrackedScriptTimeoutError);

    const atRejection = (await fs.readFile(log, "utf8")).length;
    expect(atRejection).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 600));
    // Nothing wrote another line after the rejection: the process was gone
    // before the caller was told.
    expect((await fs.readFile(log, "utf8")).length).toBe(atRejection);
    await fs.rm(path.dirname(log), { recursive: true, force: true });
  }, 20_000);
});
