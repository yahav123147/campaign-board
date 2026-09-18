import { describe, expect, it } from "vitest";
import type { ClientProfile } from "@/config/clientProfile";
import {
  assertClientFeatureReady,
  stage8ApprovalViolation,
  stage8ReportSha256,
  stageRequiresExplicitStart,
  STAGE9_EXECUTION_POLICY,
} from "@/orchestrator/stage89Safety";

function profile(): ClientProfile {
  return {
    schemaVersion: 1,
    tenant: { id: "acme", displayName: "Acme", locale: "en-US", timezone: "UTC" },
    brand: { publicName: "Acme", facts: ["Verified"] },
    policies: {
      contentRules: [],
      advertisingRules: [],
      operationalRules: [],
      capabilities: {
        landingPageBuild: false,
        metaPixelRead: false,
        metaCampaignCreatePaused: false,
      },
    },
  };
}

describe("Stage 8/9 safety policy", () => {
  it("fails closed when profile fields or capabilities are unavailable", () => {
    expect(() => assertClientFeatureReady(profile(), "stage8")).toThrow(/does not authorize stage8/i);
    expect(() => assertClientFeatureReady(profile(), "stage9")).toThrow(/does not authorize stage9/i);
  });

  it("requires explicit start for Stage 9 only", () => {
    expect(stageRequiresExplicitStart(8)).toBe(false);
    expect(stageRequiresExplicitStart(9)).toBe(true);
    expect(STAGE9_EXECUTION_POLICY).toEqual({
      mode: "plan-only",
      typedExecutionAvailable: false,
      requiresExplicitStart: true,
    });
  });

  it("approves only the exact passing typed Stage 8 report", () => {
    const output = "# Typed verification\n\nRESULT: PASS";
    const subTask = {
      output,
      metaVerification: {
        schemaVersion: 1 as const,
        ready: true,
        reportSha256: stage8ReportSha256(output),
        checkedAt: "2026-08-28T10:00:00.000Z",
      },
    };

    expect(stage8ApprovalViolation(subTask)).toBeUndefined();
    expect(stage8ApprovalViolation({ ...subTask, output: `${output}\nchanged` }))
      .toMatch(/edited/i);
    expect(stage8ApprovalViolation({
      ...subTask,
      metaVerification: { ...subTask.metaVerification, ready: false },
    })).toMatch(/passes/i);
    expect(stage8ApprovalViolation({ output, metaVerification: undefined }))
      .toMatch(/without a typed verification receipt/i);
  });

  it("also binds Stage 8 stage-level approval to the assembled output", () => {
    const output = "verified report";
    const subTask = {
      output,
      metaVerification: {
        schemaVersion: 1 as const,
        ready: true,
        reportSha256: stage8ReportSha256(output),
        checkedAt: "2026-08-28T10:00:00.000Z",
      },
    };
    expect(stage8ApprovalViolation(subTask, "edited stage output")).toMatch(/edited/i);
  });
});
