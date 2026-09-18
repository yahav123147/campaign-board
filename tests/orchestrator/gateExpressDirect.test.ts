import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Run } from "@/types";
import { eventBus } from "@/orchestrator/eventBus";
import { installExpressGateAutoApprover } from "@/orchestrator/gateAutoApprove";
import { getRun } from "@/orchestrator/runRegistry";
import { CRITIC_UNRESOLVED_MARKER } from "@/orchestrator/copyStandard";
import { initializeStages } from "@/orchestrator/initializeStages";

vi.mock("@/config/clientProfile", () => ({ loadClientProfile: vi.fn(async () => ({ gates: { policy: "express" } })) }));
vi.mock("@/orchestrator/runRegistry", () => ({ getRun: vi.fn() }));

function directRun(id: string): Run {
  return { id, slug: id, brief: "b", createdAt: "2026-09-15T10:00:00.000Z", status: "approved", currentRound: null, messages: [],
    currentStage: 2, assetType: "sales-page", pipeline: "direct", stages: initializeStages("sales-page", "direct") };
}
const fetchMock = vi.fn(async (_url: string, _init?: unknown) => ({ ok: true, status: 200 }));
beforeEach(() => { vi.stubGlobal("fetch", fetchMock); fetchMock.mockClear(); installExpressGateAutoApprover(); });

async function complete(id: string, stageNumber: 1 | 2 | 3, subTaskId: string, content = "פלט") {
  vi.mocked(getRun).mockReturnValue(directRun(id));
  eventBus.emit(id, { type: "subtask-completed", runId: id, stageNumber, subTaskId, content });
  await new Promise((r) => setTimeout(r, 20));
}

describe("express on a direct run", () => {
  it("leaves stage 1 and the final copy (stage 2) to a human", async () => {
    await complete("direct-1", 1, "1"); await complete("direct-2", 2, "2");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("auto-approves a clean design brief and refuses one the critic did not pass", async () => {
    await complete("direct-3", 3, "3");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/runs/direct-3/stages/3/subtasks/3/decide");
    await complete("direct-3b", 3, "3", `${CRITIC_UNRESOLVED_MARKER} 2 סבבים\n\nטקסט`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
