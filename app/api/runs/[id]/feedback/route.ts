import { NextRequest, NextResponse } from "next/server";
import {
  getRun,
  withRunLock,
} from "@/orchestrator/runRegistry";
import { startFeedbackExecution } from "@/orchestrator/runFeedbackCycle";
import { createRunDir } from "@/lib/runStore";
import { httpBodyError, readJsonBody } from "@/lib/httpBody";
import { MAX_FEEDBACK_CHARS, trimmedString } from "@/lib/inputLimits";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  let body: { feedback?: string };
  try {
    body = await readJsonBody(req);
  } catch (error) {
    const issue = httpBodyError(error);
    return NextResponse.json({ error: issue.error }, { status: issue.status });
  }

  const feedback = trimmedString(body.feedback);
  if (!feedback || feedback.length < 5) return NextResponse.json({ error: "feedback must be at least 5 characters" }, { status: 400 });
  if (feedback.length > MAX_FEEDBACK_CHARS) {
    return NextResponse.json({ error: `feedback must be at most ${MAX_FEEDBACK_CHARS} characters` }, { status: 400 });
  }

  const eligibility = await withRunLock(id, async () => {
    const run = getRun(id);
    if (!run) return { error: "Run not found", status: 404 } as const;
    if (run.status !== "awaiting-decision") {
      return { error: `Run is in status '${run.status}'`, status: 409 } as const;
    }
    return { ok: true } as const;
  });
  if (!("ok" in eligibility)) {
    return NextResponse.json({ error: eligibility.error }, { status: eligibility.status });
  }

  const runDir = await createRunDir(id);

  const started = await startFeedbackExecution(id, runDir, feedback);
  if (!started.ok) {
    return NextResponse.json(
      { error: started.error, attemptId: started.activeAttemptId },
      { status: 409 },
    );
  }

  return NextResponse.json({ ok: true, attemptId: started.attemptId }, { status: 202 });
}
