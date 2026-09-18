// Report which images a rendered page actually shows, separately per viewport width.
// Usage: node scripts/check-visible-images.mjs <http(s)://url>
// Stdout on success: {"390":[...],"1280":[...]}. Each item:
//   {kind:"img"|"background", url, loaded, visible, width, height, areaRatio}
// An image is visible only when, after clipping by every clipping ancestor, the
// viewport width and the document height, at least 24px x 24px AND 30% of its
// own box remain, and no ancestor hides it (display, visibility, opacity).
// Each image is judged while it intersects the viewport, after animations
// settle, and keeps its best verdict across the windows it was judged in. An
// image never judged in any window is reported as not visible.
import { chromium } from "playwright";
import { classifyBrowserRequest, parseHttpNavigationUrl } from "./browser-network-policy.mjs";

const NAVIGATION_TIMEOUT_MS = 90_000;
const NETWORK_IDLE_TIMEOUT_MS = 10_000;
const MAX_SCROLL_STEPS = 160;
const MAX_ITEMS = 2_000;
const MAX_ELEMENTS = 20_000;
const MAX_WINDOWS = 60;
const WINDOW_OVERLAP_PX = 100;
const SETTLE_POLL_MS = 50;
const SETTLE_MIN_MS = 200;
const SETTLE_MAX_MS = 1_500;
const MIN_VISIBLE_SIDE_PX = 24;
const MIN_VISIBLE_AREA_RATIO = 0.3;
const WIDTHS = [390, 1280];

const input = process.argv[2];
let browser;

try {
  if (!input) throw new Error("usage: check-visible-images.mjs <url>");
  const pageUrl = parseHttpNavigationUrl(input);
  browser = await chromium.launch({ args: ["--disable-background-networking"] });
  const report = {};

  for (const width of WIDTHS) {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
      deviceScaleFactor: 1,
      serviceWorkers: "block",
      acceptDownloads: false,
    });
    try {
      const page = await context.newPage();
      const imageStatuses = new Map();
      await page.route("**/*", async (route) => {
        const request = route.request();
        const decision = classifyBrowserRequest(request.url(), pageUrl, {
          method: request.method(),
          restrictToRoute: true,
        });
        if (decision.allowed) await route.continue();
        else await route.abort("blockedbyclient");
      });
      page.on("response", (response) => {
        if (response.request().resourceType() === "image") imageStatuses.set(response.url(), response.status());
      });

      const response = await page.goto(pageUrl.href, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
      if (!response) throw new Error(`navigation returned no response at ${width}px`);
      if (response.status() >= 400) throw new Error(`navigation returned HTTP ${response.status()} at ${width}px`);
      await page.waitForLoadState("networkidle", { timeout: NETWORK_IDLE_TIMEOUT_MS }).catch(() => {});

      await page.evaluate(async (maxSteps) => {
        const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        let stable = 0;
        let previous = 0;
        for (let step = 0; step < maxSteps && stable < 3; step += 1) {
          const height = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0);
          const bottom = Math.max(0, height - window.innerHeight);
          const nextY = Math.min(bottom, step * 500);
          window.scrollTo({ left: 0, top: nextY, behavior: "instant" });
          await pause(50);
          stable = nextY === bottom && height === previous ? stable + 1 : 0;
          previous = height;
        }
        window.scrollTo({ left: 0, top: 0, behavior: "instant" });
        await pause(300);
      }, MAX_SCROLL_STEPS);
      await page.waitForLoadState("networkidle", { timeout: NETWORK_IDLE_TIMEOUT_MS }).catch(() => {});

      // Every candidate is judged while it is in view: a reveal animation that
      // is not "once" fades an image back to opacity 0 as soon as it leaves the
      // viewport, so one measurement at the top of the page would read every
      // below-the-fold image as hidden. The page is stepped through in windows
      // of about one viewport height; each window waits for animations to
      // settle and then judges only the candidates that intersect it.
      const items = await page.evaluate(async ({ maxItems, maxElements, minSide, minRatio, maxWindows, windowOverlap, settle }) => {
        const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        let docHeight = 0;
        const clipsPaint = (style) => /\b(paint|strict|content)\b/.test(style.contain);

        // A rectangle cannot describe clip-path (inset(100%) keeps the full box),
        // so any clip-path on the element or an ancestor switches to hit-testing,
        // which Chromium clips exactly.
        const hasClipPath = (element) => {
          for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
            if (getComputedStyle(node).clipPath !== "none") return true;
          }
          return false;
        };

        // Share of sample points inside the already rectangle-clipped box (page
        // coordinates) at which the element is hit. pointer-events is forced on
        // for the duration so decorative images still hit-test, then restored.
        const hitTestRatio = (element, box) => {
          const chain = [];
          for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
            chain.push([node, node.style.getPropertyValue("pointer-events"), node.style.getPropertyPriority("pointer-events")]);
            node.style.setProperty("pointer-events", "auto", "important");
          }
          const startX = window.scrollX;
          const startY = window.scrollY;
          const samples = 10;
          let hits = 0;
          try {
            for (let row = 0; row < samples; row += 1) {
              const pageY = box.top + ((row + 0.5) * box.height) / samples;
              window.scrollTo({ left: startX, top: Math.max(0, pageY - window.innerHeight / 2), behavior: "instant" });
              const viewportY = pageY - window.scrollY;
              for (let column = 0; column < samples; column += 1) {
                const x = box.left + ((column + 0.5) * box.width) / samples;
                if (document.elementsFromPoint(x, viewportY).includes(element)) hits += 1;
              }
            }
          } finally {
            window.scrollTo({ left: startX, top: startY, behavior: "instant" });
            for (const [node, value, priority] of chain) {
              if (value) node.style.setProperty("pointer-events", value, priority);
              else node.style.removeProperty("pointer-events");
            }
          }
          return hits / (samples * samples);
        };

        const visibleBox = (element) => {
          // checkVisibility catches content that keeps a normal layout box but is
          // withheld from rendering: a closed <details>, hidden="until-found", and
          // content-visibility:hidden ancestors. The manual ancestor loop below
          // still runs as well, for display/visibility/opacity it may not cover.
          if (!element.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return null;
          const rect = element.getBoundingClientRect();
          const fullArea = Math.max(0, rect.width) * Math.max(0, rect.height);
          let left = rect.left;
          let right = rect.right;
          let top = rect.top + window.scrollY;
          let bottom = rect.bottom + window.scrollY;
          for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
            const style = getComputedStyle(node);
            if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return null;
            if (Number.parseFloat(style.opacity) === 0) return null;
            if (node === element || node === document.body || node === document.documentElement) continue;
            const clipX = style.overflowX !== "visible" || clipsPaint(style);
            const clipY = style.overflowY !== "visible" || clipsPaint(style);
            if (!clipX && !clipY) continue;
            const box = node.getBoundingClientRect();
            if (clipX) {
              left = Math.max(left, box.left);
              right = Math.min(right, box.right);
            }
            if (clipY) {
              top = Math.max(top, box.top + window.scrollY);
              bottom = Math.min(bottom, box.bottom + window.scrollY);
            }
          }
          left = Math.max(left, 0);
          right = Math.min(right, window.innerWidth);
          top = Math.max(top, 0);
          bottom = Math.min(bottom, docHeight);
          const width = Math.max(0, right - left);
          const height = Math.max(0, bottom - top);
          const result = { left, top, width, height, areaRatio: fullArea > 0 ? (width * height) / fullArea : 0 };
          if (width > 0 && height > 0 && hasClipPath(element)) {
            result.areaRatio *= hitTestRatio(element, result);
          }
          return result;
        };

        const judge = (kind, url, element, loaded) => {
          const box = visibleBox(element);
          return {
            kind,
            url,
            loaded,
            visible: Boolean(box && box.width >= minSide && box.height >= minSide && box.areaRatio >= minRatio),
            width: Math.round(box?.width ?? 0),
            height: Math.round(box?.height ?? 0),
            areaRatio: Math.round((box?.areaRatio ?? 0) * 1000) / 1000,
          };
        };

        // Candidate order is first discovery; one record per element and url.
        const records = [];
        const byElement = new Map();
        const recordFor = (kind, url, element, loaded) => {
          let urls = byElement.get(element);
          if (!urls) {
            urls = new Map();
            byElement.set(element, urls);
          }
          let record = urls.get(url);
          if (!record) {
            if (records.length >= maxItems) return null;
            // Fail-closed until the candidate is judged inside a window.
            record = { kind, url, loaded, visible: false, width: 0, height: 0, areaRatio: 0, judged: false };
            urls.set(url, record);
            records.push(record);
          }
          return record;
        };
        const better = (next, current) => {
          if (!current.judged) return true;
          if (next.areaRatio !== current.areaRatio) return next.areaRatio > current.areaRatio;
          if (next.visible !== current.visible) return next.visible;
          return next.loaded === true && current.loaded !== true;
        };
        const candidates = function* () {
          for (const image of document.querySelectorAll("img")) {
            if (image.currentSrc) yield ["img", image.currentSrc, image, image.complete && image.naturalWidth > 0];
          }
          const urlPattern = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"']*))\s*\)/g;
          for (const element of Array.from(document.querySelectorAll("body *")).slice(0, maxElements)) {
            const value = getComputedStyle(element).backgroundImage;
            if (!value || value === "none") continue;
            for (const match of value.matchAll(urlPattern)) {
              const raw = (match[1] ?? match[2] ?? match[3] ?? "").trim();
              if (raw) yield ["background", new URL(raw, document.baseURI).href, element, null];
            }
          }
        };
        const intersectsViewport = (element) => {
          const rect = element.getBoundingClientRect();
          return rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth;
        };
        // Finite animations only: an infinite one (a spinner, a pulse) never
        // settles and says nothing about whether a reveal has finished.
        const animationsRunning = () => document.getAnimations().some((animation) => {
          if (animation.playState !== "running") return false;
          const end = animation.effect?.getComputedTiming?.().endTime;
          return typeof end !== "number" || Number.isFinite(end);
        });
        const waitForAnimations = async () => {
          const startedAt = performance.now();
          let quiet = 0;
          for (;;) {
            await pause(settle.pollMs);
            quiet = animationsRunning() ? 0 : quiet + 1;
            const elapsed = performance.now() - startedAt;
            if (elapsed >= settle.maxMs) return;
            if (quiet >= 2 && elapsed >= settle.minMs) return;
          }
        };

        let y = 0;
        for (let step = 0; step < maxWindows; step += 1) {
          docHeight = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0);
          const bottom = Math.max(0, docHeight - window.innerHeight);
          const top = Math.min(y, bottom);
          window.scrollTo({ left: 0, top, behavior: "instant" });
          await waitForAnimations();
          // Judge the whole window synchronously, so no observer callback or
          // transition can change the page between two candidates.
          docHeight = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0);
          for (const [kind, url, element, loaded] of candidates()) {
            const record = recordFor(kind, url, element, loaded);
            if (!record || !intersectsViewport(element)) continue;
            const verdict = judge(kind, url, element, loaded);
            if (better(verdict, record)) Object.assign(record, verdict, { judged: true });
          }
          if (top >= bottom) break;
          // Consecutive windows overlap a little, so a small image on a window
          // edge still gets one window where a reveal with a negative
          // observer margin has fired.
          y = top + Math.max(100, window.innerHeight - windowOverlap);
        }
        window.scrollTo({ left: 0, top: 0, behavior: "instant" });
        return records.map(({ kind, url, loaded, visible, width, height, areaRatio }) => ({ kind, url, loaded, visible, width, height, areaRatio }));
      }, {
        maxItems: MAX_ITEMS,
        maxElements: MAX_ELEMENTS,
        minSide: MIN_VISIBLE_SIDE_PX,
        minRatio: MIN_VISIBLE_AREA_RATIO,
        maxWindows: MAX_WINDOWS,
        windowOverlap: WINDOW_OVERLAP_PX,
        settle: { pollMs: SETTLE_POLL_MS, minMs: SETTLE_MIN_MS, maxMs: SETTLE_MAX_MS },
      });

      report[String(width)] = items.map((item) => {
        if (item.kind !== "background") return item;
        const status = imageStatuses.get(item.url);
        return { ...item, loaded: typeof status === "number" && status >= 200 && status < 300 };
      });
    } finally {
      await context.close();
    }
  }

  process.stdout.write(`${JSON.stringify(report)}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${JSON.stringify({ error: message })}\n`);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
}
