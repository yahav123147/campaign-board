#!/usr/bin/env node
// Proves, in one short agent turn, that the Claude CLI's own Bash sandbox
// works on this machine with the settings stage 5.2 hands it. Stage 5.2
// takes a quarter of an hour to reach that point; this takes a minute and
// prints the CLI's stderr when the sandbox refuses, which the stage log only
// shows as the agent's own words.
//
// Usage: node scripts/ci-agent-sandbox-smoke.mjs <assetsDir> <landingWorkspace>
// Exit 0 when the agent ran `id -u` inside the sandbox and reported a number.

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const [assetsDir, landingWorkspace] = process.argv.slice(2);
if (!assetsDir || !landingWorkspace) {
  console.error("usage: ci-agent-sandbox-smoke.mjs <assetsDir> <landingWorkspace>");
  process.exit(2);
}
await fs.mkdir(assetsDir, { recursive: true });

const venv = path.join(os.homedir(), ".campaign-council-venv");
const pythonRoot = await fs.access(path.join(venv, "bin", "python3")).then(() => venv, () => undefined);

// The same shape orchestrator/runStage5Assets.ts buildAssetSandboxSettings
// produces (enabled, fail closed, home denied, WSL host paths denied, only
// named directories readable, no network, unix sockets blocked). Built here
// rather than imported: that module's import graph does not load through
// the doctor's data-URL loader (an unsettled top-level await, run
// 35757921546), and the smoke must never hang on the loader.
const allowRead = [
  path.resolve(assetsDir),
  path.join(process.cwd(), "scripts"),
  path.join(process.cwd(), "vendor", "landing-skill", "scripts"),
  path.join(landingWorkspace, ".agents", "skills"),
  path.join(landingWorkspace, "node_modules"),
  ...(pythonRoot ? [pythonRoot] : []),
];
const settings = {
  sandbox: {
    enabled: true,
    failIfUnavailable: true,
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: false,
    filesystem: {
      denyRead: [os.homedir(), "/mnt", "/media", "/init", "/run/WSL"],
      allowRead,
    },
    network: { allowedDomains: [], allowLocalBinding: false, allowAllUnixSockets: false },
  },
};
const settingsSource = "mirror of buildAssetSandboxSettings (stage 5.2)";
console.log(`settings from: ${settingsSource}`);
console.log(`sandbox keys: ${Object.keys(settings.sandbox).join(", ")}`);

const env = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  LANG: process.env.LANG,
  CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  NODE_ENV: "production",
  DISABLE_AUTOUPDATER: "1",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
};
const args = [
  "-p", "--input-format", "text", "--no-session-persistence",
  "--permission-mode", "dontAsk",
  "--tools", "Bash",
  "--strict-mcp-config",
  "--setting-sources", "",
  "--disable-slash-commands",
  "--settings", JSON.stringify(settings),
];
console.log(`user: uid ${process.getuid?.()} ${os.userInfo().username}; cwd ${process.cwd()}`);

const started = Date.now();
const child = spawn("claude", args, { env, cwd: assetsDir, stdio: ["pipe", "pipe", "pipe"] });
let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => { stdout += chunk; });
child.stderr.on("data", (chunk) => { stderr += chunk; });
const timer = setTimeout(() => child.kill("SIGKILL"), 180_000);
child.stdin.end("Use the Bash tool to run the command `id -u` and then reply with only the number it printed, nothing else. If the tool call fails, reply with the word FAILED followed by the exact error text.");
const code = await new Promise((resolve) => child.on("close", resolve));
clearTimeout(timer);

console.log(`claude exited ${code} after ${Math.round((Date.now() - started) / 1000)}s`);
console.log(`stdout (first 1200 chars):\n${stdout.slice(0, 1200)}`);
console.log(`stderr (first 2000 chars):\n${stderr.slice(0, 2000)}`);
const ok = code === 0 && /^\s*\d+\s*$/.test(stdout);
console.log(ok ? "AGENT SANDBOX: OK (Bash ran inside the CLI sandbox)" : "AGENT SANDBOX: FAILED");
process.exit(ok ? 0 : 1);
