import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CLIENT_PROFILE_PATH_ENV,
  DEVELOPMENT_PROFILE_ENV,
  MAX_CLIENT_PROFILE_BYTES,
  getClientFeatureReadiness,
  loadClientProfile,
  validateClientProfile,
} from "@/config/clientProfile";
import { CLIENT_PRIVATE_CONTENT_PATTERNS } from "@/scripts/package-client.mjs";

function completeProfile() {
  return {
    schemaVersion: 1,
    tenant: {
      id: "acme-labs",
      displayName: "Acme Labs",
      locale: "en-US",
      timezone: "America/New_York",
    },
    brand: {
      publicName: "Acme",
      legalName: "Acme Labs LLC",
      facts: ["Acme sells one verified example product."],
    },
    policies: {
      contentRules: ["Never invent customer results."],
      advertisingRules: ["New campaign objects stay paused."],
      operationalRules: ["External writes require approval."],
      capabilities: {
        landingPageBuild: true,
        metaPixelRead: true,
        metaCampaignCreatePaused: true,
      },
    },
    landing: {
      workspacePath: "/srv/acme/landing-pages",
      publicBaseUrl: "https://offers.example.test/campaign",
      referenceUrlPrefixes: ["https://www.example.test/offers/"],
      referenceRoots: ["/srv/acme/reference-projects"],
      designStandardPath: ".agents/skills/landing-page-design/SKILL.md",
      qaScriptPath: ".agents/skills/landing-page-design/scripts/landing-qa.mjs",
      mockupBasesDir: "/srv/acme/mockup-bases",
    },
    meta: {
      accountId: "act_123456789",
      pixelId: "123456789",
      customConversionId: "423456789",
      pageId: "223456789",
      instagramActorId: "323456789",
      domain: "offers.example.test",
      tokenKeychainService: "acme-meta-token",
    },
  };
}

describe("client profile validation", () => {
  it("accepts a tenant-neutral complete profile and enables configured features", () => {
    const profile = validateClientProfile(completeProfile());

    expect(profile.tenant.id).toBe("acme-labs");
    expect(profile.landing?.publicBaseUrl).toBe("https://offers.example.test/campaign");
    expect(profile.landing?.referenceRoots).toEqual(["/srv/acme/reference-projects"]);
    expect(profile.landing?.mockupBasesDir).toBe("/srv/acme/mockup-bases");
    expect(getClientFeatureReadiness(profile)).toEqual({
      stage5: { enabled: true, missingFields: [], policyBlocks: [] },
      stage8: { enabled: true, missingFields: [], policyBlocks: [] },
      stage9: { enabled: true, missingFields: [], policyBlocks: [] },
    });
  });

  it("reports missing configuration separately from explicit policy blocks", () => {
    const input = {
      ...completeProfile(),
      policies: {
        ...completeProfile().policies,
        capabilities: {
          landingPageBuild: false,
          metaPixelRead: false,
          metaCampaignCreatePaused: false,
        },
      },
      landing: { workspacePath: null, publicBaseUrl: null },
      meta: {
        accountId: null,
        pixelId: null,
        customConversionId: null,
        pageId: null,
        instagramActorId: null,
        domain: null,
        tokenKeychainService: null,
      },
    };

    const readiness = getClientFeatureReadiness(validateClientProfile(input));
    expect(readiness.stage5).toEqual({
      enabled: false,
      missingFields: [
        "landing.workspacePath",
        "landing.designStandardPath",
        "landing.qaScriptPath",
      ],
      policyBlocks: ["policies.capabilities.landingPageBuild"],
    });
    expect(readiness.stage8.enabled).toBe(false);
    expect(readiness.stage8.missingFields).toEqual([
      "meta.accountId",
      "meta.pixelId",
      "meta.customConversionId",
      "meta.domain",
      "meta.tokenKeychainService",
    ]);
    expect(readiness.stage9.policyBlocks).toEqual([
      "policies.capabilities.metaPixelRead",
      "policies.capabilities.metaCampaignCreatePaused",
    ]);
  });

  it.each([
    ["schema version", { ...completeProfile(), schemaVersion: 2 }, "schemaVersion must be 1"],
    [
      "unknown field",
      { ...completeProfile(), tenant: { ...completeProfile().tenant, secret: "no" } },
      "tenant.secret is not a supported field",
    ],
    [
      "relative workspace",
      { ...completeProfile(), landing: { workspacePath: "../landing-pages" } },
      "workspacePath must be an absolute path",
    ],
    [
      "escaping QA path",
      { ...completeProfile(), landing: { ...completeProfile().landing, qaScriptPath: "../qa.mjs" } },
      "qaScriptPath must not contain",
    ],
    [
      "relative mockup bases directory",
      { ...completeProfile(), landing: { ...completeProfile().landing, mockupBasesDir: "bases" } },
      "mockupBasesDir must be an absolute path",
    ],
    [
      "unknown landing field",
      { ...completeProfile(), landing: { ...completeProfile().landing, mockupBases: "/srv" } },
      "landing.mockupBases is not a supported field",
    ],
    [
      "malformed Meta account",
      { ...completeProfile(), meta: { ...completeProfile().meta, accountId: "123" } },
      "accountId must match act_<digits>",
    ],
    [
      "malformed Meta domain",
      { ...completeProfile(), meta: { ...completeProfile().meta, domain: "bad_host.example" } },
      "domain must contain valid DNS hostname labels",
    ],
  ])("rejects %s with a field-specific message", (_name, input, message) => {
    expect(() => validateClientProfile(input)).toThrow(message as string);
  });
});

describe("client profile loading", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "council-client-profile-"));
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("loads a regular JSON file from the configurable path", async () => {
    const profilePath = path.join(directory, "client.json");
    await fs.writeFile(profilePath, JSON.stringify(completeProfile()));

    const profile = await loadClientProfile({
      env: { [CLIENT_PROFILE_PATH_ENV]: "client.json" },
      cwd: directory,
    });

    expect(profile.brand.publicName).toBe("Acme");
  });

  it("keeps the checked-in example valid and every external feature disabled", async () => {
    const profile = await loadClientProfile({
      env: { [CLIENT_PROFILE_PATH_ENV]: "config/client-profile.example.json" },
      cwd: process.cwd(),
    });

    expect(profile.tenant.id).toBe("example-client");
    expect(Object.values(getClientFeatureReadiness(profile)).every((item) => !item.enabled)).toBe(true);
  });

  it("has no implicit tenant and explains how to configure one", async () => {
    await expect(loadClientProfile({ env: {} })).rejects.toMatchObject({
      code: "missing-profile",
    });
    await expect(loadClientProfile({ env: {} })).rejects.toThrow(CLIENT_PROFILE_PATH_ENV);
  });

  it("uses the generic development profile only after explicit environment opt-in", async () => {
    const profile = await loadClientProfile({ env: { [DEVELOPMENT_PROFILE_ENV]: "1" } });

    expect(profile.tenant.id).toBe("development");
    for (const pattern of CLIENT_PRIVATE_CONTENT_PATTERNS) {
      expect(profile.brand.publicName).not.toMatch(pattern.expression);
    }
    expect(profile.meta).toBeUndefined();
    expect(Object.values(getClientFeatureReadiness(profile)).every((item) => !item.enabled)).toBe(true);

    await expect(
      loadClientProfile({ env: { [DEVELOPMENT_PROFILE_ENV]: "true" } }),
    ).rejects.toMatchObject({ code: "missing-profile" });
  });

  it("does not fall back to development when a configured file is malformed", async () => {
    const profilePath = path.join(directory, "bad.json");
    await fs.writeFile(profilePath, "{not json");

    await expect(
      loadClientProfile({
        env: {
          [CLIENT_PROFILE_PATH_ENV]: profilePath,
          [DEVELOPMENT_PROFILE_ENV]: "1",
        },
      }),
    ).rejects.toMatchObject({ code: "invalid-profile", profilePath });
  });

  it("rejects profile files that are not valid UTF-8", async () => {
    const profilePath = path.join(directory, "invalid-utf8.json");
    await fs.writeFile(profilePath, Buffer.from([0xff, 0xfe, 0xfd]));

    await expect(
      loadClientProfile({ env: { [CLIENT_PROFILE_PATH_ENV]: profilePath } }),
    ).rejects.toMatchObject({ code: "invalid-profile", profilePath });
  });

  it("rejects oversized profiles before parsing", async () => {
    const profilePath = path.join(directory, "huge.json");
    await fs.writeFile(profilePath, Buffer.alloc(MAX_CLIENT_PROFILE_BYTES + 1, "x"));

    await expect(
      loadClientProfile({ env: { [CLIENT_PROFILE_PATH_ENV]: profilePath } }),
    ).rejects.toMatchObject({ code: "profile-too-large", profilePath });
  });

  it("rejects symlinked profiles", async () => {
    const target = path.join(directory, "target.json");
    const link = path.join(directory, "client.json");
    await fs.writeFile(target, JSON.stringify(completeProfile()));
    await fs.symlink(target, link);

    await expect(
      loadClientProfile({ env: { [CLIENT_PROFILE_PATH_ENV]: link } }),
    ).rejects.toEqual(
      expect.objectContaining({
        code: "unsafe-profile-file",
        profilePath: link,
      }),
    );
  });
});
