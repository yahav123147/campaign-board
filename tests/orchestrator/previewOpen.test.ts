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
    expect(openInBrowser(url, { platform: "darwin", spawn: mac.spawn as never })).toBe(true);
    expect(mac.calls[0]).toEqual({ command: "open", args: [url] });

    const linux = spy();
    expect(openInBrowser(url, { platform: "linux", wsl: false, spawn: linux.spawn as never })).toBe(true);
    expect(linux.calls[0]).toEqual({ command: "xdg-open", args: [url] });

    const wsl = spy();
    expect(openInBrowser(url, { platform: "linux", wsl: true, spawn: wsl.spawn as never })).toBe(true);
    expect(wsl.calls[0].command).toBe("powershell.exe");
    expect(wsl.calls[0].args).toEqual(["-NoProfile", "-NonInteractive", "-Command", "Start-Process", url]);
  });

  it("survives a launcher that is missing from PATH: the child's async error is absorbed", () => {
    // Inside WSL2 with Windows interop paths absent, spawn("powershell.exe")
    // returns a child and then emits ENOENT asynchronously. Unlistened, that
    // is an uncaught exception in the server process.
    const wsl = spy();
    expect(openInBrowser(url, { platform: "linux", wsl: true, spawn: wsl.spawn as never })).toBe(true);
    const child = wsl.children[0];
    expect(child.listenerCount("error")).toBe(1);
    expect(() => child.emit("error", Object.assign(new Error("spawn powershell.exe ENOENT"), { code: "ENOENT" }))).not.toThrow();
  });

  it("never throws: a failed launcher only means the link is printed instead", () => {
    const boom = vi.fn(() => {
      throw new Error("ENOENT");
    });
    expect(openInBrowser(url, { platform: "linux", wsl: false, spawn: boom as never })).toBe(false);
    expect(openInBrowser(url, { platform: "win32", spawn: spy().spawn as never })).toBe(false);
  });
});
