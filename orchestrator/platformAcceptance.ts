import fs from "node:fs";
import path from "node:path";

export const PLATFORM_ACCEPTANCE_FILE = "config/platform-acceptance.json";

let accepted: boolean | undefined;

/**
 * Same contract as lib/platformAcceptance.mjs; the test asserts they agree.
 * Read once per process: the file is a release artefact, not a runtime
 * toggle, and this sits on every sandboxed launch and agent spawn.
 */
export function linuxLandingAccepted(): boolean {
  if (accepted === undefined) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(process.cwd(), PLATFORM_ACCEPTANCE_FILE), "utf8")) as { linuxLanding?: unknown };
      accepted = raw?.linuxLanding === true;
    } catch {
      accepted = false;
    }
  }
  return accepted;
}
