import { describe, expect, it } from "vitest";
import {
  classifyBrowserRequest,
  parseHttpNavigationUrl,
  violationSentinel,
} from "@/scripts/browser-network-policy.mjs";

describe("browser network policy", () => {
  const root = new URL("http://127.0.0.1:4322/safe-page");

  it("allows only read requests to the selected origin", () => {
    expect(classifyBrowserRequest("http://127.0.0.1:4322/safe-page", root)).toEqual({ allowed: true });
    expect(classifyBrowserRequest("https://cdn.example/image.png", root)).toEqual({
      allowed: false,
      reason: "cross-origin",
    });
    expect(classifyBrowserRequest(root.href, root, { method: "POST" })).toEqual({
      allowed: false,
      reason: "method-post",
    });
  });

  it("contains generated previews to their route and Next static files", () => {
    const options = { restrictToRoute: true };
    expect(classifyBrowserRequest("http://127.0.0.1:4322/safe-page/photo.webp", root, options)).toEqual({ allowed: true });
    expect(classifyBrowserRequest("http://127.0.0.1:4322/_next/static/app.js", root, options)).toEqual({ allowed: true });
    expect(classifyBrowserRequest("http://127.0.0.1:4322/api/delete", root, options)).toEqual({
      allowed: false,
      reason: "outside-preview-route",
    });
    expect(classifyBrowserRequest("http://127.0.0.1:4322/other", root, options)).toEqual({
      allowed: false,
      reason: "outside-preview-route",
    });
  });

  it("rejects unsafe navigation URLs and emits opaque sentinels", () => {
    expect(() => parseHttpNavigationUrl("file:///etc/passwd")).toThrow(/http or https/);
    expect(() => parseHttpNavigationUrl("https://user:secret@example.test/")).toThrow(/credentials/);
    expect(violationSentinel("asset collector", "cross-origin")).toBe(
      "invalid:asset-collector-cross-origin",
    );
  });
});

describe("the shipped landing template stays inside the preview render policy", () => {
  // WSL2 acceptance run 35850777432: globals.css loaded /fonts/Heebo.ttf, the
  // render policy blocked it as outside-preview-route, and stage 5.3 failed
  // on every page built from the template. Assets the template itself loads
  // must come through the bundler (/_next/static) or the page's own route.
  it("loads its font through a relative url the bundler serves, never an absolute path", async () => {
    const root = new URL("http://127.0.0.1:4322/council-example-page");
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const css = await fs.readFile(path.join(process.cwd(), "templates", "landing", "src", "app", "globals.css"), "utf8");
    const urls = [...css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)].map((match) => match[1]);
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url.startsWith("/")).toBe(false);
      expect(classifyBrowserRequest(`http://127.0.0.1:4322/_next/static/media/${path.basename(url)}`, root, { restrictToRoute: true })).toEqual({ allowed: true });
    }
  });
});
