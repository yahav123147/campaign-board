import { completedStageState, stageSnapshotState } from "@/lib/runPageStageState";
import type { AgentMeta, Pipeline, RoundNumber, SSEEvent, Stage, StageNumber } from "@/types";

export type AgentStatus = "waiting" | "streaming" | "done" | "error";

export interface State {
  agents: AgentMeta[];
  agentStatusByRound: Record<number, Record<string, AgentStatus>>;
  contentByRound: Record<number, Record<string, string>>;
  currentRound: RoundNumber | "synthesis" | null;
  strategyDoc: string;
  synthesisStreaming: boolean;
  error: string | null;
  stages: Stage[];
  currentStageNumber: StageNumber | null;
  stageStreaming: Record<number, boolean>;
  /** Which pipeline this run is, learned from the stage snapshot event. */
  pipeline?: Pipeline;
}

export const initialRunPageState: State = {
  agents: [],
  agentStatusByRound: { 1: {}, 2: {}, 3: {} },
  contentByRound: { 1: {}, 2: {}, 3: {} },
  currentRound: null,
  strategyDoc: "",
  synthesisStreaming: false,
  error: null,
  stages: [],
  currentStageNumber: null,
  stageStreaming: {},
};

export type Action = SSEEvent | { type: "set-agents"; agents: AgentMeta[] };

export function runPageReducer(state: State, action: Action): State {
  switch (action.type) {
    case "set-agents":
      return { ...state, agents: action.agents };
    case "round-started": {
      if (action.round === 1 && state.strategyDoc) {
        return {
          ...state, currentRound: 1, strategyDoc: "", synthesisStreaming: false,
          agentStatusByRound: { 1: {}, 2: {}, 3: {} }, contentByRound: { 1: {}, 2: {}, 3: {} },
        };
      }
      return { ...state, currentRound: action.round ?? null };
    }
    case "agent-started": {
      const r = action.round as number;
      const prev = state.agentStatusByRound[r] ?? {};
      return { ...state, agentStatusByRound: { ...state.agentStatusByRound, [r]: { ...prev, [action.agentSlug!]: "streaming" } } };
    }
    case "agent-token": {
      const r = action.round as number;
      const prevContent = state.contentByRound[r] ?? {};
      const prevStatus = state.agentStatusByRound[r] ?? {};
      const cur = prevContent[action.agentSlug!] ?? "";
      const currentStatus = prevStatus[action.agentSlug!] ?? "waiting";
      const nextStatus: AgentStatus = currentStatus === "done" || currentStatus === "error" ? currentStatus : "streaming";
      return {
        ...state,
        contentByRound: { ...state.contentByRound, [r]: { ...prevContent, [action.agentSlug!]: cur + (action.token ?? "") } },
        agentStatusByRound: { ...state.agentStatusByRound, [r]: { ...prevStatus, [action.agentSlug!]: nextStatus } },
      };
    }
    case "agent-completed": {
      const r = action.round as number;
      const prev = state.agentStatusByRound[r] ?? {};
      const status: AgentStatus = action.errorMessage ? "error" : "done";
      const newContent = action.content ?? state.contentByRound[r]?.[action.agentSlug!] ?? "";
      return {
        ...state,
        agentStatusByRound: { ...state.agentStatusByRound, [r]: { ...prev, [action.agentSlug!]: status } },
        contentByRound: { ...state.contentByRound, [r]: { ...state.contentByRound[r], [action.agentSlug!]: newContent } },
      };
    }
    case "synthesis-started":
      return { ...state, currentRound: "synthesis", synthesisStreaming: true };
    case "synthesis-token":
      return { ...state, strategyDoc: state.strategyDoc + (action.token ?? "") };
    case "synthesis-completed":
      return { ...state, synthesisStreaming: false, strategyDoc: action.content ?? state.strategyDoc, currentRound: null };
    case "run-completed":
      return state;
    case "stages-initialized": {
      const { stages, currentStageNumber } = stageSnapshotState(action.stages ?? []);
      return { ...state, stages, currentStageNumber, ...(action.pipeline ? { pipeline: action.pipeline } : {}) };
    }
    case "stage-started": {
      const n = action.stageNumber!;
      const stages = state.stages.map(s => s.number === n ? { ...s, status: "running" as const, output: "" } : s);
      return { ...state, stages, currentStageNumber: n, stageStreaming: { ...state.stageStreaming, [n]: true } };
    }
    case "stage-token": {
      const n = action.stageNumber!;
      const stages = state.stages.map(s => s.number === n ? { ...s, output: s.output + (action.token ?? "") } : s);
      return { ...state, stages };
    }
    case "stage-completed": {
      const n = action.stageNumber!;
      const { stages, currentStageNumber } = completedStageState(state.stages, n, action.content);
      return { ...state, stages, currentStageNumber, stageStreaming: { ...state.stageStreaming, [n]: false } };
    }
    case "stage-error": {
      const n = action.stageNumber!;
      const stages = state.stages.map(s => s.number === n ? { ...s, status: "error" as const, errorMessage: action.errorMessage } : s);
      return { ...state, stages, stageStreaming: { ...state.stageStreaming, [n]: false } };
    }
    case "stage-skipped": {
      const n = action.stageNumber!;
      const stages = state.stages.map(s =>
        s.number === n
          ? {
              ...s,
              status: "approved" as const,
              output: action.content ?? "Skipped",
              subTasks: s.subTasks.map(st => ({ ...st, status: "approved" as const, output: action.content ?? "Skipped" })),
            }
          : s,
      );
      return { ...state, stages };
    }
    case "subtask-started": {
      const n = action.stageNumber!;
      const subId = action.subTaskId!;
      const stages = state.stages.map(s =>
        s.number === n
          ? {
              ...s,
              currentSubTaskId: subId,
              subTasks: s.subTasks.map(st =>
                st.id === subId
                  ? { ...st, status: "running" as const, output: "", draftOutput: undefined, critiques: undefined, currentPhase: undefined, criticRounds: undefined, criticRound: undefined, harvest: undefined }
                  : st,
              ),
            }
          : s,
      );
      return { ...state, stages, stageStreaming: { ...state.stageStreaming, [n]: true } };
    }
    case "subtask-phase-changed": {
      const n = action.stageNumber!;
      const subId = action.subTaskId!;
      const phase = action.phase!;
      const stages = state.stages.map(s =>
        s.number === n
          ? {
              ...s,
              subTasks: s.subTasks.map(st =>
                st.id === subId
                  ? { ...st, currentPhase: phase, output: phase === "revise" ? "" : st.output }
                  : st,
              ),
            }
          : s,
      );
      return { ...state, stages };
    }
    case "subtask-token": {
      const n = action.stageNumber!;
      const subId = action.subTaskId!;
      const stages = state.stages.map(s =>
        s.number === n
          ? {
              ...s,
              subTasks: s.subTasks.map(st =>
                st.id === subId ? { ...st, output: st.output + (action.token ?? "") } : st,
              ),
            }
          : s,
      );
      return { ...state, stages };
    }
    case "subtask-completed": {
      const n = action.stageNumber!;
      const subId = action.subTaskId!;
      const stages = state.stages.map(s =>
        s.number === n
          ? {
              ...s,
              subTasks: s.subTasks.map(st =>
                st.id === subId
                  ? { ...st, status: "awaiting-decision" as const, output: action.content ?? st.output, currentPhase: undefined, ...(action.harvest ? { harvest: action.harvest } : {}) }
                  : st,
              ),
            }
          : s,
      );
      return { ...state, stages, stageStreaming: { ...state.stageStreaming, [n]: false } };
    }
    case "subtask-error": {
      const n = action.stageNumber!;
      const subId = action.subTaskId!;
      const stages = state.stages.map(s =>
        s.number === n
          ? {
              ...s,
              subTasks: s.subTasks.map(st =>
                st.id === subId ? { ...st, status: "error" as const, errorMessage: action.errorMessage } : st,
              ),
            }
          : s,
      );
      return { ...state, stages, stageStreaming: { ...state.stageStreaming, [n]: false } };
    }
    case "critique-started": {
      const n = action.stageNumber!;
      const subId = action.subTaskId!;
      const criticSlug = action.criticSlug!;
      const stages = state.stages.map(s =>
        s.number === n
          ? {
              ...s,
              subTasks: s.subTasks.map(st => {
                if (st.id !== subId) return st;
                const critiques = st.critiques ?? [];
                if (critiques.find(c => c.agentSlug === criticSlug)) return st;
                return { ...st, critiques: [...critiques, { agentSlug: criticSlug, content: "", status: "streaming" as const }] };
              }),
            }
          : s,
      );
      return { ...state, stages };
    }
    case "critique-token": {
      const n = action.stageNumber!;
      const subId = action.subTaskId!;
      const criticSlug = action.criticSlug!;
      const stages = state.stages.map(s =>
        s.number === n
          ? {
              ...s,
              subTasks: s.subTasks.map(st => {
                if (st.id !== subId) return st;
                const critiques = (st.critiques ?? []).map(c =>
                  c.agentSlug === criticSlug ? { ...c, content: c.content + (action.token ?? "") } : c,
                );
                return { ...st, critiques };
              }),
            }
          : s,
      );
      return { ...state, stages };
    }
    case "critique-completed": {
      const n = action.stageNumber!;
      const subId = action.subTaskId!;
      const criticSlug = action.criticSlug!;
      const stages = state.stages.map(s =>
        s.number === n
          ? {
              ...s,
              subTasks: s.subTasks.map(st => {
                if (st.id !== subId) return st;
                const critiques = (st.critiques ?? []).map(c =>
                  c.agentSlug === criticSlug
                    ? {
                        ...c,
                        content: action.content ?? c.content,
                        status: action.errorMessage ? ("error" as const) : ("done" as const),
                        errorMessage: action.errorMessage,
                      }
                    : c,
                );
                return { ...st, critiques };
              }),
            }
          : s,
      );
      return { ...state, stages };
    }
    case "critic-round-started": {
      const n = action.stageNumber!, subId = action.subTaskId!;
      return { ...state, stages: state.stages.map(s => s.number === n
        ? { ...s, subTasks: s.subTasks.map(st => st.id === subId ? { ...st, criticRound: action.criticRoundNumber, currentPhase: "critic-round" as const, output: "" } : st) }
        : s) };
    }
    case "critic-round-completed": {
      const n = action.stageNumber!, subId = action.subTaskId!, entry = action.criticRound!;
      return { ...state, stages: state.stages.map(s => s.number === n
        ? { ...s, subTasks: s.subTasks.map(st => st.id === subId
            ? { ...st, criticRounds: [...(st.criticRounds ?? []).filter(r => r.round !== entry.round), entry] }
            : st) }
        : s) };
    }
    case "error":
      return { ...state, error: action.errorMessage ?? "שגיאה לא ידועה" };
    default:
      return state;
  }
}
