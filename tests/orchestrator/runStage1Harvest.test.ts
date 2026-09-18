import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Run } from "@/types";

const python = vi.hoisted(() => ({ calls: [] as { command: string; args: string[]; signal?: AbortSignal }[], fail: false, rawFiles: 1 }));
vi.mock("@/orchestrator/trackedScript", () => ({
  runTrackedScript: vi.fn(async (a: { command: string; args: string[]; signal?: AbortSignal }) => {
    python.calls.push(a);
    const outDir = a.args[1]!;
    if (python.fail) throw new Error("harvest failed: boom");
    await fs.mkdir(path.join(outDir, "raw"), { recursive: true });
    for (let i = 1; i <= python.rawFiles; i += 1) {
      await fs.writeFile(path.join(outDir, "raw", `${String(i).padStart(4, "0")}-portrait.jpg`), "x");
    }
    await fs.writeFile(path.join(outDir, "sheet.jpg"), "sheet");
    await fs.writeFile(path.join(outDir, "palette.json"), JSON.stringify({ colors: ["#111111", "#ff4499"] }));
    await fs.writeFile(path.join(outDir, "facts.json"), JSON.stringify({ facts: [{ text: "מרצה מובילה", url: "https://example.com/about" }], igFollowers: 50200 }));
    return { stdout: "ok", stderr: "" };
  }),
}));
vi.mock("@/orchestrator/spawnAgent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/orchestrator/spawnAgent")>()), spawnAgent: vi.fn(async () => ({ fullText: "### 1. טבלת תמונות\n| 1 | raw/01-portrait.jpg | דיוקן המציג | |" })) }));
vi.mock("@/orchestrator/loadAgents", () => ({ loadAgents: vi.fn(async () => [
  { slug: "rafael-researcher", name: "רפאל", role: "חוקר", color: "#000", order: 1, active: true, systemPrompt: "אתה רפאל.", avatarPath: "/tmp/a.png" },
]) }));

import { latestHandleInFeedback, runStage1Harvest, siteUrlsFromBrief } from "@/orchestrator/runStage1Harvest";
import { spawnAgent } from "@/orchestrator/spawnAgent";
import { eventBus } from "@/orchestrator/eventBus";
import { createRun, getRun, flushPersistence, __resetRegistryForTests } from "@/orchestrator/runRegistry";
import { createRunDir, loadRunState } from "@/lib/runStore";
import { initializeStages } from "@/orchestrator/initializeStages";

let runsDir: string;
function directRun(id: string, brief: string): Run {
  return { id, slug: "d", brief, createdAt: "2026-09-15T10:00:00.000Z", status: "approved", currentRound: null, messages: [],
    currentStage: 1, assetType: "sales-page", pipeline: "direct", stages: initializeStages("sales-page", "direct") };
}
beforeEach(async () => {
  runsDir = await fs.mkdtemp(path.join(os.tmpdir(), "council-harvest-"));
  process.env.RUNS_DIR_OVERRIDE = runsDir;
  __resetRegistryForTests(); python.calls = []; python.fail = false; python.rawFiles = 1; vi.mocked(spawnAgent).mockClear();
});
afterEach(async () => {
  await flushPersistence(); __resetRegistryForTests(); delete process.env.RUNS_DIR_OVERRIDE;
  await fs.rm(runsDir, { recursive: true, force: true, maxRetries: 5 });
});

describe("siteUrlsFromBrief", () => {
  it("collects every http(s) URL and an @handle or 'אינסטגרם: handle'", () => {
    expect(siteUrlsFromBrief("האתר https://example.com ועוד https://example.com/about. אינסטגרם: @michal.adar")).toEqual({
      urls: ["https://example.com", "https://example.com/about"], igHandle: "michal.adar",
    });
    expect(siteUrlsFromBrief("בלי כתובת")).toEqual({ urls: [] });
  });

  it("collects a URL written with an uppercase scheme", () => {
    expect(siteUrlsFromBrief("האתר HTTPS://Example.com/About ועוד Http://example.org")).toEqual({
      urls: ["HTTPS://Example.com/About", "Http://example.org"],
    });
  });

  it("does not read an email address as an Instagram handle", () => {
    expect(siteUrlsFromBrief("צרו קשר בכתובת info@example.com לפני הפגישה")).toEqual({ urls: [] });
  });

  it("prefers an explicit אינסטגרם: label over an @ that appears earlier inside a URL", () => {
    expect(siteUrlsFromBrief("https://example.com/@someone/page אינסטגרם: @michal.adar")).toMatchObject({ igHandle: "michal.adar" });
  });

  it("reads a handle from an instagram.com URL when there is no explicit label", () => {
    expect(siteUrlsFromBrief("העמוד שלה: https://www.instagram.com/michal.adar/")).toMatchObject({ igHandle: "michal.adar" });
  });

  it("finds a standalone @handle after whitespace, ignoring an @ inside an earlier URL", () => {
    expect(siteUrlsFromBrief("האתר שלה https://example.com/@someone/profile ותוכלו לכתוב לה @michal.adar בהודעה")).toMatchObject({ igHandle: "michal.adar" });
  });
});

describe("latestHandleInFeedback", () => {
  it("returns the newest handle in the history, not the oldest", () => {
    expect(latestHandleInFeedback(["אינסטגרם: @first.handle", "אינסטגרם: @second.handle"])).toBe("second.handle");
  });

  it("keeps the last correction when later feedback carries no handle at all", () => {
    expect(latestHandleInFeedback(["אינסטגרם: @michal.adar", "תוסיפי עוד תמונות מהאתר", "הפלטה כהה מדי"])).toBe("michal.adar");
  });

  it("returns undefined for an empty history and for a history without a handle", () => {
    expect(latestHandleInFeedback([])).toBeUndefined();
    expect(latestHandleInFeedback(["תוסיפי עוד תמונות", "צרו קשר בכתובת info@example.com"])).toBeUndefined();
  });
});

describe("runStage1Harvest", () => {
  it("runs the harvest script into <runDir>/harvest, then the sorting agent with the facts and palette in its prompt", async () => {
    const id = "2026-09-15-harvest-ok";
    const runDir = await createRunDir(id);
    createRun(directRun(id, "דף לתוכנית של מיכל אדר https://example.com אינסטגרם: @michal.adar"));
    let completed: { harvest?: unknown } | undefined;
    eventBus.on(id, (e) => { if (e.type === "subtask-completed") completed = e as { harvest?: unknown }; });
    await runStage1Harvest(id, runDir);

    expect(python.calls[0]!.args).toEqual([expect.stringMatching(/harvest_brand\.py$/), path.join(runDir, "harvest"), "https://example.com", "--ig", "michal.adar"]);
    const prompt = vi.mocked(spawnAgent).mock.calls[0]![0].prompt;
    expect(prompt).toContain("0001-portrait.jpg");
    expect(prompt).toContain("מרצה מובילה");
    expect(prompt).toContain("#ff4499");
    expect(prompt).toContain("50200");
    // Without feedback, the handle resolved for the script args, the sorting
    // prompt, and the persisted sub-task all come from the brief.
    expect(prompt).toContain("ידית האינסטגרם לצילום ההוכחה: @michal.adar");
    expect(vi.mocked(spawnAgent).mock.calls[0]![0].tools).toEqual(["Read", "Glob"]);
    const task = getRun(id)!.stages!.find((s) => s.number === 1)!.subTasks[0]!;
    expect(task.status).toBe("awaiting-decision");
    expect(task.output).toContain("טבלת תמונות");
    expect(task.harvest).toMatchObject({ schemaVersion: 1, sheetFile: "sheet.jpg", imageCount: 1, igHandle: "michal.adar" });
    expect(completed?.harvest).toMatchObject({ sheetFile: "sheet.jpg", imageCount: 1, igHandle: "michal.adar" });
  });

  it("lets feedback on this stage's card override the brief's Instagram handle: script args, persisted harvest.igHandle, and the sorting prompt all follow the correction", async () => {
    const id = "2026-09-15-harvest-feedback-ig";
    const runDir = await createRunDir(id);
    createRun(directRun(id, "דף לתוכנית של מיכל אדר https://example.com אינסטגרם: @michal.adar"));

    await runStage1Harvest(id, runDir, "אינסטגרם: @other.handle");

    expect(python.calls[0]!.args).toEqual([expect.stringMatching(/harvest_brand\.py$/), path.join(runDir, "harvest"), "https://example.com", "--ig", "other.handle"]);
    const prompt = vi.mocked(spawnAgent).mock.calls[0]![0].prompt;
    expect(prompt).toContain("ידית האינסטגרם לצילום ההוכחה: @other.handle");
    const task = getRun(id)!.stages!.find((s) => s.number === 1)!.subTasks[0]!;
    expect(task.harvest).toMatchObject({ igHandle: "other.handle" });
  });

  it("keeps the corrected handle on a second rerun whose feedback is about something else", async () => {
    const id = "2026-09-15-harvest-feedback-ig-survives";
    const runDir = await createRunDir(id);
    createRun(directRun(id, "דף לתוכנית של מיכל אדר https://example.com אינסטגרם: @michal.adar"));

    await runStage1Harvest(id, runDir, "אינסטגרם: @other.handle");
    await runStage1Harvest(id, runDir, "תוסיפי עוד תמונות מהאתר");

    // The second attempt's feedback says nothing about the handle, so the
    // correction from the first one still rules: brief handles never come back.
    expect(python.calls[1]!.args).toEqual([expect.stringMatching(/harvest_brand\.py$/), path.join(runDir, "harvest"), "https://example.com", "--ig", "other.handle"]);
    const prompt = vi.mocked(spawnAgent).mock.calls[1]![0].prompt;
    expect(prompt).toContain("ידית האינסטגרם לצילום ההוכחה: @other.handle");
    const task = getRun(id)!.stages!.find((s) => s.number === 1)!.subTasks[0]!;
    expect(task.harvest).toMatchObject({ igHandle: "other.handle" });
  });

  it("keeps the corrected handle on a plain retry with no feedback at all", async () => {
    const id = "2026-09-15-harvest-feedback-ig-retry";
    const runDir = await createRunDir(id);
    createRun(directRun(id, "דף לתוכנית של מיכל אדר https://example.com אינסטגרם: @michal.adar"));

    await runStage1Harvest(id, runDir, "אינסטגרם: @other.handle");
    await runStage1Harvest(id, runDir);

    expect(python.calls[1]!.args).toContain("other.handle");
    const task = getRun(id)!.stages!.find((s) => s.number === 1)!.subTasks[0]!;
    expect(task.harvest).toMatchObject({ igHandle: "other.handle" });
  });

  it("shows 'אין ידית' in the sorting prompt when neither the brief nor feedback carries an Instagram handle", async () => {
    const id = "2026-09-15-harvest-no-handle";
    const runDir = await createRunDir(id);
    createRun(directRun(id, "דף לתוכנית של מיכל אדר https://example.com"));

    await runStage1Harvest(id, runDir);

    const prompt = vi.mocked(spawnAgent).mock.calls[0]![0].prompt;
    expect(prompt).toContain("ידית האינסטגרם לצילום ההוכחה: אין ידית");
    const task = getRun(id)!.stages!.find((s) => s.number === 1)!.subTasks[0]!;
    expect(task.harvest).not.toHaveProperty("igHandle");
  });

  it("passes the execution signal to the script so a cancelled run kills it", async () => {
    const id = "2026-09-15-harvest-signal";
    const runDir = await createRunDir(id);
    createRun(directRun(id, "https://example.com"));
    const controller = new AbortController();
    await runStage1Harvest(id, runDir, undefined, { signal: controller.signal, throwIfAborted: () => { if (controller.signal.aborted) throw new Error("aborted"); } } as never);
    expect(python.calls[0]!.signal).toBe(controller.signal);
  });

  it("clamps the recorded image count so an oversized harvest still persists and reloads", async () => {
    python.rawFiles = 501;
    const id = "2026-09-15-harvest-many";
    const runDir = await createRunDir(id);
    createRun(directRun(id, "https://example.com"));

    await runStage1Harvest(id, runDir);

    const task = getRun(id)!.stages!.find((s) => s.number === 1)!.subTasks[0]!;
    // 500 is the ceiling the run record validates against: an unclamped count
    // makes every later save throw, and the run stops persisting in silence.
    expect(task.harvest).toMatchObject({ schemaVersion: 1, sheetFile: "sheet.jpg", imageCount: 500 });
    await flushPersistence();
    const reloaded = await loadRunState(id);
    expect(reloaded?.stages?.find((s) => s.number === 1)?.subTasks[0]?.harvest)
      .toMatchObject({ imageCount: 500 });
  });

  it("marks the sub-task error with the script's stderr when the harvest fails, rejects, and never calls the agent", async () => {
    python.fail = true;
    const id = "2026-09-15-harvest-fail";
    const runDir = await createRunDir(id);
    createRun(directRun(id, "https://example.com"));
    await expect(runStage1Harvest(id, runDir)).rejects.toThrow(/boom/);
    const task = getRun(id)!.stages!.find((s) => s.number === 1)!.subTasks[0]!;
    expect(task.status).toBe("error");
    expect(task.errorMessage).toContain("boom");
    expect(spawnAgent).not.toHaveBeenCalled();
  });
});
