// The longest vertical stretch of a mobile page with no anchor, in screen heights.
// Usage: node scripts/measure-text-deserts.mjs <http(s)://url> [--calibration]
// Anchors (each at least 40px x 40px and not hidden): a loaded <img>, <picture>,
// <video>, form controls, a <button>, a block-level <a> that looks like an action
// button (a filled backgroundColor, or a gradient background-image on a box at
// most 1.5 screens tall), and an element whose background-image has url(...) when
// that element is at most 1.5 screens tall. A gradient used as a page background
// (any element taller than 1.5 screens) is never an anchor. --calibration lifts
// the route restriction so live pages can be measured; the board never passes it.
import { chromium } from "playwright";
import { classifyBrowserRequest, parseHttpNavigationUrl } from "./browser-network-policy.mjs";

const VIEWPORT = { width: 390, height: 844 };
const MIN_SIDE_PX = 40;
const MAX_BACKGROUND_SCREENS = 1.5;
const MAX_ELEMENTS = 20_000;

const input = process.argv[2];
const calibration = process.argv.includes("--calibration");
let browser;

try {
  if (!input) throw new Error("usage: measure-text-deserts.mjs <url> [--calibration]");
  const pageUrl = parseHttpNavigationUrl(input);
  browser = await chromium.launch({ args: ["--disable-background-networking"] });
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1, serviceWorkers: "block", acceptDownloads: false });
  const page = await context.newPage();
  await page.route("**/*", async (route) => {
    const request = route.request();
    const decision = classifyBrowserRequest(request.url(), pageUrl, { method: request.method(), restrictToRoute: !calibration });
    if (decision.allowed) await route.continue();
    else await route.abort("blockedbyclient");
  });
  const response = await page.goto(pageUrl.href, { waitUntil: "domcontentloaded", timeout: 90_000 });
  if (!response || response.status() >= 400) throw new Error(`navigation failed (${response?.status() ?? "no response"})`);
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
  await page.evaluate(async () => {
    const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const height = () => Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0);
    for (let y = 0; y < height(); y += 600) {
      window.scrollTo({ left: 0, top: y, behavior: "instant" });
      await pause(40);
    }
    window.scrollTo({ left: 0, top: 0, behavior: "instant" });
    await pause(300);
  });
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});

  const result = await page.evaluate(({ minSide, maxBackgroundScreens, maxElements }) => {
    const vh = window.innerHeight;
    const docHeight = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0);
    const shown = (element) => {
      for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.display === "none" || style.visibility === "hidden" || Number.parseFloat(style.opacity) === 0) return false;
      }
      return true;
    };
    const isGradient = (backgroundImage) => /(?:linear|radial|conic)-gradient\(/.test(backgroundImage);
    const spans = [];
    const add = (element) => {
      const rect = element.getBoundingClientRect();
      if (rect.width < minSide || rect.height < minSide || !shown(element)) return;
      spans.push([rect.top + window.scrollY, rect.bottom + window.scrollY]);
    };
    for (const image of document.querySelectorAll("img")) if (image.complete && image.naturalWidth > 0) add(image);
    for (const element of document.querySelectorAll("picture, video, input, select, textarea, button")) add(element);
    for (const link of document.querySelectorAll("a")) {
      const style = getComputedStyle(link);
      const block = style.display !== "inline";
      const filled = style.backgroundColor !== "rgba(0, 0, 0, 0)" && style.backgroundColor !== "transparent";
      const rect = link.getBoundingClientRect();
      const gradientButton = isGradient(style.backgroundImage) && rect.height <= maxBackgroundScreens * vh;
      if (block && (filled || gradientButton)) add(link);
    }
    for (const element of Array.from(document.querySelectorAll("body *")).slice(0, maxElements)) {
      const background = getComputedStyle(element).backgroundImage;
      if (!background || !background.includes("url(")) continue;
      if (element.getBoundingClientRect().height > maxBackgroundScreens * vh) continue;
      add(element);
    }
    spans.sort((a, b) => a[0] - b[0]);
    let covered = 0;
    let worst = 0;
    let at = 0;
    for (const [top, bottom] of spans) {
      if (top - covered > worst) {
        worst = top - covered;
        at = covered;
      }
      covered = Math.max(covered, bottom);
    }
    if (docHeight - covered > worst) {
      worst = docHeight - covered;
      at = covered;
    }
    const round = (value) => Math.round(value * 100) / 100;
    return { pageScreens: round(docHeight / vh), worstScreens: round(worst / vh), atScreen: round(at / vh) };
  }, { minSide: MIN_SIDE_PX, maxBackgroundScreens: MAX_BACKGROUND_SCREENS, maxElements: MAX_ELEMENTS });

  await context.close();
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${JSON.stringify({ error: message })}\n`);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
}
