import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { openInBrowser } from "@/orchestrator/previewServer";

function spy() {
  const calls: { command: string; args: string[] }[] = [];
  const children: EventEmitter[] = [];
  const spawn = vi.fn((command: string, args: string[]) => {
    calls.push({ command, args });
    const child = Object.assign(new EventEmitter(), { unref() {} });
    children.push(child);
    return child as never;
  });
  return { spawn, calls, children };
}

describe("openInBrowser", () => {
  const url = "http://127.0.0.1:4322/council-x";

  it("uses open on macOS, xdg-open on Linux, and the Windows browser from WSL2", () => {
    const mac = spy();
    expect(openInBrowser(url, { platform: "darwin", spawn: mac.spawn as never, resolve: () => true })).toBe(true);
    expect(mac.calls[0]).toEqual({ command: "open", args: [url] });

    const linux = spy();
    expect(openInBrowser(url, { platform: "linux", wsl: false, spawn: linux.spawn as never, resolve: () => true })).toBe(true);
    expect(linux.calls[0]).toEqual({ command: "xdg-open", args: [url] });

    const wsl = spy();
    expect(openInBrowser(url, { platform: "linux", wsl: true, spawn: wsl.spawn as never, resolve: () => true })).toBe(true);
    expect(wsl.calls[0].command).toBe("/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe");
    // The URL is an argument to the script, never part of it: -Command
    // evaluates what it is given, and a data directory containing a space,
    // ";" or "$(" would otherwise become a PowerShell statement.
    expect(wsl.calls[0].args).toEqual([
      "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(`Start-Process -FilePath '${url}'`, "utf16le").toString("base64"),
    ]);
  });

  it("prints the link instead of opening a Linux file:// path from WSL2", () => {
    // Windows cannot resolve file:///home/... ; only the UNC \\wsl$ form works.
    // Returning false makes the caller show the path rather than claim a
    // browser opened, which is what stage 5.2 and 7.5 hand it.
    const wsl = spy();
    const sheet = "file:///home/council/client/data/runs/x/assets/contact-sheet.jpg";
    expect(openInBrowser(sheet, { platform: "linux", wsl: true, spawn: wsl.spawn as never, resolve: () => true })).toBe(false);
    expect(wsl.calls).toHaveLength(0);
    // Plain Linux and macOS resolve the same path natively.
    const linux = spy();
    expect(openInBrowser(sheet, { platform: "linux", wsl: false, spawn: linux.spawn as never, resolve: () => true })).toBe(true);
  });

  it("survives a launcher that is missing from PATH: the child's async error is absorbed", () => {
    // Inside WSL2 with Windows interop paths absent, spawn("powershell.exe")
    // returns a child and then emits ENOENT asynchronously. Unlistened, that
    // is an uncaught exception in the server process.
    const wsl = spy();
    expect(openInBrowser(url, { platform: "linux", wsl: true, spawn: wsl.spawn as never, resolve: () => true })).toBe(true);
    const child = wsl.children[0];
    expect(child.listenerCount("error")).toBe(1);
    expect(() => child.emit("error", Object.assign(new Error("spawn powershell.exe ENOENT"), { code: "ENOENT" }))).not.toThrow();
  });

  it("reports false when the launcher is not on PATH, so the caller prints the link", () => {
    // spawn("powershell.exe") with Windows interop paths absent returns a
    // child and only then emits ENOENT, so a synchronous true was a claim the
    // board could not back (run 35749912557). The launcher is resolved first.
    const wsl = spy();
    expect(openInBrowser(url, { platform: "linux", wsl: true, spawn: wsl.spawn as never, resolve: () => false })).toBe(false);
    expect(wsl.calls).toHaveLength(0);
    const linux = spy();
    expect(openInBrowser(url, { platform: "linux", wsl: false, spawn: linux.spawn as never, resolve: () => false })).toBe(false);
    expect(linux.calls).toHaveLength(0);
  });

  it("never throws: a failed launcher only means the link is printed instead", () => {
    const boom = vi.fn(() => {
      throw new Error("ENOENT");
    });
    expect(openInBrowser(url, { platform: "linux", wsl: false, spawn: boom as never, resolve: () => true })).toBe(false);
    expect(openInBrowser(url, { platform: "win32", spawn: spy().spawn as never, resolve: () => true })).toBe(false);
  });
});

describe("openInBrowser on WSL2 never lets a URL become PowerShell script", () => {
  // Re-review of the fix round: a string -Command re-joins later argv into
  // the script text, so the "$args[0]" shape opened nothing and still spliced
  // the URL. The URL now travels as a single-quoted literal inside an
  // -EncodedCommand, and only http(s) URLs are handed to Windows at all.
  it("encodes a single-quoted literal and refuses anything that is not a web URL", () => {
    const wsl = spy();
    const hostile = "http://127.0.0.1:4322/x;$(calc)";
    expect(openInBrowser(hostile, { platform: "linux", wsl: true, spawn: wsl.spawn as never, resolve: () => true })).toBe(true);
    const encoded = wsl.calls[0].args[wsl.calls[0].args.length - 1];
    const script = Buffer.from(encoded, "base64").toString("utf16le");
    expect(script).toBe("Start-Process -FilePath 'http://127.0.0.1:4322/x;$(calc)'");
    expect(wsl.calls[0].args).not.toContain("-Command");
    expect(wsl.calls[0].args.join(" ")).not.toContain("$(calc)");

    const none = spy();
    for (const bad of ["javascript:alert(1)", "http://127.0.0.1:4322/a b", "http://127.0.0.1:4322/it's", "ftp://x/y"]) {
      expect(openInBrowser(bad, { platform: "linux", wsl: true, spawn: none.spawn as never, resolve: () => true })).toBe(false);
    }
    expect(none.calls).toHaveLength(0);
  });
});
