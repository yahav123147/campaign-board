"use client";
import Link from "next/link";
import type { Stage, RoundNumber } from "@/types";
import { stageProgressDots } from "@/lib/runPageStageState";
import { useBoardName } from "@/lib/useBoardName";

interface ProgressBarProps {
  currentRound: RoundNumber | "synthesis" | null;
  roundsComplete: number; // 0..3
  hasStrategyDoc: boolean;
  stages: Stage[];
}

export function ProgressBar({ currentRound, roundsComplete, hasStrategyDoc, stages }: ProgressBarProps) {
  const boardName = useBoardName();
  const discussionDots = [1, 2, 3].map(r => ({
    state: r <= roundsComplete ? "done" : currentRound === r ? "active" : "pending",
  }));
  const strategyDot = hasStrategyDoc ? "done" : currentRound === "synthesis" ? "active" : "pending";
  // One dot per stage this run actually has. Before the strategy is approved
  // the run has no stages yet, so the section is simply empty.
  const stageDots = stageProgressDots(stages);

  return (
    <div
      className="sticky top-0 z-10 backdrop-blur-md"
      style={{ background: "rgba(250, 250, 249, 0.85)", borderBottom: "1px solid var(--color-rule)" }}
    >
      <div className="max-w-7xl mx-auto px-6 py-3 flex items-center gap-6 text-xs" style={{ color: "var(--color-ink-muted)" }}>
        <Link href="/" className="font-display text-sm hover:underline" style={{ color: "var(--color-ink)" }}>{boardName}</Link>
        <Section label="דיון" dots={discussionDots.map(d => d.state as "done" | "active" | "pending")} />
        <Section label="אסטרטגיה" dots={[strategyDot as "done" | "active" | "pending"]} />
        <Section label="שלבים" dots={stageDots} />
        <nav className="ms-auto flex items-center gap-4">
          <Link href="/archive" className="hover:underline">ארכיון</Link>
          <Link
            href="/"
            className="font-medium px-3 py-1.5 rounded-md transition-colors"
            style={{ background: "var(--color-accent)", color: "white" }}
          >
            + מהלך חדש
          </Link>
        </nav>
      </div>
    </div>
  );
}

function Section({ label, dots }: { label: string; dots: ("done" | "active" | "pending")[] }) {
  return (
    <div className="flex items-center gap-2">
      <span>{label}</span>
      <div className="flex items-center gap-1">
        {dots.map((d, i) => (
          <span
            key={i}
            className="w-1.5 h-1.5 rounded-full transition-colors"
            style={{
              background: d === "done" ? "var(--color-accent)" : d === "active" ? "var(--color-accent)" : "var(--color-rule-strong)",
              opacity: d === "active" ? 1 : d === "done" ? 1 : 0.5,
              animation: d === "active" ? "pulse 1.5s ease-in-out infinite" : "none",
            }}
          />
        ))}
      </div>
    </div>
  );
}
