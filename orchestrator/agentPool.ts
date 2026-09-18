export const DEFAULT_AGENT_POOL_CONCURRENCY = 2;

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 1_000;
const DEFAULT_MAX_DELAY_MS = 15_000;

export type ClaudeErrorClassification =
  | "aborted"
  | "rate-limit"
  | "transient"
  | "permanent";

export interface AgentPoolWorkerContext {
  /** Original input position. Results use this same order. */
  index: number;
  /** One-based attempt number for this input. */
  attempt: number;
  /** Shared cancellation signal supplied by the caller. */
  signal: AbortSignal;
}

export type AgentPoolWorker<TInput, TOutput> = (
  input: TInput,
  context: AgentPoolWorkerContext,
) => Promise<TOutput>;

export interface AgentPoolSuccess<T> {
  ok: true;
  value: T;
  attempts: number;
}

export interface AgentPoolFailure {
  ok: false;
  error: unknown;
  attempts: number;
  classification: ClaudeErrorClassification;
}

export type AgentPoolResult<T> = AgentPoolSuccess<T> | AgentPoolFailure;

export interface AgentRetryContext {
  index: number;
  attempt: number;
  error: unknown;
  classification: "rate-limit" | "transient";
}

export type AgentPoolJitter = (
  maximumDelayMs: number,
  context: AgentRetryContext,
) => number;

export type AgentPoolSleep = (delayMs: number, signal: AbortSignal) => Promise<void>;

export interface AgentPoolRetryOptions {
  /** Total attempts, including the first call. */
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Receives the capped exponential delay and must return the desired delay. */
  jitter?: AgentPoolJitter;
  /** Injectable for deterministic tests. Production uses an abortable timer. */
  sleep?: AgentPoolSleep;
  classifyError?: (error: unknown) => ClaudeErrorClassification;
}

export interface AgentPoolOptions {
  concurrency?: number;
  signal?: AbortSignal;
  retry?: AgentPoolRetryOptions;
}

interface ErrorShape {
  name?: unknown;
  message?: unknown;
  code?: unknown;
  status?: unknown;
  statusCode?: unknown;
  cause?: unknown;
}

function isErrorShape(error: unknown): error is ErrorShape {
  return typeof error === "object" && error !== null;
}

function numericStatus(error: ErrorShape): number | undefined {
  for (const candidate of [error.status, error.statusCode]) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
    if (typeof candidate === "string" && /^\d{3}$/.test(candidate)) return Number(candidate);
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (isErrorShape(error) && typeof error.message === "string") return error.message;
  return typeof error === "string" ? error : "";
}

function errorCode(error: unknown): string {
  return isErrorShape(error) && typeof error.code === "string" ? error.code.toUpperCase() : "";
}

/**
 * Classifies only explicit Claude/API/network signals as retryable. An unknown
 * exit from `claude -p` stays permanent, so this pool never turns a prompt,
 * auth, permission, or local setup failure into a retry storm.
 */
export function classifyClaudeError(error: unknown): ClaudeErrorClassification {
  let current: unknown = error;

  // Inspect a short cause chain because Node fetch errors often keep their
  // network code on `cause`. A cycle or an opaque value remains permanent.
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 4 && !seen.has(current); depth += 1) {
    seen.add(current);
    const shape = isErrorShape(current) ? current : undefined;
    const name = typeof shape?.name === "string" ? shape.name : "";
    const code = errorCode(current);
    const message = errorMessage(current);
    const status = shape ? numericStatus(shape) : undefined;

    if (
      name === "AbortError"
      || code === "ABORT_ERR"
      || /\b(?:execution|request|operation)\s+(?:was\s+)?aborted\b/i.test(message)
    ) {
      return "aborted";
    }

    if (
      status === 429
      || /\b(?:rate[_ -]?limit(?:ed|_error)?|too many requests)\b/i.test(message)
      || /\b(?:http|status(?: code)?)\s*429\b/i.test(message)
    ) {
      return "rate-limit";
    }

    if (
      status === 408
      || status === 500
      || status === 502
      || status === 503
      || status === 504
      || status === 529
      || [
        "ECONNRESET",
        "EPIPE",
        "ETIMEDOUT",
        "EAI_AGAIN",
        "ENETDOWN",
        "ENETUNREACH",
        "UND_ERR_CONNECT_TIMEOUT",
        "UND_ERR_HEADERS_TIMEOUT",
        "UND_ERR_SOCKET",
      ].includes(code)
      || /\b(?:overloaded_error|internal_server_error|temporarily unavailable)\b/i.test(message)
      || /\b(?:http|status(?: code)?)\s*(?:408|500|502|503|504|529)\b/i.test(message)
    ) {
      return "transient";
    }

    if (!shape || shape.cause === undefined) break;
    current = shape.cause;
  }

  return "permanent";
}

function abortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  const error = new Error("Agent pool was aborted");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

const defaultJitter: AgentPoolJitter = maximumDelayMs => Math.random() * maximumDelayMs;

const defaultSleep: AgentPoolSleep = (delayMs, signal) => {
  throwIfAborted(signal);
  if (delayMs <= 0) return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
};

interface NormalizedRetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitter: AgentPoolJitter;
  sleep: AgentPoolSleep;
  classifyError: (error: unknown) => ClaudeErrorClassification;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive integer`);
  }
  return value;
}

function nonNegativeFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative finite number`);
  }
  return value;
}

function normalizeRetryOptions(options: AgentPoolRetryOptions = {}): NormalizedRetryOptions {
  const maxAttempts = positiveInteger(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS, "maxAttempts");
  const baseDelayMs = nonNegativeFinite(options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS, "baseDelayMs");
  const maxDelayMs = nonNegativeFinite(options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS, "maxDelayMs");

  return {
    maxAttempts,
    baseDelayMs,
    maxDelayMs,
    jitter: options.jitter ?? defaultJitter,
    sleep: options.sleep ?? defaultSleep,
    classifyError: options.classifyError ?? classifyClaudeError,
  };
}

function cappedExponentialDelay(
  baseDelayMs: number,
  maxDelayMs: number,
  failedAttempt: number,
): number {
  if (baseDelayMs === 0 || maxDelayMs === 0) return 0;
  // Avoid overflowing before applying the configured upper bound.
  const exponent = Math.min(failedAttempt - 1, 52);
  return Math.min(maxDelayMs, baseDelayMs * (2 ** exponent));
}

function boundedJitterDelay(
  retry: NormalizedRetryOptions,
  context: AgentRetryContext,
): number {
  const cap = cappedExponentialDelay(retry.baseDelayMs, retry.maxDelayMs, context.attempt);
  const proposed = retry.jitter(cap, context);
  if (!Number.isFinite(proposed)) return cap;
  return Math.max(0, Math.min(cap, proposed));
}

async function runOne<TInput, TOutput>(
  input: TInput,
  index: number,
  worker: AgentPoolWorker<TInput, TOutput>,
  signal: AbortSignal,
  retry: NormalizedRetryOptions,
): Promise<AgentPoolResult<TOutput>> {
  for (let attempt = 1; attempt <= retry.maxAttempts; attempt += 1) {
    throwIfAborted(signal);
    try {
      const value = await worker(input, { index, attempt, signal });
      throwIfAborted(signal);
      return { ok: true, value, attempts: attempt };
    } catch (error) {
      // Caller cancellation ends the whole pool. A task-local AbortError is a
      // settled failure, but is never retried.
      throwIfAborted(signal);
      const baseClassification = classifyClaudeError(error);
      const classification = baseClassification === "aborted"
        ? "aborted"
        : retry.classifyError(error);
      const retryable = classification === "rate-limit" || classification === "transient";
      if (!retryable || attempt === retry.maxAttempts) {
        return { ok: false, error, attempts: attempt, classification };
      }

      const context: AgentRetryContext = { index, attempt, error, classification };
      const delayMs = boundedJitterDelay(retry, context);
      await retry.sleep(delayMs, signal);
    }
  }

  // normalizeRetryOptions guarantees at least one attempt.
  throw new Error("Agent pool reached an unreachable retry state");
}

/**
 * Runs the same worker against every input with bounded concurrency. Each
 * transient retry invokes that same worker again; there is deliberately no
 * alternate provider or paid API fallback.
 */
export async function runAgentPool<TInput, TOutput>(
  inputs: readonly TInput[],
  worker: AgentPoolWorker<TInput, TOutput>,
  options: AgentPoolOptions = {},
): Promise<AgentPoolResult<TOutput>[]> {
  const concurrency = positiveInteger(
    options.concurrency ?? DEFAULT_AGENT_POOL_CONCURRENCY,
    "concurrency",
  );
  const retry = normalizeRetryOptions(options.retry);
  const signal = options.signal ?? new AbortController().signal;
  throwIfAborted(signal);

  if (inputs.length === 0) return [];

  const results = new Array<AgentPoolResult<TOutput>>(inputs.length);
  let cursor = 0;
  const laneCount = Math.min(concurrency, inputs.length);

  const lane = async () => {
    while (true) {
      throwIfAborted(signal);
      const index = cursor;
      if (index >= inputs.length) return;
      cursor += 1;
      results[index] = await runOne(inputs[index], index, worker, signal, retry);
    }
  };

  await Promise.all(Array.from({ length: laneCount }, () => lane()));
  throwIfAborted(signal);
  return results;
}

export class AgentQuorumError extends Error {
  readonly name = "AgentQuorumError";

  constructor(
    readonly minimumSuccessful: number,
    readonly successful: number,
    readonly total: number,
    readonly failures: readonly AgentPoolFailure[],
  ) {
    super(
      `Agent quorum not met: ${successful}/${total} succeeded; `
      + `at least ${minimumSuccessful} required`,
    );
  }
}

/**
 * Enforces the synthesis gate and returns successful values in input order.
 */
export function assertAgentQuorum<T>(
  results: readonly AgentPoolResult<T>[],
  minimumSuccessful: number,
): T[] {
  positiveInteger(minimumSuccessful, "minimumSuccessful");
  const successes: T[] = [];
  const failures: AgentPoolFailure[] = [];

  for (const result of results) {
    if (result.ok) successes.push(result.value);
    else failures.push(result);
  }

  if (successes.length < minimumSuccessful) {
    throw new AgentQuorumError(
      minimumSuccessful,
      successes.length,
      results.length,
      failures,
    );
  }
  return successes;
}
