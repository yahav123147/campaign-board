import { describe, expect, it } from "vitest";
import { previewUrlFor, waitForPage } from "@/orchestrator/previewServer";

describe("waitForPage", () => {
  it("refuses readiness probes outside the fixed loopback preview origin", async () => {
    await expect(waitForPage("https://example.test/page")).rejects.toThrow(/local preview origin/);
    await expect(waitForPage("http://127.0.0.1:9999/page")).rejects.toThrow(/local preview origin/);
  });

  it("honors cancellation before issuing a request", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(waitForPage(previewUrlFor("safe-page"), controller.signal)).rejects.toThrow(/aborted/);
  });
});
