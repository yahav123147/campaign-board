import { beforeEach, describe, expect, it, vi } from "vitest";

// Same mocked loader as tests/api/createDirectRun.test.ts: the route must never
// read a real client profile from disk during a test.
const profile = vi.hoisted(() => ({ pipelineDefault: undefined as string | undefined, fail: false }));
vi.mock("@/config/clientProfile", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/config/clientProfile")>();
  return { ...mod, loadClientProfile: vi.fn(async () => {
    if (profile.fail) throw new Error("פרופיל הלקוח לא נטען");
    return mod.validateClientProfile({
      schemaVersion: 1,
      tenant: { id: "acme", displayName: "Acme", locale: "he-IL", timezone: "Asia/Jerusalem" },
      brand: { publicName: "Acme", facts: ["עובדה מאומתת"] },
      policies: { contentRules: [], advertisingRules: [], operationalRules: [],
        capabilities: { landingPageBuild: true, metaPixelRead: false, metaCampaignCreatePaused: false } },
      ...(profile.pipelineDefault ? { pipeline: { default: profile.pipelineDefault } } : {}),
    });
  }) };
});

import { GET } from "@/app/api/config/route";

beforeEach(() => { profile.pipelineDefault = undefined; profile.fail = false; });

describe("GET /api/config", () => {
  it("returns the profile's pipeline default", async () => {
    profile.pipelineDefault = "direct";
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pipelineDefault: "direct" });
  });

  it("falls back to council when the profile names no default", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pipelineDefault: "council" });
  });

  // The board's name is deliberately absent: the root layout resolves it from
  // the profile on the server and provides it to the header, so there is one
  // source for it and no flash of the neutral default on every page load.
  it("does not carry the board name", async () => {
    const res = await GET();
    expect(Object.keys(await res.json())).toEqual(["pipelineDefault"]);
  });

  it("answers 503 when the client profile cannot be loaded", async () => {
    profile.fail = true;
    const res = await GET();
    expect(res.status).toBe(503);
    expect((await res.json()).error).toContain("פרופיל הלקוח");
  });
});
