import { describe, expect, it } from "vitest";
import { validateClientProfile } from "@/config/clientProfile";

function base(extra: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    tenant: { id: "acme", displayName: "Acme", locale: "he-IL", timezone: "Asia/Jerusalem" },
    brand: { publicName: "Acme", facts: ["Acme sells one verified example product."] },
    policies: {
      contentRules: [], advertisingRules: [], operationalRules: [],
      capabilities: { landingPageBuild: true, metaPixelRead: false, metaCampaignCreatePaused: false, liveProof: true },
    },
    ...extra,
  };
}

describe("profile.pipeline", () => {
  it("accepts a default pipeline, a critic round cap and the liveProof capability", () => {
    const profile = validateClientProfile(base({ pipeline: { default: "direct", criticMaxRounds: 3 } }));
    expect(profile.pipeline).toEqual({ default: "direct", criticMaxRounds: 3 });
    expect(profile.policies.capabilities.liveProof).toBe(true);
  });

  it("rejects an unknown pipeline, a round cap outside 1..5 and unknown keys", () => {
    expect(() => validateClientProfile(base({ pipeline: { default: "board" } }))).toThrow(/profile\.pipeline\.default/);
    expect(() => validateClientProfile(base({ pipeline: { criticMaxRounds: 9 } }))).toThrow(/criticMaxRounds/);
    expect(() => validateClientProfile(base({ pipeline: { rounds: 2 } }))).toThrow(/profile\.pipeline/);
  });

  it("defaults liveProof to false when absent", () => {
    const profile = validateClientProfile({ ...base(), policies: { ...base().policies, capabilities: { landingPageBuild: true, metaPixelRead: false, metaCampaignCreatePaused: false } } });
    expect(profile.policies.capabilities.liveProof).toBe(false);
  });
});

describe("profile.copy.critics", () => {
  it("accepts a rubrics directory and a design-strategy standard path", () => {
    const profile = validateClientProfile(
      base({ copy: { critics: { rubricsDir: "/srv/acme/critics", designStrategyStandardPath: "/srv/acme/critics/design-strategy-standard.md" } } }),
    );
    expect(profile.copy?.critics).toEqual({
      rubricsDir: "/srv/acme/critics",
      designStrategyStandardPath: "/srv/acme/critics/design-strategy-standard.md",
    });
  });

  it("rejects an unknown key under critics", () => {
    expect(() =>
      validateClientProfile(base({ copy: { critics: { rubricsDir: "/srv/acme/critics", extra: "no" } } })),
    ).toThrow(/profile\.copy\.critics\.extra/);
  });
});

describe("profile.copy.voice", () => {
  it("accepts both first-person voices", () => {
    expect(validateClientProfile(base({ copy: { voice: { firstPerson: "presenter" } } })).copy?.voice)
      .toEqual({ firstPerson: "presenter" });
    expect(validateClientProfile(base({ copy: { voice: { firstPerson: "brand-owner" } } })).copy?.voice)
      .toEqual({ firstPerson: "brand-owner" });
  });

  it("leaves the voice unset when the section is absent, which keeps today's behaviour", () => {
    expect(validateClientProfile(base({ copy: { standardPath: "/srv/acme/standard.md" } })).copy?.voice).toBeUndefined();
  });

  it("rejects a third voice and an unknown key under voice", () => {
    expect(() => validateClientProfile(base({ copy: { voice: { firstPerson: "narrator" } } })))
      .toThrow(/profile\.copy\.voice\.firstPerson/);
    expect(() => validateClientProfile(base({ copy: { voice: { firstPerson: "presenter", tone: "warm" } } })))
      .toThrow(/profile\.copy\.voice\.tone/);
  });
});
