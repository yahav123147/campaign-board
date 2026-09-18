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

// Only the file-system asset bookkeeping is stubbed: this test is about what
// the stage 5.2 prompt carries, not about validating image folders.
vi.mock("@/orchestrator/assetQuality", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/orchestrator/assetQuality")>()),
  ensureManagedDirectory: vi.fn(async () => {}),
  recoverCutoutTransactions: vi.fn(async () => {}),
  readReusableAssetHashes: vi.fn(async () => ({})),
  readSealedApprovedAssetHashes: vi.fn(async () => ({})),
  snapshotAssetHashes: vi.fn(async () => ({})),
  hasValidAssetPlan: vi.fn(async () => false),
}));

import { runStage5Assets } from "@/orchestrator/runStage5Assets";
import { spawnAgent } from "@/orchestrator/spawnAgent";
import { __resetMockupBaseMemoForTests } from "@/orchestrator/mockupRenderer";
import { __resetRegistryForTests, createRun, flushPersistence } from "@/orchestrator/runRegistry";
import { createRunDir } from "@/lib/runStore";
import { validateClientProfile } from "@/config/clientProfile";
import { stageRegistryFor } from "@/orchestrator/stageRegistry";
import type { Run, Stage } from "@/types";
import { seedPackagedMockupRegions, seededScreenSize } from "./mockupBaseRegions";
import {
  expectLegalWorkedExamples,
  expectRenderContract,
  expectScreenBoundaries,
  expectScreensFirstOrder,
} from "./assetPromptContract";

/**
 * Spec 7.4: the page-type blueprint must reach the stage 5.2 asset prompt
 * itself. The warning helper alone proves nothing about the prompt.
 */
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

function upsellRun(id: string, pageTypesDir: string): Run {
  const stages: Stage[] = stageRegistryFor("upsell-page").map((def) => ({
    number: def.number,
    title: def.title,
    ownerSlug: def.ownerSlug,
    status: def.number < 5 ? "approved" : "running",
    output: def.number < 5 ? `פלט ${def.number}` : "",
    feedbackHistory: [],
    subTasks: def.subTasks.map((sub) => ({
      id: sub.id,
      title: sub.title,
      status: def.number < 5 || sub.id === "5.1" ? "approved" : "pending",
      output: def.number < 5 || sub.id === "5.1" ? `פלט ${sub.id}` : "",
      feedbackHistory: [],
    })),
  }));
  return {
    id, slug: "upsell", brief: "בריף לבדיקה", createdAt: "2026-09-12T10:00:00.000Z",
    status: "approved", currentRound: null, messages: [], currentStage: 5,
    assetType: "upsell-page", clientProfile: readyProfile(), pageTypesDir, stages,
  };
}

beforeEach(async () => {
  runsDir = await fs.mkdtemp(path.join(os.tmpdir(), "council-stage5-assets-blueprint-"));
  process.env.RUNS_DIR_OVERRIDE = runsDir;
  // The prompt reads the base frames' regions; the seeded cache keeps this
  // suite off detect_screens.py and off the real cache directory.
  process.env.CAMPAIGN_COUNCIL_MOCKUP_CACHE_DIR = path.join(runsDir, "mockup-cache");
  // Each test stands for a fresh process: the describe memo is keyed by frame
  // content, so without this a later test would be served an earlier one's.
  __resetMockupBaseMemoForTests();
  await seedPackagedMockupRegions();
  __resetRegistryForTests();
  vi.mocked(spawnAgent).mockClear();
});

afterEach(async () => {
  await flushPersistence();
  __resetRegistryForTests();
  delete process.env.RUNS_DIR_OVERRIDE;
  delete process.env.CAMPAIGN_COUNCIL_MOCKUP_CACHE_DIR;
  await fs.rm(runsDir, { recursive: true, force: true, maxRetries: 5 });
});

describe("the stage 5.2 asset prompt", () => {
  it("carries the blueprint read from the run's stored page-type folder", async () => {
    const id = "2026-09-12-assets-blueprint";
    const runDir = await createRunDir(id);
    await fs.mkdir(path.join(runDir, "assets"), { recursive: true });
    const pageTypesDir = path.join(runsDir, "page-types");
    await fs.mkdir(pageTypesDir, { recursive: true });
    await fs.writeFile(
      path.join(pageTypesDir, "upsell-page.md"),
      "## נכסים לפי סקציה\nמוקאפ חבילה אחד בלבד לבלוק ההחלטה",
      "utf8",
    );
    createRun(upsellRun(id, pageTypesDir));

    await expect(runStage5Assets(id, runDir)).rejects.toThrow("stop after capturing the prompt");

    expect(spawnAgent).toHaveBeenCalledTimes(1);
    const prompt = vi.mocked(spawnAgent).mock.calls[0]![0].prompt;
    expect(prompt).toContain("תבנית סוג הדף: אילו נכסים נדרשים");
    expect(prompt).toContain("מוקאפ חבילה אחד בלבד לבלוק ההחלטה");
  });

  // The sandbox statement belongs to the direct pipeline alone. A council run
  // produces its mockups, so telling it to declare them instead of producing
  // them removes work the page type asked for.
  it("does not tell a council run to declare mockups instead of producing them", async () => {
    const id = "2026-09-16-assets-council-no-sandbox-note";
    const runDir = await createRunDir(id);
    await fs.mkdir(path.join(runDir, "assets"), { recursive: true });
    const pageTypesDir = path.join(runsDir, "page-types");
    await fs.mkdir(pageTypesDir, { recursive: true });
    await fs.writeFile(path.join(pageTypesDir, "upsell-page.md"), "## נכסים לפי סקציה\nמוקאפ חבילה", "utf8");
    createRun(upsellRun(id, pageTypesDir));

    await expect(runStage5Assets(id, runDir)).rejects.toThrow("stop after capturing the prompt");

    const prompt = vi.mocked(spawnAgent).mock.calls[0]![0].prompt;
    expect(prompt).not.toContain("רינדור מחוץ לארגז החול");
    expect(prompt).not.toContain("אין דפדפן");
    // The interpreter and the system converters stay for both pipelines.
    expect(prompt).toContain("כולל Pillow ו-certifi");
    expect(prompt).toContain("/usr/bin/sips");
  });

  // Task 17: the render contract is not a direct-pipeline note. A council run
  // writes its screens the same way and the orchestrator renders them.
  it("carries the render contract and the base frames' regions to a council run too", async () => {
    const id = "2026-09-16-assets-council-render-contract";
    const runDir = await createRunDir(id);
    await fs.mkdir(path.join(runDir, "assets"), { recursive: true });
    const pageTypesDir = path.join(runsDir, "page-types");
    await fs.mkdir(pageTypesDir, { recursive: true });
    await fs.writeFile(path.join(pageTypesDir, "upsell-page.md"), "## נכסים לפי סקציה\nמוקאפ חבילה", "utf8");
    createRun(upsellRun(id, pageTypesDir));

    await expect(runStage5Assets(id, runDir)).rejects.toThrow("stop after capturing the prompt");

    const prompt = vi.mocked(spawnAgent).mock.calls[0]![0].prompt;
    expectRenderContract(prompt);
    // A council screen is rendered by the same renderer, so it lives under the
    // same boundaries and its worked examples must be just as legal.
    expectScreenBoundaries(prompt);
    expectScreensFirstOrder(prompt, 60);
    expectLegalWorkedExamples(prompt);
    const [laptopW, laptopH] = seededScreenSize("devices", 1);
    const [phoneW, phoneH] = seededScreenSize("devices", 2);
    const [tabletW, tabletH] = seededScreenSize("chapter", 1);
    expect(prompt).toContain(`אזור "1" דורש מסך ${laptopW}x${laptopH} פיקסלים`);
    expect(prompt).toContain(`אזור "2" דורש מסך ${phoneW}x${phoneH} פיקסלים`);
    expect(prompt).toContain(`אזור "1" דורש מסך ${tabletW}x${tabletH} פיקסלים`);
    // The writable surfaces stay named in both pipelines.
    expect(prompt).toContain(path.join(runDir, "assets", "asset-plan.json"));
    expect(prompt).toContain(path.join(runDir, "assets", "screens"));
    expect(prompt).toContain("sizes.json");
    expect(prompt).toContain("heredoc");
  });
});
