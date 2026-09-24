import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { resolvedAgentTimeoutMs, spawnAgent } from "./spawnAgent";
import { loadAgents } from "./loadAgents";
import { eventBus } from "./eventBus";
import { getRun, updateRun } from "./runRegistry";
import { appendLog, saveRunArtifact } from "@/lib/runStore";
import { assetPreambleFor, getSubTaskDef, pageCopyForBuild, pageTypeRequiresMockups } from "./stageRegistry";
import { readRunPageTypeBlueprint } from "./pageTypeBlueprint";
import { renderCopyStandard } from "./copyStandard";
import { openInBrowser } from "./previewServer";
import { buildContactSheetWithStatus, parseAssetCaptions } from "./contactSheet";
import { authorizeReferenceProject, parseReference } from "./designStandard";
import { absolutePathRule, brandBriefForBuild } from "./runStage5LpBuild";
import {
  ASSET_APPROVAL_NAME,
  MAX_CONTACT_SHEET_BYTES,
  ASSET_MANIFEST_NAME,
  ASSET_PLAN_NAME,
  ensureManagedDirectory,
  readReusableAssetHashes,
  readSealedApprovedAssetHashes,
  recoverCutoutTransactions,
  atomicCreateManagedFile,
  hasValidAssetPlan,
  isSafeAssetFileName,
  mockupEntriesFor,
  readAssetPlanEntries,
  placementFields,
  snapshotAssetHashes,
  validateAssetFolderSnapshot,
  createAssetThumbnailDataUrls,
  SCREENS_DIR,
  SCREEN_SIZES_NAME,
  MAX_SCREEN_EDGE_PX,
  SANDBOX_CONTROL_DIR,
} from "./assetQuality";
import type { AssetManifest, AssetManifestEntry, AssetPlanEntry, MockupRenderContext } from "./assetQuality";
import { describeMockupBases, packagedMockupBasesDir, renderMockups, type MockupBaseDescription } from "./mockupRenderer";
import {
  MAX_MOCKUP_NAME_CHARS,
  MAX_RECEIPT_FILE_CHARS,
  MAX_RENDER_REGIONS,
  MAX_SCREEN_DATA_BYTES,
  MAX_SCREEN_HTML_BYTES,
} from "@/lib/mockupContract";
import { parseDesignBriefJson } from "./designBriefJson";
import type { DesignBriefRequiredMockup } from "./designBriefJson";
import type { MockupRenderReceipt } from "@/types";
import { HARVEST_DIR, latestHandleInFeedback, siteUrlsFromBrief } from "./runStage1Harvest";
import { captureInstagramProof, liveProofEnabled } from "./liveProof";
import { agentTimeoutMs } from "./executionService";
import type { ExecutionControl } from "./executionService";
import { assertClientFeatureReady } from "./stage89Safety";
import { renderClientContext } from "./clientContext";
import { resolvePython } from "./runStage7Creatives";
import { availableImageSystemTools, imageSystemToolsLine } from "./imageSystemTools";
import type { AssetType, Run } from "@/types";

const SUB_ID = "5.2";
const IMAGE_RE = /\.(webp|png|jpe?g|svg|avif)$/i;

/**
 * The stage 4 warning (F page-types) for a run whose page type is not a sales
 * page but has no blueprint file on disk: the run is not blocked, it just
 * falls back to the code-level instructions for that type, and the operator
 * needs to see why. A sales page has no blueprint by design and never warns.
 */
/**
 * The base frames the agent may composite onto, one line each, with the exact
 * screen size every region needs. A frame whose regions could not be read is
 * said to be unreadable rather than left out: the agent still writes and
 * declares its screens, and the renderer rejects what does not fit with its
 * own reason instead of the run inventing sizes.
 */
export function renderMockupBasesBlock(bases: readonly MockupBaseDescription[]): string {
  return bases
    .map((base) => {
      if (base.regions.length) {
        return `- בסיס \`${base.base}\`: ${base.regions.map((region) => `אזור "${region.id}" דורש מסך ${region.width}x${region.height} פיקסלים`).join(", ")}.`;
      }
      // A frame over the render ceiling was read successfully and still cannot
      // be composited onto here. Nothing the agent writes changes that, so it
      // is told to leave the frame alone instead of producing screens that
      // will be rejected, and the reason names the region and the size.
      if (base.unusable) {
        return `- בסיס \`${base.base}\`: לא ניתן לרנדר על המסגרת הזאת בהתקנה הזאת (${base.error ?? "ללא סיבה"}). אל תצהיר על מוקאפ עם הבסיס הזה; מוקאפ כזה ייפסל.`;
      }
      return `- בסיס \`${base.base}\`: לא ניתן לקרוא את אזורי המסגרת בריצה הזאת (${base.error ?? "ללא סיבה"}). הצהר על המסכים ועל render כרגיל; מוקאפ שמידותיו לא יתאימו לאזור ייפסל בשלב הרינדור עם הסיבה.`;
    })
    .join("\n");
}

/**
 * A worked mockup example built from the frames this run will actually
 * composite onto.
 *
 * The schema example is the only fully worked example the agent gets, so it
 * must be legal: hand written ids and sizes drifted from the installed frames
 * and taught the agent a map the renderer rejects. A chapter mockup is the
 * common case (one per module), so it is the example whenever its frame could
 * be read; with no readable frame the example falls back to placeholders and
 * the listing says why.
 */
interface MockupPlanExample {
  base: string;
  screens: string[];
  map: Record<string, string>;
  sizes: Record<string, [number, number]>;
}

function mockupPlanExample(bases: readonly MockupBaseDescription[]): MockupPlanExample | undefined {
  const base = bases.find((candidate) => candidate.base === "chapter" && candidate.regions.length)
    ?? bases.find((candidate) => candidate.regions.length);
  if (!base) return undefined;
  const example: MockupPlanExample = { base: base.base, screens: [], map: {}, sizes: {} };
  for (const region of base.regions) {
    const name = `ch1-screen-${region.id}`;
    example.screens.push(name);
    example.map[String(region.id)] = name;
    example.sizes[name] = [region.width, region.height];
  }
  return example;
}

export function renderMissingPageTypeBlueprintWarning(
  assetType: AssetType | undefined,
  blueprint: string,
): string {
  if (blueprint) return "";
  if (!assetType || assetType === "sales-page") return "";
  return `⚠️ תבנית סוג הדף (${assetType}) לא נמצאה. ממשיכים על ההוראות שבקוד.\n`;
}

/**
 * Stage 5.2 maps every placeable image to a section and a headline, so it must
 * read the same approved copy the builder will implement. Same source as the
 * builder (pageCopyForBuild), so flagged sub-tasks stay out of both.
 */
export function renderApprovedCopyBlock(run: Run): { block: string; warning: string } {
  const copy = pageCopyForBuild(run).trim();
  // Stage 4 with every sub-task approved but empty joins into a separators-only
  // string (pageCopyForBuild does not skip blank outputs), which is truthy but
  // carries no real copy. Strip the separators before judging emptiness.
  const hasRealCopy = copy.replace(/-{3,}/g, "").trim() !== "";
  if (!hasRealCopy) {
    return {
      block: "### הקופי שאושר בשלב 4\n(אין קופי מאושר משלב 4. אי אפשר למפות נכסים לסקציות, ולכן כל נכס להצבה יסומן לבדיקה בגיליון)",
      warning: "⚠️ לא נמצא קופי מאושר משלב 4. הנכסים יופקו בלי מפה לסקציות.\n",
    };
  }
  return {
    block: `### הקופי שאושר בשלב 4\nזה המקור היחיד לשמות הסקציות ולכותרות שבשדות section ו-proves.\n\n${copy}`,
    warning: "",
  };
}

/**
 * The root of a venv interpreter path (the parent of its bin/ dir), only when
 * the interpreter is an absolute path (a venv, e.g.
 * ~/.campaign-council-venv/bin/python3). resolvePython() otherwise returns
 * the bare "python3" resolved on PATH, which is not absolute and yields no
 * root here, so the sandbox's allowRead is left untouched.
 */
export function pythonVenvRoot(python: string): string | undefined {
  if (!path.isAbsolute(python)) return undefined;
  // python = <root>/bin/python3
  return path.dirname(path.dirname(python));
}

export function buildAssetSandboxSettings(args: {
  assetsDir: string;
  profileLandingWorkspace: string;
  referenceDir?: string;
  allowedDomains: readonly string[];
  /** Read-only directories this run adds, like the harvest of a direct run. */
  extraReadDirs?: readonly string[];
  /**
   * The root of the python venv resolvePython() picked (the parent of its
   * bin/ dir), when the interpreter lives under the home directory. Its
   * site-packages (Pillow, certifi) must be readable inside the sandbox,
   * which otherwise denies the whole home directory. Never a wildcard: only
   * this one resolved root is added.
   */
  pythonRoot?: string;
}): Readonly<Record<string, unknown>> {
  const repoScripts = path.join(process.cwd(), "scripts");
  const vendorLandingSkillScripts = path.join(process.cwd(), "vendor", "landing-skill", "scripts");
  const skillRoot = path.join(args.profileLandingWorkspace, ".agents", "skills");
  const nodeModules = path.join(args.profileLandingWorkspace, "node_modules");
  const browserCache = path.join(os.homedir(), "Library", "Caches", "ms-playwright");
  const allowRead = [
    path.resolve(args.assetsDir),
    path.resolve(repoScripts),
    path.resolve(vendorLandingSkillScripts),
    path.resolve(skillRoot),
    path.resolve(nodeModules),
    ...(args.referenceDir ? [path.resolve(args.referenceDir)] : []),
    ...(args.extraReadDirs ?? []).map((dir) => path.resolve(dir)),
    ...(args.pythonRoot ? [path.resolve(args.pythonRoot)] : []),
    ...(process.platform === "darwin" ? [browserCache] : []),
  ];

  return {
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      filesystem: {
        // WSL host integration must remain outside the Bash tool's reach.
        // Do not rely on the operator's Windows filesystem being private.
        denyRead: [os.homedir(), ...(process.platform === "linux" ? ["/mnt", "/media", "/init", "/run/WSL"] : [])],
        allowRead,
      },
      network: {
        allowedDomains: [...new Set(args.allowedDomains)],
        allowLocalBinding: false,
        allowAllUnixSockets: false,
      },
    },
  };
}

export interface ImageMapRow {
  harvestFile: string;
  section: string;
  proves: string;
}

/**
 * The image map the human approved in stage 3, turned into the seed of the
 * asset plan: the rows the agent must produce an asset for, and the rows whose
 * source file is not in the harvest at all.
 *
 * null (not an empty seed) when the design brief carries no parseable JSON
 * block, no imageMap array, or an explicitly empty one. A map that vanished or
 * was emptied is a broken stage 3, and 5.2 stops on it rather than producing a
 * page with no approved images.
 */
export function directAssetPlanSeed(
  designBrief: string,
  harvestFiles: readonly string[],
): { rows: ImageMapRow[]; missing: string[]; invalidRows: number } | null {
  const parsed = parseDesignBriefJson(designBrief);
  if (!parsed) return null;
  // A map is applied whole or not at all. Dropping one broken row would narrow
  // the approved map in silence: that image would never reach the prompt and
  // never be checked for coverage, which is the failure the null guard exists
  // to prevent.
  if (parsed.invalidRows > 0) return null;
  // An explicit "imageMap": [] parses cleanly and would otherwise carry a page
  // with no image at all through the whole chain: every page has at least one
  // image that proves a headline, so an empty map is a stop, not a plan.
  if (parsed.imageMap.length === 0) return null;
  const available = new Set(harvestFiles);
  const rows = parsed.imageMap.map((row) => ({ ...row }));
  const missing = [...new Set(rows.map((row) => row.harvestFile).filter((file) => !available.has(file)))];
  return { rows, missing, invalidRows: parsed.invalidRows };
}

/** Why a null seed is null, in the words the operator needs to reopen stage 3. */
export function directSeedStopMessage(designBrief: string): string {
  const parsed = parseDesignBriefJson(designBrief);
  const noMap = "בריף העיצוב בלי בלוק JSON תקין או בלי imageMap. פתח את שלב 3 מחדש.";
  if (!parsed) return noMap;
  if (parsed.invalidRows) {
    return `מפת התמונות בבריף העיצוב מכילה ${parsed.invalidRows} רשומות לא תקינות (${parsed.invalidReasons.join("; ")}). מפה חלקית לא מיושמת: פתח את שלב 3 מחדש ותקן את השורות האלה.`;
  }
  if (!parsed.imageMap.length) {
    return "בריף העיצוב עם מפת תמונות ריקה: כל דף חייב לפחות תמונה אחת שמוכיחה כותרת. פתח את שלב 3 מחדש.";
  }
  return noMap;
}

/**
 * A page type whose template requires mockups never runs 5.2 on a design brief
 * that does not say which mockups the page needs: the agent would produce a
 * page without them and nobody would learn it until the sheet was already
 * approved. Same shape as the null image-map seed: reopen stage 3.
 */
export const REQUIRED_MOCKUPS_STOP_MESSAGE =
  "בריף העיצוב בלי רשימת מוקאפים נדרשים לדף שמחייב מוקאפים. פתח את שלב 3 מחדש.";

/** The mockups stage 3 approved for this run, or null when 5.2 must stop. */
export function requiredMockupsForRun(
  assetType: AssetType | undefined,
  designBrief: string,
): DesignBriefRequiredMockup[] | null {
  if (!pageTypeRequiresMockups(assetType)) return parseDesignBriefJson(designBrief)?.requiredMockups ?? [];
  const required = parseDesignBriefJson(designBrief)?.requiredMockups;
  return required && required.length ? required : null;
}

/**
 * The rows of the approved map that no manifest asset covers. A row is covered
 * only by a non-rejected asset linked to it through harvestFile whose
 * placement fields are exactly the row's, because placementFields is what the
 * 5.3 image-map check counts as mapped: an asset it would ignore cannot prove
 * the row reached the page.
 */
export function imageMapCoverageGaps(
  manifestAssets: readonly AssetManifestEntry[],
  rows: readonly ImageMapRow[],
): ImageMapRow[] {
  return rows.filter((row) => {
    const section = row.section.trim();
    const proves = row.proves.trim();
    return !manifestAssets.some((asset) => {
      if (asset.status === "rejected") return false;
      if (asset.harvestFile !== row.harvestFile) return false;
      const fields = placementFields(asset);
      return !!fields && fields.section === section && fields.proves === proves;
    });
  });
}

/** A manifest that does not cover the approved image map. Never salvaged. */
export class ImageMapCoverageError extends Error {}

function assertImageMapCovered(
  manifest: AssetManifest,
  seed: ReturnType<typeof directAssetPlanSeed>,
): void {
  if (!seed) return;
  const gaps = imageMapCoverageGaps(manifest.assets, seed.rows);
  if (gaps.length) {
    throw new ImageMapCoverageError(
      `המניפסט לא מכסה את מפת התמונות המאושרת: ${gaps.map((gap) => `${gap.section} / ${gap.proves} (${gap.harvestFile})`).join("; ")}`,
    );
  }
}

/**
 * How long a whole 5.2 mockup render may take: the browser startup, every
 * screen of every declared mockup, and the composites. One budget for the
 * step, like the live Instagram proof's, because a renderer that hangs must
 * not hold the sub-task open past its own attempt. Shortened only by tests.
 */
const MOCKUP_RENDER_TIMEOUT_MS = 600_000;

function mockupRenderTimeoutMs(): number {
  const override = Number(process.env.CAMPAIGN_COUNCIL_MOCKUP_RENDER_TIMEOUT_MS);
  return Number.isFinite(override) && override > 0 ? override : MOCKUP_RENDER_TIMEOUT_MS;
}

/**
 * The receipt as run state may carry it.
 *
 * A row's file name comes from the agent's plan and its reason and notes are
 * free text produced by a subprocess, while run.json is shape-validated on
 * every write: an unusually long line must cost the operator a truncated note,
 * never the ability to save the run. Everything a later check reads (the
 * digests, the statuses, and the file name a row is recognised by) is carried
 * through as it is, capped in length and never reshaped.
 */
const MAX_RECEIPT_TEXT_CHARS = 500;
const MAX_RECEIPT_NOTES = 32;
/**
 * And one budget across the whole receipt: 80 rows, each within its own caps,
 * would still put megabytes of explanation into a run state that has a byte
 * ceiling of its own to share with the rest of the run.
 */
export const MAX_RECEIPT_TEXT_BYTES = 64 * 1024;

export function receiptForRunState(receipt: MockupRenderReceipt): MockupRenderReceipt {
  // The budget is spent in order, so the first rows keep their explanation and
  // a later one loses its text rather than the run losing the row.
  let left = MAX_RECEIPT_TEXT_BYTES;
  const text = (value: string): string | undefined => {
    const clamped = value.slice(0, MAX_RECEIPT_TEXT_CHARS);
    const cost = Buffer.byteLength(clamped, "utf8");
    if (cost > left) return undefined;
    left -= cost;
    return clamped;
  };
  const lines = (values: string[] | undefined): string[] | undefined => {
    if (!values?.length) return undefined;
    const kept = values
      .filter((line) => line.trim())
      .slice(0, MAX_RECEIPT_NOTES)
      .map(text)
      .filter((line): line is string => line !== undefined);
    return kept.length ? kept : undefined;
  };
  // The rows are clamped before the warnings, and each budget-spending helper
  // is called exactly once: calling it twice would charge the same text twice.
  const mockups = receipt.mockups.map((row) => {
    const reason = row.reason === undefined ? undefined : text(row.reason);
    const notes = lines(row.notes);
    return {
      file: row.file.slice(0, MAX_RECEIPT_FILE_CHARS),
      // One hash per declared screen, never more than the plan allows: the
      // run-state validator caps a hash record, and a record it refuses stops
      // every later save of this run, the 5.2 gate decision included.
      screensSha256: Object.fromEntries(
        Object.entries(row.screensSha256 ?? {}).slice(0, MAX_RENDER_REGIONS),
      ),
      status: row.status,
      ...(row.outputSha256 === undefined ? {} : { outputSha256: row.outputSha256 }),
      ...(reason === undefined ? {} : { reason }),
      ...(notes ? { notes } : {}),
    };
  });
  const warnings = lines(receipt.warnings);
  return {
    schemaVersion: receipt.schemaVersion,
    attemptId: receipt.attemptId,
    baseSha256: receipt.baseSha256,
    renderedAt: receipt.renderedAt,
    mockups,
    ...(warnings ? { warnings } : {}),
  };
}

/** At most this many render notes reach the completion message; the rest are in the log. */
const MAX_SHOWN_RENDER_NOTES = 10;

/**
 * What the render noticed, in the operator's words: one line per note a row
 * carries, then the render's own warnings.
 *
 * These are the facts a finished mockup cannot show. A screen that was
 * screenshotted before its fonts settled looks perfect and carries fallback
 * typography; a temp directory that could not be removed is a note on an
 * otherwise successful render. Nothing reads run.json on the operator's
 * behalf, so they are said in the message the gate shows.
 */
export function mockupRenderNotes(receipt: MockupRenderReceipt | undefined): string[] {
  if (!receipt) return [];
  return [
    ...receipt.mockups.flatMap((row) => (row.notes ?? []).map((note) => `${row.file}: ${note}`)),
    ...(receipt.warnings ?? []),
  ];
}

/**
 * The entries the orchestrator renders: a mockup that says how it is composited.
 * A mockup without `render` is rejected by the plan validation itself, and a
 * plan with none of these starts no browser at all.
 */
export function mockupPlanEntries(entries: readonly AssetPlanEntry[]): AssetPlanEntry[] {
  return entries.filter((entry) => entry.kind === "mockup" && entry.render !== undefined);
}

/** A manifest that misses a mockup the approved design brief requires. Never salvaged. */
export class MockupCoverageError extends Error {}

/**
 * Why a required mockup is not covered, one line per row, or an empty list.
 *
 * A row is covered by a manifest entry of kind mockup, not rejected, whose
 * section and claim are the approved ones, and whose bytes are exactly what
 * this attempt's receipt says the renderer produced. The receipt is bound to
 * the attempt through the manifest, so last attempt's receipt covers nothing.
 */
export function mockupCoverageGaps(
  manifest: AssetManifest,
  receipt: MockupRenderReceipt | undefined,
  required: readonly DesignBriefRequiredMockup[],
): string[] {
  if (!required.length) return [];
  const current = receipt && receipt.attemptId === manifest.attemptId ? receipt : undefined;
  // Each row needs its OWN mockup: two rows that share a section and a claim
  // ask for two files, and one rendered mockup may not answer for both.
  const taken = new Set<string>();
  return required.flatMap((row) => {
    const candidates = mockupEntriesFor(manifest.assets, row).filter((asset) => !taken.has(asset.file));
    if (!candidates.length) return [`${row.name}: אין מוקאפ בתוכנית עם הסקציה והטענה האלה`];
    const alive = candidates.filter((asset) => asset.status !== "rejected");
    if (!alive.length) return [`${row.name}: המוקאפ נפסל בבדיקת האיכות`];
    if (!current) return [`${row.name}: אין קבלת רינדור של הניסיון הזה`];
    const rendered = alive.find((asset) => current.mockups.some(
      (entry) => entry.file === asset.file && entry.status === "ok" && entry.outputSha256 === asset.sha256,
    ));
    if (rendered) {
      taken.add(rendered.file);
      return [];
    }
    const reason = current.mockups.find((entry) => alive.some((asset) => asset.file === entry.file))?.reason;
    return [`${row.name}: ${reason ?? "הקובץ אינו מה שהרינדור של הניסיון הזה הפיק"}`];
  });
}

export function assertMockupCoverage(
  manifest: AssetManifest,
  receipt: MockupRenderReceipt | undefined,
  required: readonly DesignBriefRequiredMockup[],
): void {
  const gaps = mockupCoverageGaps(manifest, receipt, required);
  if (gaps.length) {
    throw new MockupCoverageError(`מוקאפים נדרשים חסרים או נפסלו: ${gaps.join("; ")}`);
  }
}

async function listImages(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    // Regular files only, and the listing never descends, so the agent
    // sandbox's own control directory (SANDBOX_CONTROL_DIR) stays out of the
    // count wherever it landed, and so does every other folder.
    return entries
      .filter((e) => e.isFile() && e.name !== SANDBOX_CONTROL_DIR && IMAGE_RE.test(e.name))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Whether the previous set of assets should step aside.
 *
 * Only when the chain arrives here from a freshly approved brand brief, which
 * means no feedback: that set was produced for a different design. A crashed
 * attempt keeps its files, and so does a fix the human reviewer requested, because
 * re-downloading photos that are already right to redo six mockups costs a
 * quarter of an hour a round.
 */
export function shouldArchivePrevious(
  previousStatus: string | undefined,
  feedback: string | undefined,
): boolean {
  if (feedback) return false;
  return previousStatus === "approved" || previousStatus === "awaiting-decision";
}

/**
 * A re-run starts from an empty folder, or the previous run's images would sit
 * in the contact sheet and get built into the page as if they were produced
 * now. Nothing is deleted: the old set moves aside into a dated subfolder.
 */
export async function archivePreviousAssets(assetsDir: string, stamp: string): Promise<void> {
  return isolateAssetAttemptDirectory(assetsDir, {}, stamp);
}

/**
 * Start an attempt with only byte-identical assets from the prior validated
 * snapshot. Everything else moves to a recoverable sibling archive before the
 * agent starts, so an undeclared old file cannot be baked into a new mockup.
 */
export async function isolateAssetAttemptDirectory(
  assetsDir: string,
  reusableHashes: Record<string, string>,
  stamp: string,
): Promise<void> {
  await ensureManagedDirectory(assetsDir, path.dirname(assetsDir));
  let entries;
  try {
    entries = await fs.readdir(assetsDir, { withFileTypes: true });
  } catch {
    return;
  }
  const keep = new Set([
    ...Object.keys(reusableHashes),
    ...Object.keys(reusableHashes).map((file) => `${file}.cutout.json`),
    ...(Object.keys(reusableHashes).length ? [ASSET_MANIFEST_NAME, ASSET_APPROVAL_NAME] : []),
  ]);
  const stale = entries.filter((entry) => !keep.has(entry.name));
  if (!stale.length) return;

  // Outside the working folder on purpose: an archive sitting inside it is
  // material the agent will reuse instead of producing its own.
  const archive = `${assetsDir}-prev-${stamp}`;
  await ensureManagedDirectory(archive, path.dirname(archive));
  for (const entry of stale) {
    await fs.rename(path.join(assetsDir, entry.name), path.join(archive, entry.name));
  }
}

async function archiveContactSheetsForRecovery(
  assetsDir: string,
  stamp: string,
): Promise<void> {
  const entries = await fs.readdir(assetsDir, { withFileTypes: true });
  const sheets = entries.filter((entry) => /^contact-sheet-[A-Za-z0-9-]+\.html$/.test(entry.name));
  if (!sheets.length) return;
  const archive = `${assetsDir}-prev-${stamp}-sheets`;
  await ensureManagedDirectory(archive, path.dirname(archive));
  for (const sheet of sheets) {
    await fs.rename(path.join(assetsDir, sheet.name), path.join(archive, sheet.name));
  }
}

export async function recoverOrphanAssetAttempt(
  assetsDir: string,
  stamp: string,
): Promise<{ reusableHashes: Record<string, string>; manifestSha256: string }> {
  await recoverCutoutTransactions(assetsDir);
  await archiveContactSheetsForRecovery(assetsDir, stamp);
  const recovered = await validateAssetFolderSnapshot(assetsDir, { requirePlacementMap: true });
  return {
    reusableHashes: Object.fromEntries(
      recovered.manifest.assets
        .filter((asset) => asset.status !== "rejected" && asset.sha256)
        .map((asset) => [asset.file, asset.sha256]),
    ),
    manifestSha256: recovered.manifestSha256,
  };
}

export async function recoverOrArchivePartialAssetAttempt(
  assetsDir: string,
  stamp: string,
): Promise<{
  reusableHashes: Record<string, string>;
  manifestSha256?: string;
  recovered: boolean;
}> {
  if (await hasValidAssetPlan(assetsDir)) {
    try {
      const recovered = await recoverOrphanAssetAttempt(assetsDir, stamp);
      return { ...recovered, recovered: true };
    } catch {
      // Structurally malformed entries, stale manifests and incomplete control
      // files are not allowed to trap every retry before the agent can start.
      // Preserve all surviving bytes, then start from a clean working folder.
    }
  }
  await isolateAssetAttemptDirectory(assetsDir, {}, `${stamp}-partial`);
  return { reusableHashes: {}, recovered: false };
}

/**
 * Sub-task 5.2: produce the real images and mockups the page needs, then show
 * them. The human reviewer approves artwork by looking at it, so this ends on a contact
 * sheet in his browser rather than on a list of filenames he cannot see.
 */
export async function runStage5Assets(
  runId: string,
  runDir: string,
  feedback?: string,
  control?: ExecutionControl,
): Promise<void> {
  control?.throwIfAborted();
  const run = getRun(runId);
  if (!run?.stages) throw new Error(`Run ${runId} has no stages initialized`);

  const logName = "stage-5-2-assets.log";
  const assetsDir = path.join(runDir, "assets");
  const startedAt = new Date().toISOString();
  const assetAttemptId = randomUUID();
  let baselineHashes: Record<string, string> = {};
  // The approved image map of a direct run, read before the agent spawns and
  // checked again against whatever it produced. null in a council run.
  let seed: ReturnType<typeof directAssetPlanSeed> = null;
  // The mockups stage 3 approved for this run. Empty for a council run and for
  // a page type whose template asks for none, which makes the coverage
  // assertion below a no-op there.
  let requiredMockups: DesignBriefRequiredMockup[] = [];
  /**
   * Render this attempt's declared mockups, or undefined when the plan
   * declares none. Assigned once the profile and the interpreter are known,
   * and called on the main path and on the salvage path alike, because a
   * salvaged folder must meet the same receipt requirement. It renders at most
   * once per attempt: the second caller gets the first one's outcome, or its
   * failure.
   */
  let renderDeclaredMockups: (() => Promise<MockupRenderContext | undefined>) | undefined;
  let reusableHashes: Record<string, string> = {};
  let sealedApprovedHashes: Record<string, string> = {};

  const setSubTask = (patch: Record<string, unknown>) => {
    const stages = (getRun(runId)?.stages ?? []).map((s) =>
      s.number === 5
        ? {
            ...s,
            status: "running" as const,
            currentSubTaskId: SUB_ID,
            subTasks: s.subTasks.map((st) => (st.id === SUB_ID ? { ...st, ...patch } : st)),
          }
        : s,
    );
    updateRun(runId, { stages, currentStage: 5 });
  };

  /** The one way this sub-task ends in error: stage and sub-task marked, event emitted, log written. */
  const failSubTask = async (errorMessage: string, logHeader: string): Promise<void> => {
    const stages = (getRun(runId)?.stages ?? []).map((s) =>
      s.number === 5
        ? {
            ...s,
            status: "error" as const,
            errorMessage,
            subTasks: s.subTasks.map((st) => (st.id === SUB_ID ? { ...st, status: "error" as const, errorMessage } : st)),
          }
        : s,
    );
    updateRun(runId, { stages });
    eventBus.emit(runId, { type: "subtask-error", runId, stageNumber: 5, subTaskId: SUB_ID, errorMessage });
    await appendLog(runDir, logName, `\n\n## ${logHeader}\n\n${errorMessage}\n`).catch(() => {});
  };

  const emit = (token: string) => {
    control?.throwIfAborted();
    eventBus.emit(runId, { type: "subtask-token", runId, stageNumber: 5, subTaskId: SUB_ID, token });
    appendLog(runDir, logName, token).catch(() => {});
  };

  const existing = run.stages.find((s) => s.number === 5)?.subTasks.find((st) => st.id === SUB_ID);
  setSubTask({
    status: "running",
    output: "",
    errorMessage: undefined,
    startedAt,
    assetContactSheetFile: undefined,
    assetContactSheetSha256: undefined,
    feedbackHistory: feedback ? [...(existing?.feedbackHistory ?? []), feedback] : existing?.feedbackHistory,
  });
  eventBus.emit(runId, { type: "subtask-started", runId, stageNumber: 5, subTaskId: SUB_ID });

  try {
    if (!run.clientProfile) throw new Error("This legacy run has no sealed client profile");
    const profile = assertClientFeatureReady(run.clientProfile, "stage5");
    // Resolved once, before the sandbox settings and the prompt are built: the
    // venv's Pillow/certifi live under its own root, which must join allowRead
    // whenever resolvePython() picked a venv inside the (otherwise denied)
    // home directory rather than the bare system `python3`.
    const python = await resolvePython();
    const pythonRoot = pythonVenvRoot(python);
    // One render per attempt, outcome and failure alike: the promise itself is
    // the memo, so a main-path failure after (or during) the render never buys
    // the salvage path a second browser under a brand new deadline.
    let mockupRenderOnce: Promise<MockupRenderContext | undefined> | undefined;
    const renderOnce = async (): Promise<MockupRenderContext | undefined> => {
      const entries = mockupPlanEntries(await readAssetPlanEntries(assetsDir, assetAttemptId));
      if (!entries.length) return undefined;
      emit(`🖥️ מרנדר ${entries.length} מוקאפים מהמסכים שנכתבו...\n`);
      const outcome = await renderMockups({
        assetsDir,
        attemptId: assetAttemptId,
        entries,
        basesDir: profile.landing?.mockupBasesDir ?? packagedMockupBasesDir(),
        python,
        signal: control?.signal,
        deadline: Date.now() + mockupRenderTimeoutMs(),
      });
      // receiptForRunState is also what keeps the renderer's acceptedScreens
      // out of the stored record: the screens are the caller's business.
      setSubTask({ mockupRender: receiptForRunState(outcome) });
      const rejected = outcome.mockups.filter((mockup) => mockup.status !== "ok");
      if (rejected.length) {
        emit(`⚠️ ${rejected.length} מוקאפים לא רונדרו: ${rejected.map((mockup) => `${mockup.file} (${mockup.reason ?? "ללא סיבה"})`).join(", ")}\n`);
      }
      // Every note, in the log; the completion message shows the first few.
      const notes = mockupRenderNotes(outcome);
      if (notes.length) {
        await appendLog(runDir, logName, `\n## MOCKUP RENDER NOTES\n\n${notes.map((note) => `- ${note}`).join("\n")}\n`)
          .catch(() => {});
      }
      return { receipt: outcome, acceptedScreens: outcome.acceptedScreens };
    };
    renderDeclaredMockups = () => (mockupRenderOnce ??= renderOnce());
    // A shell fallback the tools block can point to when a python tool fails;
    // only listed if it actually exists on this machine (never assumed).
    const systemImageTools = await availableImageSystemTools();
    await ensureManagedDirectory(assetsDir, runDir);
    await recoverCutoutTransactions(assetsDir);
    reusableHashes = await readReusableAssetHashes(
      assetsDir,
      existing?.assetManifestSha256 ?? existing?.assetManifestDraftSha256,
    );
    sealedApprovedHashes = await readSealedApprovedAssetHashes(
      assetsDir,
      existing?.assetManifestSha256,
    );
    if (
      !shouldArchivePrevious(existing?.status, feedback)
      && Object.keys(reusableHashes).length === 0
      && (await listImages(assetsDir)).length > 0
    ) {
      const recoveryStamp = `${startedAt.replace(/[:.]/g, "-")}-${assetAttemptId}`;
      const recovered = await recoverOrArchivePartialAssetAttempt(assetsDir, recoveryStamp);
      reusableHashes = recovered.reusableHashes;
      if (recovered.recovered && recovered.manifestSha256) {
        // A hard crash can land after the manifest rename but before run state
        // is persisted. Re-validate its exact plan and bytes before isolation.
        setSubTask({
          assetManifestDraftSha256: recovered.manifestSha256,
          assetManifestSha256: undefined,
        });
        emit(`♻️ שוחזר snapshot יתום עם ${Object.keys(reusableHashes).length} נכסים מאומתים.\n`);
      } else {
        // A crash before asset-plan.json leaves no trustworthy dependency map.
        // Preserve the partial files outside the working folder and let the new
        // agent attempt start clean instead of looping on the same error.
        emit("♻️ נמצאו קבצים חלקיים בלי תוכנית נכסים. הם הועברו לארכיון והניסיון מתחיל נקי.\n");
      }
    }
    if (shouldArchivePrevious(existing?.status, feedback)) {
      await archivePreviousAssets(assetsDir, startedAt.replace(/[:.]/g, "-"));
      reusableHashes = {};
      sealedApprovedHashes = {};
      setSubTask({ assetManifestDraftSha256: undefined, assetManifestSha256: undefined });
    } else if (existing?.status === "error") {
      emit("↩️ ההרצה הקודמת נקטעה. רק נכסים מאומתים נשמרים, והשאר עוברים לארכיון.\n");
    } else if (feedback) {
      emit("↩️ תיקון: הנכסים הקיימים נשארים, רק מה שביקשת משתנה.\n");
    }
    if (!shouldArchivePrevious(existing?.status, feedback)) {
      await isolateAssetAttemptDirectory(
        assetsDir,
        reusableHashes,
        `${startedAt.replace(/[:.]/g, "-")}-${assetAttemptId}`,
      );
    }
    baselineHashes = await snapshotAssetHashes(assetsDir);

    const agents = await loadAgents();
    const owner = agents.find((a) => a.slug === "daniel-lp-designer");
    if (!owner) throw new Error("Agent daniel-lp-designer not found");

    // A direct run has no 5.1: stage 3 is its design brief, and parseReference
    // keeps working because that brief carries the same REFERENCE_URL: lines.
    // brandBriefForBuild (Task 10) is the one place that decides which stage
    // the brand brief comes from, shared with the 5.3 builder.
    const isDirect = run.pipeline === "direct";
    // Absolute, not the relative `scripts/marker.py`: the builder's cwd during
    // the asset stage is not guaranteed to be the repo root, and vendor/landing-skill/scripts
    // is a different directory from the project's own scripts/ (cutout, check-cutout).
    const markerScriptPath = path.join(process.cwd(), "vendor", "landing-skill", "scripts", "marker.py");
    const brandBrief = brandBriefForBuild(run);
    const reference = await authorizeReferenceProject(parseReference(brandBrief), profile);

    const feedbackBlock = feedback
      ? `\n\n## ⚠️ משוב מבעל הסמכות האנושי על הריצה הקודמת\n\n> ${feedback}\n\nתתקן בהתאם. הנכסים שכבר טובים נשארים.`
      : "";

    // Read once here, not inside the template literal, so the prompt below
    // cannot see different content than what this attempt actually acted on.
    const pageTypeBlueprint = await readRunPageTypeBlueprint(run);
    const missingBlueprintWarning = renderMissingPageTypeBlueprintWarning(run.assetType, pageTypeBlueprint);
    if (missingBlueprintWarning) emit(missingBlueprintWarning);

    const approvedCopy = renderApprovedCopyBlock(run);
    if (approvedCopy.warning) emit(approvedCopy.warning);

    // The one sub-directory the agent may write into, and the single sizes
    // file next to it. Both are named in the prompt and in the Edit rules.
    const screensDir = path.join(assetsDir, SCREENS_DIR);
    // The agent's own timer, in the words the agent can act on. It is read from
    // the same resolver spawnAgent uses below, so the prompt can never state a
    // budget the turn does not actually have.
    const agentBudgetMinutes = Math.round(resolvedAgentTimeoutMs(agentTimeoutMs(control)) / 60_000);
    const sizesJsonPath = path.join(screensDir, SCREEN_SIZES_NAME);

    const harvestRoot = path.join(runDir, HARVEST_DIR);
    // Task 17: one contract for both pipelines. The browser belongs to the
    // orchestrator, so neither agent is told to start one and neither is told
    // to declare a mockup it could not produce: it writes the screens, and the
    // render happens after it exits.
    const renderContractLine = `\n- המוקאפים מרונדרים על ידי האורקסטרטור אחרי שתסיים, בדפדפן שלו ולא בשלך. אתה כותב את מסכי ה-HTML לתוך ${screensDir} ומצהיר עליהם בשדות screens ו-render של הנכס. אל תפעיל דפדפן, אל תריץ composite.py ואל תרכיב קובץ מוקאפ ביד. נכס mockup בלי screens ובלי render אינו מוקאפ.`;
    // Read from the regions data of the installed frames, never hard coded:
    // an operator who replaces a base frame changes the region ids and the
    // sizes, and the agent has to be told the ones this run will enforce.
    const mockupBases = await describeMockupBases(
      profile.landing?.mockupBasesDir ?? packagedMockupBasesDir(),
      python,
      control?.signal,
    );
    for (const base of mockupBases) {
      // Never silent: an unreadable frame changes what the prompt can promise,
      // and the operator sees it before the agent is spawned.
      if (base.error) emit(`⚠️ אזורי מסגרת הבסיס ${base.base} לא נקראו: ${base.error}\n`);
    }
    // Both worked examples below come from the same regions data as the
    // listing, so neither can teach a map or a size the renderer rejects.
    const planExample = mockupPlanExample(mockupBases);
    const mockupSchemaLine = planExample
      ? `{ "file": "module-1-mockup.webp", "kind": "mockup", "inputs": ["portrait-cut.webp"], "screens": ${JSON.stringify(planExample.screens)}, "render": { "base": "${planExample.base}", "map": ${JSON.stringify(planExample.map)} }, "section": "<שם הסקציה מהקופי>", "proves": "<הכותרת או הטענה שהמוקאפ מוכיח>" }`
      : `{ "file": "module-1-mockup.webp", "kind": "mockup", "inputs": ["portrait-cut.webp"], "screens": ["<שם מסך>"], "render": { "base": "chapter", "map": { "<מזהה אזור>": "<שם מסך>" } }, "section": "<שם הסקציה מהקופי>", "proves": "<הכותרת או הטענה שהמוקאפ מוכיח>" }`;
    const sizesExampleJson = planExample
      ? JSON.stringify(planExample.sizes)
      : `{ "<שם מסך>": [<רוחב האזור>, <גובה האזור>] }`;
    let directSection = "";
    let requiredMockupsBlock = "";
    if (isDirect) {
      const harvestFiles = (await fs.readdir(path.join(harvestRoot, "raw")).catch(() => [] as string[]))
        .sort()
        .map((file) => `raw/${file}`);
      seed = directAssetPlanSeed(brandBrief, harvestFiles);
      if (!seed) throw new Error(directSeedStopMessage(brandBrief));
      if (seed.missing.length) {
        throw new Error(
          `קבצים מבריף העיצוב שאינם קיימים בקציר: ${seed.missing.join(", ")}. פתח את שלב 3 מחדש ותקן: השלם (העלה קובץ), החלף (בחר תמונה אחרת מהקציר) או הסר את ההצבה.`,
        );
      }
      // Before the agent, never after it: a page type that requires mockups and
      // has no approved list of them would otherwise reach the sheet with none.
      const required = requiredMockupsForRun(run.assetType, brandBrief);
      if (!required) throw new Error(REQUIRED_MOCKUPS_STOP_MESSAGE);
      requiredMockups = required;
      requiredMockupsBlock = required.length
        ? `\n\n### המוקאפים הנדרשים (חובה)\n\n${required
            .map((mockup) => `- ${mockup.name} | בסיס: ${mockup.base} | סקציה: ${mockup.section} | מוכיח: ${mockup.proves}`)
            .join("\n")}\n\nלכל שורה כאן הצהר נכס אחד מסוג mockup ב-asset-plan.json, עם אותם section ו-proves בדיוק, עם המסכים שלו ב-screens ועם render.base כמו בעמודת הבסיס.`
        : "";
      let proofLine = "";
      if (liveProofEnabled(profile)) {
        // Latest correction wins: a 5.2 feedback rerun outranks stage 1's approved
        // sub-task, which in turn outranks the brief the run started from. The
        // correction is read from this sub-task's whole feedback history (the
        // current attempt's feedback is already in it), so a later rerun about
        // something else, or a plain retry, does not drop it.
        const stage52FeedbackHistory = getRun(runId)?.stages?.find((s) => s.number === 5)
          ?.subTasks.find((st) => st.id === SUB_ID)?.feedbackHistory ?? [];
        const feedbackIgHandle = latestHandleInFeedback(stage52FeedbackHistory);
        const stage1IgHandle = run.stages?.find((s) => s.number === 1)?.subTasks.find((st) => st.id === "1")?.harvest?.igHandle;
        const briefIgHandle = siteUrlsFromBrief(run.brief).igHandle;
        const igHandle = feedbackIgHandle ?? stage1IgHandle ?? briefIgHandle;
        const igHandleSource = feedbackIgHandle ? "משוב 5.2" : stage1IgHandle ? "שלב 1" : "הבריף";
        if (igHandle) {
          emit(`📸 מצלם את פרופיל האינסטגרם ${igHandle} (מקור: ${igHandleSource}) דרך הכרום של המפעיל...\n`);
          const shot = await captureInstagramProof({
            runDir,
            handle: igHandle,
            landingWorkspace: profile.landing!.workspacePath!,
            signal: control?.signal,
          });
          // The count the capture validated is stated here, so the agent circles
          // a number the run actually read off the page instead of guessing one.
          proofLine = "file" in shot
            ? `\n- הוכחת אינסטגרם חיה: ${path.basename(shot.file)} (בשורש תיקיית הקציר)${shot.followers ? `, ${shot.followersRaw || `${shot.followers} עוקבים`}` : ""}. עגל את מספר העוקבים עם \`${python} ${markerScriptPath} <in.png> <out.webp-or-png> x0 y0 x1 y1 --style circle\` לפני ההצבה.`
            : `\n- צילום ההוכחה החיה נכשל (${shot.error}); אין קובץ הוכחת אינסטגרם בריצה הזאת, ואסור להמציא אחד. על המפעיל להעלות צילום ידני בשער האישור של השלב.`;
        }
      }
      directSection = `\n\n### מפת התמונות מבריף העיצוב (חובה)\n\nתיקיית הקציר (קריאה בלבד): ${harvestRoot}\n${seed.rows.map((row) => `- ${row.harvestFile} | סקציה: ${row.section} | מוכיח: ${row.proves}`).join("\n")}${proofLine}\n\nלכל שורה: העתק את הקובץ מתיקיית הקציר, עבד אותו (WebP, בלי מטא-דאטה, רוחב עד 1600px), תן לו שם סופי, והצהר עליו ב-asset-plan.json עם השדה "harvestFile" (הנתיב המדויק מהשורה, למשל "raw/01-portrait.jpg") ועם אותם section ו-proves בדיוק. האפליקציה בודקת שכל שורה במפה קיבלה נכס שמקושר אליה ב-harvestFile; נכס בלי harvestFile לא מכסה שורה. בסוף הדוח שלך טבלה "מקור בקציר | שם סופי". אל תוסיף תמונות להצבה שאינן במפה; מוקאפי מכשירים מותרים לפי סעיף הנכסים של תבנית סוג הדף.${requiredMockupsBlock}`;
    }

    const prompt = `${owner.systemPrompt}

---

${getSubTaskDef(5, SUB_ID, run.assetType, run.pipeline).instructions}

${assetPreambleFor(run.assetType)}

${renderCopyStandard(pageTypeBlueprint, "תבנית סוג הדף: אילו נכסים נדרשים")}

---

## הקשר

${renderClientContext(profile)}

### הבריף
${run.brief}

### בריף המותג שאושר
${brandBrief || "(לא אושר בריף מותג)"}

${approvedCopy.block}

### פרויקט קיים
${reference.dir ? `תיקייה: ${reference.dir}` : "אין תיקייה מקומית"}
${reference.url ? `דף חי: ${reference.url}` : "אין דף חי"}

### איפה לשמור
תיקיית היעד קיימת כבר: **${assetsDir}**
כל קובץ סופי נשמר שם ישירות, בלי תת-תיקיות. קבצי ביניים יש לשמור זמנית בתוך התיקייה הזו ולמחוק לפני הסיום. בסיום מותר שיישארו רק הנכסים וקובצי הבקרה המוצהרים.

### כלי התמונות של ההתקנה הזו
- cutout: \`${python} ${path.join(process.cwd(), "scripts", "cutout.py")} <מקור> <יעד.webp>\`
- checker: \`${python} ${path.join(process.cwd(), "scripts", "check-cutout.py")} --source <מקור> <מועמד-cutout>\`
- marker: \`${python} ${markerScriptPath} <in.png> <out.webp-or-png> x0 y0 x1 y1 --style circle\`
- המפרש: \`${python}\` (כולל Pillow ו-certifi). אין להתקין חבילות; אם כלי נכשל, דווח את השגיאה המדויקת.
- ${imageSystemToolsLine(systemImageTools)}${renderContractLine}
אל תניח שהפרויקט מותקן תחת \`~/campaign-council\`; אלה הנתיבים הסמכותיים לריצה הנוכחית.

### תוכנית נכסים שחייבת להתאים לניסיון הזה
לפני שאתה מסיים, כתוב את הקובץ **${path.join(assetsDir, ASSET_PLAN_NAME)}** **בכלי Write** (בכלי Write מותר לך ליצור בדיוק שלושה סוגי קבצים: את קובץ התוכנית הזה, את מסכי ה-HTML תחת **${screensDir}** ואת **${sizesJsonPath}**. שום קובץ אחר). לא דרך Bash: הפניות פלט, tee ו-heredoc נחסמות במצב ההרשאות, וקובץ שלא נכתב מפיל את כל הנכסים. רק קבצים שמוצהרים בו יופיעו בגיליון ויגיעו לבונה. המבנה המדויק:

\`\`\`json
{
  "schemaVersion": 1,
  "attemptId": "${assetAttemptId}",
  "assets": [
    { "file": "portrait.webp", "kind": "photo" },
    { "file": "portrait-cut.webp", "kind": "cutout", "sourceFile": "portrait.webp", "section": "<שם הסקציה מהקופי>", "proves": "<הכותרת מהקופי שהתמונה עומדת לידה>" },
    ${mockupSchemaLine},
    { "file": "logo-press.webp", "kind": "logo" }
  ]
}
\`\`\`

הסוגים המותרים: \`photo\`, \`cutout\`, \`mockup\`, \`logo\`, \`proof\`, \`generated\`. לכל cutout חובה לשמור גם את המקור באותה תיקייה ולהצהיר עליו ב-sourceFile. לכל mockup חובה להצהיר את המסכים שלו ב-screens ואת ההרכבה ב-render, ומהם האורקסטרטור מרנדר את הקובץ. קובץ ישן שלא השתנה מותר להצהיר שוב רק אם הוא כבר היה מאומת במניפסט הקודם.

### מוקאפים: המסכים שאתה כותב וההצהרה עליהם
**סדר העבודה, כשסוג הדף דורש מוקאפים:** כתוב קודם את ${sizesJsonPath} ואת כל המסכים הנדרשים, ורק אחר כך חיתוכים, הוכחות ושאר נכסים. המוקאפים הנדרשים הם השער הקשה של השלב: מוקאפ נדרש שחסר מפיל את 5.2 כולו, בעוד נכס אחר שלא הספקת מדווח וממשיכים. הזמן שלך בריצה הזאת מוגבל ל-${agentBudgetMinutes} דקות, ואחריהן הריצה נעצרת עם מה שכתבת עד אז. אל תשקיע בנכס משני לפני שכל המסכים הנדרשים כתובים.

מסך של מוקאפ הוא קובץ HTML סטטי שאתה כותב לתוך **${screensDir}**, ולידו קובץ אחד **${sizesJsonPath}** שנותן לכל מסך את גודלו בפיקסלים, למשל \`${sizesExampleJson}\`. עד ${MAX_SCREEN_EDGE_PX} פיקסלים לכל צלע.
1. שם מסך: אותיות אנגליות, ספרות, נקודה, מקף וקו תחתון בלבד, עד ${MAX_MOCKUP_NAME_CHARS} תווים. שם הקובץ הוא \`<שם>.html\`.
2. \`screens\` מונה את שמות המסכים של אותו מוקאפ, בלי הסיומת. כל שם חייב קובץ קיים ושורה ב-sizes.json.
3. \`inputs\` אינו חובה במוקאפ שמרונדר ממסכים: המסכים הם הקלט שלו, והאורקסטרטור פותח אותם ומרחיב מהם כל הפניית \`asset:\`. כשאתה כן מצהיר עליו, הוא רשימת תמונות בלבד (קובץ HTML שם פוסל את הנכס; מסכים מוצהרים ב-screens), והוא מה שמסמן תמונה מאושרת שהמסכים משתמשים בה כחומר גלם בגיליון במקום כנכס בלי סקציה.
4. \`render.base\` הוא \`chapter\` (מוקאפ של פרק בודד) או \`devices\` (מוקאפ של כל התוכנית). כמה מסכים יש בכל מסגרת ובאיזה גודל נקבע ברשימת האזורים שלמטה, והיא הקובעת. \`render.map\` ממפה מזהה אזור בבסיס לשם מסך שהצהרת עליו ב-screens. מוקאפ בלי render נפסל.
5. בתיקיית המסכים מותרים רק קובצי ה-HTML שהצהרת עליהם ו-${SCREEN_SIZES_NAME}. כל קובץ אחר שם נחשב קובץ לא מוצהר ופוסל את כל המוקאפים.
6. **קובץ המוקאפ שב-\`file\` הוא \`.webp\` או \`.png\` בלבד.** סיומת אחרת אינה נשמרת עם שקיפות והמוקאפ נפסל.
7. הרכבת קובץ המוקאפ עצמו מהמסכים אינה באחריותך. אתה כותב את המסכים ומצהיר עליהם. **אל תיצור בעצמך את הקובץ ששמו מופיע ב-file**: האורקסטרטור כותב אותו אחרי שתסיים, וקובץ מוקאפ שלא נוצר ברינדור של הניסיון הזה נפסל.

**מסגרות הבסיס והאזורים שלהן בהתקנה הזו:**
${renderMockupBasesBlock(mockupBases)}
מפתחות \`render.map\` הם מזהי האזורים האלה, כמחרוזות של ספרות בלבד. מזהה שאינו ברשימה פוסל את המוקאפ, וכך גם מסך שגודלו ב-${SCREEN_SIZES_NAME} שונה מהגודל שהאזור שהוא ממופה אליו דורש.

**גבולות המסך שהאורקסטרטור אוכף.** המסך נפתח בלי JavaScript ובלי גישה לרשת ולקבצים, אז הוא חייב להיות קובץ אחד שעומד בפני עצמו:
א. **ה-CSS בתוך הקובץ**, בתוך תגית \`<style>\`. אין קובץ סגנון נפרד.
ב. **תמונה מאושרת מתיקיית הנכסים נכנסת למסך בהפניית \`asset:\`**, כולל התמונה של הפרזנטור: \`<img src="asset:portrait-cut.webp">\`, ובתוך CSS \`url(asset:portrait-cut.webp)\`. האורקסטרטור מרחיב כל הפניה כזאת ל-data: URI בעותק שהוא מרנדר, והקובץ שאתה כותב נשאר בדיוק כפי שכתבת אותו. מותר רק שם קובץ ישיר בתיקיית הנכסים, בסיומת \`.webp\`, \`.png\`, \`.jpg\` או \`.jpeg\`. הפניה לקובץ שאינו שם, שם עם נתיב, או סיומת אחרת, פוסלת את המוקאפ. אין נתיב יחסי כמו \`../portrait-cut.webp\`, אין כתובת http או https, ואין Google Fonts.
ג. **אל תטמיע base64 בעצמך כשיש קובץ בתיקיית הנכסים.** תמונה מוטמעת ביד הופכת מסך של שני קילו-בייט לקובץ של עשרים ושבעה, וכתיבתו לוקחת דקות ארוכות לכל מסך; הפניית \`asset:\` היא אחת עשרה תווים. \`data:\` נשאר מותר ומיועד לגופן, ולתמונה שאין לה קובץ מאושר בתיקייה: \`${python} -c 'import base64,sys;print(base64.b64encode(open(sys.argv[1],"rb").read()).decode())' <נתיב הקובץ בתיקיית הנכסים>\`, ואז \`<img src="data:image/webp;base64,<הפלט>">\`. הפלט הוא שורה אחת בלי שורות חדשות. אל תשתמש בכלי \`base64\` של המערכת: הגרסה שמותקנת כאן לא מקבלת שם קובץ כארגומנט חופשי. תמונה מאושרת שהמסכים משתמשים בה כדאי להצהיר גם ב-inputs של המוקאפ, כדי שהגיליון יראה אותה כחומר גלם; חובה זו אינה.
ד. **תקציבים:** עד ${MAX_SCREEN_DATA_BYTES / (1024 * 1024)} מגה-בייט של data: בכל המסכים של מוקאפ אחד יחד, כולל מה שהפניות \`asset:\` מתרחבות אליו, ועד ${MAX_SCREEN_HTML_BYTES / 1024} קילו-בייט סימון לכל מסך, בלי לספור את ה-data:.
ה. **אסור בהחלט:** תגית \`<script>\`, מאפיין אירוע (\`onclick=\` וכל \`on...=\`), כתובת \`javascript:\`, וכל הפניה לכתובת חיצונית ב-\`src\`, \`href\`, \`url()\` או \`@import\`.
ו. **המסך חייב להיכנס בדיוק לגודל שהצהרת עליו ב-${SCREEN_SIZES_NAME}.** \`html, body { overflow: hidden }\` על שניהם, לא על body בלבד: overflow על body לבדו עובר לחלון ומשאיר את body עצמו גולש. שום אלמנט לא יוצא מהמלבן המוצהר. אין מיקום שלילי בצד ההתחלה, למשל \`inset-inline-end: -420px\` במסמך RTL, והילה או זוהר דקורטיביים יושבים בתוך מיכל בגודל המסך שיש עליו \`overflow: hidden\`, לא על המסמך. לפני הצילום האורקסטרטור מודד את \`scrollWidth\` ואת \`scrollHeight\` של המסמך ושל body, ומסך שגודל הגלילה שלו גדול מהגודל המוצהר נפסל: הצילום שלו היה יוצא מוסט וחתוך בקצה, בלי שהתמונה תגלה זאת.
ז. מסך שחורג מאחד הגבולות האלה נפסל, והמוקאפ שלו נפסל איתו. מוקאפ נדרש שנפסל מפיל את שלב 5.2 כולו, אז תבדוק את הגבולות לפני שאתה מסיים.

### מפת התמונות
1. \`section\` נכתב בדיוק כשם הסקציה בקופי שאושר למעלה.
2. \`proves\` הוא הכותרת או הטענה מהקופי שהתמונה מוכיחה, לא תיאור של התמונה. "תמונה של המנחה" אינו ערך תקין.
3. \`section\` עד 80 תווים, \`proves\` עד 200 תווים.
4. תמונה שמיועדת להצבה בדף ואין לה סקציה שהיא מוכיחה לא מיוצרת. לוגואים וחומרי גלם (מקור של cutout, קלט של mockup) פטורים מהכלל הזה ולא צריכים את השדות.
5. נכס להצבה בלי שני השדות יסומן בגיליון לבדיקה אנושית.
6. קובץ אחד לכל טענה. לא מפיקים קובץ נפרד למובייל וקובץ נפרד לדסקטופ של אותה תמונה ממופה, כי כל תמונה ממופה חייבת להיות מוצגת גם ב-390px וגם ב-1280px.
${directSection}
${feedbackBlock}`;

    await appendLog(runDir, logName, `\n## Prompt\n\n${prompt}\n\n## Output\n\n`);
    emit(`🎨 דניאל מפיק נכסים לתוך ${assetsDir}\n\n`);

    const referenceDomains = (profile.landing?.referenceUrlPrefixes ?? [])
      .map((value) => {
        try {
          return new URL(value).hostname;
        } catch {
          return "";
        }
      })
      .filter(Boolean);
    const sandboxSettings = buildAssetSandboxSettings({
      assetsDir,
      profileLandingWorkspace: profile.landing!.workspacePath!,
      referenceDir: reference.dir,
      allowedDomains: referenceDomains,
      extraReadDirs: isDirect ? [harvestRoot] : [],
      pythonRoot,
    });
    const allowedWebFetch = referenceDomains.map((domain) => `WebFetch(domain:${domain})`);

    const { fullText } = await spawnAgent({
      prompt,
      cwd: assetsDir,
      permissionMode: "dontAsk",
      // Write is granted for the asset plan alone (an Edit(...) path rule,
      // which governs every file-editing tool; Write(...) path rules are not
      // enforced). Under dontAsk, Bash refuses heredoc-shaped commands even
      // inside the sandbox, so a JSON manifest written from the shell landed
      // or failed by the command shape the agent happened to pick (15.09.2026).
      tools: ["Bash", "Write", "WebSearch", "WebFetch", "Skill"],
      allowedTools: [
        "WebSearch",
        "Skill",
        ...allowedWebFetch,
        absolutePathRule("Edit", path.join(assetsDir, ASSET_PLAN_NAME)),
        // Task 13: the agent writes the HTML screens, the orchestrator renders
        // them. One star only: `**` would reach every nested path under screens/.
        absolutePathRule("Edit", path.join(screensDir, "*.html")),
        absolutePathRule("Edit", sizesJsonPath),
      ],
      strictMcpConfig: true,
      settingSources: [],
      settings: sandboxSettings,
      signal: control?.signal,
      timeoutMs: agentTimeoutMs(control),
      onToken: emit,
    });

    // Show what actually landed on disk, not what the agent said it produced.
    control?.throwIfAborted();
    await recoverCutoutTransactions(assetsDir);
    // The mockups are the orchestrator's own work, produced after the agent
    // exits and before anything is validated: the receipt must exist by the
    // time the folder is judged, or a mockup file could pass on its own.
    const mockupRender = await renderDeclaredMockups();
    control?.throwIfAborted();
    const validation = await validateAssetFolderSnapshot(assetsDir, {
      expectedAttemptId: assetAttemptId,
      baselineHashes,
      reusableHashes,
      sealedApprovedHashes,
      requirePlacementMap: true,
      ...(mockupRender ? { mockupReceipt: mockupRender } : {}),
    });
    const { manifest, manifestSha256: assetManifestDraftSha256, assetBytes } = validation;
    assertImageMapCovered(manifest, seed);
    assertMockupCoverage(manifest, mockupRender?.receipt, requiredMockups);
    setSubTask({ assetManifestDraftSha256, assetManifestSha256: undefined });
    const files = manifest.assets.filter((asset) => asset.status !== "rejected").map((asset) => asset.file);
    const sheetFiles = manifest.assets.map((asset) => asset.file);
    const reviewRequired = manifest.assets.filter((asset) => asset.status === "review-required");
    const rejected = manifest.assets.filter((asset) => asset.status === "rejected");
    const renderNotes = mockupRenderNotes(mockupRender?.receipt);
    const captions = parseAssetCaptions(fullText);
    const sheetFile = `contact-sheet-${assetAttemptId}-${assetManifestDraftSha256.slice(0, 16)}.html`;
    const sheetPath = path.join(assetsDir, sheetFile);
    const statuses = Object.fromEntries(
      manifest.assets.map((asset) => [
        asset.file,
        {
          status: asset.status,
          kind: asset.kind,
          sourceFile: asset.sourceFile,
          problems: asset.problems,
          previewable: asset.previewable && isSafeAssetFileName(asset.file),
          ...(placementFields(asset) ?? {}),
        },
      ]),
    );
    const cacheKeys = Object.fromEntries(manifest.assets.map((asset) => [asset.file, asset.sha256]));
    const snapshotSources = await createAssetThumbnailDataUrls(
      assetBytes,
      manifest.assets
        .filter((asset) => asset.previewable && assetBytes.has(asset.file))
        .map((asset) => asset.file),
    );
    const sheetHtml = buildContactSheetWithStatus(
      sheetFiles,
      captions,
      statuses,
      cacheKeys,
      snapshotSources,
    );
    const assetContactSheetSha256 = createHash("sha256").update(sheetHtml).digest("hex");
    if (Buffer.byteLength(sheetHtml, "utf8") > MAX_CONTACT_SHEET_BYTES) {
      throw new Error("גיליון הנכסים גדול מדי להצגה ואישור בטוחים. יש לצמצם את מספר או גודל התמונות");
    }
    control?.throwIfAborted();
    await atomicCreateManagedFile(sheetPath, assetsDir, sheetHtml);
    const sheetUrl = `file://${sheetPath}`;
    const opened = openInBrowser(sheetUrl);

    emit(`\n📇 ${files.length} נכסים מאומתים. פותח גיליון לאישור...\n`);
    if (rejected.length) {
      emit(`⚠️ ${rejected.length} נכסים נפסלו אוטומטית ולא הועברו לבונה.\n`);
    }
    if (reviewRequired.length) {
      emit(`👀 ${reviewRequired.length} נכסים דורשים תשומת לב מיוחדת בגיליון.\n`);
    }

    const output = [
      `## 🖼️ ${sheetUrl}`,
      "",
      opened
        ? "גיליון הנכסים נפתח לך בדפדפן. תסתכל על התמונות לפני שאתה מאשר."
        : "תפתח את הקישור למעלה ותסתכל על התמונות לפני שאתה מאשר.",
      "",
      files.length
        ? `- **${files.length} נכסים בטוחים להצגה בגיליון** ונשמרו ב-\`${assetsDir}\``
        : "- **לא הופק אף נכס.** הדף ייבנה בלי תמונות, כלומר כשלד.",
      ...(reviewRequired.length
        ? [`- **${reviewRequired.length} נכסים דורשים בדיקה בעין.** אישור הגיליון יאשר אותם לבונה.`]
        : []),
      ...(rejected.length
        ? [
            `- **${rejected.length} נכסים נפסלו ולא יגיעו לדף:**`,
            ...rejected.map((asset) =>
              `  - \`${asset.file}\`: ${asset.problems.join("; ") || "בדיקת איכות נכשלה"}`,
            ),
          ]
        : []),
      // What the render noticed and the picture cannot show: fallback fonts on
      // a screen that looks finished, a directory that could not be removed.
      ...(renderNotes.length
        ? [
            `- **${renderNotes.length} הערות מהרינדור:**`,
            ...renderNotes.slice(0, MAX_SHOWN_RENDER_NOTES).map((note) => `  - ${note}`),
            ...(renderNotes.length > MAX_SHOWN_RENDER_NOTES
              ? [`  - ועוד ${renderNotes.length - MAX_SHOWN_RENDER_NOTES} הערות ביומן השלב`]
              : []),
          ]
        : []),
      "",
      "---",
      "",
      fullText,
      "",
      `ASSETS_DIR: ${files.length ? assetsDir : "none"}`,
      `ASSET_MANIFEST: ${path.join(assetsDir, ASSET_MANIFEST_NAME)}`,
      `ASSET_MANIFEST_DRAFT_SHA256: ${assetManifestDraftSha256}`,
      "",
      `**לאישור: ${sheetUrl}**`,
      "",
    ].join("\n");

    control?.throwIfAborted();
    await saveRunArtifact(runDir, "stage-5-2-assets.md", output);
    control?.throwIfAborted();
    setSubTask({
      status: "awaiting-decision",
      output,
      completedAt: new Date().toISOString(),
      assetManifestDraftSha256,
      assetManifestSha256: undefined,
      assetContactSheetFile: sheetFile,
      assetContactSheetSha256,
    });
    eventBus.emit(runId, { type: "subtask-completed", runId, stageNumber: 5, subTaskId: SUB_ID, content: output });
  } catch (err) {
    if (control?.signal.aborted) throw err;
    const errorMessage = err instanceof Error ? err.message : String(err);

    // A coverage failure is a fact about the approved map, not about a crashed
    // agent: there is nothing here to salvage, and a folder of finished files
    // that misses an approved image ends in error, never awaiting-decision.
    if (err instanceof ImageMapCoverageError) {
      await failSubTask(errorMessage, "IMAGE MAP COVERAGE ERROR");
      throw err;
    }

    // A required mockup that is missing or unrendered is the same kind of
    // fact: the approved design brief asked for it, and no folder of finished
    // files makes up for it. Never salvaged, exactly like a coverage gap.
    if (err instanceof MockupCoverageError) {
      await failSubTask(errorMessage, "MOCKUP COVERAGE ERROR");
      throw err;
    }

    // The agent may have died after producing real files. Show them rather than
    // reporting a bare failure over a folder full of finished work.
    try {
      await recoverCutoutTransactions(assetsDir);
    } catch (recoveryError) {
      const recoveryMessage = recoveryError instanceof Error ? recoveryError.message : String(recoveryError);
      setSubTask({ status: "error", errorMessage: recoveryMessage });
      eventBus.emit(runId, {
        type: "subtask-error",
        runId,
        stageNumber: 5,
        subTaskId: SUB_ID,
        errorMessage: recoveryMessage,
      });
      await appendLog(runDir, logName, `\n\n## RECOVERY ERROR\n\n${recoveryMessage}\n`).catch(() => {});
      throw recoveryError;
    }
    // Why the salvage refused to rescue the attempt, when it did.
    let salvageRefusal = "";
    const salvagedOnDisk = await listImages(assetsDir);
    if (salvagedOnDisk.length) {
      try {
        // Same order as the main path: render first, then judge the folder.
        const mockupRender = renderDeclaredMockups ? await renderDeclaredMockups() : undefined;
        const validation = await validateAssetFolderSnapshot(assetsDir, {
          expectedAttemptId: assetAttemptId,
          baselineHashes,
          reusableHashes,
          sealedApprovedHashes,
          requirePlacementMap: true,
          ...(mockupRender ? { mockupReceipt: mockupRender } : {}),
        });
        const { manifest, manifestSha256: assetManifestDraftSha256, assetBytes } = validation;
        // Salvaging around a map the manifest does not cover would hand the
        // builder a page missing approved images. Its error reaches the
        // salvage catch below, which logs and falls through to the error path.
        assertImageMapCovered(manifest, seed);
        assertMockupCoverage(manifest, mockupRender?.receipt, requiredMockups);
        setSubTask({ assetManifestDraftSha256, assetManifestSha256: undefined });
        const salvaged = manifest.assets.filter((asset) => asset.status !== "rejected").map((asset) => asset.file);
        const reviewRequired = manifest.assets.filter((asset) => asset.status === "review-required");
        const rejected = manifest.assets.filter((asset) => asset.status === "rejected");
        if (salvaged.length) {
          const sheetFile = `contact-sheet-${assetAttemptId}-${assetManifestDraftSha256.slice(0, 16)}.html`;
          const sheetPath = path.join(assetsDir, sheetFile);
          const statuses = Object.fromEntries(
            manifest.assets.map((asset) => [
              asset.file,
              {
                status: asset.status,
                kind: asset.kind,
                sourceFile: asset.sourceFile,
                problems: asset.problems,
                previewable: asset.previewable && isSafeAssetFileName(asset.file),
                ...(placementFields(asset) ?? {}),
              },
            ]),
          );
          const sheetHtml = buildContactSheetWithStatus(
                manifest.assets.map((asset) => asset.file),
                {},
                statuses,
                Object.fromEntries(manifest.assets.map((asset) => [asset.file, asset.sha256])),
                await createAssetThumbnailDataUrls(
                  assetBytes,
                  manifest.assets
                    .filter((asset) => asset.previewable && assetBytes.has(asset.file))
                    .map((asset) => asset.file),
                ),
              );
          const assetContactSheetSha256 = createHash("sha256").update(sheetHtml).digest("hex");
          if (Buffer.byteLength(sheetHtml, "utf8") > MAX_CONTACT_SHEET_BYTES) {
            throw new Error("גיליון הנכסים גדול מדי להצגה ואישור בטוחים");
          }
          await atomicCreateManagedFile(sheetPath, assetsDir, sheetHtml);
          const sheetUrl = `file://${sheetPath}`;
          const opened = openInBrowser(sheetUrl);
          const output = [
            `## 🖼️ ${sheetUrl}`,
            "",
            `⚠️ הסוכן נפל באמצע (${errorMessage}), אבל ${salvaged.length} נכסים כבר הופקו ונשמרו.`,
            opened ? "הגיליון נפתח לך בדפדפן." : "תפתח את הקישור למעלה.",
            "",
            "אפשר לאשר את מה שיש, או להריץ שוב כדי להשלים. הרצה חוזרת אחרי נפילה שומרת את הקבצים הקיימים.",
            ...(reviewRequired.length
              ? ["", `${reviewRequired.length} נכסים דורשים בדיקה בעין לפני האישור.`]
              : []),
            ...(rejected.length
              ? ["", `${rejected.length} נכסים שנכשלו מוצגים בגיליון עם סטטוס פסילה ולא יועברו לבונה.`]
              : []),
            "",
            `ASSETS_DIR: ${assetsDir}`,
            `ASSET_MANIFEST: ${path.join(assetsDir, ASSET_MANIFEST_NAME)}`,
            `ASSET_MANIFEST_DRAFT_SHA256: ${assetManifestDraftSha256}`,
            "",
            `**לאישור: ${sheetUrl}**`,
            "",
          ].join("\n");
          setSubTask({
            status: "awaiting-decision",
            output,
            completedAt: new Date().toISOString(),
            assetManifestDraftSha256,
            assetManifestSha256: undefined,
            assetContactSheetFile: sheetFile,
            assetContactSheetSha256,
          });
          eventBus.emit(runId, { type: "subtask-completed", runId, stageNumber: 5, subTaskId: SUB_ID, content: output });
          await appendLog(runDir, logName, `\n\n## ERROR (salvaged ${salvaged.length} assets)\n\n${errorMessage}\n`).catch(() => {});
          return;
        }
      } catch (validationError) {
        const salvageMessage = validationError instanceof Error ? validationError.message : String(validationError);
        await appendLog(runDir, logName, `\n\n## SALVAGE VALIDATION ERROR\n\n${salvageMessage}\n`).catch(() => {});
        // A missing mockup is why the salvage was refused, and the sub-task's
        // error message is the one line the operator reads. It says so there,
        // instead of leaving the reason in a log nobody opens after a crash.
        if (validationError instanceof MockupCoverageError) {
          salvageRefusal = salvageMessage;
        }
      }
    }

    await failSubTask(
      salvageRefusal ? `${errorMessage}\n\nההצלה נדחתה: ${salvageRefusal}` : errorMessage,
      "ERROR",
    );
    throw err;
  }
}
