import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Run } from "@/types";
import { htmlPage, startProbeFixtureServer } from "../scripts/probeFixtureServer";
import { collectVisibleImages } from "@/orchestrator/previewServer";
import { runImageMapCheck } from "@/orchestrator/imageMapCheck";
import { buildRevisePrompt, finalizeImageMapCheck, imageMapCritique, splitCritiques } from "@/orchestrator/runStage5LpBuild";
import { expressAutoApproveViolation } from "@/orchestrator/gateAutoApprove";

const mapped = [
  { file: "hero.png", section: "Hero", proves: "״30 לקוחות בחודש״" },
  { file: "proof.png", section: "הוכחה", proves: "״50 אלף עוקבים״" },
  { file: "stack.png", section: "Stack", proves: "״מה מקבלים״" },
];
const IMG = 'width="320" height="220"';
const attemptStartedAt = "2026-09-13T10:00:00.000Z";
const assetManifestSha256 = "a".repeat(64);
const pageSourceHashes = { "page.tsx": "1".repeat(64) };

const pages = {
  "scenario-removed": {
    html: htmlPage(`<img src="/scenario-removed/hero.png" ${IMG}><img src="/scenario-removed/proof.png" ${IMG}>`),
    images: ["hero.png", "proof.png", "stack.png"],
  },
  "scenario-mobile-hidden": {
    html: htmlPage(
      `<img src="/scenario-mobile-hidden/hero.png" ${IMG}><img src="/scenario-mobile-hidden/proof.png" ${IMG}><img class="d" src="/scenario-mobile-hidden/stack.png" ${IMG}>`,
      "<style>@media (max-width:600px){.d{display:none}}</style>",
    ),
    images: ["hero.png", "proof.png", "stack.png"],
  },
  "scenario-restored": {
    html: htmlPage(`<img src="/scenario-restored/hero.png" ${IMG}><img src="/scenario-restored/proof.png" ${IMG}><img src="/scenario-restored/stack.png" ${IMG}>`),
    images: ["hero.png", "proof.png", "stack.png"],
  },
};

let server: Awaited<ReturnType<typeof startProbeFixtureServer>>;
beforeAll(async () => { server = await startProbeFixtureServer(pages); });
afterAll(async () => { await server.close(); });

async function checkPage(slug: keyof typeof pages) {
  const raw = await runImageMapCheck({
    pageUrl: `${server.origin}/${slug}`,
    slug,
    placement: { mapped, logos: [], rawMaterial: [], unmapped: [] },
    pageSourceHashes,
    assetManifestSha256,
    attemptStartedAt,
    probe: (url) => collectVisibleImages(url),
  });
  return finalizeImageMapCheck(raw, { attemptStartedAt, assetManifestSha256, pageSourceHashes })!;
}

function expressRun(check: Awaited<ReturnType<typeof checkPage>>): Run {
  return {
    id: "scenario", slug: "scenario", brief: "brief", createdAt: attemptStartedAt, status: "approved",
    currentRound: null, messages: [], currentStage: 5,
    stages: [{
      number: 5, title: "5", ownerSlug: "daniel-lp-designer", status: "running", output: "", feedbackHistory: [],
      subTasks: [
        { id: "5.2", title: "assets", status: "approved", output: "", feedbackHistory: [], assetManifestSha256 },
        { id: "5.3", title: "build", status: "awaiting-decision", output: "", feedbackHistory: [],
          startedAt: attemptStartedAt, assetManifestSha256, pageSourceHashes, imageMapCheck: check,
          designReview: { schemaVersion: 1, passed: true, failing: [], silent: [], checkedAt: attemptStartedAt } },
      ],
    }],
  } as Run;
}

describe("image map acceptance scenario", { timeout: 240_000 }, () => {
  it("1. a removed mapped image fails the check, reaches the revise prompt and stops express", async () => {
    const check = await checkPage("scenario-removed");
    expect(check.passed).toBe(false);
    expect(check.missing).toEqual([{ file: "stack.png", section: "Stack", proves: "״מה מקבלים״", widths: [390, 1280] }]);

    const critique = imageMapCritique(check)!;
    expect(critique.verdict).toBe("fail");
    expect(splitCritiques([critique]).failing).toEqual([critique]);
    const revise = buildRevisePrompt({ pagePath: "src/app/scenario/page.tsx", slug: "scenario", failing: [critique] });
    expect(revise).toContain("stack.png");
    expect(revise).toContain("״מה מקבלים״");
    expect(expressAutoApproveViolation(expressRun(check), 5, "5.3")).not.toBeNull();
  });

  it("2. an image hidden only on mobile is caught at 390 only", async () => {
    const check = await checkPage("scenario-mobile-hidden");
    expect(check.passed).toBe(false);
    expect(check.missing).toEqual([{ file: "stack.png", section: "Stack", proves: "״מה מקבלים״", widths: [390] }]);
    expect(expressAutoApproveViolation(expressRun(check), 5, "5.3")).not.toBeNull();
  });

  it("3. restoring the image passes the check and lets express approve", async () => {
    const check = await checkPage("scenario-restored");
    expect(check).toMatchObject({ passed: true, missing: [] });
    expect(imageMapCritique(check)).toBeNull();
    expect(expressAutoApproveViolation(expressRun(check), 5, "5.3")).toBeNull();
  });

  it("4. a check that no longer matches the final page source is not trusted", async () => {
    const check = await checkPage("scenario-restored");
    const stale = finalizeImageMapCheck(check, { attemptStartedAt, assetManifestSha256, pageSourceHashes: { "page.tsx": "9".repeat(64) } })!;
    expect(stale.passed).toBe(false);
    expect(stale.failure).toBe("הדף השתנה אחרי בדיקת המפה");
    const finalCritique = imageMapCritique(stale)!;
    expect(splitCritiques([finalCritique]).failing).toEqual([finalCritique]);
    expect(finalCritique.text).toContain(stale.failure);
  });
});

/**
 * runStage5LpBuild prepares a git worktree and spawns Next, so this ordering is
 * guarded on the source. ensurePreviewServer reuses a preview already open on
 * the same worktree; every build must therefore be preceded by stopPreview,
 * or round 1 would render the previous build under a check sealed to the new one.
 */
describe("stage 5.3 preview freshness", () => {
  it("stops the preview before every landing build, including an attempt's first", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "orchestrator/runStage5LpBuild.ts"), "utf8");
    const bodyStart = source.indexOf("export async function runStage5LpBuild(");
    expect(bodyStart).toBeGreaterThanOrEqual(0);
    const body = source.slice(bodyStart);
    const builds = [...body.matchAll(/await runLandingBuild\(/g)].map((match) => match.index!);
    expect(builds.length).toBeGreaterThanOrEqual(2);
    for (const buildAt of builds) {
      const before = body.slice(0, buildAt);
      expect(before.lastIndexOf("stopPreview();"), `build at offset ${buildAt}`).toBeGreaterThan(before.lastIndexOf("ensurePreviewServer("));
    }
  });
});
