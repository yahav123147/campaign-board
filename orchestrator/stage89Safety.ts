import {
  getClientFeatureReadiness,
  loadClientProfile,
  type ClientFeature,
  type ClientProfile,
  type FeatureReadiness,
} from "@/config/clientProfile";
import { createHash } from "node:crypto";
import type { StageNumber, SubTask } from "@/types";

export const STAGE9_EXECUTION_POLICY = Object.freeze({
  mode: "plan-only" as const,
  typedExecutionAvailable: false,
  requiresExplicitStart: true,
});

const SHA256_HEX_RE = /^[a-f0-9]{64}$/;

export function stage8ReportSha256(report: string): string {
  return createHash("sha256").update(report, "utf-8").digest("hex");
}

export function isValidStage8VerificationReceipt(
  value: unknown,
): value is NonNullable<SubTask["metaVerification"]> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  return receipt.schemaVersion === 1
    && typeof receipt.ready === "boolean"
    && typeof receipt.reportSha256 === "string"
    && SHA256_HEX_RE.test(receipt.reportSha256)
    && typeof receipt.checkedAt === "string"
    && Number.isFinite(Date.parse(receipt.checkedAt));
}

/** A typed verification report is evidence, so edited or failed bytes cannot be approved. */
export function stage8ApprovalViolation(
  subTask: Pick<SubTask, "output" | "metaVerification">,
  assembledStageOutput = subTask.output,
): string | undefined {
  const receipt = subTask.metaVerification;
  if (!isValidStage8VerificationReceipt(receipt)) {
    return "Stage 8 cannot be approved without a typed verification receipt.";
  }
  if (
    stage8ReportSha256(subTask.output) !== receipt.reportSha256
    || stage8ReportSha256(assembledStageOutput) !== receipt.reportSha256
  ) {
    return "Stage 8 cannot be approved because its verified report was edited.";
  }
  if (!receipt.ready) {
    return "Stage 8 cannot be approved until the typed launch-readiness gate passes. Send feedback and rerun the verification.";
  }
  return undefined;
}

export class ClientFeatureBlockedError extends Error {
  readonly feature: ClientFeature;
  readonly readiness: FeatureReadiness;

  constructor(feature: ClientFeature, readiness: FeatureReadiness, cause?: unknown) {
    const details = [
      readiness.missingFields.length
        ? `missing configuration: ${readiness.missingFields.join(", ")}`
        : "",
      readiness.policyBlocks.length
        ? `blocked by policy: ${readiness.policyBlocks.join(", ")}`
        : "",
    ].filter(Boolean);
    super(
      `Client profile does not authorize ${feature}${details.length ? ` (${details.join("; ")})` : ""}.`,
      { cause },
    );
    this.name = "ClientFeatureBlockedError";
    this.feature = feature;
    this.readiness = readiness;
  }
}

export function assertClientFeatureReady(
  profile: ClientProfile,
  feature: ClientFeature,
): ClientProfile {
  const readiness = getClientFeatureReadiness(profile)[feature];
  if (!readiness.enabled) throw new ClientFeatureBlockedError(feature, readiness);
  return profile;
}

export async function requireClientFeature(feature: ClientFeature): Promise<ClientProfile> {
  let profile: ClientProfile;
  try {
    profile = await loadClientProfile();
  } catch (error) {
    throw new Error(
      `Client profile could not be loaded for ${feature}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  return assertClientFeatureReady(profile, feature);
}

/** Stage 9 is intentionally a user-started planning step. It is never chained. */
export function stageRequiresExplicitStart(stageNumber: StageNumber): boolean {
  return stageNumber === 9;
}
