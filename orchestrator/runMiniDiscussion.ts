import { loadAgents } from "./loadAgents";
import { spawnAgent } from "./spawnAgent";
import { eventBus } from "./eventBus";
import { getRun, updateRun } from "./runRegistry";
import { getStageDef, getSubTaskDef } from "./stageRegistry";
import { appendLog } from "@/lib/runStore";
import {
  markSubTaskAwaitingDecision,
  markSubTaskError,
  persistSubTaskFile,
  buildPriorContext,
} from "./runSubTask";
import type { Critique, StageNumber, SubTaskPhase } from "@/types";
import { agentTimeoutMs } from "./executionService";
import type { ExecutionControl } from "./executionService";
import { renderClientContext } from "./clientContext";
import fs from "node:fs/promises";
import path from "node:path";
import {
  readAdsCopyStandard,
  readCopyStandard,
  renderCopyStandard,
  SKILL_AUDIT_FAILED_MARKER,
  SKILL_AUDIT_SKIPPED_MARKER,
} from "./copyStandard";
import { readRunPageTypeBlueprint } from "./pageTypeBlueprint";
import { readVerdict, type Verdict } from "./designStandard";

export async function runMiniDiscussion(
  runId: string,
  runDir: string,
  stageNumber: StageNumber,
  subTaskId: string,
  feedback?: string,
  control?: ExecutionControl,
): Promise<void> {
  control?.throwIfAborted();
  const run = getRun(runId);
  if (!run?.stages) return;
  const stageDef = getStageDef(stageNumber, run.assetType, run.pipeline);
  const subTaskDef = getSubTaskDef(stageNumber, subTaskId, run.assetType, run.pipeline);
  if (!subTaskDef.critics) throw new Error("runMiniDiscussion called without critics");

  const allAgents = await loadAgents();
  const owner = allAgents.find((a) => a.slug === stageDef.ownerSlug);
  if (!owner) throw new Error(`Owner ${stageDef.ownerSlug} not found`);

  const priorContext = buildPriorContext(run, stageNumber, subTaskId);
  const clientContext = renderClientContext(run.clientProfile);
  // Read at run time so the rules cannot drift from the prompt, exactly as the
  // design critics read their standard in stage 5.
  // Stage 7 writes ads, not page sections: it judges against the ads craft
  // standard when the tenant configured one (F88, 01.09.2026).
  const copyStandard = stageNumber === 7
    ? await readAdsCopyStandard(run.clientProfile)
    : await readCopyStandard(run.clientProfile);
  // The structure of the page type is read from disk like the standard, and only
  // in stage 4: stage 7 writes ads. Read once here and reuse the rendered blocks
  // in all four prompts below, so the four calls of one sub-task run cannot see
  // different content if the file changes mid-run.
  const pageTypeBlueprint = stageNumber === 4
    ? await readRunPageTypeBlueprint(run)
    : "";
  const pageTypeBlueprintMissing = stageNumber === 4
    && !pageTypeBlueprint
    && !!run.assetType
    && run.assetType !== "sales-page";
  const blueprintForWriter = renderCopyStandard(pageTypeBlueprint, "תבנית סוג הדף, גוברת על כללי מבנה כלליים");
  const blueprintForCritic = renderCopyStandard(pageTypeBlueprint, "תבנית סוג הדף שאתה שופט לפיה");
  const blueprintForAuditor = renderCopyStandard(pageTypeBlueprint, "תבנית סוג הדף שאתה בודק ציות אליה");
  // The previous approved version is still on disk until this rerun persists.
  // Without it, a feedback rerun rewrites from scratch and regresses parts the
  // operator never asked to change (finding F82, 31.08.2026).
  const previousOutput = feedback
    ? await fs
        .readFile(path.join(runDir, `stage-${stageNumber}`, `${subTaskId}.md`), "utf8")
        .catch(() => "")
    : "";
  const feedbackBlock = feedback
    ? `\n\n## ⚠️ משוב מבעל הסמכות האנושי על הריצה הקודמת\n\n> ${feedback}\n\nשפר בהתאם.${
        previousOutput
          ? `\n\n## הגרסה הקודמת של הסקציה\n\n${previousOutput}\n\nהמשוב מתייחס לגרסה הזו. החל עליה את המשוב בלבד, ושמור כל דבר אחר, כולל הכותרות, בדיוק כפי שהוא.`
          : ""
      }`
    : "";

  // ============== PHASE 1: DRAFT ==============
  setPhase(runId, stageNumber, subTaskId, "draft");
  eventBus.emit(runId, {
    type: "subtask-phase-changed",
    runId,
    stageNumber,
    subTaskId,
    phase: "draft",
  });

  const draftLog = `stage-${stageNumber}-${subTaskId}-phase1-draft.log`;
  if (pageTypeBlueprintMissing) {
    // A sales page has no blueprint by design (excluded above), so this only
    // fires for a page type that should have one but does not. Reported the
    // same way the draft phase already streams progress into the run: a
    // subtask-token, logged to the same file the draft prompt is about to open.
    const warning = `⚠️ תבנית סוג הדף (${run.assetType}) לא נמצאה. ממשיכים על ההוראות שבקוד.\n`;
    eventBus.emit(runId, {
      type: "subtask-token",
      runId,
      stageNumber,
      subTaskId,
      token: warning,
      phase: "draft",
    });
    await appendLog(runDir, draftLog, warning);
  }

  const draftPrompt = `${owner.systemPrompt}

---

${clientContext}

---

## ה-Brief

${run.brief}

---

## מסמך אסטרטגיה

${run.strategyDoc ?? ""}

---

## תוצרים שאושרו עד עכשיו

${priorContext}

---

## המשימה שלך — טיוטה ראשונה

**${subTaskDef.title}**

${subTaskDef.instructions}${feedbackBlock}${renderCopyStandard(copyStandard, "ספר הכללים של הקופי, מנצח את הטעם שלך")}${blueprintForWriter}

זה רק טיוטה ראשונה. אחרי שתסיים, סוכנים אחרים יבקרו אותה ואז תקבל הזדמנות לשכתב. כתוב את הגרסה הראשונה כאילו זו הסופית. בלי הקדמות.`;

  await appendLog(runDir, draftLog, `# Draft Prompt\n\n${draftPrompt}\n\n# Output\n\n`);

  let draft = "";
  try {
    const { fullText } = await spawnAgent({
      prompt: draftPrompt,
      permissionMode: "default",
      tools: [],
      strictMcpConfig: true,
      settingSources: [],
      disableSlashCommands: true,
      signal: control?.signal,
      timeoutMs: agentTimeoutMs(control),
      onToken: (token) => {
        control?.throwIfAborted();
        eventBus.emit(runId, {
          type: "subtask-token",
          runId,
          stageNumber,
          subTaskId,
          token,
          phase: "draft",
        });
        appendLog(runDir, draftLog, token).catch(() => {});
      },
    });
    control?.throwIfAborted();
    draft = fullText;
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    await markSubTaskError(runId, stageNumber, subTaskId, errorMessage);
    if (!control?.signal.aborted) {
      eventBus.emit(runId, {
        type: "subtask-error",
        runId,
        stageNumber,
        subTaskId,
        errorMessage,
      });
    }
    throw err;
  }

  setDraft(runId, stageNumber, subTaskId, draft);

  // ============== PHASE 2: CRITIQUE (parallel) ==============
  setPhase(runId, stageNumber, subTaskId, "critique");
  eventBus.emit(runId, {
    type: "subtask-phase-changed",
    runId,
    stageNumber,
    subTaskId,
    phase: "critique",
  });

  const critiques: Critique[] = await Promise.all(
    subTaskDef.critics.map(async (criticSlug): Promise<Critique> => {
      control?.throwIfAborted();
      const critic = allAgents.find((a) => a.slug === criticSlug);
      if (!critic) {
        return { agentSlug: criticSlug, content: "", status: "error", errorMessage: "Agent not found" };
      }

      eventBus.emit(runId, {
        type: "critique-started",
        runId,
        stageNumber,
        subTaskId,
        criticSlug,
      });

      const critiquePrompt = `${critic.systemPrompt}

---

## הקשר: ביקורת על קופי שכתב סוכן אחר

${clientContext}

---

ה-brief המקורי:
${run.brief}

האסטרטגיה הכוללת:
${run.strategyDoc ?? ""}

תוצרים מאושרים עד עכשיו:
${priorContext}

---

## הטיוטה ש${owner.name} כתב

**${subTaskDef.title}:**

${draft}

---

## המשימה שלך — ביקורת בונה

קרא את הטיוטה לעיל. תפקידך לתת **קונטרה ספציפית מהפרספקטיבה של התפקיד שלך**:

1. **מה עובד בטיוטה** (משפט אחד)
2. **2-3 נקודות חולשה ספציפיות** — עם ציטוטים ישירים מהטיוטה ("המשפט X לא יעבוד כי...")
3. **הצעת תיקון קונקרטית** — מה לשנות${renderCopyStandard(copyStandard, "ספר הכללים שאתה שופט לפיו")}${blueprintForCritic}

100-150 מילים סה"כ. תהיה ספציפי, לא כללי. **אסור "זה טוב, אולי שווה לחדד..."** — או שיש לך ביקורת אמיתית או שאתה כותב "אני סומך על ${owner.name} בסקציה הזו, אין לי קונטרה".

תכתוב רק את הקונטרה. בלי הקדמות.`;

      const critiqueLog = `stage-${stageNumber}-${subTaskId}-phase2-critique-${criticSlug}.log`;
      await appendLog(
        runDir,
        critiqueLog,
        `# Critique Prompt\n\n${critiquePrompt}\n\n# Output\n\n`,
      );

      try {
        const { fullText } = await spawnAgent({
          prompt: critiquePrompt,
          permissionMode: "default",
          tools: [],
          strictMcpConfig: true,
          settingSources: [],
          disableSlashCommands: true,
          signal: control?.signal,
          timeoutMs: agentTimeoutMs(control),
          onToken: (token) => {
            control?.throwIfAborted();
            eventBus.emit(runId, {
              type: "critique-token",
              runId,
              stageNumber,
              subTaskId,
              criticSlug,
              token,
            });
            appendLog(runDir, critiqueLog, token).catch(() => {});
          },
        });
        control?.throwIfAborted();
        eventBus.emit(runId, {
          type: "critique-completed",
          runId,
          stageNumber,
          subTaskId,
          criticSlug,
          content: fullText,
        });
        return { agentSlug: criticSlug, content: fullText, status: "done" };
      } catch (err) {
        control?.throwIfAborted();
        const errorMessage = err instanceof Error ? err.message : String(err);
        eventBus.emit(runId, {
          type: "critique-completed",
          runId,
          stageNumber,
          subTaskId,
          criticSlug,
          content: "",
          errorMessage,
        });
        return { agentSlug: criticSlug, content: "", status: "error", errorMessage };
      }
    }),
  );

  control?.throwIfAborted();
  setCritiques(runId, stageNumber, subTaskId, critiques);

  // ============== PHASE 3: REVISE ==============
  setPhase(runId, stageNumber, subTaskId, "revise");
  eventBus.emit(runId, {
    type: "subtask-phase-changed",
    runId,
    stageNumber,
    subTaskId,
    phase: "revise",
  });

  const critiquesText = critiques
    .filter((c) => c.status === "done" && c.content)
    .map((c) => {
      const ag = allAgents.find((a) => a.slug === c.agentSlug);
      return `### קונטרה מ-${ag?.name ?? c.agentSlug}\n\n${c.content}`;
    })
    .join("\n\n");

  const revisePrompt = `${owner.systemPrompt}

---

## הקשר

${clientContext}

---

ה-brief: ${run.brief}
האסטרטגיה: ${run.strategyDoc ?? ""}

תוצרים מאושרים עד עכשיו:

${priorContext}

---

## הטיוטה הראשונה שלך

${draft}

---

## קונטרות שקיבלת מהבורד

${critiquesText || "(אין קונטרות זמינות)"}

---

## המשימה שלך — שכתוב סופי

קרא את הקונטרות ושכתב את הסקציה. **אסור להתעלם מהקונטרות.** אם אתה לא מסכים עם קונטרה — תסביר למה במשפט אחד בתחילת התוצר, אבל **גם תשפר את הסקציה בנקודה שהוא העלה**.

${subTaskDef.instructions}

תכתוב רק את הגרסה הסופית. בלי הקדמות, בלי "הנה הגרסה המתוקנת".${feedbackBlock}${renderCopyStandard(copyStandard, "ספר הכללים של הקופי, מנצח את הטעם שלך")}${blueprintForWriter}`;

  const reviseLog = `stage-${stageNumber}-${subTaskId}-phase3-revise.log`;
  await appendLog(runDir, reviseLog, `# Revise Prompt\n\n${revisePrompt}\n\n# Output\n\n`);

  try {
    const { fullText } = await spawnAgent({
      prompt: revisePrompt,
      permissionMode: "default",
      tools: [],
      strictMcpConfig: true,
      settingSources: [],
      disableSlashCommands: true,
      signal: control?.signal,
      timeoutMs: agentTimeoutMs(control),
      onToken: (token) => {
        control?.throwIfAborted();
        eventBus.emit(runId, {
          type: "subtask-token",
          runId,
          stageNumber,
          subTaskId,
          token,
          phase: "revise",
        });
        appendLog(runDir, reviseLog, token).catch(() => {});
      },
    });
    control?.throwIfAborted();

    // ============== PHASE 4: SKILL COMPLIANCE AUDIT ==============
    // The operator's explicit requirement (31.08.2026): the board must POLICE
    // skill usage, because writers drift from skill instructions. This is a
    // checklist audit, not a taste critique: standard rules, sub-task
    // instructions, and, on feedback reruns, "did you change ONLY what the
    // feedback asked". A failed audit gets one repair pass; if it still fails,
    // the report is prepended to the output and the express auto-approver
    // refuses the gate, so a human always sees an uncompliant section.
    const auditorSlug = subTaskDef.critics[0];
    const auditor = allAgents.find((a) => a.slug === auditorSlug);
    let finalText = fullText;
    if (auditor) {
      const auditLog = `stage-${stageNumber}-${subTaskId}-phase4-audit.log`;
      const buildAuditPrompt = (candidate: string): string => `${auditor.systemPrompt}

---

# המשימה שלך עכשיו: ביקורת ציות לסקיל. לא ביקורת טעם

לפניך הגרסה הסופית של "${subTaskDef.title}". תפקידך לבדוק ציות בלבד, שורה מול כלל:

1. **ספר הכללים (מטה):** כל כלל מפורש. קול הכתיבה, איסורים, מבנה שורת הפתיחה, em-dashes, המצאת עובדות, יחס טענה-הוכחה.
2. **הוראות המשימה:** טווח מילים, אלמנטים נדרשים, סימוני חסר במקום המצאות.
${previousOutput ? `3. **ציות למשוב המפעיל:** המשוב היה: "${feedback}". השווה מול הגרסה הקודמת (מטה). השינוי היחיד המותר הוא מה שהמשוב ביקש. כל שינוי אחר, כולל כותרת, מבנה או טענות, הוא הפרה, גם אם הוא נראה לך שיפור.` : ""}

## הגרסה הסופית לבדיקה

${candidate}

${previousOutput ? `## הגרסה הקודמת (הבסיס שהמשוב התייחס אליו)\n\n${previousOutput}\n` : ""}
## הוראות המשימה המקוריות

${subTaskDef.instructions}
${renderCopyStandard(copyStandard, "ספר הכללים שאתה בודק ציות אליו")}${blueprintForAuditor}

## הפורמט שאתה מחזיר

אין לך כלים. אל תנסה להריץ פקודות ואל תכתוב בלוקים של קריאות כלים. ענה בטקסט בלבד.
השורה הראשונה, בדיוק: "פסק דין: עובר" או "פסק דין: לא עובר".
אם לא עובר: רשימה ממוספרת. כל שורה: ציטוט מדויק של ההפרה + הכלל שהופר + התיקון הנדרש. אל תמציא הפרות כדי להיראות קפדן, וטעם אישי אינו הפרה. בלי הקדמות.`;

      // An auditor that names no verdict (a leaked tool call, a truncated
      // answer, seen twice on 14.09.2026) is asked once more with the format
      // demand up front. Still nothing = the audit did not run. That is not a
      // failed audit: nobody found a violation, so nothing is "repaired" and
      // the section is not stamped as uncompliant. It is stamped as unaudited,
      // which the express gate also leaves to a human.
      const askAuditor = async (auditCycle: number): Promise<{ verdict: Verdict; auditText: string }> => {
        let auditText = "";
        for (let ask = 1; ask <= 2; ask++) {
          control?.throwIfAborted();
          const auditPrompt = ask === 1
            ? buildAuditPrompt(finalText)
            : `לא החזרת פסק דין בתשובה הקודמת. אין לך כלים ואין מה להריץ. ענה בטקסט בלבד, והשורה הראשונה חייבת להיות בדיוק "פסק דין: עובר" או "פסק דין: לא עובר".

---

${buildAuditPrompt(finalText)}`;
          await appendLog(
            runDir,
            auditLog,
            `\n\n# Audit cycle ${auditCycle}${ask === 2 ? " (re-ask: no readable verdict)" : ""} Prompt\n\n${auditPrompt}\n\n# Output\n\n`,
          );
          ({ fullText: auditText } = await spawnAgent({
            prompt: auditPrompt,
            permissionMode: "default",
            tools: [],
            strictMcpConfig: true,
            settingSources: [],
            disableSlashCommands: true,
            signal: control?.signal,
            timeoutMs: agentTimeoutMs(control),
            onToken: (token) => {
              control?.throwIfAborted();
              appendLog(runDir, auditLog, token).catch(() => {});
            },
          }));
          control?.throwIfAborted();
          const verdict = readVerdict(auditText);
          if (verdict !== "unreadable") return { verdict, auditText };
        }
        return { verdict: "unreadable", auditText };
      };

      for (let auditCycle = 1; auditCycle <= 2; auditCycle++) {
        const { verdict, auditText } = await askAuditor(auditCycle);
        if (verdict === "pass") break;
        if (verdict === "unreadable") {
          await appendLog(runDir, auditLog, `\n\n# Audit cycle ${auditCycle}: no readable verdict after a re-ask, section left unaudited\n`);
          finalText = `${SKILL_AUDIT_SKIPPED_MARKER}\n\n---\n\n${finalText}`;
          break;
        }
        if (auditCycle === 2) {
          finalText = `${SKILL_AUDIT_FAILED_MARKER}\n\n${auditText}\n\n---\n\n${finalText}`;
          break;
        }
        const repairPrompt = `${owner.systemPrompt}

---

הגרסה שכתבת נכשלה בביקורת ציות לסקיל. אלו ההפרות:

${auditText}

## הגרסה שלך

${finalText}

## המשימה

תקן **בדיוק** את ההפרות שברשימה ואל תשנה שום דבר אחר, אף מילה. תכתוב רק את הגרסה המתוקנת המלאה. בלי הקדמות.`;
        await appendLog(runDir, auditLog, `\n\n# Repair Prompt\n\n${repairPrompt}\n\n# Repair Output\n\n`);
        const { fullText: repaired } = await spawnAgent({
          prompt: repairPrompt,
          permissionMode: "default",
          tools: [],
          strictMcpConfig: true,
          settingSources: [],
          disableSlashCommands: true,
          signal: control?.signal,
          timeoutMs: agentTimeoutMs(control),
          onToken: (token) => {
            control?.throwIfAborted();
            appendLog(runDir, auditLog, token).catch(() => {});
          },
        });
        control?.throwIfAborted();
        if (repaired.trim()) finalText = repaired;
      }
    }

    await persistSubTaskFile(runDir, stageNumber, subTaskId, finalText);
    control?.throwIfAborted();
    await markSubTaskAwaitingDecision(runId, stageNumber, subTaskId, finalText);
    eventBus.emit(runId, {
      type: "subtask-completed",
      runId,
      stageNumber,
      subTaskId,
      content: finalText,
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    await markSubTaskError(runId, stageNumber, subTaskId, errorMessage);
    if (!control?.signal.aborted) {
      eventBus.emit(runId, {
        type: "subtask-error",
        runId,
        stageNumber,
        subTaskId,
        errorMessage,
      });
    }
    throw err;
  }
}

function setPhase(
  runId: string,
  stageNumber: StageNumber,
  subTaskId: string,
  phase: SubTaskPhase,
): void {
  const run = getRun(runId);
  if (!run?.stages) return;
  const stages = run.stages.map((s) =>
    s.number === stageNumber
      ? {
          ...s,
          subTasks: s.subTasks.map((st) =>
            st.id === subTaskId
              ? { ...st, currentPhase: phase, output: phase === "revise" ? "" : st.output }
              : st,
          ),
        }
      : s,
  );
  updateRun(runId, { stages });
}

function setDraft(
  runId: string,
  stageNumber: StageNumber,
  subTaskId: string,
  draft: string,
): void {
  const run = getRun(runId);
  if (!run?.stages) return;
  const stages = run.stages.map((s) =>
    s.number === stageNumber
      ? {
          ...s,
          subTasks: s.subTasks.map((st) =>
            st.id === subTaskId ? { ...st, draftOutput: draft } : st,
          ),
        }
      : s,
  );
  updateRun(runId, { stages });
}

function setCritiques(
  runId: string,
  stageNumber: StageNumber,
  subTaskId: string,
  critiques: Critique[],
): void {
  const run = getRun(runId);
  if (!run?.stages) return;
  const stages = run.stages.map((s) =>
    s.number === stageNumber
      ? {
          ...s,
          subTasks: s.subTasks.map((st) =>
            st.id === subTaskId ? { ...st, critiques } : st,
          ),
        }
      : s,
  );
  updateRun(runId, { stages });
}
