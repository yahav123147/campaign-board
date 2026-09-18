import { NextRequest, NextResponse } from "next/server";
import {
  getRun,
  withRunLock,
} from "@/orchestrator/runRegistry";
import { startStageExecution } from "@/orchestrator/runStage";
import { createRunDir } from "@/lib/runStore";
import type { StageNumber } from "@/types";
import { httpBodyError, readJsonBody } from "@/lib/httpBody";
import { MAX_FEEDBACK_CHARS, trimmedString } from "@/lib/inputLimits";
import { stageOrderViolation } from "@/orchestrator/executionOrder";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; n: string }> }
) {
  const { id, n: nStr } = await params;
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
    return NextResponse.json({ error: "feedback must be at least 5 characters" }, { status: 400 });
  }
  if (feedback.length > MAX_FEEDBACK_CHARS) {
    return NextResponse.json({ error: `feedback must be at most ${MAX_FEEDBACK_CHARS} characters` }, { status: 400 });
  }

  const eligibility = await withRunLock(id, async () => {
    const run = getRun(id);
    if (!run?.stages) return { error: "Run or stages not found", status: 404 } as const;
    const stage = run.stages.find((candidate) => candidate.number === n);
    if (!stage) return { error: "Stage not found", status: 404 } as const;
    const orderIssue = stageOrderViolation(run, n);
    if (orderIssue) return { error: orderIssue, status: 409 } as const;
    if (stage.status !== "awaiting-decision") {
      return { error: `Stage is in status '${stage.status}'`, status: 409 } as const;
    }
    return { ok: true } as const;
  });
  if (!("ok" in eligibility)) {
    return NextResponse.json({ error: eligibility.error }, { status: eligibility.status });
  }

  const runDir = await createRunDir(id);
  const started = await startStageExecution(id, runDir, n, feedback);
  if (!started.ok) {
    return NextResponse.json(
      { error: started.error, attemptId: started.activeAttemptId },
      { status: 409 },
    );
  }

  return NextResponse.json({ ok: true, attemptId: started.attemptId }, { status: 202 });
}
