import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { SubTask } from "@/types";
import { reopenSubTask } from "@/orchestrator/stageRegistry";
import { hashPageSourceManifest } from "@/orchestrator/pagePostflight";
import {
  imageMapCheckIsCurrent,
  missingMappedImages,
  renderDesertSummary,
  renderDesertWarning,
  runImageMapCheck,
  type VisibilityProbe,
} from "@/orchestrator/imageMapCheck";

const page = { pageUrl: "http://127.0.0.1:4322/demo-page", slug: "demo-page" };
const mapped = [
  { file: "hero.webp", section: "Hero", proves: "״30 לקוחות״" },
  { file: "proof.webp", section: "הוכחה", proves: "״50 אלף עוקבים״" },
];
const item = (url: string, overrides: Partial<VisibilityProbe["390"][number]> = {}) => ({
  kind: "img" as const, url, loaded: true, visible: true, width: 300, height: 200, areaRatio: 1, ...overrides,
});
const sources = { "page.tsx": "1".repeat(64) };
const base = {
  ...page,
  pageSourceHashes: sources,
  assetManifestSha256: "a".repeat(64),
  attemptStartedAt: "2026-09-13T10:00:00.000Z",
};

describe("missingMappedImages", () => {
  it("requires every mapped image to be loaded and visible at each width separately", () => {
    const probe: VisibilityProbe = {
      "390": [
        item("http://127.0.0.1:4322/_next/image?url=%2Fdemo-page%2Fhero.webp&w=828&q=75"),
        item("http://127.0.0.1:4322/demo-page/proof.webp", { visible: false }),
      ],
      "1280": [
        item("http://127.0.0.1:4322/demo-page/hero.webp"),
        item("http://127.0.0.1:4322/demo-page/proof.webp"),
      ],
    };
    expect(missingMappedImages(probe, mapped, page)).toEqual([
      { file: "proof.webp", section: "הוכחה", proves: "״50 אלף עוקבים״", widths: [390] },
    ]);
  });

  it("does not let a similarly named file or a broken load satisfy a mapped image", () => {
    const probe: VisibilityProbe = {
      "390": [item("http://127.0.0.1:4322/demo-page/other-hero.webp"), item("http://127.0.0.1:4322/demo-page/proof.webp")],
      "1280": [item("http://127.0.0.1:4322/demo-page/hero.webp", { loaded: false }), item("http://127.0.0.1:4322/demo-page/proof.webp")],
    };
    expect(missingMappedImages(probe, mapped, page)).toEqual([
      { file: "hero.webp", section: "Hero", proves: "״30 לקוחות״", widths: [390, 1280] },
    ]);
  });
});

describe("runImageMapCheck", () => {
  it("passes without probing when nothing is mapped (upsell and squeeze pages)", async () => {
    const check = await runImageMapCheck({
      ...base,
      placement: { mapped: [], logos: ["logo.webp"], rawMaterial: [], unmapped: [] },
      probe: async () => { throw new Error("must not probe"); },
    });
    expect(check).toMatchObject({ passed: true, mappedCount: 0, missing: [] });
    expect(check.pageSourceManifestSha256).toBe(hashPageSourceManifest(sources));
  });

  it("fails closed when the probe itself fails", async () => {
    const check = await runImageMapCheck({
      ...base,
      placement: { mapped, logos: [], rawMaterial: [], unmapped: [] },
      probe: async () => { throw new Error("browser crashed"); },
    });
    expect(check.passed).toBe(false);
    expect(check.failure).toContain("browser crashed");
  });
});

describe("imageMapCheckIsCurrent", () => {
  const check = {
    schemaVersion: 1 as const, passed: true, mappedCount: 1, missing: [],
    attemptStartedAt: base.attemptStartedAt, assetManifestSha256: base.assetManifestSha256,
    pageSourceManifestSha256: hashPageSourceManifest(sources), checkedAt: "2026-09-13T10:05:00.000Z",
  };
  const current = { attemptStartedAt: base.attemptStartedAt, assetManifestSha256: base.assetManifestSha256, pageSourceHashes: sources };

  it("accepts a check bound to the current attempt, manifest and page source", () => {
    expect(imageMapCheckIsCurrent(check, current)).toBeNull();
  });

  it("rejects a missing check, another attempt, another manifest or a changed page", () => {
    expect(imageMapCheckIsCurrent(undefined, current)).not.toBeNull();
    expect(imageMapCheckIsCurrent(check, { ...current, attemptStartedAt: "2026-09-13T11:00:00.000Z" })).not.toBeNull();
    expect(imageMapCheckIsCurrent(check, { ...current, assetManifestSha256: "c".repeat(64) })).not.toBeNull();
    expect(imageMapCheckIsCurrent(check, { ...current, pageSourceHashes: { "page.tsx": "2".repeat(64) } })).not.toBeNull();
  });
});

describe("imageMapCheck reset", () => {
  it("is cleared when a sub-task is reopened", () => {
    const build: SubTask = {
      id: "5.3", title: "Build", status: "awaiting-decision", output: "x", feedbackHistory: [],
      designReview: { schemaVersion: 1, passed: true, failing: [], silent: [], checkedAt: base.attemptStartedAt },
      imageMapCheck: {
        schemaVersion: 1, passed: true, mappedCount: 0, missing: [],
        attemptStartedAt: base.attemptStartedAt, assetManifestSha256: "a".repeat(64),
        pageSourceManifestSha256: "b".repeat(64), checkedAt: base.attemptStartedAt,
      },
    };
    const stages = reopenSubTask(
      [{ number: 5, title: "5", ownerSlug: "daniel-lp-designer", status: "running", output: "", feedbackHistory: [], subTasks: [build] }],
      5,
      "5.3",
    );
    expect(stages[0].subTasks[0].imageMapCheck).toBeUndefined();
    expect(stages[0].subTasks[0].designReview).toBeUndefined();
  });

  it("is cleared by feedback rewinds and at the start of every 5.3 attempt", async () => {
    const read = (file: string) => fs.readFile(path.join(process.cwd(), file), "utf8");
    const bodyOf = (source: string, marker: string) => source.slice(source.indexOf(marker), source.indexOf(marker) + 1_500);
    expect(bodyOf(await read("orchestrator/executionOrder.ts"), "function resetSubTaskForFeedback")).toContain("imageMapCheck: undefined");
    expect(bodyOf(await read("orchestrator/stageRegistry.ts"), "function clearSubTaskWork")).toContain("imageMapCheck: undefined");
    expect(bodyOf(await read("orchestrator/runStage5LpBuild.ts"), "const SUB_ID = \"5.3\"")).toContain("imageMapCheck: undefined");
  });
});

describe("renderDesertWarning", () => {
  it("is silent below the threshold and a non-blocking warning at or above it", () => {
    expect(renderDesertWarning({ pageScreens: 20, worstScreens: 2.56, atScreen: 21 })).toBe("");
    const warning = renderDesertWarning({ pageScreens: 17.8, worstScreens: 4.01, atScreen: 9.9 });
    expect(warning).toContain("4.01 מסכים");
    expect(warning).toContain("אזהרה בלבד");
  });

  it("never reports an incomplete measurement as fine", () => {
    expect(renderDesertSummary({ kind: "incomplete", reason: "timeout" })).toBe("⚠️ המדידה לא הושלמה: timeout");
    expect(renderDesertSummary({ kind: "warning", text: "4.01 מסכים" })).toBe("4.01 מסכים");
    expect(renderDesertSummary({ kind: "ok" })).toBe("תקין");
  });
});
