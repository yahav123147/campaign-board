import { NextRequest, NextResponse } from "next/server";
import {
  getRun,
  flushPersistence,
  updateRun,
  withRunLock,
} from "@/orchestrator/runRegistry";
import { startStageExecution } from "@/orchestrator/runStage";
import { stageRequiresExplicitStart } from "@/orchestrator/stage89Safety";
import { createRunDir } from "@/lib/runStore";
import type { StageNumber } from "@/types";
import { httpBodyError, readJsonBody } from "@/lib/httpBody";
import { MAX_EDITED_OUTPUT_CHARS } from "@/lib/inputLimits";
import {
  activeExecutionViolation,
  stageOrderViolation,
} from "@/orchestrator/executionOrder";
import { eventBus } from "@/orchestrator/eventBus";
import { stage8ApprovalViolation } from "@/orchestrator/stage89Safety";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; n: string }> }
) {
  const { id, n: nStr } = await params;
  const n = Number(nStr) as StageNumber;
  if (![1, 2, 3, 4, 5, 6, 7, 8, 9].includes(n)) {
    return NextResponse.json({ error: "Invalid stage number" }, { status: 400 });
  }

  let body: { action?: string; editedOutput?: string };
  try {
    body = await readJsonBody(req);
  } catch (error) {
    const issue = httpBodyError(error);
    return NextResponse.json({ error: issue.error }, { status: issue.status });
  }

  if (body.action !== "approve" && body.action !== "edit") {
    return NextResponse.json({ error: "action must be 'approve' or 'edit'" }, { status: 400 });
  }

  if (
    body.action === "edit"
    && (typeof body.editedOutput !== "string" || body.editedOutput.trim().length === 0)
  ) {
    return NextResponse.json({ error: "editedOutput required for 'edit' action" }, { status: 400 });
  }
  if (typeof body.editedOutput === "string" && body.editedOutput.trim().length > MAX_EDITED_OUTPUT_CHARS) {
    return NextResponse.json(
      { error: `editedOutput must be at most ${MAX_EDITED_OUTPUT_CHARS} characters` },
      { status: 400 },
    );
  }

  const decision = await withRunLock(id, async () => {
    const run = getRun(id);
    if (!run?.stages) return { error: "Run or stages not found", status: 404 } as const;
    const stage = run.stages.find((candidate) => candidate.number === n);
    if (!stage) return { error: "Stage not found", status: 404 } as const;
    const orderIssue = stageOrderViolation(run, n);
    if (orderIssue) return { error: orderIssue, status: 409 } as const;
    if (stage.status !== "awaiting-decision") {
      return { error: `Stage is in status '${stage.status}'`, status: 409 } as const;
    }
    const activeIssue = activeExecutionViolation(run);
    if (activeIssue) return { error: activeIssue, status: 409 } as const;

    if (n === 8) {
      if (body.action === "edit") {
        return {
          error: "Stage 8 is a sealed verification report and cannot be edited. Send feedback to rerun it.",
          status: 409,
        } as const;
      }
      const verificationTask = stage.subTasks.find((task) => task.id === "8");
      const verificationIssue = verificationTask
        ? stage8ApprovalViolation(verificationTask, stage.output)
        : "Stage 8 cannot be approved without its verification sub-task.";
      if (verificationIssue) return { error: verificationIssue, status: 409 } as const;
    }

    const updatedOutput = body.action === "edit" ? body.editedOutput!.trim() : stage.output;
    const stages = run.stages.map((candidate) =>
      candidate.number === n
        ? { ...candidate, status: "approved" as const, output: updatedOutput }
        : candidate,
    );
    const nextStage = stages.find(
      (candidate) => candidate.status === "pending" && candidate.number > n,
    );
    updateRun(id, { stages, currentStage: nextStage?.number ?? null });
    await flushPersistence();
    return { ok: true, nextStage: nextStage?.number ?? null, stages } as const;
  });

  if (!("ok" in decision)) {
    return NextResponse.json({ error: decision.error }, { status: decision.status });
  }

  eventBus.emit(id, { type: "stages-initialized", runId: id, stages: decision.stages });

  if (!decision.nextStage) {
    return NextResponse.json({ ok: true, nextStage: null });
  }
  if (stageRequiresExplicitStart(decision.nextStage)) {
    return NextResponse.json({
      ok: true,
      nextStage: decision.nextStage,
      explicitStartRequired: true,
    });
  }
  const runDir = await createRunDir(id);
  const started = await startStageExecution(id, runDir, decision.nextStage);
  if (!started.ok) {
    return NextResponse.json(
      { error: started.error, attemptId: started.activeAttemptId },
      { status: 409 },
    );
  }
  return NextResponse.json(
    { ok: true, nextStage: decision.nextStage, attemptId: started.attemptId },
    { status: 202 },
  );
}
