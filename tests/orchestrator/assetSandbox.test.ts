import path from "node:path";
import os from "node:os";
import { describe, expect, it } from "vitest";
import { buildAssetSandboxSettings } from "@/orchestrator/runStage5Assets";

describe("Stage 5 asset sandbox", () => {
  it("fails closed, blocks unsandboxed commands, and scopes network/read access", () => {
    const settings = buildAssetSandboxSettings({
      assetsDir: "/safe/run/assets",
      profileLandingWorkspace: "/safe/landing",
      referenceDir: "/safe/references/product",
      allowedDomains: ["brand.example", "brand.example"],
    }) as {
      sandbox: {
        enabled: boolean;
        failIfUnavailable: boolean;
        allowUnsandboxedCommands: boolean;
        filesystem: { allowRead: string[]; denyRead: string[] };
        network: { allowedDomains: string[]; allowAllUnixSockets: boolean };
      };
    };

    expect(settings.sandbox).toMatchObject({
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
    });
    expect(settings.sandbox.network).toMatchObject({
      allowedDomains: ["brand.example"],
      allowAllUnixSockets: false,
      allowLocalBinding: false,
    });
    expect(settings.sandbox.filesystem.allowRead).toEqual(expect.arrayContaining([
      path.resolve("/safe/run/assets"),
      path.resolve("/safe/references/product"),
    ]));
    expect(settings.sandbox.filesystem.denyRead).toContain(os.homedir());
    if (process.platform === "linux") {
      expect(settings.sandbox.filesystem.denyRead).toEqual(expect.arrayContaining(["/mnt", "/media", "/init", "/run/WSL"]));
    }
  });

  it("adds the python venv root to allowRead when pythonRoot is given", () => {
    const settings = buildAssetSandboxSettings({
      assetsDir: "/safe/run/assets",
      profileLandingWorkspace: "/safe/landing",
      allowedDomains: [],
      pythonRoot: "/safe/home/.campaign-council-venv",
    }) as { sandbox: { filesystem: { allowRead: string[] } } };

    expect(settings.sandbox.filesystem.allowRead).toContain(path.resolve("/safe/home/.campaign-council-venv"));
  });

  it("leaves allowRead unchanged when pythonRoot is not given", () => {
    const settings = buildAssetSandboxSettings({
      assetsDir: "/safe/run/assets",
      profileLandingWorkspace: "/safe/landing",
      allowedDomains: [],
    }) as { sandbox: { filesystem: { allowRead: string[] } } };

    expect(settings.sandbox.filesystem.allowRead).not.toEqual(expect.arrayContaining([
      expect.stringContaining("campaign-council-venv"),
    ]));
  });
});

describe("macOS Seatbelt profile shape", () => {
  it("allows reading the root directory and writes rules as realpaths", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const { sandboxedNodeLaunch } = await import("@/orchestrator/processSandbox");
    if (process.platform !== "darwin") return;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cc-profile-"));
    const launch = await sandboxedNodeLaunch(process.execPath, ["-e", "0"], { readPaths: [home], writePaths: [home], network: "none" } as never);
    expect(launch.profile).toContain('(allow file-read* (literal "/"))');
    expect(launch.profile).toContain(`(allow file-write* (subpath "${fs.realpathSync.native(home)}"))`);
    fs.rmSync(home, { recursive: true, force: true });
  });
});

describe("https-egress network mode", () => {
  it("opens only outbound 443 and the macOS DNS socket", async () => {
    if (process.platform !== "darwin") return;
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const { sandboxedNodeLaunch } = await import("@/orchestrator/processSandbox");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cc-egress-"));
    const launch = await sandboxedNodeLaunch(process.execPath, ["-e", "0"], { readPaths: [home], writePaths: [home], network: "https-egress" } as never);
    expect(launch.profile).toContain('(allow network-outbound (remote tcp "*:443"))');
    expect(launch.profile).toContain("mDNSResponder");
    expect(launch.profile).not.toContain("network-inbound");
    fs.rmSync(home, { recursive: true, force: true });
  });
});
