import { describe, it, expect } from "vitest";
import { buildAgentPrompt, buildSynthesizerPrompt } from "@/orchestrator/promptBuilder";
import type { ClientProfile } from "@/config/clientProfile";
import type { Agent, Message } from "@/types";

const fakeAgent: Agent = {
  slug: "yoni-strategist",
  name: "יוני",
  role: "אסטרטג",
  color: "#000",
  order: 1,
  active: true,
  systemPrompt: "אתה יוני, אסטרטג.",
  avatarPath: "/tmp/y.png",
};

const clientProfile: ClientProfile = {
  schemaVersion: 1,
  tenant: { id: "acme", displayName: "Acme", locale: "en-US", timezone: "UTC" },
  brand: { publicName: "Acme Product", facts: ["The trial lasts 14 days."] },
  policies: {
    contentRules: ["Do not invent testimonials."],
    advertisingRules: [],
    operationalRules: [],
    capabilities: {
      landingPageBuild: false,
      metaPixelRead: false,
      metaCampaignCreatePaused: false,
    },
  },
};

describe("buildAgentPrompt", () => {
  it("for round 1 includes brief but no prior messages", () => {
    const p = buildAgentPrompt({ agent: fakeAgent, round: 1, brief: "השק קמפיין", priorMessages: [] });
    expect(p).toContain("אתה יוני, אסטרטג.");
    expect(p).toContain("השק קמפיין");
    expect(p).toContain("סבב 1");
    expect(p).not.toContain("עמדות הסוכנים האחרים");
  });

  it("for round 2 includes round-1 messages from others", () => {
    const messages: Message[] = [
      { agentSlug: "roni-creative", round: 1, content: "הקמפיין צריך דמונסטרציה.", status: "done", startedAt: "" },
    ];
    const p = buildAgentPrompt({ agent: fakeAgent, round: 2, brief: "X", priorMessages: messages });
    expect(p).toContain("סבב 2");
    expect(p).toContain("הקמפיין צריך דמונסטרציה");
    expect(p).toContain("חובה: התעמת בשם");
  });

  it("excludes the agent's own messages from priorMessages", () => {
    const messages: Message[] = [
      { agentSlug: "yoni-strategist", round: 1, content: "מילים שלי הקודמות", status: "done", startedAt: "" },
      { agentSlug: "roni-creative", round: 1, content: "של רוני", status: "done", startedAt: "" },
    ];
    const p = buildAgentPrompt({ agent: fakeAgent, round: 2, brief: "X", priorMessages: messages });
    expect(p).toContain("של רוני");
    expect(p).not.toContain("מילים שלי הקודמות");
  });

  it("places the approved client context before the campaign brief", () => {
    const p = buildAgentPrompt({
      agent: fakeAgent,
      round: 1,
      brief: "CAMPAIGN_BRIEF",
      priorMessages: [],
      clientProfile,
    });

    expect(p).toContain("Acme Product");
    expect(p).toContain("Do not invent testimonials.");
    expect(p.indexOf("CLIENT_PROFILE_JSON")).toBeLessThan(p.indexOf("CAMPAIGN_BRIEF"));
  });
});

describe("buildSynthesizerPrompt", () => {
  it("includes all 3 rounds and brief", () => {
    const messages: Message[] = [
      { agentSlug: "yoni-strategist", round: 1, content: "R1Y", status: "done", startedAt: "" },
      { agentSlug: "yoni-strategist", round: 2, content: "R2Y", status: "done", startedAt: "" },
      { agentSlug: "yoni-strategist", round: 3, content: "R3Y", status: "done", startedAt: "" },
    ];
    const p = buildSynthesizerPrompt({ brief: "BRIEF", allMessages: messages, synthesizerPrompt: "SYS" });
    expect(p).toContain("BRIEF");
    expect(p).toContain("SYS");
    expect(p).toContain("R1Y");
    expect(p).toContain("R2Y");
    expect(p).toContain("R3Y");
  });

  it("binds the synthesis to the copy rulebook when one is configured (F109)", () => {
    const p = buildSynthesizerPrompt({
      brief: "BRIEF",
      allMessages: [],
      synthesizerPrompt: "SYS",
      copyStandard: "## ההבטחה הגדולה: הנוסחה\nכלל הברזל של ההבטחה",
    });

    expect(p).toContain("ספר הכללים של הקופי");
    expect(p).toContain("כלל הברזל של ההבטחה");
    expect(p.indexOf("כלל הברזל של ההבטחה")).toBeLessThan(p.indexOf("## משימה"));
  });

  it("omits the rulebook section for a tenant that configured no standard", () => {
    const p = buildSynthesizerPrompt({ brief: "BRIEF", allMessages: [], synthesizerPrompt: "SYS" });
    expect(p).not.toContain("ספר הכללים של הקופי");
  });

  it("includes the same client context used by the discussing agents", () => {
    const p = buildSynthesizerPrompt({
      brief: "BRIEF",
      allMessages: [],
      synthesizerPrompt: "SYS",
      clientProfile,
    });

    expect(p).toContain("Acme Product");
    expect(p).toContain("The trial lasts 14 days.");
  });
});
