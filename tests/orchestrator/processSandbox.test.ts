import { describe, expect, it } from "vitest";
import { buildMacProcessSandboxProfile } from "@/orchestrator/processSandbox";

describe("generated-page process sandbox", () => {
  it("is deny-by-default, limits execution to Node, and has no network for builds", () => {
    const profile = buildMacProcessSandboxProfile("/safe/node", {
      readPaths: ["/safe/worktree", "/safe/node_modules"],
      writePaths: ["/safe/worktree/.next", "/safe/tmp"],
      network: "none",
    });
    expect(profile).toContain("(deny default)");
    expect(profile).toContain('(allow process-exec (literal "/safe/node"))');
    expect(profile).toContain('(allow file-read* (subpath "/safe/worktree"))');
    expect(profile).toContain('(allow file-write* (subpath "/safe/worktree/.next"))');
    expect(profile).not.toMatch(/allow network/);
    expect(profile).not.toContain("(allow process*)");
  });

  it("allows only loopback server operations for preview", () => {
    const profile = buildMacProcessSandboxProfile("/safe/node", {
      readPaths: ["/safe/worktree"],
      writePaths: ["/safe/worktree/.next"],
      network: "loopback-server",
    });
    expect(profile).not.toContain("network-outbound");
  });
});
