import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CriticRound, Run, SSEEvent } from "@/types";

vi.mock("@/orchestrator/spawnAgent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/orchestrator/spawnAgent")>()), spawnAgent: vi.fn(async () => ({ fullText: "" })) }));
vi.mock("@/orchestrator/loadAgents", () => ({ loadAgents: vi.fn(async () => [
  { slug: "maya-lp-copywriter", name: "מאיה", role: "קופי", color: "#000", order: 1, active: true, systemPrompt: "אתה מאיה.", avatarPath: "/tmp/a.png" },
  { slug: "roni-creative", name: "רוני", role: "מבקר", color: "#000", order: 2, active: true, systemPrompt: "אתה רוני.", avatarPath: "/tmp/a.png" },
]) }));

import { parseReversals, runCriticLoop, validateReversals } from "@/orchestrator/runCriticLoop";
import { parseCriticRubric } from "@/orchestrator/criticRubric";
import { CRITIC_BLOCKED_MARKER, CRITIC_UNRESOLVED_MARKER } from "@/orchestrator/copyStandard";
import { spawnAgent } from "@/orchestrator/spawnAgent";
import { eventBus } from "@/orchestrator/eventBus";
import { createRun, getRun, flushPersistence, __resetRegistryForTests } from "@/orchestrator/runRegistry";
import { createRunDir } from "@/lib/runStore";
import { initializeStages } from "@/orchestrator/initializeStages";

const rubric = parseCriticRubric("copy-critic", "---\navg: 8\nmin: 7\n---\n## ממדים\n1. מבנה\n2. הבטחה\n");
const CRITIC_MARK = "הרובריקה שאתה שופט לפיה";
const REPAIR_MARK = "תקן בדיוק את הפריטים";
const verdict = (scores: [number, number], kind = "APPROVE", extra: Record<string, unknown> = {}) =>
  `<critic>${JSON.stringify({ scores: { "מבנה": scores[0], "הבטחה": scores[1] }, verdict: kind, fixes: [{ quote: "שורה", rule: "הבטחה", fix: "חדד" }], ...extra })}</critic>`;

function script(critic: string[]) {
  // `order` is every spawn in the order it happened: the only way to prove the
  // critic was asked again BEFORE the writer was handed anything.
  const state = { drafts: 0, repairs: 0, criticPrompts: [] as string[], repairPrompts: [] as string[], order: [] as string[] };
  vi.mocked(spawnAgent).mockImplementation(async (opts: { prompt: string }) => {
    if (opts.prompt.includes(CRITIC_MARK)) { state.order.push("critic"); state.criticPrompts.push(opts.prompt); return { fullText: critic.shift() ?? "" } as never; }
    if (opts.prompt.includes(REPAIR_MARK)) { state.order.push("repair"); state.repairs += 1; state.repairPrompts.push(opts.prompt); return { fullText: `גרסה ${state.repairs + 1}` } as never; }
    state.order.push("draft"); state.drafts += 1; return { fullText: "גרסה 1" } as never;
  });
  return state;
}

let runsDir: string;
function directRun(id: string): Run {
  const stages = initializeStages("sales-page", "direct");
  stages[0]!.status = "approved"; stages[0]!.subTasks[0]!.status = "approved"; stages[0]!.subTasks[0]!.output = "מאגר עובדות";
  return { id, slug: "d", brief: "בריף https://example.com", createdAt: "2026-09-15T10:00:00.000Z", status: "approved", currentRound: null, messages: [], currentStage: 2, assetType: "sales-page", pipeline: "direct", stages };
}
const args = (runId: string, runDir: string, maxRounds = 3, feedback?: string) =>
  ({ runId, runDir, stageNumber: 2 as const, subTaskId: "2", standard: "# ספר כללים", rubric, extraContext: "## מאגר עובדות\nמאגר", maxRounds, feedback });
const task = (id: string) => getRun(id)!.stages!.find((s) => s.number === 2)!.subTasks[0]!;

beforeEach(async () => {
  runsDir = await fs.mkdtemp(path.join(os.tmpdir(), "council-critic-loop-"));
  process.env.RUNS_DIR_OVERRIDE = runsDir; __resetRegistryForTests(); vi.mocked(spawnAgent).mockClear();
});
afterEach(async () => {
  await flushPersistence(); __resetRegistryForTests(); delete process.env.RUNS_DIR_OVERRIDE;
  await fs.rm(runsDir, { recursive: true, force: true, maxRetries: 5 });
});

describe("parseReversals", () => {
  const fix = (text: string) => ({ quote: "ציטוט", rule: "כלל", fix: text });

  it("reads the round and the 1-based item index out of the exact prefix", () => {
    expect(parseReversals([fix("מבטל את הנחיית סבב 2 פריט 1: ההנחיה מתנגשת עם הכותרת")]))
      .toEqual([{ round: 2, index: 1 }]);
    expect(parseReversals([
      fix("מבטל את הנחיית סבב 1 פריט 3: נימוק"),
      fix("תיקון רגיל בלי ביטול"),
      fix("מבטל את הנחיית סבב 2 פריט 2: נימוק"),
    ])).toEqual([{ round: 1, index: 3 }, { round: 2, index: 2 }]);
  });

  it("ignores a fix that does not open with the prefix", () => {
    expect(parseReversals([
      fix("קצר את הלד"),
      // The old, unstructured wording is not a reversal any more: without an
      // item number there is nothing to drop, so it is a critic defect.
      fix("מבטל את הנחיית סבב 2: נימוק"),
      fix("בהמשך לסבב 2 פריט 1: מבטל את הנחיית סבב 2 פריט 1"),
    ])).toEqual([]);
  });

  it("ignores malformed and out-of-range numbers", () => {
    expect(parseReversals([
      fix("מבטל את הנחיית סבב אחד פריט 1: נימוק"),
      fix("מבטל את הנחיית סבב 2 פריט אפס: נימוק"),
      fix("מבטל את הנחיית סבב 0 פריט 1: נימוק"),
      fix("מבטל את הנחיית סבב 2 פריט 0: נימוק"),
    ])).toEqual([]);
  });

  it("reads nothing out of an empty or missing fix list", () => {
    expect(parseReversals([])).toEqual([]);
    expect(parseReversals(undefined)).toEqual([]);
  });
});

describe("validateReversals", () => {
  const round = (n: number, ...fixes: string[]): CriticRound => ({
    round: n,
    verdict: "revise",
    at: "2026-09-15T10:00:00.000Z",
    fixes: fixes.map((fix) => ({ quote: "ציטוט", rule: "כלל", fix })),
  });

  it("accepts a reversal that points at an item an earlier round really has", () => {
    const { valid, invalid } = validateReversals([
      round(1, "חדד את הכותרת"),
      round(2, "מבטל את הנחיית סבב 1 פריט 1: הכותרת הישנה הייתה מדויקת"),
    ]);
    expect(invalid).toEqual([]);
    expect(valid).toEqual([{
      round: 1,
      index: 1,
      byRound: 2,
      byIndex: 1,
      fix: "מבטל את הנחיית סבב 1 פריט 1: הכותרת הישנה הייתה מדויקת",
    }]);
  });

  it("rejects an item index the round does not have, and cancels nothing with it", () => {
    const { valid, invalid } = validateReversals([
      round(1, "חדד את הכותרת"),
      round(2, "מבטל את הנחיית סבב 1 פריט 4: טעות"),
    ]);
    expect(valid).toEqual([]);
    expect(invalid).toHaveLength(1);
    expect(invalid[0]!.reason).toContain("אין פריט 4 בסבב 1");
    expect(invalid[0]!.reversal.fix).toContain("פריט 4");
  });

  it("rejects a round that does not exist at all", () => {
    const { valid, invalid } = validateReversals([
      round(1, "חדד את הכותרת"),
      round(2, "מבטל את הנחיית סבב 9 פריט 1: טעות"),
    ]);
    expect(valid).toEqual([]);
    expect(invalid[0]!.reason).toContain("אין פריט 1 בסבב 9");
  });

  it("rejects a reference to its own round and to a later one", () => {
    const own = validateReversals([
      round(1, "חדד את הכותרת"),
      round(2, "פתח בשורת פקודה", "מבטל את הנחיית סבב 2 פריט 1: סתירה"),
    ]);
    expect(own.valid).toEqual([]);
    expect(own.invalid[0]!.reason).toContain("סבב 2 אינו קודם לסבב 2");

    const later = validateReversals([
      round(1, "מבטל את הנחיית סבב 2 פריט 1: סתירה"),
      round(2, "פתח בשורת פקודה"),
    ]);
    expect(later.valid).toEqual([]);
    expect(later.invalid[0]!.reason).toContain("אינו קודם");
  });
});

describe("runCriticLoop", () => {
  it("approves at round 2 after one repair, records both rounds and emits round events", async () => {
    const id = "loop-approve"; const runDir = await createRunDir(id); createRun(directRun(id));
    const events: SSEEvent[] = []; eventBus.on(id, (e) => events.push(e));
    const s = script([verdict([9, 6], "REVISE"), verdict([9, 9])]);
    await runCriticLoop(args(id, runDir));
    expect(s.drafts).toBe(1); expect(s.repairs).toBe(1);
    expect(task(id).status).toBe("awaiting-decision");
    expect(task(id).output).toBe("גרסה 2");
    expect(task(id).criticRounds?.map((r) => r.verdict)).toEqual(["revise", "approve"]);
    expect(task(id).criticRounds?.[0]?.scores).toEqual({ "מבנה": 9, "הבטחה": 6 });
    // Completion leaves no round "in progress": the phase and the current-round
    // number are cleared, while the round history itself is kept.
    expect(task(id).currentPhase).toBeUndefined();
    expect(task(id).criticRound).toBeUndefined();
    expect(task(id).criticRounds).toHaveLength(2);
    expect(events.filter((e) => e.type === "critic-round-completed")).toHaveLength(2);
    expect(s.criticPrompts[0]).toContain("מבנה");
    // The repair round carries the binding context, not only the draft and the fixes.
    expect(s.repairPrompts[0]).toContain("ספר כללים");
    expect(s.repairPrompts[0]).toContain("מאגר");
    expect(s.repairPrompts[0]).toContain("גרסה 1");
    expect(s.repairPrompts[0]).toContain("חדד");
  });

  it("carries the prior rounds into round 2: the critic sees what it already demanded and may not reverse it silently, the writer sees what stays in effect", async () => {
    const id = "loop-history"; const runDir = await createRunDir(id); createRun(directRun(id));
    const round1Fix = { quote: "כותרת ישנה", rule: "ההבטחה הגדולה", fix: "החלף למנגנון עם שם" };
    const s = script([verdict([9, 6], "REVISE", { fixes: [round1Fix] }), verdict([9, 9])]);
    await runCriticLoop(args(id, runDir));

    // Round 1 has nothing behind it, so no history block at all.
    expect(s.criticPrompts[0]).not.toContain("## סבבים קודמים");
    const round2Critic = s.criticPrompts[1]!;
    expect(round2Critic).toContain("## סבבים קודמים");
    expect(round2Critic).toContain("סבב 1");
    expect(round2Critic).toContain("revise");
    expect(round2Critic).toContain("הבטחה: 6");
    expect(round2Critic).toContain("כותרת ישנה");
    expect(round2Critic).toContain("החלף למנגנון עם שם");
    expect(round2Critic).toContain("מבטל את הנחיית סבב N פריט k: ");

    // Round 2's repair has no older round behind round 1, and round 1's fixes
    // are the items it is being asked to apply right now: repeating them as
    // "already in effect" would tell the writer they are closed.
    expect(s.repairPrompts[0]).not.toContain("## תיקונים מסבבים קודמים");
  });

  it("round 3's repair keeps round 1's fixes in effect without repeating round 2's current items", async () => {
    const id = "loop-history-3"; const runDir = await createRunDir(id); createRun(directRun(id));
    const round1Fix = { quote: "כותרת ישנה", rule: "ההבטחה הגדולה", fix: "החלף למנגנון עם שם" };
    const round2Fix = { quote: "לֶד ארוך", rule: "מבנה", fix: "קצר את הלֶד לשלוש שורות" };
    const s = script([
      verdict([9, 6], "REVISE", { fixes: [round1Fix] }),
      verdict([9, 7], "REVISE", { fixes: [round2Fix] }),
      verdict([9, 9]),
    ]);
    await runCriticLoop(args(id, runDir));

    const repair = s.repairPrompts[1]!;
    const block = repair.slice(repair.indexOf("## תיקונים מסבבים קודמים (נשארים בתוקף)"));
    expect(repair).toContain("## תיקונים מסבבים קודמים (נשארים בתוקף)");
    expect(block).toContain("החלף למנגנון עם שם");
    // Round 2's fix is the current item list above the block, not history.
    expect(block).not.toContain("קצר את הלֶד לשלוש שורות");
    expect(repair).toContain("קצר את הלֶד לשלוש שורות");
    // The critic, unlike the writer, sees every finished round including the last.
    expect(s.criticPrompts[2]).toContain("סבב 2");
    expect(s.criticPrompts[2]).toContain("קצר את הלֶד לשלוש שורות");
  });

  /** The block the repair prompt hands the writer as "everything still binding". */
  function priorBlock(repair: string): { inForce: string; cancelled: string } {
    const block = repair.slice(
      repair.indexOf("## תיקונים מסבבים קודמים (נשארים בתוקף)"),
      repair.indexOf("## המשימה"),
    );
    const split = block.indexOf("### הנחיות שבוטלו (אינן בתוקף)");
    return split === -1
      ? { inForce: block, cancelled: "" }
      : { inForce: block.slice(0, split), cancelled: block.slice(split) };
  }

  const ROUND1_FIX = { quote: "כותרת ישנה", rule: "ההבטחה הגדולה", fix: "החלף למנגנון עם שם" };
  const ROUND2_FIX_A = { quote: "פתיח מנומס", rule: "מבנה", fix: "פתח בשורת פקודה" };
  const REVERSAL_OF_A = {
    quote: "שורת הפקודה",
    rule: "מבנה",
    fix: "מבטל את הנחיית סבב 2 פריט 1: הפקודה בפתיח מתנגשת עם הכותרת. החזר פתיח מתאר.",
  };

  it("drops a reversed fix from what stays in effect and lists it under its own cancelled heading", async () => {
    const id = "loop-reversal"; const runDir = await createRunDir(id); createRun(directRun(id));
    const s = script([
      verdict([9, 6], "REVISE", { fixes: [ROUND1_FIX] }),
      verdict([9, 6], "REVISE", { fixes: [ROUND2_FIX_A] }),
      verdict([9, 7], "REVISE", { fixes: [REVERSAL_OF_A] }),
      verdict([9, 9]),
    ]);
    await runCriticLoop(args(id, runDir, 4));

    // Round 4 is the repair that follows the reversal: its "still in effect"
    // list is rounds 1 and 2, and round 2's item is exactly the reversed one.
    const { inForce, cancelled } = priorBlock(s.repairPrompts[2]!);
    expect(inForce).toContain("החלף למנגנון עם שם");
    expect(inForce).not.toContain("פתח בשורת פקודה");
    // The binding trailer belongs to the in-force list alone.
    expect(inForce).toContain("כל מה שכבר תוקן לפי הרשימה הזאת נשאר כפי שהוא");
    // Not merely dropped: the writer is told the instruction is void, with the
    // round it came from and the round that cancelled it kept apart.
    expect(cancelled).toContain("הנחיה מסבב 2 פריט 1 שבוטלה בסבב 3: \"פתיח מנומס\"");
    // The reversal itself is the current item list above the block.
    expect(s.repairPrompts[2]).toContain("מבטל את הנחיית סבב 2 פריט 1");
  });

  it("keeps a reversal in force in every later round, not only in the next one", async () => {
    const id = "loop-reversal-persists"; const runDir = await createRunDir(id); createRun(directRun(id));
    const s = script([
      verdict([9, 6], "REVISE", { fixes: [ROUND1_FIX] }),
      verdict([9, 6], "REVISE", { fixes: [ROUND2_FIX_A] }),
      verdict([9, 7], "REVISE", { fixes: [REVERSAL_OF_A] }),
      verdict([9, 7], "REVISE", { fixes: [{ quote: "סיום", rule: "מבנה", fix: "חדד את הסיום" }] }),
      verdict([9, 9]),
    ]);
    await runCriticLoop(args(id, runDir, 5));

    // Round 5's repair: the reversal is two rounds back now, and the fix it
    // cancelled must not come back to life as "still in effect".
    const { inForce, cancelled } = priorBlock(s.repairPrompts[3]!);
    expect(inForce).toContain("החלף למנגנון עם שם");
    expect(inForce).not.toContain("פתח בשורת פקודה");
    expect(cancelled).toContain("הנחיה מסבב 2 פריט 1 שבוטלה בסבב 3");
  });

  it("lets a reversal of a reversal put the original instruction back in force", async () => {
    const id = "loop-reversal-of-reversal"; const runDir = await createRunDir(id); createRun(directRun(id));
    const s = script([
      verdict([9, 6], "REVISE", { fixes: [ROUND1_FIX] }),
      verdict([9, 6], "REVISE", { fixes: [ROUND2_FIX_A] }),
      verdict([9, 7], "REVISE", { fixes: [REVERSAL_OF_A] }),
      verdict([9, 7], "REVISE", { fixes: [{
        quote: "הפתיח המתאר",
        rule: "מבנה",
        fix: "מבטל את הנחיית סבב 3 פריט 1: הביטול היה שגוי. שורת הפקודה בפתיח נשארת.",
      }] }),
      verdict([9, 9]),
    ]);
    await runCriticLoop(args(id, runDir, 5));

    const { inForce, cancelled } = priorBlock(s.repairPrompts[3]!);
    // Round 4 cancelled the round-3 reversal, so round 2's fix binds again.
    expect(inForce).toContain("פתח בשורת פקודה");
    expect(cancelled).toContain("הנחיה מסבב 3 פריט 1 שבוטלה בסבב 4");
    expect(cancelled).not.toContain("הנחיה מסבב 2 פריט 1");
  });

  it("settles a three-deep chain of reversals the way the last word decides it", async () => {
    const id = "loop-reversal-chain"; const runDir = await createRunDir(id); createRun(directRun(id));
    // X cancels round 1, Y cancels X, Z cancels Y. Z has the last word, so Y is
    // void, X stands again, and round 1's instruction is cancelled after all.
    const x = { quote: "הכותרת החדשה", rule: "ההבטחה הגדולה", fix: "מבטל את הנחיית סבב 1 פריט 1: הכותרת הישנה הייתה מדויקת." };
    const y = { quote: "המנגנון", rule: "ההבטחה הגדולה", fix: "מבטל את הנחיית סבב 2 פריט 1: הביטול היה נמהר." };
    const z = { quote: "הכותרת", rule: "ההבטחה הגדולה", fix: "מבטל את הנחיית סבב 3 פריט 1: הביטול השני היה השגוי." };
    const s = script([
      verdict([9, 6], "REVISE", { fixes: [ROUND1_FIX] }),
      verdict([9, 6], "REVISE", { fixes: [x] }),
      verdict([9, 6], "REVISE", { fixes: [y] }),
      verdict([9, 7], "REVISE", { fixes: [z] }),
      verdict([9, 9]),
    ]);
    await runCriticLoop(args(id, runDir, 5));

    const { inForce, cancelled } = priorBlock(s.repairPrompts[3]!);
    // Round 1's instruction is cancelled by X, which stands again.
    expect(cancelled).toContain("הנחיה מסבב 1 פריט 1 שבוטלה בסבב 2");
    expect(inForce).not.toContain("החלף למנגנון עם שם");
    // Y is the one Z cancelled.
    expect(cancelled).toContain("הנחיה מסבב 3 פריט 1 שבוטלה בסבב 4");
    // A standing reversal is a ruling about another item, not an instruction to
    // keep applying: neither X nor Z is offered as a fix that stays in force.
    expect(inForce).not.toContain("הכותרת הישנה הייתה מדויקת");
    expect(inForce).not.toContain("הביטול השני היה השגוי");
    // Its reasoning is not lost: it is stated next to what it cancelled.
    expect(cancelled).toContain("הכותרת הישנה הייתה מדויקת");
  });

  it("refuses the forward reference that a pair of mutual reversals would need", async () => {
    const id = "loop-reversal-cycle"; const runDir = await createRunDir(id); createRun(directRun(id));
    // Two reversals can only cancel each other if one of them points forward, at
    // a round that has not been judged yet. That reference is refused in the
    // round that wrote it, so the writer never receives a pair that cancel each
    // other, and no item is silently dropped on the way.
    const forward = { quote: "פתיח", rule: "מבנה", fix: "מבטל את הנחיית סבב 3 פריט 1: פתח בשורת פקודה." };
    const s = script([
      verdict([9, 6], "REVISE", { fixes: [ROUND1_FIX] }),
      verdict([9, 6], "REVISE", { fixes: [forward] }),
      verdict([9, 6], "REVISE", { fixes: [ROUND2_FIX_A] }),
      verdict([9, 7], "REVISE", { fixes: [{ quote: "סיום", rule: "מבנה", fix: "חדד את הסיום" }] }),
      verdict([9, 9]),
    ]);
    await runCriticLoop(args(id, runDir, 5));

    // Round 3 does not exist when round 2 is judged, so that is what it is told.
    expect(s.criticPrompts[2]).toContain("אין פריט 1 בסבב 3");
    // The re-ask is not a round: the last repair is the third, not the fourth.
    const { inForce, cancelled } = priorBlock(s.repairPrompts[2]!);
    expect(cancelled).toBe("");
    expect(inForce).toContain("החלף למנגנון עם שם");
    expect(inForce).toContain("פתח בשורת פקודה");
    // The refused reference never reached the writer, in any round.
    expect(s.repairPrompts.every((p) => !p.includes("מבטל את הנחיית סבב 3 פריט 1"))).toBe(true);
  });

  const INVALID_BLOCK = "## הפניות ביטול לא תקינות מהסבב הקודם (תקן)";
  const invalidReversal = (fix: string) => ({ quote: "ש", rule: "מבנה", fix });

  // A reversal that points at no real item cancels nothing, so forwarding it
  // would hand the writer the old instruction and its cancellation at once. It
  // goes back to the critic inside the same round, before the writer runs again.
  it("re-asks the critic in the same round on an item index that does not exist, before any repair", async () => {
    const id = "loop-reversal-bad-index"; const runDir = await createRunDir(id); createRun(directRun(id));
    const s = script([
      verdict([9, 6], "REVISE", { fixes: [ROUND1_FIX] }),
      // Round 1 had one item, so item 4 of it does not exist.
      verdict([9, 6], "REVISE", { fixes: [invalidReversal("מבטל את הנחיית סבב 1 פריט 4: טעות")] }),
      verdict([9, 6], "REVISE", { fixes: [ROUND2_FIX_A] }),
      verdict([9, 9]),
    ]);
    await runCriticLoop(args(id, runDir, 4));

    // The correction was asked for and answered before the second repair ran.
    expect(s.order).toEqual(["draft", "critic", "repair", "critic", "critic", "repair", "critic"]);
    expect(s.repairs).toBe(2);
    const reask = s.criticPrompts[2]!;
    expect(reask).toContain(INVALID_BLOCK);
    expect(reask).toContain("אין פריט 4 בסבב 1");
    expect(reask).toContain("מבטל את הנחיית סבב 1 פריט 4: טעות");
    // The round is recorded as the corrected verdict, with the re-ask on it.
    expect(task(id).criticRounds?.[1]?.fixes).toEqual([ROUND2_FIX_A]);
    expect(task(id).criticRounds?.[1]?.reversalReask).toBe(true);
    // The writer only ever saw the corrected list: no invalid text, no cancelled line.
    const repair = s.repairPrompts[1]!;
    expect(repair).toContain("פתח בשורת פקודה");
    expect(repair).not.toContain("מבטל את הנחיית סבב 1 פריט 4");
    expect(repair).not.toContain("### הנחיות שבוטלו (אינן בתוקף)");
  });

  it("re-asks the critic on a round that does not exist", async () => {
    const id = "loop-reversal-bad-round"; const runDir = await createRunDir(id); createRun(directRun(id));
    const s = script([
      verdict([9, 6], "REVISE", { fixes: [ROUND1_FIX] }),
      verdict([9, 6], "REVISE", { fixes: [invalidReversal("מבטל את הנחיית סבב 9 פריט 1: טעות")] }),
      verdict([9, 6], "REVISE", { fixes: [ROUND2_FIX_A] }),
      verdict([9, 9]),
    ]);
    await runCriticLoop(args(id, runDir, 4));

    expect(s.criticPrompts[2]).toContain("אין פריט 1 בסבב 9");
    expect(s.order.indexOf("critic")).toBeLessThan(s.order.indexOf("repair"));
    expect(s.repairs).toBe(2);
  });

  it("re-asks the critic on a reversal of its own round, which is not an earlier item", async () => {
    const id = "loop-reversal-self-round"; const runDir = await createRunDir(id); createRun(directRun(id));
    const s = script([
      verdict([9, 6], "REVISE", { fixes: [ROUND1_FIX] }),
      verdict([9, 6], "REVISE", { fixes: [ROUND2_FIX_A, invalidReversal("מבטל את הנחיית סבב 2 פריט 1: סתירה")] }),
      verdict([9, 6], "REVISE", { fixes: [ROUND2_FIX_A] }),
      verdict([9, 9]),
    ]);
    await runCriticLoop(args(id, runDir, 4));

    expect(s.criticPrompts[2]).toContain(INVALID_BLOCK);
    expect(s.criticPrompts[2]).toContain("סבב 2 אינו קודם לסבב 2");
    expect(s.repairs).toBe(2);
    expect(s.repairPrompts[1]).not.toContain("מבטל את הנחיית סבב 2 פריט 1");
  });

  it("errors instead of repairing when the critic returns an invalid reversal twice", async () => {
    const id = "loop-reversal-twice"; const runDir = await createRunDir(id); createRun(directRun(id));
    const s = script([
      verdict([9, 6], "REVISE", { fixes: [ROUND1_FIX] }),
      verdict([9, 6], "REVISE", { fixes: [invalidReversal("מבטל את הנחיית סבב 1 פריט 4: טעות")] }),
      verdict([9, 6], "REVISE", { fixes: [invalidReversal("מבטל את הנחיית סבב 7 פריט 2: שוב טעות")] }),
      verdict([9, 9]),
    ]);

    await expect(runCriticLoop(args(id, runDir, 4))).rejects.toThrow(/הפניית ביטול לא תקינה פעמיים/);
    // One repair only: the one that followed round 1, never one on the defect.
    expect(s.repairs).toBe(1);
    expect(s.criticPrompts).toHaveLength(3);
    expect(task(id).status).toBe("error");
    expect(task(id).errorMessage).toContain("הפניית ביטול לא תקינה פעמיים");
    expect(task(id).criticRounds?.[1]?.reversalReask).toBe(true);
  });

  it("does not re-ask, and changes nothing, when the reversal reference is valid", async () => {
    const id = "loop-reversal-valid"; const runDir = await createRunDir(id); createRun(directRun(id));
    const s = script([
      verdict([9, 6], "REVISE", { fixes: [ROUND1_FIX] }),
      verdict([9, 6], "REVISE", { fixes: [ROUND2_FIX_A] }),
      verdict([9, 7], "REVISE", { fixes: [REVERSAL_OF_A] }),
      verdict([9, 9]),
    ]);
    await runCriticLoop(args(id, runDir, 4));

    expect(s.order).toEqual(["draft", "critic", "repair", "critic", "repair", "critic", "repair", "critic"]);
    expect(s.criticPrompts.every((p) => !p.includes(INVALID_BLOCK))).toBe(true);
    expect(task(id).criticRounds?.[2]?.reversalReask).toBeUndefined();
    const { inForce, cancelled } = priorBlock(s.repairPrompts[2]!);
    expect(inForce).not.toContain("פתח בשורת פקודה");
    expect(cancelled).toContain("הנחיה מסבב 2 פריט 1 שבוטלה בסבב 3");
  });

  it("appends the per-draft critic context when a hook is given", async () => {
    const id = "loop-hook"; const runDir = await createRunDir(id); createRun(directRun(id));
    const s = script([verdict([9, 9])]);
    await runCriticLoop({ ...args(id, runDir), criticContextFor: async (draft) => `## קבצים שאינם קיימים (חובה לתקן)\n${draft.length}` });
    expect(s.criticPrompts[0]).toContain("קבצים שאינם קיימים");
  });

  it("re-asks once on an unreadable verdict and then errors, never a fake verdict", async () => {
    const id = "loop-unreadable"; const runDir = await createRunDir(id); createRun(directRun(id));
    const s = script(["<invoke name=\"Bash\">echo</invoke>", "בלי בלוק"]);
    // Rejects: the execution manager must see the failure (executionService.ts:193).
    await expect(runCriticLoop(args(id, runDir))).rejects.toThrow(/לא החזיר פסק דין/);
    expect(s.criticPrompts).toHaveLength(2);
    expect(s.criticPrompts[1]).toContain("לא החזרת פסק דין");
    expect(task(id).status).toBe("error");
    expect(task(id).errorMessage).toContain("המבקר לא החזיר פסק דין");
    expect(s.repairs).toBe(0);
    expect(task(id).criticRounds?.map((r) => r.verdict)).toEqual(["unreadable"]);
  });

  it("stops on BLOCK with the marker and the reason", async () => {
    const id = "loop-block"; const runDir = await createRunDir(id); createRun(directRun(id));
    const s = script([verdict([10, 10], "BLOCK", { reason: "שם של מנטור מתחרה" })]);
    await runCriticLoop(args(id, runDir));
    expect(s.repairs).toBe(0);
    expect(task(id).output.startsWith(`${CRITIC_BLOCKED_MARKER}: שם של מנטור מתחרה`)).toBe(true);
    expect(task(id).criticRounds?.[0]?.verdict).toBe("block");
  });

  it("after maxRounds without approve, persists the last version with the unresolved marker and the scores", async () => {
    const id = "loop-unresolved"; const runDir = await createRunDir(id); createRun(directRun(id));
    const s = script([verdict([7, 6], "REVISE"), verdict([8, 6], "REVISE"), verdict([8, 6], "REVISE")]);
    await runCriticLoop(args(id, runDir, 3));
    expect(s.repairs).toBe(2);
    expect(task(id).output.startsWith(`${CRITIC_UNRESOLVED_MARKER} 3 סבבים`)).toBe(true);
    expect(task(id).output).toContain("הבטחה: 6");
    expect(task(id).output).toContain("גרסה 3");
  });

  it("a feedback rerun shows the critic the previous version and the feedback", async () => {
    const id = "loop-feedback"; const runDir = await createRunDir(id); createRun(directRun(id));
    await fs.mkdir(path.join(runDir, "stage-2"), { recursive: true });
    await fs.writeFile(path.join(runDir, "stage-2", "2.md"), "הגרסה הקודמת");
    const s = script([verdict([9, 9])]);
    await runCriticLoop(args(id, runDir, 3, "קצר את הפתיח"));
    expect(s.criticPrompts[0]).toContain("הגרסה הקודמת");
    expect(s.criticPrompts[0]).toContain("קצר את הפתיח");
    expect(s.criticPrompts[0]).toContain("רק מה שהמשוב ביקש");
  });
});
