#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { linuxLandingAccepted } from "../lib/platformAcceptance.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export function clientIdFromName(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 63).replace(/-$/, "") || "client";
}

export function defaultClientDirectory(id, { platform = process.platform, home = os.homedir(), xdgDataHome = process.env.XDG_DATA_HOME } = {}) {
  const base = platform === "darwin"
    ? path.join(home, "Library", "Application Support", "Campaign Council Clients")
    : path.join(xdgDataHome && path.isAbsolute(xdgDataHome) ? xdgDataHome : path.join(home, ".local", "share"), "campaign-council-clients");
  return path.join(base, id);
}

/**
 * Where landing builds may be switched on: macOS, or Linux/WSL2 once the
 * release switch is open. The interactive wizard and configureClient's own
 * refusal read the same rule, so the wizard never hides a question whose
 * answer would be accepted (a WSL2 install used to be created with the
 * capability off and no question asked).
 */
export function landingQuestionOffered(platform, linuxAccepted) {
  return platform === "darwin" || (platform === "linux" && linuxAccepted === true);
}

async function exists(file) {
  try { await fs.lstat(file); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function validateNewDirectory(directory, projectRoot, home) {
  if (!path.isAbsolute(directory) || /[\r\n\0$"\\]/.test(directory)) {
    throw new Error("Use an absolute installation directory without quotes, $, backslashes or control characters.");
  }
  const target = path.normalize(directory);
  if ([path.parse(target).root, home, os.tmpdir(), path.dirname(home)].includes(target)
    || inside(projectRoot, target) || inside(target, projectRoot)) {
    throw new Error("Choose a dedicated client directory outside the application repository.");
  }
  for (let current = target; ; current = path.dirname(current)) {
    if (await exists(current)) {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Directory path contains a symlink or non-directory: ${current}`);
    }
    if (path.dirname(current) === current) break;
  }
  if (await exists(target)) throw new Error(`Installation directory already exists; nothing was overwritten: ${target}`);
  return target;
}

function run(command, args, cwd) {
  // Never inherit a caller's alternate Git directory, index or worktree.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  execFileSync(command, args, { cwd, env, stdio: "inherit" });
}

/** Creates only new private paths. Existing profiles, repositories and .env.local are never replaced. */
export async function configureClient(options, dependencies = {}) {
  const projectRoot = await fs.realpath(dependencies.projectRoot ?? PROJECT_ROOT);
  const platform = dependencies.platform ?? process.platform;
  const home = dependencies.home ?? os.homedir();
  const execute = dependencies.run ?? run;
  if (platform !== "darwin" && platform !== "linux") throw new Error("Use macOS or Ubuntu inside WSL2. Native Windows is not supported.");
  const name = options.name?.trim();
  const fact = options.fact?.trim();
  const id = options.id ?? clientIdFromName(name ?? "");
  if (!name || name.length > 160) throw new Error("Provide a client name (1–160 characters).");
  if (!fact || fact.length > 1_000) throw new Error("Provide one verified business fact (1–1000 characters).");
  if (!ID_PATTERN.test(id) || id.length > 63) throw new Error("Client ID must use lowercase letters, digits and internal hyphens (maximum 63 characters).");
  const linuxAccepted = dependencies.linuxAccepted ?? linuxLandingAccepted();
  if (options.enableLanding && !landingQuestionOffered(platform, linuxAccepted)) {
    throw new Error("Landing builds on WSL2/Linux are awaiting acceptance. Omit --enable-landing, or run on macOS.");
  }
  const locale = options.locale ?? "he-IL";
  const timezone = options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  new Intl.Locale(locale);
  new Intl.DateTimeFormat(locale, { timeZone: timezone });
  const pipeline = options.pipeline ?? "direct";
  if (!["direct", "council"].includes(pipeline)) throw new Error("Pipeline must be direct or council.");
  const previewPort = Number(options.previewPort ?? 4322);
  if (!Number.isInteger(previewPort) || previewPort < 1024 || previewPort > 65535) throw new Error("Preview port must be between 1024 and 65535.");
  const envPath = path.join(projectRoot, ".env.local");
  if (await exists(envPath)) throw new Error(".env.local already exists; existing installation preserved. Use a separate application clone for another client.");
  const directory = await validateNewDirectory(options.directory ?? defaultClientDirectory(id, { platform, home }), projectRoot, home);
  const workspacePath = path.join(directory, "landing");
  const profilePath = path.join(directory, "profile.json");
  const standards = path.join(directory, "standards");
  const dataDirectory = path.join(directory, "data");
  const gitConfig = ["-c", "core.hooksPath=/dev/null", "-c", "core.excludesFile=/dev/null", "-c", "commit.gpgSign=false", "-c", "user.name=Campaign Council Setup", "-c", "user.email=setup@localhost"];

  await fs.mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });
  await fs.mkdir(directory, { mode: 0o700 });
  try {
    const privateDirectory = await fs.stat(directory);
    if ((privateDirectory.mode & 0o077) !== 0) {
      throw new Error("The destination does not support private directory permissions. In WSL2, choose a directory inside the Linux home filesystem.");
    }
    await fs.mkdir(dataDirectory, { mode: 0o700 });
    await fs.mkdir(standards, { mode: 0o700 });
    for (const name of ["copy-standard", "ads-standard", "creative-standard"]) {
      await fs.copyFile(path.join(projectRoot, "config", "standards", `${name}.default.md`), path.join(standards, `${name}.md`));
    }
    await fs.mkdir(path.join(standards, "page-types"));
    for (const name of ["premium-lead-page", "webinar-page", "squeeze-page", "upsell-page"]) {
      await fs.copyFile(path.join(projectRoot, "config", "standards", "page-types", `${name}.default.md`), path.join(standards, "page-types", `${name}.md`));
    }
    await fs.cp(path.join(projectRoot, "templates", "landing"), workspacePath, { recursive: true });
    await fs.cp(path.join(projectRoot, "vendor", "landing-skill"), path.join(workspacePath, ".agents", "skills", "landing-design-agent"), { recursive: true });
    // Under src/, not public/: globals.css imports it relatively so the bundler
    // serves it from /_next/static, inside the preview render policy.
    await fs.mkdir(path.join(workspacePath, "src", "fonts"), { recursive: true });
    await fs.copyFile(path.join(projectRoot, "assets", "fonts", "Heebo.ttf"), path.join(workspacePath, "src", "fonts", "Heebo.ttf"));
    await execute("git", [...gitConfig, "init", "-q", "-b", "main", "--template="], workspacePath);
    await execute("git", [...gitConfig, "add", "--all"], workspacePath);
    await execute("git", [...gitConfig, "commit", "-q", "-m", "Initialize neutral landing workspace"], workspacePath);
    await execute("npm", ["ci", "--no-audit", "--no-fund"], workspacePath);

    const profile = JSON.parse(await fs.readFile(path.join(projectRoot, "config", "client-profile.example.json"), "utf8"));
    profile.tenant = { id, displayName: name, locale, timezone };
    profile.brand = { publicName: name, legalName: null, facts: [fact] };
    profile.pipeline = { default: pipeline, criticMaxRounds: 3 };
    profile.copy = {
      standardPath: path.join(standards, "copy-standard.md"),
      adsStandardPath: path.join(standards, "ads-standard.md"),
      pageTypesDir: path.join(standards, "page-types"),
      voice: { firstPerson: "presenter" },
    };
    profile.creative.standardPath = path.join(standards, "creative-standard.md");
    profile.policies.capabilities.landingPageBuild = Boolean(options.enableLanding);
    profile.landing = {
      ...profile.landing,
      workspacePath,
      designStandardPath: ".agents/skills/landing-design-agent/SKILL.md",
      qaScriptPath: ".agents/skills/landing-design-agent/scripts/landing-qa.mjs",
    };
    await fs.writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    let env = await fs.readFile(path.join(projectRoot, ".env.example"), "utf8");
    for (const [key, value] of Object.entries({
      CAMPAIGN_COUNCIL_CLIENT_PROFILE: profilePath,
      CAMPAIGN_COUNCIL_DATA_DIR: dataDirectory,
      LANDING_PAGES_DIR: workspacePath,
      PREVIEW_PORT: String(previewPort),
    })) env = env.replace(new RegExp(`^${key}=.*$`, "m"), `${key}=${JSON.stringify(value)}`);
    await fs.writeFile(envPath, env, { flag: "wx", mode: 0o600 });
    return { directory, workspacePath, profilePath, dataDirectory, envPath, landingEnabled: Boolean(options.enableLanding) };
  } catch (error) {
    // This directory was exclusively created by this invocation. Nothing in a
    // previously existing installation is removed, including a concurrent env.
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function main() {
  const options = {};
  const names = { "--name": "name", "--id": "id", "--fact": "fact", "--directory": "directory", "--locale": "locale", "--timezone": "timezone", "--pipeline": "pipeline", "--preview-port": "previewPort" };
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log("Usage: npm run configure -- [--name NAME --id client-id --fact VERIFIED_FACT --directory /absolute/new-directory] [--enable-landing] [--locale he-IL] [--timezone Asia/Jerusalem] [--pipeline direct|council] [--preview-port 4322]\nWithout flags, prompts guide setup. Landing builds may be enabled on macOS or Ubuntu inside WSL2; other optional integrations remain disabled. Existing configuration is never overwritten.");
    return;
  }
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--enable-landing") options.enableLanding = true;
    else if (names[args[index]] && args[index + 1] && !args[index + 1].startsWith("--")) options[names[args[index]]] = args[++index];
    else throw new Error(`Unknown or incomplete option: ${args[index]}`);
  }
  if (process.stdin.isTTY) {
    const readline = createInterface({ input: process.stdin, output: process.stdout });
    try {
      options.name ??= await readline.question("שם העסק / client name: ");
      const suggestedId = clientIdFromName(options.name);
      options.id ??= (await readline.question(`מזהה באנגלית / client ID [${suggestedId}]: `)).trim() || suggestedId;
      options.fact ??= await readline.question("עובדה מאומתת על העסק וההצעה / verified business fact: ");
      const suggestedDirectory = defaultClientDirectory(options.id);
      options.directory ??= (await readline.question(`תיקייה פרטית חדשה / new private directory [${suggestedDirectory}]: `)).trim() || suggestedDirectory;
      if (options.enableLanding === undefined && landingQuestionOffered(process.platform, linuxLandingAccepted())) {
        options.enableLanding = /^(y|yes|כן)$/i.test((await readline.question("לאפשר בניית דפים מקומית? / enable local landing builds? [y/N]: ")).trim());
      }
    } finally { readline.close(); }
  }
  const result = await configureClient(options);
  console.log(`\nClient profile: ${result.profilePath}\nPrivate data: ${result.dataDirectory}\nLanding Git workspace: ${result.workspacePath}\nLanding builds: ${result.landingEnabled ? "enabled (doctor must pass before running)" : "disabled"}\n\nNext: npm run doctor\nThen: npm run dev\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(`Setup stopped: ${error.message}`); process.exitCode = 1; });
}
