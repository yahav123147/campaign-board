import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { eventBus } from "./eventBus";
import { getRun, updateRun } from "./runRegistry";
import { lpSlugFor } from "./runStage5LpBuild";
import { appendLog, saveRunArtifact } from "@/lib/runStore";
import {
  PREVIEW_PORT,
  previewUrlFor,
  collectRenderedAssetUrls,
  ensurePreviewServer,
  waitForPage,
  openInBrowser,
} from "./previewServer";
import {
  readApprovedAssetFiles,
} from "./assetQuality";
import {
  runLandingGit,
  verifyBuilderPostflight,
} from "./runStage5LpBuild";
import {
  assertPageSourceMatchesSeal,
  assertRenderedImageUrls,
  hashPageSourceManifest,
} from "./pagePostflight";
import type { ExecutionControl } from "./executionService";
import { assertClientFeatureReady } from "./stage89Safety";
import {
  assertSameGitRepository,
  commitLandingDelivery,
  landingWorktreePath,
} from "./landingWorktree";
import { resolveContainedWorkspaceFile } from "./designStandard";
import {
  signalTrackedChildProcess,
  supervisedProcessTreeLaunch,
  trackChildProcess,
} from "./childProcessRegistry";

const QA_WIDTHS = ["320", "360", "390", "430", "768", "1280"];

export interface QaGateAssessment {
  passed: boolean;
  summary: string;
  reason?: string;
}


/** Only the per-width verdict lines. The full report stays in the run log. */
export function compactQa(raw: string): string {
  return raw
    .split("\n")
    .filter((line) => /^(PASS|FAIL|RESULT)\b/.test(line.trim()))
    .join("\n")
    .trim();
}

/**
 * Validate the QA subprocess protocol fail-closed. A zero exit code alone is
 * not enough: every requested viewport must have exactly one PASS verdict and
 * the report must contain exactly one final RESULT: PASS line.
 */
export function assessQaGate(
  code: number,
  raw: string,
  expectedWidths: readonly string[] = QA_WIDTHS,
): QaGateAssessment {
  const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean);
  const results = lines.filter((line) => /^RESULT:\s+(?:PASS|FAIL)\b/.test(line));
  const verdicts = lines
    .map((line) => /^(PASS|FAIL)\s+(\d+)px\b/.exec(line))
    .filter((match): match is RegExpExecArray => Boolean(match));
  const expected = [...expectedWidths].sort();
  const passedWidths = verdicts
    .filter((match) => match[1] === "PASS")
    .map((match) => match[2])
    .sort();

  let reason: string | undefined;
  if (code !== 0) reason = `process exited with code ${code}`;
  else if (results.length !== 1) reason = `expected one final result, found ${results.length}`;
  else if (!/^RESULT:\s+PASS\s*$/.test(results[0])) reason = "the final result was not PASS";
  else if (verdicts.some((match) => match[1] === "FAIL")) reason = "one or more viewport checks failed";
  else if (JSON.stringify(passedWidths) !== JSON.stringify(expected)) {
    reason = "the viewport PASS set was incomplete or duplicated";
  }

  const compact = compactQa(raw);
  const passed = reason === undefined;
  return {
    passed,
    summary: passed
      ? compact
      : [compact, `RESULT: FAIL (QA protocol rejected: ${reason})`].filter(Boolean).join("\n"),
    ...(reason ? { reason } : {}),
  };
}

/**
 * The link is the whole point of this sub-task, so it opens the block and
 * closes it. A reviewer once approved a page without seeing it because the URL sat
 * above a screenful of QA output and the approve buttons sat below it.
 */
export function formatPreviewOutput(
  url: string,
  branch: string,
  qaSummary: string,
  opened: boolean,
  qaPassed?: boolean,
): string {
  const passed = qaPassed ?? (/^RESULT:\s+PASS\s*$/m.test(qaSummary) && !/^RESULT:\s+FAIL\b/m.test(qaSummary));
  return [
    `## 👀 ${url}`,
    "",
    opened
      ? "הדף נפתח לך בדפדפן. תסתכל עליו לפני שאתה מאשר."
      : "תפתח את הכתובת למעלה ותסתכל על הדף לפני שאתה מאשר.",
    "",
    `- ענף טיוטה: \`${branch}\` (האישור ישמור commit מבוקר בענף)`,
    `- שער QA: ${passed ? "✅ עבר" : "⚠️ נכשל"}`,
    "",
    "```",
    qaSummary,
    "```",
    "",
    passed
      ? ""
      : "שער ה-QA חסם מסירה. שלח משוב לתיקון והריצה תחזור על הבנייה והבדיקה לפני שניתן יהיה לאשר.",
    "",
    `**הדף לאישור: ${url}**`,
    "",
  ].join("\n");
}

async function runQaGate(
  url: string,
  workspaceDir: string,
  dependencyWorkspace: string,
  qaScriptRelativePath: string,
  signal?: AbortSignal,
): Promise<{ code: number; output: string }> {
  const qaScript = await resolveContainedWorkspaceFile(
    dependencyWorkspace,
    qaScriptRelativePath,
    512 * 1024,
  );
  const launch = supervisedProcessTreeLaunch(
    process.execPath,
    [qaScript, url, ...QA_WIDTHS],
  );
  return new Promise((resolve) => {
    const proc = spawn(launch.command, [...launch.args], {
      cwd: workspaceDir,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      shell: false,
      detached: process.platform !== "win32",
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        LANG: process.env.LANG,
        LC_ALL: process.env.LC_ALL,
        TMPDIR: process.env.TMPDIR,
        NODE_ENV: "production",
        NODE_PATH: path.join(dependencyWorkspace, "node_modules"),
        NEXT_TELEMETRY_DISABLED: "1",
      },
    });
    trackChildProcess(proc, "landing-qa", { supervisedProcessTree: true });
    let output = "";
    let settled = false;
    let closed = false;
    let forceKill: NodeJS.Timeout | undefined;
    const finish = (result: { code: number; output: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (closed && forceKill) clearTimeout(forceKill);
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const killTree = (name: NodeJS.Signals) => {
      signalTrackedChildProcess(proc, name);
    };
    const onAbort = () => {
      killTree("SIGTERM");
      forceKill = setTimeout(() => killTree("SIGKILL"), 2_000);
      forceKill.unref();
      finish({ code: -1, output: `${output}\nQA gate aborted` });
    };
    const timeout = setTimeout(() => {
      killTree("SIGTERM");
      forceKill = setTimeout(() => killTree("SIGKILL"), 2_000);
      forceKill.unref();
      finish({ code: -1, output: `${output}\nQA gate timed out` });
    }, 180_000);
    timeout.unref();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    const capture = (chunk: Buffer | string) => {
      const text = chunk.toString();
      if (Buffer.byteLength(output) + Buffer.byteLength(text) > 4 * 1024 * 1024) {
        killTree("SIGTERM");
        forceKill = setTimeout(() => killTree("SIGKILL"), 2_000);
        forceKill.unref();
        finish({ code: -1, output: `${output}\nQA gate exceeded its output limit` });
        return;
      }
      output += text;
    };
    proc.stdout!.on("data", capture);
    proc.stderr!.on("data", capture);
    proc.on("close", (code) => {
      closed = true;
      if (forceKill) clearTimeout(forceKill);
      finish({ code: code ?? -1, output });
    });
    proc.on("error", (err) => finish({ code: -1, output: String(err) }));
  });
}

async function stage5Workspaces(
  runId: string,
  runDir: string,
): Promise<{
  workspaceDir: string;
  dependencyWorkspace: string;
  qaScriptRelativePath: string;
}> {
  const run = getRun(runId);
  if (!run?.clientProfile) throw new Error("This legacy run has no sealed client profile");
  const profile = assertClientFeatureReady(run.clientProfile, "stage5");
  const buildTask = getRun(runId)?.stages
    ?.find((stage) => stage.number === 5)
    ?.subTasks.find((task) => task.id === "5.3");
  const expected = landingWorktreePath(runDir);
  if (!buildTask?.landingWorktreePath || path.resolve(buildTask.landingWorktreePath) !== expected) {
    throw new Error("Stage 5.3 does not reference this run's isolated landing worktree");
  }
  const stat = await fs.lstat(expected).catch(() => undefined);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("The isolated landing worktree is missing or unsafe");
  }
  const workspaceDir = await fs.realpath(expected);
  await assertSameGitRepository(profile.landing!.workspacePath!, workspaceDir);
  return {
    workspaceDir,
    dependencyWorkspace: profile.landing!.workspacePath!,
    qaScriptRelativePath: profile.landing!.qaScriptPath!,
  };
}

export async function verifyStage5PreviewSnapshot(
  runId: string,
  runDir: string,
  options: { rendered?: boolean; signal?: AbortSignal; expectedHead?: string } = {},
): Promise<{ branch: string; slug: string; url: string }> {
  const run = getRun(runId);
  const stage5 = run?.stages?.find((stage) => stage.number === 5);
  const assetsTask = stage5?.subTasks.find((task) => task.id === "5.2");
  const buildTask = stage5?.subTasks.find((task) => task.id === "5.3");
  if (!run || !stage5 || !assetsTask || !buildTask) {
    throw new Error("Stage 5 approval snapshot is incomplete");
  }
  if (assetsTask.status !== "approved" || !assetsTask.assetManifestSha256) {
    throw new Error("Stage 5.2 asset approval is no longer valid");
  }
  if (buildTask.status !== "approved") {
    throw new Error(`Stage 5.3 must be approved before preview (current: ${buildTask.status})`);
  }
  const slug = lpSlugFor(run.brief, runId);
  if (buildTask.pageSlug !== slug) throw new Error("Built page slug does not match this run");
  if (!buildTask.landingHeadSha || !buildTask.preparedAssetHashes || !buildTask.pageSourceHashes) {
    throw new Error("Stage 5.3 has no sealed page build snapshot");
  }
  if (buildTask.assetManifestSha256 !== assetsTask.assetManifestSha256) {
    throw new Error("Stage 5.3 was built from a different asset approval");
  }

  const { workspaceDir } = await stage5Workspaces(runId, runDir);

  const expectedBranch = `campaign-council-${runId}`;
  const branchResult = await runLandingGit(
    ["branch", "--show-current"],
    workspaceDir,
    options.signal,
  );
  const branch = branchResult.stdout.trim();
  if (branchResult.code !== 0 || branch !== expectedBranch) {
    throw new Error(
      `Landing-page branch mismatch: expected ${expectedBranch}, found ${branch || "none"}`,
    );
  }

  const approvedFiles = await readApprovedAssetFiles(path.join(runDir, "assets"), {
    requireApproval: true,
    expectedManifestSha256: assetsTask.assetManifestSha256,
  });
  const preparedFiles = Object.keys(buildTask.preparedAssetHashes).sort();
  if (JSON.stringify(approvedFiles.sort()) !== JSON.stringify(preparedFiles)) {
    throw new Error("Prepared page assets no longer match the sealed asset manifest");
  }

  const landingParent = path.dirname(workspaceDir);
  const srcDir = path.join(workspaceDir, "src");
  const appDir = path.join(srcDir, "app");
  const publicDir = path.join(workspaceDir, "public");
  const pageSourceDir = path.join(appDir, slug);
  const publicAssetsDir = path.join(publicDir, slug);
  await verifyBuilderPostflight({
    workspaceDir,
    initialHead: options.expectedHead ?? buildTask.landingCommitSha ?? buildTask.landingHeadSha,
    allowedPaths: [`src/app/${slug}/`, `public/${slug}/`],
    landingParent,
    srcDir,
    appDir,
    publicDir,
    pageSourceDir,
    publicAssetsDir,
    preparedAssets: buildTask.preparedAssetHashes,
  });
  await assertPageSourceMatchesSeal(pageSourceDir, buildTask.pageSourceHashes);

  const url = previewUrlFor(slug);
  if (options.rendered) {
    const status = await waitForPage(url, options.signal);
    if (status === 0 || status >= 400) {
      throw new Error(`The sealed page did not render successfully at ${url} (HTTP ${status})`);
    }
    assertRenderedImageUrls(await collectRenderedAssetUrls(url, options.signal), {
      pageUrl: url,
      slug,
      approvedBasenames: preparedFiles,
    });
  }
  return { branch, slug, url };
}

/**
 * Commit the exact page that passed QA and human review. If Git succeeded but
 * run.json persistence was interrupted, the direct-child delivery commit is
 * verified and reused on the next approval attempt.
 */
export async function deliverStage5LandingPage(
  runId: string,
  runDir: string,
  signal?: AbortSignal,
): Promise<{ branch: string; slug: string; url: string; commitSha: string }> {
  const run = getRun(runId);
  const buildTask = run?.stages
    ?.find((stage) => stage.number === 5)
    ?.subTasks.find((task) => task.id === "5.3");
  const assetsTask = run?.stages
    ?.find((stage) => stage.number === 5)
    ?.subTasks.find((task) => task.id === "5.2");
  const previewTask = run?.stages
    ?.find((stage) => stage.number === 5)
    ?.subTasks.find((task) => task.id === "5.4");
  if (!buildTask?.landingHeadSha || !buildTask.pageSlug) {
    throw new Error("Stage 5.3 has no deliverable landing snapshot");
  }
  const qa = previewTask?.qaVerification;
  if (!qa?.ready || !buildTask.pageSourceHashes || !assetsTask?.assetManifestSha256) {
    throw new Error("Stage 5.4 has no passing QA receipt for this build");
  }
  if (
    qa.pageSourceManifestSha256 !== hashPageSourceManifest(buildTask.pageSourceHashes)
    || qa.assetManifestSha256 !== assetsTask.assetManifestSha256
  ) {
    throw new Error("Stage 5.4 QA receipt does not match the current source and assets");
  }

  const { workspaceDir } = await stage5Workspaces(runId, runDir);
  const head = await runLandingGit(["rev-parse", "HEAD"], workspaceDir, signal);
  if (head.code !== 0) throw new Error("Could not inspect the landing branch before delivery");
  if (head.stdout.trim() === buildTask.landingHeadSha) {
    await verifyStage5PreviewSnapshot(runId, runDir, {
      rendered: true,
      signal,
      expectedHead: buildTask.landingHeadSha,
    });
  }

  const branchName = `campaign-council-${runId}`;
  if (!buildTask.pageSourceHashes || !buildTask.preparedAssetHashes) {
    throw new Error("Stage 5.3 has no complete delivery file seal");
  }
  const expectedFiles = {
    ...Object.fromEntries(
      Object.entries(buildTask.pageSourceHashes).map(([file, hash]) => [
        `src/app/${buildTask.pageSlug}/${file}`,
        hash,
      ]),
    ),
    ...Object.fromEntries(
      Object.entries(buildTask.preparedAssetHashes).map(([file, hash]) => [
        `public/${buildTask.pageSlug}/${file}`,
        hash,
      ]),
    ),
  };
  const delivery = await commitLandingDelivery({
    workspacePath: workspaceDir,
    branchName,
    initialHead: buildTask.landingHeadSha,
    allowedPaths: [
      `src/app/${buildTask.pageSlug}/`,
      `public/${buildTask.pageSlug}/`,
    ],
    expectedFiles,
    runId,
    signal,
  });
  const verified = await verifyStage5PreviewSnapshot(runId, runDir, {
    rendered: true,
    signal,
    expectedHead: delivery.commitSha,
  });
  return { ...verified, commitSha: delivery.commitSha };
}

/**
 * Sub-task 5.3: put the page the human reviewer is about to approve in front of them.
 * Serves the branch locally and runs the landing QA gate against it, so the
 * approval decision is made on a rendered page, not on a build log.
 */
export async function runStage5Preview(
  runId: string,
  runDir: string,
  feedback?: string,
  control?: ExecutionControl,
): Promise<void> {
  control?.throwIfAborted();
  const run = getRun(runId);
  if (!run) throw new Error(`Run ${runId} not found`);
  if (!run.stages) throw new Error(`Run ${runId} has no stages initialized`);

  const SUB_ID = "5.4";
  const logName = "stage-5-4-preview.log";
  const startedAt = new Date().toISOString();

  const setSubTask = (patch: Record<string, unknown>) => {
    const stages = (getRun(runId)?.stages ?? []).map((s) =>
      s.number === 5
        ? {
            ...s,
            status: "running" as const,
            errorMessage: undefined,
            currentSubTaskId: SUB_ID,
            subTasks: s.subTasks.map((st) => (st.id === SUB_ID ? { ...st, ...patch } : st)),
          }
        : s,
    );
    updateRun(runId, { stages, currentStage: 5 });
  };

  const token = (t: string) => {
    control?.throwIfAborted();
    eventBus.emit(runId, { type: "subtask-token", runId, stageNumber: 5, subTaskId: SUB_ID, token: t });
    appendLog(runDir, logName, t).catch(() => {});
  };

  setSubTask({
    status: "running",
    output: "",
    errorMessage: undefined,
    qaVerification: undefined,
    startedAt,
    feedbackHistory: feedback
      ? [...(run.stages.find((s) => s.number === 5)?.subTasks.find((st) => st.id === SUB_ID)?.feedbackHistory ?? []), feedback]
      : undefined,
  });
  eventBus.emit(runId, { type: "subtask-started", runId, stageNumber: 5, subTaskId: SUB_ID });

  try {
    const { workspaceDir, dependencyWorkspace, qaScriptRelativePath } = await stage5Workspaces(runId, runDir);
    token(`\n🚀 מרים שרת תצוגה על פורט ${PREVIEW_PORT}...\n`);
    await ensurePreviewServer(
      path.join(runDir, "logs", "preview-server.log"),
      workspaceDir,
      dependencyWorkspace,
    );

    token(`⏳ מקמפל את הדף (פעם ראשונה לוקח זמן)...\n`);
    const { branch, url } = await verifyStage5PreviewSnapshot(runId, runDir, {
      rendered: true,
      signal: control?.signal,
    });
    token(`🌿 ענף ב-landing-pages: ${branch}\n`);
    token(`✅ הדף עלה: ${url}\n`);

    const opened = openInBrowser(url);
    if (opened) token("🌐 פתחתי לך אותו בדפדפן.\n");

    token(`\n🔍 מריץ את שער ה-QA על ${QA_WIDTHS.join(", ")} פיקסל...\n\n`);
    const qa = await runQaGate(
      url,
      workspaceDir,
      dependencyWorkspace,
      qaScriptRelativePath,
      control?.signal,
    );
    control?.throwIfAborted();
    await appendLog(runDir, logName, `\n## QA full report\n\n${qa.output}\n`).catch(() => {});
    const assessment = assessQaGate(qa.code, qa.output);
    token(assessment.summary + "\n");

    // QA and browser scripts run after the first seal check. Re-check the
    // exact branch, source scope, public bytes and rendered URLs before this
    // snapshot can enter awaiting-decision.
    await verifyStage5PreviewSnapshot(runId, runDir, {
      rendered: true,
      signal: control?.signal,
    });

    const currentStage = getRun(runId)?.stages?.find((stage) => stage.number === 5);
    const currentBuild = currentStage?.subTasks.find((task) => task.id === "5.3");
    const currentAssets = currentStage?.subTasks.find((task) => task.id === "5.2");
    if (!currentBuild?.pageSourceHashes || !currentAssets?.assetManifestSha256) {
      throw new Error("QA completed without a sealed Stage 5 build snapshot");
    }
    const qaVerification = assessment.passed
      ? {
          schemaVersion: 1 as const,
          ready: true as const,
          reportSha256: crypto.createHash("sha256").update(qa.output).digest("hex"),
          pageSourceManifestSha256: hashPageSourceManifest(currentBuild.pageSourceHashes),
          assetManifestSha256: currentAssets.assetManifestSha256,
          widths: QA_WIDTHS.map(Number),
          checkedAt: new Date().toISOString(),
        }
      : undefined;
    const output = formatPreviewOutput(url, branch, assessment.summary, opened, assessment.passed);
    token("\n" + output);
    control?.throwIfAborted();
    await saveRunArtifact(runDir, "stage-5-4-preview.md", output);

    control?.throwIfAborted();
    setSubTask({
      status: "awaiting-decision",
      output,
      completedAt: new Date().toISOString(),
      qaVerification,
    });
    eventBus.emit(runId, { type: "subtask-completed", runId, stageNumber: 5, subTaskId: SUB_ID, content: output });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    setSubTask({ status: "error", errorMessage });
    if (!control?.signal.aborted) {
      eventBus.emit(runId, { type: "subtask-error", runId, stageNumber: 5, subTaskId: SUB_ID, errorMessage });
    }
    await appendLog(runDir, logName, `\n\n## ERROR\n\n${errorMessage}\n`).catch(() => {});
    throw err;
  }
}
