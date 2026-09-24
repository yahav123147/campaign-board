import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PLATFORM_ACCEPTANCE_FILE = "config/platform-acceptance.json";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The one release switch for Linux/WSL2 landing execution. Three gates read
 * it (generated-code sandbox, Bash agents, configure-client --enable-landing)
 * so that opening support is one reviewed change, not three scattered ones.
 * Anything but the literal boolean true is closed.
 */
export function linuxLandingAccepted() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(root, PLATFORM_ACCEPTANCE_FILE), "utf8"));
    return raw?.linuxLanding === true;
  } catch {
    return false;
  }
}
