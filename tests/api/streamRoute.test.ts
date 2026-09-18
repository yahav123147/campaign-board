import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Run, SSEEvent } from "@/types";

const { ensureRunLoadedMock } = vi.hoisted(() => ({
  ensureRunLoadedMock: vi.fn(),
}));

vi.mock("@/orchestrator/runRegistry", () => ({
  ensureRunLoaded: ensureRunLoadedMock,
}));

import { GET } from "@/app/api/runs/[id]/stream/route";
import { eventBus } from "@/orchestrator/eventBus";

const RUN_ID = "2026-08-27-stream-test";

function runSnapshot(): Run {
  return {
    id: RUN_ID,
    slug: "stream-test",
    brief: "brief",
    createdAt: "2026-08-27T00:00:00.000Z",
    status: "discussing",
    currentRound: 1,
    messages: [
      {
        agentSlug: "yoni-strategist",
        round: 1,
        content: "snapshot",
        status: "done",
        startedAt: "2026-08-27T00:00:00.000Z",
        completedAt: "2026-08-27T00:00:01.000Z",
      },
    ],
  };
}

function request(signal?: AbortSignal): NextRequest {
  return new NextRequest(`http://127.0.0.1:3000/api/runs/${RUN_ID}/stream`, { signal });
}

async function readEvents(response: Response, count: number): Promise<SSEEvent[]> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const events: SSEEvent[] = [];
  let buffered = "";
  try {
    while (events.length < count) {
      const result = await reader.read();
      if (result.done) break;
      buffered += decoder.decode(result.value, { stream: true });
      const frames = buffered.split("\n\n");
      buffered = frames.pop() ?? "";
      for (const frame of frames) {
        const data = frame.split("\n").find((line) => line.startsWith("data: "));
        if (data) events.push(JSON.parse(data.slice(6)) as SSEEvent);
      }
    }
    return events;
  } finally {
    await reader.cancel();
  }
}

beforeEach(() => {
  ensureRunLoadedMock.mockReset();
  eventBus.removeAllListeners(RUN_ID);
});

afterEach(() => {
  eventBus.removeAllListeners(RUN_ID);
});

describe("run SSE stream", () => {
  it("returns 404 and removes its provisional subscription for a missing run", async () => {
    ensureRunLoadedMock.mockResolvedValue(undefined);

    const response = await GET(request(), { params: Promise.resolve({ id: RUN_ID }) });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Run not found" });
    expect(eventBus.listenerCount(RUN_ID)).toBe(0);
  });

  it("buffers an event emitted during snapshot loading and delivers its token exactly once", async () => {
    let resolveLoad!: (run: Run) => void;
    ensureRunLoadedMock.mockImplementation(() => new Promise<Run>((resolve) => {
      resolveLoad = resolve;
    }));

    const responsePromise = GET(request(), { params: Promise.resolve({ id: RUN_ID }) });
    await vi.waitFor(() => expect(eventBus.listenerCount(RUN_ID)).toBe(1));

    eventBus.emit(RUN_ID, {
      type: "agent-token",
      runId: RUN_ID,
      agentSlug: "roni-creative",
      round: 1,
      token: "only-once",
    });
    resolveLoad(runSnapshot());

    const response = await responsePromise;
    const events = await readEvents(response, 2);

    expect(events.map((event) => event.type)).toEqual(["agent-completed", "agent-token"]);
    expect(events.filter((event) => event.token === "only-once")).toHaveLength(1);
    expect(eventBus.listenerCount(RUN_ID)).toBe(0);
  });

  it("does not replay a stage snapshot already represented by the loaded state", async () => {
    let resolveLoad!: (run: Run) => void;
    ensureRunLoadedMock.mockImplementation(() => new Promise<Run>((resolve) => {
      resolveLoad = resolve;
    }));
    const run = runSnapshot();
    run.stages = [{
      number: 1,
      title: "Stage 1",
      ownerSlug: "yoni-strategist",
      status: "running",
      output: "",
      feedbackHistory: [],
      subTasks: [{ id: "1", title: "Task", status: "running", output: "", feedbackHistory: [] }],
    }];

    const responsePromise = GET(request(), { params: Promise.resolve({ id: RUN_ID }) });
    await vi.waitFor(() => expect(eventBus.listenerCount(RUN_ID)).toBe(1));
    eventBus.emit(RUN_ID, { type: "stages-initialized", runId: RUN_ID, stages: run.stages });
    resolveLoad(run);

    const events = await readEvents(await responsePromise, 2);
    expect(events.map((event) => event.type)).toEqual(["agent-completed", "stages-initialized"]);
  });

  it("fails safely instead of buffering an unbounded event burst during loading", async () => {
    let resolveLoad!: (run: Run) => void;
    ensureRunLoadedMock.mockImplementation(() => new Promise<Run>((resolve) => {
      resolveLoad = resolve;
    }));
    const responsePromise = GET(request(), { params: Promise.resolve({ id: RUN_ID }) });
    await vi.waitFor(() => expect(eventBus.listenerCount(RUN_ID)).toBe(1));
    for (let index = 0; index <= 4_096; index += 1) {
      eventBus.emit(RUN_ID, {
        type: "agent-token",
        runId: RUN_ID,
        agentSlug: "roni-creative",
        round: 1,
        token: String(index),
      });
    }
    resolveLoad(runSnapshot());

    const response = await responsePromise;
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("1");
    expect(eventBus.listenerCount(RUN_ID)).toBe(0);
  });

  it("delivers a live token after the snapshot once and cleans up on cancellation", async () => {
    ensureRunLoadedMock.mockResolvedValue(runSnapshot());
    const response = await GET(request(), { params: Promise.resolve({ id: RUN_ID }) });

    eventBus.emit(RUN_ID, {
      type: "agent-token",
      runId: RUN_ID,
      agentSlug: "roni-creative",
      round: 1,
      token: "live",
    });
    const events = await readEvents(response, 2);

    expect(events.filter((event) => event.token === "live")).toHaveLength(1);
    expect(eventBus.listenerCount(RUN_ID)).toBe(0);
  });

  it("uses the full stage snapshot without replaying approved items as new review events", async () => {
    const run = runSnapshot();
    run.status = "approved";
    run.stages = [{
      number: 1,
      title: "Stage 1",
      ownerSlug: "yoni-strategist",
      status: "approved",
      output: "approved stage",
      feedbackHistory: [],
      subTasks: [{
        id: "1",
        title: "Task",
        status: "approved",
        output: "approved task",
        feedbackHistory: [],
      }],
    }];
    ensureRunLoadedMock.mockResolvedValue(run);

    const response = await GET(request(), { params: Promise.resolve({ id: RUN_ID }) });
    const events = await readEvents(response, 3);

    expect(events.map((event) => event.type)).toEqual([
      "agent-completed",
      "stages-initialized",
      "run-completed",
    ]);
  });
});
