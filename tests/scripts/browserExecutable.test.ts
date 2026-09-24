import { describe, expect, it, vi } from "vitest";
import { GOOGLE_CHROME_MACOS_PATH, mockupBrowserExecutablePath } from "../../scripts/browser-executable.mjs";

describe("device mockup browser selection", () => {
  const chromium = "/client/playwright/chromium";

  it("uses the Chromium installed by setup on a clean Mac without Google Chrome", async () => {
    await expect(mockupBrowserExecutablePath({
      chromePath: "",
      platform: "darwin",
      isExecutable: async (file) => file === chromium,
      chromiumPath: async () => chromium,
    })).resolves.toBe(chromium);
  });

  it("keeps using an installed Google Chrome without resolving Playwright", async () => {
    const chromiumPath = vi.fn(async () => chromium);
    await expect(mockupBrowserExecutablePath({
      chromePath: "",
      platform: "darwin",
      isExecutable: async (file) => file === GOOGLE_CHROME_MACOS_PATH,
      chromiumPath,
    })).resolves.toBe(GOOGLE_CHROME_MACOS_PATH);
    expect(chromiumPath).not.toHaveBeenCalled();
  });

  it("honors an explicit executable and refuses a broken override", async () => {
    const selected = "/client/chosen-browser";
    const chromiumPath = vi.fn(async () => chromium);
    await expect(mockupBrowserExecutablePath({
      chromePath: selected,
      isExecutable: async (file) => file === selected,
      chromiumPath,
    })).resolves.toBe(selected);
    await expect(mockupBrowserExecutablePath({
      chromePath: selected,
      isExecutable: async (file) => file === chromium,
      chromiumPath,
    })).rejects.toThrow("CAMPAIGN_COUNCIL_CHROME_PATH");
    expect(chromiumPath).not.toHaveBeenCalled();
  });

  it("reports a missing installation when neither browser is executable", async () => {
    await expect(mockupBrowserExecutablePath({
      chromePath: "",
      platform: "darwin",
      isExecutable: async () => false,
      chromiumPath: async () => chromium,
    })).rejects.toThrow("npx playwright install chromium");
  });
});
