#!/usr/bin/env node

/**
 * Campaign Council local-readiness doctor.
 *
 * This command is intentionally read-only. It never installs dependencies,
 * creates directories, changes permissions, starts browsers, or prints secret
 * values. Checks that would normally prove writability by creating a file use
 * access and metadata checks instead.
 */

import fs from "node:fs/promises";
import { constants as fsConstants, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mockupBrowserExecutablePath } from "./browser-executable.mjs";

const execFileAsync = promisify(execFile);
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");

export const MINIMUM_NODE_VERSION = Object.freeze([20, 9, 0]);
export const MINIMUM_NPM_VERSION = Object.freeze([9, 0, 0]);
export const MINIMUM_PYTHON_VERSION = Object.freeze([3, 10, 0]);

export const DIRECT_API_ENV_KEYS = Object.freeze([
  "ANTHROPIC_API_KEY",
  "CLAUDE_API_KEY",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "AWS_BEARER_TOKEN_BEDROCK",
  "ANTHROPIC_VERTEX_PROJECT_ID",
]);

const RELEVANT_ENV_KEYS = new Set([
  "CAMPAIGN_COUNCIL_CLIENT_PROFILE",
  "CAMPAIGN_COUNCIL_USE_DEVELOPMENT_PROFILE",
  "CAMPAIGN_COUNCIL_DATA_DIR",
  "CAMPAIGN_COUNCIL_CHROME_PATH",
  "RUNS_DIR_OVERRIDE",
  "RUNS_LEGACY_DIR_OVERRIDE",
  "LANDING_PAGES_DIR",
  "PORT",
  "PREVIEW_PORT",
  "META_GRAPH_API_VERSION",
  "LOCALAPPDATA",
  "APPDATA",
  "XDG_DATA_HOME",
  ...DIRECT_API_ENV_KEYS,
]);

const STATUS_ORDER = Object.freeze({ pass: 0, warn: 1, fail: 2 });

/** @typedef {"pass" | "warn" | "fail"} CheckStatus */

/**
 * @typedef {object} DoctorCheck
 * @property {string} id
 * @property {string} title
 * @property {CheckStatus} status
 * @property {string} summary
 * @property {string=} action
 */

/**
 * Build a structured result. Keeping results structured makes the CLI output
 * testable and prevents checks from accidentally dumping raw command output.
 *
 * @param {DoctorCheck} value
 * @returns {DoctorCheck}
 */
export function doctorCheck(value) {
  if (!(value.status in STATUS_ORDER)) throw new TypeError("Invalid doctor check status");
  return Object.freeze({ ...value });
}

/**
 * Parse the first dotted numeric version in a command response.
 *
 * @param {string} input
 * @returns {readonly [number, number, number] | null}
 */
export function parseVersion(input) {
  const match = String(input).match(/(?:^|[^0-9])(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) return null;
  return Object.freeze([
    Number.parseInt(match[1], 10),
    Number.parseInt(match[2], 10),
    Number.parseInt(match[3] ?? "0", 10),
  ]);
}

/**
 * @param {readonly number[]} actual
 * @param {readonly number[]} minimum
 */
export function versionAtLeast(actual, minimum) {
  for (let index = 0; index < Math.max(actual.length, minimum.length); index += 1) {
    const left = actual[index] ?? 0;
    const right = minimum[index] ?? 0;
    if (left > right) return true;
    if (left < right) return false;
  }
  return true;
}

/** @param {readonly number[]} version */
export function formatVersion(version) {
  return version.join(".");
}

/**
 * @param {string} raw
 * @returns {{ valid: boolean, loggedIn: boolean, subscriptionOAuth: boolean }}
 */
export function assessClaudeAuth(raw) {
  try {
    const parsed = JSON.parse(raw);
    const loggedIn = parsed?.loggedIn === true;
    const method = typeof parsed?.authMethod === "string" ? parsed.authMethod.toLowerCase() : "";
    const provider = typeof parsed?.apiProvider === "string" ? parsed.apiProvider.toLowerCase() : "";
    const oauthMethod = method.includes("oauth") || method.includes("claude.ai");
    const firstParty = provider === "firstparty" || provider === "first_party";
    return {
      valid: true,
      loggedIn,
      subscriptionOAuth: loggedIn && oauthMethod && firstParty,
    };
  } catch {
    return { valid: false, loggedIn: false, subscriptionOAuth: false };
  }
}

/**
 * Some features intentionally depend on macOS primitives in this release.
 * Disabled capabilities remain non-blocking, but enabling one on another OS
 * must fail before the app reaches the runtime error.
 *
 * @param {string} platform
 * @param {boolean} enabled
 * @returns {CheckStatus}
 */
export function macOnlyCapabilityStatus(platform, enabled) {
  if (platform === "darwin") return "pass";
  return enabled ? "fail" : "warn";
}

/** Core agent processes require a safe whole-tree reaper. */
export function processTreePlatformCheck(platform = process.platform) {
  if (platform === "win32") {
    return doctorCheck({
      id: "process-tree-reaper",
      title: "Process-tree cleanup",
      status: "fail",
      summary: "Windows process execution is disabled because this release has no Job Object reaper.",
      action: "Run Campaign Council on macOS or Ubuntu inside WSL2; native Windows has no Job Object reaper in this release.",
    });
  }
  return doctorCheck({
    id: "process-tree-reaper",
    title: "Process-tree cleanup",
    status: "pass",
    summary: "POSIX process groups and the supervised tree reaper are available.",
  });
}

/**
 * Parse only variables the doctor needs. Values for all other keys, including
 * unrelated credentials, are ignored and never retained.
 *
 * @param {string} source
 * @param {ReadonlySet<string>} allowedKeys
 * @returns {Record<string, string>}
 */
export function parseRelevantDotEnv(source, allowedKeys = RELEVANT_ENV_KEYS) {
  /** @type {Record<string, string>} */
  const parsed = {};
  for (const originalLine of String(source).split(/\r?\n/)) {
    const line = originalLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match || !allowedKeys.has(match[1])) continue;

    let value = match[2].trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value
        .slice(1, -1)
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "\r")
        .replace(/\\t/g, "\t")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\");
    } else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    parsed[match[1]] = value;
  }
  return parsed;
}

/**
 * @param {string} source
 * @returns {Array<{ packageName: string, operator: "==" | ">=", version: string }>}
 */
export function parsePythonRequirements(source) {
  const requirements = [];
  for (const originalLine of String(source).split(/\r?\n/)) {
    const line = originalLine.replace(/\s+#.*$/, "").trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z0-9_.-]+)\s*(==|>=)\s*([A-Za-z0-9_.+-]+)$/);
    if (!match) throw new Error(`Unsupported Python requirement syntax: ${line}`);
    requirements.push({ packageName: match[1], operator: match[2], version: match[3] });
  }
  return requirements;
}

/**
 * @param {{ platform: string, mode: number, uid?: number, expectedUid?: number }} input
 * @returns {{ private: boolean, ownerMatches: boolean, modeLabel: string }}
 */
export function assessPrivateDirectory(input) {
  const mode = input.mode & 0o777;
  const ownerMatches = input.expectedUid === undefined
    || input.uid === undefined
    || input.uid === input.expectedUid;
  const privateMode = input.platform === "win32" || (mode & 0o077) === 0;
  return {
    private: privateMode && ownerMatches,
    ownerMatches,
    modeLabel: mode.toString(8).padStart(3, "0"),
  };
}

/**
 * @param {DoctorCheck[]} checks
 */
export function summarizeChecks(checks) {
  return checks.reduce(
    (summary, check) => {
      summary[check.status] += 1;
      return summary;
    },
    { pass: 0, warn: 0, fail: 0 },
  );
}

/**
 * @param {DoctorCheck[]} checks
 */
export function formatDoctorReport(checks) {
  const summary = summarizeChecks(checks);
  const lines = [
    "Campaign Council readiness doctor",
    "Read-only diagnostics. No files, settings, or credentials were changed.",
    "",
  ];
  for (const check of checks) {
    lines.push(`[${check.status.toUpperCase()}] ${check.title}: ${check.summary}`);
    if (check.action) lines.push(`       Action: ${check.action}`);
  }
  lines.push(
    "",
    `Summary: ${summary.pass} passed, ${summary.warn} warnings, ${summary.fail} failed.`,
    summary.fail === 0 ? "Ready: YES" : "Ready: NO",
  );
  return lines.join("\n");
}

/**
 * @param {string} file
 * @param {string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, timeout?: number, discardStdout?: boolean }=} options
 */
async function runCommand(file, args, options = {}) {
  if (options.discardStdout) return runCommandDiscardingStdout(file, args, options);
  try {
    const result = await execFileAsync(file, args, {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeout ?? 10_000,
      maxBuffer: 128 * 1024,
      windowsHide: true,
      encoding: "utf8",
    });
    return { ok: true, stdout: result.stdout ?? "", stderr: result.stderr ?? "", code: 0 };
  } catch (error) {
    const value = /** @type {{ code?: number | string, stdout?: string, stderr?: string }} */ (error);
    return {
      ok: false,
      stdout: typeof value.stdout === "string" ? value.stdout : "",
      stderr: typeof value.stderr === "string" ? value.stderr : "",
      code: value.code ?? -1,
    };
  }
}

/**
 * Like runCommand, but the child's stdout file descriptor is "ignore" at
 * spawn time. execFile always buffers stdout into memory for the caller to
 * read even when unused; a probe whose command can print a secret (Linux's
 * secret-tool "lookup", reused as an existence check) must never let that
 * value exist as a string inside this process at all, not merely go unread.
 * The exit code alone answers "does the item exist".
 *
 * @param {string} file
 * @param {string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, timeout?: number }} options
 */
function runCommandDiscardingStdout(file, args, options) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(file, args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
      });
    } catch {
      resolve({ ok: false, stdout: "", stderr: "", code: -1 });
      return;
    }
    let stderr = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ ok: false, stdout: "", stderr, code: -1 });
    }, options.timeout ?? 10_000);
    timer.unref?.();
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < 8 * 1024) stderr += chunk.toString("utf8");
    });
    child.on("error", () => finish({ ok: false, stdout: "", stderr, code: -1 }));
    child.on("close", (code) => finish({ ok: code === 0, stdout: "", stderr, code: code ?? -1 }));
  });
}

/** @param {string} root */
async function loadRelevantEnvironment(root) {
  /** @type {Record<string, string>} */
  const fromFiles = {};
  for (const filename of [".env", ".env.local"]) {
    try {
      Object.assign(fromFiles, parseRelevantDotEnv(await fs.readFile(path.join(root, filename), "utf8")));
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== "ENOENT") throw error;
    }
  }
  for (const key of RELEVANT_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) fromFiles[key] = value;
  }
  return fromFiles;
}

function nodeCheck() {
  const actual = parseVersion(process.versions.node);
  const minimum = formatVersion(MINIMUM_NODE_VERSION);
  if (!actual || !versionAtLeast(actual, MINIMUM_NODE_VERSION)) {
    return doctorCheck({
      id: "node",
      title: "Node.js",
      status: "fail",
      summary: `Node.js ${minimum} or newer is required.`,
      action: `Install an active LTS release at or above ${minimum}, then reopen the terminal.`,
    });
  }
  return doctorCheck({
    id: "node",
    title: "Node.js",
    status: "pass",
    summary: `Version ${formatVersion(actual)} is compatible.`,
  });
}

async function npmCheck() {
  const response = await runCommand("npm", ["--version"]);
  if (!response.ok) {
    return doctorCheck({
      id: "npm",
      title: "npm",
      status: "fail",
      summary: "npm is not available on PATH.",
      action: "Install Node.js with npm, then reopen the terminal.",
    });
  }
  const actual = parseVersion(response.stdout);
  const minimum = formatVersion(MINIMUM_NPM_VERSION);
  if (!actual || !versionAtLeast(actual, MINIMUM_NPM_VERSION)) {
    return doctorCheck({
      id: "npm",
      title: "npm",
      status: "fail",
      summary: `npm ${minimum} or newer is required.`,
      action: "Update the npm installation that belongs to the active Node.js version.",
    });
  }
  return doctorCheck({
    id: "npm",
    title: "npm",
    status: "pass",
    summary: `Version ${formatVersion(actual)} is compatible.`,
  });
}

/** @param {Record<string, string>} effectiveEnv */
export function claudeApiEnvironmentCheck(effectiveEnv) {
  const configured = DIRECT_API_ENV_KEYS.filter((key) => Boolean(effectiveEnv[key]?.trim()));
  if (configured.length > 0) {
    return doctorCheck({
      id: "claude-api-environment",
      title: "Claude authentication environment",
      status: "fail",
      summary: `Non-OAuth Claude provider variables are configured: ${configured.join(", ")}. Values were not printed.`,
      action: "Remove these variables from the shell and .env.local. This app supports Claude subscription OAuth only.",
    });
  }
  return doctorCheck({
    id: "claude-api-environment",
    title: "Claude authentication environment",
    status: "pass",
    summary: "No paid API fallback is configured.",
  });
}

/** @param {Readonly<Record<string, string | undefined>>} effectiveEnv */
export function metaGraphApiVersionCheck(effectiveEnv) {
  const version = effectiveEnv.META_GRAPH_API_VERSION?.trim() || "v26.0";
  if (!/^v[1-9][0-9]?\.0$/.test(version)) {
    return doctorCheck({
      id: "meta-graph-version",
      title: "Meta Graph API version",
      status: "fail",
      summary: "META_GRAPH_API_VERSION is not a safe version segment.",
      action: "Use the supported vNN.0 format, for example v26.0. Do not enter a URL or hostname.",
    });
  }
  return doctorCheck({
    id: "meta-graph-version",
    title: "Meta Graph API version",
    status: "pass",
    summary: `Meta read-only checks are configured for ${version}.`,
  });
}

function minimalClaudeEnvironment() {
  const allowed = [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "TERM",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "XDG_CONFIG_HOME",
    "CLAUDE_CONFIG_DIR",
    "CLAUDE_CODE_OAUTH_TOKEN",
  ];
  /** @type {NodeJS.ProcessEnv} */
  const env = {};
  for (const key of allowed) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.DISABLE_AUTOUPDATER = "1";
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  return env;
}

async function claudeChecks() {
  const versionResponse = await runCommand("claude", ["--version"], {
    env: minimalClaudeEnvironment(),
  });
  if (!versionResponse.ok) {
    return [
      doctorCheck({
        id: "claude-cli",
        title: "Claude CLI",
        status: "fail",
        summary: "The claude command is not available on PATH.",
        action: "Install Claude Code, reopen the terminal, and run claude auth login.",
      }),
      doctorCheck({
        id: "claude-oauth",
        title: "Claude subscription OAuth",
        status: "fail",
        summary: "OAuth status cannot be checked until Claude CLI is installed.",
        action: "Install Claude Code and authenticate with the supported subscription account.",
      }),
    ];
  }

  const version = parseVersion(versionResponse.stdout);
  const cliResult = doctorCheck({
    id: "claude-cli",
    title: "Claude CLI",
    status: "pass",
    summary: version ? `Version ${formatVersion(version)} is installed.` : "Installed.",
  });
  const authResponse = await runCommand("claude", ["auth", "status", "--json"], {
    env: minimalClaudeEnvironment(),
  });
  const assessment = assessClaudeAuth(authResponse.stdout.trim() || authResponse.stderr.trim());
  if (!assessment.valid) {
    return [
      cliResult,
      doctorCheck({
        id: "claude-oauth",
        title: "Claude subscription OAuth",
        status: "fail",
        summary: "Claude CLI did not return a valid authentication status.",
        action: "Run claude auth login, choose subscription OAuth, then rerun the doctor.",
      }),
    ];
  }
  if (!assessment.loggedIn) {
    return [
      cliResult,
      doctorCheck({
        id: "claude-oauth",
        title: "Claude subscription OAuth",
        status: "fail",
        summary: "Claude CLI is not logged in.",
        action: "Run claude auth login with the MAX subscription account, then rerun the doctor.",
      }),
    ];
  }
  if (!assessment.subscriptionOAuth) {
    return [
      cliResult,
      doctorCheck({
        id: "claude-oauth",
        title: "Claude subscription OAuth",
        status: "fail",
        summary: "Claude is authenticated with an unsupported provider or method.",
        action: "Run claude auth logout, then claude auth login and select first-party subscription OAuth.",
      }),
    ];
  }
  return [
    cliResult,
    doctorCheck({
      id: "claude-oauth",
      title: "Claude subscription OAuth",
      status: "pass",
      summary: "First-party subscription OAuth is active.",
    }),
  ];
}

/** The tier named in a Claude CLI credential store's JSON, lower-cased, or undefined. */
function subscriptionTierFrom(raw) {
  try {
    const tier = JSON.parse(raw)?.claudeAiOauth?.subscriptionType;
    return typeof tier === "string" && tier.trim() ? tier.trim().toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The subscription tier of the authenticated Claude account. `claude auth
 * status --json` does not expose it; the CLI's own credential store does
 * (claudeAiOauth.subscriptionType): the credentials file under the config
 * directory on Linux and WSL2, the "Claude Code-credentials" Keychain item
 * on macOS. The store also holds the tokens: they are parsed in memory and
 * never returned, logged or printed. A client on the Pro tier installed the
 * board and only learned at the first agent run that MAX is required.
 *
 * @param {{ platform?: string, env?: NodeJS.ProcessEnv, home?: string, readFile?: (file: string) => Promise<string>, runCommand?: typeof runCommand }} deps
 * @returns {Promise<{ tier?: string, source?: string }>}
 */
export async function readClaudeSubscriptionTier(deps = {}) {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const home = deps.home ?? os.homedir();
  const readFile = deps.readFile ?? ((file) => fs.readFile(file, "utf8"));
  const run = deps.runCommand ?? runCommand;
  const configDir = env.CLAUDE_CONFIG_DIR?.trim() || path.join(home, ".claude");
  try {
    const tier = subscriptionTierFrom(await readFile(path.join(configDir, ".credentials.json")));
    if (tier) return { tier, source: "the Claude CLI credentials file" };
  } catch {
    // no file, or unreadable: fall through
  }
  if (platform === "darwin") {
    const result = await run("/usr/bin/security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], {
      env: minimalClaudeEnvironment(),
    });
    if (result.ok) {
      const tier = subscriptionTierFrom(result.stdout);
      if (tier) return { tier, source: "the macOS Keychain" };
    }
  }
  return {};
}

/** @param {Parameters<typeof readClaudeSubscriptionTier>[0]=} deps */
export async function claudeSubscriptionCheck(deps = {}) {
  const { tier, source } = await readClaudeSubscriptionTier(deps);
  if (!tier) {
    return doctorCheck({
      id: "claude-max-subscription",
      title: "Claude MAX subscription",
      status: "warn",
      summary: "The subscription tier could not be read from the Claude CLI's credential store, so MAX cannot be verified automatically.",
      action: "Before a real run, confirm manually that the authenticated Claude account has an active MAX subscription. Do not configure a paid API fallback.",
    });
  }
  if (tier === "max") {
    return doctorCheck({
      id: "claude-max-subscription",
      title: "Claude MAX subscription",
      status: "pass",
      summary: `The authenticated Claude account is on the MAX tier (read from ${source}).`,
    });
  }
  return doctorCheck({
    id: "claude-max-subscription",
    title: "Claude MAX subscription",
    status: "fail",
    summary: `The authenticated Claude account is on the "${tier}" tier (read from ${source}); the board's agents require MAX.`,
    action: "Sign in with a MAX account: claude auth logout, then claude auth login. Do not configure a paid API fallback.",
  });
}

async function playwrightCheck() {
  try {
    const playwright = await import("playwright");
    const executable = playwright.chromium.executablePath();
    const stat = await fs.stat(executable);
    await fs.access(executable, fsConstants.R_OK | fsConstants.X_OK);
    if (!stat.isFile()) throw new Error("Chromium executable path is not a file");
    return doctorCheck({
      id: "playwright",
      title: "Playwright Chromium",
      status: "pass",
      summary: "The local Chromium executable is installed and executable.",
    });
  } catch (error) {
    const code = /** @type {NodeJS.ErrnoException} */ (error).code;
    const packageMissing = code === "ERR_MODULE_NOT_FOUND"
      || String(/** @type {Error} */ (error).message).includes("Cannot find package 'playwright'");
    return doctorCheck({
      id: "playwright",
      title: "Playwright Chromium",
      status: "fail",
      summary: packageMissing
        ? "The Playwright package is not installed."
        : "The Playwright package exists, but its Chromium executable is unavailable.",
      action: packageMissing ? "Run npm install." : "Run npx playwright install chromium.",
    });
  }
}

/** Inspect the same executable the renderer chooses, without launching it. */
export async function mockupBrowserCheck(readiness, effectiveEnv = {}, resolveBrowser = mockupBrowserExecutablePath) {
  try {
    const executable = await resolveBrowser({ chromePath: effectiveEnv.CAMPAIGN_COUNCIL_CHROME_PATH });
    return doctorCheck({
      id: "mockup-browser",
      title: "Device mockup browser",
      status: "pass",
      summary: `The renderer's browser is installed and executable: ${executable}.`,
    });
  } catch {
    return doctorCheck({
      id: "mockup-browser",
      title: "Device mockup browser",
      status: readiness?.stage5?.enabled ? "fail" : "warn",
      summary: "The browser used to render device mockups is unavailable.",
      action: effectiveEnv.CAMPAIGN_COUNCIL_CHROME_PATH
        ? "Correct or remove CAMPAIGN_COUNCIL_CHROME_PATH, then rerun the doctor."
        : "Run npx playwright install chromium, then rerun the doctor.",
    });
  }
}

/**
 * The interpreter a RUN uses, resolved exactly as orchestrator's
 * resolvePython() does: the Board's own venv when it is installed, else
 * python3 on PATH.
 *
 * The doctor used to inspect PATH's python3 while the run used the venv. With
 * numpy and scipy now needed for every device mockup, that gap is the
 * difference between a green doctor and a 5.2 that rejects every mockup.
 */
export function resolveDoctorPython({ home = os.homedir(), exists = existsSync } = {}) {
  const venv = path.join(home, ".campaign-council-venv", "bin", "python3");
  return exists(venv) ? venv : "python3";
}

/**
 * The modules every device mockup needs, whatever the requirements file
 * happens to pin: Pillow for the pixels, numpy and scipy for the screen
 * detection and the composite. A requirements file that stops pinning one of
 * them is a broken installation waiting for the first mockup run.
 */
export const REQUIRED_IMAGE_MODULES = Object.freeze(["Pillow", "numpy", "scipy"]);

export function missingRequiredImageModules(requirements) {
  const declared = new Set(requirements.map((item) => String(item.packageName).toLowerCase()));
  return REQUIRED_IMAGE_MODULES.filter((name) => !declared.has(name.toLowerCase()));
}

/**
 * Packages whose import name is not the distribution name with dashes turned
 * to underscores. python-bidi installs as `bidi`; the guess `python_bidi` never
 * imported, so a correct install read as broken on every machine.
 */
const PYTHON_IMPORT_NAMES = Object.freeze({ Pillow: "PIL", "python-bidi": "bidi" });

/** @param {string} packageName */
export function pythonImportName(packageName) {
  return PYTHON_IMPORT_NAMES[packageName] ?? packageName.replace(/-/g, "_");
}

async function pythonChecks(root) {
  const interpreter = resolveDoctorPython();
  const shown = interpreter === "python3" ? "python3 on PATH" : interpreter;
  const versionResponse = await runCommand(interpreter, ["--version"], {
    env: minimalPythonEnvironment(),
  });
  if (!versionResponse.ok) {
    return [
      doctorCheck({
        id: "python",
        title: "Python",
        status: "fail",
        summary: `The interpreter runs use (${shown}) is not available.`,
        action: "Install Python 3.10 or newer, then reopen the terminal.",
      }),
      doctorCheck({
        id: "python-modules",
        title: "Python image modules",
        status: "fail",
        summary: "Image modules cannot be checked until Python is installed.",
        action: "Install Python, then install requirements-image-core.txt in the active environment.",
      }),
    ];
  }

  const actual = parseVersion(`${versionResponse.stdout} ${versionResponse.stderr}`);
  const minimum = formatVersion(MINIMUM_PYTHON_VERSION);
  const pythonResult = !actual || !versionAtLeast(actual, MINIMUM_PYTHON_VERSION)
    ? doctorCheck({
        id: "python",
        title: "Python",
        status: "fail",
        summary: `Python ${minimum} or newer is required.`,
        action: `Install Python ${minimum} or newer and make it available as python3.`,
      })
    : doctorCheck({
        id: "python",
        title: "Python",
        status: "pass",
        summary: `Version ${formatVersion(actual)} (${shown}) is compatible.`,
      });

  let requirements;
  try {
    requirements = parsePythonRequirements(
      await fs.readFile(path.join(root, "requirements-image-core.txt"), "utf8"),
    );
    if (requirements.length === 0) throw new Error("No requirements declared");
  } catch {
    return [
      pythonResult,
      doctorCheck({
        id: "python-modules",
        title: "Python image modules",
        status: "fail",
        summary: "requirements-image-core.txt is missing or unsupported.",
        action: "Restore the checked-in requirements file before running image stages.",
      }),
    ];
  }

  const undeclared = missingRequiredImageModules(requirements);
  if (undeclared.length > 0) {
    return [
      pythonResult,
      doctorCheck({
        id: "python-modules",
        title: "Python image modules",
        status: "fail",
        summary: `requirements-image-core.txt does not pin ${undeclared.join(", ")}, needed for every device mockup.`,
        action: "Restore the checked-in requirements file before running image stages.",
      }),
    ];
  }

  const inspectionCode = [
    "import importlib, json, sys",
    "from importlib import metadata",
    "result = {}",
    "for name in sys.argv[1:]:",
    "    try:",
    // A JSON object is a valid Python dict literal for string keys and values.
    `        module_name = ${JSON.stringify(PYTHON_IMPORT_NAMES)}.get(name, name.replace('-', '_'))`,
    "        importlib.import_module(module_name)",
    "        result[name] = {'version': metadata.version(name), 'importable': True}",
    "    except Exception:",
    "        result[name] = {'version': None, 'importable': False}",
    "print(json.dumps(result))",
  ].join("\n");
  // The same interpreter the run uses, never PATH's: a venv without numpy
  // passes a PATH check and then rejects every mockup.
  const moduleResponse = await runCommand(
    interpreter,
    ["-B", "-c", inspectionCode, ...requirements.map((item) => item.packageName)],
    { env: minimalPythonEnvironment() },
  );
  let installed = {};
  try {
    installed = JSON.parse(moduleResponse.stdout);
  } catch {
    installed = {};
  }

  const missing = [];
  const mismatched = [];
  for (const requirement of requirements) {
    const detail = installed[requirement.packageName];
    if (!moduleResponse.ok || !detail?.importable || typeof detail.version !== "string") {
      missing.push(requirement.packageName);
      continue;
    }
    const actualPackage = parseVersion(detail.version);
    const expected = parseVersion(requirement.version);
    const compatible = actualPackage && expected && (
      requirement.operator === "=="
        ? detail.version === requirement.version
        : versionAtLeast(actualPackage, expected)
    );
    if (!compatible) mismatched.push(requirement.packageName);
  }

  if (missing.length > 0 || mismatched.length > 0) {
    const parts = [];
    if (missing.length > 0) parts.push(`missing or not importable: ${missing.join(", ")}`);
    if (mismatched.length > 0) parts.push(`version mismatch: ${mismatched.join(", ")}`);
    return [
      pythonResult,
      doctorCheck({
        id: "python-modules",
        title: "Python image modules",
        status: "fail",
        summary: `${parts.join("; ")} in ${shown}.`,
        action: `Run ${interpreter} -m pip install -r requirements-image-core.txt.`,
      }),
    ];
  }
  return [
    pythonResult,
    doctorCheck({
      id: "python-modules",
      title: "Python image modules",
      status: "pass",
      summary: `${requirements.map((item) => item.packageName).join(", ")} match the locked requirements in ${shown}.`,
    }),
  ];
}

function minimalPythonEnvironment() {
  const allowed = [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "SYSTEMROOT",
  ];
  const env = { PYTHONDONTWRITEBYTECODE: "1" };
  for (const key of allowed) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

/**
 * Mirror lib/runStore.ts without importing application code that can change
 * during installation. Platform and home are injectable for deterministic tests.
 *
 * @param {{ root: string, effectiveEnv: Record<string, string>, platform?: string, home?: string }} input
 */
export function resolveDoctorDataPaths(input) {
  const platform = input.platform ?? process.platform;
  const home = input.home ?? os.homedir();
  const resolveConfigured = (value, variable) => {
    if (value.includes("\0") || !path.isAbsolute(value)) {
      throw new Error(`${variable} must be an absolute dedicated directory`);
    }
    const resolved = path.resolve(value);
    const filesystemRoot = path.parse(resolved).root;
    const normalize = (candidate) => {
      const normalized = path.resolve(candidate);
      return platform === "win32" ? normalized.toLowerCase() : normalized;
    };
    const forbidden = [
      filesystemRoot,
      home,
      input.root,
      os.tmpdir(),
      ...(platform === "win32" ? [] : ["/tmp", "/private/tmp", "/var/tmp"]),
    ].filter(Boolean).map(normalize);
    if (
      path.dirname(resolved) === filesystemRoot
      || forbidden.includes(normalize(resolved))
    ) {
      throw new Error(
        `${variable} must point to a dedicated subdirectory, not a broad system or workspace path`,
      );
    }
    return resolved;
  };
  const exactOverride = input.effectiveEnv.RUNS_DIR_OVERRIDE?.trim();
  let primary;
  if (exactOverride) {
    primary = resolveConfigured(exactOverride, "RUNS_DIR_OVERRIDE");
  } else {
    const configuredBase = input.effectiveEnv.CAMPAIGN_COUNCIL_DATA_DIR?.trim();
    let base;
    if (configuredBase) {
      base = resolveConfigured(configuredBase, "CAMPAIGN_COUNCIL_DATA_DIR");
    } else if (platform === "darwin") {
      base = path.join(home, "Library", "Application Support", "Campaign Council");
    } else if (platform === "win32") {
      const windowsBase = input.effectiveEnv.LOCALAPPDATA?.trim()
        || input.effectiveEnv.APPDATA?.trim()
        || home;
      base = path.join(
        windowsBase === home
          ? home
          : resolveConfigured(
              windowsBase,
              input.effectiveEnv.LOCALAPPDATA?.trim() ? "LOCALAPPDATA" : "APPDATA",
            ),
        "Campaign Council",
      );
    } else {
      const xdgBase = input.effectiveEnv.XDG_DATA_HOME?.trim();
      base = xdgBase
        ? path.join(resolveConfigured(xdgBase, "XDG_DATA_HOME"), "campaign-council")
        : path.join(home, ".local", "share", "campaign-council");
    }
    primary = path.join(base, "runs");
  }
  const legacyOverride = input.effectiveEnv.RUNS_LEGACY_DIR_OVERRIDE?.trim();
  return {
    primary,
    legacy: legacyOverride
      ? resolveConfigured(legacyOverride, "RUNS_LEGACY_DIR_OVERRIDE")
      : path.resolve(input.root, "runs"),
    exactOverride: Boolean(exactOverride),
  };
}

/** @param {string} directory */
async function nearestExistingDirectory(directory) {
  let candidate = path.resolve(directory);
  while (true) {
    try {
      const stat = await fs.lstat(candidate);
      return stat.isDirectory() && !stat.isSymbolicLink() ? candidate : null;
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== "ENOENT") return null;
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) return null;
    candidate = parent;
  }
}

/** @param {string} root @param {Record<string, string>} effectiveEnv */
async function dataDirectoryChecks(root, effectiveEnv) {
  let paths;
  try {
    paths = resolveDoctorDataPaths({ root, effectiveEnv });
  } catch (error) {
    return [doctorCheck({
      id: "data-directory",
      title: "Private run-data directory",
      status: "fail",
      summary: error instanceof Error ? error.message : "The configured data path is unsafe.",
      action: "Choose an absolute, dedicated client-data directory below your home or application-data directory.",
    })];
  }
  const directory = paths.primary;
  const actionTarget = paths.exactOverride
    ? '"$RUNS_DIR_OVERRIDE"'
    : effectiveEnv.CAMPAIGN_COUNCIL_DATA_DIR?.trim()
      ? '"$CAMPAIGN_COUNCIL_DATA_DIR/runs"'
      : process.platform === "darwin"
        ? '"$HOME/Library/Application Support/Campaign Council/runs"'
        : "the default Campaign Council data directory";
  let stat;
  try {
    stat = await fs.lstat(directory);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== "ENOENT") {
      return [doctorCheck({
        id: "data-directory",
        title: "Private run-data directory",
        status: "fail",
        summary: "The configured data directory cannot be inspected.",
        action: "Check the configured data path and its parent permissions.",
      })];
    }
    const parent = await nearestExistingDirectory(path.dirname(directory));
    try {
      if (!parent) throw new Error("No safe parent directory");
      await fs.access(parent, fsConstants.W_OK | fsConstants.X_OK);
    } catch {
      return [doctorCheck({
        id: "data-directory",
        title: "Private run-data directory",
        status: "fail",
        summary: "The data directory does not exist and no safe writable parent is available.",
        action: "Choose a private, writable CAMPAIGN_COUNCIL_DATA_DIR owned by the current user.",
      })];
    }
    return [doctorCheck({
      id: "data-directory",
      title: "Private run-data directory",
      status: "warn",
      summary: "The private data directory does not exist yet; its nearest existing parent is writable.",
      action: `The app will create ${actionTarget} with owner-only permissions on the first run. Rerun the doctor afterward.`,
    }), ...await legacyDataChecks(paths, effectiveEnv)];
  }

  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    return [doctorCheck({
      id: "data-directory",
      title: "Private run-data directory",
      status: "fail",
      summary: "The configured data path must be a real directory, not a file or symbolic link.",
      action: "Point CAMPAIGN_COUNCIL_DATA_DIR or RUNS_DIR_OVERRIDE at a regular directory owned by the current user.",
    })];
  }
  try {
    await fs.access(directory, fsConstants.R_OK | fsConstants.W_OK | fsConstants.X_OK);
  } catch {
    return [doctorCheck({
      id: "data-directory",
      title: "Private run-data directory",
      status: "fail",
      summary: "The data directory is not readable and writable by the current user.",
      action: "Fix ownership and owner permissions before starting the app.",
    })];
  }

  const expectedUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const privacy = assessPrivateDirectory({
    platform: process.platform,
    mode: stat.mode,
    uid: stat.uid,
    expectedUid,
  });
  if (!privacy.private) {
    const ownership = privacy.ownerMatches ? "" : " or is owned by another user";
    return [doctorCheck({
      id: "data-directory",
      title: "Private run-data directory",
      status: "fail",
      summary: `The data directory has mode ${privacy.modeLabel}${ownership}; client run data must be owner-only.`,
      action: `Verify ownership, then run: chmod 700 ${actionTarget}`,
    })];
  }
  return [doctorCheck({
    id: "data-directory",
    title: "Private run-data directory",
    status: "pass",
    summary: process.platform === "win32"
      ? "The data directory is accessible; review Windows ACLs before storing client data."
      : `The directory is writable, owner-controlled, and mode ${privacy.modeLabel}.`,
  }), ...await legacyDataChecks(paths, effectiveEnv)];
}

async function legacyDataChecks(paths, effectiveEnv) {
  if (paths.exactOverride || paths.legacy === paths.primary) return [];
  let stat;
  try {
    stat = await fs.lstat(paths.legacy);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return [];
    return [doctorCheck({
      id: "legacy-data-directory",
      title: "Legacy run-data directory",
      status: "fail",
      summary: "The legacy run-data path exists but cannot be inspected safely.",
      action: "Inspect RUNS_LEGACY_DIR_OVERRIDE before starting the app.",
    })];
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    return [doctorCheck({
      id: "legacy-data-directory",
      title: "Legacy run-data directory",
      status: "fail",
      summary: "The legacy run-data path is not a real directory.",
      action: "Move legacy data to a private regular directory and configure RUNS_LEGACY_DIR_OVERRIDE.",
    })];
  }
  let entries;
  try {
    entries = await fs.readdir(paths.legacy);
  } catch {
    return [doctorCheck({
      id: "legacy-data-directory",
      title: "Legacy run-data directory",
      status: "fail",
      summary: "The legacy run-data directory is not readable.",
      action: "Fix its ownership and owner permissions before migration.",
    })];
  }
  if (entries.length === 0) return [];
  const expectedUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const privacy = assessPrivateDirectory({
    platform: process.platform,
    mode: stat.mode,
    uid: stat.uid,
    expectedUid,
  });
  const configuredLegacy = Boolean(effectiveEnv.RUNS_LEGACY_DIR_OVERRIDE?.trim());
  if (!privacy.private) {
    return [doctorCheck({
      id: "legacy-data-directory",
      title: "Legacy run-data directory",
      status: "fail",
      summary: `Legacy run data still exists with mode ${privacy.modeLabel}; it may contain client material.`,
      action: configuredLegacy
        ? 'Verify ownership, then run: chmod 700 "$RUNS_LEGACY_DIR_OVERRIDE"'
        : "Verify ownership, then run: chmod 700 runs",
    })];
  }
  return [doctorCheck({
    id: "legacy-data-directory",
    title: "Legacy run-data directory",
    status: "warn",
    summary: "Private legacy runs still exist outside the primary data directory.",
    action: "Start the app to copy runs on access. Keep the untouched source until migration is verified.",
  })];
}

/**
 * @param {string | undefined} raw
 * @param {number} fallback
 * @param {string} name
 */
export function parseLoopbackPort(raw, fallback, name) {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1024 || value > 65535) {
    throw new Error(`${name} must be an integer between 1024 and 65535.`);
  }
  return value;
}

/** @param {number} port */
async function canBindLoopback(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      server.close();
      finish(false);
    }, 2_000);
    timer.unref();
    server.once("error", () => finish(false));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close(() => finish(true));
    });
    server.unref();
  });
}

/** @param {Record<string, string>} effectiveEnv */
async function portChecks(effectiveEnv) {
  let appPort;
  let previewPort;
  try {
    appPort = parseLoopbackPort(effectiveEnv.PORT, 3000, "PORT");
    previewPort = parseLoopbackPort(effectiveEnv.PREVIEW_PORT, 4322, "PREVIEW_PORT");
  } catch (error) {
    return [doctorCheck({
      id: "loopback-ports",
      title: "Loopback ports",
      status: "fail",
      summary: /** @type {Error} */ (error).message,
      action: "Set PORT in the launching shell and PREVIEW_PORT in .env.local to valid, different loopback ports.",
    })];
  }
  if (appPort === previewPort) {
    return [doctorCheck({
      id: "loopback-ports",
      title: "Loopback ports",
      status: "fail",
      summary: `PORT and PREVIEW_PORT both resolve to ${appPort}.`,
      action: "Assign different loopback ports to the app and landing-page preview.",
    })];
  }

  const [appAvailable, previewAvailable] = await Promise.all([
    canBindLoopback(appPort),
    canBindLoopback(previewPort),
  ]);
  const checks = [];
  checks.push(appAvailable
    ? doctorCheck({
        id: "app-port",
        title: "App loopback port",
        status: "pass",
        summary: `127.0.0.1:${appPort} is available.`,
      })
    : doctorCheck({
        id: "app-port",
        title: "App loopback port",
        status: "warn",
        summary: `127.0.0.1:${appPort} is already in use.`,
        action: "Stop the existing local service or choose another unreserved shell PORT for both doctor and dev/start.",
      }));
  checks.push(previewAvailable
    ? doctorCheck({
        id: "preview-port",
        title: "Preview loopback port",
        status: "pass",
        summary: `127.0.0.1:${previewPort} is available.`,
      })
    : doctorCheck({
        id: "preview-port",
        title: "Preview loopback port",
        status: "fail",
        summary: `127.0.0.1:${previewPort} is already in use.`,
        action: "Stop the existing service or set PREVIEW_PORT to another unreserved port.",
      }));
  return checks;
}

/**
 * Load a TypeScript module under the repo root as an ES module without a
 * build step, given its root-relative specifier (e.g. "config/clientProfile",
 * "orchestrator/secretStore").
 *
 * Each file is transpiled and imported as a data: URL. A data: URL module has
 * no directory, so neither the repository's "@/..." alias nor a plain "./x"
 * or "../x" relative import can resolve from inside it: every remaining
 * such specifier (type-only imports are already erased) is compiled the same
 * way and its data: URL spliced in before import. Until the validator gained
 * a value import from "@/types" this never came up, and the doctor then
 * reported "could not be loaded" on every correct install; the secret store
 * module's own relative import of its child-process registry needed the same
 * treatment extended to "./x"/"../x".
 *
 * @param {string} root
 * @param {string} specifier
 */
export async function importTypeScriptModule(root, specifier) {
  const typescriptImport = await import("typescript");
  const typescript = typescriptImport.default ?? typescriptImport;
  /** @type {Map<string, Promise<string>>} */
  const urls = new Map();

  /** @param {string} specifier a path relative to root, without extension */
  async function sourceFileFor(specifier) {
    for (const candidate of [`${specifier}.ts`, path.join(specifier, "index.ts")]) {
      const file = path.join(root, candidate);
      if (await fs.access(file).then(() => true, () => false)) return file;
    }
    throw new Error(`Cannot resolve module "${specifier}" from ${root}`);
  }

  /**
   * A module's own "./x" and "../x" imports are relative to that module's
   * directory, not to root — e.g. orchestrator/secretStore.ts importing
   * "./childProcessRegistry" means orchestrator/childProcessRegistry.
   *
   * @param {string} fromSpecifier the importing module's root-relative specifier
   * @param {string} raw the import text exactly as written: "@/x" or "./x"/"../x"
   */
  function resolveImportSpecifier(fromSpecifier, raw) {
    if (raw.startsWith("@/")) return raw.slice(2);
    return path.posix.normalize(path.posix.join(path.posix.dirname(fromSpecifier), raw));
  }

  /** @param {string} specifier */
  function moduleUrlFor(specifier) {
    let pending = urls.get(specifier);
    if (!pending) {
      pending = (async () => {
        const source = await fs.readFile(await sourceFileFor(specifier), "utf8");
        let output = typescript.transpileModule(source, {
          compilerOptions: {
            target: typescript.ScriptTarget.ES2022,
            module: typescript.ModuleKind.ES2022,
            sourceMap: false,
          },
        }).outputText;
        const imported = new Set(
          [...output.matchAll(/from\s+["'](@\/[^"']+|\.\.?\/[^"']+)["']/g)].map((m) => m[1]),
        );
        for (const raw of imported) {
          const inner = resolveImportSpecifier(specifier, raw);
          const url = JSON.stringify(await moduleUrlFor(inner));
          output = output.replaceAll(`"${raw}"`, url).replaceAll(`'${raw}'`, url);
        }
        return `data:text/javascript;base64,${Buffer.from(output).toString("base64")}`;
      })();
      urls.set(specifier, pending);
    }
    return pending;
  }

  return import(await moduleUrlFor(specifier));
}

/** @param {string} root */
export async function importCanonicalClientProfile(root) {
  return importTypeScriptModule(root, path.join("config", "clientProfile"));
}

/**
 * Prove the Linux sandbox on this host by running a script inside it: a write
 * into the declared write path must succeed, and /etc must not be visible.
 * Existence of /usr/bin/bwrap proves nothing; user namespaces can be off.
 * @param {string} root
 * @param {{ launch?: typeof import("../orchestrator/linuxProcessSandbox").linuxSandboxedNodeLaunch; timeoutMs?: number }=} deps
 *   `deps.launch` is injectable for tests; it defaults to the real
 *   `linuxSandboxedNodeLaunch`, loaded lazily so tests never need bwrap.
 *   `deps.timeoutMs` defaults to 30s.
 * @returns {Promise<{ ok: boolean; detail: string }>}
 */
export async function probeLinuxSandbox(root, deps = {}) {
  const timeoutMs = deps.timeoutMs ?? 30_000;
  const launchFn = deps.launch
    ?? (await importTypeScriptModule(root, "orchestrator/linuxProcessSandbox")).linuxSandboxedNodeLaunch;
  const probeDir = await fs.mkdtemp(path.join(os.tmpdir(), "council-doctor-sandbox-"));
  const out = path.join(probeDir, "out");
  await fs.mkdir(out, { mode: 0o700 });
  const script = path.join(probeDir, "probe.js");
  await fs.writeFile(script, [
    "const fs = require('fs');",
    "let wrote = false, hidden = false;",
    `try { fs.writeFileSync(${JSON.stringify(path.join(out, "ok.txt"))}, '1'); wrote = true; } catch {}`,
    "try { fs.readFileSync('/etc/passwd'); } catch { hidden = true; }",
    'process.stdout.write(JSON.stringify({ wrote, hidden }) + "\\n", () => process.exit(wrote && hidden ? 0 : 1));',
  ].join("\n"));
  let launch;
  try {
    launch = await launchFn(process.execPath, [script], {
      readPaths: [probeDir], writePaths: [out], network: "none", workingDirectory: probeDir,
    });
    return await new Promise((resolve) => {
      const child = spawn(launch.command, launch.args, { stdio: ["ignore", "pipe", "pipe"], env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: out, TMPDIR: out } });
      let output = "";
      let settled = false;
      child.stdout.on("data", (chunk) => { output += chunk; });
      child.stderr.on("data", (chunk) => { output += chunk; });
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGKILL");
        resolve({ ok: false, detail: `sandbox probe timed out: ${output.trim()}` });
      }, timeoutMs);
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok: false, detail: error.message });
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok: code === 0, detail: output.trim() });
      });
    });
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  } finally {
    if (launch?.cleanupPath) await fs.rm(launch.cleanupPath, { recursive: true, force: true });
    await fs.rm(probeDir, { recursive: true, force: true });
  }
}

/** @param {string} root @param {Record<string, string>} effectiveEnv */
async function profileChecks(root, effectiveEnv) {
  let profileModule;
  try {
    profileModule = await importCanonicalClientProfile(root);
  } catch {
    return {
      checks: [doctorCheck({
        id: "client-profile",
        title: "Client profile",
        status: "fail",
        summary: "The canonical client-profile validator could not be loaded.",
        action: "Run npm install and restore config/clientProfile.ts, then rerun the doctor.",
      })],
      profile: null,
      readiness: null,
    };
  }

  let profile;
  try {
    profile = await profileModule.loadClientProfile({ env: effectiveEnv, cwd: root });
  } catch (error) {
    const code = typeof error?.code === "string" ? error.code : "invalid-profile";
    const summaries = {
      "missing-profile": "No client profile is configured.",
      "invalid-profile": "The configured client profile is invalid.",
      "profile-too-large": "The configured client profile exceeds the safe size limit.",
      "unsafe-profile-file": "The configured client profile is not a safe regular file.",
      "profile-read-failed": "The configured client profile cannot be read.",
    };
    return {
      checks: [doctorCheck({
        id: "client-profile",
        title: "Client profile",
        status: "fail",
        summary: summaries[code] ?? "The configured client profile could not be validated.",
        action: "Copy config/client-profile.example.json to a private regular file, complete it, and set CAMPAIGN_COUNCIL_CLIENT_PROFILE to its path.",
      })],
      profile: null,
      readiness: null,
    };
  }

  const readiness = profileModule.getClientFeatureReadiness(profile);
  const developmentOnly = effectiveEnv.CAMPAIGN_COUNCIL_USE_DEVELOPMENT_PROFILE === "1"
    && !effectiveEnv.CAMPAIGN_COUNCIL_CLIENT_PROFILE?.trim();
  const checks = [doctorCheck({
    id: "client-profile",
    title: "Client profile",
    status: developmentOnly ? "warn" : "pass",
    summary: developmentOnly
      ? "The generic development profile is active; all external capabilities remain disabled."
      : "The configured profile passed the canonical schema and file-safety checks.",
    ...(developmentOnly ? {
      action: "Configure a real client profile before producing or publishing client work.",
    } : {}),
  })];

  for (const [stage, state] of Object.entries(readiness)) {
    checks.push(doctorCheck({
      id: `profile-${stage}`,
      title: `${stage.toUpperCase()} profile readiness`,
      status: state.enabled ? "pass" : "warn",
      summary: state.enabled
        ? "Required fields and explicit policy permission are present."
        : `Disabled. Missing fields: ${state.missingFields.join(", ") || "none"}. Policy blocks: ${state.policyBlocks.join(", ") || "none"}.`,
      ...(state.enabled ? {} : {
        action: "Leave this capability disabled unless the client has supplied every field and explicitly approved the policy switch.",
      }),
    }));
  }
  return { checks, profile, readiness };
}

export const NON_SALES_PAGE_ASSET_TYPES = Object.freeze([
  "premium-lead-page",
  "webinar-page",
  "squeeze-page",
  "upsell-page",
]);

/**
 * Every non-sales-page asset type reads its structure from a page-type
 * template file at runtime (orchestrator/pageTypeBlueprint.ts). The template
 * is optional in the sense that a missing file does not block a run, but a
 * missing file silently falls back to bare in-code instructions, so the
 * doctor surfaces it instead of staying quiet.
 *
 * The check is exactly as strict as that loader: a template counts only when
 * it is a regular file and not a symlink. A relative profile path resolves
 * against `root`, the same directory loadClientProfile loaded the profile
 * from, never against the directory the doctor happened to be launched in.
 *
 * @param {any} profile
 * @param {Record<string, string>} effectiveEnv
 * @param {string=} root
 */
export async function pageTypesCheck(profile, effectiveEnv, root = DEFAULT_ROOT) {
  if (!profile) {
    return doctorCheck({
      id: "page-types",
      title: "Page-type templates",
      status: "warn",
      summary: "Skipped because no valid client profile is loaded.",
      action: "Configure the client profile first, then rerun the doctor.",
    });
  }

  const configuredDir = profile.copy?.pageTypesDir;
  let dir = configuredDir;
  if (!dir) {
    const profilePath = effectiveEnv.CAMPAIGN_COUNCIL_CLIENT_PROFILE?.trim();
    if (profilePath && !profilePath.includes("\0")) {
      dir = path.join(path.dirname(path.resolve(root, profilePath)), "page-types");
    }
  }

  if (!dir) {
    return doctorCheck({
      id: "page-types",
      title: "Page-type templates",
      status: "warn",
      summary: "No page-types folder could be resolved, so page-type templates cannot be located.",
      action: "Set CAMPAIGN_COUNCIL_CLIENT_PROFILE to the client profile path, or set profile.copy.pageTypesDir explicitly.",
    });
  }

  const missing = [];
  for (const assetType of NON_SALES_PAGE_ASSET_TYPES) {
    const file = path.join(dir, `${assetType}.md`);
    // lstat, not access: access follows symlinks and accepts directories, and
    // the runtime loader refuses both.
    const entry = await fs.lstat(file).catch(() => undefined);
    const regular = entry !== undefined && !entry.isSymbolicLink() && entry.isFile();
    const readable = regular && await fs.access(file, fsConstants.R_OK).then(() => true, () => false);
    if (!readable) missing.push(assetType);
  }

  if (missing.length > 0) {
    return doctorCheck({
      id: "page-types",
      title: "Page-type templates",
      status: "warn",
      summary: `Missing, unreadable, symlinked or non-regular page-type template file(s) in ${dir}: ${missing.join(", ")}.`,
      action: "Run setup.sh to install the default templates, or set profile.copy.pageTypesDir to a folder that already has them.",
    });
  }

  return doctorCheck({
    id: "page-types",
    title: "Page-type templates",
    status: "pass",
    summary: `All ${NON_SALES_PAGE_ASSET_TYPES.length} page-type templates are present and readable in ${dir}.`,
  });
}

/**
 * Stage 5 executes generated Next.js code inside a native sandbox: the macOS
 * Seatbelt sandbox on Darwin, bubblewrap on Linux (including WSL2). There is
 * deliberately no unsandboxed fallback on any other platform.
 *
 * @param {any} readiness
 * @param {string=} platform
 * @param {{ probe?: () => Promise<{ ok: boolean; detail: string }>, accepted?: () => boolean, loadSwitch?: () => Promise<{ linuxLandingAccepted: () => boolean }> }=} deps injectable for tests; defaults to the real probe and release switch
 */
export async function stage5SandboxCheck(readiness, platform = process.platform, deps = {}) {
  const enabled = readiness?.stage5?.enabled === true;
  if (platform === "linux") {
    // The same switch the three runtime gates read. A working sandbox is not
    // enough: with the switch closed every landing run stops on
    // "awaiting acceptance", and the doctor exists to say so beforehand.
    // The switch module is loaded here, guarded, like the secret-store module:
    // a partial unpack must cost one FAIL line, not the whole report.
    let accepted;
    if (deps.accepted) {
      accepted = deps.accepted();
    } else {
      let acceptance;
      try {
        acceptance = await (deps.loadSwitch ?? (() => import("../lib/platformAcceptance.mjs")))();
      } catch {
        return doctorCheck({
          id: "stage5-native-sandbox",
          title: "Stage 5 sandbox (bubblewrap)",
          status: enabled ? "fail" : "warn",
          summary: "The release switch module lib/platformAcceptance.mjs could not be loaded, so Linux/WSL landing execution counts as not accepted.",
          action: "Restore lib/platformAcceptance.mjs and config/platform-acceptance.json from the released package, then rerun the doctor.",
        });
      }
      accepted = acceptance.linuxLandingAccepted();
    }
    if (!accepted) {
      return doctorCheck({
        id: "stage5-native-sandbox",
        title: "Stage 5 sandbox (bubblewrap)",
        status: enabled ? "fail" : "warn",
        summary: "Linux/WSL landing execution is awaiting acceptance, so Stage 5 would stop before the sandbox is reached.",
        action: 'Restore config/platform-acceptance.json from the released package (it must contain "linuxLanding": true), or run Stage 5 on macOS.',
      });
    }
    const probe = deps.probe ?? (() => probeLinuxSandbox(DEFAULT_ROOT));
    const result = await probe();
    return doctorCheck({
      id: "stage5-native-sandbox",
      title: "Stage 5 sandbox (bubblewrap)",
      status: result.ok ? "pass" : (enabled ? "fail" : "warn"),
      summary: result.ok
        ? "A probe ran inside the Linux sandbox: the declared write path was writable and /etc was hidden."
        : `The Linux sandbox probe failed: ${result.detail}`,
      action: result.ok
        ? "None."
        : "Install bubblewrap (sudo apt-get install bubblewrap) and confirm unprivileged user namespaces are enabled (sysctl kernel.unprivileged_userns_clone). On WSL2, run inside the Linux filesystem, not under /mnt.",
    });
  }
  if (platform !== "darwin") {
    return doctorCheck({
      id: "stage5-native-sandbox",
      title: "Stage 5 native sandbox",
      status: macOnlyCapabilityStatus(platform, enabled),
      summary: enabled
        ? "Stage 5 is enabled, but generated landing-page execution is supported only on macOS or Ubuntu inside WSL2."
        : "Stage 5 generated-code execution is unavailable on this operating system and remains disabled.",
      action: enabled
        ? "Run the full Stage 5 workflow on macOS or Ubuntu inside WSL2, or disable policies.capabilities.landingPageBuild."
        : "Use macOS or Ubuntu inside WSL2 before enabling policies.capabilities.landingPageBuild.",
    });
  }

  try {
    const stat = await fs.lstat("/usr/bin/sandbox-exec");
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("unsafe sandbox executable");
    await fs.access("/usr/bin/sandbox-exec", fsConstants.R_OK | fsConstants.X_OK);
  } catch {
    return doctorCheck({
      id: "stage5-native-sandbox",
      title: "Stage 5 native sandbox",
      status: enabled ? "fail" : "warn",
      summary: "The required macOS sandbox-exec executable is unavailable or unsafe.",
      action: enabled
        ? "Do not run Stage 5 on this Mac. Restore the standard macOS sandbox facility or disable landing-page builds."
        : "Keep Stage 5 disabled on this Mac.",
    });
  }

  return doctorCheck({
    id: "stage5-native-sandbox",
    title: "Stage 5 native sandbox",
    status: "pass",
    summary: enabled
      ? "The required macOS sandbox executable is present and Stage 5 is enabled."
      : "The required macOS sandbox executable is present; Stage 5 remains disabled by configuration.",
  });
}

/**
 * Stage 8 deliberately reads its Meta token from the host's own secret store
 * (macOS Keychain, Windows Credential Manager reached from WSL2, or
 * secret-tool on Linux) through the existence probe only, so this check never
 * asks the store to print the secret. When the probe's own command could
 * otherwise print the value (Linux's secret-tool "lookup", reused for its
 * exit code), `probe.discardStdout` tells runCommand to spawn with stdout set
 * to "ignore" — the value never exists as a string inside this process.
 *
 * The module load is guarded: a missing or broken orchestrator/secretStore.ts
 * (e.g. a fresh checkout before `npm install`, or a corrupted working tree)
 * must fail this one check closed, the same way profileChecks already
 * degrades for config/clientProfile.ts, not crash the whole doctor run.
 *
 * @param {any} profile
 * @param {any} readiness
 * @param {string=} platform
 * @param {boolean=} wsl
 * @param {typeof importTypeScriptModule=} load injectable for tests; defaults to the real loader
 * @param {string=} root the checkout to load the module from, as runDoctor was pointed at
 */
export async function secretStoreCheck(profile, readiness, platform = process.platform, wsl = undefined, load = importTypeScriptModule, root = DEFAULT_ROOT) {
  const enabled = readiness?.stage8?.enabled === true || readiness?.stage9?.enabled === true;
  const title = "Meta token in the host secret store";
  let secretStoreModule;
  try {
    secretStoreModule = await load(root, "orchestrator/secretStore");
  } catch {
    return doctorCheck({ id: "meta-keychain", title, status: enabled ? "fail" : "warn",
      summary: "The secret store module could not be loaded.",
      action: "Run npm install and restore orchestrator/secretStore.ts, then rerun the doctor." });
  }
  const { detectSecretBackend, secretExistsCommand, installHint } = secretStoreModule;
  const backend = detectSecretBackend(platform, wsl);
  if (!backend) {
    return doctorCheck({ id: "meta-keychain", title, status: enabled ? "fail" : "warn",
      summary: "This operating system has no supported secret store; Meta verification stays disabled.",
      action: installHint(undefined) });
  }
  const service = profile?.meta?.tokenKeychainService;
  if (!service) {
    return doctorCheck({ id: "meta-keychain", title, status: "warn",
      summary: "No secret service name is configured; Stage 8 remains disabled.",
      action: `When enabling Stage 8, store the approved token (${backend}) and set meta.tokenKeychainService in the private client profile.` });
  }
  // No Windows PowerShell reachable from this distro (interop off, or a
  // non-default automount root with no PATH entry) would otherwise read as
  // "item not found" and send the operator to re-store a credential that is
  // already there.
  const { resolveWindowsPowerShell, WINDOWS_INTEROP_MISSING } = secretStoreModule;
  // Building the probe can reject the configured name outright: on WSL2 the
  // PowerShell script refuses a control character (a name copy-pasted from a
  // password manager keeps its newline). This check is awaited inside
  // Promise.all, so an escaping throw would cost the operator the whole
  // report instead of one FAIL line. The name itself is never echoed.
  let response;
  try {
    const probe = secretExistsCommand(backend, service);
    if (backend === "windows-credential-manager" && typeof resolveWindowsPowerShell === "function" && !resolveWindowsPowerShell()) {
      return doctorCheck({ id: "meta-keychain", title, status: enabled ? "fail" : "warn",
        summary: "Windows PowerShell is not reachable from this WSL2 distro, so the Credential Manager cannot be read; the configured item may well exist.",
        action: WINDOWS_INTEROP_MISSING });
    }
    response = await runCommand(probe.command, probe.args, { env: probe.env, discardStdout: probe.discardStdout === true });
  } catch (error) {
    return doctorCheck({ id: "meta-keychain", title, status: enabled ? "fail" : "warn",
      summary: `The configured meta.tokenKeychainService could not be used with ${backend}: ${error instanceof Error ? error.message : String(error)}`,
      action: "Set meta.tokenKeychainService in the private client profile to the plain service name, with no line breaks or other control characters." });
  }
  if (!response.ok) {
    return doctorCheck({ id: "meta-keychain", title, status: enabled ? "fail" : "warn",
      summary: `The configured item was not found in ${backend}. No secret value was requested or printed.`,
      action: installHint(backend) });
  }
  return doctorCheck({ id: "meta-keychain", title, status: enabled ? "pass" : "warn",
    summary: `The configured item exists in ${backend}; its value was not read by the doctor.`,
    action: enabled ? "None." : "Enable the Meta capability switches when ready." });
}

function minimalGitEnvironment() {
  const allowed = ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "SYSTEMROOT"];
  const env = { GIT_OPTIONAL_LOCKS: "0" };
  for (const key of allowed) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

/**
 * Optional because stages 1 to 4 can run without a landing-page repository.
 * When Stage 5 is enabled, every issue found here is blocking.
 *
 * @param {string} root
 * @param {Record<string, string>} effectiveEnv
 * @param {any} profile
 * @param {any} readiness
 */
async function landingWorkspaceCheck(root, effectiveEnv, profile, readiness) {
  if (!profile) {
    return doctorCheck({
      id: "landing-workspace",
      title: "Landing workspace",
      status: "warn",
      summary: "Skipped because no valid client profile is loaded.",
      action: "Configure the client profile first, then rerun the doctor.",
    });
  }
  const configuredPath = profile.landing?.workspacePath;
  if (!configuredPath) {
    return doctorCheck({
      id: "landing-workspace",
      title: "Landing workspace",
      status: "warn",
      summary: "No landing workspace is configured; Stage 5 remains disabled.",
      action: "This is safe. Configure a workspace only when the client approves local landing-page builds.",
    });
  }

  const workspace = path.resolve(configuredPath);
  const runtimeWorkspace = path.resolve(
    effectiveEnv.LANDING_PAGES_DIR?.trim() || path.join(os.homedir(), "landing-pages"),
  );
  if (workspace !== runtimeWorkspace) {
    return doctorCheck({
      id: "landing-workspace",
      title: "Landing workspace",
      status: "fail",
      summary: "The profile workspace and LANDING_PAGES_DIR runtime workspace do not match.",
      action: "Set LANDING_PAGES_DIR to the same absolute path declared in the client profile.",
    });
  }

  let stat;
  try {
    stat = await fs.lstat(workspace);
  } catch {
    return doctorCheck({
      id: "landing-workspace",
      title: "Landing workspace",
      status: "fail",
      summary: "The configured landing workspace does not exist or cannot be inspected.",
      action: "Create or clone the approved landing repository at the configured path, then run npm install inside it.",
    });
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    return doctorCheck({
      id: "landing-workspace",
      title: "Landing workspace",
      status: "fail",
      summary: "The landing workspace must be a real directory, not a file or symbolic link.",
      action: "Point both profile and LANDING_PAGES_DIR at the real repository directory.",
    });
  }
  try {
    await fs.access(workspace, fsConstants.R_OK | fsConstants.W_OK | fsConstants.X_OK);
    for (const required of ["package.json", ".git", path.join("src", "app"), "public"]) {
      await fs.access(path.join(workspace, required), fsConstants.R_OK);
    }
    const nextBinary = path.join(
      workspace,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "next.cmd" : "next",
    );
    await fs.access(nextBinary, fsConstants.R_OK | (process.platform === "win32" ? 0 : fsConstants.X_OK));
  } catch {
    return doctorCheck({
      id: "landing-workspace",
      title: "Landing workspace",
      status: "fail",
      summary: "The repository is missing required Next.js folders, Git metadata, write access, or installed dependencies.",
      action: "Verify package.json, src/app, public, and .git, then run npm install inside the landing repository.",
    });
  }

  const declaredRealPath = await fs.realpath(workspace);
  for (const [field, relativeFile] of [
    ["landing.designStandardPath", profile.landing?.designStandardPath],
    ["landing.qaScriptPath", profile.landing?.qaScriptPath],
  ]) {
    if (!relativeFile) continue;
    const candidatePath = path.resolve(declaredRealPath, ...relativeFile.split("/"));
    const relative = path.relative(declaredRealPath, candidatePath);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      return doctorCheck({
        id: "landing-workspace",
        title: "Landing workspace",
        status: "fail",
        summary: `${field} escapes the configured landing workspace.`,
        action: "Choose a regular file contained by the approved landing repository.",
      });
    }
    try {
      const fileStat = await fs.lstat(candidatePath);
      const realFile = await fs.realpath(candidatePath);
      const realRelative = path.relative(declaredRealPath, realFile);
      if (
        !fileStat.isFile() ||
        fileStat.isSymbolicLink() ||
        fileStat.size > 512 * 1024 ||
        realRelative === ".." ||
        realRelative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(realRelative)
      ) {
        throw new Error("unsafe workspace file");
      }
      await fs.access(realFile, fsConstants.R_OK);
    } catch {
      return doctorCheck({
        id: "landing-workspace",
        title: "Landing workspace",
        status: "fail",
        summary: `${field} is missing, unsafe, unreadable, or larger than 512KB.`,
        action: "Point the profile field at a regular file contained by the approved landing repository.",
      });
    }
  }

  const gitEnv = minimalGitEnvironment();
  const rootResponse = await runCommand(
    "git",
    ["--no-optional-locks", "-C", workspace, "rev-parse", "--show-toplevel"],
    { env: gitEnv },
  );
  if (!rootResponse.ok) {
    return doctorCheck({
      id: "landing-workspace",
      title: "Landing workspace",
      status: "fail",
      summary: "Git cannot validate the landing workspace.",
      action: "Install Git and verify that the configured workspace is a repository.",
    });
  }
  const gitRealPath = await fs.realpath(rootResponse.stdout.trim()).catch(() => "");
  if (!gitRealPath || declaredRealPath !== gitRealPath) {
    return doctorCheck({
      id: "landing-workspace",
      title: "Landing workspace",
      status: "fail",
      summary: "The configured directory is not the root of its Git repository.",
      action: "Set the workspace path to the repository root.",
    });
  }
  const statusResponse = await runCommand(
    "git",
    ["--no-optional-locks", "-C", workspace, "status", "--porcelain", "--untracked-files=normal"],
    { env: gitEnv },
  );
  if (!statusResponse.ok) {
    return doctorCheck({
      id: "landing-workspace",
      title: "Landing workspace",
      status: "fail",
      summary: "Git status could not be read safely.",
      action: "Repair the repository before enabling Stage 5.",
    });
  }
  const changedCount = statusResponse.stdout.split(/\r?\n/).filter(Boolean).length;
  if (changedCount > 0) {
    return doctorCheck({
      id: "landing-workspace",
      title: "Landing workspace",
      status: "warn",
      summary: `The base landing repository has ${changedCount} uncommitted or untracked path(s). Stage 5 uses an isolated worktree from committed HEAD, so those local changes will not be included. Filenames were not printed.`,
      action: "Commit the intended base changes before Stage 5 if they should appear in the generated page.",
    });
  }
  return doctorCheck({
    id: "landing-workspace",
    title: "Landing workspace",
    status: readiness?.stage5?.enabled ? "pass" : "warn",
    summary: readiness?.stage5?.enabled
      ? "The configured Next.js repository, design standard, and QA script are installed and ready."
      : "The repository is ready, but Stage 5 remains disabled by client policy.",
    ...(readiness?.stage5?.enabled ? {} : {
      action: "Keep it disabled until the client explicitly approves landing-page builds.",
    }),
  });
}

/**
 * Run all local diagnostics. The function returns data instead of exiting so it
 * can be embedded by a future setup UI.
 *
 * @param {{ root?: string }=} options
 * @returns {Promise<DoctorCheck[]>}
 */
export async function runDoctor(options = {}) {
  const root = path.resolve(options.root ?? DEFAULT_ROOT);
  let effectiveEnv;
  try {
    effectiveEnv = await loadRelevantEnvironment(root);
  } catch {
    return [doctorCheck({
      id: "environment",
      title: "Local environment",
      status: "fail",
      summary: ".env or .env.local could not be read safely.",
      action: "Fix file ownership and read permissions, then rerun the doctor.",
    })];
  }

  const [npmResult, claudeResult, playwrightResult, pythonResult, dataResult, portsResult, profileResult] = await Promise.all([
    npmCheck(),
    claudeChecks(),
    playwrightCheck(),
    pythonChecks(root),
    dataDirectoryChecks(root, effectiveEnv),
    portChecks(effectiveEnv),
    profileChecks(root, effectiveEnv),
  ]);
  const [landingResult, stage5SandboxResult, metaKeychainResult, pageTypesResult, mockupBrowserResult] = await Promise.all([
    landingWorkspaceCheck(
      root,
      effectiveEnv,
      profileResult.profile,
      profileResult.readiness,
    ),
    stage5SandboxCheck(profileResult.readiness),
    secretStoreCheck(profileResult.profile, profileResult.readiness, undefined, undefined, undefined, root),
    pageTypesCheck(profileResult.profile, effectiveEnv, root),
    mockupBrowserCheck(profileResult.readiness, effectiveEnv),
  ]);

  const subscriptionResult = await claudeSubscriptionCheck();
  return [
    nodeCheck(),
    processTreePlatformCheck(),
    npmResult,
    claudeApiEnvironmentCheck(effectiveEnv),
    metaGraphApiVersionCheck(effectiveEnv),
    ...claudeResult,
    subscriptionResult,
    playwrightResult,
    mockupBrowserResult,
    ...pythonResult,
    ...dataResult,
    ...portsResult,
    ...profileResult.checks,
    pageTypesResult,
    stage5SandboxResult,
    landingResult,
    metaKeychainResult,
  ];
}

function printHelp() {
  process.stdout.write([
    "Usage: node scripts/doctor.mjs",
    "",
    "Runs read-only local installation and safety checks.",
    "Exit code 0 means no blocking failures; warnings may remain for disabled optional features.",
    "Exit code 1 means one or more required checks failed.",
    "",
  ].join("\n"));
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }
  if (args.length > 0) {
    process.stderr.write("doctor does not accept positional arguments. Use --help for usage.\n");
    process.exitCode = 2;
    return;
  }
  const checks = await runDoctor();
  process.stdout.write(`${formatDoctorReport(checks)}\n`);
  process.exitCode = checks.some((check) => check.status === "fail") ? 1 : 0;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  main().catch(() => {
    process.stderr.write("The doctor stopped because of an unexpected internal error. No changes were made.\n");
    process.exitCode = 2;
  });
}
