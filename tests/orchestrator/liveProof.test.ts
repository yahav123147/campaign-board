import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

vi.mock("@/orchestrator/liveProofBrowser", () => ({
  startSupervisedChrome: vi.fn(),
  runInstagramCapture: vi.fn(),
}));

import { captureInstagramProof, liveProofEnabled } from "@/orchestrator/liveProof";
import { runInstagramCapture, startSupervisedChrome } from "@/orchestrator/liveProofBrowser";
import { validateClientProfile } from "@/config/clientProfile";

/**
 * The Chrome and capture helpers are mocked here: this file is about the
 * lifecycle the parent owns (profile creation, session copy, ordering,
 * deletion) and never starts a real browser or touches Instagram.
 */

const profile = (liveProof?: boolean) => validateClientProfile({
  schemaVersion: 1,
  tenant: { id: "acme", displayName: "Acme", locale: "he-IL", timezone: "Asia/Jerusalem" },
  brand: { publicName: "Acme", facts: ["עובדה מאומתת"] },
  policies: {
    contentRules: [],
    advertisingRules: [],
    operationalRules: [],
    capabilities: {
      landingPageBuild: true,
      metaPixelRead: false,
      metaCampaignCreatePaused: false,
      ...(liveProof === undefined ? {} : { liveProof }),
    },
  },
});

describe("liveProofEnabled", () => {
  it("is off unless the capability is explicitly true", () => {
    expect(liveProofEnabled(undefined)).toBe(false);
    expect(liveProofEnabled(profile())).toBe(false);
    expect(liveProofEnabled(profile(true))).toBe(true);
  });
});

/**
 * Throwaway profiles land in a directory this file owns, not in the shared
 * system temp dir, so a parallel test file can never be seen mid-capture.
 */
let profileParent: string;

async function ownedProfiles(): Promise<string[]> {
  return (await fs.readdir(profileParent)).sort();
}

describe("captureInstagramProof", () => {
  let runDir: string;
  let workspace: string;
  let operatorProfile: string;
  let closeAndWait: ReturnType<typeof vi.fn<() => Promise<void>>>;
  /** What the browser helper saw in the profile directory at launch time. */
  let seenAtLaunch: { profileDir?: string; files?: string[]; defaultFiles?: string[]; mode?: number };

  beforeEach(async () => {
    runDir = await fs.mkdtemp(path.join(os.tmpdir(), "council-live-proof-run-"));
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "council-live-proof-ws-"));
    operatorProfile = await fs.mkdtemp(path.join(os.tmpdir(), "council-live-proof-chrome-"));
    profileParent = await fs.mkdtemp(path.join(os.tmpdir(), "council-live-proof-parent-"));
    process.env.CAMPAIGN_COUNCIL_LIVE_PROOF_PROFILE_PARENT = profileParent;
    await fs.mkdir(path.join(operatorProfile, "Default", "Network"), { recursive: true });
    await fs.writeFile(path.join(operatorProfile, "Local State"), "{}");
    await fs.writeFile(path.join(operatorProfile, "Default", "Cookies"), "cookies");
    await fs.writeFile(path.join(operatorProfile, "Default", "Network", "Cookies"), "cookies");
    process.env.CAMPAIGN_COUNCIL_CHROME_PROFILE_DIR = operatorProfile;

    seenAtLaunch = {};
    closeAndWait = vi.fn<() => Promise<void>>(async () => {});
    vi.mocked(startSupervisedChrome).mockReset();
    vi.mocked(runInstagramCapture).mockReset();
    vi.mocked(startSupervisedChrome).mockImplementation(async (args) => {
      seenAtLaunch.profileDir = args.profileDir;
      seenAtLaunch.files = (await fs.readdir(args.profileDir)).sort();
      seenAtLaunch.defaultFiles = (await fs.readdir(path.join(args.profileDir, "Default"))).sort();
      seenAtLaunch.mode = (await fs.stat(args.profileDir)).mode & 0o777;
      return { endpoint: "http://127.0.0.1:65000", closeAndWait };
    });
    vi.mocked(runInstagramCapture).mockImplementation(async (args) => {
      await fs.writeFile(args.out, "png-bytes");
      return { followers: "12.3K", followersRaw: "12.3K עוקבים" };
    });
  });

  afterEach(async () => {
    delete process.env.CAMPAIGN_COUNCIL_CHROME_PROFILE_DIR;
    delete process.env.CAMPAIGN_COUNCIL_LIVE_PROOF_PROFILE_PARENT;
    await fs.rm(profileParent, { recursive: true, force: true });
    await fs.rm(runDir, { recursive: true, force: true });
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(operatorProfile, { recursive: true, force: true });
  });

  const capture = (over: Partial<Parameters<typeof captureInstagramProof>[0]> = {}) =>
    captureInstagramProof({ runDir, handle: "acme", landingWorkspace: workspace, ...over });

  it("copies the session into a throwaway profile before launch, and returns the screenshot with its follower count", async () => {

    const result = await capture();

    // The follower count the capture read off the page travels with the file:
    // 5.2 states it next to the proof, so the number is never guessed later.
    expect(result).toEqual({
      file: path.join(runDir, "harvest", "instagram-acme.png"),
      followers: "12.3K",
      followersRaw: "12.3K עוקבים",
    });
    expect("file" in result && result.file.endsWith("instagram-acme.png")).toBe(true);
    // The profile existed with the copied session before Chrome was asked to start.
    expect(seenAtLaunch.files).toEqual(["Default", "Local State"]);
    expect(seenAtLaunch.defaultFiles).toEqual(["Cookies", "Network"]);
    expect(seenAtLaunch.mode).toBe(0o700);
    // The capture ran against the endpoint the helper returned, in the landing workspace.
    const captureArgs = vi.mocked(runInstagramCapture).mock.calls[0]![0];
    expect(captureArgs.endpoint).toBe("http://127.0.0.1:65000");
    expect(captureArgs.handle).toBe("acme");
    expect(captureArgs.cwd).toBe(workspace);
    expect(captureArgs.deadline).toBeGreaterThan(Date.now());
    expect(captureArgs.deadline).toBeLessThanOrEqual(Date.now() + 180_000);
    expect(closeAndWait).toHaveBeenCalledTimes(1);
    // The throwaway profile is gone again.
    expect(await ownedProfiles()).toEqual([]);
  });

  it("deletes nothing and settles nothing until the browser has actually closed", async () => {
    let releaseClose = () => {};
    closeAndWait.mockImplementation(() => new Promise<void>((resolve) => {
      releaseClose = resolve;
    }));
    let settled = false;

    const pending = capture().then((value) => {
      settled = true;
      return value;
    });
    // Wait for the state under test, not for a clock: the capture is parked on
    // the browser close. A fixed 50ms assumed launch had happened by then,
    // and on a loaded machine it had not, so the profile was not there yet.
    await vi.waitFor(() => expect(closeAndWait).toHaveBeenCalled());

    expect(settled).toBe(false);
    const profileDir = seenAtLaunch.profileDir!;
    await expect(fs.stat(profileDir)).resolves.toBeTruthy();

    releaseClose();
    await expect(pending).resolves.toMatchObject({ file: path.join(runDir, "harvest", "instagram-acme.png") });
    await expect(fs.stat(profileDir)).rejects.toThrow();
  });

  it("returns an operational error, after cleanup, when the capture fails", async () => {
    vi.mocked(runInstagramCapture).mockRejectedValue(new Error("ig_shot.mjs נכשל: קוד יציאה 1"));

    const result = await capture();

    expect(result).toEqual({ error: expect.stringContaining("ig_shot.mjs נכשל") });
    expect(closeAndWait).toHaveBeenCalledTimes(1);
    expect(await ownedProfiles()).toEqual([]);
  });

  it("leaves no unvalidated image in the harvest when the proof failed", async () => {
    // The agent can read the harvest root, and the prompt says there is no
    // proof: an image left there would be placed as one anyway.
    vi.mocked(runInstagramCapture).mockImplementation(async (args) => {
      await fs.writeFile(args.out, "png-bytes");
      await fs.writeFile(`${args.out}.json`, "{}");
      throw new Error("ig_shot.mjs נכשל: קוד יציאה 2");
    });

    const result = await capture();

    expect("error" in result).toBe(true);
    const out = path.join(runDir, "harvest", "instagram-acme.png");
    await expect(fs.stat(out)).rejects.toThrow();
    await expect(fs.stat(`${out}.json`)).rejects.toThrow();
  });

  it("leaves no unvalidated image in the harvest when the run was cancelled", async () => {
    const controller = new AbortController();
    vi.mocked(runInstagramCapture).mockImplementation(async (args) => {
      await fs.writeFile(args.out, "png-bytes");
      controller.abort();
      throw new Error("צילום האינסטגרם בוטל");
    });

    await expect(capture({ signal: controller.signal })).rejects.toThrow(/בוטל/);

    await expect(fs.stat(path.join(runDir, "harvest", "instagram-acme.png"))).rejects.toThrow();
  });

  it("passes on the capture's own refusal as the error, with no file", async () => {
    // The script validated the page and refused to save: a rejected proof, not
    // a crashed run. The reason it printed is what 5.2 has to show the operator.
    vi.mocked(runInstagramCapture).mockResolvedValue({
      error: "ig_shot.mjs נכשל: הדף של acme.studio אינו זמין באינסטגרם",
    });

    const result = await capture();

    expect(result).toEqual({ error: expect.stringContaining("אינו זמין באינסטגרם") });
    expect("file" in result).toBe(false);
    expect(closeAndWait).toHaveBeenCalledTimes(1);
    expect(await ownedProfiles()).toEqual([]);
  });

  it("returns an operational error when the capture runs out of time", async () => {
    vi.mocked(runInstagramCapture).mockRejectedValue(new Error("צילום האינסטגרם חרג מהזמן שהוקצב"));

    await expect(capture()).resolves.toEqual({ error: expect.stringContaining("חרג מהזמן") });
    expect(closeAndWait).toHaveBeenCalledTimes(1);
  });

  it("returns an operational error, and never runs a capture, when the browser fails to start", async () => {
    vi.mocked(startSupervisedChrome).mockRejectedValue(new Error("הדפדפן נסגר לפני שנפתחה אליו גישה"));

    const result = await capture();

    expect(result).toEqual({ error: expect.stringContaining("הדפדפן נסגר") });
    expect(runInstagramCapture).not.toHaveBeenCalled();
    // The helper reaped its own supervisor; the parent still removes its profile.
    expect(closeAndWait).not.toHaveBeenCalled();
    expect(await ownedProfiles()).toEqual([]);
  });

  it("returns an operational error when the operator has no Chrome profile to copy", async () => {
    process.env.CAMPAIGN_COUNCIL_CHROME_PROFILE_DIR = path.join(operatorProfile, "missing");

    const result = await capture();

    expect(result).toEqual({ error: expect.stringContaining("פרופיל כרום") });
    expect(startSupervisedChrome).not.toHaveBeenCalled();
    expect(await ownedProfiles()).toEqual([]);
  });

  it("rethrows after cleanup when the run is cancelled during startup", async () => {
    const controller = new AbortController();
    vi.mocked(startSupervisedChrome).mockImplementation(async () => {
      controller.abort();
      throw new Error("הפעלת הדפדפן בוטלה");
    });

    await expect(capture({ signal: controller.signal })).rejects.toThrow(/בוטלה/);

    expect(await ownedProfiles()).toEqual([]);
  });

  it("rethrows after cleanup when the run is cancelled during the capture", async () => {
    const controller = new AbortController();
    vi.mocked(runInstagramCapture).mockImplementation(async () => {
      controller.abort();
      throw new Error("צילום האינסטגרם בוטל");
    });

    await expect(capture({ signal: controller.signal })).rejects.toThrow(/בוטל/);

    // Cancellation does not skip cleanup: the browser was closed and the profile removed.
    expect(closeAndWait).toHaveBeenCalledTimes(1);
    expect(await ownedProfiles()).toEqual([]);
  });

  it("allocates nothing for an already-cancelled run", async () => {

    await expect(capture({ signal: AbortSignal.abort() })).rejects.toThrow(/בוטל/);

    expect(startSupervisedChrome).not.toHaveBeenCalled();
    expect(runInstagramCapture).not.toHaveBeenCalled();
    expect(await ownedProfiles()).toEqual([]);
  });

  it("propagates a cleanup failure instead of downgrading it to an optional-proof note", async () => {
    closeAndWait.mockRejectedValue(new Error("הדפדפן לא נסגר"));

    await expect(capture()).rejects.toThrow(/לא נסגר/);

    // The copied session never survives the attempt: the profile carries the
    // decryption key and the cookie databases, so it is removed even when the
    // browser refused to close, and the close failure is still what surfaces.
    expect(await ownedProfiles()).toEqual([]);
  });

  it("rejects an invalid handle before anything is allocated", async () => {
    const result = await capture({ handle: "acme/../etc" });

    expect("error" in result).toBe(true);
    expect(startSupervisedChrome).not.toHaveBeenCalled();
  });

  it("reports a capture that ended without a screenshot", async () => {
    vi.mocked(runInstagramCapture).mockResolvedValue({ followers: "12.3K", followersRaw: "12.3K עוקבים" });

    await expect(capture()).resolves.toEqual({ error: expect.stringContaining("בלי קובץ תמונה") });
  });
});
