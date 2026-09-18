import type { StageNumber } from "@/types";
import { runInExecutionContext } from "./executionContext";
import {
  ExecutionFencedError,
  ExecutionManager,
  executionTargetKey,
  type ClaimResult,
  type ExecutionClaimIntent,
  type ExecutionPolicy,
  type ExecutionTarget,
  type WatchdogTickResult,
} from "./executionManager";
import { RunExecutionAdapter } from "./runExecutionAdapter";

export interface ExecutionControl {
  attemptId: string;
  signal: AbortSignal;
  /**
   * The whole budget this attempt was claimed with, in milliseconds. The
   * executor needs it because the agent it spawns has a timer of its own:
   * without this the agent fell back to spawnAgent's 60 minute default and was
   * killed mid-task inside a 90 minute execution, which is exactly how the
   * 5.2 acceptance run lost four of its eight screens.
   */
  timeoutMs: number;
  heartbeat(): Promise<void>;
  throwIfAborted(): void;
}

/**
 * What the executor keeps for itself after the agent exits: rendering the
 * mockups, validating the folder, writing the receipt. The agent's own timer
 * is the budget minus this, so a run that reaches its limit still produces a
 * judged attempt rather than a killed process and nothing else.
 */
export const AGENT_TIMEOUT_MARGIN_MS = 15 * 60_000;
/** Below this an agent cannot do useful work, so the margin gives way instead. */
export const MIN_AGENT_TIMEOUT_MS = 30 * 60_000;

/**
 * The timer to hand `spawnAgent` for a turn running inside this execution.
 * Undefined when there is no execution at all (a direct call in a test, a
 * script), and spawnAgent keeps its own default there.
 */
export function agentTimeoutMs(control?: Pick<ExecutionControl, "timeoutMs">): number | undefined {
  const budget = control?.timeoutMs;
  if (typeof budget !== "number" || !Number.isFinite(budget) || budget <= 0) return undefined;
  return Math.max(MIN_AGENT_TIMEOUT_MS, Math.round(budget - AGENT_TIMEOUT_MARGIN_MS));
}

export type ManagedExecutionOperation = (control: ExecutionControl) => Promise<void>;

export type StartManagedExecutionResult =
  | {
      ok: true;
      attemptId: string;
      completion: Promise<void>;
    }
  | Extract<ClaimResult, { ok: false }>;

interface ExecutionServiceOptions {
  policyForTarget?: (target: ExecutionTarget) => ExecutionPolicy;
  onBackgroundError?: (target: ExecutionTarget, error: unknown) => void;
}

function positiveEnvMs(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function defaultPolicyForTarget(target: ExecutionTarget): ExecutionPolicy {
  const configuredTimeout = positiveEnvMs("EXECUTION_TIMEOUT_MS");
  const configuredLease = positiveEnvMs("EXECUTION_LEASE_MS");
  let timeoutMs = configuredTimeout ?? 60 * 60_000;

  if (target.kind === "run") timeoutMs = configuredTimeout ?? 2 * 60 * 60_000;
  if (target.kind === "subtask" && target.stageNumber === 5) {
    timeoutMs = configuredTimeout ?? (target.subTaskId === "5.3" ? 2 * 60 * 60_000 : 90 * 60_000);
  }

  return {
    leaseMs: configuredLease ?? 90_000,
    timeoutMs,
    retrySafety:
      target.kind === "subtask" && target.stageNumber === 9
        ? "review-required"
        : "safe",
  };
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("Execution was aborted");
}

/**
 * Claims work durably before returning to an API route, then runs it in a
 * fenced async context. The completion promise is exposed for tests and
 * orderly callers; routes may safely leave it in the background.
 */
export class ExecutionService {
  private readonly policyForTarget: (target: ExecutionTarget) => ExecutionPolicy;
  private readonly onBackgroundError: (target: ExecutionTarget, error: unknown) => void;

  constructor(
    readonly manager: ExecutionManager,
    options: ExecutionServiceOptions = {},
  ) {
    this.policyForTarget = options.policyForTarget ?? defaultPolicyForTarget;
    this.onBackgroundError = options.onBackgroundError ?? ((target, error) => {
      console.error(`[execution ${executionTargetKey(target)}] failed:`, error);
    });
  }

  async start(
    target: ExecutionTarget,
    operation: ManagedExecutionOperation,
    policy?: ExecutionPolicy,
    claimIntent?: ExecutionClaimIntent,
  ): Promise<StartManagedExecutionResult> {
    const claim = await this.manager.claim(
      target,
      policy ?? this.policyForTarget(target),
      claimIntent,
    );
    if (!claim.ok) return claim;

    const completion = this.runClaimed(claim, operation);
    void completion.catch((error) => this.onBackgroundError(target, error));
    return { ok: true, attemptId: claim.attempt.attemptId, completion };
  }

  private async runClaimed(
    claim: Extract<ClaimResult, { ok: true }>,
    operation: ManagedExecutionOperation,
  ): Promise<void> {
    const stopHeartbeat = this.manager.startHeartbeat(claim);
    const control: ExecutionControl = {
      attemptId: claim.attempt.attemptId,
      signal: claim.signal,
      // The claimed policy's timeout, read back off the attempt: the claim is
      // the authority on the budget, not the caller's copy of the policy.
      timeoutMs: claim.attempt.deadlineAt - claim.attempt.startedAt,
      heartbeat: async () => {
        if (!(await this.manager.heartbeat(claim))) {
          throw new ExecutionFencedError(claim.attempt.attemptId);
        }
      },
      throwIfAborted: () => {
        if (claim.signal.aborted) throw abortReason(claim.signal);
      },
    };

    try {
      await runInExecutionContext(
        {
          runId: claim.target.runId,
          targetKey: executionTargetKey(claim.target),
          attemptId: claim.attempt.attemptId,
        },
        async () => {
          control.throwIfAborted();
          await operation(control);
          control.throwIfAborted();
        },
      );
      if (!(await this.manager.complete(claim))) {
        throw new ExecutionFencedError(claim.attempt.attemptId);
      }
    } catch (error) {
      await this.manager.fail(claim, error);
      throw error;
    } finally {
      stopHeartbeat();
    }
  }
}

const globalForExecutionService = globalThis as unknown as {
  __councilExecutionService?: ExecutionService;
  __councilWatchdogStartup?: Promise<WatchdogTickResult>;
};

export function getExecutionService(): ExecutionService {
  if (!globalForExecutionService.__councilExecutionService) {
    globalForExecutionService.__councilExecutionService = new ExecutionService(
      new ExecutionManager(new RunExecutionAdapter()),
    );
  }
  return globalForExecutionService.__councilExecutionService;
}

export function runExecutionTarget(runId: string): ExecutionTarget {
  return { kind: "run", runId };
}

export function subTaskExecutionTarget(
  runId: string,
  stageNumber: StageNumber,
  subTaskId: string,
): ExecutionTarget {
  return { kind: "subtask", runId, stageNumber, subTaskId };
}

export async function startManagedExecution(
  target: ExecutionTarget,
  operation: ManagedExecutionOperation,
  policy?: ExecutionPolicy,
  claimIntent?: ExecutionClaimIntent,
): Promise<StartManagedExecutionResult> {
  return getExecutionService().start(target, operation, policy, claimIntent);
}

/** Run once at server boot, then keep checking leases in the background. */
export function startExecutionWatchdog(): Promise<WatchdogTickResult> {
  if (!globalForExecutionService.__councilWatchdogStartup) {
    const service = getExecutionService();
    globalForExecutionService.__councilWatchdogStartup = service.manager
      .watchdogTick()
      .then((result) => {
        service.manager.startWatchdog(positiveEnvMs("EXECUTION_WATCHDOG_MS") ?? 30_000);
        return result;
      })
      .catch((error) => {
        delete globalForExecutionService.__councilWatchdogStartup;
        throw error;
      });
  }
  return globalForExecutionService.__councilWatchdogStartup;
}

/** Test-only reset for the hot-reload singleton. */
export function __resetExecutionServiceForTests(): void {
  globalForExecutionService.__councilExecutionService?.manager.stopWatchdog();
  delete globalForExecutionService.__councilExecutionService;
  delete globalForExecutionService.__councilWatchdogStartup;
}
