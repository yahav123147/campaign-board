import { describe, expect, it } from "vitest";
import type { ClientProfile } from "@/config/clientProfile";
import { renderClientContext } from "@/orchestrator/clientContext";

const PROFILE: ClientProfile = {
  schemaVersion: 1,
  tenant: {
    id: "sample-client",
    displayName: "Sample Client",
    locale: "en-GB",
    timezone: "Europe/London",
  },
  brand: {
    publicName: "Sample Brand",
    legalName: "Sample Brand Limited",
    facts: ["The offer includes six live sessions."],
  },
  policies: {
    contentRules: ["Use only approved customer evidence."],
    advertisingRules: ["Keep launch objects paused for review."],
    operationalRules: ["Do not make external writes."],
    capabilities: {
      landingPageBuild: true,
      metaPixelRead: false,
      metaCampaignCreatePaused: false,
    },
  },
  landing: {
    workspacePath: "/private/client/workspace",
    publicBaseUrl: "https://example.test",
  },
  meta: {
    accountId: "act_123456789",
    pixelId: "123456789",
    pageId: "123456789",
    instagramActorId: "123456789",
    domain: "example.test",
    tokenKeychainService: "private-token-service",
  },
};

describe("renderClientContext", () => {
  it("renders tenant identity, facts, policies and capability gates", () => {
    const context = renderClientContext(PROFILE);

    expect(context).toContain("Sample Client");
    expect(context).toContain("Sample Brand");
    expect(context).toContain("en-GB");
    expect(context).toContain("Europe/London");
    expect(context).toContain("The offer includes six live sessions.");
    expect(context).toContain("Use only approved customer evidence.");
    expect(context).toContain("Keep launch objects paused for review.");
    expect(context).toContain("Do not make external writes.");
    expect(context).toContain('"landingPageBuild":true');
  });

  it("does not expose paths, connection identifiers or credential lookup names", () => {
    const context = renderClientContext(PROFILE);

    expect(context).not.toContain("/private/client/workspace");
    expect(context).not.toContain("act_123456789");
    expect(context).not.toContain("private-token-service");
  });

  it("exposes the public landing URLs so agents can pick an allowed reference (F87, 01.09.2026)", () => {
    const context = renderClientContext(PROFILE);

    // Public URLs are not secrets; without them the brand-brief agent keeps
    // choosing reference URLs outside the allowlist and stage 5.2 fails.
    expect(context).toContain("https://example.test");
    expect(context).toContain("allowedReferenceUrlPrefixes");
    expect(context).toContain("REFERENCE_URL: none");
  });

  it("states the output language in words, resolved from tenant.locale", () => {
    // Six stage instructions say "write in the profile's output language", but
    // nothing rendered what that language is: the model was left to read a BCP
    // 47 tag out of a JSON blob, and one client's strategy document came out in
    // Italian. The language is now a sentence, not an inference.
    expect(renderClientContext(PROFILE)).toContain("Write every output in English");
    expect(renderClientContext({ ...PROFILE, tenant: { ...PROFILE.tenant, locale: "he-IL" } }))
      .toContain("Write every output in Hebrew");
  });

  it("fails closed when no profile was supplied", () => {
    const context = renderClientContext();

    expect(context).toContain("No client profile was supplied");
    expect(context).toContain("Do not infer");
  });
});
