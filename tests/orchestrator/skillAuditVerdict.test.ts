import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runMiniDiscussion } from "@/orchestrator/runMiniDiscussion";
import { spawnAgent } from "@/orchestrator/spawnAgent";
import { loadAgents } from "@/orchestrator/loadAgents";
import { createRun, getRun, flushPersistence, __resetRegistryForTests } from "@/orchestrator/runRegistry";
import {
  SKILL_AUDIT_FAILED_MARKER,
  SKILL_AUDIT_SKIPPED_MARKER,
  auditBlocksExpress,
} from "@/orchestrator/copyStandard";
import type { Agent, Run } from "@/types";

vi.mock("@/orchestrator/spawnAgent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/orchestrator/spawnAgent")>()),
  spawnAgent: vi.fn(async () => ({ fullText: "" })),
}));

vi.mock("@/orchestrator/loadAgents", () => ({
  loadAgents: vi.fn(async () => []),
}));

const AUDIT_PROMPT_MARK = "ביקורת ציות לסקיל. לא ביקורת טעם";
const REPAIR_PROMPT_MARK = "נכשלה בביקורת ציות לסקיל";
const LEAKED_TOOL_CALL = "<invoke name=\"Bash\">\n<parameter name=\"command\">cat <<'EOF'\nfoo\nEOF</parameter>\n</invoke>\necho 1\necho 2";

function makeAgent(slug: Agent["slug"], name: string): Agent {
  return { slug, name, role: name, color: "#000", order: 1, active: true, systemPrompt: `אתה ${name}.`, avatarPath: "/tmp/a.png" };
}

const agents: Agent[] = [makeAgent("maya-lp-copywriter", "מאיה"), makeAgent("roni-creative", "רוני")];

function baseRun(id: string): Run {
  return {
    id,
    slug: "audit-run",
    brief: "בריף לבדיקה",
    createdAt: "2026-09-15T10:00:00.000Z",
    status: "approved",
    currentRound: null,
    messages: [],
    currentStage: 4,
    stages: [
      {
        number: 4,
        title: "קופי",
        ownerSlug: "maya-lp-copywriter",
        status: "running",
        output: "",
        feedbackHistory: [],
        subTasks: [{ id: "4a", title: "הירו", status: "running", output: "", feedbackHistory: [] }],
      },
    ],
    assetType: "sales-page",
  };
}

/** Queue audit answers in order; everything else (draft, critique, revise, repair) answers with a fixed text. */
function scriptAgents(auditAnswers: string[]): { auditPrompts: string[]; repairs: number } {
  const state = { auditPrompts: [] as string[], repairs: 0 };
  vi.mocked(spawnAgent).mockImplementation(async (opts: { prompt: string }) => {
    if (opts.prompt.includes(AUDIT_PROMPT_MARK)) {
      state.auditPrompts.push(opts.prompt);
      return { fullText: auditAnswers.shift() ?? "" } as never;
    }
    if (opts.prompt.includes(REPAIR_PROMPT_MARK)) {
      state.repairs += 1;
      return { fullText: "גרסה מתוקנת" } as never;
    }
    return { fullText: "טיוטת הסקציה" } as never;
  });
  return state;
}

let runsDir: string;

beforeEach(async () => {
  runsDir = await fs.mkdtemp(path.join(os.tmpdir(), "council-audit-verdict-"));
  process.env.RUNS_DIR_OVERRIDE = runsDir;
  await fs.mkdir(path.join(runsDir, "logs"), { recursive: true });
  __resetRegistryForTests();
  vi.mocked(spawnAgent).mockClear();
  vi.mocked(loadAgents).mockResolvedValue(agents);
});

afterEach(async () => {
  await flushPersistence();
  __resetRegistryForTests();
  delete process.env.RUNS_DIR_OVERRIDE;
  await fs.rm(runsDir, { recursive: true, force: true, maxRetries: 5 });
});

function output(runId: string): string {
  return getRun(runId)?.stages?.find((s) => s.number === 4)?.subTasks.find((st) => st.id === "4a")?.output ?? "";
}

describe("the skill-compliance audit verdict", () => {
  it("פסק דין לא קריא פעמיים = הביקורת לא רצה: סימון 'לא רצה', בלי תיקון ובלי סימון כישלון", async () => {
    const state = scriptAgents([LEAKED_TOOL_CALL, LEAKED_TOOL_CALL]);
    createRun(baseRun("r-unreadable"));
    await runMiniDiscussion("r-unreadable", runsDir, 4, "4a");

    expect(state.auditPrompts).toHaveLength(2);
    expect(state.repairs).toBe(0);
    const text = output("r-unreadable");
    expect(text.startsWith(SKILL_AUDIT_SKIPPED_MARKER)).toBe(true);
    expect(text).not.toContain(SKILL_AUDIT_FAILED_MARKER);
    expect(text).not.toContain("<invoke");
    expect(text).toContain("טיוטת הסקציה");
  });

  it("השאלה החוזרת מדגישה שאין כלים ומבקשת רק את שורת פסק הדין", async () => {
    const state = scriptAgents([LEAKED_TOOL_CALL, "פסק דין: עובר"]);
    createRun(baseRun("r-retry"));
    await runMiniDiscussion("r-retry", runsDir, 4, "4a");

    expect(state.auditPrompts).toHaveLength(2);
    expect(state.auditPrompts[0]).toContain("אין לך כלים");
    expect(state.auditPrompts[1]).toContain("לא החזרת פסק דין");
    expect(state.repairs).toBe(0);
    const text = output("r-retry");
    expect(text).toBe("טיוטת הסקציה");
  });

  it("פסק דין 'לא עובר' אמיתי עדיין מוביל לתיקון ואז לאישור", async () => {
    const state = scriptAgents(["פסק דין: לא עובר\n1. ציטוט: מקף ארוך", "פסק דין: עובר"]);
    createRun(baseRun("r-fail-then-pass"));
    await runMiniDiscussion("r-fail-then-pass", runsDir, 4, "4a");

    expect(state.repairs).toBe(1);
    expect(output("r-fail-then-pass")).toBe("גרסה מתוקנת");
  });

  it("שני כשלונות אמיתיים עדיין מסמנים כישלון ציות", async () => {
    scriptAgents(["פסק דין: לא עובר\n1. הפרה", "פסק דין: לא עובר\n1. עדיין הפרה"]);
    createRun(baseRun("r-fail-twice"));
    await runMiniDiscussion("r-fail-twice", runsDir, 4, "4a");

    expect(output("r-fail-twice").startsWith(SKILL_AUDIT_FAILED_MARKER)).toBe(true);
  });

  it("פסק דין לא קריא אחרי תיקון אחד מסומן 'לא רצה' ולא ככישלון", async () => {
    const state = scriptAgents(["פסק דין: לא עובר\n1. הפרה", LEAKED_TOOL_CALL, "בלי פסק דין"]);
    createRun(baseRun("r-fail-then-unreadable"));
    await runMiniDiscussion("r-fail-then-unreadable", runsDir, 4, "4a");

    expect(state.repairs).toBe(1);
    expect(state.auditPrompts).toHaveLength(3);
    const text = output("r-fail-then-unreadable");
    expect(text.startsWith(SKILL_AUDIT_SKIPPED_MARKER)).toBe(true);
    expect(text).toContain("גרסה מתוקנת");
  });
});

describe("auditBlocksExpress", () => {
  it("עוצר את אקספרס על כישלון ציות וגם על ביקורת שלא רצה, ולא על פלט רגיל", () => {
    expect(auditBlocksExpress(`${SKILL_AUDIT_FAILED_MARKER}\n\nטקסט`)).toBe(true);
    expect(auditBlocksExpress(`${SKILL_AUDIT_SKIPPED_MARKER}\n\nטקסט`)).toBe(true);
    expect(auditBlocksExpress("טקסט רגיל")).toBe(false);
    expect(auditBlocksExpress(undefined)).toBe(false);
  });
});
