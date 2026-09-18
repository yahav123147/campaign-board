// shoot.mjs — full-page screenshots of a URL at several widths.
// Usage: node scripts/shoot.mjs <url> <outDir> <label> [widths...]
// Prints one absolute file path per line. Exit 1 if nothing could be captured.
import { chromium } from "playwright";
import path from "node:path";
import fs from "node:fs/promises";
import {
  blockedRequestIsViolation,
  classifyBrowserRequest,
  parseHttpNavigationUrl,
} from "./browser-network-policy.mjs";

const NAVIGATION_TIMEOUT_MS = 90_000;
const NETWORK_IDLE_TIMEOUT_MS = 8_000;
const MAX_PAGE_HEIGHT_PX = 80_000;
const MAX_WIDTHS = 4;

const [url, outDir, label, ...ws] = process.argv.slice(2);
if (!url || !outDir || !label) {
  console.error("usage: shoot.mjs <url> <outDir> <label> [widths...]");
  process.exit(1);
}

let pageUrl;
try {
  pageUrl = parseHttpNavigationUrl(url);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
if (!/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(label)) {
  console.error("label must contain only letters, digits, dot, underscore, and hyphen");
  process.exit(1);
}
const widths = ws.length ? ws.map(Number) : [390, 1280];
if (
  widths.length > MAX_WIDTHS ||
  widths.some((width) => !Number.isSafeInteger(width) || width < 320 || width > 2_560)
) {
  console.error(`screenshot widths must be 320-2560px, with at most ${MAX_WIDTHS} widths`);
  process.exit(1);
}
await fs.mkdir(outDir, { recursive: true });

const browser = await chromium.launch({ args: ["--disable-background-networking"] });
const written = [];

for (const width of widths) {
  const ctx = await browser.newContext({
    viewport: { width, height: 900 },
    deviceScaleFactor: 1,
    serviceWorkers: "block",
    acceptDownloads: false,
  });
  const page = await ctx.newPage();
  try {
    const blocked = new Set();
    await page.route("**/*", async (route) => {
      const request = route.request();
      const decision = classifyBrowserRequest(request.url(), pageUrl, {
        method: request.method(),
      });
      if (decision.allowed) {
        await route.continue();
        return;
      }
      if (blockedRequestIsViolation(request.resourceType(), decision.reason)) {
        blocked.add(decision.reason);
      }
      await route.abort("blockedbyclient");
    });
    const response = await page.goto(pageUrl.href, {
      waitUntil: "domcontentloaded",
      timeout: NAVIGATION_TIMEOUT_MS,
    });
    if (!response || response.status() >= 400) {
      throw new Error(`navigation failed${response ? ` with HTTP ${response.status()}` : ""}`);
    }
    if (new URL(response.url()).origin !== pageUrl.origin) {
      throw new Error("navigation escaped the selected origin");
    }
    await page.waitForLoadState("networkidle", { timeout: NETWORK_IDLE_TIMEOUT_MS }).catch(() => {});
    if (blocked.size) {
      throw new Error(`blocked unsafe browser requests: ${[...blocked].join(", ")}`);
    }
    const initialHeight = await page.evaluate(() => Math.max(
      document.documentElement.scrollHeight,
      document.body?.scrollHeight ?? 0,
    ));
    if (initialHeight > MAX_PAGE_HEIGHT_PX) {
      throw new Error(`page is too tall to capture safely (${initialHeight}px)`);
    }
    // Scroll the whole page so reveal-on-scroll sections are actually painted.
    const finalHeight = await page.evaluate(async ({ maxHeight }) => {
      for (let y = 0; y <= Math.min(document.body.scrollHeight + 900, maxHeight); y += 400) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 40));
        if (document.body.scrollHeight > maxHeight) return document.body.scrollHeight;
      }
      window.scrollTo(0, 0);
      await new Promise((r) => setTimeout(r, 1500));
      return document.body.scrollHeight;
    }, { maxHeight: MAX_PAGE_HEIGHT_PX });
    if (finalHeight > MAX_PAGE_HEIGHT_PX) {
      throw new Error(`page grew too tall to capture safely (${finalHeight}px)`);
    }
    if (blocked.size) {
      throw new Error(`blocked unsafe browser requests: ${[...blocked].join(", ")}`);
    }
    const file = path.resolve(outDir, `${label}-${width}.png`);
    await page.screenshot({ path: file, fullPage: true });
    written.push(file);
    console.log(file);
  } catch (err) {
    console.error(`${width}px failed: ${err.message}`);
  } finally {
    await ctx.close();
  }
}

await browser.close();
process.exit(written.length ? 0 : 1);
