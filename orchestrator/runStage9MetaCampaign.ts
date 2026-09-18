import type { ClientProfile } from "@/config/clientProfile";
import { appendLog, saveRunArtifact } from "@/lib/runStore";
import type { Run } from "@/types";
import { agentTimeoutMs } from "./executionService";
import type { ExecutionControl } from "./executionService";
import { eventBus } from "./eventBus";
import { getRun, updateRun } from "./runRegistry";
import { spawnAgent } from "./spawnAgent";
import {
  assertClientFeatureReady,
  isValidStage8VerificationReceipt,
  stage8ReportSha256,
  STAGE9_EXECUTION_POLICY,
} from "./stage89Safety";
import { getStageDef } from "./stageRegistry";

const MAX_CONTEXT_CHARS = 30_000;

function redactSensitiveText(value: string): string {
  return value
    .replace(/access[_-]?token\s*[:=]\s*[^\s&"']+/gi, "[REDACTED SECRET]")
    .replace(/authorization\s*[:=]\s*bearer\s+[^\s"']+/gi, "[REDACTED SECRET]")
    .replace(/\b(?:sk|pat|token)-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED]");
}

function boundedContext(value: string | undefined, fallback: string): string {
  const normalized = redactSensitiveText((value ?? "").replace(/\0/g, "")).trim();
  if (!normalized) return fallback;
  return normalized.length <= MAX_CONTEXT_CHARS
    ? normalized
    : `${normalized.slice(0, MAX_CONTEXT_CHARS)}\n\n[המשך התוכן הושמט בגלל מגבלת גודל]`;
}

export function assertStage9Prerequisites(run: Run): {
  stage7Output: string;
  stage8Output: string;
} {
  const stage7 = run.stages?.find((stage) => stage.number === 7);
  if (stage7?.status !== "approved" || !stage7.output.trim()) {
    throw new Error("Stage 9 is blocked until Stage 7 ad copy is approved.");
  }

  const stage8 = run.stages?.find((stage) => stage.number === 8);
  const verification = stage8?.subTasks.find((subTask) => subTask.id === "8")?.metaVerification;
  if (stage8?.status !== "approved" || !stage8.output.trim()) {
    throw new Error("Stage 9 is blocked until Stage 8 verification is approved.");
  }
  if (!isValidStage8VerificationReceipt(verification)) {
    throw new Error("Stage 9 is blocked because Stage 8 has no typed verification receipt.");
  }
  if (stage8ReportSha256(stage8.output) !== verification.reportSha256) {
    throw new Error("Stage 9 is blocked because the approved Stage 8 report changed after verification.");
  }
  if (!verification.ready) {
    throw new Error("Stage 9 is blocked because Stage 8 did not pass the typed launch-readiness gate.");
  }

  return { stage7Output: stage7.output, stage8Output: stage8.output };
}

function profileForPlanning(profile: ClientProfile): string {
  const meta = profile.meta;
  const landing = profile.landing;
  return redactSensitiveText(JSON.stringify(
    {
      tenant: profile.tenant,
      brand: profile.brand,
      policies: {
        contentRules: profile.policies.contentRules,
        advertisingRules: profile.policies.advertisingRules,
        operationalRules: profile.policies.operationalRules,
      },
      landing: { publicBaseUrl: landing?.publicBaseUrl },
      meta: {
        accountId: meta?.accountId,
        pixelId: meta?.pixelId,
        customConversionId: meta?.customConversionId,
        pageId: meta?.pageId,
        instagramActorId: meta?.instagramActorId,
        domain: meta?.domain,
      },
    },
    null,
    2,
  ));
}

export function buildStage9PlanningPrompt(
  profile: ClientProfile,
  run: Run,
  stage7Output: string,
  stage8Output: string,
  feedback?: string,
): string {
  const feedbackBlock = feedback
    ? `\n\n## משוב על התוכנית הקודמת\n\n${boundedContext(feedback, "")}`
    : "";
  return `אתה מתכנן מדיה בכיר. צור מסמך תכנון לקמפיין Meta עבור הלקוח המוגדר למטה.

זהו מצב PLAN ONLY. אין לך הרשאה או כלים לבצע פעולות חיצוניות. אסור לטעון סודות, להריץ פקודות, לקרוא ל-Graph API, ליצור אובייקטים, להעלות מדיה או לטעון שביצעת פעולה. התוצר הוא מפרט לבדיקת אדם בלבד.

## פרופיל לקוח מאומת

${profileForPlanning(profile)}

## brief

${boundedContext(run.brief, "אין brief")}

## אסטרטגיה מאושרת

${boundedContext(run.strategyDoc, "אין מסמך אסטרטגיה")}

## קופי מודעות מאושר משלב 7

${boundedContext(stage7Output, "אין קופי")}

## אימות typed משלב 8

${boundedContext(stage8Output, "אין אימות")}

## התוצר הנדרש

כתוב מסמך markdown בעברית שכולל:

1. הנחות וחוסמים שדורשים החלטת אדם.
2. מבנה של קמפיין אחד ועד 3 ad sets, עם objective, optimization goal, קהלים, exclusions ותקציב בדיקה קטן.
3. שיוך הקופי המאושר והמדיה הנדרשת לכל מודעה. אל תשנה קופי שאושר ואל תמציא נכסי מדיה.
4. URL ו-UTM מלאים לכל מודעה.
5. kill criteria מספריים, benchmark ליום 1 ותנאי scale זהירים.
6. checklist עבור מבצע אנושי או typed executor עתידי. כל אובייקט עתידי מתחיל PAUSED ודורש אישור מפורש לפני יצירה.
7. checklist אימות אחרי יצירה, בלי לטעון שהיצירה כבר התבצעה.

כללי תזמון: מודעות ממומנות ב-Meta רשאיות לרוץ ברצף 7 ימים, כולל שבת. האיסור בשבת חל על תקשורת broadcast כמו מייל, WhatsApp, SMS ופוש, מערב שבת עד מוצאי שבת. אל תוסיף כיבוי שבת למודעות.

אל תכתוב פקודות shell, דוגמאות עם סודות, הוראות לשליפת credentials או קריאות API ישירות. אל תמציא IDs של אובייקטים שלא נוצרו. בלי em dash.${feedbackBlock}

כתוב רק את מסמך התכנון.`;
}

export function assertStage9PlanOutputSafe(output: string): void {
  if (output.trim().length < 100) throw new Error("Stage 9 plan is empty or too short.");
  const forbidden: Array<[RegExp, string]> = [
    [/```\s*(?:bash|sh|shell|zsh)/i, "shell code block"],
    [/\bcurl\b/i, "curl command"],
    [/access[\s_-]?token/i, "access token reference"],
    [/authorization\s*:\s*bearer/i, "bearer credential reference"],
    [/find-generic-password/i, "credential lookup command"],
    [/bypassPermissions/i, "permission bypass reference"],
    [/—/, "em dash"],
    [/(?:^|\n)\s*(?:POST|PATCH|DELETE)\s+https?:\/\//i, "direct write request"],
    [/(?:יצרתי|העליתי|פרסמתי|ביצעתי)\s+(?:את\s+)?(?:הקמפיין|המודעות|ה-ad)/i, "claim of external execution"],
  ];
  const violation = forbidden.find(([pattern]) => pattern.test(output));
  if (violation) throw new Error(`Stage 9 plan failed the plan-only output gate: ${violation[1]}.`);
}

export function buildTrustedStage9Document(plan: string): string {
  return `# תוכנית קמפיין Meta

> מצב: PLAN ONLY
>
> ביצוע חיצוני חסום. המערכת לא יצרה ולא שינתה קמפיין, ad set, מודעה או creative. אין בפרויקט כרגע typed executor מאושר לביצוע שלב זה.
>
> מודעות ממומנות יכולות לרוץ 7 ימים, כולל שבת. רק broadcast במייל, WhatsApp, SMS או פוש מוגבל בשבת.

${plan.trim()}`;
}

function appendFeedbackOnce(history: string[], feedback?: string): string[] {
  if (!feedback || history.at(-1) === feedback) return history;
  return [...history, feedback];
}

export async function runStage9MetaCampaign(
  runId: string,
  runDir: string,
  feedback?: string,
  control?: ExecutionControl,
): Promise<void> {
  control?.throwIfAborted();
  const run = getRun(runId);
  if (!run?.stages) throw new Error(`Run ${runId} or stages not found`);
  const subTaskId = "9";
  const startedAt = new Date().toISOString();
  const runningStages = run.stages.map((stage) =>
    stage.number === 9
      ? {
          ...stage,
          status: "running" as const,
          startedAt,
          currentSubTaskId: subTaskId,
          feedbackHistory: appendFeedbackOnce(stage.feedbackHistory, feedback),
          subTasks: stage.subTasks.map((subTask) =>
            subTask.id === subTaskId
              ? {
                  ...subTask,
                  status: "running" as const,
                  output: "",
                  errorMessage: undefined,
                  startedAt,
                  feedbackHistory: appendFeedbackOnce(subTask.feedbackHistory, feedback),
                }
              : subTask,
          ),
        }
      : stage,
  );
  updateRun(runId, { stages: runningStages, currentStage: 9 });
  eventBus.emit(runId, { type: "stage-started", runId, stageNumber: 9 });
  eventBus.emit(runId, { type: "subtask-started", runId, stageNumber: 9, subTaskId });

  const logName = `stage-9-${getStageDef(9).ownerSlug}.log`;
  try {
    if (!run.clientProfile) {
      throw new Error(
        "Stage 9 is blocked because this legacy run has no client-profile snapshot. Start a new run with a configured client profile.",
      );
    }
    const profile = assertClientFeatureReady(run.clientProfile, "stage9");
    const prerequisites = assertStage9Prerequisites(getRun(runId) ?? run);
    control?.throwIfAborted();
    const prompt = buildStage9PlanningPrompt(
      profile,
      run,
      prerequisites.stage7Output,
      prerequisites.stage8Output,
      feedback,
    );
    await appendLog(runDir, logName, `# Plan prompt\n\n${prompt}\n\n# Plan output\n\n`);

    const { fullText } = await spawnAgent({
      prompt,
      permissionMode: "default",
      tools: [],
      strictMcpConfig: true,
      settingSources: [],
      disableSlashCommands: true,
      signal: control?.signal,
      timeoutMs: agentTimeoutMs(control),
      // Buffer the text until the plan-only gate accepts the complete output.
      // Unsafe partial output must not be streamed to the UI or written to disk.
      onToken: () => {
        control?.throwIfAborted();
      },
    });
    control?.throwIfAborted();
    assertStage9PlanOutputSafe(fullText);
    const document = buildTrustedStage9Document(fullText);
    await appendLog(runDir, logName, document);
    await saveRunArtifact(runDir, "stage-9.md", document);
    control?.throwIfAborted();

    const finalStages = (getRun(runId)?.stages ?? []).map((stage) =>
      stage.number === 9
        ? {
            ...stage,
            subTasks: stage.subTasks.map((subTask) =>
              subTask.id === subTaskId
                ? {
                    ...subTask,
                    status: "awaiting-decision" as const,
                    output: document,
                    completedAt: new Date().toISOString(),
                  }
                : subTask,
            ),
          }
        : stage,
    );
    updateRun(runId, { stages: finalStages });
    eventBus.emit(runId, {
      type: "subtask-completed",
      runId,
      stageNumber: 9,
      subTaskId,
      content: document,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const failedStages = (getRun(runId)?.stages ?? []).map((stage) =>
      stage.number === 9
        ? {
            ...stage,
            status: "error" as const,
            errorMessage,
            subTasks: stage.subTasks.map((subTask) =>
              subTask.id === subTaskId
                ? { ...subTask, status: "error" as const, errorMessage }
                : subTask,
            ),
          }
        : stage,
    );
    updateRun(runId, { stages: failedStages });
    if (!control?.signal.aborted) {
      eventBus.emit(runId, {
        type: "subtask-error",
        runId,
        stageNumber: 9,
        subTaskId,
        errorMessage,
      });
      eventBus.emit(runId, { type: "stage-error", runId, stageNumber: 9, errorMessage });
    }
    await appendLog(runDir, logName, `\n\n# ERROR\n\n${errorMessage}\n`).catch(() => undefined);
    throw error;
  }
}

export { STAGE9_EXECUTION_POLICY };
