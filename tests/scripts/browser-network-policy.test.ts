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
