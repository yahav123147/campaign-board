import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

vi.mock("@/orchestrator/spawnAgent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/orchestrator/spawnAgent")>()),
  spawnAgent: vi.fn(async () => {
    throw new Error("stop after capturing the prompt");
  }),
}));

vi.mock("@/orchestrator/loadAgents", () => ({
  loadAgents: vi.fn(async () => [{
    slug: "daniel-lp-designer",
    name: "דניאל",
    role: "מעצב",
    color: "#000",
    order: 1,
    active: true,
    systemPrompt: "אתה דניאל.",
    avatarPath: "/tmp/avatar.png",
  }]),
}));

// Same stubbing as tests/orchestrator/stage5AssetsDirect.test.ts: the file
// bookkeeping is faked and validateAssetFolderSnapshot is a plain spy, so a
// test can hand back the exact manifest the coverage assertion must judge.
vi.mock("@/orchestrator/assetQuality", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/orchestrator/assetQuality")>()),
  ensureManagedDirectory: vi.fn(async () => {}),
  recoverCutoutTransactions: vi.fn(async () => {}),
  readReusableAssetHashes: vi.fn(async () => ({})),
  readSealedApprovedAssetHashes: vi.fn(async () => ({})),
  snapshotAssetHashes: vi.fn(async () => ({})),
  hasValidAssetPlan: vi.fn(async () => false),
  validateAssetFolderSnapshot: vi.fn(),
}));

// The renderer owns a real browser and a real python. Mocked here: this file
// tests the wiring around it, not the render itself (Task 15 covers that).
vi.mock("@/orchestrator/mockupRenderer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/orchestrator/mockupRenderer")>()),
  renderMockups: vi.fn(),
}));

vi.mock("@/orchestrator/liveProof", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/orchestrator/liveProof")>()),
  captureInstagramProof: vi.fn(),
}));

vi.mock("@/orchestrator/runStage7Creatives", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/orchestrator/runStage7Creatives")>()),
  resolvePython: vi.fn(async () => "python3"),
}));

import {
  assertMockupCoverage,
  MAX_RECEIPT_TEXT_BYTES,
  MockupCoverageError,
  receiptForRunState,
  renderMockupBasesBlock,
  runStage5Assets,
} from "@/orchestrator/runStage5Assets";
import { packagedMockupBasesDir, renderMockups } from "@/orchestrator/mockupRenderer";
import type { MockupRenderOutcome } from "@/orchestrator/mockupRenderer";
import { validateAssetFolderSnapshot } from "@/orchestrator/assetQuality";
import type { AssetManifest, AssetManifestEntry } from "@/orchestrator/assetQuality";
import { spawnAgent } from "@/orchestrator/spawnAgent";
import { __resetRegistryForTests, createRun, flushPersistence, getRun } from "@/orchestrator/runRegistry";
import { eventBus } from "@/orchestrator/eventBus";
import { createRunDir, loadRunState } from "@/lib/runStore";
import { validateClientProfile } from "@/config/clientProfile";
import { initializeStages } from "@/orchestrator/initializeStages";
import type { AssetType, Run, SSEEvent } from "@/types";
import { seedPackagedMockupRegions } from "./mockupBaseRegions";
import { MAX_RENDER_REGIONS } from "@/lib/mockupContract";

const ATTEMPT = "attempt-under-test";
const MOCKUP_SHA = "e".repeat(64);

const REQUIRED_MOCKUPS = [
  { name: "module-1", section: "Stack", proves: "מה מקבלים בפרק הראשון", base: "chapter" },
];

const BRIEF = "כיוון עיצוב לאקמה.\n```json\n" + JSON.stringify({
  playbook: "Dark Premium",
  imageMap: [{ harvestFile: "raw/01-portrait.jpg", section: "Hero", proves: "המנחה שבנתה את השיטה" }],
  requiredMockups: REQUIRED_MOCKUPS,
}) + "\n```";

/** The same brief with no mockups required at all. */
const BRIEF_NO_MOCKUPS = "כיוון עיצוב לאקמה.\n```json\n" + JSON.stringify({
  playbook: "Dark Premium",
  imageMap: [{ harvestFile: "raw/01-portrait.jpg", section: "Hero", proves: "המנחה שבנתה את השיטה" }],
}) + "\n```";

/** The plan the agent leaves behind: one covered photo and one mockup to render. */
const PLAN_ENTRIES = [
  { file: "hero.webp", kind: "photo", harvestFile: "raw/01-portrait.jpg", section: "Hero", proves: "המנחה שבנתה את השיטה" },
  {
    file: "module-1-mockup.webp",
    kind: "mockup",
    inputs: ["hero.webp"],
    screens: ["ch1-laptop"],
    render: { base: "chapter", map: { "1": "ch1-laptop" } },
    section: "Stack",
    proves: "מה מקבלים בפרק הראשון",
  },
];

async function writePlan(assetsDir: string, assets: unknown[] = PLAN_ENTRIES): Promise<void> {
  await fs.writeFile(
    path.join(assetsDir, "asset-plan.json"),
    JSON.stringify({ schemaVersion: 1, attemptId: currentAttemptId(), assets }),
  );
}

/** The attempt id the run generated, read off the plan the code wrote. */
let attemptIdOfRun = ATTEMPT;
function currentAttemptId(): string {
  return attemptIdOfRun;
}

function entry(over: Partial<AssetManifestEntry>): AssetManifestEntry {
  return {
    file: "x.webp",
    kind: "photo",
    status: "approved",
    sha256: "a".repeat(64),
    problems: [],
    previewable: true,
    ...over,
  };
}

function manifestOf(assets: AssetManifestEntry[], attemptId = ATTEMPT): AssetManifest {
  return {
    schemaVersion: 1,
    generatedAt: "2026-09-16T10:05:00.000Z",
    attemptId,
    ignoredFiles: [],
    assets,
  };
}

/** A manifest that covers the image map and carries the required mockup. */
function coveredAssets(over: Partial<AssetManifestEntry> = {}): AssetManifestEntry[] {
  return [
    entry({ file: "hero.webp", harvestFile: "raw/01-portrait.jpg", section: "Hero", proves: "המנחה שבנתה את השיטה" }),
    entry({
      file: "module-1-mockup.webp",
      kind: "mockup",
      sha256: MOCKUP_SHA,
      section: "Stack",
      proves: "מה מקבלים בפרק הראשון",
      ...over,
    }),
  ];
}

function receipt(over: Partial<MockupRenderOutcome> = {}, rowOver: Record<string, unknown> = {}): MockupRenderOutcome {
  return {
    acceptedScreens: ["ch1-laptop"],
    schemaVersion: 1,
    attemptId: ATTEMPT,
    baseSha256: { chapter: "c".repeat(64) },
    mockups: [{
      file: "module-1-mockup.webp",
      screensSha256: { "ch1-laptop": "d".repeat(64) },
      outputSha256: MOCKUP_SHA,
      status: "ok" as const,
      ...rowOver,
    }],
    renderedAt: "2026-09-16T10:05:00.000Z",
    ...over,
  };
}

function snapshot(assets: AssetManifestEntry[], attemptId = ATTEMPT) {
  return {
    manifest: manifestOf(assets, attemptId),
    manifestSha256: "b".repeat(64),
    assetBytes: new Map<string, Buffer>(),
  };
}

describe("assertMockupCoverage", () => {
  const required = REQUIRED_MOCKUPS as { name: string; section: string; proves: string; base: "chapter" | "devices" }[];

  it("passes when every required mockup is in the manifest with a matching ok receipt row", () => {
    expect(() => assertMockupCoverage(manifestOf(coveredAssets()), receipt(), required)).not.toThrow();
  });

  it("is a no-op for a run that requires no mockups, receipt or not", () => {
    expect(() => assertMockupCoverage(manifestOf([]), undefined, [])).not.toThrow();
  });

  it("names the mockup that has no manifest entry with that section and claim", () => {
    const assets = coveredAssets({ section: "אחר", proves: "משהו" });
    expect(() => assertMockupCoverage(manifestOf(assets), receipt(), required))
      .toThrow(/module-1/);
  });

  it("refuses a rejected mockup entry", () => {
    const assets = coveredAssets({ status: "rejected", problems: ["מוקאפ מניסיון קודם או ללא רינדור"] });
    expect(() => assertMockupCoverage(manifestOf(assets), receipt(), required)).toThrow(MockupCoverageError);
  });

  it("accepts a review-required mockup: the human decides on the sheet", () => {
    const assets = coveredAssets({ status: "review-required" });
    expect(() => assertMockupCoverage(manifestOf(assets), receipt(), required)).not.toThrow();
  });

  it("refuses a manifest whose mockup digest is not the one the receipt recorded", () => {
    const assets = coveredAssets({ sha256: "f".repeat(64) });
    expect(() => assertMockupCoverage(manifestOf(assets), receipt(), required)).toThrow(MockupCoverageError);
  });

  it("refuses a receipt row that is rejected, and one from another attempt", () => {
    expect(() => assertMockupCoverage(
      manifestOf(coveredAssets()),
      receipt({}, { status: "rejected", outputSha256: undefined, reason: "הרינדור לא זמין" }),
      required,
    )).toThrow(MockupCoverageError);
    expect(() => assertMockupCoverage(
      manifestOf(coveredAssets()),
      receipt({ attemptId: "attempt-previous" }),
      required,
    )).toThrow(MockupCoverageError);
  });

  it("gives each required row its own entry: two rows with one claim need two mockups", () => {
    const twoRows = [
      { ...REQUIRED_MOCKUPS[0]!, name: "module-1" },
      { ...REQUIRED_MOCKUPS[0]!, name: "module-2" },
    ] as typeof required;
    const second = entry({
      file: "module-2-mockup.webp",
      kind: "mockup",
      sha256: "b".repeat(64),
      section: "Stack",
      proves: "מה מקבלים בפרק הראשון",
    });
    const twoReceipts = receipt();
    twoReceipts.mockups.push({
      file: "module-2-mockup.webp",
      screensSha256: {},
      outputSha256: "b".repeat(64),
      status: "ok",
    });

    // One rendered mockup cannot satisfy both rows.
    expect(() => assertMockupCoverage(manifestOf(coveredAssets()), twoReceipts, twoRows))
      .toThrow(/module-2/);
    // With a second rendered mockup, both rows are covered.
    expect(() => assertMockupCoverage(manifestOf([...coveredAssets(), second]), twoReceipts, twoRows))
      .not.toThrow();
  });

  it("refuses a run with required mockups and no receipt at all", () => {
    expect(() => assertMockupCoverage(manifestOf(coveredAssets()), undefined, required)).toThrow(MockupCoverageError);
  });
});

describe("receiptForRunState", () => {
  it("keeps the whole receipt's free text inside one budget, not only each field", () => {
    const chatty = {
      ...receipt(),
      warnings: Array.from({ length: 40 }, (_, index) => `אזהרה ${index} ${"ט".repeat(600)}`),
      mockups: Array.from({ length: 80 }, (_, index) => ({
        file: `mockup-${index}.webp`,
        screensSha256: {},
        status: "rejected" as const,
        reason: "ס".repeat(900),
        notes: Array.from({ length: 40 }, (_, note) => `הערה ${note} ${"נ".repeat(600)}`),
      })),
    };

    const stored = receiptForRunState(chatty);

    // Every row survives, with its file name and status: only the text is cut.
    expect(stored.mockups).toHaveLength(80);
    expect(stored.mockups[79]?.file).toBe("mockup-79.webp");
    const text = stored.mockups.flatMap((row) => [row.reason ?? "", ...(row.notes ?? [])])
      .concat(stored.warnings ?? [])
      .join("");
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(MAX_RECEIPT_TEXT_BYTES);
    // The budget is spent in order, so the first rows keep their explanation.
    expect(stored.mockups[0]?.reason?.length).toBe(500);
  });

  // I4: the run-state validator refuses a hash record over 512 entries, and a
  // receipt it refuses makes every later save of the run fail silently, the
  // 5.2 gate decision included. The contract's own ceiling is the clamp.
  it("clamps a row's screen hashes to the screens the plan may declare", () => {
    const many = Object.fromEntries(
      Array.from({ length: 600 }, (_, index) => [`ch${index}-laptop`, String(index % 10).repeat(64)]),
    );
    const flooded = {
      ...receipt(),
      mockups: [{ ...receipt().mockups[0]!, screensSha256: many }],
    };

    const stored = receiptForRunState(flooded);

    const hashes = Object.entries(stored.mockups[0]!.screensSha256);
    expect(hashes).toHaveLength(MAX_RENDER_REGIONS);
    // The first declared screens are the ones kept, not an arbitrary slice.
    expect(hashes[0]![0]).toBe("ch0-laptop");
  });

  it("carries the digests and statuses through untouched", () => {
    const stored = receiptForRunState(receipt());

    expect(stored.mockups[0]?.outputSha256).toBe(MOCKUP_SHA);
    expect(stored.mockups[0]?.status).toBe("ok");
    expect(stored.baseSha256).toEqual({ chapter: "c".repeat(64) });
    // The renderer's accepted screens are the caller's business, not the
    // record's: they never reach run state.
    expect("acceptedScreens" in stored).toBe(false);
  });
});

let runsDir: string;

function readyProfile() {
  return validateClientProfile({
    schemaVersion: 1,
    tenant: { id: "acme", displayName: "Acme", locale: "he-IL", timezone: "Asia/Jerusalem" },
    brand: { publicName: "Acme", facts: ["עובדה מאומתת"] },
    policies: {
      contentRules: [],
      advertisingRules: [],
      operationalRules: [],
      capabilities: { landingPageBuild: true, metaPixelRead: false, metaCampaignCreatePaused: false },
    },
    landing: {
      workspacePath: path.join(os.tmpdir(), "council-landing-workspace"),
      designStandardPath: "design/standard.md",
      qaScriptPath: "scripts/qa.mjs",
    },
  });
}

function directRun(id: string, pageTypesDir: string, designBrief: string, assetType: AssetType = "sales-page"): Run {
  const stages = initializeStages(assetType, "direct").map((stage) => (stage.number < 5
    ? {
        ...stage,
        status: "approved" as const,
        output: `פלט ${stage.number}`,
        subTasks: stage.subTasks.map((sub) => ({
          ...sub,
          status: "approved" as const,
          output: sub.id === "3" ? designBrief : `פלט ${sub.id}`,
        })),
      }
    : { ...stage, status: "running" as const }));
  return {
    id,
    slug: "sales",
    brief: "בריף לבדיקה של אקמה https://acme.example",
    createdAt: "2026-09-16T10:00:00.000Z",
    status: "approved",
    currentRound: null,
    messages: [],
    currentStage: 5,
    assetType,
    pipeline: "direct",
    clientProfile: readyProfile(),
    pageTypesDir,
    stages,
  };
}

async function prepareRun(id: string, designBrief = BRIEF, assetType: AssetType = "sales-page"): Promise<string> {
  const runDir = await createRunDir(id);
  await fs.mkdir(path.join(runDir, "assets"), { recursive: true });
  await fs.mkdir(path.join(runDir, "harvest", "raw"), { recursive: true });
  await fs.writeFile(path.join(runDir, "harvest", "raw", "01-portrait.jpg"), "jpeg-bytes");
  createRun(directRun(id, path.join(runsDir, "page-types"), designBrief, assetType));
  return runDir;
}

function subTask52(runId: string) {
  return getRun(runId)?.stages?.find((s) => s.number === 5)?.subTasks.find((st) => st.id === "5.2");
}

/**
 * The agent's part of an attempt: it writes the plan (with the attempt id the
 * run generated) and the finished files, then returns or crashes.
 */
function agentWrites(runDir: string, crash?: string, assets: unknown[] = PLAN_ENTRIES) {
  return vi.mocked(spawnAgent).mockImplementationOnce(async (options) => {
    attemptIdOfRun = /"attemptId": "([^"]+)"/.exec(options.prompt)![1]!;
    await fs.writeFile(path.join(runDir, "assets", "hero.webp"), "webp-bytes-1");
    await fs.writeFile(path.join(runDir, "assets", "module-1-mockup.webp"), "webp-bytes-2");
    await writePlan(path.join(runDir, "assets"), assets);
    if (crash) throw new Error(crash);
    return { fullText: "סיימתי", exitCode: 0, durationMs: 1 };
  });
}

beforeEach(async () => {
  runsDir = await fs.mkdtemp(path.join(os.tmpdir(), "council-stage5-mockups-"));
  process.env.RUNS_DIR_OVERRIDE = runsDir;
  // The 5.2 prompt reads the base frames' regions: the seeded cache keeps this
  // suite off detect_screens.py and off the real cache directory.
  process.env.CAMPAIGN_COUNCIL_MOCKUP_CACHE_DIR = path.join(runsDir, "mockup-cache");
  await seedPackagedMockupRegions();
  __resetRegistryForTests();
  attemptIdOfRun = ATTEMPT;
  vi.mocked(spawnAgent).mockReset();
  vi.mocked(validateAssetFolderSnapshot).mockReset();
  vi.mocked(renderMockups).mockReset();
});

afterEach(async () => {
  await flushPersistence();
  __resetRegistryForTests();
  delete process.env.RUNS_DIR_OVERRIDE;
  delete process.env.CAMPAIGN_COUNCIL_MOCKUP_CACHE_DIR;
  await fs.rm(runsDir, { recursive: true, force: true, maxRetries: 5 });
});

describe("stage 5.2 renders the declared mockups", () => {
  it("renders once, before validation, with the declared mockup entries and the receipt on the sub-task", async () => {
    const id = "2026-09-16-mockups-main-path";
    const runDir = await prepareRun(id);
    agentWrites(runDir);
    const order: string[] = [];
    vi.mocked(renderMockups).mockImplementation(async () => {
      order.push("render");
      return receipt({ attemptId: attemptIdOfRun });
    });
    vi.mocked(validateAssetFolderSnapshot).mockImplementation(async () => {
      order.push("validate");
      return snapshot(coveredAssets(), attemptIdOfRun);
    });

    await runStage5Assets(id, runDir);

    expect(renderMockups).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["render", "validate"]);
    const args = vi.mocked(renderMockups).mock.calls[0]![0];
    // Only the mockup entries of the plan, never the photos.
    expect(args.entries.map((candidate) => candidate.file)).toEqual(["module-1-mockup.webp"]);
    expect(args.assetsDir).toBe(path.join(runDir, "assets"));
    expect(args.attemptId).toBe(attemptIdOfRun);
    expect(args.basesDir).toBe(packagedMockupBasesDir());
    expect(args.python).toBe("python3");
    expect(args.deadline).toBeGreaterThan(Date.now());
    // Validation is handed the receipt of this attempt and the screens that
    // passed the render boundaries, so nothing else under screens/ is excused.
    const options = vi.mocked(validateAssetFolderSnapshot).mock.calls[0]![1]!;
    expect(options.mockupReceipt?.receipt.attemptId).toBe(attemptIdOfRun);
    // Straight from the renderer: the wiring never re-reads the screens folder.
    expect(options.mockupReceipt?.acceptedScreens).toEqual(["ch1-laptop"]);
    expect(subTask52(id)?.mockupRender?.mockups[0]?.file).toBe("module-1-mockup.webp");
    expect(subTask52(id)?.status).toBe("awaiting-decision");
  });

  // Minor 8: nothing reads the persisted receipt on the operator's behalf. A
  // screen screenshotted before its fonts settled looks perfect and carries
  // fallback typography, so the note has to reach the message at the gate.
  it("shows the render's notes and warnings in the message the gate displays", async () => {
    const id = "2026-09-16-mockups-notes-surface";
    const runDir = await prepareRun(id);
    agentWrites(runDir);
    vi.mocked(renderMockups).mockImplementation(async () => ({
      ...receipt({ attemptId: attemptIdOfRun }),
      warnings: ["לא ניתן למחוק את תיקיית הרינדור"],
      mockups: [{
        ...receipt().mockups[0]!,
        notes: ["ch1-laptop: רונדר בלי להמתין לגופנים"],
      }],
    }));
    vi.mocked(validateAssetFolderSnapshot).mockImplementation(async () => snapshot(coveredAssets(), attemptIdOfRun));

    await runStage5Assets(id, runDir);

    const output = subTask52(id)?.output ?? "";
    expect(output).toContain("2 הערות מהרינדור");
    expect(output).toContain("module-1-mockup.webp: ch1-laptop: רונדר בלי להמתין לגופנים");
    expect(output).toContain("לא ניתן למחוק את תיקיית הרינדור");
    // And in the stage log, where the full list lives.
    const log = await fs.readFile(path.join(runDir, "logs", "stage-5-2-assets.log"), "utf8").catch(() => "");
    expect(log).toContain("MOCKUP RENDER NOTES");
  });

  it("says nothing about notes when the render had none", async () => {
    const id = "2026-09-16-mockups-no-notes";
    const runDir = await prepareRun(id);
    agentWrites(runDir);
    vi.mocked(renderMockups).mockImplementation(async () => receipt({ attemptId: attemptIdOfRun }));
    vi.mocked(validateAssetFolderSnapshot).mockImplementation(async () => snapshot(coveredAssets(), attemptIdOfRun));

    await runStage5Assets(id, runDir);

    expect(subTask52(id)?.output ?? "").not.toContain("הערות מהרינדור");
  });

  it("never starts the renderer for a plan that declares no mockup to render", async () => {
    const id = "2026-09-16-mockups-none-declared";
    // A squeeze page: its template asks for no mockups, so the brief carries
    // no requiredMockups and the plan declares none either.
    const runDir = await prepareRun(id, BRIEF_NO_MOCKUPS, "squeeze-page");
    agentWrites(runDir, undefined, [PLAN_ENTRIES[0]]);
    vi.mocked(validateAssetFolderSnapshot).mockImplementation(async () => snapshot([
      entry({ file: "hero.webp", harvestFile: "raw/01-portrait.jpg", section: "Hero", proves: "המנחה שבנתה את השיטה" }),
    ], attemptIdOfRun));

    await runStage5Assets(id, runDir);

    expect(renderMockups).not.toHaveBeenCalled();
    // The folder is judged exactly as it was before Task 16.
    expect(validateAssetFolderSnapshot).toHaveBeenCalledTimes(1);
    expect(vi.mocked(validateAssetFolderSnapshot).mock.calls[0]![1]!.mockupReceipt).toBeUndefined();
    expect(subTask52(id)?.mockupRender).toBeUndefined();
    expect(subTask52(id)?.status).toBe("awaiting-decision");
  });

  it("stores a receipt run state can hold, with the script's free text clamped", async () => {
    const id = "2026-09-16-mockups-long-notes";
    const runDir = await prepareRun(id);
    agentWrites(runDir);
    vi.mocked(renderMockups).mockImplementation(async () => ({
      ...receipt({ attemptId: attemptIdOfRun }),
      warnings: Array.from({ length: 40 }, (_, index) => `אזהרה ${index} ${"ט".repeat(600)}`),
      mockups: [{
        ...receipt().mockups[0]!,
        reason: "ס".repeat(900),
        notes: Array.from({ length: 40 }, (_, index) => `הערה ${index} ${"נ".repeat(600)}`),
      }],
    }));
    vi.mocked(validateAssetFolderSnapshot).mockImplementation(async () => snapshot(coveredAssets(), attemptIdOfRun));

    await runStage5Assets(id, runDir);

    // run.json is shape-validated on every write: a chatty render script must
    // cost a truncated note, never the ability to save the run.
    const stored = subTask52(id)?.mockupRender;
    expect(stored?.warnings).toHaveLength(32);
    expect(stored?.warnings?.[0]!.length).toBe(500);
    expect(stored?.mockups[0]?.notes).toHaveLength(32);

    expect(stored?.mockups[0]?.reason?.length).toBe(500);
    // The digests the later checks read are untouched.
    expect(stored?.mockups[0]?.outputSha256).toBe(MOCKUP_SHA);
    expect(subTask52(id)?.status).toBe("awaiting-decision");
    // And it really survives a save and a load, validator included.
    await flushPersistence();
    const persisted = (await loadRunState(id))?.stages?.find((stage) => stage.number === 5)
      ?.subTasks.find((task) => task.id === "5.2");
    expect(persisted?.mockupRender?.mockups[0]?.outputSha256).toBe(MOCKUP_SHA);
    expect(persisted?.mockupRender?.warnings).toHaveLength(32);
  });

  it("saves a receipt whose rejected row carries the Hebrew file name the agent wrote", async () => {
    const id = "2026-09-16-mockups-unsafe-file-name";
    const runDir = await prepareRun(id);
    const unsafe = "מוקאפ-פרק-1.webp";
    agentWrites(runDir);
    // The renderer names a row after the plan entry, before any validation:
    // a file name that is not a portable asset name still reaches run state.
    vi.mocked(renderMockups).mockImplementation(async () => ({
      ...receipt({ attemptId: attemptIdOfRun }),
      mockups: [
        { file: unsafe, screensSha256: {}, status: "rejected" as const, reason: "שם קובץ המוקאפ אינו שם יחסי ובטוח" },
        receipt().mockups[0]!,
      ],
    }));
    vi.mocked(validateAssetFolderSnapshot).mockImplementation(async () => snapshot(coveredAssets(), attemptIdOfRun));

    await runStage5Assets(id, runDir);

    await flushPersistence();
    const persisted = (await loadRunState(id))?.stages?.find((stage) => stage.number === 5)
      ?.subTasks.find((task) => task.id === "5.2");
    // The run keeps persisting, and the rejected row is still readable.
    expect(persisted?.mockupRender?.mockups[0]).toMatchObject({ file: unsafe, status: "rejected" });
    expect(persisted?.status).toBe("awaiting-decision");
  });

  it("ends in error, with no sheet, when a rejected receipt row leaves a required mockup uncovered", async () => {
    const id = "2026-09-16-mockups-rejected-row";
    const runDir = await prepareRun(id);
    agentWrites(runDir);
    vi.mocked(renderMockups).mockImplementation(async () => receipt(
      { attemptId: attemptIdOfRun },
      { status: "rejected", outputSha256: undefined, reason: "הרינדור לא זמין" },
    ));
    // Validation rejects the entry on that receipt, exactly as the real
    // validateAssetFolderSnapshot does with a receipt row that is not ok.
    vi.mocked(validateAssetFolderSnapshot).mockImplementation(async () => snapshot(
      coveredAssets({ status: "rejected", problems: ["מוקאפ מניסיון קודם או ללא רינדור"] }),
      attemptIdOfRun,
    ));
    const events: SSEEvent[] = [];
    const unsubscribe = eventBus.subscribe(id, (event) => events.push(event));

    try {
      await expect(runStage5Assets(id, runDir)).rejects.toThrow(MockupCoverageError);
    } finally {
      unsubscribe();
    }

    expect(subTask52(id)?.status).toBe("error");
    expect(subTask52(id)?.errorMessage).toContain("module-1");
    expect(events.some((event) => event.type === "subtask-completed")).toBe(false);
    expect(events.some((event) => event.type === "subtask-error")).toBe(true);
  });

  it("renders once per attempt: the salvage path reuses the render, it does not start a second one", async () => {
    const id = "2026-09-16-mockups-render-once";
    const runDir = await prepareRun(id);
    agentWrites(runDir);
    vi.mocked(renderMockups).mockImplementation(async () => receipt({ attemptId: attemptIdOfRun }));
    // The main path renders and then fails in validation; the salvage path
    // must judge the folder against the receipt that already exists, not
    // start a second browser under a brand new deadline.
    vi.mocked(validateAssetFolderSnapshot)
      .mockImplementationOnce(async () => { throw new Error("האימות נפל"); })
      .mockImplementation(async () => snapshot(coveredAssets(), attemptIdOfRun));

    await runStage5Assets(id, runDir);

    expect(renderMockups).toHaveBeenCalledTimes(1);
    // The salvage still validated against this attempt's receipt.
    const salvaged = vi.mocked(validateAssetFolderSnapshot).mock.calls[1]![1]!;
    expect(salvaged.mockupReceipt?.receipt.attemptId).toBe(attemptIdOfRun);
    expect(subTask52(id)?.status).toBe("awaiting-decision");
  }, 30_000);

  it("does not retry a render that failed, and reports it once", async () => {
    const id = "2026-09-16-mockups-render-failure-once";
    const runDir = await prepareRun(id);
    agentWrites(runDir);
    vi.mocked(renderMockups).mockRejectedValue(new Error("רינדור המוקאפים חרג מהזמן שהוקצב"));
    vi.mocked(validateAssetFolderSnapshot).mockImplementation(async () => snapshot(coveredAssets(), attemptIdOfRun));

    await expect(runStage5Assets(id, runDir)).rejects.toThrow("חרג מהזמן שהוקצב");

    expect(renderMockups).toHaveBeenCalledTimes(1);
    expect(subTask52(id)?.status).toBe("error");
  });

  it("renders on the salvage path too, and never salvages a mockup the receipt does not back", async () => {
    const id = "2026-09-16-mockups-salvage";
    const runDir = await prepareRun(id);
    agentWrites(runDir, "הסוכן נפל");
    vi.mocked(renderMockups).mockImplementation(async () => receipt({ attemptId: attemptIdOfRun }));
    // The salvaged folder still holds a mockup, but its bytes are not the ones
    // the receipt recorded: a file from an earlier attempt, never rescued.
    vi.mocked(validateAssetFolderSnapshot).mockImplementation(async () => snapshot(
      coveredAssets({ sha256: "f".repeat(64) }),
      attemptIdOfRun,
    ));
    const events: SSEEvent[] = [];
    const unsubscribe = eventBus.subscribe(id, (event) => events.push(event));

    try {
      await expect(runStage5Assets(id, runDir)).rejects.toThrow("הסוכן נפל");
    } finally {
      unsubscribe();
    }

    expect(renderMockups).toHaveBeenCalledTimes(1);
    expect(subTask52(id)?.status).toBe("error");
    expect(events.some((event) => event.type === "subtask-completed")).toBe(false);
    // The one message the operator reads says why the salvage was refused.
    expect(subTask52(id)?.errorMessage).toContain("הסוכן נפל");
    expect(subTask52(id)?.errorMessage).toContain("module-1");
  });
});

describe("the base listing in the 5.2 prompt", () => {
  it("lists the region ids and the exact screen size each one needs", () => {
    const block = renderMockupBasesBlock([
      { base: "chapter", regions: [{ id: 1, width: 2400, height: 3200 }] },
    ]);

    expect(block).toContain('- בסיס `chapter`: אזור "1" דורש מסך 2400x3200 פיקסלים.');
  });

  // I3: a frame bigger than the render ceiling is the operator's installation.
  // The prompt must not advertise a size the validator then drops, and it must
  // not invite the agent to produce screens that will all be rejected.
  it("tells the agent to leave a base frame the installation cannot render on", () => {
    const block = renderMockupBasesBlock([
      {
        base: "devices",
        regions: [],
        unusable: true,
        error: "מסגרת הבסיס גדולה מדי לרינדור: אזור 1 דורש מסך 4800x3000, מעל התקרה של 4096 פיקסלים לצלע",
      },
    ]);

    expect(block).toContain("לא ניתן לרנדר על המסגרת הזאת בהתקנה הזאת");
    expect(block).toContain("אזור 1 דורש מסך 4800x3000");
    expect(block).toContain("אל תצהיר על מוקאפ עם הבסיס הזה");
    // Not the unreadable-frame line, which invites screens that would be lost.
    expect(block).not.toContain("הצהר על המסכים ועל render כרגיל");
  });

  it("keeps the unreadable-frame line for a frame it simply could not read", () => {
    const block = renderMockupBasesBlock([
      { base: "devices", regions: [], error: "לא ניתן לזהות את המסכים במסגרת הבסיס" },
    ]);

    expect(block).toContain("לא ניתן לקרוא את אזורי המסגרת בריצה הזאת");
    expect(block).toContain("הצהר על המסכים ועל render כרגיל");
  });
});
