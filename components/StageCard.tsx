"use client";
import { useState } from "react";
import type { Stage, AgentMeta } from "@/types";
import { apiFetch } from "@/lib/clientApi";

interface StageCardProps {
  stage: Stage;
  owner?: AgentMeta;
  isStreaming: boolean;
  isCurrent: boolean;
  runId: string;
}

export function StageCard({ stage, owner, isStreaming, runId }: StageCardProps) {
  const [editing, setEditing] = useState(false);
  const [editedOutput, setEditedOutput] = useState(stage.output);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const collapsed = stage.status === "approved" && !editing;

  const approve = async () => {
    setSubmitting(true);
    const res = await apiFetch(`/api/runs/${runId}/stages/${stage.number}/decide`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "approve" }) });
    if (!res.ok) { alert((await res.json()).error ?? "שגיאה"); setSubmitting(false); return; }
    setSubmitting(false);
  };
  const saveEdit = async () => {
    setSubmitting(true);
    const res = await apiFetch(`/api/runs/${runId}/stages/${stage.number}/decide`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "edit", editedOutput }) });
    if (!res.ok) { alert((await res.json()).error ?? "שגיאה"); setSubmitting(false); return; }
    setEditing(false); setSubmitting(false);
  };
  const sendFeedback = async () => {
    if (feedback.trim().length < 5) { alert("המשוב חייב להיות לפחות 5 תווים"); return; }
    setSubmitting(true);
    const res = await apiFetch(`/api/runs/${runId}/stages/${stage.number}/feedback`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ feedback }) });
    if (!res.ok) { alert((await res.json()).error ?? "שגיאה"); setSubmitting(false); return; }
    setFeedback(""); setFeedbackOpen(false); setSubmitting(false);
  };

  if (collapsed) {
    return (
      <div className="border border-zinc-200 rounded-lg p-4 mb-3 flex items-center gap-3 bg-zinc-50/50">
        <div className="text-zinc-900 text-lg">✓</div>
        <div className="flex-1 text-sm"><span className="font-medium text-zinc-700">שלב {stage.number}:</span> <span className="text-zinc-500">{stage.title}</span></div>
        <button onClick={() => setEditing(true)} className="text-zinc-500 text-xs hover:text-zinc-900">הצג</button>
      </div>
    );
  }

  return (
    <section className="border-2 border-zinc-900 rounded-lg p-6 mb-6 bg-white">
      <header className="flex items-center gap-3 mb-4 pb-4 border-b border-zinc-200">
        {owner && (
          <div className="w-10 h-10 rounded-full bg-zinc-900 text-white grid place-items-center text-sm font-semibold">
            {owner.name.charAt(0)}
          </div>
        )}
        <div className="flex-1">
          <h2 className="text-base font-bold text-zinc-900">שלב {stage.number}: {stage.title}</h2>
          <p className="text-xs text-zinc-500">{owner?.name ?? stage.ownerSlug}{owner && ` · ${owner.role}`}</p>
        </div>
        <StatusBadge status={stage.status} isStreaming={isStreaming} />
      </header>

      {stage.status === "running" && !stage.output && <div className="text-zinc-500 text-sm">מתחיל לעבוד…</div>}
      {(stage.status === "running" || stage.status === "awaiting-decision" || stage.status === "approved") && stage.output && !editing && (
        <pre className="whitespace-pre-wrap text-[15px] leading-[1.75] text-zinc-900 mb-5" style={{ fontFamily: "var(--font-heebo), system-ui, sans-serif" }}>
          {stage.output}
          {isStreaming && <span className="inline-block w-2 h-4 bg-zinc-900 animate-pulse align-middle mr-1" />}
        </pre>
      )}
      {editing && (
        <textarea
          value={editedOutput}
          onChange={(e) => setEditedOutput(e.target.value)}
          rows={20}
          className="w-full bg-white border border-zinc-300 rounded-lg p-3 text-zinc-900 text-sm mb-3"
          style={{ fontFamily: "var(--font-heebo), system-ui, sans-serif" }}
        />
      )}
      {stage.status === "error" && <div className="border border-red-300 bg-red-50 rounded-lg p-3 text-red-700 text-sm mb-4">⚠ שגיאה: {stage.errorMessage ?? "ללא"}</div>}

      {stage.status === "awaiting-decision" && !editing && !feedbackOpen && (
        <div className="grid grid-cols-3 gap-2">
          <button onClick={approve} disabled={submitting} className="bg-zinc-900 hover:bg-zinc-800 disabled:opacity-40 text-white font-medium py-3 rounded-lg">✅ אשר</button>
          <button onClick={() => { setEditedOutput(stage.output); setEditing(true); }} disabled={submitting} className="bg-white border border-zinc-300 text-zinc-700 py-3 rounded-lg hover:bg-zinc-50">✏️ ערוך</button>
          <button onClick={() => setFeedbackOpen(true)} disabled={submitting} className="bg-white border border-zinc-300 text-zinc-700 py-3 rounded-lg hover:bg-zinc-50">💬 הגב</button>
        </div>
      )}
      {editing && (
        <div className="flex gap-2 mt-2">
          <button onClick={saveEdit} disabled={submitting} className="flex-1 bg-zinc-900 hover:bg-zinc-800 disabled:opacity-40 text-white font-medium py-3 rounded-lg">💾 שמור והמשך</button>
          <button onClick={() => setEditing(false)} disabled={submitting} className="flex-1 bg-white border border-zinc-300 text-zinc-700 py-3 rounded-lg">ביטול</button>
        </div>
      )}
      {feedbackOpen && (
        <div className="mt-2">
          <textarea value={feedback} onChange={(e) => setFeedback(e.target.value)} placeholder="מה תרצה שיתוקן?" rows={4} className="w-full bg-white border border-zinc-300 rounded-lg p-3 text-zinc-900 text-sm mb-2" />
          <div className="flex gap-2">
            <button onClick={sendFeedback} disabled={submitting} className="flex-1 bg-zinc-900 hover:bg-zinc-800 disabled:opacity-40 text-white font-medium py-3 rounded-lg">שלח והרץ שוב</button>
            <button onClick={() => { setFeedback(""); setFeedbackOpen(false); }} disabled={submitting} className="flex-1 bg-white border border-zinc-300 text-zinc-700 py-3 rounded-lg">ביטול</button>
          </div>
        </div>
      )}
      {stage.feedbackHistory.length > 0 && (
        <details className="mt-4 text-xs text-zinc-500">
          <summary className="cursor-pointer">היסטוריית משוב ({stage.feedbackHistory.length})</summary>
          <ul className="mt-2 space-y-1 mr-4">{stage.feedbackHistory.map((f, i) => <li key={i}>• {f}</li>)}</ul>
        </details>
      )}
    </section>
  );
}

function StatusBadge({ status, isStreaming }: { status: Stage["status"]; isStreaming: boolean }) {
  if (isStreaming || status === "running") return <span className="text-zinc-700 text-xs animate-pulse">⏳ עובד</span>;
  if (status === "awaiting-decision") return <span className="text-zinc-900 text-xs font-medium">📋 לבדיקה</span>;
  if (status === "approved") return <span className="text-zinc-500 text-xs">✓ אושר</span>;
  if (status === "error") return <span className="text-red-600 text-xs">⚠ שגיאה</span>;
  return <span className="text-zinc-400 text-xs">⏸ ממתין</span>;
}
