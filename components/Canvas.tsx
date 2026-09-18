"use client";
import type { AgentMeta, Stage } from "@/types";
import type { Selection } from "./Timeline";
import { CanvasRoundView } from "./CanvasRoundView";
import { CanvasStrategyDoc } from "./CanvasStrategyDoc";
import { CanvasStage } from "./CanvasStage";

interface CanvasProps {
  selection: Selection | null;
  agents: AgentMeta[];
  contentByRound: Record<number, Record<string, string>>;
  agentStatusByRound: Record<number, Record<string, "waiting" | "streaming" | "done" | "error">>;
  strategyDoc: string;
  synthesisStreaming: boolean;
  stages: Stage[];
  stageStreaming: Record<number, boolean>;
  runId: string;
  hasStrategyDoc: boolean;
  onApproveStrategy: () => void;
  onEditStrategy: (next: string) => void;
  onFeedbackStrategy: (feedback: string) => void;
}

export function Canvas(props: CanvasProps) {
  const sel = props.selection;

  if (!sel) {
    return <Empty>בחר פריט מהציר מימין כדי להתחיל</Empty>;
  }

  if (sel.kind === "round") {
    return (
      <CanvasRoundView
        round={sel.round}
        agents={props.agents.filter(a => a.slug !== "synthesizer")}
        contents={props.contentByRound[sel.round] ?? {}}
        statuses={props.agentStatusByRound[sel.round] ?? {}}
      />
    );
  }

  if (sel.kind === "synthesis") {
    return (
      <CanvasStrategyDoc
        content={props.strategyDoc}
        streaming={props.synthesisStreaming}
        hasStages={props.stages.length > 0}
        onApprove={props.onApproveStrategy}
        onEdit={props.onEditStrategy}
        onFeedback={props.onFeedbackStrategy}
      />
    );
  }

  if (sel.kind === "stage") {
    const stage = props.stages.find(s => s.number === sel.stageNumber);
    if (!stage) return <Empty>שלב לא נמצא</Empty>;
    const owner = props.agents.find(a => a.slug === stage.ownerSlug);
    return (
      <CanvasStage
        stage={stage}
        stages={props.stages}
        owner={owner}
        agents={props.agents}
        isStreaming={props.stageStreaming[stage.number] ?? false}
        runId={props.runId}
      />
    );
  }

  return <Empty>מצב לא ידוע</Empty>;
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid place-items-center h-full text-sm" style={{ color: "var(--color-ink-muted)" }}>{children}</div>
  );
}
