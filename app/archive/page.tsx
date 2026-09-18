"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

interface RunSummary {
  id: string;
  brief: string;
  createdAt: string;
  status: string;
  currentStage: number | null;
  stagesApproved: number;
  stagesTotal: number;
  hasState: boolean;
  stateError?: string;
}

const STATUS_LABEL: Record<string, string> = {
  pending: "ממתין",
  discussing: "בדיון",
  synthesizing: "בסיכום",
  "awaiting-decision": "ממתין להחלטה",
  approved: "הושלם",
  error: "נעצר",
};

function formatDate(id: string, createdAt: string): string {
  // Run ids are timestamps: YYYY-MM-DD-HHMM
  const m = id.match(/^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})$/);
  if (m) return `${m[3]}.${m[2]}.${m[1]} · ${m[4]}:${m[5]}`;
  if (!createdAt) return id;
  const d = new Date(createdAt);
  return Number.isNaN(d.getTime()) ? id : d.toLocaleString("he-IL");
}

function firstLine(brief: string): string {
  const line = brief.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  return line.length > 110 ? `${line.slice(0, 110)}…` : line;
}

export default function ArchivePage() {
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/runs")
      .then((res) => res.json())
      .then((data) => setRuns(data.runs ?? []))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  return (
    <div className="max-w-3xl mx-auto px-6 py-16">
      <header className="mb-10">
        <Link href="/" className="text-sm hover:underline" style={{ color: "var(--color-ink-muted)" }}>
          → חזרה לבורד
        </Link>
        <h1
          className="font-display text-3xl font-medium tracking-tight mt-4 mb-2"
          style={{ color: "var(--color-ink)" }}
        >
          ארכיון הריצות
        </h1>
        <p className="text-sm" style={{ color: "var(--color-ink-muted)" }}>
          כל מה שהבורד עבד עליו נשמר כאן. גם אחרי שהשרת מופעל מחדש.
        </p>
      </header>

      {error && (
        <p className="text-sm" style={{ color: "var(--color-danger)" }}>
          שגיאה בטעינת הארכיון: {error}
        </p>
      )}

      {!runs && !error && (
        <p className="text-sm" style={{ color: "var(--color-ink-muted)" }}>
          טוען…
        </p>
      )}

      {runs?.length === 0 && (
        <p className="text-sm" style={{ color: "var(--color-ink-muted)" }}>
          עוד אין ריצות שמורות.
        </p>
      )}

      <ul className="space-y-3">
        {runs?.map((run) => (
          <li key={run.id}>
            <Link
              href={`/runs/${run.id}`}
              className="block rounded-md p-5 transition-colors hover:bg-[var(--color-paper)]"
              style={{ background: "var(--color-surface)", border: "1px solid var(--color-rule)" }}
            >
              <div className="flex items-baseline justify-between gap-4 mb-2">
                <span className="text-sm font-medium" style={{ color: "var(--color-ink)" }}>
                  {formatDate(run.id, run.createdAt)}
                </span>
                <span
                  className="text-xs shrink-0"
                  style={{
                    color:
                      run.status === "error"
                        ? "var(--color-danger)"
                        : run.status === "approved"
                          ? "var(--color-success)"
                          : "var(--color-ink-muted)",
                  }}
                >
                  {STATUS_LABEL[run.status] ?? run.status}
                  {run.stagesTotal > 0 && ` · ${run.stagesApproved}/${run.stagesTotal} שלבים`}
                </span>
              </div>

              <p className="text-[15px] leading-relaxed" style={{ color: "var(--color-ink)" }}>
                {firstLine(run.brief)}
              </p>

              {!run.hasState && (
                <p className="mt-2 text-xs" style={{ color: "var(--color-ink-muted)" }}>
                  ריצה ישנה: הקבצים שמורים, מצב השלבים לא נשמר בזמנו
                </p>
              )}
              {run.stateError && (
                <p className="mt-2 text-xs" style={{ color: "var(--color-danger)" }}>
                  {run.stateError}
                </p>
              )}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
