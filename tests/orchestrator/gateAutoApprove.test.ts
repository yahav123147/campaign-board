import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ImageMapCheck, Run, SubTask } from "@/types";
import { hashPageSourceManifest } from "@/orchestrator/pagePostflight";
import { approveViaRoute, expressApproval, expressAutoApproveViolation } from "@/orchestrator/gateAutoApprove";

const startedAt = "2026-09-13T10:00:00.000Z";
const manifest = "a".repeat(64);
const sources = { "page.tsx": "1".repeat(64) };

function check(overrides: Partial<ImageMapCheck> = {}): ImageMapCheck {
  return {
    schemaVersion: 1, passed: true, mappedCount: 2, missing: [],
    attemptStartedAt: startedAt, assetManifestSha256: manifest,
    pageSourceManifestSha256: hashPageSourceManifest(sources), checkedAt: startedAt,
    ...overrides,
  };
}

function run(build: Partial<SubTask> = {}, assetsManifest = manifest): Run {
  return {
    id: "express", slug: "express", brief: "brief", createdAt: startedAt, status: "approved",
    currentRound: null, messages: [], currentStage: 5,
    stages: [{
      number: 5, title: "5", ownerSlug: "daniel-lp-designer", status: "running", output: "", feedbackHistory: [],
      subTasks: [
        { id: "5.2", title: "assets", status: "approved", output: "", feedbackHistory: [], assetManifestSha256: assetsManifest },
        {
          id: "5.3", title: "build", status: "awaiting-decision", output: "", feedbackHistory: [],
          startedAt, assetManifestSha256: manifest, pageSourceHashes: sources, imageMapCheck: check(),
          designReview: { schemaVersion: 1, passed: true, failing: [], silent: [], checkedAt: startedAt },
          ...build,
        },
      ],
    }],
  } as Run;
}

describe("expressAutoApproveViolation", () => {
  it("does not affect any gate other than 5.3", () => {
    expect(expressAutoApproveViolation(undefined, 4, "4a")).toBeNull();
    expect(expressAutoApproveViolation(undefined, 5, "5.1")).toBeNull();
  });

  it("allows 5.3 only with a passing, current check", () => {
    expect(expressAutoApproveViolation(run(), 5, "5.3")).toBeNull();
  });

  it("requires a passing design review even when the image map passed", () => {
    expect(expressAutoApproveViolation(run({ designReview: undefined }), 5, "5.3")).toMatch(/ביקורת עיצוב/);
    expect(expressAutoApproveViolation(run({ designReview: { schemaVersion: 1, passed: false, failing: [], silent: ["אורי"], checkedAt: startedAt } }), 5, "5.3")).toMatch(/לא הצביע/);
    expect(expressAutoApproveViolation(run({ designReview: { schemaVersion: 1, passed: false, failing: ["רוני"], silent: [], checkedAt: startedAt } }), 5, "5.3")).toMatch(/חוסמים/);
  });

  it("leaves 5.3 to a human when the check failed, is missing or is stale", () => {
    expect(expressAutoApproveViolation(run({ imageMapCheck: check({ passed: false, missing: [{ file: "hero.webp", section: "Hero", proves: "x", widths: [390] }] }) }), 5, "5.3")).not.toBeNull();
    expect(expressAutoApproveViolation(run({ imageMapCheck: undefined }), 5, "5.3")).not.toBeNull();
    expect(expressAutoApproveViolation(run({ startedAt: "2026-09-13T11:00:00.000Z" }), 5, "5.3")).not.toBeNull();
    expect(expressAutoApproveViolation(run({ pageSourceHashes: { "page.tsx": "2".repeat(64) } }), 5, "5.3")).not.toBeNull();
    expect(expressAutoApproveViolation(run({}, "c".repeat(64)), 5, "5.3")).not.toBeNull();
    expect(expressAutoApproveViolation(run({ status: "running" }), 5, "5.3")).not.toBeNull();
  });
});

describe("approveViaRoute", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("re-checks eligibility before every retry and stops when the result changed", async () => {
    fetchMock.mockResolvedValue(new Response("busy", { status: 409 }));
    let eligible = true;
    const pending = approveViaRoute("http://127.0.0.1:4321/decide", "run:5:5.3", () => (eligible ? null : "stale"));

    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    eligible = false;
    await vi.advanceTimersByTimeAsync(2_500);
    await pending;

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never posts when the gate is not eligible to begin with", async () => {
    await approveViaRoute("http://127.0.0.1:4321/decide", "run:5:5.3", () => "failed");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("re-checks design review before retrying a passing image map approval", async () => {
    fetchMock.mockResolvedValue(new Response("busy", { status: 409 }));
    const current = run();
    const pending = approveViaRoute("http://127.0.0.1:4321/decide", "run:5:5.3", () => expressApproval(current, 5, "5.3"));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    current.stages![0].subTasks[1].designReview = { schemaVersion: 1, passed: false, failing: [], silent: ["אורי"], checkedAt: startedAt };
    await vi.advanceTimersByTimeAsync(2_500);
    await pending;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("binds the 5.3 express POST to the image map check it just evaluated", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    const checkedAt = "2026-09-13T10:07:00.000Z";
    const current = run({ imageMapCheck: check({ checkedAt }) });
    await approveViaRoute("http://127.0.0.1:4321/decide", "run:5:5.3", () => expressApproval(current, 5, "5.3"));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      action: "approve",
      expressImageMapCheck: { attemptStartedAt: startedAt, checkedAt },
    });
  });

  it("posts exactly { action: approve } for every other gate", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    await approveViaRoute("http://127.0.0.1:4321/decide", "run:4:4a", () => expressApproval(run(), 4, "4a"));
    await approveViaRoute("http://127.0.0.1:4321/decide", "run:5:5.1", () => expressApproval(run(), 5, "5.1"));
    await approveViaRoute("http://127.0.0.1:4321/decide", "run:synthesis");

    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const call of fetchMock.mock.calls) expect(call[1].body).toBe(JSON.stringify({ action: "approve" }));
  });

  it("never posts a 5.3 binding when the check is not eligible", async () => {
    await approveViaRoute("http://127.0.0.1:4321/decide", "run:5:5.3", () =>
      expressApproval(run({ imageMapCheck: check({ passed: false, missing: [{ file: "hero.webp", section: "Hero", proves: "x", widths: [390] }] }) }), 5, "5.3"));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts once when eligible and the route accepts", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    await approveViaRoute("http://127.0.0.1:4321/decide", "run:5:5.3", () => null);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
