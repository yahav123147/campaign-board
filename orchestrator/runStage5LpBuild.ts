import path from "node:path";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import {
  captureWidthFromFile,
  planStrips,
  pngPixelSize,
  renderShotList,
  type ShotGroup,
} from "./shotStrips";
import { resolvePython } from "./runStage7Creatives";
import { spawnAgent } from "./spawnAgent";
import { loadAgents } from "./loadAgents";
import { eventBus } from "./eventBus";
import { getRun, updateRun } from "./runRegistry";
import { appendLog, saveRunArtifact } from "@/lib/runStore";
import {
  previewUrlFor,
  collectRenderedAssetUrls,
  collectVisibleImages,
  ensurePreviewServer,
  measureTextDeserts,
  stopPreview,
  waitForPage,
  shoot,
} from "./previewServer";
import {
  authorizeReferenceProject,
  readDesignStandard,
  readFullDesignStandard,
  readVerdict,
  type Verdict,
  parseReference,
  type ReferenceProject,
} from "./designStandard";
import {
  assertManagedDirectory,
  copyApprovedAssets,
  readApprovedAssetPlacement,
  removeManagedChildDirectory,
  verifyPreparedAssets,
  type AssetPlacement,
  type MappedAsset,
} from "./assetQuality";
import {
  assertOnlyAllowedGitPaths,
  assertPageSourceHasNoEmbeddedMedia,
  assertRenderedImageUrls,
  sealPageSourceTree,
} from "./pagePostflight";
import {
  imageMapCheckIsCurrent,
  renderDesertSummary,
  renderDesertWarning,
  runImageMapCheck,
  type DesertStatus,
} from "./imageMapCheck";
import type { AgentSlug, AssetType, ImageMapCheck, Run } from "@/types";
import { agentTimeoutMs } from "./executionService";
import type { ExecutionControl } from "./executionService";
import { parseDesignBriefJson } from "./designBriefJson";
import { assertClientFeatureReady } from "./stage89Safety";
import {
  prepareLandingWorktree,
  runLandingGit as runGitInRepository,
} from "./landingWorktree";
import { prepareLinuxSandboxFiles, sandboxedNodeLaunch } from "./processSandbox";
import { renderClientContext } from "./clientContext";
import { readRunPageTypeBlueprint } from "./pageTypeBlueprint";
import { pageCopyForBuild } from "./stageRegistry";
import {
  signalTrackedChildProcess,
  supervisedProcessTreeLaunch,
  trackChildProcess,
} from "./childProcessRegistry";

/** Three lenses on the same rendered page: craft, creative, conversion. */
const DESIGN_CRITICS: AgentSlug[] = ["uri-art-director", "roni-creative", "avishai-campaigner"];

/** A round is a revise pass plus three critics, so this is the cost dial. Two rounds: in the 30.08 e2e run round 3 never converged beyond round 2; the QA gate in 5.4 is the enforcement. */
const MAX_ROUNDS = 2;

const SHOT_WIDTHS = [390, 1280];

/**
 * Claude Code permission rules read a single leading slash as "relative to the
 * project root". An absolute filesystem path must start with `//`, otherwise the
 * rule silently never matches and the builder is denied every write in
 * dontAsk mode. Verified against Claude Code 2.1.97 on 30.08.2026.
 */
export function absolutePathRule(tool: "Read" | "Write" | "Edit", absolutePath: string, suffix = ""): string {
  const resolved = path.resolve(absolutePath);
  if (!path.isAbsolute(resolved)) {
    throw new Error(`Permission rule paths must be absolute: ${absolutePath}`);
  }
  return `${tool}(/${resolved}${suffix})`;
}

export function buildWorkspacePermissions(
  workspaceDir: string,
  writableSourceDir: string,
): Readonly<Record<string, unknown>> {
  const workspace = path.resolve(workspaceDir);
  const writable = path.resolve(writableSourceDir);
  if (!isWithin(writable, workspace)) {
    throw new Error("The landing source directory must stay inside its isolated worktree");
  }
  return {
    permissions: {
      // Only Edit(path) rules are matched by the CLI's file permission checks.
      // A Write(path) rule is not merely ignored: the CLI refuses to start and
      // exits 1 naming the rule, which killed a 5.3 build (17.09.2026). Edit
      // governs every file-editing tool, Write included, so one rule is enough.
      allow: [
        absolutePathRule("Read", workspace, "/**"),
        absolutePathRule("Edit", writable, "/**"),
        "Glob",
        "Grep",
      ],
      deny: [
        absolutePathRule("Edit", path.join(workspace, "public"), "/**"),
      ],
    },
  };
}

function buildScreenshotReadPermissions(files: readonly string[]): Readonly<Record<string, unknown>> {
  return {
    permissions: {
      allow: files.map((file) => absolutePathRule("Read", file)),
    },
  };
}

const execFileP = promisify(execFile);

/** Where the readable strips of each capture live, under the run's shots dir. */
const CRITIC_STRIP_DIR = "strips";
const SLICE_TIMEOUT_MS = 60_000;

/** The height of a capture, from the header the PNG states it in. */
async function capturePixelHeight(file: string): Promise<number> {
  const handle = await fs.open(file, "r");
  try {
    const header = Buffer.alloc(24);
    await handle.read(header, 0, 24, 0);
    const size = pngPixelSize(header);
    if (!size) throw new Error(`${path.basename(file)} אינו PNG קריא`);
    return size.height;
  } finally {
    await handle.close();
  }
}

/**
 * The strips a critic reads instead of one full-page capture, or the capture
 * itself when the cut cannot be made.
 *
 * `shoot` writes the whole page as one file, and a real sales page comes out
 * over 20,000px tall. A vision model handed that file sees a compressed
 * sliver: in the 10th acceptance run all three design critics failed the page
 * from two such files, one saying honestly that no text was legible and two
 * writing confident blockers the pixels contradict. A failed cut degrades to
 * the whole file and says so out loud, because an unreadable critique is bad
 * and no critique at all is worse.
 */
async function sliceCapture(
  capture: string,
  outDir: string,
  emit: (t: string) => void,
): Promise<string[]> {
  try {
    const strips = planStrips(await capturePixelHeight(capture));
    if (strips.length < 2) return [capture];
    const { stdout } = await execFileP(
      await resolvePython(),
      [path.join(process.cwd(), "scripts", "slice-shot.py"), capture, String(strips[0].height), outDir],
      { timeout: SLICE_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
    );
    const files = stdout.split("\n").map((line) => line.trim()).filter(Boolean);
    if (files.length !== strips.length) {
      throw new Error(`החיתוך החזיר ${files.length} רצועות במקום ${strips.length}`);
    }
    return files;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    emit(`⚠️ ${path.basename(capture)} לא נחתך לרצועות, המבקרים יקבלו את הקובץ המלא: ${reason}\n`);
    return [capture];
  }
}

/** Every capture as its own group, labelled by the width its file name states. */
async function sliceCaptures(
  captures: readonly string[],
  outDir: string,
  emit: (t: string) => void,
): Promise<ShotGroup[]> {
  const groups: ShotGroup[] = [];
  for (const [index, capture] of captures.entries()) {
    groups.push({
      width: captureWidthFromFile(capture, SHOT_WIDTHS[index]) ?? SHOT_WIDTHS[0],
      files: await sliceCapture(capture, outDir, emit),
    });
  }
  return groups;
}

/**
 * The design standard skill (vendor/landing-skill/SKILL.md) is written for a
 * sales page: it hard-codes structural rules such as a media logo strip as
 * the first thing on the page. An upsell page must open on the order state
 * instead, so the page-type blueprint's structure section has to outrank the
 * skill's structure rules for both the builder and the three design critics,
 * while the craft rules that have nothing to do with structure keep blocking
 * either way. This renders that one block, injected identically after the
 * design standard section in both prompts.
 *
 * With no blueprint the block is empty: a sales page (and any run without a
 * template) must reach the builder and critics with exactly the prompts it
 * had before page types existed.
 */
export function renderPageTypeStructureBlock(assetType: AssetType, blueprint: string): string {
  if (!blueprint) return "";
  return `

## תבנית סוג הדף (${assetType})

${blueprint}

**קדימות:** סעיף המבנה של התבנית מנצח כל כלל מבנה בספר הכללים, כולל סדר הסקציות ורצועת הלוגו בראש הדף. כלל שהתבנית מוציאה אינו חוסם. כללי המלאכה שאינם מבנה נשארים חוסמים: היררכיית גדלים, ריתמוס רקעים, אפס letter-spacing בעברית, ונכסים אמיתיים בלבד.`;
}

interface PreflightResult {
  ok: boolean;
  reason?: string;
}

export async function runLandingGit(
  args: string[],
  workspaceDir: string,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return runGitInRepository(workspaceDir, args, signal);
}

function nulSeparatedPaths(stdout: string): string[] {
  return stdout.split("\0").filter(Boolean);
}

export async function changedLandingPaths(
  workspaceDir: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const commands = await Promise.all([
    runLandingGit(["diff", "--name-only", "-z"], workspaceDir, signal),
    runLandingGit(["diff", "--cached", "--name-only", "-z"], workspaceDir, signal),
    runLandingGit(["ls-files", "--others", "--exclude-standard", "-z"], workspaceDir, signal),
  ]);
  const failed = commands.find((result) => result.code !== 0);
  if (failed) throw new Error(`Could not inspect landing-page changes: ${failed.stderr || failed.stdout}`);
  return [...new Set(commands.flatMap((result) => nulSeparatedPaths(result.stdout)))].sort();
}

export async function verifyBuilderPostflight(args: {
  workspaceDir: string;
  initialHead: string;
  allowedPaths: string[];
  landingParent: string;
  srcDir: string;
  appDir: string;
  publicDir: string;
  pageSourceDir: string;
  publicAssetsDir: string;
  preparedAssets: Record<string, string>;
}): Promise<void> {
  const currentHead = await runLandingGit(["rev-parse", "HEAD"], args.workspaceDir);
  if (currentHead.code !== 0 || currentHead.stdout.trim() !== args.initialHead) {
    throw new Error("Landing-page builder changed Git HEAD or created a commit");
  }
  assertOnlyAllowedGitPaths(await changedLandingPaths(args.workspaceDir), args.allowedPaths);
  await assertManagedDirectory(args.workspaceDir, args.landingParent);
  await assertManagedDirectory(args.srcDir, args.workspaceDir);
  await assertManagedDirectory(args.appDir, args.srcDir);
  await assertManagedDirectory(args.publicDir, args.workspaceDir);
  await assertManagedDirectory(args.pageSourceDir, args.appDir);
  await assertPageSourceHasNoEmbeddedMedia(args.pageSourceDir);
  await verifyPreparedAssets(args.publicAssetsDir, args.preparedAssets);
}

/**
 * Uncommitted work that is not this run's own page. A previous stage-5 run
 * leaves its generated page in the tree, and the board must not be blocked by
 * output it produced itself, while still refusing to bury unrelated work.
 */
export function blockingStatusLines(porcelain: string, allowPrefixes: string[]): string[] {
  return porcelain
    .split("\n")
    .filter((line) => line.trim().length > 0)
    // " m ruflo" = submodule with uncommitted inner changes; harmless here.
    .filter((line) => !/^\s*m\s/.test(line))
    .filter((line) => {
      const filePath = line.slice(3).trim().replace(/^"|"$/g, "");
      return !allowPrefixes.some((prefix) => filePath.startsWith(prefix));
    });
}

async function preflightLandingPages(
  workspaceDir: string,
  ownPaths: string[] = [],
): Promise<PreflightResult> {
  try {
    const stat = await fs.stat(workspaceDir);
    if (!stat.isDirectory()) {
      return { ok: false, reason: "The configured landing workspace is not a directory" };
    }
  } catch {
    return { ok: false, reason: "The configured landing workspace does not exist on this machine" };
  }
  try {
    await fs.access(path.join(workspaceDir, ".git"));
  } catch {
    return { ok: false, reason: "The configured landing workspace is not a Git repository" };
  }
  const status = await runLandingGit(["status", "--porcelain"], workspaceDir);
  const blocking = blockingStatusLines(status.stdout, ownPaths);
  if (blocking.length > 0) {
    return {
      ok: false,
      reason: `The configured landing workspace has unrelated uncommitted changes. Commit or stash them before stage 5 runs.\n\n${blocking.join("\n").slice(0, 500)}`,
    };
  }
  return { ok: true };
}

/**
 * Resolve the Next.js CLI entry as a JavaScript file. `node_modules/.bin/next`
 * is a symlink under npm but a POSIX shell shim under bun, and running a shell
 * shim with `node` fails with a SyntaxError (landing-pages is bun-managed,
 * found 30.08.2026). The package entry is the same file under both managers.
 */
export async function resolveNextCli(nodeModules: string): Promise<string> {
  const packageEntry = path.join(nodeModules, "next", "dist", "bin", "next");
  const entryStat = await fs.stat(packageEntry).catch(() => undefined);
  if (entryStat?.isFile()) return fs.realpath(packageEntry);
  const shim = await fs.realpath(path.join(nodeModules, ".bin", "next"));
  const head = await fs.readFile(shim, { encoding: "utf8", flag: "r" }).then((text) => text.slice(0, 64));
  if (head.startsWith("#!/bin/sh") || head.startsWith("#!/usr/bin/env sh")) {
    throw new Error("node_modules/.bin/next is a shell shim and next/dist/bin/next is missing; reinstall the landing workspace dependencies");
  }
  return shim;
}

/**
 * The message a failed build hands the agent and the operator. The compiler's
 * "file(line,col): error TSxxxx" lines come first, so a rerun knows where to
 * look; the raw tail alone began mid-sentence (WSL2 acceptance run
 * 35877627654 reran three times on the same widened-string easing without
 * ever being told the file and line).
 */
export function landingBuildFailureMessage(code: number | null, output: string, hint = ""): string {
  const located = [...output.matchAll(/^(.+\.\w+\(\d+,\d+\): error TS\d+: .+)$/gm)].map((match) => match[1]).slice(0, 5);
  const where = located.length ? `${located.join("\n")}\n---\n` : "";
  return `Landing build failed (exit ${code}): ${where}${output.slice(-4_000)}${hint}`;
}

async function runLandingBuild(
  workspaceDir: string,
  dependencyWorkspace: string,
  signal?: AbortSignal,
  /**
   * The run log to record the exact sandbox profile in (the same
   * "# sandbox profile" block the preview server writes), so a reviewer can
   * read from the run's own logs that the build ran with network "none" on
   * Linux instead of reproducing the launch by hand.
   */
  profileLogFile?: string,
): Promise<string> {
  if (signal?.aborted) return Promise.reject(new Error("Landing build was aborted"));
  const sandboxHome = await fs.mkdtemp(path.join(os.tmpdir(), "campaign-council-build-"));
  await fs.chmod(sandboxHome, 0o700);
  const nodeModules = await fs.realpath(path.join(dependencyWorkspace, "node_modules"));
  const nextScript = await resolveNextCli(nodeModules);
  const nextRelative = path.relative(nodeModules, nextScript);
  if (
    nextRelative === ".." ||
    nextRelative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(nextRelative)
  ) {
    await fs.rm(sandboxHome, { recursive: true, force: true });
    throw new Error("The configured Next.js executable escaped node_modules");
  }
  await fs.mkdir(path.join(workspaceDir, ".next"), { recursive: true, mode: 0o700 });
  await prepareLinuxSandboxFiles([path.join(workspaceDir, "next-env.d.ts")]).catch(async (error) => {
    await fs.rm(sandboxHome, { recursive: true, force: true });
    throw error;
  });
  const launch = await sandboxedNodeLaunch(
    process.execPath,
    ["--max-old-space-size=1536", nextScript, "build", "--webpack"],
    {
      readPaths: [workspaceDir, nodeModules, sandboxHome],
      // `next build` refreshes next-env.d.ts (gitignored) exactly like `next dev`.
      writePaths: [path.join(workspaceDir, ".next"), sandboxHome, path.join(workspaceDir, "next-env.d.ts")],
      // Linux intentionally builds the local-font starter offline. The backend
      // rejects HTTPS requests rather than silently weakening that contract.
      network: process.platform === "linux" ? "none" : "https-egress",
      workingDirectory: workspaceDir,
    },
  ).catch(async (error) => {
    await fs.rm(sandboxHome, { recursive: true, force: true });
    throw error;
  });
  if (profileLogFile) {
    await fs.appendFile(profileLogFile, `\n# sandbox profile\n${launch.profile}\n# end profile\n`, "utf8").catch(async (error) => {
      await fs.rm(sandboxHome, { recursive: true, force: true });
      throw error;
    });
  }
  const processTreeLaunch = supervisedProcessTreeLaunch(launch.command, launch.args);

  try {
    return await new Promise((resolve, reject) => {
      const proc = spawn(processTreeLaunch.command, [...processTreeLaunch.args], {
        cwd: workspaceDir,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        shell: false,
        detached: process.platform !== "win32",
        env: {
          PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
          HOME: sandboxHome,
          LANG: process.env.LANG,
          LC_ALL: process.env.LC_ALL,
          TMPDIR: sandboxHome,
          NODE_ENV: "production",
          NODE_PATH: nodeModules,
          NEXT_TELEMETRY_DISABLED: "1",
        },
      });
      trackChildProcess(proc, "landing-build", { supervisedProcessTree: true });
      let output = Buffer.alloc(0);
      let settled = false;
      let closed = false;
      let forceKill: NodeJS.Timeout | undefined;
      let terminationError: Error | undefined;
      const maxOutput = 4 * 1024 * 1024;

      const killTree = (name: NodeJS.Signals) => {
        signalTrackedChildProcess(proc, name);
      };
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (closed && forceKill) clearTimeout(forceKill);
        signal?.removeEventListener("abort", onAbort);
        if (error) reject(error);
        else resolve(output.toString("utf8"));
      };
      const terminate = (error: Error) => {
        if (terminationError) return;
        terminationError = error;
        killTree("SIGTERM");
        forceKill = setTimeout(() => killTree("SIGKILL"), 2_000);
        forceKill.unref();
      };
      const timeout = setTimeout(
        () => terminate(new Error("Landing build timed out after 10 minutes")),
        10 * 60_000,
      );
      timeout.unref();
      const onAbort = () => terminate(new Error("Landing build was aborted"));
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();

      const capture = (chunk: Buffer | string) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (output.length + bytes.length > maxOutput) {
          terminate(new Error("Landing build output exceeded the 4MB safety limit"));
          return;
        }
        output = Buffer.concat([output, bytes]);
      };
      proc.stdout!.on("data", capture);
      proc.stderr!.on("data", capture);
      // A failed spawn also emits close; release host launch state only then.
      proc.on("error", (error) => { terminationError ??= error; });
      proc.on("close", (code) => {
        closed = true;
        if (forceKill) clearTimeout(forceKill);
        if (settled) return;
        if (terminationError) {
          finish(terminationError);
        } else if (code !== 0) {
          const offlineHint = process.platform === "linux"
            ? " Linux builds run offline; use the included local-font starter and remove next/font/google or other build-time downloads."
            : "";
          finish(new Error(landingBuildFailureMessage(code, output.toString("utf8"), offlineHint)));
        } else {
          finish();
        }
      });
    });
  } finally {
    if (launch.cleanupPath) await fs.rm(launch.cleanupPath, { recursive: true, force: true });
    await fs.rm(sandboxHome, { recursive: true, force: true });
  }
}

export function lpSlugFor(brief: string, runId: string): string {
  // Strip Hebrew, keep ASCII alphanumerics; if there's enough, prefix to slug.
  const ascii = brief
    .toLowerCase()
    .replace(/[֐-׿]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 30);
  if (ascii && ascii.length > 3) return `council-${ascii}-${runId}`;
  return `council-${runId}`;
}

/** What the builder is told about an existing project it should build on top of. */
const MAX_REFERENCE_BRIEF_BYTES = 64 * 1024;
const MAX_REFERENCE_ASSET_PATHS = 200;

function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

async function readContainedReferenceBrief(root: string, file: string): Promise<string> {
  const candidate = path.join(root, file);
  const before = await fs.lstat(candidate);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error("reference brief is not a regular file");
  }
  const realRoot = await fs.realpath(root);
  const realCandidate = await fs.realpath(candidate);
  if (!isWithin(realCandidate, realRoot)) throw new Error("reference brief escaped its root");

  const handle = await fs.open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > MAX_REFERENCE_BRIEF_BYTES) {
      throw new Error("reference brief is too large or not a regular file");
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

export async function describeReference(ref: ReferenceProject): Promise<string> {
  if (!ref.url && !ref.dir) return "";

  const parts: string[] = ["## Existing project for this product — build on it, do not start from zero"];
  if (ref.url) parts.push(`- Live reference page: ${ref.url}. Open it and match its bar for hierarchy, rhythm and proof.`);

  if (ref.dir) {
    parts.push(`- Local project folder: \`${ref.dir}\``);
    let entries: string[];
    try {
      entries = await fs.readdir(ref.dir);
    } catch {
      parts.push("- (the folder could not be read from here)");
      return parts.join("\n");
    }
    if (entries.includes("design-brief.json")) {
      try {
        const brief = await readContainedReferenceBrief(ref.dir, "design-brief.json");
        parts.push(`\n### design-brief.json (binding — this is the brand)\n\n\`\`\`json\n${brief.slice(0, 6000)}\n\`\`\``);
      } catch {
        parts.push("- design-brief.json was ignored because it is not a safe, bounded regular file");
      }
    }
    try {
      // Only the reference project's photographed assets. Its mockups are
      // renders of a different build and are never this client's product.
      const assetsDir = entries.includes("assets") ? path.join(ref.dir, "assets") : null;
      if (assetsDir) {
        const listing = await listAssets(assetsDir);
        if (listing.length) {
          parts.push(
            `\n### Photographed assets that already exist (${listing.length} files)\n\n${listing.slice(0, 60).join("\n")}\n\n` +
              `These filenames are visual context only. Do not copy anything from this folder into the page. ` +
              `Any reference photograph the page needs must first be imported, declared, reviewed, and approved in sub-task 5.2. ` +
              `Use only the files the application already placed in \`public/<slug>/\` from that approved manifest.`,
          );
        }
      }
    } catch {
      parts.push("- (the reference asset listing could not be read safely)");
    }
  }

  return parts.join("\n");
}

function tableCell(value: string): string {
  return value.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
}

export function renderPlacementTable(slug: string, mapped: readonly MappedAsset[]): string {
  return [
    "| File | Section | Proves |",
    "|---|---|---|",
    ...mapped.map((asset) => `| \`public/${slug}/${asset.file}\` | ${tableCell(asset.section)} | ${tableCell(asset.proves)} |`),
  ].join("\n");
}

export function renderAssetPlacementBlock(slug: string, placement: AssetPlacement): string {
  const total = placement.mapped.length + placement.logos.length + placement.rawMaterial.length + placement.unmapped.length;
  if (total === 0) return "## Approved assets\n\n(the validated asset manifest contains no approved images)";
  const list = (files: readonly string[]) => files.map((file) => `- \`public/${slug}/${file}\``).join("\n");
  const sections: string[] = ["## Approved assets - validated by the application"];
  if (placement.mapped.length) {
    sections.push(
      `### Image map. Place every image right next to the headline in "Proves", and keep it visible at 390px AND at 1280px\n\n${renderPlacementTable(slug, placement.mapped)}\n\nOn desktop, content sections with an image alternate the image side. A page-type structure rule, when present, overrides this alternation.\nThe application checks every mapped image in the rendered page at 390px and at 1280px. A mapped image that is not visible blocks the round.\nDo not place a mapped image inside a carousel, a marquee or an inner scroll container, and make every scroll-reveal animation around a mapped image reveal once (\`viewport={{ once: true }}\` or \`useInView(ref, { once: true })\`).`,
    );
  }
  if (placement.logos.length) sections.push(`### Logos\n${list(placement.logos)}`);
  if (placement.rawMaterial.length) {
    sections.push(`### Raw material (inputs of other assets, not meant for placement)\n${list(placement.rawMaterial)}`);
  }
  if (placement.unmapped.length) sections.push(`### Approved without a map (you may use these)\n${list(placement.unmapped)}`);
  sections.push(
    `The application has already copied these exact files into \`public/${slug}/\`. Use them there. Do not add or copy any other image, and do not rewrite or recompress these files.\nThe private validation folder is intentionally not exposed to the builder.`,
  );
  return sections.join("\n\n");
}

/** The images approved by the human reviewer in 5.2, handed to the builder as real files. */
export async function describeApprovedAssets(
  assetsReport: string,
  slug: string,
  expectedAssetsDir?: string,
  expectedManifestSha256?: string,
): Promise<string> {
  let dir: string;
  if (expectedAssetsDir) {
    dir = path.resolve(expectedAssetsDir);
  } else {
    const line = assetsReport
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.startsWith("ASSETS_DIR:"));
    const reportedDir = line?.slice("ASSETS_DIR:".length).trim();
    if (!reportedDir || reportedDir.toLowerCase() === "none" || !reportedDir.startsWith("/")) {
      return "## Approved assets\n\n(none were produced — the page will be a skeleton, say so in your summary)";
    }
    dir = path.resolve(reportedDir);
  }

  try {
    if (!expectedManifestSha256) throw new Error("the approved asset manifest digest is missing");
    return renderAssetPlacementBlock(slug, await readApprovedAssetPlacement(dir, expectedManifestSha256));
  } catch (error) {
    throw new Error(`Approved assets could not be verified: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function listAssets(dir: string, depth = 2): Promise<string[]> {
  const out: string[] = [];
  const rootStat = await fs.lstat(dir);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return out;
  const root = await fs.realpath(dir);
  const walk = async (current: string, level: number) => {
    if (level > depth || out.length >= MAX_REFERENCE_ASSET_PATHS) return;
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= MAX_REFERENCE_ASSET_PATHS) break;
      if (e.isSymbolicLink()) continue;
      const full = path.join(current, e.name);
      const stat = await fs.lstat(full).catch(() => undefined);
      if (!stat || stat.isSymbolicLink()) continue;
      const real = await fs.realpath(full).catch(() => "");
      if (!real || !isWithin(real, root)) continue;
      if (stat.isDirectory()) await walk(full, level + 1);
      else if (stat.isFile() && /\.(webp|png|jpe?g|svg|mp4|avif)$/i.test(e.name)) out.push(real);
    }
  };
  await walk(dir, 0);
  return out;
}

export interface Critique {
  slug: AgentSlug;
  name: string;
  /** True only for an explicit "פסק דין: עובר". */
  passed: boolean;
  /** The three-state reading behind `passed`: an unreadable answer is "did not vote", not a failure. */
  verdict: Verdict;
  text: string;
}

export const IMAGE_MAP_CRITIC_NAME = "בדיקת מפת התמונות";

function widthsLabel(widths: readonly number[]): string {
  return widths.map((width) => `${width}px`).join(" ו-");
}

/** The failed image map check as one more blocking reviewer, so it flows into `failing`, the revise prompt and the summary. */
export function imageMapCritique(check: ImageMapCheck): Critique | null {
  if (check.passed) return null;
  const blockers = check.failure
    ? [`1. [כל הדף] ${check.failure}. יש לרנדר שוב; אם זה חוזר, בעל הסמכות מחליט.`]
    : check.missing.map((item, index) =>
        `${index + 1}. [${item.section}, ${widthsLabel(item.widths)}] התמונה ${item.file} ממופה ל"${item.proves}" אבל לא מוצגת. למקם אותה צמוד לכותרת הזו ולוודא שהיא נראית בשני הרוחבים.`);
  return {
    slug: "daniel-lp-designer",
    name: IMAGE_MAP_CRITIC_NAME,
    passed: false,
    verdict: "fail",
    text: ["פסק דין: לא עובר", "", "חוסמים:", ...blockers].join("\n"),
  };
}

/** The last round's check is trusted only if it still matches the attempt, the assets and the final page source. */
export function finalizeImageMapCheck(
  check: ImageMapCheck | undefined,
  current: { attemptStartedAt: string; assetManifestSha256: string; pageSourceHashes: Record<string, string> },
): ImageMapCheck | undefined {
  if (!check) return undefined;
  const stale = imageMapCheckIsCurrent(check, current);
  return stale ? { ...check, passed: false, failure: stale } : check;
}

export function buildRevisePrompt(args: { pagePath: string; slug: string; failing: readonly Critique[] }): string {
  const { pagePath, slug, failing } = args;
  return `You built ${pagePath} in the current isolated worktree. Reviewers looked at the RENDERED page and returned blocking issues. Fix them.

${failing.map((c) => `## ${c.name}\n\n${c.text}`).join("\n\n---\n\n")}

## Rules
- Fix every item marked חוסם. Items marked שיפור are optional.
- Do not redesign the page and do not change the copy. Fix what they pointed at.
- Keep every JavaScript or TypeScript source file client-only and beginning with exactly \`"use client";\`.
- Stay inside \`src/app/${slug}/\`. The existing \`public/${slug}/\` assets are read-only.
- Do not run shell commands or builds. The application validates and builds after your edits.
- The "Static page contract" from the build instructions still applies to every edit: no \`document\`/\`window\`/\`setTimeout\`/browser globals, no \`<link>\`/\`<script>\` tags, no dynamic JSX tags, no variable-key member access, no loops/try/switch/classes. Use framer-motion for anything timed.
- Report briefly what you changed, item by item.`;
}

/**
 * The three groups a design round ends with. `silent` critics returned no
 * readable verdict even after a re-ask: they block auto-approval (fail
 * closed) but they are not sent to the builder as "fixes", because their
 * text is not a list of blockers anyone wrote.
 */
export function splitCritiques(critiques: readonly Critique[]): {
  passing: Critique[];
  failing: Critique[];
  silent: Critique[];
} {
  return {
    passing: critiques.filter((c) => c.verdict === "pass"),
    failing: critiques.filter((c) => c.verdict === "fail"),
    silent: critiques.filter((c) => c.verdict === "unreadable"),
  };
}

/** The final verdict line of the 5.3 summary, honest about why a page is not waved through. */
export function finalVerdictLabel(passed: boolean, critiques: readonly Critique[]): string {
  if (passed) return "✅ כל המבקרים עברו";
  const { failing, silent } = splitCritiques(critiques);
  if (failing.length) return "⚠️ נשארו חוסמים";
  if (silent.length) return `⚠️ ${silent.map((c) => c.name).join(", ")} לא הצביע (אין חוסמים ידועים)`;
  return "⚠️ נשארו חוסמים";
}

/**
 * The pure text of one design critic's prompt, extracted so the page-type
 * blueprint's injection point can be tested directly with fixture inputs
 * instead of needing a rendered page, a running preview server and real
 * screenshots.
 */
export function buildCritiquePrompt(args: {
  systemPrompt: string;
  round: number;
  shotList: string;
  referenceList: string;
  brandBrief: string;
  standard: string;
  pageTypeStructureBlock: string;
  placementBlock?: string;
  desertWarning?: string;
}): string {
  const { systemPrompt, round, shotList, referenceList, brandBrief, standard, pageTypeStructureBlock, placementBlock, desertWarning } = args;
  return `${systemPrompt}

---

# המשימה שלך עכשיו: ביקורת עיצוב, סבב ${round}

לפניך **צילומי מסך של הדף המרונדר**. תפתח את הקבצים ותסתכל עליהם. אסור לבקר בלי לפתוח.

## הדף

${shotList}${referenceList}

## בריף המותג שאושר (מנצח את הטעם שלך)

${brandBrief || "(לא אושר בריף מותג)"}

## ספר הכללים העדכני של סקיל העיצוב

${standard || "(ספר הכללים לא נמצא, תבקר לפי הבריף בלבד)"}${pageTypeStructureBlock}${placementBlock ? `

## מפת התמונות שאושרה

כל תמונה בטבלה צריכה להופיע צמוד לכותרת שבעמודה "מוכיחה", גם ב-390 וגם ב-1280.

${placementBlock}` : ""}${desertWarning ? `

## אזהרה, לא חוסם: מדבר טקסט במובייל

${desertWarning}` : ""}

## בדיקות חובה, עבור עליהן אחת אחת לפני פסק הדין

1. הוק פתיחה לכל סקציה: כל סקציה נפתחת בכותרת קטנה ומושכת בצבע המבטא של המותג לפני גוף הטקסט. סקציה שנפתחת ישר בגוף טקסט היא חוסם.
2. היררכיית גדלים: כותרות הסקציות גדולות ובולטות בבירור מגוף הטקסט. דף שנראה כולו באותו גודל טקסט הוא חוסם.
3. ריתמוס רקעים: סקציות מתחלפות לפי הבריף. שלוש סקציות רצופות באותו רקע הן חוסם.
4. אפס letter-spacing בטקסט עברי, חיובי או שלילי. כל ערך שאינו normal הוא חוסם.
5. אין קירות טקסט: פסקה ארוכה בלי כותרת שוברת מעליה היא חוסם.
6. הירו דומיננטי: תמונת ההירו היא האלמנט החזותי הבולט ביותר במסך הראשון, כפי שהבריף מגדיר. תמונה שנבלעת בבלוק הטקסט היא חוסם.
7. עדויות קריאות: טקסט בצילום עדות נקרא בלי זום ב-390. ב-1280 לכל היותר שתי עדויות בשורה. עדות שלא נקראת היא חוסם.
8. כפתור קרוב: בין שני כפתורי פעולה יש לכל היותר שלוש סקציות, ותמיד יש כפתור מיד אחרי סקציית העדויות ומיד אחרי סקציית הסמכות. דף שמפר זאת הוא חוסם.
9. התמונה הנכונה ליד הכותרת: כל תמונה ממפת התמונות יושבת ליד הכותרת שבעמודה "מוכיחה". תמונה שהוצבה ליד כותרת אחרת היא חוסם.

בדיקה שתבנית סוג הדף מבטלת אינה חוסם.

## הפורמט שאתה מחזיר

השורה הראשונה חייבת להיות בדיוק אחת מהשתיים:

פסק דין: עובר
פסק דין: לא עובר

אחריה: רשימת **חוסמים** ואחריה רשימת **שיפורים**. כל הערה עם [סקציה, רוחב], מה לא בסדר, ומה במקום. הערה בלי מיקום ובלי תיקון קונקרטי לא נספרת.

חוסם אחד מספיק כדי ש"לא עובר". אם באמת אין חוסמים — "עובר", ואל תמציא חוסם כדי להיראות תובעני.

תכתוב רק את הביקורת. בלי הקדמות. בלי em-dashes.`;
}

export async function critiqueRound(args: {
  runDir: string;
  round: number;
  shotGroups: ShotGroup[];
  referenceGroups: ShotGroup[];
  brandBrief: string;
  standard: string;
  pageTypeStructureBlock: string;
  placementBlock: string;
  desertWarning: string;
  emit: (t: string) => void;
  control?: ExecutionControl;
}): Promise<Critique[]> {
  const { runDir, round, shotGroups, referenceGroups, brandBrief, standard, pageTypeStructureBlock, placementBlock, desertWarning, emit, control } = args;
  control?.throwIfAborted();
  const agents = await loadAgents();

  const shotList = renderShotList(shotGroups);
  const referenceBody = renderShotList(referenceGroups);
  const referenceList = referenceBody
    ? `\n\n## דף הרפרנס — הרף להשוואה\n\nתפתח גם אותם והשווה זה לצד זה באותו רוחב:\n\n${referenceBody}`
    : "";
  const readableFiles = [...shotGroups, ...referenceGroups].flatMap((group) => group.files);

  return Promise.all(
    DESIGN_CRITICS.map(async (slug): Promise<Critique> => {
      control?.throwIfAborted();
      const agent = agents.find((a) => a.slug === slug);
      if (!agent) return { slug, name: slug, passed: false, verdict: "fail", text: `הסוכן ${slug} לא נמצא` };

      const prompt = buildCritiquePrompt({
        systemPrompt: agent.systemPrompt,
        round,
        shotList,
        referenceList,
        brandBrief,
        standard,
        pageTypeStructureBlock,
        placementBlock,
        desertWarning,
      });

      emit(`   🔎 ${agent.name} מסתכל...\n`);
      // A critic that names no verdict is asked once more with the format
      // demand up front (same rule as the stage 4 audit). Still nothing =
      // "did not vote": fails closed, reported honestly, never a blocker list.
      let fullText = "";
      let verdict: Verdict = "unreadable";
      for (let ask = 1; ask <= 2 && verdict === "unreadable"; ask++) {
        const askPrompt = ask === 1
          ? prompt
          : `לא החזרת פסק דין בתשובה הקודמת. אל תריץ פקודות ואל תכתוב בלוקים של קריאות כלים. השורה הראשונה חייבת להיות בדיוק "פסק דין: עובר" או "פסק דין: לא עובר".\n\n---\n\n${prompt}`;
        ({ fullText } = await spawnAgent({
          prompt: askPrompt,
          cwd: runDir,
          permissionMode: "dontAsk",
          tools: ["Read"],
          strictMcpConfig: true,
          settingSources: [],
          disableSlashCommands: true,
          settings: buildScreenshotReadPermissions(readableFiles),
          signal: control?.signal,
          timeoutMs: agentTimeoutMs(control),
          onToken: () => {},
        }));
        control?.throwIfAborted();
        verdict = readVerdict(fullText);
        if (verdict === "unreadable" && ask === 1) {
          await appendLog(runDir, `stage-5-3-critique-round-${round}.md`, `\n\n## ${agent.name} (no readable verdict, asking again)\n\n${fullText}\n`);
        }
      }
      const passed = verdict === "pass";
      emit(`   ${passed ? "✅" : verdict === "fail" ? "❌" : "⚠️"} ${agent.name}: ${passed ? "עובר" : verdict === "fail" ? "לא עובר" : "לא הצביע (פסק דין לא קריא)"}\n`);
      await appendLog(runDir, `stage-5-3-critique-round-${round}.md`, `\n\n## ${agent.name}\n\n${fullText}\n`);
      return { slug, name: agent.name, passed, verdict, text: fullText };
    }),
  );
}

/**
 * A direct run has no 5.1 (stage 3 IS its design brief, approved by the
 * human reviewer at the end of stage 3's critic loop); a council run has no
 * stage-3 design brief at all (5.1 is the brand-brief sub-task). Both the
 * 5.3 builder here and 5.2's asset placement (runStage5Assets.ts) need the
 * same source of truth, so this is the one place that decides which stage
 * the brand brief comes from.
 */
export function brandBriefForBuild(run: Run): string {
  const find = (n: number, id: string) =>
    run.stages?.find((s) => s.number === n)?.subTasks.find((st) => st.id === id)?.output ?? "";
  return run.pipeline === "direct" ? find(3, "3") : find(5, "5.1");
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((v) => typeof v === "string") ? (value as string[]) : undefined;
}

function asColors(value: unknown): { base?: string; accent?: string; text?: string } {
  if (!value || typeof value !== "object") return {};
  const record = value as Record<string, unknown>;
  return { base: asString(record.base), accent: asString(record.accent), text: asString(record.text) };
}

/**
 * A direct run's stage 3 ```json block is not decoration: the human reviewer
 * approved it, so it becomes binding rules in the builder's own prompt, not
 * just prose the builder can round off. Council runs have no such block
 * ("" is the intended output, not a missing case).
 */
export function renderDesignBriefBlock(run: Run): string {
  if (run.pipeline !== "direct") return "";
  const brief = parseDesignBriefJson(brandBriefForBuild(run));
  if (!brief) return "";
  const list = (xs: string[] | undefined) => (xs?.length ? xs.map((x) => `- ${x}`).join("\n") : "- (אין)");
  const colors = asColors(brief.colors);
  return `## בריף העיצוב (שלב 3, מאושר). מחייב

סדר עדיפות: תבנית סוג הדף > בריף העיצוב > תקן העיצוב הכללי.

- פלייבוק: ${asString(brief.playbook) ?? "(לא צוין)"}
- צבעים: בסיס ${colors.base ?? "?"}, הדגשה ${colors.accent ?? "?"}, טקסט ${colors.text ?? "?"}

### אלמנטים מיוחדים
${list(asStringArray(brief.specialElements))}

### איסורים קשיחים
${list(asStringArray(brief.hardBans))}

### מפת התמונות (שם קובץ סופי לפי הטבלה "מקור בקציר | שם סופי" בדוח הנכסים)
${brief.imageMap.length ? brief.imageMap.map((m) => `- ${m.harvestFile} | סקציה: ${m.section} | מוכיח: ${m.proves}`).join("\n") : "- (אין)"}`;
}

/**
 * The pure text of the builder's prompt, extracted for the same reason as
 * buildCritiquePrompt above: the page-type blueprint's injection point right
 * after the full design standard section is testable directly with fixture
 * inputs, without a Git worktree or a running preview server.
 */
export function buildLpBuildPrompt(args: {
  editInPlace: boolean;
  pagePath: string;
  slug: string;
  brandBrief: string;
  referenceBlock: string;
  fullStandard: string;
  standard: string;
  pageTypeStructureBlock: string;
  assetsBlock: string;
  clientContext: string;
  lpCopy: string;
  brief: string;
  strategyDoc?: string;
  feedbackBlock: string;
  designBriefBlock: string;
}): string {
  const {
    editInPlace,
    pagePath,
    slug,
    brandBrief,
    referenceBlock,
    fullStandard,
    standard,
    pageTypeStructureBlock,
    assetsBlock,
    clientContext,
    lpCopy,
    brief,
    strategyDoc,
    feedbackBlock,
    designBriefBlock,
  } = args;
  return `${editInPlace
    ? `Edit the EXISTING landing page at ${pagePath} in the current isolated worktree. Apply ONLY what the client feedback below asks for, keep every other line exactly as it is, and keep the page compliant with the full contract below.`
    : `Build a new Next.js landing page at ${pagePath} in the current isolated worktree.`}

Implement the Hebrew sales copy below verbatim: don't paraphrase, don't summarize, don't add sections that aren't in it. RTL Hebrew, Framer Motion for entrance animations on key sections. Mobile-first.

${brandBrief
  ? `## Brand brief approved by the human reviewer. This is binding\n\n${brandBrief}\n\nUse this palette, this type and these images. Do not substitute a default playbook. An image the brief marks as missing stays a marked empty slot: no invented stand-in, no generated portrait, no fake logo.`
  : "## Brand brief\n\n(none approved — say so explicitly in your summary)"}

${referenceBlock}

## Design standard (the FULL skill, binding end to end)

${fullStandard || standard || "Use the approved brand brief as the binding visual standard."}${designBriefBlock ? `\n\n${designBriefBlock}` : ""}${pageTypeStructureBlock}

${assetsBlock}

${clientContext}

## Sales Copy to Implement

${lpCopy}

## Strategy Context

Brief: ${brief}

Strategy: ${strategyDoc ?? "(no strategy)"}

${feedbackBlock}

## Constraints
- Create the file at exactly ${pagePath}. Create \`src/app/${slug}/\` if needed.
- Every JavaScript or TypeScript source file you create must begin with exactly \`"use client";\`. Keep it a client-only React page.
- The application already copied approved assets into \`public/${slug}/\`. Treat that folder as read-only.
- The only path you may write is \`src/app/${slug}/\`.
- DO NOT commit. DO NOT push.
- Do not run shell commands, package scripts, builds, or development servers. The application validates and builds after your edits.
- Report with a 1-paragraph summary + the exact file path.

## Static page contract (the application rejects the page otherwise)
The page is checked by a strict static analyser before it is built. A single violation fails the whole build, so treat every line below as a hard rule:
- Imports: only \`react\`, \`framer-motion\`, \`next/image\`, \`next/link\`, and local files inside \`src/app/${slug}/\`. Named imports only.
- React: \`useState\`, \`useRef\`, \`useMemo\`, \`useCallback\`, \`useEffect\` are allowed, but never touch \`document\`, \`window\`, \`navigator\`, \`location\`, \`localStorage\`, \`fetch\`, \`setTimeout\`, \`setInterval\`, \`requestAnimationFrame\` or any other browser global. No scroll fail-safes, no class toggling on the document. Use \`framer-motion\` (\`motion\`, \`useInView\`, \`useScroll\`) for reveal animations.
- JSX: never render \`<link>\`, \`<script>\`, \`<meta>\`, \`<iframe>\`, \`<video>\`, \`<audio>\`, \`<source>\`, \`<object>\`, \`<embed>\`. No \`dangerouslySetInnerHTML\`, no \`action\`/\`formAction\`, no JSX spread attributes (\`{...props}\`). Fonts come from the app layout; declare \`fontFamily\` as a plain string with a generic fallback, never load a font yourself.
- Syntax: no classes, no \`this\`, no \`try\`/\`catch\`/\`throw\`, no \`switch\`, no \`while\`/\`do\`/\`for\` loops (use \`map\`/\`filter\`), no \`await\`/\`yield\`, no \`delete\`, no tagged templates, no getters/setters, no decorators, no \`import.meta\`, no dynamic \`import()\`, no computed member access with a variable key (literal indexes like row[0] are fine; \`obj[key]\`), no mutation of objects or arrays after creation (\`x.y = z\`, \`arr.push\`), no \`Function\`/\`eval\`.
- Top level: only \`"use client"\`, imports, \`const\` declarations with literal/arrow initialisers, function declarations, and one default export. No top-level side effects.
- Type-check floor: \`next build\` type-checks the page. framer-motion 12 types \`ease\` as \`Easing\`, so a transition object declared on its own widens \`ease: "easeOut"\` to \`string\` and fails the build. Write \`ease: "easeOut" as const\`, or a bezier array \`ease: [0.16, 1, 0.3, 1]\`, or declare the object inline where a \`Variants\`/\`Transition\` type is expected.
- QA floor (the automated gate rejects the page otherwise): every \`fontSize\` on the page is at least \`14px\` (legal footer links and placeholder labels included; use 0.875rem+), and no headline may leave a single word alone on its last line at any width from 320 to 1280 (break lines with block \`span\`s into a descending pyramid).
`;
}

export async function runStage5LpBuild(
  runId: string,
  runDir: string,
  feedback?: string,
  control?: ExecutionControl,
): Promise<void> {
  control?.throwIfAborted();
  const run = getRun(runId);
  if (!run) throw new Error(`Run ${runId} not found`);
  if (!run.stages) throw new Error(`Run ${runId} has no stages initialized`);
  const stages = run.stages;

  const SUB_ID = "5.3";
  const logName = "stage-5-3-daniel-lp-designer.log";

  const startedAt = new Date().toISOString();
  const updatedStages = stages.map((s) =>
    s.number === 5
      ? {
          ...s,
          status: "running" as const,
          output: "",
          startedAt,
          currentSubTaskId: SUB_ID,
          feedbackHistory: feedback ? [...s.feedbackHistory, feedback] : s.feedbackHistory,
          subTasks: s.subTasks.map((st) =>
            st.id === SUB_ID
              ? {
                  ...st,
                  status: "running" as const,
                  output: "",
                  errorMessage: undefined,
                  startedAt,
                  preparedAssetHashes: undefined,
                  pageSourceHashes: undefined,
                  assetManifestSha256: undefined,
                  landingHeadSha: undefined,
                  landingCommitSha: undefined,
                  pageSlug: undefined,
                  landingWorktreePath: undefined,
                  imageMapCheck: undefined,
                  feedbackHistory: feedback ? [...st.feedbackHistory, feedback] : st.feedbackHistory,
                }
              : st,
          ),
        }
      : s,
  );
  updateRun(runId, { stages: updatedStages, currentStage: 5 });
  eventBus.emit(runId, { type: "stage-started", runId, stageNumber: 5 });
  eventBus.emit(runId, { type: "subtask-started", runId, stageNumber: 5, subTaskId: SUB_ID });

  const emit = (token: string) => {
    control?.throwIfAborted();
    eventBus.emit(runId, { type: "subtask-token", runId, stageNumber: 5, subTaskId: SUB_ID, token });
    appendLog(runDir, logName, token).catch(() => {});
  };

  try {
    const slug = lpSlugFor(run.brief, runId);
    if (!/^[a-z0-9][a-z0-9-]{0,119}$/.test(slug)) {
      throw new Error(`Generated landing-page slug is not portable or safe: ${slug}`);
    }
    const ownPaths = [`src/app/${slug}/`, `public/${slug}/`];

    if (!run.clientProfile) throw new Error("This legacy run has no sealed client profile");
    const profile = assertClientFeatureReady(run.clientProfile, "stage5");
    const baseWorkspace = profile.landing!.workspacePath!;
    const branchName = `campaign-council-${runId}`;
    emit("🔍 מכין worktree מבודד לדף הנחיתה...\n\n");
    const preparedWorktree = await prepareLandingWorktree({
      baseRepository: baseWorkspace,
      runDir,
      branchName,
      signal: control?.signal,
    });
    const landingWorkspace = preparedWorktree.worktreePath;
    const initialHead = preparedWorktree.initialHead;
    const pf = await preflightLandingPages(landingWorkspace, ownPaths);
    if (!pf.ok) throw new Error(`Preflight failed: ${pf.reason}`);
    emit(
      `✅ worktree ${preparedWorktree.reused ? "שוחזר" : "נוצר"}; ה-checkout הראשי לא הוחלף.\n\n`,
    );

    const landingParent = path.dirname(landingWorkspace);
    const srcDir = path.join(landingWorkspace, "src");
    const appDir = path.join(srcDir, "app");
    const publicDir = path.join(landingWorkspace, "public");
    await assertManagedDirectory(landingWorkspace, landingParent);
    await assertManagedDirectory(srcDir, landingWorkspace);
    await assertManagedDirectory(appDir, srcDir);
    await assertManagedDirectory(publicDir, landingWorkspace);

    const pagePath = `src/app/${slug}/page.tsx`;
    const url = previewUrlFor(slug);
    const shotsDir = path.join(runDir, "shots");

    const pageDir = path.join(appDir, slug);
    const publicAssetsDir = path.join(publicDir, slug);
    // A rebuild from scratch re-rolls the whole page, so operator feedback
    // ("fix these two font sizes") regresses other, already-fixed details on
    // every cycle (30.08.2026, six QA rounds on an end-to-end run). When the
    // operator gave feedback and a page already exists, keep it and edit it.
    const editInPlace = Boolean(feedback) &&
      Boolean(await fs.stat(path.join(pageDir, "page.tsx")).catch(() => undefined));
    if (!editInPlace) {
      await removeManagedChildDirectory(pageDir, appDir);
      emit(`🧹 ניקיתי בנייה קודמת של ${slug}, אם הייתה.\n`);
    } else {
      emit(`✏️ יש דף קיים ומשוב מפעיל: עורך את הדף הקיים במקום לבנות מאפס.\n`);
    }
    await removeManagedChildDirectory(publicAssetsDir, publicDir);

    // pageCopyForBuild joins stage 4's approved sub-task outputs, skipping any
    // sub-task marked excludeFromPage (e.g. a webinar's thank-you page copy,
    // Task 10): that copy is real and approved, but it belongs in the
    // confirmation flow, not on the page this stage builds.
    const lpCopy = pageCopyForBuild(run) || "(stage 4 output missing)";
    const brandBrief = brandBriefForBuild(getRun(runId) ?? run);
    const designBriefBlock = renderDesignBriefBlock(getRun(runId) ?? run);
    const reference = await authorizeReferenceProject(parseReference(brandBrief), profile);
    const assetsSubTask = getRun(runId)?.stages?.find((s) => s.number === 5)?.subTasks.find((st) => st.id === "5.2");
    const assetsReport = assetsSubTask?.output ?? "";
    const assetManifestSha256 = assetsSubTask?.assetManifestSha256;
    if (assetsSubTask?.status !== "approved") {
      throw new Error(`Stage 5.2 must be approved before the landing page can be built (current: ${assetsSubTask?.status ?? "missing"})`);
    }
    if (!assetManifestSha256) throw new Error("Stage 5.2 has no sealed asset manifest approval");
    const approvedAssetsDir = path.join(runDir, "assets");
    const preparedAssets = await copyApprovedAssets(
      approvedAssetsDir,
      publicAssetsDir,
      assetManifestSha256,
    );
    const assetsBlock = await describeApprovedAssets(
      assetsReport,
      slug,
      approvedAssetsDir,
      assetManifestSha256,
    );
    const referenceBlock = await describeReference(reference);
    const standard = await readDesignStandard(
      baseWorkspace,
      profile.landing!.designStandardPath!,
    );
    const fullStandard = await readFullDesignStandard(
      baseWorkspace,
      profile.landing!.designStandardPath!,
    );
    // Read once here, not inside a template literal, so the builder prompt and
    // every design critic below all see exactly the same bytes for this run.
    const pageType: AssetType = run.assetType ?? "sales-page";
    const pageTypeBlueprint = await readRunPageTypeBlueprint(run);
    const pageTypeStructureBlock = renderPageTypeStructureBlock(pageType, pageTypeBlueprint);
    const placement = await readApprovedAssetPlacement(approvedAssetsDir, assetManifestSha256);

    emit(`📄 הדף ייווצר ב: ${pagePath}\n`);
    if (reference.url || reference.dir) emit(`📎 רפרנס: ${reference.url ?? reference.dir}\n`);
    emit(`\n🔨 בונה את הדף בתוך ה-worktree המבודד...\n\n`);

    const feedbackBlock = feedback
      ? `\n\n## ⚠️ משוב הלקוח\n\nהלקוח הגיב על הריצה הקודמת:\n\n> ${feedback}\n\nשפר בהתאם.`
      : "";

    const buildPrompt = buildLpBuildPrompt({
      editInPlace,
      pagePath,
      slug,
      brandBrief,
      referenceBlock,
      fullStandard,
      standard,
      pageTypeStructureBlock,
      assetsBlock,
      clientContext: renderClientContext(run.clientProfile),
      lpCopy,
      brief: run.brief,
      strategyDoc: run.strategyDoc,
      feedbackBlock,
      designBriefBlock,
    });

    await appendLog(
      runDir,
      logName,
      `\n## Branch: ${branchName}\n## Page path: ${pagePath}\n\n## Build prompt\n\n${buildPrompt}\n\n## Output\n\n`,
    );

    const build = await spawnAgent({
      prompt: buildPrompt,
      cwd: landingWorkspace,
      permissionMode: "dontAsk",
      tools: ["Read", "Write", "Edit", "Glob", "Grep"],
      strictMcpConfig: true,
      settingSources: [],
      disableSlashCommands: true,
      settings: buildWorkspacePermissions(landingWorkspace, pageDir),
      signal: control?.signal,
      timeoutMs: agentTimeoutMs(control),
      onToken: emit,
    });
    control?.throwIfAborted();
    const postflightArgs = {
      workspaceDir: landingWorkspace,
      initialHead,
      allowedPaths: ownPaths,
      landingParent,
      srcDir,
      appDir,
      publicDir,
      pageSourceDir: pageDir,
      publicAssetsDir,
      preparedAssets,
    };
    // The builder writes the page from scratch on every attempt and a single
    // banned construct fails the whole stage, so a static-check failure loops
    // back to the builder as a targeted repair of the existing file instead of
    // burning a human retry (30.08.2026, attempts 17-23 of an end-to-end run).
    const MAX_STATIC_REPAIRS = 2;
    const verifyWithStaticRepairs = async () => {
    for (let repair = 0; ; repair++) {
      try {
        await verifyBuilderPostflight(postflightArgs);
        break;
      } catch (error) {
        const failure = error as { name?: string; code?: string; message?: string };
        if (
          repair >= MAX_STATIC_REPAIRS ||
          failure.name !== "PagePostflightError" ||
          !["SOURCE_EXECUTION_VIOLATION", "SOURCE_MEDIA_VIOLATION", "SOURCE_INLINE_MEDIA_VIOLATION"].includes(failure.code ?? "")
        ) {
          throw error;
        }
        control?.throwIfAborted();
        emit(`\n🔧 הבודק הסטטי דחה את הדף (${failure.message ?? ""}). סבב תיקון ${repair + 1}/${MAX_STATIC_REPAIRS}...\n`);
        await spawnAgent({
          prompt: [
            `The static analyser rejected the page you just wrote. Failure: ${failure.message ?? "unknown"}.`,
            `Open ${pagePath}, locate every construct behind these violation kinds and rewrite ONLY those places so the page satisfies the "Static page contract" from your build instructions. Do not restructure sections, do not change copy, do not touch any other file.`,
            `Report the exact lines you changed.`,
          ].join("\n\n"),
          cwd: landingWorkspace,
          permissionMode: "dontAsk",
          tools: ["Read", "Write", "Edit", "Glob", "Grep"],
          strictMcpConfig: true,
          settingSources: [],
          disableSlashCommands: true,
          settings: buildWorkspacePermissions(landingWorkspace, pageDir),
          signal: control?.signal,
          timeoutMs: agentTimeoutMs(control),
          onToken: emit,
        });
      }
    }
    };
    await verifyWithStaticRepairs();
    emit("\n🧪 מריץ build מבוקר אחרי סריקת המקור...\n");
    // A preview left open by an earlier attempt on this same worktree would be
    // reused by ensurePreviewServer, so round 1 would render the previous build
    // while the image map check is sealed to the new source. Stop it first.
    stopPreview();
    await runLandingBuild(landingWorkspace, baseWorkspace, control?.signal, path.join(runDir, "logs", logName));
    await verifyBuilderPostflight(postflightArgs);

    // ===== Design rounds: render, critique, revise =====
    let referenceGroups: ShotGroup[] = [];
    const referenceTarget = reference.url;
    if (referenceTarget) {
      emit(`\n📸 מצלם את דף הרפרנס להשוואה...\n`);
      const referenceShots = await shoot(referenceTarget, shotsDir, "reference", SHOT_WIDTHS, control?.signal);
      referenceGroups = await sliceCaptures(referenceShots, path.join(shotsDir, CRITIC_STRIP_DIR), emit);
    }

    const roundLog: string[] = [];
    let passed = false;
    let lastCritiques: Critique[] = [];
    let lastImageMapCheck: ImageMapCheck | undefined;
    let lastDesertStatus: DesertStatus = { kind: "incomplete", reason: "לא נמדד" };
    const recordImageMapCheck = (check: ImageMapCheck) => {
      const current = (getRun(runId)?.stages ?? []).map((s) =>
        s.number === 5
          ? { ...s, subTasks: s.subTasks.map((st) => (st.id === SUB_ID ? { ...st, imageMapCheck: check } : st)) }
          : s,
      );
      updateRun(runId, { stages: current });
    };

    for (let round = 1; round <= MAX_ROUNDS; round++) {
      control?.throwIfAborted();
      emit(`\n---\n\n## סבב עיצוב ${round} מתוך ${MAX_ROUNDS}\n\n`);

      emit(`🚀 מרנדר את הדף...\n`);
      await ensurePreviewServer(
        path.join(runDir, "logs", "preview-server.log"),
        landingWorkspace,
        baseWorkspace,
      );
      const status = await waitForPage(url, control?.signal);
      if (status >= 400 || status === 0) throw new Error(`הדף לא נטען לצילום (HTTP ${status}) בכתובת ${url}`);

      const renderedAssetUrls = await collectRenderedAssetUrls(url, control?.signal);
      assertRenderedImageUrls(renderedAssetUrls, {
        pageUrl: url,
        slug,
        approvedBasenames: Object.keys(preparedAssets),
      });

      lastImageMapCheck = await runImageMapCheck({
        pageUrl: url,
        slug,
        placement,
        pageSourceHashes: await sealPageSourceTree(pageDir),
        assetManifestSha256,
        attemptStartedAt: startedAt,
        probe: (target) => collectVisibleImages(target, control?.signal),
      });
      control?.throwIfAborted();
      recordImageMapCheck(lastImageMapCheck);
      emit(
        lastImageMapCheck.passed
          ? `🗺️ מפת התמונות: ${lastImageMapCheck.mappedCount} תמונות ממופות מוצגות בשני הרוחבים.\n`
          : `🗺️ מפת התמונות לא עוברת: ${lastImageMapCheck.failure ?? lastImageMapCheck.missing.map((m) => `${m.file} (${widthsLabel(m.widths)})`).join(", ")}\n`,
      );

      const shots = await shoot(url, shotsDir, `round-${round}`, SHOT_WIDTHS, control?.signal);
      if (!shots.length) throw new Error("לא הצלחתי לצלם את הדף");
      const shotGroups = await sliceCaptures(shots, path.join(shotsDir, CRITIC_STRIP_DIR), emit);
      const stripCount = shotGroups.reduce((total, group) => total + group.files.length, 0);
      emit(`📸 ${shots.length} צילומים, ${stripCount} רצועות לקריאה.\n\n`);

      let desertWarning = "";
      try {
        const desert = await measureTextDeserts(url, control?.signal);
        await appendLog(runDir, logName, `\n## Text desert, round ${round}\n\n${JSON.stringify(desert)}\n`);
        desertWarning = renderDesertWarning(desert);
        lastDesertStatus = desertWarning ? { kind: "warning", text: desertWarning } : { kind: "ok" };
        if (desertWarning) emit(`🏜️ ${desertWarning}\n`);
      } catch (error) {
        control?.throwIfAborted();
        const reason = error instanceof Error ? error.message : String(error);
        lastDesertStatus = { kind: "incomplete", reason };
        emit(`⚠️ מדידת מדבר הטקסט לא הושלמה ולא נחשבת: ${reason}\n`);
      }

      lastCritiques = await critiqueRound({
        runDir,
        round,
        shotGroups,
        referenceGroups,
        brandBrief,
        standard,
        pageTypeStructureBlock,
        placementBlock: placement.mapped.length ? renderPlacementTable(slug, placement.mapped) : "",
        desertWarning,
        emit,
        control,
      });

      const mapCritique = imageMapCritique(lastImageMapCheck);
      if (mapCritique) lastCritiques = [...lastCritiques, mapCritique];

      const { passing, failing, silent } = splitCritiques(lastCritiques);
      roundLog.push(
        `- סבב ${round}: ${passing.length}/${lastCritiques.length} עברו` +
          (failing.length ? ` (${failing.map((c) => c.name).join(", ")} לא)` : "") +
          (silent.length ? ` (${silent.map((c) => c.name).join(", ")} לא הצביע)` : ""),
      );

      if (!failing.length && !silent.length) {
        passed = true;
        emit(`\n✅ כל המבקרים עברו בסבב ${round}.\n`);
        break;
      }

      if (!failing.length) {
        // Nobody wrote a blocker, so there is nothing to send the builder.
        // The page is not waved through either: a human decides.
        emit(`\n⚠️ אין חוסמים ידועים, אבל ${silent.map((c) => c.name).join(", ")} לא החזיר פסק דין קריא גם אחרי שאלה חוזרת. אין מה לתקן; מעביר אליך להחלטה.\n`);
        break;
      }

      if (round === MAX_ROUNDS) {
        emit(`\n⚠️ נגמרו הסבבים ועדיין יש חוסמים. מעביר אליך כמו שזה.\n`);
        break;
      }

      emit(`\n🔧 דניאל מתקן לפי הביקורת...\n\n`);
      stopPreview();
      const revisePrompt = buildRevisePrompt({ pagePath, slug, failing });

      await appendLog(runDir, logName, `\n\n## Revise prompt (round ${round})\n\n${revisePrompt}\n\n## Output\n\n`);
      await spawnAgent({
        prompt: revisePrompt,
        cwd: landingWorkspace,
        permissionMode: "dontAsk",
        tools: ["Read", "Write", "Edit", "Glob", "Grep"],
        strictMcpConfig: true,
        settingSources: [],
        disableSlashCommands: true,
        settings: buildWorkspacePermissions(landingWorkspace, pageDir),
        signal: control?.signal,
        timeoutMs: agentTimeoutMs(control),
        onToken: emit,
      });
      control?.throwIfAborted();
      await verifyWithStaticRepairs();
      await runLandingBuild(landingWorkspace, baseWorkspace, control?.signal, path.join(runDir, "logs", logName));
      await verifyBuilderPostflight(postflightArgs);
    }

    // A final check is required even when the last design round passed without
    // a revision. Nothing produced by the builder or its critics may replace,
    // remove, or add files outside the human-approved asset snapshot.
    await verifyBuilderPostflight(postflightArgs);

    let verifiedPath: string | null = null;
    try {
      await fs.access(path.join(landingWorkspace, pagePath));
      verifiedPath = pagePath;
    } catch {
      verifiedPath = null;
    }

    const pageSourceHashes = await sealPageSourceTree(pageDir);
    const finalImageMapCheck = finalizeImageMapCheck(lastImageMapCheck, {
      attemptStartedAt: startedAt,
      assetManifestSha256,
      pageSourceHashes,
    });
    if (!finalImageMapCheck?.passed) passed = false;
    const finalMapCritique = finalImageMapCheck ? imageMapCritique(finalImageMapCheck) : null;
    if (finalMapCritique) {
      lastCritiques = [...lastCritiques.filter((c) => c.name !== IMAGE_MAP_CRITIC_NAME), finalMapCritique];
    }

    const summary = [
      "",
      "---",
      "",
      "### 📦 סיכום שלב 5.3",
      "",
      `- **ענף טיוטה:** \`${branchName}\` (יישמר ב-commit רק לאחר אישור התצוגה)`,
      `- **דף:** \`${verifiedPath ?? "לא אומת — בדוק ידנית את הענף"}\``,
      `- **רפרנס:** ${reference.url ?? reference.dir ?? "לא היה"}`,
      `- **סבבי עיצוב:**`,
      ...roundLog.map((l) => `  ${l}`),
      `- **פסק דין סופי:** ${finalVerdictLabel(passed, lastCritiques)}`,
      `- **${IMAGE_MAP_CRITIC_NAME}:** ${finalImageMapCheck?.passed ? "✅ כל התמונות הממופות מוצגות" : `⚠️ ${finalImageMapCheck?.failure ?? "לא עוברת"}`}`,
      `- **מדבר טקסט במובייל (אזהרה בלבד):** ${renderDesertSummary(lastDesertStatus)}`,
      "",
      passed
        ? "אשר כדי לעבור לתצוגה המקומית."
        : splitCritiques(lastCritiques).failing.length
          ? "נשארו חוסמים אחרי " + roundLog.length + " סבבים. תסתכל על הביקורת האחרונה למטה ותחליט: לאשר בכל זאת, או לשלוח משוב וסבב נוסף."
          : "אף מבקר לא כתב חוסם, אבל לא כולם הצביעו. תסתכל על הדף ותחליט: לאשר, או לשלוח משוב וסבב נוסף.",
      "",
      ...(splitCritiques(lastCritiques).failing.length
        ? ["", "### ⚠️ חוסמים שנשארו", "", ...splitCritiques(lastCritiques).failing.map((c) => `#### ${c.name}\n\n${c.text}`)]
        : []),
      ...(splitCritiques(lastCritiques).silent.length
        ? ["", "### ⚠️ לא הצביעו (פסק דין לא קריא גם אחרי שאלה חוזרת)", "", ...splitCritiques(lastCritiques).silent.map((c) => `- ${c.name}`)]
        : []),
      "",
    ].join("\n");

    const fullOutput = build.fullText + summary;
    emit(summary);

    control?.throwIfAborted();
    await saveRunArtifact(runDir, "stage-5.md", fullOutput);
    control?.throwIfAborted();

    const finalStages = (getRun(runId)?.stages ?? []).map((s) =>
      s.number === 5
        ? {
            ...s,
            subTasks: s.subTasks.map((st) =>
              st.id === SUB_ID
                ? {
                    ...st,
                    status: "awaiting-decision" as const,
                    output: fullOutput,
                    completedAt: new Date().toISOString(),
                    preparedAssetHashes: preparedAssets,
                    pageSourceHashes,
                    assetManifestSha256,
                    designReview: {
                      schemaVersion: 1 as const,
                      passed,
                      failing: splitCritiques(lastCritiques).failing.map((c) => c.name),
                      silent: splitCritiques(lastCritiques).silent.map((c) => c.name),
                      checkedAt: new Date().toISOString(),
                    },
                    landingHeadSha: initialHead,
                    pageSlug: slug,
                    landingWorktreePath: landingWorkspace,
                    imageMapCheck: finalImageMapCheck,
                  }
                : st,
            ),
          }
        : s,
    );
    updateRun(runId, { stages: finalStages });
    eventBus.emit(runId, { type: "subtask-completed", runId, stageNumber: 5, subTaskId: SUB_ID, content: fullOutput });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const errStages = (getRun(runId)?.stages ?? []).map((s) =>
      s.number === 5
        ? {
            ...s,
            status: "error" as const,
            errorMessage,
            subTasks: s.subTasks.map((st) =>
              st.id === SUB_ID ? { ...st, status: "error" as const, errorMessage } : st,
            ),
          }
        : s,
    );
    updateRun(runId, { stages: errStages });
    if (!control?.signal.aborted) {
      eventBus.emit(runId, { type: "subtask-error", runId, stageNumber: 5, subTaskId: SUB_ID, errorMessage });
      eventBus.emit(runId, { type: "stage-error", runId, stageNumber: 5, errorMessage });
    }
    await appendLog(runDir, logName, `\n\n## ERROR\n\n${errorMessage}\n`).catch(() => {});
    throw err;
  }
}
