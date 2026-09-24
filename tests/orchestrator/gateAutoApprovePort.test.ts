import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/config/clientProfile", () => ({
  loadClientProfile: vi.fn(async () => ({ gates: { policy: "express" } })),
}));
vi.mock("@/orchestrator/runRegistry", () => ({ getRun: vi.fn() }));
vi.mock("@/orchestrator/eventBus", () => ({ eventBus: { onAny: vi.fn() } }));

describe("express approval port", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.stubGlobal("__councilExpressGatesInstalled", false);
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each([
    { configured: "4500", expected: "4500" },
    { configured: undefined, expected: "3000" },
  ])("posts to port $expected with a matching Origin", async ({ configured, expected }) => {
    vi.stubEnv("PORT", configured);
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { installExpressGateAutoApprover } = await import("@/orchestrator/gateAutoApprove");
    const { eventBus } = await import("@/orchestrator/eventBus");
    installExpressGateAutoApprover();
    const listener = vi.mocked(eventBus.onAny).mock.calls.at(-1)![0];
    listener({ type: "synthesis-completed", runId: "custom-port-run", content: "approved strategy" });
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      `http://127.0.0.1:${expected}/api/runs/custom-port-run/decide`,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Origin: `http://127.0.0.1:${expected}` }),
        body: JSON.stringify({ action: "approve" }),
      }),
    );
  });
});
