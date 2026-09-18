import { describe, expect, it, vi } from "vitest";
import { checkPixelHealthSkip } from "@/orchestrator/stage8Preflight";

describe("Stage 8 preflight", () => {
  it("never skips from generic pixel activity", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(checkPixelHealthSkip()).resolves.toMatchObject({
      skip: false,
      reason: expect.stringContaining("Purchase"),
    });
    expect(fetchSpy).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
  });
});
