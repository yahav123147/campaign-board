import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Run } from "@/types";
import { eventBus } from "@/orchestrator/eventBus";
import { installExpressGateAutoApprover } from "@/orchestrator/gateAutoApprove";
import { getRun } from "@/orchestrator/runRegistry";
import { hashPageSourceManifest } from "@/orchestrator/pagePostflight";

vi.mock("@/config/clientProfile", () => ({
  loadClientProfile: vi.fn(async () => ({ gates: { policy: "express" } })),
}));
vi.mock("@/orchestrator/runRegistry", () => ({ getRun: vi.fn() }));

/**
 * Fix round 1 (F-Task2-1): the express retry loop used to close over a single
 * `gateRun` snapshot taken once when the `subtask-completed` event fired, so
 * every retry re-evaluated eligibility against that same stale object instead
 * of re-reading the run. This run builder is eligible on 5.3 (design review
 * passed, image map current) both times it is built; only `checkedAt`
 * differs, so a passing second POST whose body carries the SECOND
 * `checkedAt` can only happen if the closure called `getRun` again on retry.
 */
function run(checkedAt: string): Run {
  const startedAt = "2026-09-15T10:00:00.000Z";
  const manifest = "a".repeat(64);
  const pageSourceHashes = { "page.tsx": "b".repeat(64) };
  return {
    id: "retry-run", slug: "retry-run", brief: "b", createdAt: startedAt, status: "approved",
    currentRound: null, messages: [], currentStage: 5, assetType: "sales-page",
    stages: [{
      number: 5, title: "בנייה", ownerSlug: "daniel-lp-designer", status: "running", output: "", feedbackHistory: [],
      subTasks: [
        { id: "5.2", title: "נכסים", status: "approved", output: "", feedbackHistory: [], assetManifestSha256: manifest },
        {
          id: "5.3", title: "בנייה", status: "awaiting-decision", output: "", feedbackHistory: [],
          startedAt, assetManifestSha256: manifest, pageSourceHashes,
          imageMapCheck: {
            schemaVersion: 1, passed: true, mappedCount: 0, missing: [],
            attemptStartedAt: startedAt, assetManifestSha256: manifest,
            pageSourceManifestSha256: hashPageSourceManifest(pageSourceHashes), checkedAt,
          },
          designReview: { schemaVersion: 1, passed: true, failing: [], silent: [], checkedAt: startedAt },
        },
      ],
    }],
  } as Run;
}

describe("the express retry loop re-reads the run on every attempt", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    vi.mocked(getRun).mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    installExpressGateAutoApprover();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("sends the second attempt's body from a fresh read, not the frozen event-time snapshot", async () => {
    const firstCheckedAt = "2026-09-15T10:00:05.000Z";
    const secondCheckedAt = "2026-09-15T10:05:00.000Z";
    // Call 1: the synchronous subtask-completed handler's gateRun read.
    // Call 2: approveViaRoute attempt 1's eligibility read.
    // Call 3: approveViaRoute attempt 2's eligibility read, after the retry delay.
    vi.mocked(getRun)
      .mockReturnValueOnce(run(firstCheckedAt))
      .mockReturnValueOnce(run(firstCheckedAt))
      .mockReturnValue(run(secondCheckedAt));

    // Per the file's own doc comment: "the runner that produced the gate is
    // still unwinding its execution claim right after the event fires, so
    // the first attempts may see 409." Attempt 1 is blocked at the route;
    // attempt 2, after a fresh read, is accepted.
    fetchMock.mockResolvedValueOnce(new Response("busy", { status: 409 }));
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 200 }));

    eventBus.emit("retry-run", {
      type: "subtask-completed", runId: "retry-run", stageNumber: 5, subTaskId: "5.3", content: "דף",
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2_500); // RETRY_DELAY_MS
    expect(fetchMock).toHaveBeenCalledTimes(2);

    expect(getRun).toHaveBeenCalledTimes(3);
    const secondBody = JSON.parse((fetchMock.mock.calls[1]![1] as { body: string }).body);
    expect(secondBody.expressImageMapCheck.checkedAt).toBe(secondCheckedAt);
  });
});
