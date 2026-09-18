import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Run, SubTask } from "@/types";
import { eventBus } from "@/orchestrator/eventBus";
import { designReviewBlocksExpress, installExpressGateAutoApprover } from "@/orchestrator/gateAutoApprove";
import { getRun } from "@/orchestrator/runRegistry";
import { hashPageSourceManifest } from "@/orchestrator/pagePostflight";

vi.mock("@/config/clientProfile", () => ({
  loadClientProfile: vi.fn(async () => ({ gates: { policy: "express" } })),
}));
vi.mock("@/orchestrator/runRegistry", () => ({ getRun: vi.fn() }));

function run(id: string, build: Partial<SubTask>): Run {
  const startedAt = "2026-09-15T10:00:00.000Z";
  const manifest = "a".repeat(64);
  const pageSourceHashes = { "page.tsx": "b".repeat(64) };
  return {
    id, slug: id, brief: "b", createdAt: "2026-09-15T10:00:00.000Z", status: "approved",
    currentRound: null, messages: [], currentStage: 5, assetType: "sales-page",
    stages: [{
      number: 5, title: "בנייה", ownerSlug: "daniel-lp-designer", status: "running", output: "", feedbackHistory: [],
      subTasks: [
        { id: "5.2", title: "נכסים", status: "approved", output: "", feedbackHistory: [], assetManifestSha256: manifest },
        { id: "5.3", title: "בנייה", status: "awaiting-decision", output: "", feedbackHistory: [],
          startedAt, assetManifestSha256: manifest, pageSourceHashes,
          imageMapCheck: { schemaVersion: 1, passed: true, mappedCount: 0, missing: [], attemptStartedAt: startedAt, assetManifestSha256: manifest, pageSourceManifestSha256: hashPageSourceManifest(pageSourceHashes), checkedAt: startedAt },
          ...build },
      ],
    }],
  } as Run;
}

const review = (passed: boolean, failing: string[] = [], silent: string[] = []) =>
  ({ schemaVersion: 1 as const, passed, failing, silent, checkedAt: "2026-09-15T10:05:00.000Z" });

describe("designReviewBlocksExpress", () => {
  it("חוסם 5.3 בלי תוצאת ביקורת, עם חוסמים, או עם מבקר שלא הצביע; מאשר רק מעבר מלא", () => {
    expect(designReviewBlocksExpress(run("a", {}), 5, "5.3")).toMatch(/ביקורת עיצוב/);
    expect(designReviewBlocksExpress(run("b", { designReview: review(false, ["רוני"]) }), 5, "5.3")).toMatch(/חוסמים/);
    expect(designReviewBlocksExpress(run("c", { designReview: review(false, [], ["אורי"]) }), 5, "5.3")).toMatch(/אורי לא הצביע/);
    expect(designReviewBlocksExpress(run("d", { designReview: review(true) }), 5, "5.3")).toBeNull();
    expect(designReviewBlocksExpress(run("e", {}), 4, "4a")).toBeNull();
  });
});

describe("the express listener on 5.3 completion", () => {
  const fetchMock = vi.fn(async (_url: string, _init?: unknown) => ({ ok: true, status: 200 }));
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockClear();
    installExpressGateAutoApprover();
  });

  async function complete(r: Run): Promise<void> {
    vi.mocked(getRun).mockReturnValue(r);
    eventBus.emit(r.id, { type: "subtask-completed", runId: r.id, stageNumber: 5, subTaskId: "5.3", content: "דף" });
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  it("לא שולח בקשת אישור כשמבקר לא הצביע", async () => {
    await complete(run("silent-run", { designReview: review(false, [], ["אורי"]) }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("לא שולח בקשת אישור כשנשארו חוסמים", async () => {
    await complete(run("blockers-run", { designReview: review(false, ["רוני"]) }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("שולח בקשת אישור כשכל המבקרים עברו", async () => {
    await complete(run("pass-run", { designReview: review(true) }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/runs/pass-run/stages/5/subtasks/5.3/decide");
  });
});
