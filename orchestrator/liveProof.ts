import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HARVEST_DIR } from "./runStage1Harvest";
import { runInstagramCapture, startSupervisedChrome, type OwnedChrome } from "./liveProofBrowser";
import type { ClientProfile } from "@/config/clientProfile";

/** One screenshot, browser startup included. Shortened only by lifecycle tests. */
const CAPTURE_TIMEOUT_MS = 180_000;

function captureTimeoutMs(): number {
  const override = Number(process.env.CAMPAIGN_COUNCIL_LIVE_PROOF_TIMEOUT_MS);
  return Number.isFinite(override) && override > 0 ? override : CAPTURE_TIMEOUT_MS;
}
const HANDLE_RE = /^[A-Za-z0-9._]{2,30}$/;
const CHROME_PROFILE_DEFAULT = "Library/Application Support/Google/Chrome";
/** The only files the capture needs from the operator's Chrome profile. */
const SESSION_FILES = ["Default/Cookies", "Default/Network/Cookies"] as const;

/**
 * A live screenshot uses the operator's own browser session, so it is never
 * implicit: only a profile that declares the capability gets one.
 */
export function liveProofEnabled(profile: ClientProfile | undefined): boolean {
  return profile?.policies.capabilities.liveProof === true;
}

/**
 * Where the throwaway profile is created. Overridable so lifecycle tests can
 * own a directory of their own instead of sharing the system temp dir.
 */
export function profileParentDir(): string {
  return process.env.CAMPAIGN_COUNCIL_LIVE_PROOF_PROFILE_PARENT || os.tmpdir();
}

/** The operator's Chrome profile. Overridable so tests never read a real one. */
export function operatorChromeProfileDir(): string {
  return process.env.CAMPAIGN_COUNCIL_CHROME_PROFILE_DIR
    || path.join(os.homedir(), CHROME_PROFILE_DEFAULT);
}

/**
 * Copy the session into the throwaway profile: the decryption key ("Local
 * State") and the cookie databases, and nothing else. The child never learns
 * where the operator's profile lives.
 */
async function copyChromeSession(profileDir: string): Promise<void> {
  const source = operatorChromeProfileDir();
  await fs.mkdir(path.join(profileDir, "Default", "Network"), { recursive: true });
  await fs.copyFile(path.join(source, "Local State"), path.join(profileDir, "Local State"))
    .catch(() => {
      throw new Error("לא נמצא פרופיל כרום של המפעיל להעתקת הסשן");
    });
  for (const file of SESSION_FILES) {
    await fs.copyFile(path.join(source, file), path.join(profileDir, file)).catch(() => {
      // A profile can carry either cookie database, or an empty one.
    });
  }
}

export interface InstagramProofArgs {
  runDir: string;
  handle: string;
  landingWorkspace: string;
  signal?: AbortSignal;
}

/**
 * A proof is the image plus the count the capture validated on the page, so
 * whatever states the number later never has to guess it.
 */
export interface InstagramProofResult {
  file: string;
  followers?: string;
  followersRaw?: string;
}

/**
 * Capture a live Instagram profile into the run's harvest directory, next to
 * the files stage 1 harvested. The orchestrator owns this, not the asset
 * agent: the agent runs sandboxed with no access to the operator's browser
 * session, and a proof image is evidence, so it is produced under the same
 * ownership as the rest of the harvest.
 *
 * The lifecycle is owned end to end. This function creates the throwaway
 * profile and is the only thing that deletes it; the browser helper owns
 * Chrome and the capture process. Nothing is deleted before the close attempt
 * has settled, so a screenshot can never be taken against a profile that is
 * disappearing, and the profile is removed even when that close failed.
 *
 * The proof itself is optional: an operational failure comes back as {error}
 * so 5.2 can ask for a manual screenshot. A cancelled run rethrows after
 * cleanup, and a cleanup failure propagates rather than being downgraded to a
 * note in a prompt while an owned process is still alive.
 */
export async function captureInstagramProof(
  args: InstagramProofArgs,
): Promise<InstagramProofResult | { error: string }> {
  if (args.signal?.aborted) throw new Error("צילום האינסטגרם בוטל");
  if (!HANDLE_RE.test(args.handle)) return { error: `כינוי אינסטגרם לא תקין: ${args.handle}` };

  const deadline = Date.now() + captureTimeoutMs();
  const harvestRoot = path.join(args.runDir, HARVEST_DIR);
  const out = path.join(harvestRoot, `instagram-${args.handle}.png`);
  await fs.mkdir(harvestRoot, { recursive: true });

  const profileDir = await fs.mkdtemp(path.join(profileParentDir(), "council-live-proof-profile-"));
  let chrome: OwnedChrome | undefined;
  let failure: Error | undefined;
  let proof: { followers?: string; followersRaw?: string } | undefined;
  try {
    await fs.chmod(profileDir, 0o700);
    await copyChromeSession(profileDir);
    chrome = await startSupervisedChrome({ profileDir, signal: args.signal, deadline });
    const captured = await runInstagramCapture({
      endpoint: chrome.endpoint,
      handle: args.handle,
      out,
      cwd: args.landingWorkspace,
      signal: args.signal,
      deadline,
    });
    // A refused capture is still a failure of the proof, so it takes the same
    // path: cleanup first, then {error}. It is simply not a failure of the run.
    if (captured && "error" in captured) throw new Error(captured.error);
    proof = captured;
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  } finally {
    // Cleanup does not observe the signal: a cancelled run still has to leave
    // no browser and no profile behind, and a failure here is fatal.
    try {
      await chrome?.closeAndWait();
    } finally {
      // The profile holds the copied decryption key and cookie databases, so
      // it is removed even when the browser refused to close. A removal that
      // fails names the directory: it is the only thing the operator can act
      // on, and nothing else in the message points at it.
      await fs.rm(profileDir, { recursive: true, force: true }).catch((error) => {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`לא ניתן למחוק את פרופיל הביניים ${profileDir}: ${reason}`);
      });
    }
  }

  // Whatever went wrong, no image is left in the harvest: the asset agent reads
  // that directory, and 5.2 is about to tell it there is no live proof. An
  // unvalidated screenshot sitting there would be placed on the page anyway.
  if (args.signal?.aborted) {
    await removeProofFiles(out);
    throw failure ?? new Error("צילום האינסטגרם בוטל");
  }
  if (failure) {
    await removeProofFiles(out);
    return { error: failure.message };
  }
  const stat = await fs.stat(out).catch(() => undefined);
  if (!stat?.isFile() || stat.size === 0) {
    await removeProofFiles(out);
    return { error: "הצילום הסתיים בלי קובץ תמונה" };
  }
  return {
    file: out,
    ...(proof?.followers ? { followers: proof.followers, followersRaw: proof.followersRaw } : {}),
  };
}

/** The proof image and its sidecar. Removed together, and never half of a pair. */
async function removeProofFiles(out: string): Promise<void> {
  await fs.rm(out, { force: true }).catch(() => {});
  await fs.rm(`${out}.json`, { force: true }).catch(() => {});
}
