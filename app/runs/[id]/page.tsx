"use client";
import { use, useEffect, useReducer, useState, useMemo } from "react";
import { ProgressBar } from "@/components/ProgressBar";
import { Timeline, type Selection } from "@/components/Timeline";
import { Canvas } from "@/components/Canvas";
import { subscribeToRun } from "@/lib/sse-client";
import { apiFetch } from "@/lib/clientApi";
import { initialRunPageState, runPageReducer } from "@/lib/runPageReducer";
import type { AgentMeta } from "@/types";

export default function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [state, dispatch] = useReducer(runPageReducer, initialRunPageState);
  const [agentsLoaded, setAgentsLoaded] = useState(false);
  const [pinnedSelection, setPinnedSelection] = useState<Selection | null>(null);

  useEffect(() => {
    fetch("/api/agents")
      .then(r => r.json())
      .then((agents: AgentMeta[]) => { dispatch({ type: "set-agents", agents }); setAgentsLoaded(true); })
      .catch(() => { dispatch({ type: "set-agents", agents: [] }); setAgentsLoaded(true); });
  }, []);

  useEffect(() => {
    if (!agentsLoaded) return;
    const unsub = subscribeToRun(id, (e) => dispatch(e));
    return unsub;
  }, [id, agentsLoaded]);

  const roundsComplete = useMemo(() => {
    let count = 0;
    for (const r of [1, 2, 3] as const) {
      const statuses = state.agentStatusByRound[r];
      if (!statuses) continue;
      const speakers = state.agents.filter(a => a.slug !== "synthesizer");
      if (speakers.length > 0 && speakers.every(a => statuses[a.slug] === "done" || statuses[a.slug] === "error")) {
        count++;
      }
    }
    return count;
  }, [state.agentStatusByRound, state.agents]);

  // Auto-derive selection if not pinned
  const autoSelection: Selection | null = useMemo(() => {
    // Latest active thing wins.
    if (state.currentStageNumber) return { kind: "stage", stageNumber: state.currentStageNumber };
    if (state.stages.length > 0) {
      const firstPending = state.stages.find(s => s.status !== "approved");
      if (firstPending) return { kind: "stage", stageNumber: firstPending.number };
    }
    if (state.synthesisStreaming || state.strategyDoc) return { kind: "synthesis" };
    if (state.currentRound && state.currentRound !== "synthesis") return { kind: "round", round: state.currentRound };
    if (roundsComplete > 0) return { kind: "round", round: roundsComplete as 1 | 2 | 3 };
    if (state.currentRound === "synthesis") return { kind: "synthesis" };
    if (state.agents.length > 0) return { kind: "round", round: 1 };
    return null;
  }, [state.currentStageNumber, state.stages, state.synthesisStreaming, state.strategyDoc, state.currentRound, roundsComplete, state.agents.length]);

  const selection = pinnedSelection ?? autoSelection;

  const approveStrategy = async () => {
    const res = await apiFetch(`/api/runs/${id}/decide`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "approve" }) });
    if (!res.ok) alert((await res.json()).error ?? "שגיאה");
  };
  const editStrategy = async (next: string) => {
    const res = await apiFetch(`/api/runs/${id}/decide`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "approve", editedStrategy: next }) });
    if (!res.ok) alert((await res.json()).error ?? "שגיאה");
  };
  const feedbackStrategy = async (fb: string) => {
    const res = await apiFetch(`/api/runs/${id}/feedback`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ feedback: fb }) });
    if (!res.ok) alert((await res.json()).error ?? "שגיאה");
  };

  return (
    <>
      <ProgressBar
        currentRound={state.currentRound}
        roundsComplete={roundsComplete}
        hasStrategyDoc={!!state.strategyDoc && !state.synthesisStreaming}
        stages={state.stages}
      />
      {state.error && (
        <div className="max-w-7xl mx-auto px-6 mt-4 rounded-md p-3 text-sm" style={{ background: "rgba(153, 27, 27, 0.05)", border: "1px solid rgba(153, 27, 27, 0.3)", color: "var(--color-danger)" }}>⚠ {state.error}</div>
      )}
      <main className="max-w-7xl mx-auto grid h-[calc(100vh-56px)]" style={{ gridTemplateColumns: "70fr 30fr" }}>
        <section className="overflow-y-auto">
          <Canvas
            selection={selection}
            agents={state.agents}
            contentByRound={state.contentByRound}
            agentStatusByRound={state.agentStatusByRound}
            strategyDoc={state.strategyDoc}
            synthesisStreaming={state.synthesisStreaming}
            stages={state.stages}
            stageStreaming={state.stageStreaming}
            runId={id}
            hasStrategyDoc={!!state.strategyDoc && !state.synthesisStreaming}
            onApproveStrategy={approveStrategy}
            onEditStrategy={editStrategy}
            onFeedbackStrategy={feedbackStrategy}
          />
        </section>
        <Timeline
          agents={state.agents}
          currentRound={state.currentRound}
          roundsComplete={roundsComplete}
          contentByRound={state.contentByRound}
          agentStatusByRound={state.agentStatusByRound}
          hasStrategyDoc={!!state.strategyDoc && !state.synthesisStreaming}
          synthesisStreaming={state.synthesisStreaming}
          stages={state.stages}
          pipeline={state.pipeline}
          selected={selection}
          onSelect={(sel) => setPinnedSelection(sel)}
        />
      </main>
    </>
  );
}
