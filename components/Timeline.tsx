"use client";
import type { AgentMeta, Pipeline, Stage } from "@/types";

export type Selection =
  | { kind: "round"; round: 1 | 2 | 3 }
  | { kind: "synthesis" }
  | { kind: "stage"; stageNumber: number };

interface TimelineProps {
  agents: AgentMeta[];
  currentRound: 1 | 2 | 3 | "synthesis" | null;
  roundsComplete: number;
  contentByRound: Record<number, Record<string, string>>;
  agentStatusByRound: Record<number, Record<string, "waiting" | "streaming" | "done" | "error">>;
  hasStrategyDoc: boolean;
  synthesisStreaming: boolean;
  stages: Stage[];
  /** A direct run has no board discussion and no synthesis, so it shows neither. */
  pipeline?: Pipeline;
  selected: Selection | null;
  onSelect: (sel: Selection) => void;
}

export function Timeline(props: TimelineProps) {
  const { agents, currentRound, roundsComplete, agentStatusByRound, hasStrategyDoc, synthesisStreaming, stages, selected, onSelect } = props;

  const isSelected = (sel: Selection) => selected && selected.kind === sel.kind &&
    (sel.kind === "round" ? selected.kind === "round" && selected.round === sel.round :
     sel.kind === "stage" ? selected.kind === "stage" && selected.stageNumber === sel.stageNumber : true);

  return (
    <aside className="overflow-y-auto py-6 px-4 text-sm" style={{ borderInlineStart: "1px solid var(--color-rule)", maxHeight: "calc(100vh - 56px)" }}>
      {props.pipeline !== "direct" && (
        <>
        <Section title="הבורד">
          {[1, 2, 3].map(r => {
            const round = r as 1 | 2 | 3;
            const state: "done" | "active" | "pending" =
              r <= roundsComplete ? "done" : currentRound === r ? "active" : "pending";
            const roundAgents = agents.filter(a => a.slug !== "synthesizer");
            const streamingAgent = state === "active"
              ? roundAgents.find(a => agentStatusByRound[r]?.[a.slug] === "streaming")
              : undefined;
            return (
              <TimelineItem
                key={r}
                label={`סבב ${r}`}
                state={state}
                preview={streamingAgent ? `${streamingAgent.name.split(" ")[0]} מדבר…` : undefined}
                selected={!!isSelected({ kind: "round", round })}
                onClick={() => onSelect({ kind: "round", round })}
              />
            );
          })}
        </Section>

        <Section title="סינתזה">
          <TimelineItem
            label="אסטרטגיה"
            state={hasStrategyDoc ? "done" : synthesisStreaming ? "active" : "pending"}
            selected={!!isSelected({ kind: "synthesis" })}
            onClick={() => onSelect({ kind: "synthesis" })}
          />
        </Section>
        </>
      )}

      {stages.length > 0 && (
        <Section title="שלבים">
          {stages.map(s => {
            const state: "done" | "active" | "pending" | "error" =
              s.status === "approved" ? "done" :
              s.status === "running" || s.status === "awaiting-decision" ? "active" :
              s.status === "error" ? "error" : "pending";
            return (
              <TimelineItem
                key={s.number}
                label={`${s.number}. ${s.title}`}
                state={state}
                selected={!!isSelected({ kind: "stage", stageNumber: s.number })}
                onClick={() => onSelect({ kind: "stage", stageNumber: s.number })}
              />
            );
          })}
        </Section>
      )}
    </aside>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-7">
      <h3 className="text-[11px] font-medium uppercase tracking-wider mb-2" style={{ color: "var(--color-ink-muted)" }}>{title}</h3>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

function TimelineItem({ label, state, preview, selected, onClick }: { label: string; state: "done" | "active" | "pending" | "error"; preview?: string; selected: boolean; onClick: () => void }) {
  const dotStyle =
    state === "done" ? { background: "var(--color-accent)" } :
    state === "active" ? { background: "var(--color-accent)", animation: "pulse 1.5s ease-in-out infinite" } :
    state === "error" ? { background: "var(--color-danger)" } :
    { background: "var(--color-rule-strong)", opacity: 0.5 };

  return (
    <button
      onClick={onClick}
      className="w-full text-right py-1.5 px-2 rounded-md flex items-start gap-2.5 transition-colors hover:bg-zinc-100"
      style={{
        background: selected ? "var(--color-surface)" : "transparent",
        border: selected ? "1px solid var(--color-rule)" : "1px solid transparent",
      }}
    >
      <span className="w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0" style={dotStyle} />
      <div className="flex-1 min-w-0">
        <div className="truncate" style={{ color: state === "pending" ? "var(--color-ink-muted)" : "var(--color-ink)" }}>{label}</div>
        {preview && <div className="text-[11px] mt-0.5 truncate" style={{ color: "var(--color-ink-muted)" }}>{preview}</div>}
      </div>
    </button>
  );
}
