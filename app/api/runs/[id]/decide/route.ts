import { NextRequest, NextResponse } from "next/server";
import {
  getRun,
  flushPersistence,
  updateRun,
  withRunLock,
} from "@/orchestrator/runRegistry";
import { eventBus } from "@/orchestrator/eventBus";
import { initializeStages } from "@/orchestrator/initializeStages";
import { startStageExecution } from "@/orchestrator/runStage";
import { createRunDir, saveStrategy } from "@/lib/runStore";
import type { Stage } from "@/types";
import { httpBodyError, readJsonBody } from "@/lib/httpBody";
import { MAX_EDITED_OUTPUT_CHARS } from "@/lib/inputLimits";
import { activeExecutionViolation } from "@/orchestrator/executionOrder";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  let body: { action?: string; editedStrategy?: string };
  try {
    body = await readJsonBody(req);
  } catch (error) {
    const issue = httpBodyError(error);
    return NextResponse.json({ error: issue.error }, { status: issue.status });
  }

  if (body.action !== "approve") {
    return NextResponse.json({ error: "Only 'approve' supported here" }, { status: 400 });
  }
  if (
    typeof body.editedStrategy === "string"
    && body.editedStrategy.trim().length > MAX_EDITED_OUTPUT_CHARS
  ) {
    return NextResponse.json(
      { error: `editedStrategy must be at most ${MAX_EDITED_OUTPUT_CHARS} characters` },
      { status: 400 },
    );
  }

  const decision = await withRunLock(id, async () => {
    const run = getRun(id);
    if (!run) return { error: "Run not found", status: 404 } as const;
    if (run.status !== "awaiting-decision") {
      return { error: `Run is in status '${run.status}'`, status: 409 } as const;
    }
    const activeIssue = activeExecutionViolation(run);
    if (activeIssue) return { error: activeIssue, status: 409 } as const;

    const runDir = await createRunDir(id);
    const editedStrategy =
      typeof body.editedStrategy === "string" && body.editedStrategy.trim()
        ? body.editedStrategy.trim()
        : undefined;
    if (editedStrategy) await saveStrategy(runDir, editedStrategy);

    const stages: Stage[] = initializeStages(run.assetType, run.pipeline);

    updateRun(id, {
      ...(editedStrategy ? { strategyDoc: editedStrategy } : {}),
      status: "approved",
      stages,
      currentStage: 1,
    });
    await flushPersistence();
    return { ok: true, runDir, stages, pipeline: run.pipeline } as const;
  });

  if (!("ok" in decision)) {
    return NextResponse.json({ error: decision.error }, { status: decision.status });
  }
  if (!decision.runDir) {
    return NextResponse.json({ error: "Run directory was not created" }, { status: 500 });
  }

  eventBus.emit(id, { type: "stages-initialized", runId: id, stages: decision.stages, pipeline: decision.pipeline });
  const started = await startStageExecution(id, decision.runDir, 1);
  if (!started.ok) {
    return NextResponse.json(
      { error: started.error, attemptId: started.activeAttemptId },
      { status: 409 },
    );
  }

  return NextResponse.json({ ok: true, attemptId: started.attemptId }, { status: 202 });
}
