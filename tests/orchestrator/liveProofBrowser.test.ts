import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  chromeExecutablePath,
  igShotScriptPath,
  runInstagramCapture,
  startSupervisedChrome,
} from "@/orchestrator/liveProofBrowser";
import { captureInstagramProof } from "@/orchestrator/liveProof";
import { FAKE_CHROME } from "./fakeChrome";

/**
 * Real supervisors, local fake executables, no live Chrome and no network
 * service. The fake browser is modelled the way the real one behaves under
 * cancellation: a root process plus a child that ignores SIGTERM, so only a
 * process-group owner can actually end the tree. Both PIDs are published to a
 * fixture file, and every test proves they are dead before it returns.
 */

const VENDORED_SCRIPT = path.join(process.cwd(), "vendor", "landing-skill", "scripts", "ig_shot.mjs");
const VENDORED_OVERLAY = path.join(process.cwd(), "vendor", "landing-skill", "scripts", "igOverlay.mjs");

/**
 * A capture process that refuses SIGTERM, so the helper cannot settle until the
 * supervisor escalates to KILL: the witness that separates "settled on close"
 * from "settled on the timer".
 */
const FAKE_CAPTURE = `import fs from "node:fs";
fs.writeFileSync(process.env.FAKE_CAPTURE_FIXTURE, JSON.stringify({
  capturePid: process.pid,
  argv: process.argv.slice(2),
  startedAt: Date.now(),
}));
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`;

interface CaptureFixture {
  capturePid: number;
  argv: string[];
  startedAt: number;
}

interface Fixture {
  chromePid: number;
  childPid: number;
  executable: string;
  flags: string[];
  port?: number;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs = 8_000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return true;
    if (Date.now() > end) return false;
    await delay(25);
  }
}

let workDir: string;
let fakeChrome: string;
let fakeCapture: string;
let fixtureFile: string;
let captureFixtureFile: string;
let profileDir: string;
let operatorProfile: string;
let profileParent: string;

/** Supervisors this process still owns and has not reaped. */
function liveTrackedChildren(): string[] {
  const tracked = (globalThis as unknown as {
    __councilChildren?: Set<{ label: string; process: { exitCode: number | null; signalCode: string | null } }>;
  }).__councilChildren;
  return [...(tracked ?? [])]
    .filter((entry) => entry.process.exitCode === null && entry.process.signalCode === null)
    .map((entry) => entry.label);
}

/**
 * Throwaway Chrome profiles captureInstagramProof owns. They land in a
 * directory this file owns, so a parallel test file's in-flight profile can
 * never be mistaken for one left behind here.
 */
async function ownedProfiles(): Promise<string[]> {
  return (await fs.readdir(profileParent)).sort();
}

beforeAll(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), "council-live-proof-browser-"));
  fakeChrome = path.join(workDir, "fake-chrome.cjs");
  await fs.writeFile(fakeChrome, FAKE_CHROME, { mode: 0o755 });
  fakeCapture = path.join(workDir, "fake-capture.mjs");
  await fs.writeFile(fakeCapture, FAKE_CAPTURE);
});

beforeEach(async () => {
  const stamp = Math.random().toString(36).slice(2);
  fixtureFile = path.join(workDir, `fixture-${stamp}.json`);
  captureFixtureFile = path.join(workDir, `capture-${stamp}.json`);
  profileDir = await fs.mkdtemp(path.join(workDir, "profile-"));
  // A stand-in for the operator's own Chrome profile: never the real one.
  operatorProfile = await fs.mkdtemp(path.join(workDir, "operator-chrome-"));
  profileParent = await fs.mkdtemp(path.join(workDir, "profile-parent-"));
  process.env.CAMPAIGN_COUNCIL_LIVE_PROOF_PROFILE_PARENT = profileParent;
  await fs.mkdir(path.join(operatorProfile, "Default", "Network"), { recursive: true });
  await fs.writeFile(path.join(operatorProfile, "Local State"), "{}");
  await fs.writeFile(path.join(operatorProfile, "Default", "Cookies"), "cookies");
  process.env.CAMPAIGN_COUNCIL_CHROME_PATH = fakeChrome;
  process.env.CAMPAIGN_COUNCIL_CHROME_PROFILE_DIR = operatorProfile;
  process.env.FAKE_CHROME_FIXTURE = fixtureFile;
  process.env.FAKE_CAPTURE_FIXTURE = captureFixtureFile;
  delete process.env.FAKE_CHROME_MODE;
  delete process.env.CAMPAIGN_COUNCIL_IG_SHOT_PATH;
  delete process.env.CAMPAIGN_COUNCIL_LIVE_PROOF_TIMEOUT_MS;
});

afterEach(async () => {
  // Never leave a fake browser behind, whatever the assertions did.
  const fixture = await readFixture().catch(() => undefined);
  for (const pid of [fixture?.chromePid, fixture?.childPid]) {
    if (pid && alive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
  const capture = await readCaptureFixture().catch(() => undefined);
  if (capture?.capturePid && alive(capture.capturePid)) {
    try {
      process.kill(capture.capturePid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  await fs.rm(profileDir, { recursive: true, force: true });
  await fs.rm(operatorProfile, { recursive: true, force: true });
  await fs.rm(profileParent, { recursive: true, force: true });
  delete process.env.CAMPAIGN_COUNCIL_LIVE_PROOF_PROFILE_PARENT;
  delete process.env.CAMPAIGN_COUNCIL_CHROME_PATH;
  delete process.env.CAMPAIGN_COUNCIL_CHROME_PROFILE_DIR;
  delete process.env.FAKE_CHROME_FIXTURE;
  delete process.env.FAKE_CAPTURE_FIXTURE;
  delete process.env.FAKE_CHROME_MODE;
  delete process.env.CAMPAIGN_COUNCIL_IG_SHOT_PATH;
  delete process.env.CAMPAIGN_COUNCIL_LIVE_PROOF_TIMEOUT_MS;
});

async function readCaptureFixture(): Promise<CaptureFixture> {
  return JSON.parse(await fs.readFile(captureFixtureFile, "utf8")) as CaptureFixture;
}

async function waitForCaptureFixture(): Promise<CaptureFixture> {
  const ready = await waitUntil(async () => {
    const fixture = await readCaptureFixture().catch(() => undefined);
    return Boolean(fixture?.capturePid);
  });
  expect(ready, "the fake capture never published its PID").toBe(true);
  return readCaptureFixture();
}

async function readFixture(): Promise<Fixture> {
  return JSON.parse(await fs.readFile(fixtureFile, "utf8")) as Fixture;
}

async function waitForFixture(): Promise<Fixture> {
  const ready = await waitUntil(async () => {
    const fixture = await readFixture().catch(() => undefined);
    return Boolean(fixture?.chromePid && fixture?.childPid);
  });
  expect(ready, "the fake browser never published its PIDs").toBe(true);
  return readFixture();
}

async function expectTreeDead(fixture: Fixture): Promise<void> {
  expect(await waitUntil(() => !alive(fixture.chromePid)), "the browser process is still alive").toBe(true);
  expect(await waitUntil(() => !alive(fixture.childPid)), "the SIGTERM-ignoring child is still alive").toBe(true);
}

describe("startSupervisedChrome", () => {
  it("launches the Chrome executable itself and reaps the whole tree on closeAndWait", async () => {
    const chrome = await startSupervisedChrome({ profileDir, deadline: Date.now() + 15_000 });
    const fixture = await readFixture();

    // The binary itself ran, with the owned profile and a loopback debugging port.
    expect(fixture.executable).toBe(fakeChrome);
    expect(fixture.flags).toContain(`--user-data-dir=${profileDir}`);
    expect(fixture.flags).toContain("--remote-debugging-address=127.0.0.1");
    expect(fixture.flags).toContain("--remote-debugging-port=0");
    expect(fixture.flags).toContain("--no-first-run");
    expect(chrome.endpoint).toBe(`http://127.0.0.1:${fixture.port}`);
    expect(alive(fixture.chromePid) && alive(fixture.childPid)).toBe(true);

    await chrome.closeAndWait();

    // Only a process-group owner can end a child that ignores SIGTERM.
    await expectTreeDead(fixture);
    await expect(chrome.closeAndWait()).resolves.toBeUndefined();
  }, 30_000);

  it("reaps its own supervisor when startup never becomes ready before the deadline", async () => {
    process.env.FAKE_CHROME_MODE = "never-ready";

    // The fake browser must be up and have published its PIDs before the
    // deadline kills it, or there is no tree to prove dead. 700ms raced node's
    // own startup on a loaded machine; "never-ready" still never becomes
    // ready, so a longer deadline tests the same reaping.
    const start = startSupervisedChrome({ profileDir, deadline: Date.now() + 3_000 });
    const fixture = await waitForFixture();

    await expect(start).rejects.toThrow(/לא עלה בזמן/);
    // The caller never received a handle, so the helper had to clean up itself.
    await expectTreeDead(fixture);
  }, 30_000);

  it("reaps its own supervisor when the run is cancelled during startup", async () => {
    process.env.FAKE_CHROME_MODE = "never-ready";
    const controller = new AbortController();

    const start = startSupervisedChrome({
      profileDir,
      signal: controller.signal,
      deadline: Date.now() + 15_000,
    });
    const fixture = await waitForFixture();
    controller.abort();

    await expect(start).rejects.toThrow(/בוטלה/);
    await expectTreeDead(fixture);
  }, 30_000);

  it("fails when the browser exits before exposing a debugging port", async () => {
    process.env.FAKE_CHROME_MODE = "crash";

    await expect(startSupervisedChrome({ profileDir, deadline: Date.now() + 15_000 }))
      .rejects.toThrow(/נסגר לפני/);

    await expectTreeDead(await readFixture());
  }, 30_000);

  it("fails within a poll when the browser announces a port and then dies", async () => {
    process.env.FAKE_CHROME_MODE = "port-then-exit";
    const startedAt = Date.now();

    await expect(startSupervisedChrome({ profileDir, deadline: Date.now() + 15_000 }))
      .rejects.toThrow(/נסגר לפני/);

    // Not held until the deadline: the exit check does not depend on the port file.
    expect(Date.now() - startedAt).toBeLessThan(3_000);
    await expectTreeDead(await readFixture());
  }, 30_000);

  it("refuses to run when no Chrome executable is installed at the configured path", async () => {
    process.env.CAMPAIGN_COUNCIL_CHROME_PATH = path.join(workDir, "no-such-chrome");

    await expect(startSupervisedChrome({ profileDir, deadline: Date.now() + 5_000 }))
      .rejects.toThrow(/לא נמצא דפדפן/);
  });

  it("defaults to the installed Chrome when nothing overrides it", () => {
    delete process.env.CAMPAIGN_COUNCIL_CHROME_PATH;
    expect(chromeExecutablePath()).toMatch(/Google Chrome$/);
  });
});

describe("runInstagramCapture", () => {
  it("reports a refused capture as an operational error, only after the process closed", async () => {
    const out = path.join(profileDir, "shot.png");

    // Nothing listens here: the capture script fails and exits non-zero. A
    // refusal is not a crash of the run, it is a proof that was not produced.
    const result = await runInstagramCapture({
      endpoint: "http://127.0.0.1:1",
      handle: "acme.studio",
      out,
      cwd: process.cwd(),
      deadline: Date.now() + 25_000,
    });

    expect(result).toEqual({ error: expect.stringContaining("ig_shot.mjs נכשל") });
    await expect(fs.stat(out)).rejects.toThrow();
  }, 40_000);

  it("names the pop-up in Hebrew when the capture refused with the obstruction code", async () => {
    const out = path.join(profileDir, "shot.png");
    const obstructed = path.join(workDir, "obstructed-capture.mjs");
    // Exit 6 is the capture's own refusal: the profile rendered, the count was
    // read, and a sheet stood over it. The operator reads the reason, not the
    // exit code, so the orchestrator states it rather than echoing the script.
    await fs.writeFile(obstructed, `console.error("something the operator should not have to read");
process.exit(6);
`);
    process.env.CAMPAIGN_COUNCIL_IG_SHOT_PATH = obstructed;

    const result = await runInstagramCapture({
      endpoint: "http://127.0.0.1:9",
      handle: "acme.studio",
      out,
      cwd: process.cwd(),
      deadline: Date.now() + 25_000,
    });

    expect(result).toEqual({ error: "הפרופיל מוסתר על ידי חלון קופץ ולא צולם" });
    await expect(fs.stat(out)).rejects.toThrow();
  }, 40_000);

  it("leaves no image behind when the capture wrote one and then refused", async () => {
    const out = path.join(profileDir, "shot.png");
    const halfWriter = path.join(workDir, "half-capture.mjs");
    // A capture killed after the screenshot, or one that saved and then failed
    // its own validation: an unvalidated image in the harvest is read as proof.
    await fs.writeFile(halfWriter, `import fs from "node:fs";
const out = process.argv[4];
fs.writeFileSync(out, "png");
fs.writeFileSync(out + ".json", "{}");
console.error("הדף של acme.studio אינו זמין באינסטגרם");
process.exit(2);
`);
    process.env.CAMPAIGN_COUNCIL_IG_SHOT_PATH = halfWriter;

    const result = await runInstagramCapture({
      endpoint: "http://127.0.0.1:9",
      handle: "acme.studio",
      out,
      cwd: process.cwd(),
      deadline: Date.now() + 25_000,
    });

    expect(result).toEqual({ error: expect.stringContaining("אינו זמין באינסטגרם") });
    await expect(fs.stat(out)).rejects.toThrow();
    await expect(fs.stat(`${out}.json`)).rejects.toThrow();
  }, 40_000);

  it("leaves no image behind when the capture is cancelled after writing one", async () => {
    const out = path.join(profileDir, "shot.png");
    const stubbornWriter = path.join(workDir, "stubborn-capture.mjs");
    await fs.writeFile(stubbornWriter, `import fs from "node:fs";
const out = process.argv[4];
fs.writeFileSync(out, "png");
fs.writeFileSync(process.env.FAKE_CAPTURE_FIXTURE, JSON.stringify({
  capturePid: process.pid,
  argv: process.argv.slice(2),
  startedAt: Date.now(),
}));
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`);
    process.env.CAMPAIGN_COUNCIL_IG_SHOT_PATH = stubbornWriter;
    const controller = new AbortController();

    const capture = runInstagramCapture({
      endpoint: "http://127.0.0.1:9",
      handle: "acme.studio",
      out,
      cwd: process.cwd(),
      signal: controller.signal,
      deadline: Date.now() + 25_000,
    });
    const fixture = await waitForCaptureFixture();
    controller.abort();

    await expect(capture).rejects.toThrow(/בוטל/);

    expect(await waitUntil(() => !alive(fixture.capturePid))).toBe(true);
    // Deleted only after the process closed: nothing was still writing.
    await expect(fs.stat(out)).rejects.toThrow();
  }, 40_000);

  it("carries the follower count from the sidecar the capture wrote", async () => {
    const out = path.join(profileDir, "shot.png");
    const sidecarWriter = path.join(workDir, "sidecar-capture.mjs");
    await fs.writeFile(sidecarWriter, `import fs from "node:fs";
const out = process.argv[4];
fs.writeFileSync(out, "png");
fs.writeFileSync(out + ".json", JSON.stringify({
  handle: process.argv[3],
  followers: "12.3K",
  followersRaw: "12.3K עוקבים",
  capturedAt: new Date().toISOString(),
}));
`);
    process.env.CAMPAIGN_COUNCIL_IG_SHOT_PATH = sidecarWriter;

    const result = await runInstagramCapture({
      endpoint: "http://127.0.0.1:9",
      handle: "acme.studio",
      out,
      cwd: process.cwd(),
      deadline: Date.now() + 25_000,
    });

    expect(result).toEqual({ followers: "12.3K", followersRaw: "12.3K עוקבים" });
  }, 40_000);

  it("settles on the close event, not on the deadline timer, when the capture ignores SIGTERM", async () => {
    process.env.CAMPAIGN_COUNCIL_IG_SHOT_PATH = fakeCapture;
    // Comfortably longer than a Node start under load, so the capture always
    // gets to publish its PID before the deadline bites.
    const deadlineIn = 3_000;
    const startedAt = Date.now();

    const capture = runInstagramCapture({
      endpoint: "http://127.0.0.1:9",
      handle: "acme",
      out: path.join(profileDir, "shot.png"),
      cwd: process.cwd(),
      deadline: Date.now() + deadlineIn,
    });
    const fixture = await waitForCaptureFixture();

    await expect(capture).rejects.toThrow(/חרג מהזמן/);
    const settledAfter = Date.now() - startedAt;

    // The process refuses SIGTERM, so only the supervisor's KILL escalation can
    // end it: settling on the timer alone would have returned around 300 ms.
    expect(settledAfter).toBeGreaterThan(deadlineIn + 400);
    expect(await waitUntil(() => !alive(fixture.capturePid))).toBe(true);
    expect(liveTrackedChildren()).toEqual([]);
  }, 40_000);

  it("terminates and reaps a cancelled capture that ignores SIGTERM", async () => {
    process.env.CAMPAIGN_COUNCIL_IG_SHOT_PATH = fakeCapture;
    const controller = new AbortController();

    const capture = runInstagramCapture({
      endpoint: "http://127.0.0.1:9",
      handle: "acme",
      out: path.join(profileDir, "shot.png"),
      cwd: process.cwd(),
      signal: controller.signal,
      deadline: Date.now() + 25_000,
    });
    const fixture = await waitForCaptureFixture();
    const abortedAt = Date.now();
    controller.abort();

    await expect(capture).rejects.toThrow(/בוטל/);

    expect(Date.now() - abortedAt).toBeGreaterThan(400);
    expect(await waitUntil(() => !alive(fixture.capturePid))).toBe(true);
    expect(liveTrackedChildren()).toEqual([]);
  }, 40_000);

  it("passes the endpoint, handle and output path to the capture process", async () => {
    process.env.CAMPAIGN_COUNCIL_IG_SHOT_PATH = fakeCapture;
    const out = path.join(profileDir, "shot.png");

    const capture = runInstagramCapture({
      endpoint: "http://127.0.0.1:65123",
      handle: "acme",
      out,
      cwd: process.cwd(),
      deadline: Date.now() + 3_000,
    });
    const fixture = await waitForCaptureFixture();

    await expect(capture).rejects.toThrow();
    expect(fixture.argv).toEqual(["http://127.0.0.1:65123", "acme", out]);
    expect(igShotScriptPath()).toBe(fakeCapture);
  }, 40_000);

  it("refuses an already-cancelled run before starting anything", async () => {
    await expect(runInstagramCapture({
      endpoint: "http://127.0.0.1:1",
      handle: "acme",
      out: path.join(profileDir, "shot.png"),
      cwd: process.cwd(),
      signal: AbortSignal.abort(),
      deadline: Date.now() + 25_000,
    })).rejects.toThrow(/בוטל/);
  });
});

describe("captureInstagramProof end to end, under real supervisors", () => {
  async function newRunDir(): Promise<string> {
    return fs.mkdtemp(path.join(workDir, "run-"));
  }

  it("reports a failed capture only after the browser, the capture and the profile are gone", async () => {
    // The real ig_shot.mjs runs here and fails against the fake CDP endpoint.
    const runDir = await newRunDir();

    const result = await captureInstagramProof({
      runDir,
      handle: "acme",
      landingWorkspace: process.cwd(),
    });

    expect("error" in result).toBe(true);
    await expectTreeDead(await readFixture());
    expect(await ownedProfiles()).toEqual([]);
    expect(liveTrackedChildren()).toEqual([]);
  }, 90_000);

  it("rethrows a cancellation only after the browser, the capture and the profile are gone", async () => {
    process.env.CAMPAIGN_COUNCIL_IG_SHOT_PATH = fakeCapture;
    const runDir = await newRunDir();
    const controller = new AbortController();

    const proof = captureInstagramProof({
      runDir,
      handle: "acme",
      landingWorkspace: process.cwd(),
      signal: controller.signal,
    });
    const capture = await waitForCaptureFixture();
    controller.abort();

    await expect(proof).rejects.toThrow(/בוטל/);

    expect(await waitUntil(() => !alive(capture.capturePid)), "the capture is still alive").toBe(true);
    await expectTreeDead(await readFixture());
    expect(await ownedProfiles()).toEqual([]);
    expect(liveTrackedChildren()).toEqual([]);
  }, 90_000);

  it("reports a timed-out capture only after the browser, the capture and the profile are gone", async () => {
    process.env.CAMPAIGN_COUNCIL_IG_SHOT_PATH = fakeCapture;
    process.env.CAMPAIGN_COUNCIL_LIVE_PROOF_TIMEOUT_MS = "6000";
    const runDir = await newRunDir();

    const result = await captureInstagramProof({
      runDir,
      handle: "acme",
      landingWorkspace: process.cwd(),
    });
    const capture = await readCaptureFixture();

    expect(result).toEqual({ error: expect.stringContaining("חרג מהזמן") });
    expect(capture.capturePid).toBeGreaterThan(0);
    expect(await waitUntil(() => !alive(capture.capturePid)), "the capture is still alive").toBe(true);
    await expectTreeDead(await readFixture());
    expect(await ownedProfiles()).toEqual([]);
    expect(liveTrackedChildren()).toEqual([]);
  }, 90_000);
});

describe("the shape of the owned launch", () => {
  it("spawns Chrome through the process-tree supervisor with the IPC slot, never through a browser library", async () => {
    const source = await fs.readFile(path.join(process.cwd(), "orchestrator", "liveProofBrowser.ts"), "utf8");

    expect(source).toContain("supervisedProcessTreeLaunch");
    expect(source).toContain('"ipc"');
    expect(source).toContain("supervisedProcessTree: true");
    expect(source).not.toContain("open -a");
    expect(source).not.toContain("chromium.launch");
    expect(source).not.toContain("launchPersistentContext");
    expect(source).not.toContain("detached: true");
  });

  it("keeps the vendored capture script connect-only, with no browser or profile ownership", async () => {
    const source = await fs.readFile(VENDORED_SCRIPT, "utf8");

    expect(source).toContain("connectOverCDP");
    expect(source).not.toContain("launchPersistentContext");
    expect(source).not.toContain("chromium.launch");
    expect(source).not.toContain("copyFileSync");
    expect(source).not.toContain("mkdtempSync");
    expect(source).not.toContain("rmSync");
    expect(source).not.toContain("newContext(");
  });
});

/**
 * The page the fake browser renders. The fake playwright module installs a
 * minimal DOM from it and runs the script's own page functions against it, so
 * the extraction and the validation under test are the real ones.
 */
interface PageFixture {
  title: string;
  text: string;
  url?: string;
  headings?: string[];
  /** Whether the page carries a role="dialog" overlay, like a login modal. */
  dialog?: boolean;
  /** The text inside that overlay, which the body text does not carry. */
  dialogText?: string;
  /** href of link[rel="canonical"], the profile URL Instagram declares. */
  canonical?: string;
  /** content of meta[property="og:url"], the same URL for social cards. */
  ogUrl?: string;
  /** A login form, either as a form element or as the username and password pair. */
  loginForm?: "form" | "inputs";
  /**
   * A sheet sitting over the follower count, like the "save your login details"
   * prompt that covered the profile in run 2026-09-16.
   */
  overlay?: { position?: string; label?: string; persistent?: boolean };
  /** The count is in the DOM but scrolled out of the rendered viewport. */
  countOutOfView?: boolean;
}

const PROFILE_PAGE: PageFixture = {
  title: "acme.studio (@acme.studio) - Instagram",
  text: "acme.studio\n412 פוסטים\n12.3K עוקבים\n180 עוקב אחרי\nסטודיו לעיצוב\n",
  url: "https://www.instagram.com/acme.studio/",
};

const FAKE_PLAYWRIGHT = `
import fs from "node:fs";
const fixture = JSON.parse(process.env.CAPTURE_PAGE);
const calls = [];
// A minimal DOM, so the script's own page functions run here unchanged.
const attributed = (attrs) => ({ getAttribute: (name) => (name in attrs ? attrs[name] : null) });
const box = (left, top, width, height) => ({
  left, top, width, height, right: left + width, bottom: top + height,
});
const makeNode = (name, props) => {
  const node = { name, innerText: "", position: "static", parentElement: null, removed: false, clicked: false };
  node.getBoundingClientRect = () => box(20, 200, 120, 20);
  node.contains = (other) => other === node;
  node.remove = () => { node.removed = true; calls.push(["remove", name]); };
  node.click = () => { node.clicked = true; calls.push(["click", name]); };
  return Object.assign(node, props || {});
};

const dialogNodes = (fixture.dialog || fixture.dialogText)
  ? [makeNode("dialog", {
      innerText: fixture.dialogText || "",
      remove: () => { dialogNodes[0].removed = true; calls.push(["remove-dialog"]); },
    })]
  : [];

// The element the follower count really lives in, next to the body text the
// classification reads. elementFromPoint answers with it, unless a sheet is in
// the way.
const FOLLOWERS = /(\\d[\\d.,]*)[\\s\u200e\u200f]*(K|M|אלף|אלפים|מיליון)?[\\s\u200e\u200f]*(?:עוקבים|followers)/i;
const countMatch = (fixture.text || "").match(FOLLOWERS);
const countNode = countMatch
  ? makeNode("count", {
      innerText: countMatch[0],
      getBoundingClientRect: () => (fixture.countOutOfView ? box(20, 1400, 120, 20) : box(20, 200, 120, 20)),
    })
  : null;

const overlayNode = fixture.overlay
  ? makeNode("overlay", { position: fixture.overlay.position || "fixed" })
  : null;
const buttonNodes = (fixture.overlay && fixture.overlay.label)
  ? [makeNode("dismiss", {
      innerText: " " + fixture.overlay.label + " ",
      click: () => { overlayNode.clicked = true; calls.push(["click-dismiss"]); },
    })]
  : [];

const bodyNode = makeNode("body", { innerText: fixture.text, style: {} });
if (countNode) countNode.parentElement = bodyNode;
if (overlayNode) overlayNode.parentElement = bodyNode;

globalThis.document = {
  title: fixture.title,
  body: bodyNode,
  documentElement: makeNode("html"),
  querySelectorAll: (selector) => {
    if (selector.includes("h1")) return (fixture.headings || []).map((heading) => ({ innerText: heading }));
    // A login modal is part of what the page says: removing it before the page
    // is classified is what turned a logged-out wall into a saved "proof".
    if (selector.includes("dialog")) return dialogNodes.filter((node) => !node.removed);
    if (selector.includes("canonical")) return fixture.canonical ? [attributed({ href: fixture.canonical })] : [];
    if (selector.includes("og:url")) return fixture.ogUrl ? [attributed({ content: fixture.ogUrl })] : [];
    if (selector.includes("username") || selector.includes("password")) {
      return fixture.loginForm === "inputs" ? [attributed({})] : [];
    }
    if (selector.includes("form")) return fixture.loginForm === "form" ? [attributed({})] : [];
    if (selector.includes("button")) return buttonNodes.filter((node) => !node.removed);
    if (selector.includes("span")) return countNode ? [countNode] : [];
    return [];
  },
  querySelector: (selector) => globalThis.document.querySelectorAll(selector)[0] || null,
  elementFromPoint: () => {
    const covering = overlayNode
      && !overlayNode.clicked
      && ((fixture.overlay && fixture.overlay.persistent) || !overlayNode.removed);
    return covering ? overlayNode : countNode;
  },
};
globalThis.window = {
  innerWidth: 430,
  innerHeight: 932,
  getComputedStyle: (el) => ({ position: el.position }),
};
globalThis.location = { href: fixture.url || "https://www.instagram.com/" };
const page = {
  setViewportSize: (size) => { calls.push(["setViewportSize", size]); },
  goto: (url) => { calls.push(["goto", url]); },
  waitForTimeout: () => {},
  evaluate: (fn, arg) => fn(arg),
  screenshot: ({ path }) => { calls.push(["screenshot", path]); fs.writeFileSync(path, "png"); },
};
const session = { send: (method, params) => { calls.push([method, params]); } };
const context = {
  pages: () => [page],
  newPage: () => { calls.push(["newPage"]); return page; },
  newCDPSession: (target) => { calls.push(["newCDPSession", target === page]); return session; },
};
const browser = {
  contexts: () => { calls.push(["contexts"]); return [context]; },
  // A fresh context would have no session cookies: asking for one is a failure.
  newContext: () => { throw new Error("newContext must never be called"); },
  close: () => { calls.push(["close"]); fs.writeFileSync(process.env.CAPTURE_LOG, JSON.stringify(calls)); },
};
export const chromium = {
  connectOverCDP: (endpoint) => { calls.push(["connectOverCDP", endpoint]); return browser; },
};
export const devices = { "iPhone 14 Pro Max": { userAgent: "fake-iphone-ua" } };
`;

interface CaptureRun {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  out: string;
  calls: [string, unknown][];
  png: boolean;
  sidecar: { handle: string; followers: string; followersRaw: string; obstructionCleared: number; capturedAt: string } | undefined;
}

/** Run the real vendored script against one page fixture, in its own directory. */
async function runCaptureScript(fixture: PageFixture, handle = "acme.studio"): Promise<CaptureRun> {
  const fixtureDir = await fs.mkdtemp(path.join(workDir, "capture-fixture-"));
  const moduleDir = path.join(fixtureDir, "node_modules", "playwright");
  await fs.mkdir(moduleDir, { recursive: true });
  await fs.writeFile(
    path.join(moduleDir, "package.json"),
    JSON.stringify({ name: "playwright", version: "0.0.0-fake", type: "module", main: "index.mjs" }),
  );
  await fs.writeFile(path.join(moduleDir, "index.mjs"), FAKE_PLAYWRIGHT);
  const log = path.join(fixtureDir, "log.json");
  const out = path.join(fixtureDir, "shot.png");
  // The real script and its page half, run where a fake playwright resolves:
  // same source, injected dependency.
  await fs.copyFile(VENDORED_SCRIPT, path.join(fixtureDir, "ig_shot.mjs"));
  await fs.copyFile(VENDORED_OVERLAY, path.join(fixtureDir, "igOverlay.mjs"));

  let stdout = "";
  let stderr = "";
  const exitCode = await new Promise<number | null>((resolve) => {
    const child = spawn(process.execPath, [path.join(fixtureDir, "ig_shot.mjs"), "http://127.0.0.1:9", handle, out], {
      cwd: fixtureDir,
      env: { ...process.env, CAPTURE_LOG: log, CAPTURE_PAGE: JSON.stringify(fixture) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("close", (code) => resolve(code));
  });

  const calls = JSON.parse(await fs.readFile(log, "utf8").catch(() => "[]")) as [string, unknown][];
  const png = await fs.stat(out).then((s) => s.isFile() && s.size > 0).catch(() => false);
  const sidecar = await fs.readFile(`${out}.json`, "utf8").then((raw) => JSON.parse(raw)).catch(() => undefined);
  return { exitCode, stdout, stderr, out, calls, png, sidecar };
}

describe("the capture script against a fake authenticated browser", () => {
  it("uses the default context of the connected browser and never asks for a fresh one", async () => {
    const run = await runCaptureScript(PROFILE_PAGE);

    expect(run.exitCode).toBe(0);
    const names = run.calls.map(([name]) => name);
    expect(names).toContain("connectOverCDP");
    expect(names).toContain("contexts");
    expect(names).toContain("Emulation.setDeviceMetricsOverride");
    expect(names).toContain("Emulation.setUserAgentOverride");
    // The CDP session and the screenshot are on the default context's own page.
    expect(run.calls.find(([name]) => name === "newCDPSession")?.[1]).toBe(true);
    expect(run.calls.find(([name]) => name === "goto")?.[1]).toBe("https://www.instagram.com/acme.studio/");
    expect(run.calls.find(([name]) => name === "screenshot")?.[1]).toBe(run.out);
    await expect(fs.stat(run.out)).resolves.toMatchObject({ size: 3 });
  }, 20_000);

  it("saves the screenshot and a sidecar with the follower count when the profile really rendered", async () => {
    const run = await runCaptureScript(PROFILE_PAGE);

    expect(run.exitCode).toBe(0);
    expect(run.png).toBe(true);
    expect(run.stdout).toContain(`saved ${run.out} followers: 12.3K`);
    expect(run.sidecar).toMatchObject({
      handle: "acme.studio",
      followers: "12.3K",
      followersRaw: "12.3K עוקבים",
    });
    expect(Date.parse(run.sidecar!.capturedAt)).toBeGreaterThan(0);
  }, 20_000);

  it("refuses the Hebrew page-not-available screen, saves nothing and exits 2", async () => {
    const run = await runCaptureScript({
      title: "Instagram",
      text: "מצטערים, דף זה אינו זמין.\nייתכן שהקישור שפתחת שגוי או שהדף הוסר.",
    });

    expect(run.exitCode).toBe(2);
    expect(run.png).toBe(false);
    expect(run.sidecar).toBeUndefined();
    expect(run.calls.some(([name]) => name === "screenshot")).toBe(false);
    expect(run.stderr).toContain("אינו זמין");
  }, 20_000);

  it("refuses the English page-not-available screen and exits 2", async () => {
    const run = await runCaptureScript({
      title: "Instagram",
      text: "Sorry, this page isn't available.\nThe link you followed may be broken.",
    });

    expect(run.exitCode).toBe(2);
    expect(run.png).toBe(false);
  }, 20_000);

  it("refuses a login wall, saves nothing and exits 3", async () => {
    const run = await runCaptureScript({
      title: "Instagram",
      text: "התחבר\nמספר טלפון, שם משתמש או כתובת אימייל\nסיסמה\nשכחת את הסיסמה?",
      headings: ["התחבר"],
    });

    expect(run.exitCode).toBe(3);
    expect(run.png).toBe(false);
    expect(run.sidecar).toBeUndefined();
    expect(run.stderr).toContain("התחברות");
  }, 20_000);

  it("refuses a profile page with no readable follower count and exits 4", async () => {
    const run = await runCaptureScript({
      title: "acme.studio (@acme.studio) - Instagram",
      text: "acme.studio\nסטודיו לעיצוב\nעקוב\nשלח הודעה\n",
    });

    expect(run.exitCode).toBe(4);
    expect(run.png).toBe(false);
    expect(run.sidecar).toBeUndefined();
    expect(run.stderr).toContain("עוקבים");
  }, 20_000);

  it("refuses a rate-limit screen with its own exit code", async () => {
    const run = await runCaptureScript({
      title: "Instagram",
      text: "Please wait a few minutes before you try again.",
    });

    expect(run.exitCode).toBe(5);
    expect(run.png).toBe(false);
  }, 20_000);

  // A dead session is served as the profile page with the handle in the title
  // and the content behind a login modal. Reading the page only after that
  // modal was deleted is what made a logged-out wall pass as live proof.
  it("refuses a logged-out profile page, even with the handle in the title and a follower count", async () => {
    const run = await runCaptureScript({
      title: "acme.studio (@acme.studio) - Instagram",
      text: "acme.studio\n12.3K עוקבים\nהתחבר\nSign up\nCreate new account\n",
      url: "https://www.instagram.com/acme.studio/",
      dialog: true,
    });

    expect(run.exitCode).toBe(3);
    expect(run.png).toBe(false);
    expect(run.sidecar).toBeUndefined();
    // The dialog was never deleted: the page was classified as it was served.
    expect(run.calls.some(([name]) => name === "remove-dialog")).toBe(false);
    expect(run.calls.some(([name]) => name === "screenshot")).toBe(false);
  }, 20_000);

  it("refuses a Hebrew signed-out call to action on a profile page", async () => {
    const run = await runCaptureScript({
      title: "acme.studio (@acme.studio) - Instagram",
      text: "acme.studio\n12.3K עוקבים\nהירשם\nיש לך חשבון?\n",
      url: "https://www.instagram.com/acme.studio/",
      dialog: true,
    });

    expect(run.exitCode).toBe(3);
    expect(run.png).toBe(false);
  }, 20_000);

  it("refuses a redirect to the login page, which carries neither the handle nor a heading", async () => {
    const run = await runCaptureScript({
      title: "Instagram",
      text: "מספר טלפון, שם משתמש או כתובת אימייל\nסיסמה\n",
      url: "https://www.instagram.com/accounts/login/?next=%2Facme.studio%2F",
    });

    expect(run.exitCode).toBe(3);
    expect(run.png).toBe(false);
    expect(run.stderr).toContain("התחברות");
  }, 20_000);

  it("removes the dialogs only on the success path, right before the screenshot", async () => {
    const run = await runCaptureScript({ ...PROFILE_PAGE, dialog: true });

    expect(run.exitCode).toBe(0);
    const names = run.calls.map(([name]) => name);
    expect(names.indexOf("remove-dialog")).toBeGreaterThan(-1);
    expect(names.indexOf("remove-dialog")).toBeLessThan(names.indexOf("screenshot"));
  }, 20_000);

  // Instagram writes Hebrew counts as "12.3 אלף" and injects bidi marks between
  // the number and the word, so a K/M-only pattern reads a real profile as
  // having no follower count at all.
  it.each([
    ["12.3 אלף עוקבים", "12.3K"],
    ["1.2 מיליון עוקבים", "1.2M"],
    ["1,234 followers", "1,234"],
    ["5,371‏ עוקבים", "5,371"],
    ["48.9k followers", "48.9K"],
  ])("reads %s as %s", async (line, expected) => {
    const run = await runCaptureScript({
      title: "acme.studio (@acme.studio) - Instagram",
      text: `acme.studio\n412 פוסטים\n${line}\nסטודיו לעיצוב\n`,
      url: "https://www.instagram.com/acme.studio/",
    });

    expect(run.exitCode).toBe(0);
    expect(run.sidecar).toMatchObject({ followers: expected, followersRaw: line.trim() });
  }, 20_000);

  // The requested handle is the identity of the proof. Read as a substring, the
  // page of a neighbouring account passes as the account that was asked for.
  it.each(["acme.studio.other", "xacme.studio", "acme_studio"])(
    "refuses the page of %s when acme.studio was requested and exits 2",
    async (other) => {
      const run = await runCaptureScript({
        title: `${other} (@${other}) - Instagram`,
        text: `${other}\n412 פוסטים\n12.3K עוקבים\n@${other}\nסטודיו לעיצוב\n`,
        url: `https://www.instagram.com/${other}/`,
        canonical: `https://www.instagram.com/${other}/`,
        ogUrl: `https://www.instagram.com/${other}/`,
      }, "acme.studio");

      expect(run.exitCode).toBe(2);
      expect(run.png).toBe(false);
      expect(run.sidecar).toBeUndefined();
      expect(run.calls.some(([name]) => name === "screenshot")).toBe(false);
    },
    20_000,
  );

  it("identifies the profile by the og:url meta alone, whatever case it is written in", async () => {
    const run = await runCaptureScript({
      title: "Instagram",
      text: "412 פוסטים\n12.3K עוקבים\nסטודיו לעיצוב\n",
      url: "https://www.instagram.com/acme.studio/",
      ogUrl: "https://www.instagram.com/ACME.Studio/",
    });

    expect(run.exitCode).toBe(0);
    expect(run.sidecar).toMatchObject({ handle: "acme.studio", followers: "12.3K" });
  }, 20_000);

  it("identifies the profile by the canonical link alone", async () => {
    const run = await runCaptureScript({
      title: "Instagram",
      text: "412 פוסטים\n12.3K עוקבים\nסטודיו לעיצוב\n",
      url: "https://www.instagram.com/acme.studio/",
      canonical: "https://instagram.com/acme.studio/",
    });

    expect(run.exitCode).toBe(0);
    expect(run.sidecar).toMatchObject({ followers: "12.3K" });
  }, 20_000);

  // The URL a page declares for itself is the account it belongs to. A mention
  // of the requested handle in a bio or a partner credit is not identification
  // when the page itself says it is somebody else's.
  it("refuses a page whose canonical link names another account, mention or not, and exits 2", async () => {
    const run = await runCaptureScript({
      title: "acme.studio.other (@acme.studio.other) - Instagram",
      text: "acme.studio.other\n412 פוסטים\n12.3K עוקבים\nבשיתוף @acme.studio\n",
      url: "https://www.instagram.com/acme.studio.other/",
      canonical: "https://www.instagram.com/acme.studio.other/",
    }, "acme.studio");

    expect(run.exitCode).toBe(2);
    expect(run.png).toBe(false);
    expect(run.sidecar).toBeUndefined();
    expect(run.stderr).toContain("חשבון אחר");
  }, 20_000);

  it("accepts the profile whose canonical link matches, even when it credits another handle", async () => {
    const run = await runCaptureScript({
      title: "Instagram",
      text: "412 פוסטים\n12.3K עוקבים\nבשיתוף @other.brand\n",
      url: "https://www.instagram.com/acme.studio/",
      canonical: "https://www.instagram.com/acme.studio/",
    });

    expect(run.exitCode).toBe(0);
    expect(run.sidecar).toMatchObject({ handle: "acme.studio", followers: "12.3K" });
  }, 20_000);

  it("lets the title decide when the page declares no canonical link and no og:url", async () => {
    const run = await runCaptureScript({
      title: "acme.studio (@acme.studio) - Instagram",
      text: "412 פוסטים\n12.3K עוקבים\nסטודיו לעיצוב\n",
      url: "https://www.instagram.com/acme.studio/",
    });

    expect(run.exitCode).toBe(0);
    expect(run.sidecar).toMatchObject({ followers: "12.3K" });
  }, 20_000);

  // A live session renders dialogs of its own. Reading any "log in" wording in
  // them as a signed-out wall refuses a profile that is perfectly signed in.
  it("does not refuse a signed-in page whose dialog offers to switch accounts", async () => {
    const run = await runCaptureScript({
      ...PROFILE_PAGE,
      dialogText: "התחבר לחשבון אחר\nהמשך כ-acme.studio",
    });

    expect(run.exitCode).toBe(0);
    expect(run.png).toBe(true);
    expect(run.sidecar).toMatchObject({ followers: "12.3K" });
  }, 20_000);

  it("identifies the profile by an @handle mention that ends where the handle ends", async () => {
    const run = await runCaptureScript({
      title: "Instagram",
      text: "@acme.studio\n412 פוסטים\n12.3K עוקבים\n",
      url: "https://www.instagram.com/acme.studio/",
    });

    expect(run.exitCode).toBe(0);
    expect(run.sidecar).toMatchObject({ followers: "12.3K" });
  }, 20_000);

  // A signed-out page is not only a wording: it carries the login elements
  // themselves, and a page that carries them is not proof of a live session.
  it.each(["form", "inputs"] as const)(
    "refuses a page carrying a login %s, header or not, and exits 3",
    async (kind) => {
      const run = await runCaptureScript({
        title: "acme.studio (@acme.studio) - Instagram",
        text: "acme.studio\n12.3K עוקבים\nמספר טלפון, שם משתמש או כתובת אימייל\n",
        url: "https://www.instagram.com/acme.studio/",
        loginForm: kind,
      });

      expect(run.exitCode).toBe(3);
      expect(run.png).toBe(false);
      expect(run.sidecar).toBeUndefined();
      expect(run.calls.some(([name]) => name === "remove-dialog")).toBe(false);
    },
    20_000,
  );

  it("refuses a signed-out dialog whose call to action is not in the page text", async () => {
    const run = await runCaptureScript({
      title: "acme.studio (@acme.studio) - Instagram",
      text: "acme.studio\n412 פוסטים\n12.3K עוקבים\nסטודיו לעיצוב\n",
      url: "https://www.instagram.com/acme.studio/",
      dialogText: "צור חשבון חדש כדי לעקוב אחרי הפרופיל",
    });

    expect(run.exitCode).toBe(3);
    expect(run.png).toBe(false);
    expect(run.sidecar).toBeUndefined();
    expect(run.calls.some(([name]) => name === "remove-dialog")).toBe(false);
  }, 20_000);

  it("does not refuse a real profile whose bio happens to quote a failure screen", async () => {
    const run = await runCaptureScript({
      title: "acme.studio (@acme.studio) - Instagram",
      text: "acme.studio\n12.3K עוקבים\nTry Again Later? מצטערים, דף זה אינו זמין לא מפסיק אותנו\n",
      url: "https://www.instagram.com/acme.studio/",
    });

    expect(run.exitCode).toBe(0);
    expect(run.sidecar).toMatchObject({ followers: "12.3K" });
  }, 20_000);

  // Run 2026-09-16 filed a picture of the "לשמור את פרטי ההתחברות שלך?" sheet
  // as live proof: the count was read off the DOM behind it, and the sheet is
  // not a role="dialog", so nothing removed it.
  it.each(["לא עכשיו", "Not now", "Not Now"])(
    "clicks the sheet's %s button and photographs the profile behind it",
    async (label) => {
      const run = await runCaptureScript({
        ...PROFILE_PAGE,
        overlay: { position: "fixed", label },
      });

      expect(run.exitCode).toBe(0);
      expect(run.png).toBe(true);
      expect(run.calls.some(([name]) => name === "click-dismiss")).toBe(true);
      expect(run.sidecar).toMatchObject({ followers: "12.3K", obstructionCleared: 1 });
    },
    20_000,
  );

  it("removes a sheet that answers to no button, then takes the picture", async () => {
    const run = await runCaptureScript({ ...PROFILE_PAGE, overlay: { position: "fixed" } });

    expect(run.exitCode).toBe(0);
    expect(run.png).toBe(true);
    const names = run.calls.map(([name]) => name);
    expect(names.indexOf("remove")).toBeLessThan(names.indexOf("screenshot"));
    expect(run.sidecar).toMatchObject({ obstructionCleared: 1 });
  }, 20_000);

  it("records that nothing stood in the way when the profile was already clear", async () => {
    const run = await runCaptureScript(PROFILE_PAGE);

    expect(run.exitCode).toBe(0);
    expect(run.sidecar).toMatchObject({ obstructionCleared: 0 });
  }, 20_000);

  it("refuses with exit 6 and saves nothing when the pop-up will not go away", async () => {
    const run = await runCaptureScript({
      ...PROFILE_PAGE,
      overlay: { position: "fixed", persistent: true },
    });

    expect(run.exitCode).toBe(6);
    expect(run.png).toBe(false);
    expect(run.sidecar).toBeUndefined();
    expect(run.calls.some(([name]) => name === "screenshot")).toBe(false);
    expect(run.stderr).toContain("הפרופיל מוסתר על ידי חלון קופץ ולא צולם");
  }, 20_000);

  it("refuses with exit 6 when the count is in the DOM but outside the viewport", async () => {
    const run = await runCaptureScript({ ...PROFILE_PAGE, countOutOfView: true });

    expect(run.exitCode).toBe(6);
    expect(run.png).toBe(false);
    expect(run.calls.some(([name]) => name === "screenshot")).toBe(false);
  }, 20_000);
});
