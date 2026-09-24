import { describe, expect, it } from "vitest";
import { windowsBrowserLaunch } from "@/orchestrator/windowsBrowser";

describe("windowsBrowserLaunch", () => {
  it("encodes a single-quoted literal for a web URL and never uses -Command", () => {
    const launch = windowsBrowserLaunch("http://127.0.0.1:4322/council-x;$(calc)");
    expect(launch?.command).toMatch(/\/powershell\.exe$/i);
    expect(launch?.args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
    const script = Buffer.from(launch!.args[3], "base64").toString("utf16le");
    expect(script).toBe("Start-Process -FilePath 'http://127.0.0.1:4322/council-x;$(calc)'");
    expect(launch?.args).not.toContain("-Command");
  });
  it("refuses file paths, non-web schemes, whitespace and quotes", () => {
    for (const bad of ["file:///home/u/sheet.jpg", "javascript:alert(1)", "ftp://x/y", "http://h/a b", "http://h/it's", "http://h/\n"]) {
      expect(windowsBrowserLaunch(bad)).toBeUndefined();
    }
  });
});
