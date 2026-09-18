import { NextRequest, NextResponse } from "next/server";
import { getRun, updateRun, flushPersistence, withRunLock } from "@/orchestrator/runRegistry";
import { startSubTaskExecution } from "@/orchestrator/runSubTask";
import { createRunDir } from "@/lib/runStore";
import type { StageNumber } from "@/types";
import { httpBodyError, readJsonBody } from "@/lib/httpBody";
import { subTaskOrderViolation, activeExecutionViolation } from "@/orchestrator/executionOrder";
import { isCreativeMode, RUNNER_FEEDBACK_SENTINELS } from "@/lib/creativeMode";
import {
  listPresenterPhotos,
  resolvePresenterDir,
} from "@/orchestrator/runStage7Creatives";
import { loadClientProfile } from "@/config/clientProfile";

/**
 * Records the client's Stage 7.5 production-mode choice and relaunches the
 * sub-task. This is deliberately NOT the decide endpoint: decide on 7.5 seals
 * an approved contact sheet, and at choice time no assets exist yet.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; n: string; subId: string }> },
) {
  const { id, n: nStr, subId } = await params;
  const n = Number(nStr) as StageNumber;
  if (n !== 7 || subId !== "7.5") {
    return NextResponse.json({ error: "Creative mode applies only to stage 7.5" }, { status: 400 });
  }

  let body: { mode?: string };
  try {
    body = await readJsonBody(req);
  } catch (error) {
    const issue = httpBodyError(error);
    return NextResponse.json({ error: issue.error }, { status: issue.status });
  }
  const mode = body.mode;
  if (!isCreativeMode(mode)) {
    return NextResponse.json({ error: "mode must be 'typography' or 'ai-variation'" }, { status: 400 });
  }

  const decision = await withRunLock(id, async () => {
    const run = getRun(id);
    if (!run?.stages) return { error: "Run not found", status: 404 } as const;
    const stage = run.stages.find((s) => s.number === n);
    const subTask = stage?.subTasks.find((st) => st.id === subId);
    if (!stage || !subTask) return { error: "SubTask not found", status: 404 } as const;
    const orderIssue = subTaskOrderViolation(run, n, subId);
    if (orderIssue) return { error: orderIssue, status: 409 } as const;
    // מותר לבחור מצב בכל עצירה של 7.5: מסך הבחירה, שער עם תוצרים (החלפת מצב
    // מריצה הפקה חדשה ומחליפה את הסט), ומצב error, שבו בחירה מחדש היא נתיב
    // ההחלמה של הלקוח (למשל אחרי סירוב מודל לערוך תמונת אדם אמיתי).
    if (subTask.status !== "awaiting-decision" && subTask.status !== "error") {
      return {
        error: `בחירת מצב אפשרית רק כששלב 7.5 עצור, והוא כרגע '${subTask.status}'`,
        status: 409,
      } as const;
    }
    // ריצת משוב שנכשלה: המשוב האנושי האחרון עוד לא יושם, ורילונץ' בלעדיו היה
    // זורק אותו בשקט ומגיש ללקוח סט שמתעלם ממה שהוא ביקש.
    const carriedFeedback = subTask.status === "error"
      ? [...subTask.feedbackHistory].reverse().find((f) => !RUNNER_FEEDBACK_SENTINELS.includes(f))
      : undefined;
    const activeIssue = activeExecutionViolation(run);
    if (activeIssue) return { error: activeIssue, status: 409 } as const;

    // בדיקת הספרייה רצה אחרי הבדיקות הזולות ובאותו נתיב הכרעה כמו הראנר
    // (resolvePresenterDir על הפרופיל החי, עם נפילה לצילום הריצה), כדי שהשער
    // והייצור יסתכלו על אותה תיקייה. כשל בקריאת הפרופיל לא חוסם כאן: הראנר
    // יעלה את השגיאה האמיתית בצורה גלויה.
    if (mode === "ai-variation") {
      const liveProfile = await loadClientProfile().catch(() => undefined);
      const snapshotTenant = run.clientProfile?.tenant?.id;
      if (liveProfile && snapshotTenant && liveProfile.tenant?.id !== snapshotTenant) {
        return {
          error: `הפרופיל הפעיל שייך ללקוח '${liveProfile.tenant?.id ?? "?"}' אבל הריצה של '${snapshotTenant}'. טענו את הפרופיל הנכון.`,
          status: 409,
        } as const;
      }
      const dir = resolvePresenterDir(liveProfile ?? run.clientProfile ?? undefined);
      const photos = await listPresenterPhotos(dir);
      if (photos.length === 0) {
        return {
          error: "וריאציית AI דורשת תמונת פרזנטור. העלו תמונה קודם ואז בחרו שוב.",
          status: 409,
        } as const;
      }
    }

    updateRun(id, {
      stages: run.stages.map((s) =>
        s.number === n
          ? {
              ...s,
              subTasks: s.subTasks.map((st) =>
                st.id === subId ? { ...st, creativeMode: mode } : st,
              ),
            }
          : s,
      ),
    });
    await flushPersistence();
    return { ok: true, carriedFeedback } as const;
  });
  if (!("ok" in decision)) {
    return NextResponse.json({ error: decision.error }, { status: decision.status });
  }

  const runDir = await createRunDir(id);
  const started = await startSubTaskExecution(id, runDir, n, subId, decision.carriedFeedback);
  if (!started.ok) {
    return NextResponse.json(
      { error: started.error, attemptId: started.activeAttemptId },
      { status: 409 },
    );
  }
  return NextResponse.json({ ok: true, mode, attemptId: started.attemptId }, { status: 202 });
}
