import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runSubTask } from "@/orchestrator/runSubTask";
import { runDiscussion } from "@/orchestrator/runDiscussion";
import { spawnAgent } from "@/orchestrator/spawnAgent";
import { createRun, __resetRegistryForTests } from "@/orchestrator/runRegistry";
import type { Run } from "@/types";

vi.mock("@/orchestrator/spawnAgent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/orchestrator/spawnAgent")>()),
  spawnAgent: vi.fn(async () => ({ fullText: "פלט", exitCode: 0, durationMs: 1 })),
}));

const AGENTS = [
  { slug: "rafael-researcher", name: "רפאל לוי", role: "חוקר", color: "#06B6D4", order: 1, active: true, systemPrompt: "p", avatarPath: "a.png" },
  { slug: "yoni-strategist", name: "יוני בן-דוד", role: "אסטרטג", color: "#3B5BFD", order: 2, active: true, systemPrompt: "p", avatarPath: "a.png" },
  { slug: "daniel-lp-designer", name: "דניאל ברוך", role: "מעצב", color: "#8B6F3D", order: 3, active: true, systemPrompt: "p", avatarPath: "a.png" },
  { slug: "roni-creative", name: "רוני אבישר", role: "קריאייטיב", color: "#FF7A00", order: 5, active: true, systemPrompt: "p", avatarPath: "a.png" },
  { slug: "synthesizer", name: "סינטיסייזר", role: "מסכם", color: "#9CA3B8", order: 4, active: true, systemPrompt: "p", avatarPath: "a.png" },
];

vi.mock("@/orchestrator/loadAgents", () => ({
  loadAgents: vi.fn(async () => AGENTS),
}));

let testRunsDir: string;

function runWithStages(id: string): Run {
  return {
    id,
    slug: "test-run",
    brief: "בריף לבדיקה",
    createdAt: "2026-08-28T09:00:00.000Z",
    status: "approved",
    currentRound: null,
    messages: [],
    currentStage: 1,
    stages: [
      {
        number: 1,
        title: "מחקר שוק",
        ownerSlug: "rafael-researcher",
        status: "pending",
        output: "",
        feedbackHistory: [],
        subTasks: [{ id: "1", title: "מסמך מחקר שוק", status: "pending", output: "", feedbackHistory: [] }],
      },
      // שלב 6 הוא תור יחיד בלי מבקרים ובלי תפקיד מחקר; שלבים 2-3 עברו לדיון מיני (F105).
      {
        number: 6,
        title: "זוויות למודעות",
        ownerSlug: "omer-ad-copywriter",
        status: "pending",
        output: "",
        feedbackHistory: [],
        subTasks: [{ id: "6", title: "3 זוויות למודעות + hooks", status: "pending", output: "", feedbackHistory: [] }],
      },
    ],
  };
}

beforeEach(async () => {
  testRunsDir = await fs.mkdtemp(path.join(os.tmpdir(), "council-research-"));
  process.env.RUNS_DIR_OVERRIDE = testRunsDir;
  __resetRegistryForTests();
  vi.mocked(spawnAgent).mockClear();
});

afterEach(async () => {
  delete process.env.RUNS_DIR_OVERRIDE;
  // ניקוי הוא לא מושא הבדיקה: כתיבות אסינכרוניות של הרג'יסטרי יכולות עוד לגעת
  // בתיקייה ברגע המחיקה, ולכן מנסים שוב ולא מפילים טסט על שגיאת ניקוי.
  await fs.rm(testRunsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
});

/**
 * `--tools` decides which tools exist for a turn; permission is decided
 * separately. A headless turn cannot answer a permission prompt, so a research
 * tool that is listed but not permitted is refused, and the researcher writes
 * from general knowledge instead. Both grants have to travel together.
 */
describe("research turns are granted the web tools they are given", () => {
  it("permits the researcher's web tools in the discussion", async () => {
    createRun({ ...runWithStages("2026-08-28-1400"), status: "pending", stages: undefined });

    await runDiscussion("2026-08-28-1400", testRunsDir);

    const researcherCalls = vi.mocked(spawnAgent).mock.calls
      .map(([options]) => options)
      .filter((options) => (options.tools ?? []).includes("WebSearch"));
    // Two discussion rounds by default since 02.09.2026 (opening + confrontation).
    expect(researcherCalls).toHaveLength(2);
    for (const options of researcherCalls) {
      expect(options.allowedTools).toEqual(["WebSearch", "WebFetch"]);
    }
  });

  it("permits the web tools on the market research stage", async () => {
    createRun(runWithStages("2026-08-28-1401"));

    await runSubTask("2026-08-28-1401", testRunsDir, 1, "1");

    const [options] = vi.mocked(spawnAgent).mock.calls.at(-1)!;
    expect(options.tools).toEqual(["WebSearch", "WebFetch"]);
    expect(options.allowedTools).toEqual(["WebSearch", "WebFetch"]);
  });

  it("gives a stage with no research role neither the tools nor the permission", async () => {
    createRun(runWithStages("2026-08-28-1402"));

    await runSubTask("2026-08-28-1402", testRunsDir, 6, "6");

    const [options] = vi.mocked(spawnAgent).mock.calls.at(-1)!;
    expect(options.tools).toEqual([]);
    expect(options.allowedTools).toEqual([]);
  });
});
