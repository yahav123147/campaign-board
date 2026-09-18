import fs from "node:fs/promises";
import path from "node:path";
import { spawnAgent } from "./spawnAgent";
import { loadAgents } from "./loadAgents";
import { eventBus } from "./eventBus";
import { getRun, updateRun } from "./runRegistry";
import { getStageDef, getSubTaskDef } from "./stageRegistry";
import { appendLog } from "@/lib/runStore";
import { markSubTaskAwaitingDecision, markSubTaskError, persistSubTaskFile, buildPriorContext } from "./runSubTask";
import { renderClientContext } from "./clientContext";
import { renderCopyStandard, CRITIC_BLOCKED_MARKER, CRITIC_UNRESOLVED_MARKER } from "./copyStandard";
import { parseCriticVerdict, renderRubricForCritic, type CriticRubric, type CriticVerdict } from "./criticRubric";
import type { CriticRound, StageNumber, SubTaskPhase } from "@/types";
import { agentTimeoutMs } from "./executionService";
import type { ExecutionControl } from "./executionService";

export interface CriticLoopArgs {
  runId: string;
  runDir: string;
  stageNumber: StageNumber;
  subTaskId: string;
  feedback?: string;
  control?: ExecutionControl;
  /** The craft standard the owner writes against and the critic judges against (rendered by renderCopyStandard). */
  standard: string;
  rubric: CriticRubric;
  /** Stage-specific context: the facts pool, the harvest tables, the approved copy. Already rendered as markdown. */
  extraContext: string;
  maxRounds: number;
  /** Extra critic context computed from the current draft each round (stage 3: which imageMap files do not exist). Appended after the rubric. */
  criticContextFor?: (draft: string) => Promise<string>;
}

const TEXT_ONLY = { permissionMode: "default" as const, tools: [] as string[], strictMcpConfig: true, settingSources: [] as never[], disableSlashCommands: true };

// currentPhase is a required positional argument, never a default parameter:
// a default triggers on an explicitly-passed `undefined` too, which would
// make it impossible for the final post-completion call below to actually
// clear the phase. Every in-progress call passes "critic-round"; only the
// call after the loop finishes passes undefined.
function setRound(
  runId: string,
  stageNumber: StageNumber,
  subTaskId: string,
  patch: { criticRound?: number; criticRounds?: CriticRound[]; output?: string },
  currentPhase: SubTaskPhase | undefined,
): void {
  const run = getRun(runId);
  if (!run?.stages) return;
  updateRun(runId, { stages: run.stages.map((s) => s.number === stageNumber
    ? { ...s, subTasks: s.subTasks.map((st) => st.id === subTaskId ? { ...st, ...patch, currentPhase } : st) }
    : s) });
}

/**
 * The opening a critic must use when it knowingly reverses one of its own
 * earlier instructions. N is the round, k the 1-based position of the item in
 * that round's list, exactly as priorRoundsForCritic numbers them. A prose
 * reversal is unenforceable: the writer is then told in the same prompt both to
 * undo an instruction and to keep it in effect.
 */
const REVERSAL_PREFIX = "מבטל את הנחיית סבב N פריט k: ";
const REVERSAL_RE = /^\s*מבטל את הנחיית סבב\s+(\d+)\s+פריט\s+(\d+)\s*:/;

/** One earlier instruction a reversal points at: round N, item k (1-based). */
export interface CriticReversal {
  round: number;
  index: number;
}

/**
 * The reversals declared in one round's fix list. Only the exact prefix counts:
 * anything else is an ordinary fix, and a reversal written without it is a
 * critic defect that the prompt rule names as such. Numbers below 1 are
 * meaningless as a round or an item, so they are read as malformed and dropped;
 * an index that no round actually has simply matches nothing later.
 */
export function parseReversals(
  fixes: readonly { fix: string }[] | undefined,
): CriticReversal[] {
  return (fixes ?? []).flatMap((f) => {
    const match = REVERSAL_RE.exec(f.fix ?? "");
    if (!match) return [];
    const round = Number(match[1]);
    const index = Number(match[2]);
    if (!Number.isInteger(round) || !Number.isInteger(index) || round < 1 || index < 1) return [];
    return [{ round, index }];
  });
}

/** A reversal as it was declared: what it points at, and where it stands. */
export interface DeclaredReversal extends CriticReversal {
  byRound: number;
  byIndex: number;
  /** The fix text that declared it, so a defect can be quoted back to the critic. */
  fix: string;
}

/** A reversal whose reference resolves to nothing, with the reason it does not. */
export interface InvalidReversal {
  reversal: DeclaredReversal;
  reason: string;
}

const key = (round: number, index: number): string => `${round}:${index}`;

/** Every reversal any round declared, in the order the rounds were judged. */
function declaredReversals(rounds: readonly CriticRound[]): DeclaredReversal[] {
  return rounds.flatMap((r) => (r.fixes ?? []).flatMap((f, i) =>
    parseReversals([f]).map((rev) => ({ ...rev, byRound: r.round, byIndex: i + 1, fix: f.fix }))));
}

/**
 * A reversal is only enforceable when it points at an instruction that really
 * exists and really came first: an item of a round that was judged earlier. A
 * reference to a missing round, to an item that round never had, or to the
 * declaring round itself cancels nothing, so forwarding it to the writer leaves
 * the old instruction and its cancellation binding at the same time. It is a
 * defect of the critic, and the loop sends it back to the critic instead.
 */
export function validateReversals(
  rounds: readonly CriticRound[],
): { valid: DeclaredReversal[]; invalid: InvalidReversal[] } {
  const valid: DeclaredReversal[] = [];
  const invalid: InvalidReversal[] = [];
  for (const rev of declaredReversals(rounds)) {
    const target = rounds.find((r) => r.round === rev.round)?.fixes?.[rev.index - 1];
    if (!target) {
      invalid.push({ reversal: rev, reason: `אין פריט ${rev.index} בסבב ${rev.round} ברשימות שלמעלה` });
    } else if (rev.round >= rev.byRound) {
      invalid.push({ reversal: rev, reason: `סבב ${rev.round} אינו קודם לסבב ${rev.byRound}, ולכן הפריט אינו הנחיה קודמת` });
    } else {
      valid.push(rev);
    }
  }
  return { valid, invalid };
}

/**
 * The defects, written back to the critic in the same round. The critic re-issues
 * the whole verdict, so the writer never sees an unenforceable reversal at all.
 */
function invalidReversalsBlock(defects: readonly InvalidReversal[]): string {
  const items = defects.map(({ reversal, reason }) =>
    `- פריט ${reversal.byIndex} ברשימה שהחזרת: "${reversal.fix}". ${reason}.`).join("\n");
  return `## הפניות ביטול לא תקינות מהסבב הקודם (תקן)\n\n${items}\n\nהפריטים האלה אינם מבטלים כלום, ולכן לא הועברו לכותב. החזר עכשיו את פסק הדין המלא מחדש באותו פורמט: אם ההנחיה באמת צריכה להתהפך, כתוב את הפריט עם מספר סבב ומספר פריט שקיימים ברשימות שלמעלה וקודמים לסבב הנוכחי; אם לא, השמט את הפריט.`;
}

/**
 * Every reversal declared so far, minus the ones that were themselves reversed.
 * Reading only the newest round loses a reversal the moment another round
 * follows it, and the instruction it cancelled silently returns to force.
 *
 * Reversals form a chain: one can cancel another, which can cancel a third, so
 * whether a reversal stands is not decided by a single pass. A pass that only
 * removes is wrong in both directions: in the chain "X cancels round 1, Y
 * cancels X, Z cancels Y" it drops X together with Y and never puts X back,
 * even though Z voided Y and left X the last word on round 1.
 *
 * This is the grounded labelling of that chain. A reversal no surviving
 * reversal attacks is IN; whatever an IN reversal attacks is OUT; repeat until
 * nothing changes. Anything still undecided stays OUT, so a critic that
 * contradicts itself in a loop cancels nothing rather than deciding
 * arbitrarily. A cycle needs a reversal that points forward, which validation
 * refuses at the source, so the labelling only has to settle chains here.
 */
function standingReversals(rounds: readonly CriticRound[]): DeclaredReversal[] {
  // Only a reversal that resolves is in the argument at all: one that points at
  // nothing cancels nothing, and must not cancel a reversal either.
  const declared = validateReversals(rounds).valid;
  const declaredKey = (rev: DeclaredReversal): string => key(rev.byRound, rev.byIndex);
  // Who cancels this reversal: a reversal pointing at the item that declared it.
  const attackersOf = (rev: DeclaredReversal): DeclaredReversal[] =>
    declared.filter((other) => key(other.round, other.index) === declaredKey(rev));

  const label = new Map<string, "in" | "out">();
  for (;;) {
    let changed = false;
    for (const rev of declared) {
      if (label.has(declaredKey(rev))) continue;
      // Undecided attackers still count against it: only an attacker already
      // known to be void can be ignored.
      if (attackersOf(rev).every((a) => label.get(declaredKey(a)) === "out")) {
        label.set(declaredKey(rev), "in");
        changed = true;
      }
    }
    for (const rev of declared) {
      if (label.has(declaredKey(rev))) continue;
      if (attackersOf(rev).some((a) => label.get(declaredKey(a)) === "in")) {
        label.set(declaredKey(rev), "out");
        changed = true;
      }
    }
    if (!changed) break;
  }
  return declared.filter((rev) => label.get(declaredKey(rev)) === "in");
}

/**
 * What this critic already ruled on this draft, round by round. Every spawn is
 * a fresh process with no memory, so without this block round 2 judges a
 * version that was written to satisfy round 1 while knowing nothing about
 * round 1, and the loop contradicts itself: the writer fixes what was demanded
 * and is then told to undo it. Empty on round 1, where nothing came before.
 */
function priorRoundsForCritic(rounds: readonly CriticRound[]): string {
  if (!rounds.length) return "";
  const body = rounds.map((r) => {
    const scores = Object.entries(r.scores ?? {}).map(([d, s]) => `${d}: ${s}`).join(", ") || "(בלי ציונים)";
    const fixes = (r.fixes ?? []).map((f, i) => `${i + 1}. ציטוט: "${f.quote}"\n   כלל: ${f.rule}\n   תיקון: ${f.fix}`).join("\n") || "(בלי פריטים)";
    return `### סבב ${r.round}\nפסק דין: ${r.verdict}\nציונים: ${scores}\nהפריטים שדרשת:\n${fixes}`;
  }).join("\n\n");
  return `\n\n## סבבים קודמים\n\n${body}\n\nהגרסה שלפניך נכתבה כדי לקיים את הפריטים האלה. אסור לך לסתור תיקון שדרשת בסבב קודם. אם הנחיה קודמת בכל זאת צריכה להתהפך, כתוב את זה בתוך שדה ה-fix של הפריט ופתח אותו בדיוק בקידומת "${REVERSAL_PREFIX}", כשבמקום N מספר הסבב ובמקום k מספר הפריט ברשימה הממוספרת של אותו סבב למעלה, ואחריה ההסבר למה ההנחיה הקודמת מתהפכת. רק הקידומת הזאת בדיוק מבטלת הנחיה קודמת; פריט שמהפך הנחיה קודמת בלי הקידומת הזאת, או עם מספרים שאינם מצביעים על פריט קיים, הוא פגם שלך כמבקר, לא של הכותב.`;
}

/**
 * The fixes demanded in the rounds BEFORE the one being repaired now, handed to
 * the writer alongside the new list: a repair that quietly undoes an earlier fix
 * sends the next round straight back to the item that was already closed. The
 * newest round's fixes are deliberately excluded, because they are printed just
 * above as the items to apply; listing them here as "already in effect" would
 * tell the writer they are done. Empty on the first repair.
 *
 * A reversed fix is not in effect any more, so it leaves the list entirely and
 * is stated under a heading of its own: inside the "still in effect" list, under
 * a trailer that says everything listed stays as it is, a cancelled instruction
 * reads as binding. The trailer therefore covers the in-force list alone.
 *
 * A standing reversal is likewise not an instruction to keep applying: it is a
 * ruling about another item. It is therefore stated next to what it cancelled,
 * with its reasoning, instead of standing in the in-force list beside the very
 * instruction it voided.
 */
function priorFixesForOwner(
  rounds: readonly CriticRound[],
  reversals: readonly DeclaredReversal[] = [],
): string {
  const byTarget = new Map(reversals.map((rev) => [key(rev.round, rev.index), rev]));
  const byDeclaration = new Map(reversals.map((rev) => [key(rev.byRound, rev.byIndex), rev]));
  const all = rounds.flatMap((r) => (r.fixes ?? []).map((f, i) => ({ round: r.round, index: i + 1, ...f })));
  const known = new Map(all.map((f) => [key(f.round, f.index), f]));
  // Every reversal handed in here resolves: the loop refuses to record a round
  // whose reversal points at nothing. So a fix that declared one is a ruling
  // about another item, never an instruction of its own.
  const isRuling = (round: number, index: number): boolean => byDeclaration.has(key(round, index));
  const prior = all.filter((f) => !byTarget.has(key(f.round, f.index)) && !isRuling(f.round, f.index));
  const cancelled = all.filter((f) => byTarget.has(key(f.round, f.index)));
  if (!prior.length && !cancelled.length) return "";
  const inEffect = prior.length
    ? prior.map((f) => `- סבב ${f.round}: "${f.quote}" (${f.rule}). ${f.fix}`).join("\n")
    : "(אין)";
  // The cancelled instruction is named by its quote, never repeated as text, so
  // nothing in this block reads as something to apply. What follows it is the
  // reasoning of the reversal, when that reversal is on record here.
  const cancelledBlock = cancelled.length
    ? `\n\n### הנחיות שבוטלו (אינן בתוקף)\n\n${cancelled.map((f) => {
      const rev = byTarget.get(key(f.round, f.index))!;
      const reason = known.get(key(rev.byRound, rev.byIndex))?.fix;
      return `- הנחיה מסבב ${f.round} פריט ${f.index} שבוטלה בסבב ${rev.byRound}: "${f.quote}" (${f.rule})${reason ? `. נימוק הביטול: ${reason}` : ""}`;
    }).join("\n")}\n\nההנחיות שברשימה הזאת בוטלו על ידי המבקר ואינן בתוקף. אל תחיל אותן.`
    : "";
  return `\n\n## תיקונים מסבבים קודמים (נשארים בתוקף)\n\n${inEffect}\n\nכל מה שכבר תוקן לפי הרשימה הזאת נשאר כפי שהוא. אל תבטל תיקון קודם בזמן שאתה מחיל את הפריטים החדשים.${cancelledBlock}`;
}

function scoresTable(v: Extract<CriticVerdict, { kind: "approve" | "revise" | "block" }>): string {
  return [`| ממד | ציון |`, `|---|---|`, ...Object.entries(v.scores).map(([d, s]) => `| ${d} | ${s} |`), `| **ממוצע** | ${v.avg} |`, `| **מינימום** | ${v.min} |`].join("\n");
}

export async function runCriticLoop(a: CriticLoopArgs): Promise<void> {
  const { runId, runDir, stageNumber, subTaskId, feedback, control, standard, rubric, extraContext, maxRounds } = a;
  control?.throwIfAborted();
  const run = getRun(runId);
  if (!run?.stages) throw new Error(`Run ${runId} has no stages initialized`);
  const stageDef = getStageDef(stageNumber, run.assetType, run.pipeline);
  const subTaskDef = getSubTaskDef(stageNumber, subTaskId, run.assetType, run.pipeline);
  if (!subTaskDef.critic) throw new Error(`Sub-task ${subTaskId} has no critic`);
  const agents = await loadAgents();
  const owner = agents.find((x) => x.slug === stageDef.ownerSlug);
  const critic = agents.find((x) => x.slug === subTaskDef.critic!.slug);
  if (!owner || !critic) throw new Error(`Owner ${stageDef.ownerSlug} or critic ${subTaskDef.critic.slug} not found`);
  const logName = `stage-${stageNumber}-${subTaskId}-critic-loop.log`;
  const emitToken = (token: string) => {
    control?.throwIfAborted();
    eventBus.emit(runId, { type: "subtask-token", runId, stageNumber, subTaskId, token });
    appendLog(runDir, logName, token).catch(() => {});
  };
  const previousOutput = feedback
    ? await fs.readFile(path.join(runDir, `stage-${stageNumber}`, `${subTaskId}.md`), "utf8").catch(() => "")
    : "";
  const feedbackBlock = feedback
    ? `\n\n## ⚠️ משוב מבעל הסמכות האנושי על הריצה הקודמת\n\n> ${feedback}\n\nהחל את המשוב בלבד ושמור כל דבר אחר בדיוק כפי שהוא.${previousOutput ? `\n\n## הגרסה הקודמת\n\n${previousOutput}` : ""}`
    : "";
  const sharedHead = `${renderClientContext(run.clientProfile)}\n\n## ה-Brief\n\n${run.brief}\n\n## תוצרים שאושרו עד עכשיו\n\n${buildPriorContext(run, stageNumber, subTaskId)}\n\n${extraContext}`;

  const rounds: CriticRound[] = [];
  let text = "";
  try {
    for (let round = 1; round <= maxRounds; round++) {
      control?.throwIfAborted();
      setRound(runId, stageNumber, subTaskId, { criticRound: round, criticRounds: rounds, output: "" }, "critic-round");
      eventBus.emit(runId, { type: "critic-round-started", runId, stageNumber, subTaskId, criticRoundNumber: round });

      // Owner: draft on round 1, repair on later rounds.
      const last = rounds[rounds.length - 1];
      // Every spawn is a fresh process with no memory: the repair round carries
      // the same binding context as the draft (client, brief, prior work, facts
      // pool, template, standard) plus the current version and the fix list.
      const bindingContext = `${sharedHead}\n\n## הוראות המשימה המקוריות\n\n${subTaskDef.instructions}${renderCopyStandard(standard, "ספר הכללים שאתה כותב לפיו")}`;
      const ownerPrompt = round === 1
        ? `${owner.systemPrompt}\n\n---\n\n${bindingContext}${feedbackBlock}\n\n## המשימה שלך\n\nכתוב את הגרסה הראשונה כאילו זו הסופית. בלי הקדמות.`
        : `${owner.systemPrompt}\n\n---\n\n${bindingContext}${feedbackBlock}\n\n## הגרסה הנוכחית שלך (סבב ${round - 1})\n\n${text}\n\n## פריטים לתיקון מהמבקר\n\n${(last?.fixes ?? []).map((f, i) => `${i + 1}. ציטוט: "${f.quote}"\n   כלל: ${f.rule}\n   תיקון: ${f.fix}`).join("\n")}${priorFixesForOwner(rounds.slice(0, -1), standingReversals(rounds))}\n\n## המשימה\n\nתקן בדיוק את הפריטים שברשימה ואל תשנה שום דבר אחר, אף מילה. כל הכללים וההקשר למעלה ממשיכים לחול. תכתוב רק את הגרסה המתוקנת המלאה. בלי הקדמות.`;
      await appendLog(runDir, logName, `\n\n# Round ${round} owner prompt\n\n${ownerPrompt}\n\n# Output\n\n`);
      const owned = await spawnAgent({ ...TEXT_ONLY, prompt: ownerPrompt, signal: control?.signal, timeoutMs: agentTimeoutMs(control), onToken: emitToken });
      control?.throwIfAborted();
      if (owned.fullText.trim()) text = owned.fullText;

      // Critic, with one re-ask on an unreadable verdict and one on a reversal
      // that points at no earlier item.
      const askCritic = async (prelude: string, label: string): Promise<CriticVerdict> => {
        const criticPrompt = `${prelude}${critic.systemPrompt}\n\n---\n\n# המשימה שלך: ביקורת עם ציון. אתה לא כותב, אתה פוסל ומנמק\n\n${sharedHead}\n\n## הגרסה לבדיקה\n\n${text}\n\n## הוראות המשימה שהכותב קיבל\n\n${subTaskDef.instructions}\n${renderCopyStandard(standard, "ספר הכללים שאתה בודק לפיו")}\n\n${renderRubricForCritic(rubric)}${priorRoundsForCritic(rounds)}${a.criticContextFor ? `\n\n${await a.criticContextFor(text)}` : ""}${feedback ? `\n\n## ממד נוסף בריצת משוב\n\nהמשוב היה: "${feedback}". השווה מול הגרסה הקודמת (למעלה). השינוי היחיד המותר הוא רק מה שהמשוב ביקש; כל שינוי אחר הוא פריט לתיקון.${previousOutput ? `\n\n## הגרסה הקודמת\n\n${previousOutput}` : ""}` : ""}\n\n## הפורמט שאתה מחזיר\n\nאין לך כלים. אל תריץ פקודות. הערות קצרות בטקסט, ואז בלוק אחד בדיוק:\n<critic>{"scores": {${rubric.dimensions.map((d) => `"${d}": <1-10>`).join(", ")}}, "verdict": "APPROVE" | "REVISE" | "BLOCK", "reason": "<רק ב-BLOCK: איזה איסור מוחלט הופר>", "fixes": [{"quote": "<ציטוט מדויק>", "rule": "<הכלל>", "fix": "<התיקון הנדרש>"}]}</critic>\nBLOCK רק על איסור מוחלט מהרובריקה. אל תמציא פריטים כדי להיראות קפדן. בלי הקדמות.`;
        await appendLog(runDir, logName, `\n\n# Round ${round} critic prompt${label}\n\n${criticPrompt}\n\n# Output\n\n`);
        const judged = await spawnAgent({ ...TEXT_ONLY, prompt: criticPrompt, signal: control?.signal, timeoutMs: agentTimeoutMs(control), onToken: (t) => appendLog(runDir, logName, t).catch(() => {}) });
        control?.throwIfAborted();
        return parseCriticVerdict(judged.fullText, rubric);
      };
      // The reversals of this answer are validated against the rounds as they
      // would stand with it in them, so an item of the answer itself is never
      // read as an earlier instruction.
      const defectsOf = (v: CriticVerdict): InvalidReversal[] => v.kind !== "revise" ? []
        : validateReversals([...rounds, { round, verdict: "revise", fixes: v.fixes, at: "" }])
          .invalid.filter((d) => d.reversal.byRound === round);

      let verdict = await askCritic("", "");
      if (verdict.kind === "unreadable") {
        verdict = await askCritic(`לא החזרת פסק דין בתשובה הקודמת. אין לך כלים ואין מה להריץ. החזר טקסט בלבד, ובסופו בלוק <critic>...</critic> אחד עם JSON תקין.\n\n---\n\n`, " (re-ask)");
      }
      let defects = defectsOf(verdict);
      // An unenforceable reversal goes back to the critic now, before the writer
      // is handed anything: a repair round spent on an instruction that cancels
      // nothing is a round where the old and the new instruction both bind.
      const reversalReask = defects.length > 0;
      if (reversalReask) {
        verdict = await askCritic(`${invalidReversalsBlock(defects)}\n\n---\n\n`, " (reversal re-ask)");
        defects = defectsOf(verdict);
      }
      if (verdict.kind === "unreadable") {
        rounds.push({ round, verdict: "unreadable", at: new Date().toISOString(), ...(reversalReask ? { reversalReask } : {}) });
        setRound(runId, stageNumber, subTaskId, { criticRounds: rounds }, "critic-round");
        throw new Error("המבקר לא החזיר פסק דין קריא גם אחרי שאלה חוזרת");
      }
      if (defects.length) {
        // Twice is not a slip. Nothing is forwarded: the sub-task fails here
        // rather than sending the writer a fix list that contradicts itself.
        rounds.push({ round, verdict: "unreadable", reversalReask: true, at: new Date().toISOString() });
        setRound(runId, stageNumber, subTaskId, { criticRounds: rounds }, "critic-round");
        throw new Error("המבקר החזיר הפניית ביטול לא תקינה פעמיים");
      }
      const entry: CriticRound = { round, verdict: verdict.kind, scores: verdict.scores, avg: verdict.avg, min: verdict.min, fixes: verdict.fixes, reason: verdict.reason, at: new Date().toISOString(), ...(reversalReask ? { reversalReask } : {}) };
      rounds.push(entry);
      setRound(runId, stageNumber, subTaskId, { criticRounds: rounds }, "critic-round");
      eventBus.emit(runId, { type: "critic-round-completed", runId, stageNumber, subTaskId, criticRound: entry });

      if (verdict.kind === "approve") break;
      if (verdict.kind === "block") {
        text = `${CRITIC_BLOCKED_MARKER}: ${verdict.reason ?? "איסור מוחלט"}\n\n${scoresTable(verdict)}\n\n---\n\n${text}`;
        break;
      }
      if (round === maxRounds) {
        const scoreLine = Object.entries(verdict.scores).map(([d, s]) => `${d}: ${s}`).join(", ");
        text = `${CRITIC_UNRESOLVED_MARKER} ${maxRounds} סבבים\n\n${scoreLine}\n\n${scoresTable(verdict)}\n\n${verdict.fixes.map((f, i) => `${i + 1}. ${f.quote}. תיקון: ${f.fix}`).join("\n")}\n\n---\n\n${text}`;
      }
    }
    await persistSubTaskFile(runDir, stageNumber, subTaskId, text);
    control?.throwIfAborted();
    await markSubTaskAwaitingDecision(runId, stageNumber, subTaskId, text);
    // Final state: the loop is done, so no round is "in progress" any more.
    setRound(runId, stageNumber, subTaskId, { criticRound: undefined, criticRounds: rounds }, undefined);
    eventBus.emit(runId, { type: "subtask-completed", runId, stageNumber, subTaskId, content: text });
  } catch (err) {
    control?.throwIfAborted();
    const errorMessage = err instanceof Error ? err.message : String(err);
    await appendLog(runDir, logName, `\n\n## ERROR\n\n${errorMessage}\n`).catch(() => {});
    await markSubTaskError(runId, stageNumber, subTaskId, errorMessage);
    eventBus.emit(runId, { type: "subtask-error", runId, stageNumber, subTaskId, errorMessage });
    // The execution manager records a failure only from a rejection (executionService.ts:193).
    throw err;
  }
}
