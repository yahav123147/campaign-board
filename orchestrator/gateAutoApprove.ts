import { eventBus } from "./eventBus";
import { loadClientProfile } from "@/config/clientProfile";
import { auditBlocksExpress } from "./copyStandard";
import { CREATIVES_DISABLED_MARKER } from "./runStage7Creatives";
import { getRun } from "./runRegistry";
import { finalCopySubTaskId } from "./stageRegistry";
import { imageMapCheckIsCurrent } from "./imageMapCheck";
import type { Run } from "@/types";

/**
 * Express gate policy (finding F73, 31.08.2026).
 *
 * A full run has 13 human approval stops. A client running the board will not
 * click through 13 gates, and 10 of them rubber-stamp intermediate documents.
 * Under `gates.policy: "express"` in the client profile, a completed gate in
 * this set still waits for a human; every other gate is approved
 * automatically, with the output persisted and logged exactly as if a human
 * had clicked approve.
 *
 * The gates that stay human are the ones where a decision is real:
 * - "4e": the last copy sub-task, i.e. the complete sales copy.
 * - "5.2": the asset contact sheet. Generated imagery is where hallucinations
 *   bite (invented faces, fake logos), so a human must see it.
 * - "5.4": the QA'd landing page about to be committed to the branch.
 * - "7":  the three Meta ads.
 * - "8"/"9": Meta verification and campaign plan, human by design.
 * - "5.3" is routine only after all design critics and its current image map
 *   check pass. The map must match the attempt, asset manifest and page source.
 *   Both checks are re-read before every retry and by the approval route.
 * - "1" (direct runs): the harvest sheet and the facts pool, the only source
 *   of truth for every claim.
 * - "2" (direct runs): the complete copy, the direct pipeline's final copy
 *   gate.
 *
 * The approval is performed through the same HTTP route a human uses, so every
 * guard (execution order, active-attempt lock, QA receipts, asset seals) keeps
 * applying. If the route keeps refusing, the gate simply stays human.
 */
const HUMAN_GATES = new Set(["4e", "5.2", "5.4", "7", "7.5", "8", "9"]);

const PORT = process.env.PORT?.trim() || "4321";
const BASE_URL = `http://127.0.0.1:${PORT}`;
const REQUEST_HEADERS = {
  "Content-Type": "application/json",
  Origin: BASE_URL,
  "X-Campaign-Council-Request": "1",
} as const;

/** The runner that produced the gate is still unwinding its execution claim right after the event fires, so the first attempts may see 409. */
const MAX_ATTEMPTS = 6;
const RETRY_DELAY_MS = 2500;

const inFlight = new Set<string>();

/**
 * Why express must not auto-approve this gate, or null when it may. Only 5.3
 * carries a design review: a page whose critics left blockers, or whose
 * critics returned no readable verdict, is a human decision even under
 * express. The summary the builder writes says exactly that; this makes the
 * gate agree with it (finding of 15.09.2026: "אורי לא הצביע" still produced an
 * approve request).
 */
export function designReviewBlocksExpress(
  run: Run | undefined,
  stageNumber: number | undefined,
  subTaskId: string | undefined,
): string | null {
  if (stageNumber !== 5 || subTaskId !== "5.3") return null;
  const build = run?.stages?.find((s) => s.number === 5)?.subTasks.find((st) => st.id === "5.3");
  const review = build?.designReview;
  if (!review) return "5.3 ללא תוצאת ביקורת עיצוב";
  if (review.passed) return null;
  if (review.failing.length) return `נשארו חוסמים: ${review.failing.join(", ")}`;
  if (review.silent.length) return `${review.silent.join(", ")} לא הצביע`;
  return "ביקורת העיצוב לא עברה";
}

async function expressEnabled(): Promise<boolean> {
  try {
    const profile = await loadClientProfile();
    return profile.gates?.policy === "express";
  } catch {
    return false;
  }
}

/**
 * Why express cannot approve the current 5.3 gate right now, or null when it can.
 * Every other gate is untouched: this only ever fires for stage 5, sub-task "5.3".
 */
export function expressAutoApproveViolation(
  run: Run | undefined,
  stageNumber: number | undefined,
  subTaskId: string | undefined,
): string | null {
  if (stageNumber !== 5 || subTaskId !== "5.3") return null;
  const stage5 = run?.stages?.find((stage) => stage.number === 5);
  const build = stage5?.subTasks.find((task) => task.id === "5.3");
  if (!build || build.status !== "awaiting-decision") return "5.3 אינו ממתין להחלטה";
  const designBlock = designReviewBlocksExpress(run, stageNumber, subTaskId);
  if (designBlock) return designBlock;
  const stale = imageMapCheckIsCurrent(build.imageMapCheck, {
    attemptStartedAt: build.startedAt,
    assetManifestSha256: build.assetManifestSha256,
    pageSourceHashes: build.pageSourceHashes,
  });
  if (stale) return stale;
  const check = build.imageMapCheck!;
  const assets = stage5?.subTasks.find((task) => task.id === "5.2");
  if (!assets?.assetManifestSha256 || assets.assetManifestSha256 !== check.assetManifestSha256) {
    return "מניפסט הנכסים של 5.2 השתנה אחרי בדיקת המפה";
  }
  if (!check.passed) return check.failure ?? "בדיקת מפת התמונות נכשלה";
  return null;
}

/** The body express POSTs to the decide route. Only 5.3 carries the check it was approved on. */
export interface ExpressApproveBody {
  action: "approve";
  expressImageMapCheck?: { attemptStartedAt: string; checkedAt: string };
}

/**
 * A violation string, or the body to POST. The 5.3 body binds the approval to
 * the exact image map check this eligibility read, so the route can refuse it
 * if the run on disk has moved on since.
 */
export function expressApproval(
  run: Run | undefined,
  stageNumber: number | undefined,
  subTaskId: string | undefined,
): string | ExpressApproveBody {
  const violation = expressAutoApproveViolation(run, stageNumber, subTaskId);
  if (violation) return violation;
  if (stageNumber !== 5 || subTaskId !== "5.3") return { action: "approve" };
  const check = run!.stages!.find((stage) => stage.number === 5)!.subTasks.find((task) => task.id === "5.3")!.imageMapCheck!;
  return {
    action: "approve",
    expressImageMapCheck: { attemptStartedAt: check.attemptStartedAt, checkedAt: check.checkedAt },
  };
}

/**
 * `eligibility` returns a violation string to stop, null to POST the plain
 * approve body, or the body to POST. It is re-read before every attempt.
 */
export async function approveViaRoute(
  url: string,
  label: string,
  eligibility: () => string | null | ExpressApproveBody = () => null,
): Promise<void> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const decision = eligibility();
    if (typeof decision === "string") {
      console.warn(`[express-gate] ${label}: ${decision}, leaving the gate to a human`);
      return;
    }
    const body: ExpressApproveBody = decision ?? { action: "approve" };
    const response = await fetch(url, {
      method: "POST",
      headers: REQUEST_HEADERS,
      body: JSON.stringify(body),
    }).catch(() => undefined);
    if (response?.ok) {
      console.log(`[express-gate] auto-approved ${label}`);
      return;
    }
    if (response && response.status !== 409) {
      console.warn(`[express-gate] ${label}: HTTP ${response.status}, leaving the gate to a human`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
  }
  console.warn(`[express-gate] ${label}: still blocked after ${MAX_ATTEMPTS} attempts, leaving the gate to a human`);
}

function schedule(key: string, url: string, eligibility: () => string | null | ExpressApproveBody = () => null): void {
  if (inFlight.has(key)) return;
  inFlight.add(key);
  void (async () => {
    try {
      if (!(await expressEnabled())) return;
      await approveViaRoute(url, key, eligibility);
    } finally {
      inFlight.delete(key);
    }
  })();
}

/** Idempotent. Installed once per server process from instrumentation.ts. */
export function installExpressGateAutoApprover(): void {
  const globalFlag = globalThis as unknown as { __councilExpressGatesInstalled?: boolean };
  if (globalFlag.__councilExpressGatesInstalled) return;
  globalFlag.__councilExpressGatesInstalled = true;

  eventBus.onAny((event) => {
    if (event.type === "subtask-completed") {
      if (!event.subTaskId || event.stageNumber === undefined) return;
      const gateRun = getRun(event.runId);
      // A disabled creative stage carries an explanatory note, not images to
      // review, so it flows through even though 7.5 is otherwise a human gate.
      const creativesDisabled =
        event.subTaskId === "7.5" &&
        typeof event.content === "string" &&
        event.content.startsWith(CREATIVES_DISABLED_MARKER);
      // שער הקופי הסופי הוא שלב 4 בריצת council (משתנה לפי סוג הנכס: 4e בדף
      // מכירה, 4c בסקוויז) ושלב 2 בריצת direct.
      const finalCopyGate = event.stageNumber === (gateRun?.pipeline === "direct" ? 2 : 4)
        && event.subTaskId === finalCopySubTaskId(gateRun?.assetType, gateRun?.pipeline);
      const directHumanGate = gateRun?.pipeline === "direct" && event.stageNumber === 1 && event.subTaskId === "1";
      if ((HUMAN_GATES.has(event.subTaskId) || finalCopyGate || directHumanGate) && !creativesDisabled) return;
      // A section that failed the skill-compliance audit, or was never audited
      // because the auditor returned no readable verdict, must reach a human.
      if (auditBlocksExpress(event.content)) {
        console.warn(`[express-gate] ${event.runId}:${event.subTaskId} did not pass the skill audit, leaving the gate to a human`);
        return;
      }
      const { runId, stageNumber, subTaskId } = event;
      schedule(
        `${runId}:${stageNumber}:${subTaskId}`,
        `${BASE_URL}/api/runs/${encodeURIComponent(runId)}/stages/${stageNumber}/subtasks/${encodeURIComponent(subTaskId)}/decide`,
        // Re-read on every retry attempt, not the gateRun snapshot above: the
        // 5.3 eligibility (imageMapCheck, assetManifestSha256) can change
        // during the up-to-6-attempt/~15s retry loop in approveViaRoute.
        () => expressApproval(getRun(runId), stageNumber, subTaskId),
      );
      return;
    }
    if (event.type === "synthesis-completed") {
      schedule(
        `${event.runId}:synthesis`,
        `${BASE_URL}/api/runs/${encodeURIComponent(event.runId)}/decide`,
      );
    }
  });
}
