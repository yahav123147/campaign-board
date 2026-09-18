import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Run } from "@/types";

// runCriticLoopForSubTask lives in its own module and imports runCriticLoop, so
// mocking "@/orchestrator/runCriticLoop" replaces the call it makes. A mock of
// an export used inside the same module would not (ESM binds internal calls
// directly), and the test would spawn a real agent. spawnAgent is mocked as a
// second fence: if the wiring ever bypasses runCriticLoop, no process starts.
const loop = vi.hoisted(() => ({ calls: [] as Record<string, unknown>[] }));
vi.mock("@/orchestrator/runCriticLoop", () => ({
  runCriticLoop: vi.fn(async (a: Record<string, unknown>) => { loop.calls.push(a); }),
}));
vi.mock("@/orchestrator/spawnAgent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/orchestrator/spawnAgent")>()), spawnAgent: vi.fn(async () => { throw new Error("the wiring must not spawn an agent"); }) }));
vi.mock("@/orchestrator/copyStandard", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/orchestrator/copyStandard")>();
  return { ...mod, readCopyStandard: vi.fn(async () => "# ספר כללים"), readDesignStrategyStandard: vi.fn(async () => "# תקן אסטרטגיית עיצוב\nplaybook") };
});

import { runCriticLoopForSubTask } from "@/orchestrator/runCriticLoopForSubTask";
import { validateClientProfile } from "@/config/clientProfile";
import { spawnAgent } from "@/orchestrator/spawnAgent";
import { createRun, flushPersistence, __resetRegistryForTests } from "@/orchestrator/runRegistry";
import { createRunDir } from "@/lib/runStore";
import { initializeStages } from "@/orchestrator/initializeStages";

let runsDir: string;
/** A sealed profile whose copy section either sets a first-person voice or says nothing about one. */
function profileWithVoice(firstPerson?: "presenter" | "brand-owner") {
  return validateClientProfile({
    schemaVersion: 1,
    tenant: { id: "acme", displayName: "Acme", locale: "he-IL", timezone: "Asia/Jerusalem" },
    brand: { publicName: "Acme", facts: ["עובדה מאומתת"] },
    policies: {
      contentRules: [], advertisingRules: [], operationalRules: [],
      capabilities: { landingPageBuild: true, metaPixelRead: false, metaCampaignCreatePaused: false },
    },
    copy: firstPerson ? { voice: { firstPerson } } : {},
  });
}

function run(id: string, stage2Output = "", firstPerson?: "presenter" | "brand-owner"): Run {
  const stages = initializeStages("sales-page", "direct");
  stages[0]!.status = "approved"; stages[0]!.subTasks[0]!.status = "approved";
  stages[0]!.subTasks[0]!.output = "### 1. טבלת תמונות\n| 1 | raw/01-portrait.jpg | דיוקן המציג | |\n\n### 3. מאגר עובדות\n| 1 | 50,200 עוקבים | instagram |";
  if (stage2Output) { stages[1]!.status = "approved"; stages[1]!.subTasks[0]!.status = "approved"; stages[1]!.subTasks[0]!.output = stage2Output; }
  return { id, slug: "d", brief: "https://example.com", createdAt: "2026-09-15T10:00:00.000Z", status: "approved", currentRound: null, messages: [], currentStage: 2, assetType: "sales-page", pipeline: "direct", clientProfile: profileWithVoice(firstPerson), stages };
}
beforeEach(async () => { runsDir = await fs.mkdtemp(path.join(os.tmpdir(), "council-wiring-")); process.env.RUNS_DIR_OVERRIDE = runsDir; __resetRegistryForTests(); loop.calls = []; });
afterEach(async () => { await flushPersistence(); __resetRegistryForTests(); delete process.env.RUNS_DIR_OVERRIDE; await fs.rm(runsDir, { recursive: true, force: true, maxRetries: 5 }); });

describe("runCriticLoopForSubTask", () => {
  it("stage 2 gets the copy standard, the copy rubric, the facts pool and 3 rounds", async () => {
    const id = "wire-2"; const runDir = await createRunDir(id); createRun(run(id));
    await runCriticLoopForSubTask(id, runDir, 2, "2");
    const a = loop.calls[0]!;
    expect(a.standard).toBe("# ספר כללים");
    expect((a.rubric as { name: string }).name).toBe("copy-critic");
    expect(a.extraContext).toContain("מאגר העובדות המאושר");
    expect(a.extraContext).toContain("50,200 עוקבים");
    expect(a.maxRounds).toBe(3);
    expect(spawnAgent).not.toHaveBeenCalled();
  });

  it("stage 2 carries the voice block when the profile writes in the presenter's first person", async () => {
    const id = "wire-2-voice"; const runDir = await createRunDir(id); createRun(run(id, "", "presenter"));
    await runCriticLoopForSubTask(id, runDir, 2, "2");
    const extraContext = loop.calls[0]!.extraContext as string;
    expect(extraContext).toContain("## קול הכתיבה");
    expect(extraContext).toContain("גוף ראשון של המציג");
    // The block never cancels a rule: it says an example that names the profile
    // owner is an example, not the speaker of this page.
    expect(extraContext).toContain("דוגמאות בלבד");
    expect(extraContext).not.toContain("אינו חל");
    // Voice is decided by the profile, so the writer must not list it as an assumption.
    expect(extraContext).toContain("אינו הנחה");
  });

  it("stage 2 carries no voice block when the profile says nothing about the voice", async () => {
    const id = "wire-2-no-voice"; const runDir = await createRunDir(id); createRun(run(id));
    await runCriticLoopForSubTask(id, runDir, 2, "2");
    expect(loop.calls[0]!.extraContext as string).not.toContain("## קול הכתיבה");
  });

  it("stage 2 carries no voice block when the profile keeps the brand owner's first person", async () => {
    const id = "wire-2-owner-voice"; const runDir = await createRunDir(id); createRun(run(id, "", "brand-owner"));
    await runCriticLoopForSubTask(id, runDir, 2, "2");
    expect(loop.calls[0]!.extraContext as string).not.toContain("## קול הכתיבה");
  });

  it("stage 3 gets the design-strategy standard, the approved copy, the harvest listing and the missing-file list", async () => {
    const id = "wire-3"; const runDir = await createRunDir(id); createRun(run(id, "# הקופי\n## Hero\nכותרת"));
    await fs.mkdir(path.join(runDir, "harvest", "raw"), { recursive: true });
    await fs.writeFile(path.join(runDir, "harvest", "raw", "01-portrait.jpg"), "x");
    await runCriticLoopForSubTask(id, runDir, 3, "3");
    const a = loop.calls[0]!;
    expect(a.standard).toContain("playbook");
    expect((a.rubric as { name: string }).name).toBe("design-brief-critic");
    expect(a.extraContext).toContain("## הקופי המאושר");
    expect(a.extraContext).toContain("raw/01-portrait.jpg");
    expect(a.maxRounds).toBe(2);
    const hook = a.criticContextFor as (draft: string) => Promise<string>;
    await expect(hook("```json\n{\"imageMap\":[{\"harvestFile\":\"raw/99-missing.jpg\",\"section\":\"Hero\",\"proves\":\"x\"}]}\n```")).resolves.toContain("raw/99-missing.jpg");
    await expect(hook("```json\n{\"imageMap\":[{\"harvestFile\":\"raw/01-portrait.jpg\",\"section\":\"Hero\",\"proves\":\"x\"}]}\n```")).resolves.toBe("");
    // A row broken in another way still has to be told its file does not exist,
    // otherwise the critic sees only one of the two problems it must fix.
    await expect(hook("```json\n{\"imageMap\":[{\"harvestFile\":\"raw/99-missing.jpg\",\"section\":\"Hero\"}]}\n```")).resolves.toContain("raw/99-missing.jpg");
  });

  it("stage 3 reports over-length rows and malformed harvestFile shapes, not only missing files", async () => {
    const id = "wire-3-rows"; const runDir = await createRunDir(id); createRun(run(id, "# הקופי\n## Hero\nכותרת"));
    await fs.mkdir(path.join(runDir, "harvest", "raw"), { recursive: true });
    await fs.writeFile(path.join(runDir, "harvest", "raw", "01-portrait.jpg"), "x");
    await runCriticLoopForSubTask(id, runDir, 3, "3");
    const hook = loop.calls[0]!.criticContextFor as (draft: string) => Promise<string>;

    const row = (over: Record<string, unknown>) => "```json\n" + JSON.stringify({
      imageMap: [{ harvestFile: "raw/01-portrait.jpg", section: "Hero", proves: "כותרת", ...over }],
    }) + "\n```";

    // The three rules that null the 5.2 seed are the three the critic must see.
    await expect(hook(row({ section: "ה".repeat(81) }))).resolves.toContain("סקציה ארוכה");
    await expect(hook(row({ proves: "מ".repeat(201) }))).resolves.toContain("טענה ארוכה");
    await expect(hook(row({ harvestFile: "../etc/passwd" }))).resolves.toContain("שם קובץ בקציר לא תקין");
    await expect(hook(row({}))).resolves.toBe("");
  });
});
