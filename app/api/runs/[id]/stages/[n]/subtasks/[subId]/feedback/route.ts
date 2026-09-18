import { NextRequest, NextResponse } from "next/server";
import { getRun, withRunLock } from "@/orchestrator/runRegistry";
import { startSubTaskExecution } from "@/orchestrator/runSubTask";
import { createRunDir } from "@/lib/runStore";
import type { StageNumber } from "@/types";
import { httpBodyError, readJsonBody } from "@/lib/httpBody";
import { MAX_FEEDBACK_CHARS, trimmedString } from "@/lib/inputLimits";
import { subTaskOrderViolation } from "@/orchestrator/executionOrder";
import type { ExecutionClaimIntent } from "@/orchestrator/executionManager";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; n: string; subId: string }> },
) {
  const { id, n: nStr, subId } = await params;
  const n = Number(nStr) as StageNumber;
  if (![1, 2, 3, 4, 5, 6, 7, 8, 9].includes(n)) {
    return NextResponse.json({ error: "Invalid stage number" }, { status: 400 });
  }

  let body: { feedback?: string };
  try {
    body = await readJsonBody(req);
  } catch (error) {
    const issue = httpBodyError(error);
    return NextResponse.json({ error: issue.error }, { status: issue.status });
  }
  const feedback = trimmedString(body.feedback);
  if (!feedback || feedback.length < 5) {
    return NextResponse.json({ error: "feedback >= 5 chars required" }, { status: 400 });
  }
  if (feedback.length > MAX_FEEDBACK_CHARS) {
    return NextResponse.json({ error: `feedback must be at most ${MAX_FEEDBACK_CHARS} characters` }, { status: 400 });
  }

  type Eligibility =
    | {
        ok: true;
        executionSubTaskId: string;
        claimIntent: ExecutionClaimIntent | undefined;
      }
    | { ok: false; error: string; status: number };

  const eligibility = await withRunLock<Eligibility>(id, async () => {
    const run = getRun(id);
    if (!run?.stages) return { ok: false, error: "Run not found", status: 404 };
    const stage = run.stages.find((s) => s.number === n);
    if (!stage) return { ok: false, error: "Stage not found", status: 404 };
    const subTask = stage.subTasks.find((st) => st.id === subId);
    if (!subTask) return { ok: false, error: "SubTask not found", status: 404 };
    const orderIssue = subTaskOrderViolation(run, n, subId);
    if (orderIssue) return { ok: false, error: orderIssue, status: 409 };
    if (!["pending", "awaiting-decision", "error"].includes(subTask.status)) {
      return {
        ok: false,
        error: `SubTask is '${subTask.status}'`,
        status: 409,
      };
    }
    const rewindsPreview = n === 5 && subId === "5.4";
    const claimIntent: ExecutionClaimIntent | undefined = rewindsPreview
      ? {
          kind: "rewind-subtasks-for-feedback",
          stageNumber: 5,
          fromSubTaskId: "5.3",
          triggerSubTaskId: "5.4",
          feedback,
        }
      : undefined;
    return {
      ok: true,
      executionSubTaskId: rewindsPreview ? "5.3" : subId,
      claimIntent,
    };
  });
  if (!eligibility.ok) {
    return NextResponse.json({ error: eligibility.error }, { status: eligibility.status });
  }

  const runDir = await createRunDir(id);
  const started = await startSubTaskExecution(
    id,
    runDir,
    n,
    eligibility.executionSubTaskId,
    feedback,
    eligibility.claimIntent,
  );
  if (!started.ok) {
    return NextResponse.json(
      { error: started.error, attemptId: started.activeAttemptId },
      { status: 409 },
    );
  }

  return NextResponse.json(
    {
      ok: true,
      attemptId: started.attemptId,
      startedSubTaskId: eligibility.executionSubTaskId,
    },
    { status: 202 },
  );
}
