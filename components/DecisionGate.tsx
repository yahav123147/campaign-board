"use client";
import { useState } from "react";
import { apiFetch } from "@/lib/clientApi";
import { strategyEditNote } from "@/lib/runPageStageState";

interface DecisionGateProps {
  runId: string;
  strategyDoc: string;
  /** How many stages this run will have: nine for most page types, five for an upsell. */
  stageCount: number;
}

export function DecisionGate({ runId, strategyDoc, stageCount }: DecisionGateProps) {
  const [submitting, setSubmitting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editedDoc, setEditedDoc] = useState(strategyDoc);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedback, setFeedback] = useState("");

  const approve = async (overrideStrategy?: string) => {
    setSubmitting(true);
    const res = await apiFetch(`/api/runs/${runId}/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "approve", editedStrategy: overrideStrategy }),
    });
    if (!res.ok) { alert((await res.json()).error ?? "שגיאה"); setSubmitting(false); return; }
    // The stages-initialized event will fire and the UI will re-render.
  };

  const sendFeedback = async () => {
    if (feedback.trim().length < 5) { alert("המשוב חייב להיות לפחות 5 תווים"); return; }
    setSubmitting(true);
    const res = await apiFetch(`/api/runs/${runId}/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ feedback }),
    });
    if (!res.ok) { alert((await res.json()).error ?? "שגיאה"); setSubmitting(false); return; }
    setFeedback("");
    setFeedbackOpen(false);
    setSubmitting(false);
  };

  if (editing) {
    return (
      <section className="border-t border-zinc-200 pt-8 mb-12">
        <p className="text-zinc-600 text-sm mb-3">{strategyEditNote(stageCount)}</p>
        <textarea
          value={editedDoc}
          onChange={(e) => setEditedDoc(e.target.value)}
          rows={20}
          className="w-full bg-white border border-zinc-300 rounded-lg p-4 text-zinc-900 text-sm mb-3"
          style={{ fontFamily: "var(--font-heebo), system-ui, sans-serif" }}
        />
        <div className="grid grid-cols-2 gap-3">
          <button onClick={() => approve(editedDoc)} disabled={submitting} className="bg-zinc-900 hover:bg-zinc-800 disabled:opacity-40 text-white font-medium py-3 rounded-lg">שמור והמשך לשלב 1</button>
          <button onClick={() => setEditing(false)} disabled={submitting} className="bg-white border border-zinc-300 text-zinc-700 py-3 rounded-lg hover:bg-zinc-50">ביטול</button>
        </div>
      </section>
    );
  }

  if (feedbackOpen) {
    return (
      <section className="border-t border-zinc-200 pt-8 mb-12">
        <p className="text-zinc-600 text-sm mb-3">דעתך תועבר למועצה והסוכנים יערכו דיון חדש (3 סבבים נוספים) עם המשוב שלך.</p>
        <textarea
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          rows={6}
          placeholder="מה תרצה שיתחדד או יתוקן באסטרטגיה?"
          className="w-full bg-white border border-zinc-300 rounded-lg p-4 text-zinc-900 text-sm mb-3"
        />
        <div className="grid grid-cols-2 gap-3">
          <button onClick={sendFeedback} disabled={submitting} className="bg-zinc-900 hover:bg-zinc-800 disabled:opacity-40 text-white font-medium py-3 rounded-lg">שלח למועצה לדיון נוסף</button>
          <button onClick={() => { setFeedback(""); setFeedbackOpen(false); }} disabled={submitting} className="bg-white border border-zinc-300 text-zinc-700 py-3 rounded-lg hover:bg-zinc-50">ביטול</button>
        </div>
      </section>
    );
  }

  return (
    <section className="border-t border-zinc-200 pt-8 mb-12">
      <p className="text-zinc-500 text-sm mb-4 text-center">ההחלטה שלך</p>
      <div className="grid grid-cols-3 gap-3">
        <button onClick={() => approve()} disabled={submitting} className="bg-zinc-900 hover:bg-zinc-800 disabled:opacity-40 text-white font-medium py-3 rounded-lg">✅ אשר והמשך</button>
        <button onClick={() => { setEditedDoc(strategyDoc); setEditing(true); }} disabled={submitting} className="bg-white border border-zinc-300 text-zinc-700 py-3 rounded-lg hover:bg-zinc-50">✏️ ערוך</button>
        <button onClick={() => setFeedbackOpen(true)} disabled={submitting} className="bg-white border border-zinc-300 text-zinc-700 py-3 rounded-lg hover:bg-zinc-50">💬 הגב לדיון</button>
      </div>
    </section>
  );
}
