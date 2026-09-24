import fs from "node:fs";
import path from "node:path";

export const PLATFORM_ACCEPTANCE_FILE = "config/platform-acceptance.json";

/** Same contract as lib/platformAcceptance.mjs; the test asserts they agree. */
export function linuxLandingAccepted(): boolean {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(process.cwd(), PLATFORM_ACCEPTANCE_FILE), "utf8")) as { linuxLanding?: unknown };
    return raw?.linuxLanding === true;
  } catch {
    return false;
  }
}
