"use client";

import { useEffect, useState } from "react";

type Width = 390 | 1280;

/**
 * The built page, inside the board. Approving a design means looking at it, and
 * a link to another tab is a link people do not click.
 */
export function PagePreview({ runId }: { runId: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [up, setUp] = useState(false);
  const [builtAt, setBuiltAt] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [width, setWidth] = useState<Width>(390);
  const [nonce, setNonce] = useState(0);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/runs/${runId}/preview`);
        const data = await res.json();
        if (cancelled) return;
        setUrl(data.url ?? null);
        setUp(Boolean(data.up));
        setBuiltAt(data.builtAt ?? null);
        setStale(Boolean(data.stale));
      } catch {
        if (!cancelled) setUp(false);
      } finally {
        if (!cancelled) setChecking(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // `nonce` re-checks whether the preview server came up since last look.
  }, [runId, nonce]);

  const refresh = () => {
    setChecking(true);
    setNonce((n) => n + 1);
  };

  return (
    <section
      className="mt-8 rounded-md overflow-hidden"
      style={{ border: "1px solid var(--color-rule)", background: "var(--color-surface)" }}
    >
      <header
        className="flex items-center gap-2 px-4 py-2.5 text-sm"
        style={{ borderBottom: "1px solid var(--color-rule)", color: "var(--color-ink-muted)" }}
      >
        <span style={{ color: "var(--color-ink)" }}>הדף</span>
        {builtAt && (
          <span className="text-xs">
            נבנה {new Date(builtAt).toLocaleString("he-IL", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
          </span>
        )}

        <div className="flex gap-1 mr-auto">
          {([390, 1280] as Width[]).map((w) => (
            <button
              key={w}
              onClick={() => setWidth(w)}
              className="text-xs px-2.5 py-1 rounded"
              style={
                width === w
                  ? { background: "var(--color-accent)", color: "white" }
                  : { background: "var(--color-paper)", color: "var(--color-ink-muted)", border: "1px solid var(--color-rule)" }
              }
            >
              {w === 390 ? "מובייל" : "דסקטופ"}
            </button>
          ))}
          <button
            onClick={refresh}
            className="text-xs px-2.5 py-1 rounded"
            style={{ background: "var(--color-paper)", color: "var(--color-ink-muted)", border: "1px solid var(--color-rule)" }}
          >
            ↻ רענן
          </button>
          {url && (
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="text-xs px-2.5 py-1 rounded"
              style={{ background: "var(--color-paper)", color: "var(--color-ink-muted)", border: "1px solid var(--color-rule)" }}
            >
              ↗ בטאב
            </a>
          )}
        </div>
      </header>

      {stale && (
        <p
          className="px-4 py-2.5 text-xs"
          style={{ background: "rgba(153,27,27,0.05)", color: "var(--color-danger)", borderBottom: "1px solid var(--color-rule)" }}
        >
          ⚠ זו הגרסה מהבנייה הקודמת. תת-משימת הבנייה עוד לא רצה מחדש, אז מה שמוצג כאן לא כולל את מה שאושר בשלב הזה.
        </p>
      )}

      {up && url ? (
        <div className="flex justify-center p-4" style={{ background: "var(--color-paper)" }}>
          <iframe
            key={`${width}-${nonce}`}
            src={url}
            title="תצוגת הדף"
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            style={{
              width: width === 390 ? 390 : "100%",
              maxWidth: "100%",
              height: 620,
              border: "1px solid var(--color-rule)",
              borderRadius: 6,
              background: "#fff",
            }}
          />
        </div>
      ) : (
        <p className="px-4 py-6 text-sm" style={{ color: "var(--color-ink-muted)" }}>
          {checking
            ? "בודק אם הדף מוגש…"
            : "הדף לא מוגש כרגע. הוא עולה בתת-משימה של התצוגה המקומית, ואפשר להריץ אותה שוב כדי להעלות אותו."}
        </p>
      )}
    </section>
  );
}
