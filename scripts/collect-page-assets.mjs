// Collect every image-like asset a rendered page actually uses.
// Usage: node scripts/collect-page-assets.mjs <http(s)://url>
// Stdout is always either a JSON array on success or empty on failure.
import { chromium } from "playwright";
import {
  blockedRequestIsViolation,
  classifyBrowserRequest,
  parseHttpNavigationUrl,
  violationSentinel,
} from "./browser-network-policy.mjs";

const NAVIGATION_TIMEOUT_MS = 90_000;
const NETWORK_IDLE_TIMEOUT_MS = 10_000;
const MAX_URLS = 2_500;
const MAX_URL_LENGTH = 8_192;
const MAX_ELEMENTS = 20_000;
const MAX_SCROLL_STEPS = 160;
const MAX_PAGE_HEIGHT_PX = 80_000;
const VIEWPORT_WIDTHS = [390, 1280];

const input = process.argv[2];
let browser;

try {
  if (!input) throw new Error("usage: collect-page-assets.mjs <url>");
  const pageUrl = parseHttpNavigationUrl(input);
  const requestedAssets = new Set();
  const renderedAssets = new Set();
  const violations = new Set();
  const markViolation = (reason, detail = "") => {
    const suffix = detail ? `?${detail}` : "";
    violations.add(`invalid:asset-collector-${reason}${suffix}`);
  };

  browser = await chromium.launch({ args: ["--disable-background-networking"] });
  for (const viewportWidth of VIEWPORT_WIDTHS) {
    const context = await browser.newContext({
      viewport: { width: viewportWidth, height: 900 },
      deviceScaleFactor: 1,
      serviceWorkers: "block",
      acceptDownloads: false,
    });
    try {
      const page = await context.newPage();

      await page.route("**/*", async (route) => {
        const request = route.request();
        const decision = classifyBrowserRequest(request.url(), pageUrl, {
          method: request.method(),
          restrictToRoute: true,
        });
        if (decision.allowed) {
          await route.continue();
          return;
        }
        if (blockedRequestIsViolation(request.resourceType(), decision.reason)) {
          violations.add(violationSentinel("asset-collector", decision.reason));
        }
        await route.abort("blockedbyclient");
      });

      page.on("request", (request) => {
        const resourceType = request.resourceType();
        if (resourceType !== "image" && resourceType !== "media") return;
        const requestUrl = request.url();
        if (requestUrl.length > MAX_URL_LENGTH) {
          markViolation("oversized-request", `length=${requestUrl.length}`);
        } else if (requestedAssets.size >= MAX_URLS) {
          markViolation("truncated", "reason=max-requests");
        } else {
          requestedAssets.add(requestUrl);
        }
      });

      const response = await page.goto(pageUrl.href, {
        waitUntil: "domcontentloaded",
        timeout: NAVIGATION_TIMEOUT_MS,
      });
      if (!response) throw new Error(`navigation returned no response at ${viewportWidth}px`);
      if (response.status() >= 400) {
        throw new Error(`navigation returned HTTP ${response.status()} at ${viewportWidth}px`);
      }
      if (new URL(response.url()).origin !== pageUrl.origin) {
        throw new Error(`navigation escaped the selected origin at ${viewportWidth}px`);
      }

      const initialHeight = await page.evaluate(() => Math.max(
        document.documentElement.scrollHeight,
        document.body?.scrollHeight ?? 0,
      ));
      if (initialHeight > MAX_PAGE_HEIGHT_PX) {
        markViolation("oversized-page", `height=${initialHeight}`);
      }

      // A permanently busy page should not prevent collection. This wait is
      // only a short opportunity for ordinary lazy scripts and styles to settle.
      await page.waitForLoadState("networkidle", { timeout: NETWORK_IDLE_TIMEOUT_MS }).catch(() => {});

      const scrollResult = await page.evaluate(
        async ({ maxScrollSteps, maxPageHeight }) => {
          const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
          let stableBottoms = 0;
          let previousHeight = 0;
          let reachedStableBottom = false;

          for (let step = 0; step < maxScrollSteps; step += 1) {
            const height = Math.max(
              document.documentElement.scrollHeight,
              document.body?.scrollHeight ?? 0,
            );
            if (height > maxPageHeight) {
              return { reachedStableBottom: false, oversizedHeight: height };
            }
            const bottom = Math.max(0, height - window.innerHeight);
            const nextY = Math.min(bottom, step * 500);
            window.scrollTo(0, nextY);
            await pause(50);

            if (nextY === bottom && height === previousHeight) stableBottoms += 1;
            else stableBottoms = 0;
            previousHeight = height;
            if (stableBottoms >= 3) {
              reachedStableBottom = true;
              break;
            }
          }

          window.scrollTo(0, 0);
          await pause(500);
          return { reachedStableBottom, oversizedHeight: 0 };
        },
        { maxScrollSteps: MAX_SCROLL_STEPS, maxPageHeight: MAX_PAGE_HEIGHT_PX },
      );
      if (scrollResult.oversizedHeight) {
        markViolation("oversized-page", `height=${scrollResult.oversizedHeight}`);
      }
      if (!scrollResult.reachedStableBottom) {
        markViolation("truncated", `reason=max-scroll&viewport=${viewportWidth}`);
      }

      const collected = await page.evaluate(
        ({ maxUrls, maxUrlLength, maxElements }) => {
      const urls = [];
      const seen = new Set();
      const localViolations = new Set();
      const supportedProtocols = new Set(["http:", "https:", "data:", "blob:"]);

      const markLocalViolation = (reason, detail = "") => {
        const suffix = detail ? `?${detail}` : "";
        localViolations.add(`invalid:asset-collector-${reason}${suffix}`);
      };

      const add = (raw) => {
        if (typeof raw !== "string") return;
        const value = raw.trim();
        if (!value || value === "none") return;
        if (value.length > maxUrlLength) {
          const protocol = value.slice(0, value.indexOf(":")) || "unknown";
          markLocalViolation("oversized-url", `protocol=${encodeURIComponent(protocol)}&length=${value.length}`);
          return;
        }
        try {
          const absolute = new URL(value, document.baseURI);
          if (!supportedProtocols.has(absolute.protocol)) {
            markLocalViolation("unsupported-protocol", `protocol=${encodeURIComponent(absolute.protocol)}`);
            return;
          }
          if (seen.has(absolute.href)) return;
          if (urls.length >= maxUrls) {
            markLocalViolation("truncated", "reason=max-urls");
            return;
          }
          seen.add(absolute.href);
          urls.push(absolute.href);
        } catch {
          markLocalViolation("malformed-url");
        }
      };

      // This follows the browser's srcset tokenization closely enough to retain
      // commas inside data URLs while removing candidate-separator commas.
      const addSrcset = (srcset) => {
        if (!srcset) return;
        let position = 0;
        while (position < srcset.length) {
          while (position < srcset.length && /[\s,]/.test(srcset[position])) position += 1;
          if (position >= srcset.length) break;

          const start = position;
          while (position < srcset.length && !/\s/.test(srcset[position])) position += 1;
          let candidate = srcset.slice(start, position);
          let separatorCount = 0;
          while (candidate.endsWith(",")) {
            candidate = candidate.slice(0, -1);
            separatorCount += 1;
          }
          add(candidate);

          if (separatorCount === 0) {
            let parentheses = 0;
            while (position < srcset.length) {
              const char = srcset[position];
              position += 1;
              if (char === "(") parentheses += 1;
              else if (char === ")" && parentheses > 0) parentheses -= 1;
              else if (char === "," && parentheses === 0) break;
            }
          }
        }
      };

      const addCssUrls = (value) => {
        if (!value || value === "none") return;
        const pattern = /url\(\s*(?:(['"])(.*?)\1|([^)]*))\s*\)/gi;
        let match;
        while ((match = pattern.exec(value))) {
          add((match[2] ?? match[3] ?? "").trim());
        }
      };

      for (const image of document.querySelectorAll("img")) {
        add(image.currentSrc);
        add(image.src);
        addSrcset(image.getAttribute("srcset"));
      }
      for (const media of document.querySelectorAll("video, audio")) {
        add(media.currentSrc);
        add(media.src);
        add(media.getAttribute("src"));
        if (media instanceof HTMLVideoElement) add(media.poster);
      }
      for (const source of document.querySelectorAll("source")) {
        add(source.getAttribute("src"));
        addSrcset(source.getAttribute("srcset"));
      }

      const elements = Array.from(document.querySelectorAll("*"));
      if (elements.length > maxElements) {
        markLocalViolation("truncated", `reason=max-elements&count=${elements.length}`);
      }
      const pseudoElements = [null, "::before", "::after"];
      for (const element of elements.slice(0, maxElements)) {
        for (const pseudo of pseudoElements) {
          let style;
          try {
            style = getComputedStyle(element, pseudo);
          } catch {
            continue;
          }
          addCssUrls(style.backgroundImage);
          addCssUrls(style.maskImage);
          addCssUrls(style.getPropertyValue("-webkit-mask-image"));
        }
      }

          return { urls, violations: [...localViolations] };
        },
        {
          maxUrls: MAX_URLS,
          maxUrlLength: MAX_URL_LENGTH,
          maxElements: MAX_ELEMENTS,
        },
      );

      for (const assetUrl of collected.urls) renderedAssets.add(assetUrl);
      for (const violation of collected.violations) violations.add(violation);
    } finally {
      await context.close();
    }
  }

  const allUrls = [];
  const seen = new Set();
  for (const assetUrl of [...violations, ...renderedAssets, ...requestedAssets]) {
    if (seen.has(assetUrl)) continue;
    if (!assetUrl.startsWith("invalid:") && allUrls.length >= MAX_URLS + violations.size) {
      if (!seen.has("invalid:asset-collector-truncated?reason=max-total-urls")) {
        allUrls.unshift("invalid:asset-collector-truncated?reason=max-total-urls");
      }
      break;
    }
    seen.add(assetUrl);
    allUrls.push(assetUrl);
  }

  process.stdout.write(`${JSON.stringify(allUrls)}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${JSON.stringify({ error: message })}\n`);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
}
