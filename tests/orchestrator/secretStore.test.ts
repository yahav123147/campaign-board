import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  credReadScript, detectSecretBackend, installHint, MAX_SECRET_BYTES, psSingleQuoted, readSecret, secretCommand, secretExistsCommand,
} from "@/orchestrator/secretStore";

/** A child that emits what the test scripts, and records what it was asked. */
function fakeSpawn(script: (child: FakeChild) => void) {
  const calls: { command: string; args: string[] }[] = [];
  const spawn = vi.fn((command: string, args: string[]) => {
    calls.push({ command, args });
    const child = new FakeChild();
    queueMicrotask(() => script(child));
    return child as never;
  });
  return { spawn, calls };
}
class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = { resume() {} };
  pid = 4242;
  killed: string[] = [];
  kill(signal: string) { this.killed.push(signal); return true; }
  unref() {}
}

describe("detectSecretBackend", () => {
  it("picks the store the host actually has, and none for native Windows", () => {
    expect(detectSecretBackend("darwin", false)).toBe("macos-keychain");
    expect(detectSecretBackend("linux", true)).toBe("windows-credential-manager");
    expect(detectSecretBackend("linux", false)).toBe("linux-secret-tool");
    expect(detectSecretBackend("win32", false)).toBeUndefined();
  });
});

describe("secretCommand", () => {
  it("names the service in argv on every backend, and never the secret", () => {
    for (const backend of ["macos-keychain", "linux-secret-tool"] as const) {
      const { args } = secretCommand(backend, "council-meta");
      expect(args.join(" ")).toContain("council-meta");
    }
    // Windows: the service reaches PowerShell as a single-quoted literal
    // inside the script. WSLENV on the Linux child does not carry a
    // per-process variable into an interop-launched Windows process (measured
    // on a real runner), so the environment route could not work.
    const win = secretCommand("windows-credential-manager", "council-meta");
    expect(win.args.join(" ")).toContain("'council-meta'");
    expect(win.args.join(" ")).toContain("$false");
    expect(win.args.join(" ")).not.toContain("$env:");

    expect(secretCommand("macos-keychain", "s")).toMatchObject({ command: "/usr/bin/security", args: ["find-generic-password", "-s", "s", "-w"] });
    // Absolute, like the macOS backend: a stale ~/.local/bin shim or a
    // compromised dev tool earlier on PATH could otherwise answer the lookup
    // and hand stage 8 a substituted token.
    expect(secretCommand("linux-secret-tool", "s")).toMatchObject({ command: "/usr/bin/secret-tool", args: ["lookup", "service", "s"] });
    expect(win.command).toBe("/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe");
    expect(win.args).toContain("-NonInteractive");
    expect(win.args.join(" ")).toContain("CredRead");
  });
  it("keeps the Windows environment to exactly the minimal key set, with nothing secret-specific", () => {
    const win = secretCommand("windows-credential-manager", "s");
    expect(Object.keys(win.env).sort()).toEqual(["HOME", "LANG", "NODE_ENV", "PATH", "WSL_DISTRO_NAME", "WSL_INTEROP"]);
    expect(Object.keys(win.env).some((key) => key.startsWith("COUNCIL_SECRET_"))).toBe(false);
    expect(win.env).not.toHaveProperty("WSLENV");
  });
  it("quotes a service name so a quote cannot break out, and refuses control characters", () => {
    expect(psSingleQuoted("it's")).toBe("'it''s'");
    expect(credReadScript("it's", false)).toContain("'it''s'");
    for (const bad of ["a\nb", "a\u0000b", "a\tb"]) {
      let message = "";
      try { psSingleQuoted(bad); } catch (error) { message = (error as Error).message; }
      expect(message).toContain("invalid");
      expect(message).not.toContain("\u0000");
      expect(message).not.toContain("\n");
    }
  });
  it("has an existence probe that cannot print the value", () => {
    expect(secretExistsCommand("macos-keychain", "s").args).not.toContain("-w");
    expect(secretExistsCommand("macos-keychain", "s").discardStdout).toBe(false);
    // secret-tool's "search" prints "secret = <value>" for a match and exits 0
    // regardless, so the probe reuses "lookup" (exits 1 when missing) and the
    // caller must discard its stdout at the spawn level, not merely ignore it.
    const linuxProbe = secretExistsCommand("linux-secret-tool", "s");
    expect(linuxProbe.command).toBe("/usr/bin/secret-tool");
    expect(secretExistsCommand("windows-credential-manager", "s").command).toBe("/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe");
    expect(linuxProbe.args[0]).toBe("lookup");
    expect(linuxProbe.args).toEqual(["lookup", "service", "s"]);
    expect(linuxProbe.discardStdout).toBe(true);
    const winProbe = secretExistsCommand("windows-credential-manager", "s");
    const winProbeScript = winProbe.args[winProbe.args.length - 1];
    expect(winProbeScript).toContain("'s'");
    // The mode reaching Read, not merely the word: the script also passes
    // $false to the UTF8Encoding constructor (no BOM).
    expect(winProbeScript).toContain("::Read('s', $true)");
    expect(winProbeScript).not.toContain("::Read('s', $false)");
    // The struct declaration textually names CredentialBlob(Size) either way
    // (it's C# source, compiled once for both modes) — the real guarantee is
    // that existsOnly short-circuits to "present" before the blob is ever
    // touched, not that the field name is absent from the script text.
    const existsOnlyIndex = winProbeScript.indexOf('if (existsOnly) return "present"');
    const blobReadIndex = winProbeScript.indexOf("c.CredentialBlobSize");
    expect(existsOnlyIndex).toBeGreaterThan(-1);
    expect(blobReadIndex).toBeGreaterThan(-1);
    expect(existsOnlyIndex).toBeLessThan(blobReadIndex);
    expect(winProbe.discardStdout).toBe(false);
  });
});

describe("readSecret", () => {
  const deps = (spawn: unknown) => ({ platform: "darwin" as const, wsl: false, spawn: spawn as never });

  it("returns the trimmed stdout of a zero exit", async () => {
    const { spawn } = fakeSpawn((c) => { c.stdout.emit("data", Buffer.from("tok3n\n")); c.emit("close", 0); });
    await expect(readSecret("svc", undefined, deps(spawn))).resolves.toBe("tok3n");
  });
  it("fails closed on a non-zero exit or empty output, naming the service, never the value", async () => {
    const { spawn } = fakeSpawn((c) => { c.emit("close", 1); });
    await expect(readSecret("svc", undefined, deps(spawn))).rejects.toThrow(/svc/);
  });
  it("honours an already-aborted signal before spawning", async () => {
    const { spawn } = fakeSpawn(() => {});
    const controller = new AbortController(); controller.abort();
    await expect(readSecret("svc", controller.signal, deps(spawn))).rejects.toThrow();
    expect(spawn).not.toHaveBeenCalled();
  });
  it("terminates the child on abort", async () => {
    let child!: FakeChild;
    const { spawn } = fakeSpawn((c) => { child = c; });
    const controller = new AbortController();
    const pending = readSecret("svc", controller.signal, deps(spawn));
    await new Promise((r) => setTimeout(r, 10));
    controller.abort();
    await expect(pending).rejects.toThrow(/abort/i);
    expect(child.killed).toContain("SIGTERM");
  });
  it("refuses output beyond the size limit", async () => {
    const { spawn } = fakeSpawn((c) => { c.stdout.emit("data", Buffer.alloc(MAX_SECRET_BYTES + 1, 0x61)); });
    await expect(readSecret("svc", undefined, deps(spawn))).rejects.toThrow(/limit/);
  });
  it("fails closed with an install hint when the host has no store", async () => {
    const { spawn } = fakeSpawn(() => {});
    await expect(readSecret("svc", undefined, { platform: "win32", wsl: false, spawn: spawn as never })).rejects.toThrow(installHint(undefined));
    expect(spawn).not.toHaveBeenCalled();
  });
  it("turns a missing secret-tool binary into the Linux install hint, naming the service", async () => {
    const { spawn } = fakeSpawn((c) => { const e = Object.assign(new Error("spawn secret-tool ENOENT"), { code: "ENOENT" }); c.emit("error", e); });
    let error: unknown;
    try {
      await readSecret("svc", undefined, { platform: "linux", wsl: false, spawn: spawn as never });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("svc");
    expect(message).toContain(installHint("linux-secret-tool"));
  });
});

describe("credReadScript", () => {
  // Regression for a real WSL2/Windows-runner bug: CREDENTIALW's field
  // offsets are 32-bit-only, so a hand-computed Marshal.ReadInt32/ReadIntPtr
  // offset read garbage on 64-bit powershell.exe (a random huge "blob size"
  // that either thrashed until timeout or threw immediately). The script must
  // let the marshaler lay out the struct instead of repeating that mistake.
  it("lets the marshaler own the CREDENTIAL struct layout, with no hard-coded offsets", () => {
    const script = credReadScript("x", false);
    expect(script).toContain("StructLayout(LayoutKind.Sequential");
    expect(script).toContain("PtrToStructure");
    expect(script).toContain("MAX_BLOB");
    expect(script).not.toContain("ReadInt32($ptr, 24)");
    expect(script).not.toContain("ReadIntPtr($ptr, 32)");
    // No Marshal.ReadInt32/ReadIntPtr/ReadInt64 call at all — the whole family
    // of hand-offset APIs this bug came from, not just its two prior call sites.
    expect(script).not.toMatch(/Marshal\.Read(Int32|IntPtr|Int64)\(/);
  });
  it("carries the service only as the quoted literal it was asked for, never through the environment", () => {
    // A second real-runner bug: WSLENV does not carry a per-process value into
    // an interop-launched Windows process, so `$env:` is not a transport here.
    const script = credReadScript("council-meta", true);
    expect(script).not.toContain("$env:");
    expect(script).toContain("'council-meta'");
    for (const other of ["council-ci-secret", "svc"]) expect(script).not.toContain(other);
    // The here-string that carries the C# must open at end of line and close
    // at column 0, or PowerShell never terminates it.
    expect(script).toMatch(/@'\s*\n/);
    expect(script).toMatch(/\n'@\s*\n/);
  });
  it("sets UTF-8 output before writing, so a non-ASCII secret survives the pipe", () => {
    // Redirected Windows PowerShell 5.1 writes through the OEM/ANSI code
    // page, while readSecret decodes utf-8: a token with any non-ASCII
    // character came back as mojibake, non-empty, and failed open into an
    // opaque Graph auth error instead of a secret-store error.
    const script = credReadScript("council-meta", false);
    expect(script).toContain("[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)");
    expect(script.indexOf("[Console]::OutputEncoding")).toBeLessThan(script.indexOf("[Console]::Out.Write"));
  });
});

describe("readSecret termination escalation", () => {
  afterEach(() => { vi.useRealTimers(); });
  const deps = (spawn: unknown) => ({ platform: "darwin" as const, wsl: false, spawn: spawn as never });

  it("escalates SIGTERM to SIGKILL 2s later when the child never closes", async () => {
    vi.useFakeTimers();
    let child!: FakeChild;
    const { spawn } = fakeSpawn((c) => { child = c; });
    const controller = new AbortController();
    const pending = readSecret("svc", controller.signal, deps(spawn));
    pending.catch(() => {}); // observed below; avoids an unhandled-rejection warning meanwhile
    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    expect(child.killed).toEqual(["SIGTERM"]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(child.killed).toEqual(["SIGTERM", "SIGKILL"]);
    await expect(pending).rejects.toThrow(/abort/i);
  });

  it("does not escalate, and settles exactly once, when the child closes right after SIGTERM", async () => {
    vi.useFakeTimers();
    let child!: FakeChild;
    const { spawn } = fakeSpawn((c) => { child = c; });
    const controller = new AbortController();
    const pending = readSecret("svc", controller.signal, deps(spawn));
    let rejections = 0;
    pending.catch(() => { rejections += 1; });
    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    child.emit("close", 143); // the real process exits promptly once SIGTERM is delivered
    await vi.advanceTimersByTimeAsync(2_000);
    expect(child.killed).toEqual(["SIGTERM"]);
    await expect(pending).rejects.toThrow(/abort/i);
    expect(rejections).toBe(1);
  });
});
