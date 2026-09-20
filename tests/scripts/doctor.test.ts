import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assessClaudeAuth,
  assessPrivateDirectory,
  claudeApiEnvironmentCheck,
  doctorCheck,
  formatDoctorReport,
  importCanonicalClientProfile,
  macOnlyCapabilityStatus,
  metaGraphApiVersionCheck,
  missingRequiredImageModules,
  parseLoopbackPort,
  parsePythonRequirements,
  parseRelevantDotEnv,
  parseVersion,
  processTreePlatformCheck,
  pythonImportName,
  REQUIRED_IMAGE_MODULES,
  resolveDoctorDataPaths,
  resolveDoctorPython,
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

  it("loads the canonical profile validator with its @/ imports resolved", async () => {
    // The validator imports a value from "@/types". A data: URL module cannot
    // resolve a bare alias, so the doctor reported "could not be loaded" on
    // every install, correct ones included.
    const validator = await importCanonicalClientProfile(path.resolve(import.meta.dirname, "..", ".."));
    expect(typeof validator.validateClientProfile).toBe("function");
  });

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
