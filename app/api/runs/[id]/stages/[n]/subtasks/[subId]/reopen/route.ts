import { NextRequest, NextResponse } from "next/server";
import {
  getRun,
  flushPersistence,
  updateRun,
  withRunLock,
} from "@/orchestrator/runRegistry";
import { reopenSubTask } from "@/orchestrator/stageRegistry";
import { eventBus } from "@/orchestrator/eventBus";
import type { StageNumber } from "@/types";
import {
  activeExecutionViolation,
  reopenOrderViolation,
} from "@/orchestrator/executionOrder";

/**
 * Send an approved sub-task back to pending so it can run again. Used when the
 * work was approved and later turned out to need another pass.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; n: string; subId: string }> },
) {
  const { id, n: nStr, subId } = await params;
  const n = Number(nStr) as StageNumber;
  if (![1, 2, 3, 4, 5, 6, 7, 8, 9].includes(n)) {
    return NextResponse.json({ error: "Invalid stage number" }, { status: 400 });
  }

  const result = await withRunLock(id, async () => {
    const run = getRun(id);
    if (!run?.stages) return { error: "Run not found", status: 404 } as const;

    const stage = run.stages.find((candidate) => candidate.number === n);
    const subTask = stage?.subTasks.find((candidate) => candidate.id === subId);
    if (!stage || !subTask) return { error: "SubTask not found", status: 404 } as const;
    if (subTask.status !== "approved") {
      return { error: `SubTask is '${subTask.status}'`, status: 409 } as const;
    }
    const activeIssue = activeExecutionViolation(run);
    if (activeIssue) return { error: activeIssue, status: 409 } as const;
    const orderIssue = reopenOrderViolation(run, n, subId);
    if (orderIssue) return { error: orderIssue, status: 409 } as const;
    const runningTask = run.stages
      .flatMap((candidate) => candidate.subTasks)
      .find((candidate) => candidate.status === "running");
    if (runningTask) {
      return {
        error: `אי אפשר לפתוח מחדש בזמן שתת-המשימה ${runningTask.id} רצה`,
        status: 409,
      } as const;
    }

    const stages = reopenSubTask(run.stages, n, subId);
    updateRun(id, { stages, currentStage: n });
    await flushPersistence();
    return { ok: true, stages } as const;
  });
  if (!("ok" in result)) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  eventBus.emit(id, { type: "stages-initialized", runId: id, stages: result.stages });
  return NextResponse.json({ ok: true });
}
