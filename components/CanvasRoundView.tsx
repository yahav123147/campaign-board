"use client";
import { useState } from "react";
import type { AgentMeta, RoundNumber } from "@/types";

const ROUND_TITLES: Record<RoundNumber, string> = {
  1: "סבב 1 — עמדות פתיחה",
  2: "סבב 2 — קונטרות",
  3: "סבב 3 — התכנסות",
};

interface CanvasRoundViewProps {
  round: RoundNumber;
  agents: AgentMeta[];
  contents: Record<string, string>;
  statuses: Record<string, "waiting" | "streaming" | "done" | "error">;
}

export function CanvasRoundView({ round, agents, contents, statuses }: CanvasRoundViewProps) {
  const ordered = [...agents].sort((a, b) => a.order - b.order);
  return (
    <div className="max-w-3xl mx-auto px-8 py-10">
      <header className="mb-10">
        <p className="text-xs font-medium uppercase tracking-wider mb-2" style={{ color: "var(--color-ink-muted)" }}>הבורד</p>
        <h1 className="font-display text-3xl font-medium tracking-tight" style={{ color: "var(--color-ink)" }}>{ROUND_TITLES[round]}</h1>
      </header>
      <div className="space-y-1">
        {ordered.map((a) => (
          <AgentRow key={a.slug} agent={a} status={statuses[a.slug] ?? "waiting"} content={contents[a.slug] ?? ""} />
        ))}
      </div>
    </div>
  );
}

function AgentRow({ agent, status, content }: { agent: AgentMeta; status: "waiting" | "streaming" | "done" | "error"; content: string }) {
  const isStreaming = status === "streaming";
  const isDone = status === "done";
  const [expanded, setExpanded] = useState(false);
  const showExpanded = isStreaming || expanded;
  const preview = content.replace(/\s+/g, " ").trim().slice(0, 90);

  if (status === "waiting") {
    return (
      <div className="flex items-center gap-3 py-2 px-3 text-sm" style={{ color: "var(--color-ink-muted)" }}>
        <span className="w-2 h-2 rounded-full" style={{ background: "var(--color-rule-strong)" }} />
        <span>{agent.name}</span>
        <span className="text-xs">· ממתין</span>
      </div>
    );
  }

  return (
    <div
      className="rounded-md transition-colors"
      style={{ background: showExpanded ? "var(--color-surface)" : "transparent", border: `1px solid ${showExpanded ? "var(--color-rule)" : "transparent"}` }}
    >
      <button
        onClick={() => !isStreaming && setExpanded(!expanded)}
        className="w-full text-right flex items-center gap-3 py-3 px-3"
        disabled={isStreaming}
      >
        <span
          className="w-2 h-2 rounded-full flex-shrink-0"
          style={{
            background: status === "error" ? "var(--color-danger)" : "var(--color-accent)",
            animation: isStreaming ? "pulse 1.5s ease-in-out infinite" : "none",
          }}
        />
        <div className="flex items-baseline gap-2 flex-1 min-w-0">
          <span className="font-medium" style={{ color: "var(--color-ink)" }}>{agent.name}</span>
          <span className="text-xs" style={{ color: "var(--color-ink-muted)" }}>{agent.role}</span>
        </div>
        {!showExpanded && preview && (
          <span className="text-xs truncate max-w-[40%]" style={{ color: "var(--color-ink-muted)" }}>{preview}</span>
        )}
        {isDone && !expanded && <span className="text-xs" style={{ color: "var(--color-success)" }}>✓</span>}
      </button>
      {showExpanded && content && (
        <div className="px-3 pb-4 pt-1">
          <p className="text-[15px] leading-[1.75] whitespace-pre-wrap" style={{ color: "var(--color-ink)" }}>
            {content}
            {isStreaming && <span className="inline-block w-[3px] h-4 align-middle mr-1" style={{ background: "var(--color-accent)", animation: "pulse 1s ease-in-out infinite" }} />}
          </p>
        </div>
      )}
    </div>
  );
}
