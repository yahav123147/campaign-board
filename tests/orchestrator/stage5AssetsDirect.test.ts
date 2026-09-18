import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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

// Same stubbing as tests/orchestrator/stage5AssetsWritePlan.test.ts: only the
// file-system bookkeeping is faked. validateAssetFolderSnapshot is a plain spy
// here so the coverage test can hand back a manifest that ignores the map.
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

// The live Instagram proof is the operator's own browser session: mocked here,
// never really launched. liveProofEnabled stays real, so a profile without the
// capability still proves the capture is not even attempted.
vi.mock("@/orchestrator/liveProof", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/orchestrator/liveProof")>()),
  captureInstagramProof: vi.fn(),
}));

// resolvePython picks the sandbox-visible interpreter for the three image
// tools (Bug: the sandbox denies the home dir, so a venv interpreter under it
// needs its own allowRead entry). Defaulted to the bare "python3" so tests
// that do not care about the interpreter path stay deterministic regardless
// of whether ~/.campaign-council-venv exists on the machine running the suite.
vi.mock("@/orchestrator/runStage7Creatives", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/orchestrator/runStage7Creatives")>()),
  resolvePython: vi.fn(async () => "python3"),
}));

import {
  directAssetPlanSeed,
  directSeedStopMessage,
  imageMapCoverageGaps,
  runStage5Assets,
} from "@/orchestrator/runStage5Assets";
import { captureInstagramProof } from "@/orchestrator/liveProof";
import { resolvePython } from "@/orchestrator/runStage7Creatives";
import { validateAssetFolderSnapshot } from "@/orchestrator/assetQuality";
import type { AssetManifestEntry } from "@/orchestrator/assetQuality";
import { spawnAgent } from "@/orchestrator/spawnAgent";
import { __resetMockupBaseMemoForTests } from "@/orchestrator/mockupRenderer";
import { absolutePathRule } from "@/orchestrator/runStage5LpBuild";
import { __resetRegistryForTests, createRun, flushPersistence, getRun } from "@/orchestrator/runRegistry";
import { eventBus } from "@/orchestrator/eventBus";
import { createRunDir } from "@/lib/runStore";
import { validateClientProfile } from "@/config/clientProfile";
import { seedPackagedMockupRegions, seededScreenSize } from "./mockupBaseRegions";
import {
  BASE64_RECIPE,
  expectLegalWorkedExamples,
  expectRenderContract,
  expectScreenBoundaries,
  expectScreensFirstOrder,
} from "./assetPromptContract";
import { initializeStages } from "@/orchestrator/initializeStages";
import type { AssetType, Run, SSEEvent } from "@/types";

const REQUIRED_MOCKUPS = [
  { name: "module-1", section: "Stack", proves: "מה מקבלים בפרק הראשון", base: "chapter" },
  { name: "program-stack", section: "Stack", proves: "כל מה שנכנס לתוכנית", base: "devices" },
];

const BRIEF = "כיוון עיצוב לאקמה.\n```json\n" + JSON.stringify({
  playbook: "Dark Premium",
  colors: { base: "#111", accent: "#f49", text: "#fff" },
  vibe: [],
  specialElements: [],
  hardBans: [],
  imageMap: [
    { harvestFile: "raw/01-portrait.jpg", section: "Hero", proves: "המנחה שבנתה את השיטה" },
    { harvestFile: "raw/99-missing.jpg", section: "הוכחה", proves: "50,200 עוקבים" },
  ],
  requiredMockups: REQUIRED_MOCKUPS,
}) + "\n```";

const BRIEF_ONE_ROW = "כיוון עיצוב לאקמה.\n```json\n" + JSON.stringify({
  playbook: "Dark Premium",
  colors: { base: "#111", accent: "#f49", text: "#fff" },
  imageMap: [{ harvestFile: "raw/01-portrait.jpg", section: "Hero", proves: "המנחה שבנתה את השיטה" }],
  requiredMockups: REQUIRED_MOCKUPS,
}) + "\n```";

/** The same map with no mockup list at all: a sales page stops on it. */
const BRIEF_NO_MOCKUPS = "כיוון עיצוב לאקמה.\n```json\n" + JSON.stringify({
  playbook: "Dark Premium",
  imageMap: [{ harvestFile: "raw/01-portrait.jpg", section: "Hero", proves: "המנחה שבנתה את השיטה" }],
}) + "\n```";

describe("directAssetPlanSeed / imageMapCoverageGaps", () => {
  it("returns the rows and names the files that do not exist in the harvest", () => {
    const seed = directAssetPlanSeed(BRIEF, ["raw/01-portrait.jpg"])!;
    expect(seed.rows).toHaveLength(2);
    expect(seed.missing).toEqual(["raw/99-missing.jpg"]);
  });

  it("is null when the brief has no JSON block, broken JSON, or no imageMap array (a vanished map is never an empty valid one)", () => {
    expect(directAssetPlanSeed("בלי json", [])).toBeNull();
    expect(directAssetPlanSeed("```json\n{oops\n```", [])).toBeNull();
    expect(directAssetPlanSeed("```json\n{\"playbook\":\"x\"}\n```", [])).toBeNull();
  });

  it("is null for an explicitly empty map: a page with no proving image is never built", () => {
    const emptyMap = "```json\n" + JSON.stringify({ playbook: "Dark Premium", imageMap: [] }) + "\n```";

    expect(directAssetPlanSeed(emptyMap, ["raw/01-portrait.jpg"])).toBeNull();
    expect(directSeedStopMessage(emptyMap)).toContain("מפת תמונות ריקה");
    expect(directSeedStopMessage(emptyMap)).toContain("לפחות תמונה אחת");
    expect(directSeedStopMessage(emptyMap)).toContain("פתח את שלב 3 מחדש");
  });

  it("is null for any invalid row, so a partial map is never applied", () => {
    const oneBadRow = "```json\n" + JSON.stringify({
      imageMap: [
        { harvestFile: "raw/01-portrait.jpg", section: "Hero", proves: "המנחה שבנתה את השיטה" },
        { harvestFile: "raw/02-team.jpg", section: "הוכחה", proves: "מ".repeat(210) },
      ],
    }) + "\n```";

    // Dropping the long row would narrow the approved map in silence.
    expect(directAssetPlanSeed(oneBadRow, ["raw/01-portrait.jpg", "raw/02-team.jpg"])).toBeNull();
    expect(directSeedStopMessage(oneBadRow)).toContain("1 רשומות לא תקינות");
    expect(directSeedStopMessage(oneBadRow)).toContain("טענה ארוכה");
    expect(directSeedStopMessage(oneBadRow)).toContain("פתח את שלב 3 מחדש");
  });

  it("names every kind of broken row in the stop message", () => {
    const broken = "```json\n" + JSON.stringify({
      imageMap: [
        { harvestFile: "raw/01-portrait.jpg", section: "Hero" },
        { harvestFile: "../etc/passwd", section: "הוכחה", proves: "משהו" },
        { harvestFile: "raw/03-proof.jpg", section: "ה".repeat(81), proves: "משהו" },
        { harvestFile: "raw/04-proof.jpg", section: "הוכחה", proves: "מ".repeat(201) },
      ],
    }) + "\n```";

    const message = directSeedStopMessage(broken);

    expect(message).toContain("4 רשומות לא תקינות");
    expect(message).toContain("שדה חסר או ריק");
    expect(message).toContain("שם קובץ בקציר לא תקין");
    expect(message).toContain("סקציה ארוכה");
    expect(message).toContain("טענה ארוכה");
  });

  it("is null when the map has rows but not one of them is usable", () => {
    const brokenRows = "```json\n" + JSON.stringify({
      imageMap: [
        { harvestFile: "raw/01-portrait.jpg", section: "Hero" },
        { harvestFile: "raw/02-team.jpg", section: "הוכחה", proves: "   " },
        { section: "Hero", proves: "המנחה" },
      ],
    }) + "\n```";

    expect(directAssetPlanSeed(brokenRows, ["raw/01-portrait.jpg", "raw/02-team.jpg"])).toBeNull();
    expect(directSeedStopMessage(brokenRows)).toContain("רשומות לא תקינות");
    expect(directSeedStopMessage(brokenRows)).toContain("פתח את שלב 3 מחדש");
    // A brief with no block at all still gets the original message.
    expect(directSeedStopMessage("בלי json")).toContain("בלוק JSON");
  });

  it("keeps a fully valid map whole, with no invalid rows", () => {
    const seed = directAssetPlanSeed(BRIEF, ["raw/01-portrait.jpg", "raw/99-missing.jpg"])!;

    expect(seed.rows.map((row) => row.harvestFile)).toEqual(["raw/01-portrait.jpg", "raw/99-missing.jpg"]);
    expect(seed.invalidRows).toBe(0);
    expect(seed.missing).toEqual([]);
  });

  it("covers a row only through an entry linked by harvestFile with the same placement fields", () => {
    const rows = directAssetPlanSeed(BRIEF, ["raw/01-portrait.jpg", "raw/99-missing.jpg"])!.rows;
    const entry = (over: Partial<AssetManifestEntry>): AssetManifestEntry =>
      ({ file: "x.webp", kind: "photo", status: "approved", sha256: "a".repeat(64), problems: [], previewable: true, ...over });
    const manifest = [
      entry({ file: "hero-portrait.webp", harvestFile: "raw/01-portrait.jpg", section: "Hero", proves: "המנחה שבנתה את השיטה" }),
      entry({ file: "proof-old.webp", harvestFile: "raw/99-missing.jpg", status: "rejected", section: "הוכחה", proves: "50,200 עוקבים" }),
    ];
    expect(imageMapCoverageGaps(manifest, rows)).toEqual([{ harvestFile: "raw/99-missing.jpg", section: "הוכחה", proves: "50,200 עוקבים" }]);
    // same section and proves, but a different harvest file: not this row's image
    expect(imageMapCoverageGaps([...manifest, entry({ file: "other.webp", harvestFile: "raw/01-portrait.jpg", section: "הוכחה", proves: "50,200 עוקבים" })], rows)).toHaveLength(1);
    // linked file but a placement the image-map check would ignore (proves missing): not covered
    expect(imageMapCoverageGaps([...manifest, entry({ file: "ig.webp", harvestFile: "raw/99-missing.jpg", section: "הוכחה" })], rows)).toHaveLength(1);
    // linked, trimmed fields equal, review-required: covered (the human decides on the sheet)
    expect(imageMapCoverageGaps([...manifest, entry({ file: "ig.webp", harvestFile: "raw/99-missing.jpg", status: "review-required", section: " הוכחה ", proves: "50,200 עוקבים" })], rows)).toEqual([]);
  });
});

let runsDir: string;

function readyProfile(liveProof?: boolean) {
  return validateClientProfile({
    schemaVersion: 1,
    tenant: { id: "acme", displayName: "Acme", locale: "he-IL", timezone: "Asia/Jerusalem" },
    brand: { publicName: "Acme", facts: ["עובדה מאומתת"] },
    policies: {
      contentRules: [],
      advertisingRules: [],
      operationalRules: [],
      capabilities: {
        landingPageBuild: true,
        metaPixelRead: false,
        metaCampaignCreatePaused: false,
        ...(liveProof === undefined ? {} : { liveProof }),
      },
    },
    landing: {
      workspacePath: path.join(os.tmpdir(), "council-landing-workspace"),
      designStandardPath: "design/standard.md",
      qaScriptPath: "scripts/qa.mjs",
    },
  });
}

function directRun(id: string, pageTypesDir: string, designBrief: string, liveProof?: boolean, stage1IgHandle?: string, assetType: AssetType = "sales-page"): Run {
  const stages = initializeStages(assetType, "direct").map((stage) => (stage.number < 5
    ? {
        ...stage,
        status: "approved" as const,
        output: `פלט ${stage.number}`,
        subTasks: stage.subTasks.map((sub) => ({
          ...sub,
          status: "approved" as const,
          output: sub.id === "3" ? designBrief : `פלט ${sub.id}`,
          // Stage 1's approved sub-task carries the harvest's resolved handle,
          // the way runStage1Harvest actually persists it.
          ...(stage.number === 1 && sub.id === "1" && stage1IgHandle
            ? {
                harvest: {
                  schemaVersion: 1 as const,
                  sheetFile: "sheet.jpg" as const,
                  imageCount: 1,
                  harvestedAt: "2026-09-15T09:00:00.000Z",
                  igHandle: stage1IgHandle,
                },
              }
            : {}),
        })),
      }
    : { ...stage, status: "running" as const }));
  return {
    id,
    slug: "sales",
    brief: "בריף לבדיקה של אקמה https://acme.example אינסטגרם: @acme",
    createdAt: "2026-09-15T10:00:00.000Z",
    status: "approved",
    currentRound: null,
    messages: [],
    currentStage: 5,
    assetType,
    pipeline: "direct",
    clientProfile: readyProfile(liveProof),
    pageTypesDir,
    stages,
  };
}

async function prepareRun(id: string, designBrief: string, harvestRawFiles: string[], liveProof?: boolean, stage1IgHandle?: string, assetType: AssetType = "sales-page") {
  const runDir = await createRunDir(id);
  await fs.mkdir(path.join(runDir, "assets"), { recursive: true });
  await fs.mkdir(path.join(runDir, "harvest", "raw"), { recursive: true });
  for (const file of harvestRawFiles) {
    await fs.writeFile(path.join(runDir, "harvest", "raw", file), "jpeg-bytes");
  }
  createRun(directRun(id, path.join(runsDir, "page-types"), designBrief, liveProof, stage1IgHandle, assetType));
  return runDir;
}

/** A manifest of finished work that is linked to no row of the approved map. */
function uncoveredSnapshot() {
  return {
    manifest: {
      schemaVersion: 1 as const,
      generatedAt: "2026-09-15T10:05:00.000Z",
      attemptId: "attempt",
      ignoredFiles: [],
      assets: [{
        file: "hero.webp",
        kind: "photo" as const,
        status: "approved" as const,
        sha256: "a".repeat(64),
        problems: [],
        previewable: true,
        section: "אחר",
        proves: "משהו",
      }],
    },
    manifestSha256: "b".repeat(64),
    assetBytes: new Map<string, Buffer>(),
  };
}

function subTask52(runId: string) {
  return getRun(runId)?.stages?.find((s) => s.number === 5)?.subTasks.find((st) => st.id === "5.2");
}

beforeEach(async () => {
  runsDir = await fs.mkdtemp(path.join(os.tmpdir(), "council-stage5-assets-direct-"));
  process.env.RUNS_DIR_OVERRIDE = runsDir;
  // The prompt reads the base frames' regions. Seeding the cache keeps the
  // suite off detect_screens.py and off the real cache directory.
  process.env.CAMPAIGN_COUNCIL_MOCKUP_CACHE_DIR = path.join(runsDir, "mockup-cache");
  // Each test stands for a fresh process: the describe memo is keyed by frame
  // content, so without this a later test would be served an earlier one's.
  __resetMockupBaseMemoForTests();
  await seedPackagedMockupRegions();
  __resetRegistryForTests();
  vi.mocked(spawnAgent).mockClear();
  vi.mocked(validateAssetFolderSnapshot).mockReset();
  vi.mocked(captureInstagramProof).mockReset();
  vi.mocked(resolvePython).mockClear();
});

afterEach(async () => {
  await flushPersistence();
  __resetRegistryForTests();
  delete process.env.RUNS_DIR_OVERRIDE;
  delete process.env.CAMPAIGN_COUNCIL_MOCKUP_CACHE_DIR;
  await fs.rm(runsDir, { recursive: true, force: true, maxRetries: 5 });
});

describe("stage 5.2 of a direct run", () => {
  // The acceptance run of 2026-09-16 claimed 90 minutes for 5.2 and then killed
  // the agent at 60, on spawnAgent's own default, after four of eight required
  // screens. The agent's timer is the claimed budget minus the margin the
  // executor keeps for rendering and validation.
  it("spawns the agent on the claimed 90 minute budget, minus the render margin", async () => {
    const id = "2026-09-15-direct-assets-budget";
    const runDir = await prepareRun(id, BRIEF_ONE_ROW, ["01-portrait.jpg"]);
    const control = {
      attemptId: "attempt-under-test",
      signal: new AbortController().signal,
      timeoutMs: 90 * 60_000,
      heartbeat: async () => {},
      throwIfAborted: () => {},
    };

    await expect(runStage5Assets(id, runDir, undefined, control))
      .rejects.toThrow("stop after capturing the prompt");

    expect(vi.mocked(spawnAgent).mock.calls[0]![0].timeoutMs).toBe(75 * 60_000);
  });

  it("reads the brand brief from stage 3, lists the image map in the prompt and opens the harvest dir for reading", async () => {
    const id = "2026-09-15-direct-assets-prompt";
    const runDir = await prepareRun(id, BRIEF_ONE_ROW, ["01-portrait.jpg"]);

    await expect(runStage5Assets(id, runDir)).rejects.toThrow("stop after capturing the prompt");

    expect(spawnAgent).toHaveBeenCalledTimes(1);
    const opts = vi.mocked(spawnAgent).mock.calls[0]![0];
    // The brand brief of a direct run is stage 3, not a stage 5.1 that does not exist.
    expect(opts.prompt).toContain("כיוון עיצוב לאקמה.");
    expect(opts.prompt).toContain("Dark Premium");
    expect(opts.prompt).toContain("מפת התמונות מבריף העיצוב");
    expect(opts.prompt).toContain("raw/01-portrait.jpg");
    expect(opts.prompt).toContain("סקציה: Hero");
    expect(opts.prompt).toContain("מוכיח: המנחה שבנתה את השיטה");
    expect(opts.prompt).toContain("harvestFile");
    expect(opts.prompt).toContain("מקור בקציר | שם סופי");
    const allowRead = (opts.settings as { sandbox: { filesystem: { allowRead: string[] } } })
      .sandbox.filesystem.allowRead;
    expect(allowRead).toContain(path.join(runDir, "harvest"));
    expect(allowRead).toContain(path.join(process.cwd(), "vendor", "landing-skill", "scripts"));
  });

  it("stops before spawning when the design brief declares an empty image map", async () => {
    const id = "2026-09-15-direct-assets-empty-map";
    const emptyMap = "כיוון עיצוב לאקמה.\n```json\n" + JSON.stringify({ playbook: "Dark Premium", imageMap: [] }) + "\n```";
    const runDir = await prepareRun(id, emptyMap, ["01-portrait.jpg"]);

    await expect(runStage5Assets(id, runDir)).rejects.toThrow(/מפת תמונות ריקה/);

    expect(spawnAgent).not.toHaveBeenCalled();
    const subTask = subTask52(id);
    expect(subTask?.status).toBe("error");
    expect(subTask?.errorMessage).toContain("לפחות תמונה אחת");
    expect(validateAssetFolderSnapshot).not.toHaveBeenCalled();
  });

  it("stops with an explicit error listing missing files before spawning", async () => {
    const id = "2026-09-15-direct-assets-missing";
    const runDir = await prepareRun(id, BRIEF, ["01-portrait.jpg"]);

    await expect(runStage5Assets(id, runDir)).rejects.toThrow(/raw\/99-missing\.jpg/);

    expect(spawnAgent).not.toHaveBeenCalled();
    const subTask = subTask52(id);
    expect(subTask?.status).toBe("error");
    expect(subTask?.errorMessage).toContain("raw/99-missing.jpg");
    expect(subTask?.errorMessage).toContain("השלם");
    // Nothing ran, so there is nothing to salvage either.
    expect(validateAssetFolderSnapshot).not.toHaveBeenCalled();
  });

  it("stops before spawning when one row of an otherwise good map is unusable", async () => {
    const id = "2026-09-15-direct-assets-one-bad-row";
    const rows = [1, 2, 3].map((n) => ({
      harvestFile: `raw/0${n}-portrait.jpg`,
      section: `סקציה ${n}`,
      proves: `טענה ${n}`,
    }));
    const oneBadRow = "```json\n" + JSON.stringify({
      imageMap: [...rows, { harvestFile: "raw/04-proof.jpg", section: "הוכחה", proves: "מ".repeat(210) }],
    }) + "\n```";
    const runDir = await prepareRun(id, oneBadRow, [
      "01-portrait.jpg", "02-portrait.jpg", "03-portrait.jpg", "04-proof.jpg",
    ]);

    await expect(runStage5Assets(id, runDir)).rejects.toThrow(/רשומות לא תקינות/);

    expect(spawnAgent).not.toHaveBeenCalled();
    expect(validateAssetFolderSnapshot).not.toHaveBeenCalled();
    const subTask = subTask52(id);
    expect(subTask?.status).toBe("error");
    expect(subTask?.errorMessage).toContain("טענה ארוכה");
    expect(subTask?.errorMessage).toContain("פתח את שלב 3 מחדש");
  });

  it("stops before spawning when every row of the map is broken", async () => {
    const id = "2026-09-15-direct-assets-broken-rows";
    const brokenRows = "```json\n" + JSON.stringify({
      imageMap: [{ harvestFile: "raw/01-portrait.jpg", section: "Hero" }],
    }) + "\n```";
    const runDir = await prepareRun(id, brokenRows, ["01-portrait.jpg"]);

    await expect(runStage5Assets(id, runDir)).rejects.toThrow(/רשומות לא תקינות/);

    expect(spawnAgent).not.toHaveBeenCalled();
    expect(validateAssetFolderSnapshot).not.toHaveBeenCalled();
    expect(subTask52(id)?.status).toBe("error");
    expect(subTask52(id)?.errorMessage).toContain("פתח את שלב 3 מחדש");
  });

  it("stops before spawning when the brief has no JSON block", async () => {
    const id = "2026-09-15-direct-assets-no-json";
    const runDir = await prepareRun(id, "כיוון בלי בלוק", ["01-portrait.jpg"]);

    await expect(runStage5Assets(id, runDir)).rejects.toThrow(/בלוק JSON/);

    expect(spawnAgent).not.toHaveBeenCalled();
    expect(validateAssetFolderSnapshot).not.toHaveBeenCalled();
    expect(subTask52(id)?.status).toBe("error");
  });

  it("fails after the agent when the manifest does not cover the approved map, and the salvage path does not rescue it", async () => {
    const id = "2026-09-15-direct-assets-coverage";
    const runDir = await prepareRun(id, BRIEF_ONE_ROW, ["01-portrait.jpg"]);
    // The agent leaves finished-looking files behind, so listImages() finds
    // salvageable work: the salvage path must still refuse to rescue the run.
    vi.mocked(spawnAgent).mockImplementationOnce(async () => {
      await fs.writeFile(path.join(runDir, "assets", "hero.webp"), "webp-bytes-1");
      await fs.writeFile(path.join(runDir, "assets", "proof.webp"), "webp-bytes-2");
      return { fullText: "סיימתי", exitCode: 0, durationMs: 1 };
    });
    vi.mocked(validateAssetFolderSnapshot).mockResolvedValue(uncoveredSnapshot());
    const events: SSEEvent[] = [];
    const unsubscribe = eventBus.subscribe(id, (event) => events.push(event));

    try {
      await expect(runStage5Assets(id, runDir)).rejects.toThrow(/לא מכסה את מפת התמונות/);
    } finally {
      unsubscribe();
    }

    expect(vi.mocked(validateAssetFolderSnapshot).mock.calls.length).toBeLessThanOrEqual(2);
    expect(subTask52(id)?.status).toBe("error");
    expect(subTask52(id)?.status).not.toBe("awaiting-decision");
    expect(events.some((event) => event.type === "subtask-completed")).toBe(false);
    expect(events.some((event) => event.type === "subtask-error")).toBe(true);
  });

  it("refuses to salvage a crashed attempt whose files do not cover the approved map", async () => {
    const id = "2026-09-15-direct-assets-salvage";
    const runDir = await prepareRun(id, BRIEF_ONE_ROW, ["01-portrait.jpg"]);
    vi.mocked(spawnAgent).mockImplementationOnce(async () => {
      await fs.writeFile(path.join(runDir, "assets", "hero.webp"), "webp-bytes-1");
      throw new Error("הסוכן נפל");
    });
    vi.mocked(validateAssetFolderSnapshot).mockResolvedValue(uncoveredSnapshot());
    const events: SSEEvent[] = [];
    const unsubscribe = eventBus.subscribe(id, (event) => events.push(event));

    try {
      await expect(runStage5Assets(id, runDir)).rejects.toThrow("הסוכן נפל");
    } finally {
      unsubscribe();
    }

    expect(subTask52(id)?.status).toBe("error");
    expect(events.some((event) => event.type === "subtask-completed")).toBe(false);
  });

  it("captures the live Instagram proof itself and offers it to the agent in the prompt", async () => {
    const id = "2026-09-15-direct-assets-live-proof";
    const runDir = await prepareRun(id, BRIEF_ONE_ROW, ["01-portrait.jpg"], true);
    vi.mocked(captureInstagramProof).mockResolvedValue({
      file: path.join(runDir, "harvest", "instagram-acme.png"),
      followers: "12.3K",
      followersRaw: "12.3K עוקבים",
    });

    await expect(runStage5Assets(id, runDir)).rejects.toThrow("stop after capturing the prompt");

    expect(captureInstagramProof).toHaveBeenCalledTimes(1);
    expect(vi.mocked(captureInstagramProof).mock.calls[0]![0]).toMatchObject({ runDir, handle: "acme" });
    const prompt = vi.mocked(spawnAgent).mock.calls[0]![0].prompt;
    expect(prompt).toContain("הוכחת אינסטגרם חיה: instagram-acme.png");
    // The count the capture validated travels into the prompt: the agent
    // circles a number the run actually read, never one it guessed.
    expect(prompt).toContain("12.3K עוקבים");
    // Absolute path, not the relative `scripts/marker.py`: the builder's cwd
    // during this stage is not guaranteed to be the repo root.
    expect(prompt).toContain(path.join(process.cwd(), "vendor", "landing-skill", "scripts", "marker.py"));
  });

  it("states the reason and asks for a manual proof at the gate when the live capture was refused", async () => {
    const id = "2026-09-15-direct-assets-live-proof-refused";
    const runDir = await prepareRun(id, BRIEF_ONE_ROW, ["01-portrait.jpg"], true);
    vi.mocked(captureInstagramProof).mockResolvedValue({
      error: "ig_shot.mjs נכשל: הדף של acme.studio אינו זמין באינסטגרם",
    });

    await expect(runStage5Assets(id, runDir)).rejects.toThrow("stop after capturing the prompt");

    const prompt = vi.mocked(spawnAgent).mock.calls[0]![0].prompt;
    expect(prompt).not.toContain("הוכחת אינסטגרם חיה:");
    expect(prompt).toContain("צילום ההוכחה החיה נכשל");
    expect(prompt).toContain("אינו זמין באינסטגרם");
    expect(prompt).toContain("צילום ידני");
    expect(prompt).toContain("בשער האישור");
  });

  it("prefers stage 1's approved harvest.igHandle over the brief's own handle (latest correction wins)", async () => {
    const id = "2026-09-15-direct-assets-stage1-ig-wins";
    // The run's brief carries "@acme" (see directRun); stage 1 was corrected to a different handle.
    const runDir = await prepareRun(id, BRIEF_ONE_ROW, ["01-portrait.jpg"], true, "acme.corrected");
    vi.mocked(captureInstagramProof).mockResolvedValue({
      file: path.join(runDir, "harvest", "instagram-acme-corrected.png"),
    });
    const events: SSEEvent[] = [];
    const unsubscribe = eventBus.subscribe(id, (event) => events.push(event));

    try {
      await expect(runStage5Assets(id, runDir)).rejects.toThrow("stop after capturing the prompt");
    } finally {
      unsubscribe();
    }

    expect(vi.mocked(captureInstagramProof).mock.calls[0]![0]).toMatchObject({ runDir, handle: "acme.corrected" });
    const tokens = events.filter((e) => e.type === "subtask-token").map((e) => e.token).join("");
    expect(tokens).toContain("acme.corrected (מקור: שלב 1)");
  });

  it("lets 5.2 feedback with a handle win over stage 1's harvest.igHandle (latest correction wins)", async () => {
    const id = "2026-09-15-direct-assets-feedback-ig-wins";
    const runDir = await prepareRun(id, BRIEF_ONE_ROW, ["01-portrait.jpg"], true, "acme.corrected");
    vi.mocked(captureInstagramProof).mockResolvedValue({
      file: path.join(runDir, "harvest", "instagram-acme-feedback.png"),
    });
    const events: SSEEvent[] = [];
    const unsubscribe = eventBus.subscribe(id, (event) => events.push(event));

    try {
      await expect(runStage5Assets(id, runDir, "אינסטגרם: @acme.fromfeedback")).rejects.toThrow("stop after capturing the prompt");
    } finally {
      unsubscribe();
    }

    expect(vi.mocked(captureInstagramProof).mock.calls[0]![0]).toMatchObject({ runDir, handle: "acme.fromfeedback" });
    const tokens = events.filter((e) => e.type === "subtask-token").map((e) => e.token).join("");
    expect(tokens).toContain("acme.fromfeedback (מקור: משוב 5.2)");
  });

  it("keeps a 5.2 handle correction on a second rerun whose feedback is about something else", async () => {
    const id = "2026-09-15-direct-assets-feedback-ig-survives";
    const runDir = await prepareRun(id, BRIEF_ONE_ROW, ["01-portrait.jpg"], true, "acme.corrected");
    vi.mocked(captureInstagramProof).mockResolvedValue({
      file: path.join(runDir, "harvest", "instagram-acme-feedback.png"),
    });

    await expect(runStage5Assets(id, runDir, "אינסטגרם: @acme.fromfeedback")).rejects.toThrow("stop after capturing the prompt");
    const events: SSEEvent[] = [];
    const unsubscribe = eventBus.subscribe(id, (event) => events.push(event));
    try {
      await expect(runStage5Assets(id, runDir, "תחתוך את התמונה אחרת")).rejects.toThrow("stop after capturing the prompt");
    } finally {
      unsubscribe();
    }

    // The newest handle anywhere in this sub-task's feedback history wins, so a
    // rerun about the crop does not drop the operator's handle correction.
    expect(vi.mocked(captureInstagramProof).mock.calls[1]![0]).toMatchObject({ runDir, handle: "acme.fromfeedback" });
    const tokens = events.filter((e) => e.type === "subtask-token").map((e) => e.token).join("");
    expect(tokens).toContain("acme.fromfeedback (מקור: משוב 5.2)");
  });

  it("falls back to stage 1's handle when 5.2 never got a handle correction", async () => {
    const id = "2026-09-15-direct-assets-no-52-feedback-handle";
    const runDir = await prepareRun(id, BRIEF_ONE_ROW, ["01-portrait.jpg"], true, "acme.corrected");
    vi.mocked(captureInstagramProof).mockResolvedValue({
      file: path.join(runDir, "harvest", "instagram-acme-corrected.png"),
    });
    const events: SSEEvent[] = [];
    const unsubscribe = eventBus.subscribe(id, (event) => events.push(event));

    try {
      await expect(runStage5Assets(id, runDir, "תחתוך את התמונה אחרת")).rejects.toThrow("stop after capturing the prompt");
    } finally {
      unsubscribe();
    }

    expect(vi.mocked(captureInstagramProof).mock.calls[0]![0]).toMatchObject({ runDir, handle: "acme.corrected" });
    const tokens = events.filter((e) => e.type === "subtask-token").map((e) => e.token).join("");
    expect(tokens).toContain("acme.corrected (מקור: שלב 1)");
  });

  it("does not touch the operator browser when the profile has no live-proof capability", async () => {
    const id = "2026-09-15-direct-assets-no-live-proof";
    const runDir = await prepareRun(id, BRIEF_ONE_ROW, ["01-portrait.jpg"]);

    await expect(runStage5Assets(id, runDir)).rejects.toThrow("stop after capturing the prompt");

    expect(captureInstagramProof).not.toHaveBeenCalled();
    expect(vi.mocked(spawnAgent).mock.calls[0]![0].prompt).not.toContain("הוכחת אינסטגרם חיה");
  });

  // Bug: the 5.2 sandbox denies the whole home directory, so a venv
  // interpreter resolvePython() picks under it (Pillow, certifi live in its
  // site-packages) needs its own allowRead entry, and the prompt's tools
  // block must actually name that interpreter instead of a bare "python3"
  // that resolves to a system build without Pillow inside the sandbox.
  it("names the resolved python interpreter for cutout, checker and marker, and allows its venv root in the sandbox", async () => {
    const id = "2026-09-15-direct-assets-python-venv";
    const runDir = await prepareRun(id, BRIEF_ONE_ROW, ["01-portrait.jpg"]);
    vi.mocked(resolvePython).mockResolvedValueOnce("/tmp/fake-venv/bin/python3");

    await expect(runStage5Assets(id, runDir)).rejects.toThrow("stop after capturing the prompt");

    const opts = vi.mocked(spawnAgent).mock.calls[0]![0];
    expect(opts.prompt).toContain("cutout: `/tmp/fake-venv/bin/python3 ");
    expect(opts.prompt).toContain("checker: `/tmp/fake-venv/bin/python3 ");
    expect(opts.prompt).toContain("marker: `/tmp/fake-venv/bin/python3 ");
    expect(opts.prompt).toContain("/tmp/fake-venv/bin/python3` (כולל Pillow ו-certifi)");
    // Task 17: the sandbox no longer declares mockups it cannot render; the
    // orchestrator renders them, and the prompt says so.
    expect(opts.prompt).toContain("המוקאפים מרונדרים על ידי האורקסטרטור אחרי שתסיים");
    const allowRead = (opts.settings as { sandbox: { filesystem: { allowRead: string[] } } })
      .sandbox.filesystem.allowRead;
    expect(allowRead).toContain("/tmp/fake-venv");
  });

  // Task 14: the mockup plan contract. A page type whose template requires
  // mockups never runs 5.2 on a brief that does not say which mockups the page
  // needs, because a run that discovers it mid-flight ends with no mockups.
  it("stops before spawning when a sales page brief carries no requiredMockups", async () => {
    const id = "2026-09-16-direct-assets-no-required-mockups";
    const runDir = await prepareRun(id, BRIEF_NO_MOCKUPS, ["01-portrait.jpg"]);

    await expect(runStage5Assets(id, runDir)).rejects.toThrow(/רשימת מוקאפים נדרשים/);

    expect(spawnAgent).not.toHaveBeenCalled();
    expect(validateAssetFolderSnapshot).not.toHaveBeenCalled();
    const subTask = subTask52(id);
    expect(subTask?.status).toBe("error");
    expect(subTask?.errorMessage).toContain("פתח את שלב 3 מחדש");
  });

  it("stops before spawning on an empty or malformed requiredMockups too", async () => {
    const withList = (value: unknown) => "```json\n" + JSON.stringify({
      imageMap: [{ harvestFile: "raw/01-portrait.jpg", section: "Hero", proves: "המנחה" }],
      requiredMockups: value,
    }) + "\n```";

    for (const [index, value] of [[], [{ name: "module-1" }], "module-1"].entries()) {
      const id = `2026-09-16-direct-assets-bad-required-mockups-${index}`;
      const runDir = await prepareRun(id, withList(value), ["01-portrait.jpg"]);
      await expect(runStage5Assets(id, runDir)).rejects.toThrow(/רשימת מוקאפים נדרשים/);
    }
    expect(spawnAgent).not.toHaveBeenCalled();
  });

  it("lets a squeeze page run without requiredMockups: its template asks for no mockups", async () => {
    const id = "2026-09-16-direct-assets-squeeze-no-mockups";
    const runDir = await prepareRun(id, BRIEF_NO_MOCKUPS, ["01-portrait.jpg"], undefined, undefined, "squeeze-page");

    await expect(runStage5Assets(id, runDir)).rejects.toThrow("stop after capturing the prompt");

    expect(spawnAgent).toHaveBeenCalledTimes(1);
  });

  it("lists the required mockups and the screen file contract in the prompt", async () => {
    const id = "2026-09-16-direct-assets-mockup-contract";
    const runDir = await prepareRun(id, BRIEF_ONE_ROW, ["01-portrait.jpg"]);

    await expect(runStage5Assets(id, runDir)).rejects.toThrow("stop after capturing the prompt");

    const prompt = vi.mocked(spawnAgent).mock.calls[0]![0].prompt;
    expect(prompt).toContain("המוקאפים הנדרשים");
    expect(prompt).toContain("module-1");
    expect(prompt).toContain("program-stack");
    expect(prompt).toContain("chapter");
    expect(prompt).toContain("devices");
    // The plan schema shows screens and render, and inputs stays images only.
    // The worked example itself is built from the installed frames, so its
    // legality is asserted against the base listing, not against a literal.
    expect(prompt).toContain('"screens":');
    expect(prompt).toContain('"render":');
    expect(prompt).toContain('"inputs": ["portrait-cut.webp"]');
    expectLegalWorkedExamples(prompt);
    expect(prompt).toContain(path.join(runDir, "assets", "screens"));
    expect(prompt).toContain("sizes.json");
    // The Write paragraph must name every file the agent is actually asked to
    // write, or it contradicts the mockups section two blocks below it.
    const planParagraph = prompt.split("\n").find((line) => line.startsWith("לפני שאתה מסיים"))!;
    expect(planParagraph).toContain(path.join(runDir, "assets", "screens"));
    expect(planParagraph).toContain("sizes.json");
    expect(planParagraph).not.toContain("היחיד");
    expect(planParagraph).toContain("heredoc");
  });

  // Task 17: the direct pipeline used to be told it had no browser and should
  // declare the mockups it could not produce. The orchestrator renders them
  // now, so the prompt carries the render contract instead.
  it("carries the render contract instead of the sandbox 'no browser' statement", async () => {
    const id = "2026-09-16-direct-assets-render-contract";
    const runDir = await prepareRun(id, BRIEF_ONE_ROW, ["01-portrait.jpg"]);

    await expect(runStage5Assets(id, runDir)).rejects.toThrow("stop after capturing the prompt");

    const prompt = vi.mocked(spawnAgent).mock.calls[0]![0].prompt;
    expectRenderContract(prompt);
  });

  // Fix round 1, Critical: the only way a picture or a font reaches a screen
  // is an embedded data: URI. A relative src or a web font is blocked at
  // render time, fails the screen, and fails the required mockup with it.
  it("states the screen boundaries the renderer enforces, and how the presenter's photo reaches a screen", async () => {
    const id = "2026-09-16-direct-assets-screen-boundaries";
    const runDir = await prepareRun(id, BRIEF_ONE_ROW, ["01-portrait.jpg"]);

    await expect(runStage5Assets(id, runDir)).rejects.toThrow("stop after capturing the prompt");

    expectScreenBoundaries(vi.mocked(spawnAgent).mock.calls[0]![0].prompt);
  });

  // The acceptance run wrote four of eight required screens and then lost the
  // turn to its timer, having spent the early minutes on other assets.
  it("tells the agent to write the required screens first, inside the budget it really has", async () => {
    const id = "2026-09-16-direct-assets-screens-first";
    const runDir = await prepareRun(id, BRIEF_ONE_ROW, ["01-portrait.jpg"]);
    const control = {
      attemptId: "attempt-under-test",
      signal: new AbortController().signal,
      timeoutMs: 90 * 60_000,
      heartbeat: async () => {},
      throwIfAborted: () => {},
    };

    await expect(runStage5Assets(id, runDir, undefined, control))
      .rejects.toThrow("stop after capturing the prompt");

    const call = vi.mocked(spawnAgent).mock.calls[0]![0];
    // The number in the prompt is the timer the turn is actually spawned on.
    expect(call.timeoutMs).toBe(75 * 60_000);
    expectScreensFirstOrder(call.prompt, 75);
  });

  it("states spawnAgent's own default when nothing claimed a budget", async () => {
    const id = "2026-09-16-direct-assets-default-budget";
    const runDir = await prepareRun(id, BRIEF_ONE_ROW, ["01-portrait.jpg"]);

    await expect(runStage5Assets(id, runDir)).rejects.toThrow("stop after capturing the prompt");

    expectScreensFirstOrder(vi.mocked(spawnAgent).mock.calls[0]![0].prompt, 60);
  });

  // Fix round 2: the worked command must actually run on this platform. The
  // previous `base64 <path>` was a usage error on the BSD build macOS ships.
  it("hands out an embedding command that runs, and produces the file's base64", async () => {
    const id = "2026-09-16-direct-assets-base64-recipe";
    const runDir = await prepareRun(id, BRIEF_ONE_ROW, ["01-portrait.jpg"]);

    await expect(runStage5Assets(id, runDir)).rejects.toThrow("stop after capturing the prompt");

    const prompt = vi.mocked(spawnAgent).mock.calls[0]![0].prompt;
    // resolvePython is stubbed to the bare python3 for this suite.
    expect(prompt).toContain(`python3 ${BASE64_RECIPE}`);
    const quoted = prompt.match(/`([^`]*b64encode[^`]*)`/);
    expect(quoted, "the prompt shows the command in one code span").not.toBeNull();
    const file = path.join(runDir, "recipe-sample.bin");
    const bytes = Buffer.from("מסך של מוקאפ", "utf8");
    await fs.writeFile(file, bytes);
    const command = quoted![1]!.replace("<נתיב הקובץ בתיקיית הנכסים>", JSON.stringify(file));

    const { stdout } = await execFileAsync("/bin/sh", ["-c", command]);

    expect(stdout.trim()).toBe(bytes.toString("base64"));
    expect(stdout.trim()).not.toContain("\n");
  }, 20_000);

  // Fix round 1, Important: the worked examples used to show region "10" and
  // sizes no base offers, so an agent copying them failed both checks.
  it("shows worked examples whose region ids and sizes match the base listing", async () => {
    const id = "2026-09-16-direct-assets-legal-examples";
    const runDir = await prepareRun(id, BRIEF_ONE_ROW, ["01-portrait.jpg"]);

    await expect(runStage5Assets(id, runDir)).rejects.toThrow("stop after capturing the prompt");

    expectLegalWorkedExamples(vi.mocked(spawnAgent).mock.calls[0]![0].prompt);
  });

  it("lists every base frame's region ids and the exact screen size each region needs", async () => {
    const id = "2026-09-16-direct-assets-base-regions";
    const runDir = await prepareRun(id, BRIEF_ONE_ROW, ["01-portrait.jpg"]);

    await expect(runStage5Assets(id, runDir)).rejects.toThrow("stop after capturing the prompt");

    const prompt = vi.mocked(spawnAgent).mock.calls[0]![0].prompt;
    const [laptopW, laptopH] = seededScreenSize("devices", 1);
    const [phoneW, phoneH] = seededScreenSize("devices", 2);
    const [tabletW, tabletH] = seededScreenSize("chapter", 1);
    expect(prompt).toContain(`אזור "1" דורש מסך ${laptopW}x${laptopH} פיקסלים`);
    expect(prompt).toContain(`אזור "2" דורש מסך ${phoneW}x${phoneH} פיקסלים`);
    expect(prompt).toContain(`אזור "1" דורש מסך ${tabletW}x${tabletH} פיקסלים`);
    expect(prompt).toContain("מזהי האזורים האלה");
  });

  it("says so in the prompt when a base frame's regions cannot be read, and still runs 5.2", async () => {
    process.env.CAMPAIGN_COUNCIL_MOCKUP_CACHE_DIR = path.join(runsDir, "empty-cache");
    vi.mocked(resolvePython).mockResolvedValueOnce(path.join(runsDir, "no-such-python"));
    const id = "2026-09-16-direct-assets-base-regions-unreadable";
    const runDir = await prepareRun(id, BRIEF_ONE_ROW, ["01-portrait.jpg"]);

    await expect(runStage5Assets(id, runDir)).rejects.toThrow("stop after capturing the prompt");

    const prompt = vi.mocked(spawnAgent).mock.calls[0]![0].prompt;
    expect(prompt).toContain("לא ניתן לקרוא את אזורי המסגרת בריצה הזאת");
    expect(spawnAgent).toHaveBeenCalledTimes(1);
  }, 20_000);

  it("grants Edit on the screens folder and on sizes.json, and on nothing else", async () => {
    const id = "2026-09-16-direct-assets-screen-edit-rules";
    const runDir = await prepareRun(id, BRIEF_ONE_ROW, ["01-portrait.jpg"]);
    const assetsDir = path.join(runDir, "assets");

    await expect(runStage5Assets(id, runDir)).rejects.toThrow("stop after capturing the prompt");

    const opts = vi.mocked(spawnAgent).mock.calls[0]![0];
    const planRule = absolutePathRule("Edit", path.join(assetsDir, "asset-plan.json"));
    const screensRule = absolutePathRule("Edit", path.join(assetsDir, "screens", "*.html"));
    const sizesRule = absolutePathRule("Edit", path.join(assetsDir, "screens", "sizes.json"));
    expect(opts.allowedTools?.filter((rule) => rule.startsWith("Edit(") || rule.startsWith("Write(")))
      .toEqual([planRule, screensRule, sizesRule]);
    // A single star only: `**` would reach every nested path under screens/.
    expect(screensRule).not.toContain("**");
  });

  it("adds no venv root to the sandbox when resolvePython returns the bare python3", async () => {
    const id = "2026-09-15-direct-assets-python-bare";
    const runDir = await prepareRun(id, BRIEF_ONE_ROW, ["01-portrait.jpg"]);
    vi.mocked(resolvePython).mockResolvedValueOnce("python3");

    await expect(runStage5Assets(id, runDir)).rejects.toThrow("stop after capturing the prompt");

    const opts = vi.mocked(spawnAgent).mock.calls[0]![0];
    expect(opts.prompt).toContain("cutout: `python3 ");
    const allowRead = (opts.settings as { sandbox: { filesystem: { allowRead: string[] } } })
      .sandbox.filesystem.allowRead;
    expect(allowRead.some((dir) => dir.includes("fake-venv"))).toBe(false);
  });
});
