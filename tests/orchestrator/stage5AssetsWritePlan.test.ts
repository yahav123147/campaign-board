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
import { __resetRegistryForTests, createRun, flushPersistence } from "@/orchestrator/runRegistry";
import { createRunDir } from "@/lib/runStore";
import { validateClientProfile } from "@/config/clientProfile";
import { stageRegistryFor } from "@/orchestrator/stageRegistry";
import { absolutePathRule } from "@/orchestrator/runStage5LpBuild";
import type { Run, Stage } from "@/types";
import { seedPackagedMockupRegions } from "./mockupBaseRegions";

/**
 * 15.09.2026: the asset plan used to be written through Bash under dontAsk,
 * where the permission classifier refuses heredoc-shaped commands, so the
 * write succeeded or failed by the shape the agent happened to choose. The
 * plan is now written with the Write tool, allowed for that one file only.
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

function salesRun(id: string, pageTypesDir: string): Run {
  const stages: Stage[] = stageRegistryFor("sales-page").map((def) => ({
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
    id, slug: "sales", brief: "בריף לבדיקה", createdAt: "2026-09-12T10:00:00.000Z",
    status: "approved", currentRound: null, messages: [], currentStage: 5,
    assetType: "sales-page", clientProfile: readyProfile(), pageTypesDir, stages,
  };
}

beforeEach(async () => {
  runsDir = await fs.mkdtemp(path.join(os.tmpdir(), "council-stage5-assets-write-"));
  process.env.RUNS_DIR_OVERRIDE = runsDir;
  // The 5.2 prompt reads the base frames' regions: the seeded cache keeps this
  // suite off detect_screens.py and off the real cache directory.
  process.env.CAMPAIGN_COUNCIL_MOCKUP_CACHE_DIR = path.join(runsDir, "mockup-cache");
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

describe("the stage 5.2 asset plan write permission", () => {
  it("gives the agent Write for asset-plan.json only, and tells it to use it", async () => {
    const id = "2026-09-15-assets-write";
    const runDir = await createRunDir(id);
    const assetsDir = path.join(runDir, "assets");
    await fs.mkdir(assetsDir, { recursive: true });
    createRun(salesRun(id, path.join(runsDir, "page-types")));

    await expect(runStage5Assets(id, runDir)).rejects.toThrow("stop after capturing the prompt");

    expect(spawnAgent).toHaveBeenCalledTimes(1);
    const opts = vi.mocked(spawnAgent).mock.calls[0]![0];
    expect(opts.tools).toContain("Write");
    expect(opts.tools).not.toContain("Edit");
    const planRule = absolutePathRule("Edit", path.join(assetsDir, "asset-plan.json"));
    expect(planRule).toMatch(/^Edit\(\/\/.+\/asset-plan\.json\)$/);
    expect(opts.allowedTools).toContain(planRule);
    // Task 14 widened the rules to the HTML screens the orchestrator renders
    // afterwards, and to nothing else: no `**`, no other directory.
    const screensRule = absolutePathRule("Edit", path.join(assetsDir, "screens", "*.html"));
    const sizesRule = absolutePathRule("Edit", path.join(assetsDir, "screens", "sizes.json"));
    expect(opts.allowedTools?.filter((rule) => rule.startsWith("Edit(") || rule.startsWith("Write(")))
      .toEqual([planRule, screensRule, sizesRule]);
    expect(screensRule).not.toContain("**");
    expect(opts.prompt).toContain("בכלי Write");
    // Same in a council run: the plan file is no longer the only file the
    // Write tool may create, because the HTML screens are written too.
    const planParagraph = opts.prompt.split("\n").find((line) => line.startsWith("לפני שאתה מסיים"))!;
    expect(planParagraph).toContain(path.join(assetsDir, "screens"));
    expect(planParagraph).toContain("sizes.json");
    expect(planParagraph).not.toContain("היחיד");
    expect(planParagraph).toContain("heredoc");
  });
});
