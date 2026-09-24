import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assessClaudeAuth,
  claudeSubscriptionCheck,
  readClaudeSubscriptionTier,
  assessPrivateDirectory,
  claudeApiEnvironmentCheck,
  doctorCheck,
  formatDoctorReport,
  importCanonicalClientProfile,
  importTypeScriptModule,
  macOnlyCapabilityStatus,
  metaGraphApiVersionCheck,
  missingRequiredImageModules,
  mockupBrowserCheck,
  parseLoopbackPort,
  parsePythonRequirements,
  parseRelevantDotEnv,
  parseVersion,
  probeLinuxSandbox,
  processTreePlatformCheck,
  pythonImportName,
  REQUIRED_IMAGE_MODULES,
  resolveDoctorDataPaths,
  resolveDoctorPython,
  secretStoreCheck,
  stage5SandboxCheck,
  summarizeChecks,
  versionAtLeast,
} from "../../scripts/doctor.mjs";

describe("doctor pure checks", () => {
  it("parses command versions without depending on product wording", () => {
    expect(parseVersion("v20.9.0")).toEqual([20, 9, 0]);
    expect(parseVersion("Python 3.12.7")).toEqual([3, 12, 7]);
    expect(parseVersion("Claude Code 2.1")).toEqual([2, 1, 0]);
    expect(parseVersion("unknown")).toBeNull();
    expect(versionAtLeast([20, 9, 0], [20, 9, 0])).toBe(true);
    expect(versionAtLeast([22, 0, 0], [20, 9, 0])).toBe(true);
    expect(versionAtLeast([20, 8, 9], [20, 9, 0])).toBe(false);
  });

  it("accepts first-party OAuth and rejects API-like or malformed auth status", () => {
    expect(assessClaudeAuth(JSON.stringify({
      loggedIn: true,
      authMethod: "claude.ai",
      apiProvider: "firstParty",
    }))).toEqual({ valid: true, loggedIn: true, subscriptionOAuth: true });
    expect(assessClaudeAuth(JSON.stringify({
      loggedIn: true,
      authMethod: "api_key",
      apiProvider: "firstParty",
    })).subscriptionOAuth).toBe(false);
    expect(assessClaudeAuth("not json")).toEqual({
      valid: false,
      loggedIn: false,
      subscriptionOAuth: false,
    });
  });

  it("reads only allowlisted dotenv keys and handles quotes without exposing unrelated values", () => {
    const parsed = parseRelevantDotEnv([
      "CAMPAIGN_COUNCIL_CLIENT_PROFILE='/tmp/client profile.json'",
      "PREVIEW_PORT=4500 # local preview",
      "META_GRAPH_API_VERSION=v26.0",
      "UNRELATED_SECRET=must-not-be-retained",
      "ANTHROPIC_API_KEY=present-but-never-printed",
    ].join("\n"));

    expect(parsed).toEqual({
      CAMPAIGN_COUNCIL_CLIENT_PROFILE: "/tmp/client profile.json",
      PREVIEW_PORT: "4500",
      META_GRAPH_API_VERSION: "v26.0",
      ANTHROPIC_API_KEY: "present-but-never-printed",
    });
    expect(parsed).not.toHaveProperty("UNRELATED_SECRET");
  });

  it("parses the supported locked Python requirement syntax", () => {
    expect(parsePythonRequirements("# core\nPillow==12.1.1\nhelper>=2.0\n")).toEqual([
      { packageName: "Pillow", operator: "==", version: "12.1.1" },
      { packageName: "helper", operator: ">=", version: "2.0" },
    ]);
    expect(() => parsePythonRequirements("Pillow~=12.1")).toThrow("Unsupported Python requirement");
  });

  // Parked item P2: the doctor used to inspect PATH's python3 while a run used
  // the packaged venv, so a venv without numpy passed the check and then
  // rejected every device mockup.
  it("inspects the interpreter a run actually uses", () => {
    const venv = "/home/client/.campaign-council-venv/bin/python3";
    expect(resolveDoctorPython({ home: "/home/client", exists: (file) => file === venv })).toBe(venv);
    expect(resolveDoctorPython({ home: "/home/client", exists: () => false })).toBe("python3");
  });

  it("requires numpy and scipy beside Pillow, which every device mockup needs", () => {
    expect(REQUIRED_IMAGE_MODULES).toEqual(["Pillow", "numpy", "scipy"]);
    expect(missingRequiredImageModules(parsePythonRequirements("Pillow==12.1.1\n")))
      .toEqual(["numpy", "scipy"]);
    expect(missingRequiredImageModules(
      parsePythonRequirements("Pillow==12.1.1\nnumpy==2.2.6\nscipy==1.15.3\n"),
    )).toEqual([]);
  });

  it("knows the import name of every pinned image package", () => {
    // python-bidi installs as `bidi`. The dash-to-underscore guess produced
    // `python_bidi`, which never imports, so a correct install read as broken.
    expect(pythonImportName("python-bidi")).toBe("bidi");
    expect(pythonImportName("Pillow")).toBe("PIL");
    expect(pythonImportName("numpy")).toBe("numpy");
  });

  it("checks the renderer's chosen browser and blocks a missing browser only when stage 5 is enabled", async () => {
    const override = "/client/chosen-browser";
    const result = await mockupBrowserCheck({ stage5: { enabled: true } }, {
      CAMPAIGN_COUNCIL_CHROME_PATH: override,
    }, async (options) => {
      expect(options?.chromePath).toBe(override);
      return override;
    });
    expect(result.status).toBe("pass");
    expect(result.summary).toContain(override);
    const missing = async () => { throw new Error("unavailable"); };
    expect((await mockupBrowserCheck({ stage5: { enabled: true } }, {}, missing)).status).toBe("fail");
    expect((await mockupBrowserCheck({ stage5: { enabled: false } }, {}, missing)).status).toBe("warn");
  });

  it("loads the canonical profile validator with its @/ imports resolved", async () => {
    // The validator imports a value from "@/types". A data: URL module cannot
    // resolve a bare alias, so the doctor reported "could not be loaded" on
    // every install, correct ones included.
    const validator = await importCanonicalClientProfile(path.resolve(import.meta.dirname, "..", ".."));
    expect(typeof validator.validateClientProfile).toBe("function");
  });

  it("loads any @/ TypeScript module the same way it loads the profile validator", async () => {
    const root = path.resolve(import.meta.dirname, "..", "..");
    const sandbox = await importTypeScriptModule(root, "orchestrator/linuxProcessSandbox");
    expect(typeof sandbox.linuxSandboxedNodeLaunch).toBe("function");
  });

  it("on Linux reports the sandbox by running it, and fails when the probe fails", async () => {
    const pass = await stage5SandboxCheck({ stage5: { enabled: true } }, "linux", { probe: async () => ({ ok: true, detail: "allowed write ok, /etc hidden" }) });
    expect(pass).toMatchObject({ id: "stage5-native-sandbox", status: "pass" });
    const fail = await stage5SandboxCheck({ stage5: { enabled: true } }, "linux", { probe: async () => ({ ok: false, detail: "bwrap: No permissions to create user namespace" }) });
    expect(fail).toMatchObject({ status: "fail" });
    expect(fail.summary).toContain("user namespace");
    const off = await stage5SandboxCheck({ stage5: { enabled: false } }, "linux", { probe: async () => ({ ok: false, detail: "x" }) });
    expect(off.status).toBe("warn");
  });

  it("names the closed release switch as the blocking reason, whatever the Linux probe says", () => {
    // config/platform-acceptance.json lost, edited or left out of the archive:
    // the reader fails closed, the three gates refuse every landing run, and
    // the doctor used to print PASS and Ready: YES right before that happened.
    const probe = async () => ({ ok: true, detail: "allowed write ok, /etc hidden" });
    return Promise.all([
      stage5SandboxCheck({ stage5: { enabled: true } }, "linux", { probe, accepted: () => false }),
      stage5SandboxCheck({ stage5: { enabled: false } }, "linux", { probe, accepted: () => false }),
      stage5SandboxCheck({ stage5: { enabled: true } }, "linux", { probe, accepted: () => true }),
    ]).then(([blocked, disabled, open]) => {
      expect(blocked.status).toBe("fail");
      expect(blocked.summary).toContain("acceptance");
      expect(blocked.action).toContain("config/platform-acceptance.json");
      expect(disabled.status).toBe("warn");
      expect(open.status).toBe("pass");
    });
  });

  it("fails the sandbox check closed, instead of crashing the doctor, when the release switch module cannot load", async () => {
    // A partial unpack that drops lib/ used to kill the doctor at import time
    // (the switch was a top-level import); now it is one FAIL line like the
    // secret-store module.
    const probe = async () => ({ ok: true, detail: "allowed write ok, /etc hidden" });
    const loadSwitch = async () => { throw new Error("ERR_MODULE_NOT_FOUND"); };
    const enabled = await stage5SandboxCheck({ stage5: { enabled: true } }, "linux", { probe, loadSwitch });
    expect(enabled.status).toBe("fail");
    expect(enabled.summary).toContain("lib/platformAcceptance.mjs");
    expect(enabled.action).toContain("config/platform-acceptance.json");
    const off = await stage5SandboxCheck({ stage5: { enabled: false } }, "linux", { probe, loadSwitch });
    expect(off.status).toBe("warn");
    // The real module still drives the check when it loads.
    const real = await stage5SandboxCheck({ stage5: { enabled: true } }, "linux", { probe });
    expect(real.status).toBe("pass");
  });

  it("probeLinuxSandbox reports pass and removes the launch's cleanupPath when the script exits 0", async () => {
    const cleanupPath = await fs.mkdtemp(path.join(os.tmpdir(), "council-doctor-test-cleanup-"));
    const launch = async () => ({
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      profile: "{}",
      cleanupPath,
    });
    const result = await probeLinuxSandbox("unused-root", { launch });
    expect(result.ok).toBe(true);
    await expect(fs.access(cleanupPath)).rejects.toThrow();
  });

  it("probeLinuxSandbox reports fail with the script's stdout in detail when it exits non-zero", async () => {
    const cleanupPath = await fs.mkdtemp(path.join(os.tmpdir(), "council-doctor-test-cleanup-"));
    const launch = async () => ({
      command: process.execPath,
      args: ["-e", "process.stdout.write('boom'); process.exit(1);"],
      profile: "{}",
      cleanupPath,
    });
    const result = await probeLinuxSandbox("unused-root", { launch });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("boom");
    await expect(fs.access(cleanupPath)).rejects.toThrow();
  });

  it("probeLinuxSandbox fails fast, not only on the timeout, when the launch command cannot spawn", async () => {
    const cleanupPath = await fs.mkdtemp(path.join(os.tmpdir(), "council-doctor-test-cleanup-"));
    const launch = async () => ({
      command: "/nonexistent/binary",
      args: [],
      profile: "{}",
      cleanupPath,
    });
    const start = Date.now();
    const result = await probeLinuxSandbox("unused-root", { launch });
    const elapsed = Date.now() - start;
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("ENOENT");
    expect(elapsed).toBeLessThan(5000);
    await expect(fs.access(cleanupPath)).rejects.toThrow();
  });

  it("probeLinuxSandbox times out and kills a hung script, still cleaning up", async () => {
    const cleanupPath = await fs.mkdtemp(path.join(os.tmpdir(), "council-doctor-test-cleanup-"));
    const launch = async () => ({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      profile: "{}",
      cleanupPath,
    });
    const start = Date.now();
    const result = await probeLinuxSandbox("unused-root", { launch, timeoutMs: 300 });
    const elapsed = Date.now() - start;
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("timed out");
    // The 300ms timeout kills the child well inside vitest's default 5s test
    // timeout; a resolution this fast is only possible if the SIGKILL fired
    // instead of the process being left to run indefinitely.
    expect(elapsed).toBeLessThan(2000);
    await expect(fs.access(cleanupPath)).rejects.toThrow();
  });

  it("fails the secret-store check closed, instead of crashing the doctor, when the module cannot load", async () => {
    const failingLoad = async () => { throw new Error("boom"); };
    const disabled = await secretStoreCheck({}, {}, "darwin", false, failingLoad);
    expect(disabled.status).toBe("warn");
    expect(disabled.summary).toBe("The secret store module could not be loaded.");
    expect(disabled.action).toContain("npm install");

    const enabled = await secretStoreCheck({}, { stage8: { enabled: true } }, "darwin", false, failingLoad);
    expect(enabled.status).toBe("fail");
  });

  it("reports an unreachable Windows PowerShell as an interop problem, not a missing credential", async () => {
    // automount.root = / or interop disabled: the probe's ENOENT used to read
    // as "item not found" with the cmdkey hint, sending the operator to
    // re-store a credential that is already there.
    const load = async () => ({
      detectSecretBackend: () => "windows-credential-manager",
      secretExistsCommand: () => ({ command: "/nowhere/powershell.exe", args: [], env: {}, discardStdout: false }),
      installHint: () => "cmdkey hint",
      resolveWindowsPowerShell: () => undefined,
      WINDOWS_INTEROP_MISSING: "interop text",
    });
    const profile = { meta: { tokenKeychainService: "council-meta" } };
    const result = await secretStoreCheck(profile, { stage8: { enabled: true } }, "linux", true, load);
    expect(result.status).toBe("fail");
    expect(result.summary).toContain("Windows PowerShell is not reachable");
    expect(result.action).toBe("interop text");
    expect(`${result.summary} ${result.action}`).not.toContain("cmdkey");
  });

  it("loads the secret-store module from the checkout the doctor was pointed at", async () => {
    // A doctor run given another checkout's root used to validate this one's
    // module instead, so the report described a tree nobody asked about.
    const roots: string[] = [];
    const load = async (root: string) => {
      roots.push(root);
      throw new Error("stop after the load");
    };
    await secretStoreCheck({}, {}, "darwin", false, load, "/elsewhere/checkout");
    expect(roots).toEqual(["/elsewhere/checkout"]);
  });

  it("reports an invalid secret service name as one failed check, not an aborted doctor run", async () => {
    // A name copy-pasted from a password manager keeps its newline. On WSL2
    // building the PowerShell script throws on a control character, and
    // secretStoreCheck is awaited inside Promise.all: the whole report was
    // lost instead of one FAIL line.
    const profile = { meta: { tokenKeychainService: "council\nmeta" } };
    const result = await secretStoreCheck(profile, { stage8: { enabled: true } }, "linux", true);
    expect(result.status).toBe("fail");
    expect(result.summary).toContain("meta.tokenKeychainService");
    // The rejected name itself is never echoed back.
    expect(`${result.summary} ${result.action}`).not.toContain("council");
  }, 30_000);

  it("requires owner-only Unix permissions and matching ownership", () => {
    expect(assessPrivateDirectory({ platform: "darwin", mode: 0o40700, uid: 501, expectedUid: 501 })).toEqual({
      private: true,
      ownerMatches: true,
      modeLabel: "700",
    });
    expect(assessPrivateDirectory({ platform: "linux", mode: 0o40755, uid: 1000, expectedUid: 1000 }).private).toBe(false);
    expect(assessPrivateDirectory({ platform: "linux", mode: 0o40700, uid: 1001, expectedUid: 1000 }).private).toBe(false);
  });

  it("blocks enabled macOS-only capabilities on other platforms", () => {
    expect(macOnlyCapabilityStatus("darwin", true)).toBe("pass");
    expect(macOnlyCapabilityStatus("linux", true)).toBe("fail");
    expect(macOnlyCapabilityStatus("win32", true)).toBe("fail");
    expect(macOnlyCapabilityStatus("linux", false)).toBe("warn");
  });

  it("fails Windows when no Job Object process-tree reaper is available", () => {
    expect(processTreePlatformCheck("darwin").status).toBe("pass");
    expect(processTreePlatformCheck("linux").status).toBe("pass");
    expect(processTreePlatformCheck("win32")).toMatchObject({
      id: "process-tree-reaper",
      status: "fail",
    });
  });

  it("resolves the same private data roots used by the application", () => {
    expect(resolveDoctorDataPaths({
      root: "/workspace/council",
      effectiveEnv: {},
      platform: "darwin",
      home: "/home/client",
    })).toEqual({
      primary: "/home/client/Library/Application Support/Campaign Council/runs",
      legacy: "/workspace/council/runs",
      exactOverride: false,
    });
    expect(resolveDoctorDataPaths({
      root: "/workspace/council",
      effectiveEnv: { CAMPAIGN_COUNCIL_DATA_DIR: "/private/council" },
      platform: "linux",
      home: "/home/client",
    }).primary).toBe("/private/council/runs");
    expect(resolveDoctorDataPaths({
      root: "/workspace/council",
      effectiveEnv: { RUNS_DIR_OVERRIDE: "/workspace/council/test-runs" },
      platform: "linux",
      home: "/home/client",
    })).toEqual({
      primary: "/workspace/council/test-runs",
      legacy: "/workspace/council/runs",
      exactOverride: true,
    });
  });

  it("rejects relative and broad configured data roots before runtime can chmod them", () => {
    const base = {
      root: "/workspace/council",
      platform: "linux",
      home: "/home/client",
    } as const;
    expect(() => resolveDoctorDataPaths({
      ...base,
      effectiveEnv: { RUNS_DIR_OVERRIDE: "relative-runs" },
    })).toThrow(/absolute dedicated directory/i);
    for (const unsafePath of ["/", "/home/client", "/workspace/council", "/tmp"]) {
      expect(() => resolveDoctorDataPaths({
        ...base,
        effectiveEnv: { RUNS_DIR_OVERRIDE: unsafePath },
      })).toThrow(/dedicated subdirectory/i);
    }
  });

  it("validates loopback port configuration", () => {
    expect(parseLoopbackPort(undefined, 3000, "PORT")).toBe(3000);
    expect(parseLoopbackPort("4322", 3000, "PORT")).toBe(4322);
    expect(() => parseLoopbackPort("80", 3000, "PORT")).toThrow("between 1024 and 65535");
    expect(() => parseLoopbackPort("3000.5", 3000, "PORT")).toThrow("between 1024 and 65535");
  });

  it("accepts only a Meta version segment and never a URL override", () => {
    expect(metaGraphApiVersionCheck({}).status).toBe("pass");
    expect(metaGraphApiVersionCheck({ META_GRAPH_API_VERSION: "v27.0" }).status).toBe("pass");
    expect(metaGraphApiVersionCheck({ META_GRAPH_API_VERSION: "https://evil.example" }).status)
      .toBe("fail");
    expect(metaGraphApiVersionCheck({ META_GRAPH_API_VERSION: "v26.1" }).status).toBe("fail");
  });

  it("formats an actionable report without raw diagnostic payloads", () => {
    const checks = [
      doctorCheck({ id: "one", title: "One", status: "pass", summary: "Ready." }),
      doctorCheck({
        id: "two",
        title: "Two",
        status: "fail",
        summary: "Missing.",
        action: "Install it.",
      }),
    ];

    expect(summarizeChecks(checks)).toEqual({ pass: 1, warn: 0, fail: 1 });
    expect(formatDoctorReport(checks)).toBe([
      "Campaign Council readiness doctor",
      "Read-only diagnostics. No files, settings, or credentials were changed.",
      "",
      "[PASS] One: Ready.",
      "[FAIL] Two: Missing.",
      "       Action: Install it.",
      "",
      "Summary: 1 passed, 0 warnings, 1 failed.",
      "Ready: NO",
    ].join("\n"));
  });

  it("reports forbidden API variables by name without exposing their values", () => {
    const canary = "doctor-secret-canary-7391";
    const result = claudeApiEnvironmentCheck({ ANTHROPIC_API_KEY: canary });
    const report = formatDoctorReport([result]);

    expect(report).toContain("ANTHROPIC_API_KEY");
    expect(report).not.toContain(canary);
  });
});

describe("Claude subscription tier", () => {
  // A client on the Pro tier installed the board and only learned at the
  // first agent run that MAX is required; the CLI's auth status hides the
  // tier, its credential store does not.
  const store = (tier: string) => JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-SECRET", refreshToken: "sk-ant-ort01-SECRET", subscriptionType: tier } });
  const noKeychain = async () => ({ ok: false, stdout: "", stderr: "", code: 44 });

  it("reads the tier from the credentials file under the config directory first", async () => {
    const seen: string[] = [];
    const result = await readClaudeSubscriptionTier({
      platform: "linux", home: "/home/tester", env: {} as NodeJS.ProcessEnv,
      readFile: async (file) => { seen.push(file); return store("max"); },
      runCommand: noKeychain as never,
    });
    expect(result).toEqual({ tier: "max", source: "the Claude CLI credentials file" });
    expect(seen).toEqual(["/home/tester/.claude/.credentials.json"]);
  });
  it("honours CLAUDE_CONFIG_DIR and falls back to the macOS Keychain item", async () => {
    const seen: string[] = [];
    const result = await readClaudeSubscriptionTier({
      platform: "darwin", home: "/home/mac-tester", env: { CLAUDE_CONFIG_DIR: "/cfg" } as unknown as NodeJS.ProcessEnv,
      readFile: async (file) => { seen.push(file); throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); },
      runCommand: (async (file: string, args: string[]) => {
        seen.push(`${file} ${args.join(" ")}`);
        return { ok: true, stdout: store("pro"), stderr: "", code: 0 };
      }) as never,
    });
    expect(result).toEqual({ tier: "pro", source: "the macOS Keychain" });
    expect(seen[0]).toBe("/cfg/.credentials.json");
    expect(seen[1]).toBe("/usr/bin/security find-generic-password -s Claude Code-credentials -w");
  });
  it("passes on MAX, fails naming any other tier, warns when unreadable, and never leaks a token", async () => {
    const deps = (tier?: string) => ({
      platform: "linux" as const, home: "/h", env: {} as NodeJS.ProcessEnv,
      readFile: async () => { if (!tier) throw new Error("ENOENT"); return store(tier); },
      runCommand: noKeychain as never,
    });
    const max = await claudeSubscriptionCheck(deps("Max"));
    expect(max.status).toBe("pass");
    const pro = await claudeSubscriptionCheck(deps("pro"));
    expect(pro.status).toBe("fail");
    expect(pro.summary).toContain('"pro"');
    expect(pro.action).toContain("claude auth login");
    const unknown = await claudeSubscriptionCheck(deps(undefined));
    expect(unknown.status).toBe("warn");
    for (const check of [max, pro, unknown]) {
      expect(JSON.stringify(check)).not.toContain("SECRET");
    }
  });
  it("treats a store without a tier, or with broken JSON, as unreadable", async () => {
    const readFile = async () => JSON.stringify({ claudeAiOauth: { accessToken: "x" } });
    expect(await readClaudeSubscriptionTier({ platform: "linux", home: "/h", env: {} as NodeJS.ProcessEnv, readFile, runCommand: noKeychain as never })).toEqual({});
    expect(await readClaudeSubscriptionTier({ platform: "linux", home: "/h", env: {} as NodeJS.ProcessEnv, readFile: async () => "{not json", runCommand: noKeychain as never })).toEqual({});
  });
});
