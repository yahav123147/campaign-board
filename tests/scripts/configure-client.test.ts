import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureClient, defaultClientDirectory, clientIdFromName, landingQuestionOffered } from "../../scripts/configure-client.mjs";
import { getClientFeatureReadiness, validateClientProfile } from "../../config/clientProfile";

let fixture: string;
let projectRoot: string;
let directory: string;
const options = { name: "Private Business", id: "private-business", fact: "Provides consulting for independent professionals." };

beforeEach(async () => {
  fixture = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "configure-client-")));
  projectRoot = path.join(fixture, "application");
  directory = path.join(fixture, "private client");
  await fs.mkdir(projectRoot);
  for (const item of [".env.example", "config", "templates", "vendor/landing-skill", "assets/fonts/Heebo.ttf"]) {
    await fs.cp(path.resolve(item), path.join(projectRoot, item), { recursive: true });
  }
});
afterEach(async () => { await fs.rm(fixture, { recursive: true, force: true }); });

const executeLocal = vi.fn((command: string, args: string[], cwd: string) => {
  if (command === "npm") return;
  execFileSync(command, args, { cwd, stdio: "pipe" });
});

describe("client onboarding", () => {
  it("creates a valid isolated profile and a committed neutral landing repo with local fonts and QA", async () => {
    const result = await configureClient({ ...options, directory }, { projectRoot, platform: "linux", run: executeLocal });
    const profile = validateClientProfile(JSON.parse(await fs.readFile(result.profilePath, "utf8")));
    expect(profile.tenant.displayName).toBe(options.name);
    expect(profile.brand.facts).toEqual([options.fact]);
    expect(profile.pipeline).toEqual({ default: "direct", criticMaxRounds: 3 });
    expect(profile.landing?.publicBaseUrl).toBeUndefined();
    expect(profile.copy?.voice?.firstPerson).toBe("presenter");
    expect(getClientFeatureReadiness(profile).stage5.enabled).toBe(false);
    expect(profile.policies.capabilities.metaCampaignCreatePaused).toBe(false);
    expect(profile.policies.capabilities.creativeImageGen).toBe(false);
    expect(profile.policies.capabilities.liveProof).toBe(false);
    expect((await fs.stat(result.profilePath)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(result.envPath)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(result.directory)).mode & 0o777).toBe(0o700);
    const env = await fs.readFile(result.envPath, "utf8");
    expect(env).toContain(`CAMPAIGN_COUNCIL_DATA_DIR=${JSON.stringify(result.dataDirectory)}`);
    expect(env).toContain(`LANDING_PAGES_DIR=${JSON.stringify(result.workspacePath)}`);
    const tracked = execFileSync("git", ["ls-files"], { cwd: result.workspacePath, encoding: "utf8" });
    expect(tracked).toContain("src/fonts/Heebo.ttf");
    expect(tracked).toContain(".agents/skills/landing-design-agent/scripts/landing-qa.mjs");
    expect(tracked).toContain(".agents/skills/landing-design-agent/scripts/orphanLines.mjs");
    expect(tracked).toContain("package-lock.json");
    expect(tracked).not.toMatch(/profile\.json|\.env/);
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: result.workspacePath, encoding: "utf8" })).toBe("");
    expect(spawnSync("git", ["grep", "-l", "Private Business"], { cwd: result.workspacePath, encoding: "utf8" }).status).toBe(1);
  });

  it("enables landing only by explicit choice on macOS and needs no invented public URL", async () => {
    const result = await configureClient({ ...options, directory, enableLanding: true }, { projectRoot, platform: "darwin", run: executeLocal });
    const profile = validateClientProfile(JSON.parse(await fs.readFile(result.profilePath, "utf8")));
    expect(getClientFeatureReadiness(profile).stage5.enabled).toBe(true);
    expect(profile.landing?.workspacePath).toBe(result.workspacePath);
  });

  it("rejects unsupported platform activation before writing while the switch is closed", async () => {
    // The shipped switch is open since 24.09.2026; the closed path stays covered explicitly.
    await expect(configureClient({ ...options, directory, enableLanding: true }, { projectRoot, platform: "linux", linuxAccepted: false })).rejects.toThrow("awaiting acceptance");
    await expect(fs.stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("enables landing on Linux once the acceptance switch is explicitly on", async () => {
    const result = await configureClient(
      { ...options, directory, enableLanding: true },
      { projectRoot, platform: "linux", run: executeLocal, linuxAccepted: true },
    );
    const profile = validateClientProfile(JSON.parse(await fs.readFile(result.profilePath, "utf8")));
    expect(getClientFeatureReadiness(profile).stage5.enabled).toBe(true);
  });

  it("preserves an existing env or destination and rejects symlink paths", async () => {
    await fs.writeFile(path.join(projectRoot, ".env.local"), "KEEP=1\n");
    await expect(configureClient({ ...options, directory }, { projectRoot })).rejects.toThrow("already exists");
    expect(await fs.readFile(path.join(projectRoot, ".env.local"), "utf8")).toBe("KEEP=1\n");
    await fs.unlink(path.join(projectRoot, ".env.local"));
    await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, "keep"), "saved");
    await expect(configureClient({ ...options, directory }, { projectRoot })).rejects.toThrow("already exists");
    expect(await fs.readFile(path.join(directory, "keep"), "utf8")).toBe("saved");
    await fs.symlink(directory, path.join(fixture, "alias"));
    await expect(configureClient({ ...options, directory: path.join(fixture, "alias", "new") }, { projectRoot })).rejects.toThrow("symlink");
    await expect(configureClient({ ...options, directory: path.join(projectRoot, "private") }, { projectRoot })).rejects.toThrow("outside");
  });

  it("cleans only the newly created directory if dependency installation fails", async () => {
    const execute = (command: string, args: string[], cwd: string) => {
      if (command === "npm") throw new Error("registry unavailable");
      executeLocal(command, args, cwd);
    };
    await expect(configureClient({ ...options, directory }, { projectRoot, run: execute })).rejects.toThrow("registry unavailable");
    await expect(fs.stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(path.join(projectRoot, ".env.local"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("derives private OS defaults from a bounded client ID", () => {
    expect(clientIdFromName("Example Business!")).toBe("example-business");
    expect(clientIdFromName("עסק לדוגמה")).toBe("client");
    expect(defaultClientDirectory("example", { platform: "linux", home: "/fixture/user", xdgDataHome: "" })).toBe("/fixture/user/.local/share/campaign-council-clients/example");
    expect(defaultClientDirectory("example", { platform: "darwin", home: "/fixture/user" })).toBe("/fixture/user/Library/Application Support/Campaign Council Clients/example");
  });
});

describe("landingQuestionOffered", () => {
  it("offers the wizard's landing question wherever configureClient would accept the answer", () => {
    // The wizard used to ask on macOS only, so a WSL2 client following the
    // guide's first command block installed with the branch's own feature off
    // and no question asked.
    expect(landingQuestionOffered("darwin", false)).toBe(true);
    expect(landingQuestionOffered("linux", true)).toBe(true);
    expect(landingQuestionOffered("linux", false)).toBe(false);
    expect(landingQuestionOffered("win32", true)).toBe(false);
  });
});
