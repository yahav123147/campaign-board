import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { buildMacProcessSandboxProfile, sandboxedNodeLaunch } from "@/orchestrator/processSandbox";
import { assertLinuxMountPath, linuxSandboxedNodeLaunch } from "@/orchestrator/linuxProcessSandbox";

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

describe("Linux generated-page sandbox contract", () => {
  it("keeps ordinary runtime calls blocked while the switch is closed", async () => {
    // The shipped switch is open since 24.09.2026; the closed path stays covered explicitly.
    await expect(sandboxedNodeLaunch("/safe/node", [], {
      readPaths: [], writePaths: [], network: "none",
    }, { platform: "linux", linuxAccepted: false })).rejects.toThrow("awaiting acceptance");
  });

  it("routes an accepted Linux launch to the bubblewrap backend, proven on either kind of host", async () => {
    const hasBwrap = fs.existsSync("/usr/bin/bwrap");
    if (hasBwrap) {
      // On a Linux runner bubblewrap is installed, so the launch actually
      // resolves: prove it reached the bubblewrap backend and shells out
      // through a real python3 interpreter.
      const launch = await sandboxedNodeLaunch(process.execPath, ["-e", "0"], {
        readPaths: [process.cwd()], writePaths: [], network: "none", workingDirectory: process.cwd(),
      }, { platform: "linux", linuxAccepted: true });
      try {
        expect(launch.profile).toContain('"backend": "bubblewrap"');
        expect(/python3/.test(launch.command)).toBe(true);
        expect(launch.cleanupPath).toBeTruthy();
      } finally {
        if (launch.cleanupPath) await fs.promises.rm(launch.cleanupPath, { recursive: true, force: true });
      }
    } else {
      // On this Mac /usr/bin/bwrap does not exist, so reaching the backend is
      // proven by its own first failure, not by a sandbox actually starting.
      await expect(sandboxedNodeLaunch(process.execPath, ["-e", "0"], {
        readPaths: [process.cwd()], writePaths: [], network: "none", workingDirectory: process.cwd(),
      }, { platform: "linux", linuxAccepted: true })).rejects.toThrow("Required Linux sandbox executable is unavailable: /usr/bin/bwrap");
    }
  });
  it("rejects broad host roots, Windows integration and host IPC mounts", () => {
    for (const value of ["/", "/home", "/home/client", "/run/user/1000", "/mnt/c/projects/client", "/init", "/proc", "/dev", "/tmp"]) {
      expect(() => assertLinuxMountPath(value, "/home/client")).toThrow();
    }
    expect(() => assertLinuxMountPath("/home/client/landing-worktree", "/home/client")).not.toThrow();
  });

  it("rejects unsupported HTTPS instead of changing the requested policy", async () => {
    await expect(linuxSandboxedNodeLaunch("/safe/node", [], {
      readPaths: [], writePaths: [], network: "https-egress",
    })).rejects.toThrow("HTTPS egress is not supported");
  });

  it("requires a fixed unprivileged preview port before launching anything", async () => {
    await expect(linuxSandboxedNodeLaunch("/safe/node", [], {
      readPaths: [], writePaths: [], network: "loopback-server", loopbackPort: 443,
    })).rejects.toThrow("explicit unprivileged loopback port");
  });
});
