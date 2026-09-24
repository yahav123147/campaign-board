import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import {
  signalTrackedChildProcess,
  supervisedProcessTreeLaunch,
  trackChildProcess,
} from "./childProcessRegistry";
import { linuxLandingAccepted } from "./platformAcceptance";

const DEFAULT_TIMEOUT_MS = 60 * 60 * 1_000;
const TERMINATION_GRACE_MS = 5_000;
const MAX_STDOUT_BYTES = 10 * 1024 * 1024;
const MAX_STDERR_BYTES = 1024 * 1024;
const MAX_PROMPT_BYTES = 2 * 1024 * 1024;
const MAX_TIMEOUT_MS = 4 * 60 * 60 * 1_000;

const SAFE_ENV_VARS = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TMPDIR",
  "TERM",
  "COLORTERM",
  "XDG_CONFIG_HOME",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
] as const;

export function sanitizeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {
    NODE_ENV: "production",
    DISABLE_AUTOUPDATER: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
  for (const key of SAFE_ENV_VARS) {
    if (env[key] !== undefined) out[key] = env[key];
  }
  return out;
}

export interface SpawnAgentOptions {
  prompt: string;
  onToken: (token: string) => void;
  cwd?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Test/packaging override. Production defaults to the locally installed Claude CLI. */
  command?: string;
  permissionMode?: "default" | "dontAsk" | "plan";
  /** An explicit built-in tool allowlist. Pass [] for a text-only agent. */
  tools?: readonly string[];
  /** Ignore MCP servers inherited from user/project configuration. */
  strictMcpConfig?: boolean;
  /** Explicit Claude setting sources. Pass [] to suppress inherited hooks/settings. */
  settingSources?: readonly ("user" | "project" | "local")[];
  /** Prevent skill/slash-command expansion for untrusted or text-only prompts. */
  disableSlashCommands?: boolean;
  /** Extra permission rules that are still bounded by `tools` and the sandbox. */
  allowedTools?: readonly string[];
  disallowedTools?: readonly string[];
  /** Inline Claude settings, typically used to require native OS sandboxing. */
  settings?: Readonly<Record<string, unknown>>;
  /**
   * Claude model for the turn. Agents run with settings suppressed, so without
   * this they fall to the CLI default (Opus at the time of writing) rather than
   * the operator's configured model. Defaults to CAMPAIGN_COUNCIL_AGENT_MODEL.
   */
  model?: string;
}

/**
 * The timer a turn really runs on: the caller's, else the configured default,
 * else the built-in hour. Exported because the 5.2 prompt states the budget in
 * minutes, and a prompt that names a different number than the timer is worse
 * than one that names none.
 */
export function resolvedAgentTimeoutMs(timeoutMs?: number): number {
  if (typeof timeoutMs === "number") return timeoutMs;
  const configured = Number(process.env.AGENT_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_TIMEOUT_MS;
}

export interface SpawnAgentResult {
  fullText: string;
  exitCode: number;
  durationMs: number;
}

/** Claude currently treats a missing Linux Unix-socket seccomp filter as an
 * optional warning. Do not enable Bash agents in a client install before that
 * boundary has been qualified through the actual WSL/Claude combination. */
export function assertAgentToolPlatform(
  tools: readonly string[] | undefined,
  platform = process.platform,
  linuxAccepted = linuxLandingAccepted(),
): void {
  if (platform === "win32" && tools?.includes("Bash")) {
    throw new Error("Native Windows Bash agents are unsupported; use Ubuntu inside WSL2.");
  }
  if (platform === "linux" && tools?.includes("Bash") && !linuxAccepted) {
    throw new Error("Linux/WSL Bash agents are awaiting acceptance (config/platform-acceptance.json). Use macOS for landing-page generation.");
  }
}

export async function spawnAgent(opts: SpawnAgentOptions): Promise<SpawnAgentResult> {
  const { prompt, onToken, cwd, signal, permissionMode } = opts;
  if (signal?.aborted) throw new Error("Claude execution was aborted before it started");
  if (!prompt.trim()) throw new Error("Claude prompt must not be empty");
  if (Buffer.byteLength(prompt, "utf8") > MAX_PROMPT_BYTES) {
    throw new Error("Claude prompt exceeded the 2MB safety limit");
  }
  assertAgentToolPlatform(opts.tools);
  const start = Date.now();
  const env = sanitizeEnv(process.env);
  const timeoutMs = resolvedAgentTimeoutMs(opts.timeoutMs);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`Claude timeout must be an integer between 1 and ${MAX_TIMEOUT_MS}ms`);
  }

  const args = ["-p", "--input-format", "text", "--no-session-persistence"];
  const model = (opts.model ?? process.env.CAMPAIGN_COUNCIL_AGENT_MODEL ?? "").trim();
  if (model) {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(model)) throw new Error("Invalid Claude model id for the agent turn");
    args.push("--model", model);
  }
  if (permissionMode && permissionMode !== "default") {
    args.push("--permission-mode", permissionMode);
  }
  if (opts.tools !== undefined) args.push("--tools", opts.tools.join(","));
  if (opts.strictMcpConfig) args.push("--strict-mcp-config");
  if (opts.settingSources !== undefined) {
    args.push("--setting-sources", opts.settingSources.join(","));
  }
  if (opts.disableSlashCommands) args.push("--disable-slash-commands");
  if (opts.allowedTools?.length) args.push("--allowedTools", opts.allowedTools.join(","));
  if (opts.disallowedTools?.length) args.push("--disallowedTools", opts.disallowedTools.join(","));
  if (opts.settings) {
    const settings = JSON.stringify(opts.settings);
    if (Buffer.byteLength(settings, "utf8") > 64 * 1024) {
      throw new Error("Claude inline settings exceed the 64KB safety limit");
    }
    args.push("--settings", settings);
  }

  return new Promise((resolve, reject) => {
    const launch = supervisedProcessTreeLaunch(opts.command ?? "claude", args);
    const proc = spawn(launch.command, [...launch.args], {
      env,
      cwd: cwd ?? process.cwd(),
      stdio: ["pipe", "pipe", "pipe", "ipc"],
      // The trusted supervisor owns a second process group containing Claude
      // and its descendants, and does not close until that group is reaped.
      detached: process.platform !== "win32",
    });
    trackChildProcess(proc, "claude-agent", { supervisedProcessTree: true });

    let fullText = "";
    const stdoutDecoder = new StringDecoder("utf8");
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failure: Error | undefined;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;

    const killTree = (signalName: NodeJS.Signals) => {
      signalTrackedChildProcess(proc, signalName);
    };
    const terminate = (reason: Error) => {
      if (failure) return;
      failure = reason;
      killTree("SIGTERM");
      killTimer = setTimeout(() => killTree("SIGKILL"), TERMINATION_GRACE_MS);
      killTimer.unref();
    };
    const timeout = setTimeout(
      () => terminate(new Error(`Claude execution timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    timeout.unref();
    const onAbort = () => terminate(new Error("Claude execution was aborted"));
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();

    const finish = (error?: Error, result?: SpawnAgentResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(result!);
    };

    proc.stdout!.on("data", (chunk: Buffer) => {
      if (stdoutBytes + chunk.length > MAX_STDOUT_BYTES) {
        terminate(new Error("Claude output exceeded the 10MB safety limit"));
        return;
      }
      stdoutBytes += chunk.length;
      const text = stdoutDecoder.write(chunk);
      fullText += text;
      try {
        onToken(text);
      } catch (error) {
        terminate(error instanceof Error ? error : new Error(String(error)));
      }
    });

    proc.stderr!.on("data", (chunk: Buffer) => {
      if (stderrBytes < MAX_STDERR_BYTES) {
        const remaining = MAX_STDERR_BYTES - stderrBytes;
        const accepted = chunk.subarray(0, remaining);
        stderr += accepted.toString("utf-8");
        stderrBytes += accepted.length;
      }
    });

    proc.stdin!.on("error", (error) => terminate(error));
    proc.stdin!.end(prompt);

    proc.on("error", (error) => finish(error));

    proc.on("close", (code) => {
      const durationMs = Date.now() - start;
      const trailing = stdoutDecoder.end();
      if (trailing) {
        fullText += trailing;
        try {
          onToken(trailing);
        } catch (error) {
          failure ??= error instanceof Error ? error : new Error(String(error));
        }
      }
      if (failure) {
        finish(failure);
        return;
      }
      if (code === 0) {
        finish(undefined, { fullText: fullText.trim(), exitCode: 0, durationMs });
      } else {
        finish(new Error(`claude -p exited ${code}: ${stderr.slice(0, 500)}`));
      }
    });
  });
}
