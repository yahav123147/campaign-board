"use client";
import { useState } from "react";
import type { Stage, AgentMeta, SubTask, SubTaskPhase } from "@/types";
import { PagePreview } from "./PagePreview";
import { AgentOutput } from "./AgentOutput";
import { CriticBoard } from "./CriticBoard";
import { apiFetch } from "@/lib/clientApi";
import {
  CREATIVE_MODE_CHOICE_MARKER,
  SUBTASK_START_SENTINEL,
  SUBTASK_RETRY_SENTINEL,
  type CreativeMode,
} from "@/lib/creativeMode";
import { stageOfTotalLabel } from "@/lib/runPageStageState";

interface CanvasStageProps {
  stage: Stage;
  /** The run's own stage list, so the total is five for an upsell run, not a fixed nine. */
  stages: Stage[];
  owner?: AgentMeta;
  agents: AgentMeta[];
  isStreaming: boolean;
  runId: string;
}

export function CanvasStage({ stage, stages, owner, agents, runId }: CanvasStageProps) {
  return (
    <div className="max-w-3xl mx-auto px-8 py-10">
      <header className="mb-8 pb-6" style={{ borderBottom: "1px solid var(--color-rule)" }}>
        <p className="text-xs font-medium uppercase tracking-wider mb-2" style={{ color: "var(--color-ink-muted)" }}>
          {stageOfTotalLabel(stage.number, stages)}
        </p>
        <h1 className="font-display text-4xl font-medium tracking-tight" style={{ color: "var(--color-ink)" }}>
          {stage.title}
        </h1>
        {owner && (
          <p className="mt-3 text-sm" style={{ color: "var(--color-ink-muted)" }}>
            {owner.name} · {owner.role}
          </p>
        )}
      </header>

      {stage.number === 9 && (
        <div
          className="rounded-md p-4 mb-6 text-sm"
          style={{
            background: "rgba(180, 83, 9, 0.06)",
            border: "1px solid rgba(180, 83, 9, 0.35)",
            color: "var(--color-ink)",
          }}
        >
          <strong>PLAN ONLY:</strong> שלב זה יוצר תוכנית לבדיקת אדם בלבד. הוא לא ניגש לטוקן,
          לא יוצר אובייקטים ב-Meta ולא מפעיל קמפיין. אין כרגע בפרויקט מנגנון ביצוע typed מאושר.
          התוכנית תיווצר רק אם שלב 8 עבר עם חותמת אימות שלא נערכה.
        </div>
      )}

      {stage.number === 8 && (
        <div
          className="rounded-md p-4 mb-6 text-sm"
          style={{ background: "var(--color-surface)", border: "1px solid var(--color-rule)" }}
        >
          הבדיקה היא קריאה בלבד ונכשלת סגור. פעילות כללית של הפיקסל אינה מספיקה בלי ראיית
          Purchase,‏ had_pii ומקור server מפורשים. הדוח חתום ואינו ניתן לעריכה ידנית;
          במקרה של חוסר או טעות שולחים משוב ומריצים את האימות מחדש.
        </div>
      )}

      {stage.status === "error" && (
        <div
          className="rounded-md p-4 mb-6"
          style={{
            background: "rgba(153,27,27,0.05)",
            border: "1px solid rgba(153,27,27,0.3)",
            color: "var(--color-danger)",
          }}
        >
          ⚠ שגיאה: {stage.errorMessage ?? "ללא"}
        </div>
      )}

      {/* Special-case skipped/preflight stages with single sub-task that starts with "✓" */}
      {stage.status === "approved" &&
        stage.subTasks.length === 1 &&
        stage.subTasks[0].output.startsWith("✓") && (
          <div
            className="rounded-md p-4"
            style={{ background: "var(--color-surface)", border: "1px solid var(--color-rule)" }}
          >
            <p className="text-[15px]" style={{ color: "var(--color-ink)" }}>
              {stage.subTasks[0].output}
            </p>
          </div>
        )}

      <div className="space-y-4">
        {stage.subTasks.map((subTask) => (
          <SubTaskCard
            key={subTask.id}
            subTask={subTask}
            owner={owner}
            agents={agents}
            stageNumber={stage.number}
            runId={runId}
            canStart={subTask.id === firstStartableSubTaskId(stage)}
          />
        ))}
      </div>

      {stage.number === 5 && <PagePreview runId={runId} />}

      {stage.feedbackHistory.length > 0 && (
        <details className="mt-8 text-xs" style={{ color: "var(--color-ink-muted)" }}>
          <summary className="cursor-pointer">היסטוריית משוב לשלב ({stage.feedbackHistory.length})</summary>
          <ul className="mt-3 space-y-1 pr-3">
            {stage.feedbackHistory.map((f, i) => (
              <li key={i}>· {f}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/**
 * The first sub-task that is waiting with nothing ahead of it. A stage can sit
 * pending with no work in flight (a stage rebuilt after its shape changed, or
 * one that never auto-started), and it needs a way in.
 */
function firstStartableSubTaskId(stage: Stage): string | null {
  const busy = stage.subTasks.some(
    (st) => st.status === "running" || st.status === "awaiting-decision" || st.status === "error",
  );
  if (busy) return null;
  return stage.subTasks.find((st) => st.status === "pending")?.id ?? null;
}

function SubTaskCard({
  subTask,
  owner,
  agents,
  stageNumber,
  runId,
  canStart = false,
}: {
  subTask: SubTask;
  owner?: AgentMeta;
  agents: AgentMeta[];
  stageNumber: number;
  runId: string;
  canStart?: boolean;
}) {
  const [mode, setMode] = useState<"view" | "edit" | "feedback">("view");
  const [editedOutput, setEditedOutput] = useState(subTask.output);
  const [feedback, setFeedback] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [expanded, setExpanded] = useState(subTask.status !== "approved");

  const hasMiniDisc = subTask.critiques !== undefined || subTask.currentPhase !== undefined;
  const isPending = subTask.status === "pending";
  const isRunning = subTask.status === "running";
  const isAwaiting = subTask.status === "awaiting-decision";
  // A sub-task that reports a failed gate must not offer "approve" as the
  // obvious next click: a reviewer could approve a page they never saw in that state.
  const gateFailed =
    /שער QA: ⚠️ נכשל|RESULT: FAIL|פסק דין סופי:\s*⚠️/.test(subTask.output)
    || (stageNumber === 8 && subTask.metaVerification?.ready !== true)
    || (stageNumber === 5 && subTask.id === "5.4" && subTask.qaVerification?.ready !== true);
  const isApproved = subTask.status === "approved";
  const isError = subTask.status === "error";
  const isCreativeSubTask = stageNumber === 7 && subTask.id === "7.5";
  const [modeSwitchOpen, setModeSwitchOpen] = useState(false);

  const start = async () => {
    setSubmitting(true);
    const res = await apiFetch(
      `/api/runs/${runId}/stages/${stageNumber}/subtasks/${subTask.id}/feedback`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feedback: SUBTASK_START_SENTINEL }),
      },
    );
    if (!res.ok) alert((await res.json()).error ?? "שגיאה");
    setSubmitting(false);
  };

  const reopen = async () => {
    if (!confirm("לפתוח מחדש? תת-המשימה הזאת וכל מה שאחריה בשלב יחזרו להמתנה.")) return;
    setSubmitting(true);
    const res = await apiFetch(
      `/api/runs/${runId}/stages/${stageNumber}/subtasks/${subTask.id}/reopen`,
      { method: "POST" },
    );
    if (!res.ok) alert((await res.json()).error ?? "שגיאה");
    setSubmitting(false);
  };

  const retry = async () => {
    setSubmitting(true);
    const res = await apiFetch(
      `/api/runs/${runId}/stages/${stageNumber}/subtasks/${subTask.id}/feedback`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feedback: SUBTASK_RETRY_SENTINEL }),
      },
    );
    if (!res.ok) alert((await res.json()).error ?? "שגיאה");
    setSubmitting(false);
  };

  const approve = async () => {
    setSubmitting(true);
    const res = await apiFetch(
      `/api/runs/${runId}/stages/${stageNumber}/subtasks/${subTask.id}/decide`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "approve" }),
      },
    );
    if (!res.ok) alert((await res.json()).error ?? "שגיאה");
    setSubmitting(false);
  };
  const saveEdit = async () => {
    setSubmitting(true);
    const res = await apiFetch(
      `/api/runs/${runId}/stages/${stageNumber}/subtasks/${subTask.id}/decide`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "edit", editedOutput }),
      },
    );
    if (!res.ok) alert((await res.json()).error ?? "שגיאה");
    setSubmitting(false);
    setMode("view");
  };
  const sendFeedback = async () => {
    if (feedback.trim().length < 5) {
      alert("המשוב חייב להיות לפחות 5 תווים");
      return;
    }
    setSubmitting(true);
    const res = await apiFetch(
      `/api/runs/${runId}/stages/${stageNumber}/subtasks/${subTask.id}/feedback`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feedback }),
      },
    );
    if (!res.ok) alert((await res.json()).error ?? "שגיאה");
    setSubmitting(false);
    setMode("view");
    setFeedback("");
  };

  if (isPending) {
    return (
      <div
        className="flex items-center gap-2 py-3 px-4 text-sm rounded-md"
        style={{ color: "var(--color-ink-muted)" }}
      >
        <span className="w-2 h-2 rounded-full" style={{ background: "var(--color-rule-strong)" }} />
        <span>{subTask.title}</span>
        <span className="text-xs">· ממתין</span>
        {canStart && (
          <button
            onClick={start}
            disabled={submitting}
            className="mr-auto text-xs font-medium px-3 py-1.5 rounded-md transition-colors disabled:opacity-40"
            style={{ background: "var(--color-accent)", color: "white" }}
          >
            {submitting ? "מתחיל…" : stageNumber === 9 ? "▶︎ צור תוכנית" : "▶︎ התחל"}
          </button>
        )}
      </div>
    );
  }

  // הפאנל מוצג רק כשבחירת מצב באמת עוזרת: מסך הבחירה, כשל שקשור לווריאציה,
  // או פתיחה יזומה של החלפת מצב. שגיאת תשתית רגילה שומרת על כרטיס השגיאה
  // עם retry ומשוב, אחרת הלקוח נתקע בלופ בלי תיבת משוב.
  const atChoiceScreen = isAwaiting && subTask.output.startsWith(CREATIVE_MODE_CHOICE_MARKER);
  const isVariationFailure =
    isError && isCreativeSubTask && (subTask.errorMessage ?? "").includes("וריאציית ה-AI");
  const manualModeSwitch = isCreativeSubTask && modeSwitchOpen && (isAwaiting || isError);
  if (atChoiceScreen || isVariationFailure || manualModeSwitch) {
    return (
      <CreativeModePanel
        runId={runId}
        stageNumber={stageNumber}
        subTaskId={subTask.id}
        onCancel={atChoiceScreen ? undefined : () => setModeSwitchOpen(false)}
        output={
          isVariationFailure
            ? `⚠️ ההפקה נכשלה:\n${subTask.errorMessage ?? ""}\n\nבחרו איך להמשיך: אותו מצב = ניסיון נוסף, מצב אחר = החלפה.`
            : atChoiceScreen
            ? subTask.output
            : "🎛️ החלפת מצב קריאייטיב: בחירה כאן מריצה הפקה חדשה ומחליפה את הסט הנוכחי."
        }
      />
    );
  }

  if (isApproved && !expanded) {
    return (
      <button
        onClick={() => setExpanded(true)}
        className="w-full text-right flex items-center gap-3 py-3 px-4 rounded-md transition-colors hover:bg-zinc-50"
        style={{ border: "1px solid var(--color-rule)" }}
      >
        <span className="text-sm" style={{ color: "var(--color-success)" }}>
          ✓
        </span>
        <span className="flex-1 font-medium text-sm" style={{ color: "var(--color-ink)" }}>
          {subTask.title}
        </span>
        <span className="text-xs" style={{ color: "var(--color-ink-muted)" }}>
          הצג
        </span>
      </button>
    );
  }

  const critics = (subTask.critiques ?? [])
    .map((c) => agents.find((a) => a.slug === c.agentSlug)?.name)
    .filter((n): n is string => Boolean(n));

  return (
    <section
      className="rounded-md p-6"
      style={{
        background: "var(--color-surface)",
        border: `2px solid ${isAwaiting ? "var(--color-accent)" : "var(--color-rule)"}`,
      }}
    >
      <header
        className="flex items-center justify-between mb-4 pb-3"
        style={{ borderBottom: "1px solid var(--color-rule)" }}
      >
        <h3 className="font-medium" style={{ color: "var(--color-ink)" }}>
          {subTask.title}
        </h3>
        <StatusBadge subTask={subTask} />
      </header>

      {/* Mini-discussion phase indicator while running */}
      {hasMiniDisc && isRunning && subTask.currentPhase && (
        <div className="mb-4 text-xs" style={{ color: "var(--color-ink-muted)" }}>
          <PhaseIndicator
            phase={subTask.currentPhase}
            ownerName={owner?.name ?? ""}
            critics={critics}
          />
        </div>
      )}

      {/* Draft (mini-discussion only, after phase 1) */}
      {hasMiniDisc && subTask.draftOutput && subTask.currentPhase !== "draft" && (
        <details className="mb-4 text-sm">
          <summary className="cursor-pointer py-1" style={{ color: "var(--color-ink-muted)" }}>
            טיוטה ראשונה של {owner?.name ?? "הסוכן"}
          </summary>
          <pre
            className="mt-2 whitespace-pre-wrap text-[14px] leading-[1.7] p-3 rounded"
            style={{
              background: "var(--color-paper)",
              color: "var(--color-ink-muted)",
              fontFamily: "var(--font-heebo), system-ui, sans-serif",
            }}
          >
            {subTask.draftOutput}
          </pre>
        </details>
      )}

      {/* Critiques (mini-discussion only, after phase 2) */}
      {hasMiniDisc &&
        subTask.critiques &&
        subTask.critiques.length > 0 &&
        subTask.currentPhase !== "draft" && (
          <details className="mb-4 text-sm">
            <summary className="cursor-pointer py-1" style={{ color: "var(--color-ink-muted)" }}>
              קונטרות מהבורד ({subTask.critiques.length})
            </summary>
            <div className="mt-2 space-y-3">
              {subTask.critiques.map((c) => {
                const critic = agents.find((a) => a.slug === c.agentSlug);
                return (
                  <div
                    key={c.agentSlug}
                    className="p-3 rounded"
                    style={{ background: "var(--color-paper)" }}
                  >
                    <div
                      className="text-xs font-medium mb-1"
                      style={{ color: "var(--color-ink)" }}
                    >
                      {critic?.name ?? c.agentSlug}
                    </div>
                    <pre
                      className="whitespace-pre-wrap text-[14px] leading-[1.7]"
                      style={{
                        color: "var(--color-ink)",
                        fontFamily: "var(--font-heebo), system-ui, sans-serif",
                      }}
                    >
                      {c.content || `(${c.errorMessage ?? "אין"})`}
                    </pre>
                  </div>
                );
              })}
            </div>
          </details>
        )}

      {/* The critic board: one column per scoring round, live while it runs */}
      {(subTask.criticRounds?.length || subTask.criticRound) && (
        <CriticBoard rounds={subTask.criticRounds ?? []} dimensions={Object.keys(subTask.criticRounds?.find((r) => r.scores)?.scores ?? {})} currentRound={isRunning ? subTask.criticRound : undefined} />
      )}
      {stageNumber === 1 && subTask.harvest && (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`/api/runs/${runId}/harvest/sheet.jpg?v=${encodeURIComponent(subTask.harvest.harvestedAt)}`} alt="גיליון הקציר" className="mb-1 rounded max-w-full" />
          <p className="mb-4 text-[13px]" style={{ color: "var(--color-ink-muted)" }}>
            {subTask.harvest.igHandle ? `אינסטגרם לצילום ההוכחה: @${subTask.harvest.igHandle}` : "לא נמסרה ידית אינסטגרם"}
          </p>
        </>
      )}

      {/* Main output area */}
      {mode === "view" && (
        <div>
          <AgentOutput
            text={
              subTask.output ||
              (isRunning && !hasMiniDisc
                ? "מתחיל…"
                : isRunning && subTask.currentPhase === "draft"
                  ? "מתחיל טיוטה…"
                  : isRunning && subTask.currentPhase === "critique"
                    ? "ממתין לקונטרות…"
                    : isRunning && subTask.currentPhase === "critic-round"
                      ? "סבב ביקורת…"
                      : isRunning
                        ? "משכתב…"
                        : "")
            }
          />
          {isRunning && (
            <span
              className="inline-block w-[3px] h-4 align-middle mr-1"
              style={{ background: "var(--color-accent)", animation: "pulse 1s ease-in-out infinite" }}
            />
          )}
        </div>
      )}

      {mode === "edit" && (
        <textarea
          value={editedOutput}
          onChange={(e) => setEditedOutput(e.target.value)}
          rows={18}
          className="w-full rounded-md p-3 text-[15px] focus:outline-none"
          style={{
            background: "var(--color-paper)",
            border: "1px solid var(--color-rule)",
            color: "var(--color-ink)",
            fontFamily: "var(--font-heebo), system-ui, sans-serif",
          }}
        />
      )}

      {mode === "feedback" && (
        <textarea
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          rows={5}
          placeholder="מה תרצה שיתוקן?"
          className="w-full rounded-md p-3 text-[15px] focus:outline-none"
          style={{
            background: "var(--color-paper)",
            border: "1px solid var(--color-rule)",
            color: "var(--color-ink)",
          }}
        />
      )}

      {isError && (
        <footer className={`mt-6 grid gap-2 ${isCreativeSubTask ? "grid-cols-2" : "grid-cols-1"}`}>
          <button
            onClick={retry}
            disabled={submitting}
            className="w-full font-medium py-2.5 rounded-md disabled:opacity-40 text-sm"
            style={{ background: "var(--color-accent)", color: "white" }}
          >
            🔁 נסה שוב
          </button>
          {isCreativeSubTask && (
            <button
              onClick={() => setModeSwitchOpen(true)}
              disabled={submitting}
              className="w-full font-medium py-2.5 rounded-md disabled:opacity-40 text-sm"
              style={{ background: "var(--color-paper)", color: "var(--color-ink)", border: "1px solid var(--color-rule)" }}
            >
              🎛️ החלף מצב קריאייטיב
            </button>
          )}
        </footer>
      )}

      {isApproved && mode === "view" && (
        <footer className="mt-6">
          <button
            onClick={reopen}
            disabled={submitting}
            className="text-xs px-3 py-1.5 rounded-md transition-colors disabled:opacity-40"
            style={{
              background: "var(--color-paper)",
              color: "var(--color-ink-muted)",
              border: "1px solid var(--color-rule)",
            }}
          >
            ↺ פתח מחדש
          </button>
        </footer>
      )}

      {isAwaiting && mode === "view" && gateFailed && (
        <p
          className="mt-6 text-sm rounded-md p-3"
          style={{
            background: "rgba(153,27,27,0.05)",
            border: "1px solid rgba(153,27,27,0.3)",
            color: "var(--color-danger)",
          }}
        >
          ⚠ יש חוסמים פתוחים. הפעולה המומלצת היא לתקן.
        </p>
      )}

      {isAwaiting && mode === "view" && (
        <footer
          className={`mt-6 grid gap-2 ${
            gateFailed ? "grid-cols-1" : stageNumber === 8 ? "grid-cols-2" : "grid-cols-3"
          }`}
        >
          <button
            onClick={() => setMode("feedback")}
            className="font-medium py-2.5 rounded-md text-sm"
            style={
              gateFailed
                ? { background: "var(--color-accent)", color: "white" }
                : {
                    background: "var(--color-paper)",
                    color: "var(--color-ink)",
                    border: "1px solid var(--color-rule)",
                  }
            }
          >
            {gateFailed ? "🔧 תקן" : "הגב"}
          </button>
          {!gateFailed && stageNumber !== 8 && (
            <button
              onClick={() => {
                setEditedOutput(subTask.output);
                setMode("edit");
              }}
              className="font-medium py-2.5 rounded-md text-sm"
              style={{
                background: "var(--color-paper)",
                color: "var(--color-ink)",
                border: "1px solid var(--color-rule)",
              }}
            >
              ערוך
            </button>
          )}
          {!gateFailed && (
            <button
              onClick={approve}
              disabled={submitting}
              className="font-medium py-2.5 rounded-md disabled:opacity-40 text-sm"
              style={{ background: "var(--color-accent)", color: "white" }}
            >
              {stageNumber === 9 ? "✓ אשר תוכנית" : "✓ אשר"}
            </button>
          )}
        </footer>
      )}
      {isAwaiting && mode === "view" && isCreativeSubTask && (
        <button
          onClick={() => setModeSwitchOpen(true)}
          className="mt-2 w-full text-xs py-2 rounded-md hover:bg-zinc-50"
          style={{ color: "var(--color-ink-muted)", border: "1px dashed var(--color-rule)" }}
        >
          🎛️ החלף מצב קריאייטיב (מריץ הפקה חדשה ומחליף את הסט)
        </button>
      )}
      {mode === "edit" && (
        <div className="mt-3 grid grid-cols-2 gap-2">
          <button
            onClick={saveEdit}
            disabled={submitting}
            className="font-medium py-2.5 rounded-md disabled:opacity-40 text-sm"
            style={{ background: "var(--color-accent)", color: "white" }}
          >
            שמור והמשך
          </button>
          <button
            onClick={() => setMode("view")}
            className="font-medium py-2.5 rounded-md text-sm"
            style={{
              background: "var(--color-paper)",
              color: "var(--color-ink)",
              border: "1px solid var(--color-rule)",
            }}
          >
            ביטול
          </button>
        </div>
      )}
      {mode === "feedback" && (
        <div className="mt-3 grid grid-cols-2 gap-2">
          <button
            onClick={sendFeedback}
            disabled={submitting}
            className="font-medium py-2.5 rounded-md disabled:opacity-40 text-sm"
            style={{ background: "var(--color-accent)", color: "white" }}
          >
            שלח והרץ שוב
          </button>
          <button
            onClick={() => {
              setMode("view");
              setFeedback("");
            }}
            className="font-medium py-2.5 rounded-md text-sm"
            style={{
              background: "var(--color-paper)",
              color: "var(--color-ink)",
              border: "1px solid var(--color-rule)",
            }}
          >
            ביטול
          </button>
        </div>
      )}

      {isApproved && (
        <button
          onClick={() => setExpanded(false)}
          className="mt-4 text-xs"
          style={{ color: "var(--color-ink-muted)" }}
        >
          קפל
        </button>
      )}
    </section>
  );
}

function StatusBadge({ subTask }: { subTask: SubTask }) {
  const s = subTask.status;
  if (s === "running")
    return (
      <span className="text-xs animate-pulse" style={{ color: "var(--color-accent)" }}>
        ⏳ עובד
      </span>
    );
  if (s === "awaiting-decision")
    return (
      <span className="text-xs font-medium" style={{ color: "var(--color-accent)" }}>
        📋 לבדיקה
      </span>
    );
  if (s === "approved")
    return (
      <span className="text-xs" style={{ color: "var(--color-success)" }}>
        ✓ אושר
      </span>
    );
  if (s === "error")
    return (
      <span className="text-xs" style={{ color: "var(--color-danger)" }}>
        ⚠ שגיאה
      </span>
    );
  return (
    <span className="text-xs" style={{ color: "var(--color-ink-muted)" }}>
      ⏸ ממתין
    </span>
  );
}

function PhaseIndicator({
  phase,
  ownerName,
  critics,
}: {
  phase: SubTaskPhase;
  ownerName: string;
  critics: string[];
}) {
  if (phase === "draft") return <span>שלב 1/3 · {ownerName} כותב טיוטה</span>;
  if (phase === "critique")
    return <span>שלב 2/3 · קונטרות מ-{critics.join(", ")}</span>;
  if (phase === "revise") return <span>שלב 3/3 · {ownerName} משכתב אחרי הקונטרות</span>;
  if (phase === "critic-round") return <span>סבב ביקורת · {ownerName} כותב, {critics.join(", ")} שופט</span>;
  return null;
}


function CreativeModePanel({
  runId,
  stageNumber,
  subTaskId,
  output,
  onCancel,
}: {
  runId: string;
  stageNumber: number;
  subTaskId: string;
  output: string;
  onCancel?: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [uploadNote, setUploadNote] = useState("");

  // תשובת שגיאה לא תמיד JSON (דף 500 של Next, פרוקסי), וכשל fetch לא יכול
  // להשאיר את submitting=true לנצח, אחרת כל הפאנל ננעל עד רענון.
  const errorText = async (res: Response, fallback: string) => {
    try {
      return (await res.json()).error ?? fallback;
    } catch {
      return fallback;
    }
  };

  const chooseMode = async (mode: CreativeMode) => {
    setSubmitting(true);
    try {
      const res = await apiFetch(
        `/api/runs/${runId}/stages/${stageNumber}/subtasks/${subTaskId}/creative-mode`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode }),
        },
      );
      if (!res.ok) alert(await errorText(res, "שגיאה"));
    } catch {
      alert("שגיאת רשת, נסו שוב");
    } finally {
      setSubmitting(false);
    }
  };

  const uploadPhoto = async (file: File | undefined) => {
    if (!file) return;
    setSubmitting(true);
    setUploadNote("מעלה ומנקה מטא-דאטה…");
    try {
      const form = new FormData();
      form.append("photo", file);
      const res = await apiFetch(
        `/api/runs/${runId}/stages/${stageNumber}/subtasks/${subTaskId}/creative-photo`,
        { method: "POST", body: form },
      );
      if (!res.ok) {
        alert(await errorText(res, "שגיאה בהעלאה"));
        setUploadNote("");
      } else {
        const data = await res.json();
        setUploadNote(`✓ ${data.fileName} נוסף לספרייה (${data.photos.length} תמונות). אפשר לבחור מצב.`);
      }
    } catch {
      alert("שגיאת רשת, נסו שוב");
      setUploadNote("");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="rounded-md p-6" style={{ background: "var(--color-surface)", border: "1px solid var(--color-rule)" }}>
      <pre className="whitespace-pre-wrap text-sm mb-5" style={{ color: "var(--color-ink)", fontFamily: "inherit" }}>
        {output}
      </pre>
      <div className="grid grid-cols-2 gap-3 mb-3">
        <button
          onClick={() => chooseMode("typography")}
          disabled={submitting}
          className="font-medium py-3 px-4 rounded-lg transition-colors disabled:opacity-40 text-sm"
          style={{ background: "var(--color-accent)", color: "white" }}
        >
          🖋️ טקסט על התמונה שלי
        </button>
        <button
          onClick={() => chooseMode("ai-variation")}
          disabled={submitting}
          className="font-medium py-3 px-4 rounded-lg transition-colors disabled:opacity-40 text-sm hover:bg-zinc-50"
          style={{ border: "1px solid var(--color-rule-strong)", color: "var(--color-ink)" }}
        >
          🪞 וריאציית AI מהתמונה שלי
        </button>
      </div>
      <label
        className="block text-xs cursor-pointer py-2 px-3 rounded-md hover:bg-zinc-50"
        style={{ border: "1px dashed var(--color-rule-strong)", color: "var(--color-ink-muted)" }}
      >
        📤 העלאת תמונת פרזנטור לספרייה (jpg/png/webp, עד 9MB; מטא-דאטה ומיקום GPS נמחקים אוטומטית)
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp"
          hidden
          disabled={submitting}
          onChange={(e) => uploadPhoto(e.target.files?.[0])}
        />
      </label>
      {uploadNote && (
        <p className="text-xs mt-2" style={{ color: "var(--color-ink-muted)" }}>{uploadNote}</p>
      )}
      {onCancel && (
        <button
          onClick={onCancel}
          disabled={submitting}
          className="mt-3 w-full text-xs py-2 rounded-md hover:bg-zinc-50"
          style={{ color: "var(--color-ink-muted)", border: "1px solid var(--color-rule)" }}
        >
          ביטול, חזרה לכרטיס הרגיל
        </button>
      )}
    </section>
  );
}
