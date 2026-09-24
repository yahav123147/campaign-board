import fs from "node:fs/promises";
import { constants } from "node:fs";

export const GOOGLE_CHROME_MACOS_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

async function isExecutableFile(file) {
  try {
    const stat = await fs.stat(file);
    await fs.access(file, constants.R_OK | constants.X_OK);
    return stat.isFile();
  } catch {
    return false;
  }
}

/**
 * Local mockups need no signed-in browser. Reuse Chrome when installed, or the
 * Chromium installed by setup.sh. Return a binary path only: the existing
 * supervisor still owns launch and process-tree cleanup. Live Instagram
 * capture deliberately keeps its separate Chrome/session contract.
 *
 * @param {{ chromePath?: string, platform?: string, isExecutable?: (file: string) => Promise<boolean>, chromiumPath?: () => Promise<string> }=} options
 */
export async function mockupBrowserExecutablePath({
  chromePath = process.env.CAMPAIGN_COUNCIL_CHROME_PATH,
  platform = process.platform,
  isExecutable = isExecutableFile,
  chromiumPath = async () => (await import("playwright")).chromium.executablePath(),
} = {}) {
  if (chromePath) {
    if (await isExecutable(chromePath)) return chromePath;
    throw new Error("The configured CAMPAIGN_COUNCIL_CHROME_PATH is not executable.");
  }
  if (platform === "darwin" && await isExecutable(GOOGLE_CHROME_MACOS_PATH)) {
    return GOOGLE_CHROME_MACOS_PATH;
  }
  const chromium = await chromiumPath();
  if (await isExecutable(chromium)) return chromium;
  throw new Error("No mockup browser is installed. Run npx playwright install chromium.");
}
