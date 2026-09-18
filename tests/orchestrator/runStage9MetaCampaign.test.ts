import { describe, expect, it } from "vitest";
import type { ClientProfile } from "@/config/clientProfile";
import {
  assertStage9PlanOutputSafe,
  assertStage9Prerequisites,
  buildStage9PlanningPrompt,
  buildTrustedStage9Document,
} from "@/orchestrator/runStage9MetaCampaign";
import { stage8ReportSha256 } from "@/orchestrator/runStage8PixelVerify";
import type { Run, Stage } from "@/types";

const PROFILE: ClientProfile = {
  schemaVersion: 1,
  tenant: {
    id: "acme",
    displayName: "Acme Ltd",
    locale: "he-IL",
    timezone: "Asia/Jerusalem",
  },
  brand: { publicName: "Acme", facts: ["Verified fact"] },
  policies: {
    contentRules: ["Do not invent proof."],
    advertisingRules: ["Objects start paused."],
    operationalRules: ["External writes require approval."],
    capabilities: {
      landingPageBuild: false,
      metaPixelRead: true,
      metaCampaignCreatePaused: true,
    },
  },
  landing: { publicBaseUrl: "https://offers.example.test" },
  meta: {
    accountId: "act_123456789",
    pixelId: "123456789",
    customConversionId: "423456789",
    pageId: "223456789",
    instagramActorId: "323456789",
    domain: "offers.example.test",
    tokenKeychainService: "must-not-enter-the-prompt",
  },
};

function stage(number: Stage["number"], output: string): Stage {
  return {
    number,
    title: `Stage ${number}`,
    ownerSlug: "avishai-campaigner",
    status: "approved",
    output,
    feedbackHistory: [],
    subTasks: [
      { id: String(number), title: "task", status: "approved", output, feedbackHistory: [] },
    ],
  };
}

function readyRun(stage8Output = "# verification\n\n> RESULT: PASS"): Run {
  const stage7 = stage(7, "approved ad copy");
  const stage8 = stage(8, stage8Output);
  stage8.subTasks[0].metaVerification = {
    schemaVersion: 1,
    ready: true,
    reportSha256: stage8ReportSha256(stage8Output),
    checkedAt: "2026-08-27T12:00:00.000Z",
  };
  return {
    id: "2026-08-27-1200-safe-run-id",
    slug: "safe-run",
    brief: "Launch the approved offer.",
    createdAt: "2026-08-27T12:00:00.000Z",
    status: "approved",
    currentRound: null,
    messages: [],
    strategyDoc: "Use a small test budget and explicit kill criteria.",
    stages: [stage7, stage8, { ...stage(9, ""), status: "pending" }],
    currentStage: 9,
  };
}

describe("Stage 9 plan-only boundary", () => {
  it("requires an unmodified passing typed Stage 8 receipt", () => {
    const run = readyRun();
    expect(assertStage9Prerequisites(run).stage7Output).toBe("approved ad copy");

    run.stages![1].output += "edited";
    expect(() => assertStage9Prerequisites(run)).toThrow(/changed after verification/i);

    const failed = readyRun();
    failed.stages![1].subTasks[0].metaVerification!.ready = false;
    expect(() => assertStage9Prerequisites(failed)).toThrow(/did not pass/i);

    const malformed = readyRun();
    malformed.stages![1].subTasks[0].metaVerification!.reportSha256 = "not-a-sha256";
    expect(() => assertStage9Prerequisites(malformed)).toThrow(/no typed verification receipt/i);
  });

  it("builds a tenant-profiled prompt with no credential or command path", () => {
    const run = readyRun();
    run.brief = "Launch the offer. access_token=very-secret-value-123456789";
    const prerequisites = assertStage9Prerequisites(run);
    const prompt = buildStage9PlanningPrompt(
      PROFILE,
      run,
      prerequisites.stage7Output,
      prerequisites.stage8Output,
    );

    expect(prompt).toContain("PLAN ONLY");
    expect(prompt).toContain("רשאיות לרוץ ברצף 7 ימים, כולל שבת");
    expect(prompt).toContain("האיסור בשבת חל על תקשורת broadcast");
    expect(prompt).not.toContain("must-not-enter-the-prompt");
    expect(prompt).not.toContain("very-secret-value-123456789");
    expect(prompt).toContain("[REDACTED SECRET]");
    expect(prompt).not.toMatch(/\bcurl\b|access_token|find-generic-password|bypassPermissions/i);
    expect(prompt).not.toContain("שבת OFF");
    expect(prompt).not.toContain("אסור להפעיל בשבת");
  });

  it("rejects command-shaped output and false execution claims", () => {
    const safe = "תוכנית מפורטת לבדיקת אדם בלבד. ".repeat(8);
    expect(() => assertStage9PlanOutputSafe(safe)).not.toThrow();
    expect(() => assertStage9PlanOutputSafe(`${safe}\n\`\`\`bash\ncurl example\n\`\`\``)).toThrow(
      /plan-only output gate/i,
    );
    expect(() => assertStage9PlanOutputSafe(`${safe}\nיצרתי את הקמפיין והכול מוכן.`)).toThrow(
      /claim of external execution/i,
    );
    expect(() => assertStage9PlanOutputSafe(`${safe}\nAccess token: example`)).toThrow(
      /access token reference/i,
    );
  });

  it("wraps the model plan in a trusted execution-blocked notice", () => {
    const document = buildTrustedStage9Document("## מבנה\n\nתוכנית לבדיקה.");
    expect(document).toContain("ביצוע חיצוני חסום");
    expect(document).toContain("לא יצרה ולא שינתה קמפיין");
    expect(document).toContain("7 ימים, כולל שבת");
  });
});
