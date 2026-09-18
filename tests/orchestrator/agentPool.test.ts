import { describe, expect, it, vi } from "vitest";
import {
  AgentQuorumError,
  assertAgentQuorum,
  classifyClaudeError,
  runAgentPool,
  type AgentPoolSleep,
  type AgentPoolResult,
} from "@/orchestrator/agentPool";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("runAgentPool", () => {
  it("bounds concurrency and preserves input order when work finishes out of order", async () => {
    const gates = [deferred<string>(), deferred<string>(), deferred<string>(), deferred<string>()];
    const started: number[] = [];
    let active = 0;
    let maximumActive = 0;

    const pending = runAgentPool(
      ["zero", "one", "two", "three"],
      async (_input, { index }) => {
        started.push(index);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        try {
          return await gates[index].promise;
        } finally {
          active -= 1;
        }
      },
      { concurrency: 2 },
    );

    await vi.waitFor(() => expect(started).toEqual([0, 1]));
    gates[1].resolve("result-one");
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2]));
    gates[0].resolve("result-zero");
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2, 3]));
    gates[3].resolve("result-three");
    gates[2].resolve("result-two");

    await expect(pending).resolves.toEqual([
      { ok: true, value: "result-zero", attempts: 1 },
      { ok: true, value: "result-one", attempts: 1 },
      { ok: true, value: "result-two", attempts: 1 },
      { ok: true, value: "result-three", attempts: 1 },
    ]);
    expect(maximumActive).toBe(2);
  });

  it("uses the safe default concurrency of two", async () => {
    const gate = deferred();
    const started: number[] = [];
    const pending = runAgentPool([0, 1, 2], async (_input, { index }) => {
      started.push(index);
      await gate.promise;
      return index;
    });

    await vi.waitFor(() => expect(started).toEqual([0, 1]));
    gate.resolve();
    await pending;
  });

  it("retries only explicit transient failures with bounded injected jitter", async () => {
    const attempts: number[] = [];
    const sleep = vi.fn<AgentPoolSleep>().mockResolvedValue(undefined);
    const jitter = vi.fn((delayMs: number) => delayMs / 2);

    const results = await runAgentPool(
      ["speaker"],
      async (_speaker, context) => {
        attempts.push(context.attempt);
        if (context.attempt < 3) {
          throw Object.assign(new Error("Anthropic rate limited the request"), { status: 429 });
        }
        return "answer";
      },
      {
        retry: {
          maxAttempts: 3,
          baseDelayMs: 100,
          maxDelayMs: 150,
          jitter,
          sleep,
        },
      },
    );

    expect(results).toEqual([{ ok: true, value: "answer", attempts: 3 }]);
    expect(attempts).toEqual([1, 2, 3]);
    expect(jitter.mock.calls.map(([delay]) => delay)).toEqual([100, 150]);
    expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([50, 75]);
  });

  it("does not retry an ordinary Claude CLI failure", async () => {
    const worker = vi.fn(async () => {
      throw new Error("claude -p exited 1: invalid prompt");
    });
    const sleep = vi.fn(async () => {});

    const results = await runAgentPool(["speaker"], worker, {
      retry: { maxAttempts: 4, sleep },
    });

    expect(worker).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
    expect(results[0]).toMatchObject({
      ok: false,
      attempts: 1,
      classification: "permanent",
    });
  });

  it("clamps a custom jitter function to the exponential delay cap", async () => {
    const sleep = vi.fn<AgentPoolSleep>().mockResolvedValue(undefined);
    let attempt = 0;

    await runAgentPool(["speaker"], async () => {
      attempt += 1;
      if (attempt === 1) throw Object.assign(new Error("overloaded"), { status: 529 });
      return "answer";
    }, {
      retry: {
        baseDelayMs: 80,
        maxDelayMs: 100,
        jitter: () => 10_000,
        sleep,
      },
    });

    expect(sleep.mock.calls[0][0]).toBe(80);
  });

  it("never retries an aborted task", async () => {
    const abortError = Object.assign(new Error("agent cancelled"), { name: "AbortError" });
    const worker = vi.fn(async () => {
      throw abortError;
    });

    const results = await runAgentPool(["speaker"], worker, {
      retry: { maxAttempts: 4, sleep: vi.fn(async () => {}) },
    });

    expect(worker).toHaveBeenCalledOnce();
    expect(results).toEqual([{
      ok: false,
      error: abortError,
      attempts: 1,
      classification: "aborted",
    }]);
  });

  it("does not let a custom classifier make an AbortError retryable", async () => {
    const worker = vi.fn(async () => {
      throw Object.assign(new Error("cancelled"), { name: "AbortError" });
    });

    await runAgentPool(["speaker"], worker, {
      retry: {
        maxAttempts: 3,
        classifyError: () => "transient",
        sleep: vi.fn<AgentPoolSleep>().mockResolvedValue(undefined),
      },
    });

    expect(worker).toHaveBeenCalledOnce();
  });

  it("stops queued work and rejects when the caller aborts", async () => {
    const controller = new AbortController();
    const firstAttempt = deferred();
    const reason = new Error("run fenced by watchdog");
    const worker = vi.fn(async () => {
      firstAttempt.resolve();
      throw Object.assign(new Error("overloaded_error"), { status: 529 });
    });

    const pending = runAgentPool([0, 1, 2], worker, {
      concurrency: 1,
      signal: controller.signal,
      retry: { baseDelayMs: 60_000, maxAttempts: 3 },
    });
    await firstAttempt.promise;
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(worker).toHaveBeenCalledOnce();
  });

  it("does not start any work for a pre-aborted signal", async () => {
    const controller = new AbortController();
    const reason = new Error("already stopped");
    controller.abort(reason);
    const worker = vi.fn(async (input: number) => input);

    await expect(runAgentPool([1, 2], worker, { signal: controller.signal })).rejects.toBe(reason);
    expect(worker).not.toHaveBeenCalled();
  });

  it("rejects invalid concurrency instead of hanging", async () => {
    await expect(runAgentPool([1], async value => value, { concurrency: 0 }))
      .rejects.toThrow("concurrency must be a positive integer");
  });
});

describe("classifyClaudeError", () => {
  it.each([
    [Object.assign(new Error("rate limited"), { statusCode: 429 }), "rate-limit"],
    [new Error("claude -p exited 1: rate_limit_error"), "rate-limit"],
    [Object.assign(new Error("backend unavailable"), { status: 503 }), "transient"],
    [Object.assign(new Error("socket reset"), { code: "ECONNRESET" }), "transient"],
    [new Error("claude -p exited 1: overloaded_error"), "transient"],
    [new Error("claude -p exited 1: authentication failed"), "permanent"],
    ["unknown failure", "permanent"],
  ])("classifies %p as %s", (error, expected) => {
    expect(classifyClaudeError(error)).toBe(expected);
  });
});

describe("assertAgentQuorum", () => {
  const failure = new Error("one speaker failed");
  const results: AgentPoolResult<string>[] = [
    { ok: true, value: "first", attempts: 1 },
    { ok: false, error: failure, attempts: 2, classification: "transient" },
    { ok: true, value: "third", attempts: 1 },
  ];

  it("returns successful values in speaker order when the quorum is met", () => {
    expect(assertAgentQuorum(results, 2)).toEqual(["first", "third"]);
  });

  it("throws a diagnostic error when too few speakers succeed", () => {
    expect(() => assertAgentQuorum(results, 3)).toThrow(AgentQuorumError);

    try {
      assertAgentQuorum(results, 3);
    } catch (error) {
      expect(error).toMatchObject({
        name: "AgentQuorumError",
        minimumSuccessful: 3,
        successful: 2,
        total: 3,
      });
      expect((error as AgentQuorumError).failures).toEqual([results[1]]);
    }
  });

  it("rejects a nonsensical minimum", () => {
    expect(() => assertAgentQuorum(results, 0)).toThrow("minimumSuccessful must be a positive integer");
  });
});
