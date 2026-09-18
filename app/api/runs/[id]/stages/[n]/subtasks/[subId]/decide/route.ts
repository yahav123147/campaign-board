import { NextRequest, NextResponse } from "next/server";
import {
  getRun,
  flushPersistence,
  updateRun,
  withRunLock,
} from "@/orchestrator/runRegistry";
import { getStageDef } from "@/orchestrator/stageRegistry";
import { startSubTaskExecution } from "@/orchestrator/runSubTask";
import { persistSubTaskFile } from "@/orchestrator/runSubTask";
import { CREATIVES_DISABLED_MARKER } from "@/orchestrator/runStage7Creatives";
import { CREATIVE_MODE_CHOICE_MARKER } from "@/lib/creativeMode";
import { finalizeStageIfComplete } from "@/orchestrator/runStage";
import { createRunDir } from "@/lib/runStore";
import type { StageNumber } from "@/types";
import path from "node:path";
import {
  approveReviewRequiredAssets,
  missingRequiredMockups,
  readAssetManifestDraft,
} from "@/orchestrator/assetQuality";
import { brandBriefForBuild } from "@/orchestrator/runStage5LpBuild";
import { parseDesignBriefJson } from "@/orchestrator/designBriefJson";
import { deliverStage5LandingPage } from "@/orchestrator/runStage5Preview";
import { httpBodyError, readJsonBody } from "@/lib/httpBody";
import { MAX_EDITED_OUTPUT_CHARS } from "@/lib/inputLimits";
import {
  activeExecutionViolation,
  subTaskOrderViolation,
} from "@/orchestrator/executionOrder";
import { eventBus } from "@/orchestrator/eventBus";
import { stage8ApprovalViolation } from "@/orchestrator/stage89Safety";
import { expressAutoApproveViolation } from "@/orchestrator/gateAutoApprove";

const EXPRESS_BINDING_MAX_CHARS = 64;

/**
 * Why an express 5.3 approval may not proceed, or null. Runs inside the run
 * lock on the run as refreshed from disk, so the approval lands only on the
 * exact image map check express evaluated.
 */
function expressImageMapBindingViolation(
  run: Parameters<typeof expressAutoApproveViolation>[0],
  binding: unknown,
): string | null {
  const record = binding as Record<string, unknown> | null;
  if (
    !record ||
    typeof record !== "object" ||
    typeof record.attemptStartedAt !== "string" ||
    typeof record.checkedAt !== "string" ||
    record.attemptStartedAt.length > EXPRESS_BINDING_MAX_CHARS ||
    record.checkedAt.length > EXPRESS_BINDING_MAX_CHARS
  ) {
    return "expressImageMapCheck must carry attemptStartedAt and checkedAt strings of at most 64 characters";
  }
  const violation = expressAutoApproveViolation(run, 5, "5.3");
  if (violation) return `expressImageMapCheck refused: ${violation}`;
  const check = run?.stages?.find((stage) => stage.number === 5)?.subTasks.find((task) => task.id === "5.3")?.imageMapCheck;
  if (check?.attemptStartedAt !== record.attemptStartedAt || check?.checkedAt !== record.checkedAt) {
    return "expressImageMapCheck refused: the stored image map check is not the one express evaluated";
  }
  return null;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; n: string; subId: string }> },
) {
  const { id, n: nStr, subId } = await params;
  const n = Number(nStr) as StageNumber;
  if (![1, 2, 3, 4, 5, 6, 7, 8, 9].includes(n)) {
    return NextResponse.json({ error: "Invalid stage number" }, { status: 400 });
  }

  let body: { action?: string; editedOutput?: string; expressImageMapCheck?: unknown };
  try {
    body = await readJsonBody(req);
  } catch (error) {
    const issue = httpBodyError(error);
    return NextResponse.json({ error: issue.error }, { status: issue.status });
  }

  if (body.action !== "approve" && body.action !== "edit") {
    return NextResponse.json({ error: "action must be 'approve' or 'edit'" }, { status: 400 });
  }
  if (body.action === "edit" && (typeof body.editedOutput !== "string" || !body.editedOutput.trim())) {
    return NextResponse.json({ error: "editedOutput required" }, { status: 400 });
  }
  if (typeof body.editedOutput === "string" && body.editedOutput.trim().length > MAX_EDITED_OUTPUT_CHARS) {
    return NextResponse.json(
      { error: `editedOutput must be at most ${MAX_EDITED_OUTPUT_CHARS} characters` },
      { status: 400 },
    );
  }

  const expressBinding = body.expressImageMapCheck !== undefined;
  if (expressBinding && !(n === 5 && subId === "5.3")) {
    return NextResponse.json({ error: "expressImageMapCheck is only accepted for stage 5 sub-task 5.3" }, { status: 400 });
  }

  const decision = await withRunLock(id, async () => {
    const run = getRun(id);
    if (!run?.stages) return { error: "Run or stages not found", status: 404 } as const;
    const stage = run.stages.find((candidate) => candidate.number === n);
    if (!stage) return { error: "Stage not found", status: 404 } as const;
    const subTask = stage.subTasks.find((candidate) => candidate.id === subId);
    if (!subTask) return { error: "SubTask not found", status: 404 } as const;
    const orderIssue = subTaskOrderViolation(run, n, subId);
    if (orderIssue) return { error: orderIssue, status: 409 } as const;
    if (subTask.status !== "awaiting-decision") {
      return { error: `SubTask is '${subTask.status}'`, status: 409 } as const;
    }
    const activeIssue = activeExecutionViolation(run);
    if (activeIssue) return { error: activeIssue, status: 409 } as const;
    if (expressBinding) {
      const bindingIssue = expressImageMapBindingViolation(run, body.expressImageMapCheck);
      if (bindingIssue) return { error: bindingIssue, status: 409 } as const;
    }

    if (n === 8) {
      if (body.action === "edit") {
        return {
          error: "Stage 8 is a sealed verification report and cannot be edited. Send feedback to rerun it.",
          status: 409,
        } as const;
      }
      const verificationIssue = stage8ApprovalViolation(subTask);
      if (verificationIssue) return { error: verificationIssue, status: 409 } as const;
    }

    if (n === 7 && subId === "7.5" && subTask.output.startsWith(CREATIVE_MODE_CHOICE_MARKER)) {
      return {
        error: "זהו מסך בחירת מצב קריאייטיב, לא תוצר. בחרו מצב במקום לאשר.",
        status: 409,
      } as const;
    }
    const output = body.action === "edit" ? body.editedOutput!.trim() : subTask.output;
    const runDir = await createRunDir(id);
    let assetManifestSha256: string | undefined;
    let landingCommitSha: string | undefined;
    // כשהיכולת כבויה 7.5 מסתיים בלי גיליון תמונות, ודרישת חותמת הייתה תוקעת
    // את האישור (ידני ואקספרס) ב-409 וחוסמת את שלבים 8-9 (F101).
    const creativesDisabledOutput =
      n === 7 && subId === "7.5" && subTask.output.startsWith(CREATIVES_DISABLED_MARKER);
    const sealedAssetDirName = n === 5 && subId === "5.2"
      ? "assets"
      : n === 7 && subId === "7.5" && !creativesDisabledOutput
      ? "creatives"
      : null;
    if (sealedAssetDirName) {
      if (!subTask.assetManifestDraftSha256) {
        return {
          error: "Asset approval failed: the contact sheet has no recorded manifest snapshot",
          status: 409,
        } as const;
      }
      if (!subTask.assetContactSheetFile || !subTask.assetContactSheetSha256) {
        return {
          error: "Asset approval failed: the displayed contact sheet has no recorded seal",
          status: 409,
        } as const;
      }
      // A page whose design brief requires device mockups is not approvable
      // while one of them is missing or was rejected: the builder would place
      // what is there and the gap would surface only on the built page. Read
      // before anything is sealed, so a refusal leaves no approval behind.
      const requiredMockups = n === 5 && subId === "5.2"
        ? parseDesignBriefJson(brandBriefForBuild(run))?.requiredMockups ?? []
        : [];
      if (requiredMockups.length) {
        let missing: string[];
        try {
          const draft = await readAssetManifestDraft(
            path.join(runDir, sealedAssetDirName),
            subTask.assetManifestDraftSha256,
          );
          missing = missingRequiredMockups(draft.assets, requiredMockups);
        } catch (error) {
          return {
            error: `Asset approval failed: ${error instanceof Error ? error.message : String(error)}`,
            status: 409,
          } as const;
        }
        if (missing.length) {
          return { error: `מוקאפ נדרש חסר או נפסל: ${missing.join(", ")}`, status: 409 } as const;
        }
      }
      try {
        assetManifestSha256 = (
          await approveReviewRequiredAssets(
            path.join(runDir, sealedAssetDirName),
            subTask.assetManifestDraftSha256,
            {
              file: subTask.assetContactSheetFile,
              sha256: subTask.assetContactSheetSha256,
            },
          )
        ).manifestSha256;
      } catch (error) {
        return {
          error: `Asset approval failed: ${error instanceof Error ? error.message : String(error)}`,
          status: 409,
        } as const;
      }
    }
    if (n === 5 && subId === "5.4") {
      if (!subTask.qaVerification?.ready) {
        return {
          error: "Preview approval failed: Stage 5.4 has no passing QA receipt. Send feedback and rerun the gate.",
          status: 409,
        } as const;
      }
      try {
        landingCommitSha = (await deliverStage5LandingPage(id, runDir)).commitSha;
      } catch (error) {
        return {
          error: `Preview approval failed: ${error instanceof Error ? error.message : String(error)}`,
          status: 409,
        } as const;
      }
    }

    const approvedOutput = landingCommitSha
      ? `${output.trim()}\n\n## ✅ נמסר לענף\n\n- Commit: \`${landingCommitSha}\``
      : output;
    let newStages = run.stages.map((candidate) =>
      candidate.number === n
        ? {
            ...candidate,
            subTasks: candidate.subTasks.map((task) => {
              if (landingCommitSha && task.id === "5.3") {
                return { ...task, landingCommitSha };
              }
              return task.id === subId
                ? {
                    ...task,
                    status: "approved" as const,
                    output: approvedOutput,
                    assetManifestSha256: assetManifestSha256 ?? task.assetManifestSha256,
                    assetManifestDraftSha256:
                      assetManifestSha256 !== undefined ? undefined : task.assetManifestDraftSha256,
                    metaVerification: task.metaVerification,
                  }
                : task;
            }),
          }
        : candidate,
    );
    const reviewedStage = newStages.find((candidate) => candidate.number === n);
    const stageCompleted = Boolean(
      reviewedStage?.subTasks.every((task) => task.status === "approved"),
    );
    if (stageCompleted && reviewedStage) {
      const completedAt = new Date().toISOString();
      const assembledOutput = reviewedStage.subTasks
        .map((task) => task.output)
        .join("\n\n---\n\n");
      newStages = newStages.map((candidate) => candidate.number === n
        ? {
            ...candidate,
            status: "approved" as const,
            output: assembledOutput,
            completedAt,
            currentSubTaskId: undefined,
            errorMessage: undefined,
          }
        : candidate);
    }
    const nextStageNumber = stageCompleted
      ? newStages.find(
          (candidate) => candidate.number > n && candidate.status === "pending",
        )?.number ?? null
      : null;
    // קובץ התוצר בדיסק הוא מה שריצות משוב עתידיות קוראות כ"גרסה קודמת", ולכן
    // הוא חייב להיות שווה תמיד לנוסח שאושר ב-run.json: כותבים אותו בכל אישור
    // (לא רק בעריכה, כדי שאישור מאוחר של המקור ידרוס עריכה שכשלה בדרך), לפני
    // רישום האישור, וכשל בכתיבה מפיל את האישור במקום להיבלע. אם run.json נכשל
    // אחרי שהקובץ כבר נכתב, הקובץ מגולגל חזרה לנוסח הקודם (F101).
    const previousOutput = subTask.output;
    try {
      await persistSubTaskFile(runDir, n, subId, approvedOutput);
    } catch (error) {
      return {
        error: `שמירת הנוסח המאושר לקובץ התוצר נכשלה, האישור לא נרשם: ${error instanceof Error ? error.message : String(error)}`,
        status: 500,
      } as const;
    }
    updateRun(id, {
      stages: newStages,
      ...(stageCompleted ? { currentStage: nextStageNumber } : {}),
    });
    try {
      await flushPersistence();
    } catch (error) {
      if (approvedOutput !== previousOutput) {
        await persistSubTaskFile(runDir, n, subId, previousOutput).catch(() => {});
      }
      throw error;
    }

    const stageDef = getStageDef(n, run.assetType, run.pipeline);
    const nextSubTaskDef = stageDef.subTasks.find((definition) => {
      const persisted = newStages
        .find((candidate) => candidate.number === n)
        ?.subTasks.find((task) => task.id === definition.id);
      return persisted?.status === "pending";
    });
    return {
      ok: true,
      runDir,
      nextSubTaskId: nextSubTaskDef?.id ?? null,
      landingCommitSha: landingCommitSha ?? null,
      stageCompleted,
      stages: newStages,
    } as const;
  });

  if (!("ok" in decision)) {
    return NextResponse.json({ error: decision.error }, { status: decision.status });
  }
  const decisionRunDir = decision.runDir;
  if (!decisionRunDir) {
    return NextResponse.json({ error: "Run directory was not created" }, { status: 500 });
  }
  eventBus.emit(id, { type: "stages-initialized", runId: id, stages: decision.stages });
  if (decision.nextSubTaskId) {
    const started = await startSubTaskExecution(id, decisionRunDir, n, decision.nextSubTaskId);
    if (!started.ok) {
      return NextResponse.json(
        { error: started.error, attemptId: started.activeAttemptId },
        { status: 409 },
      );
    }
    return NextResponse.json(
      { ok: true, nextSubTaskId: decision.nextSubTaskId, attemptId: started.attemptId },
      { status: 202 },
    );
  } else {
    await finalizeStageIfComplete(id, decisionRunDir, n);
  }
  return NextResponse.json({
    ok: true,
    nextSubTaskId: null,
    landingCommitSha: decision.landingCommitSha,
  });
}
