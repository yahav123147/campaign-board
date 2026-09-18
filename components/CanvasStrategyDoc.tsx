"use client";
import { useState } from "react";
import { useBoardName } from "@/lib/useBoardName";

interface CanvasStrategyDocProps {
  content: string;
  streaming: boolean;
  hasStages: boolean;
  onApprove: () => void;
  onEdit: (next: string) => void;
  onFeedback: (feedback: string) => void;
}

export function CanvasStrategyDoc({ content, streaming, hasStages, onApprove, onEdit, onFeedback }: CanvasStrategyDocProps) {
  const [mode, setMode] = useState<"view" | "edit" | "feedback">("view");
  const [editedDoc, setEditedDoc] = useState(content);
  const [feedback, setFeedback] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const boardName = useBoardName();

  if (!content && !streaming) {
    return <div className="grid place-items-center h-full text-sm" style={{ color: "var(--color-ink-muted)" }}>הסינתסייזר עוד לא התחיל</div>;
  }

  if (mode === "edit") {
    return (
      <div className="max-w-3xl mx-auto px-8 py-10">
        <header className="mb-6">
          <p className="text-xs font-medium uppercase tracking-wider mb-2" style={{ color: "var(--color-ink-muted)" }}>עריכה</p>
          <h1 className="font-display text-3xl font-medium tracking-tight" style={{ color: "var(--color-ink)" }}>ערוך את מסמך האסטרטגיה</h1>
        </header>
        <textarea
          value={editedDoc}
          onChange={(e) => setEditedDoc(e.target.value)}
          rows={28}
          className="w-full rounded-md p-4 text-[15px] leading-[1.75] focus:outline-none"
          style={{ background: "var(--color-surface)", border: "1px solid var(--color-rule)", color: "var(--color-ink)", fontFamily: "var(--font-heebo), system-ui, sans-serif" }}
        />
        <div className="grid grid-cols-2 gap-3 mt-4">
          <button
            onClick={async () => { setSubmitting(true); await onEdit(editedDoc); setSubmitting(false); setMode("view"); }}
            disabled={submitting}
            className="font-medium py-3 rounded-md disabled:opacity-40"
            style={{ background: "var(--color-accent)", color: "white" }}
          >שמור והמשך לשלב 1</button>
          <button onClick={() => setMode("view")} className="font-medium py-3 rounded-md" style={{ background: "var(--color-surface)", color: "var(--color-ink)", border: "1px solid var(--color-rule)" }}>ביטול</button>
        </div>
      </div>
    );
  }

  if (mode === "feedback") {
    return (
      <div className="max-w-3xl mx-auto px-8 py-10">
        <header className="mb-6">
          <p className="text-xs font-medium uppercase tracking-wider mb-2" style={{ color: "var(--color-ink-muted)" }}>משוב לבורד</p>
          <h1 className="font-display text-3xl font-medium tracking-tight" style={{ color: "var(--color-ink)" }}>הגב לדיון</h1>
          <p className="mt-3 text-sm" style={{ color: "var(--color-ink-muted)" }}>הסוכנים יערכו דיון חדש (3 סבבים) עם המשוב שלך כקלט.</p>
        </header>
        <textarea
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          rows={8}
          placeholder="מה תרצה שיתחדד או יתוקן?"
          className="w-full rounded-md p-4 text-[15px] leading-relaxed focus:outline-none"
          style={{ background: "var(--color-surface)", border: "1px solid var(--color-rule)", color: "var(--color-ink)" }}
        />
        <div className="grid grid-cols-2 gap-3 mt-4">
          <button
            onClick={async () => { if (feedback.trim().length < 5) { alert("המשוב חייב להיות לפחות 5 תווים"); return; } setSubmitting(true); await onFeedback(feedback); setSubmitting(false); setMode("view"); setFeedback(""); }}
            disabled={submitting}
            className="font-medium py-3 rounded-md disabled:opacity-40"
            style={{ background: "var(--color-accent)", color: "white" }}
          >שלח למועצה</button>
          <button onClick={() => { setMode("view"); setFeedback(""); }} className="font-medium py-3 rounded-md" style={{ background: "var(--color-surface)", color: "var(--color-ink)", border: "1px solid var(--color-rule)" }}>ביטול</button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto px-8 py-10">
      <header className="mb-8 pb-6" style={{ borderBottom: "1px solid var(--color-rule)" }}>
        <p className="text-xs font-medium uppercase tracking-wider mb-2" style={{ color: "var(--color-ink-muted)" }}>מסמך אסטרטגיה</p>
        <h1 className="font-display text-4xl font-medium tracking-tight" style={{ color: "var(--color-ink)" }}>{boardName}</h1>
      </header>

      <article className="prose-strategy whitespace-pre-wrap text-[16px] leading-[1.85]" style={{ color: "var(--color-ink)", fontFamily: "var(--font-heebo), system-ui, sans-serif" }}>
        {content}
        {streaming && <span className="inline-block w-[3px] h-4 align-middle mr-1" style={{ background: "var(--color-accent)", animation: "pulse 1s ease-in-out infinite" }} />}
      </article>

      {!streaming && content && !hasStages && (
        <footer className="mt-12 pt-8 grid grid-cols-3 gap-3" style={{ borderTop: "1px solid var(--color-rule)" }}>
          <button onClick={async () => { setSubmitting(true); await onApprove(); setSubmitting(false); }} disabled={submitting} className="font-medium py-3 rounded-md disabled:opacity-40" style={{ background: "var(--color-accent)", color: "white" }}>✓ אשר והמשך</button>
          <button onClick={() => { setEditedDoc(content); setMode("edit"); }} className="font-medium py-3 rounded-md" style={{ background: "var(--color-surface)", color: "var(--color-ink)", border: "1px solid var(--color-rule)" }}>ערוך</button>
          <button onClick={() => setMode("feedback")} className="font-medium py-3 rounded-md" style={{ background: "var(--color-surface)", color: "var(--color-ink)", border: "1px solid var(--color-rule)" }}>הגב לדיון</button>
        </footer>
      )}

      {hasStages && (
        <p className="mt-12 text-sm" style={{ color: "var(--color-ink-muted)" }}>האסטרטגיה אושרה. בחר שלב מהציר כדי להמשיך.</p>
      )}
    </div>
  );
}
