"use client";
import type { CriticRound } from "@/types";

const BADGE: Record<CriticRound["verdict"], { label: string; color: string }> = {
  approve: { label: "עבר", color: "var(--color-accent)" },
  revise: { label: "לתיקון", color: "var(--color-ink-muted)" },
  block: { label: "חסימה", color: "var(--color-danger)" },
  unreadable: { label: "לא הצביע", color: "var(--color-danger)" },
};

export function CriticBoard({ rounds, dimensions, currentRound }: { rounds: CriticRound[]; dimensions: string[]; currentRound?: number }) {
  const columns = [...rounds.map((r) => r.round), ...(currentRound && !rounds.some((r) => r.round === currentRound) ? [currentRound] : [])];
  const byRound = new Map(rounds.map((r) => [r.round, r]));
  const cell = (n: number, pick: (r: CriticRound) => number | undefined) => { const r = byRound.get(n); const v = r ? pick(r) : undefined; return v === undefined ? "…" : String(v); };
  return (
    <div className="mb-4 text-sm rounded p-3" style={{ background: "var(--color-paper)" }}>
      <div className="text-xs font-medium mb-2" style={{ color: "var(--color-ink)" }}>לוח ביקורת</div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-[13px]">
          <thead><tr><th className="text-right py-1 pe-3">ממד</th>{columns.map((n) => <th key={n} className="py-1 px-2 text-center">{byRound.has(n) ? `סבב ${n}` : `סבב ${n} (בביקורת)`}</th>)}</tr></thead>
          <tbody>
            {dimensions.map((d) => <tr key={d}><td className="py-1 pe-3">{d}</td>{columns.map((n) => <td key={n} className="py-1 px-2 text-center">{cell(n, (r) => r.scores?.[d])}</td>)}</tr>)}
            <tr><td className="py-1 pe-3 font-medium">ממוצע</td>{columns.map((n) => <td key={n} className="py-1 px-2 text-center">{cell(n, (r) => r.avg)}</td>)}</tr>
            <tr><td className="py-1 pe-3 font-medium">מינימום</td>{columns.map((n) => <td key={n} className="py-1 px-2 text-center">{cell(n, (r) => r.min)}</td>)}</tr>
            <tr><td className="py-1 pe-3 font-medium">פסק דין</td>{columns.map((n) => { const r = byRound.get(n); return <td key={n} className="py-1 px-2 text-center">{r ? <span style={{ color: BADGE[r.verdict].color }}>{BADGE[r.verdict].label}</span> : "…"}</td>; })}</tr>
          </tbody>
        </table>
      </div>
      {rounds.filter((r) => r.fixes?.length || r.reason).map((r) => (
        <details key={r.round} className="mt-2">
          <summary className="cursor-pointer py-1" style={{ color: "var(--color-ink-muted)" }}>תיקונים מסבב {r.round}{r.reason ? ` (חסימה: ${r.reason})` : ""}</summary>
          <ol className="mt-1 ps-5 space-y-1">{(r.fixes ?? []).map((f, i) => <li key={i}><span style={{ color: "var(--color-ink-muted)" }}>&quot;{f.quote}&quot;</span>, {f.rule}. {f.fix}</li>)}</ol>
        </details>
      ))}
    </div>
  );
}
