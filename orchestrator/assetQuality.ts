import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { trackChildProcess } from "./childProcessRegistry";
import { resolvePython } from "./pythonInterpreter";
import type { MockupRenderReceipt } from "@/types";
import {
  MAX_ASSET_COUNT,
  MAX_RENDER_REGIONS,
  MOCKUP_FILE_RE,
  MOCKUP_RENDER_BASES,
  REGION_ID_RE,
  SCREEN_NAME_RE,
  isMockupRenderBase,
  type MockupRenderBase,
} from "@/lib/mockupContract";

export const ASSET_PLAN_NAME = "asset-plan.json";
export const ASSET_MANIFEST_NAME = "asset-manifest.json";
export const ASSET_APPROVAL_NAME = "asset-approval.json";
const ASSET_SCHEMA_VERSION = 1;
const IMAGE_FILE_RE = /\.(webp|png|jpe?g|svg|avif)$/i;
const SAFE_RASTER_RE = /\.(webp|png|jpe?g|avif)$/i;
const CUTOUT_RE = /(?:^|[-_])cut(?:out)?\.(?:webp|png|jpe?g|avif)$/i;
const PYTHON_TIMEOUT_MS = 15_000;
const PYTHON_OUTPUT_LIMIT = 512 * 1024;
const MAX_ASSET_BYTES = 20 * 1024 * 1024;
const MAX_ASSET_SET_BYTES = 80 * 1024 * 1024;
const MAX_CONTROL_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_CONTACT_SHEET_BYTES = 16 * 1024 * 1024;
const MAX_THUMBNAIL_DATA_URL_BYTES = 256 * 1024;
const MAX_THUMBNAIL_SET_BYTES = 12 * 1024 * 1024;
const MAX_ATTEMPT_ENTRIES = 1_000;
const MAX_ATTEMPT_DEPTH = 4;

export type AssetKind = "photo" | "cutout" | "mockup" | "logo" | "proof" | "generated";
export type AssetStatus = "approved" | "review-required" | "rejected";

/**
 * The one sub-directory the 5.2 agent may write into: the HTML screens the
 * orchestrator renders into device mockups after the agent exits (Task 13).
 * Everything else under the assets folder is still a flat list of images.
 */
export const SCREENS_DIR = "screens";
/**
 * The control directory the agent's own sandbox creates inside its working
 * folder (`.claude/`, with `.cc-writes/` under it). It belongs to the harness,
 * not to the attempt: nobody declares it, nothing reads it, and it never holds
 * an image. It is excluded from the folder listing entirely, at any depth
 * inside the assets folder, so it can neither be reported as an undeclared
 * file nor reject a mockup: the sandbox puts it wherever the agent is
 * working, which has been the assets folder and `screens/` on different runs.
 * Its contents are never walked. A picture planted inside it is invisible to
 * the rest of the chain rather than smuggled past the fence, because only the
 * assets the plan declared and the manifest approved ever reach the builder,
 * and nothing under this directory can be declared.
 */
export const SANDBOX_CONTROL_DIR = ".claude";
export const SCREEN_SIZES_NAME = "sizes.json";
export const SCREEN_SIZES_FILE = `${SCREENS_DIR}/${SCREEN_SIZES_NAME}`;
/**
 * A file under `screens/` that is a screen, by name. Exported so one test can
 * hold it, the render policy's own copy and SCREEN_NAME_RE side by side: three
 * hand copies of one rule can only drift apart in silence.
 */
export const SCREEN_HTML_RE = /^screens\/([A-Za-z0-9._-]{1,60})\.html$/;
const HTML_INPUT_RE = /\.html?$/i;
/** A screen larger than this is a render bomb, not a device screen. */
export const MAX_SCREEN_EDGE_PX = 4096;

// Re-exported so the mockup contract reads as one module to its callers.
export { MAX_RENDER_REGIONS, MOCKUP_RENDER_BASES };
export type { MockupRenderBase };

/** Which packaged base frame a mockup is composited onto, and what goes where. */
export interface MockupRender {
  base: MockupRenderBase;
  /** region id from the base's regions file -> a name in the entry's `screens`. */
  map: Record<string, string>;
}

export interface AssetPlanEntry {
  file: string;
  kind: AssetKind;
  sourceFile?: string;
  inputs?: string[];
  /** Stage 5.2 only: the approved-copy section this image is placed in. */
  section?: string;
  /** Stage 5.2 only: the headline or claim from the approved copy this image proves. */
  proves?: string;
  /**
   * Direct run only: the file in the harvest this asset was derived from
   * ("raw/01-portrait.jpg" or the live Instagram proof at the harvest root).
   * It is the link that proves a manifest covers the approved image map.
   */
  harvestFile?: string;
  /**
   * Stage 5.2 only: the HTML screens this asset owns under `screens/`, by
   * name without the extension. They are the agent's work; the rendered
   * mockup is the orchestrator's.
   */
  screens?: string[];
  /** Stage 5.2 only, mockups: how the orchestrator composites the screens. */
  render?: MockupRender;
}

interface AssetPlan {
  schemaVersion: 1;
  attemptId: string;
  assets: AssetPlanEntry[];
}

export interface AssetManifestEntry extends AssetPlanEntry {
  status: AssetStatus;
  sha256: string;
  problems: string[];
  previewable: boolean;
}

export interface AssetManifest {
  schemaVersion: 1;
  generatedAt: string;
  attemptId: string;
  ignoredFiles: string[];
  assets: AssetManifestEntry[];
}

export interface AssetApproval {
  schemaVersion: 1;
  approvedAt: string;
  manifestSha256: string;
  approvedReviewRequiredFiles: string[];
  contactSheetFile?: string;
  contactSheetSha256?: string;
}

export interface AssetValidationOptions {
  expectedAttemptId?: string;
  baselineHashes?: Record<string, string>;
  reusableHashes?: Record<string, string>;
  sealedApprovedHashes?: Record<string, string>;
  /** Stage 5.2 only. Stage 7.5 validates generated creatives that have no page section. */
  requirePlacementMap?: boolean;
  /**
   * Stage 5.2 only, and only once the orchestrator rendered this attempt's
   * mockups. Absent for a plan that declares no mockup to render, which is why
   * a folder with no mockups validates exactly as it did before Task 16.
   */
  mockupReceipt?: MockupRenderContext;
}

export interface AssetValidationSnapshot {
  manifest: AssetManifest;
  manifestSha256: string;
  assetBytes: ReadonlyMap<string, Buffer>;
}

export interface ReadApprovedAssetOptions {
  requireApproval?: boolean;
  expectedManifestSha256?: string;
}

interface CheckerReport {
  status: "pass" | "review_required" | "fail";
  problems?: string[];
}

interface RasterReport {
  status: "pass" | "fail";
  problems?: string[];
  meaningfulAlpha?: boolean;
  significantTransparency?: boolean;
}

interface RasterValidation {
  problems: string[];
  significantTransparency: boolean;
}

function isSafeRelativeFileName(file: string): boolean {
  return (
    path.basename(file) === file &&
    file.length <= 160 &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(file)
  );
}

export function isSafeAssetFileName(file: string): boolean {
  return isSafeRelativeFileName(file) && SAFE_RASTER_RE.test(file);
}

async function readRegularFile(
  filePath: string,
  maxBytes = MAX_ASSET_BYTES,
): Promise<Buffer> {
  const handle = await fs.open(
    filePath,
    fsConstants.O_RDONLY
      | (fsConstants.O_NOFOLLOW ?? 0)
      | (fsConstants.O_NONBLOCK ?? 0),
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`Not a regular file: ${filePath}`);
    if (stat.size > maxBytes) {
      throw new Error(`File exceeds the ${maxBytes} byte read limit: ${filePath}`);
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function fileSha256(filePath: string): Promise<string> {
  const buffer = await readRegularFile(filePath);
  return createHash("sha256").update(buffer).digest("hex");
}

function bufferSha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function checkerPath(): string {
  return path.join(process.cwd(), "scripts", "check-cutout.py");
}

function cutoutToolPath(): string {
  return path.join(process.cwd(), "scripts", "cutout.py");
}

function imageCheckerPath(): string {
  return path.join(process.cwd(), "scripts", "check-image.py");
}

interface PythonResult {
  code: number;
  stdout: string;
  stderr: string;
  failure?: string;
}

async function runPython(args: string[], input?: Buffer): Promise<PythonResult> {
  // The venv setup.sh built, never PATH's python3: on a clean machine the
  // latter has no Pillow and every checker would fail at import.
  const python = await resolvePython();
  return new Promise((resolve) => {
    const child = spawn(python, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: [input ? "pipe" : "ignore", "pipe", "pipe"],
    });
    trackChildProcess(child, "asset-python");
    let stdout = "";
    let stderr = "";
    let failure: string | undefined;
    let settled = false;
    let forceKill: NodeJS.Timeout | undefined;
    const timeout = setTimeout(() => {
      failure = `בדיקת התמונה חרגה מ-${PYTHON_TIMEOUT_MS / 1000} שניות`;
      child.kill("SIGTERM");
      forceKill = setTimeout(() => child.kill("SIGKILL"), 1_000);
      forceKill.unref();
    }, PYTHON_TIMEOUT_MS);
    timeout.unref();
    const finish = (result: PythonResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      resolve(result);
    };
    const collect = (target: "stdout" | "stderr", chunk: Buffer) => {
      if (failure) return;
      const value = chunk.toString("utf8");
      if (stdout.length + stderr.length + value.length > PYTHON_OUTPUT_LIMIT) {
        failure = "בודק התמונה חרג מתקרת הפלט";
        child.kill("SIGTERM");
        forceKill = setTimeout(() => child.kill("SIGKILL"), 1_000);
        forceKill.unref();
        return;
      }
      if (target === "stdout") stdout += value;
      else stderr += value;
    };
    child.stdout!.on("data", (chunk: Buffer) => collect("stdout", chunk));
    child.stderr!.on("data", (chunk: Buffer) => collect("stderr", chunk));
    if (input && child.stdin) {
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    }
    child.once("error", (error) =>
      finish({ code: -1, stdout, stderr, failure: `לא ניתן להריץ Python: ${error.message}` }),
    );
    child.once("close", (code) => finish({ code: code ?? -1, stdout, stderr, failure }));
  });
}

/**
 * Produce small, metadata-free review snapshots. The contact sheet never
 * embeds original multi-megabyte assets, which keeps a hostile or merely large
 * asset set from multiplying memory use through base64 conversion.
 */
export async function createAssetThumbnailDataUrls(
  assetBytes: ReadonlyMap<string, Buffer>,
  files: readonly string[],
): Promise<Record<string, string>> {
  const sources: Record<string, string> = {};
  let totalBytes = 0;
  for (const file of files) {
    if (!isSafeAssetFileName(file)) throw new Error(`Unsafe thumbnail filename: ${file}`);
    const bytes = assetBytes.get(file);
    if (!bytes) throw new Error(`Validated asset bytes are missing for thumbnail: ${file}`);
    const result = await runPython(
      [imageCheckerPath(), "--thumbnail-data-url", "--stdin-name", file],
      bytes,
    );
    const value = result.stdout.trim();
    if (
      result.failure ||
      result.code !== 0 ||
      !/^data:image\/webp;base64,[A-Za-z0-9+/]+={0,2}$/.test(value)
    ) {
      throw new Error(
        result.failure ??
          `לא ניתן ליצור thumbnail בטוח עבור ${file}: ${(result.stderr || result.stdout).trim().slice(0, 300)}`,
      );
    }
    const valueBytes = Buffer.byteLength(value, "ascii");
    if (valueBytes > MAX_THUMBNAIL_DATA_URL_BYTES) {
      throw new Error(`Thumbnail for ${file} exceeds the ${MAX_THUMBNAIL_DATA_URL_BYTES} byte limit`);
    }
    totalBytes += valueBytes;
    if (totalBytes > MAX_THUMBNAIL_SET_BYTES) {
      throw new Error("Contact-sheet thumbnails exceed their total memory limit");
    }
    sources[file] = value;
  }
  return sources;
}

export async function recoverCutoutTransactions(assetsDir: string): Promise<void> {
  await assertManagedDirectory(assetsDir, path.dirname(assetsDir));
  const result = await runPython([cutoutToolPath(), "--recover-dir", assetsDir]);
  if (result.failure || result.code !== 0) {
    throw new Error(
      result.failure
        ?? `שחזור עסקת cutout נכשל: ${(result.stderr || result.stdout).trim().slice(0, 500)}`,
    );
  }
}

async function checkCutout(
  candidateBytes: Buffer,
  sourceBytes: Buffer,
  candidateName: string,
  sourceName: string,
  sealedApprovedHash?: string,
): Promise<{ status: AssetStatus; problems: string[] }> {
  const header = Buffer.alloc(8);
  header.writeBigUInt64BE(BigInt(candidateBytes.length));
  const result = await runPython([
    checkerPath(),
    "--json",
    "--stdin-pair",
    candidateName,
    sourceName,
    ...(sealedApprovedHash ? ["--trusted-output-sha256", sealedApprovedHash] : []),
  ], Buffer.concat([header, candidateBytes, sourceBytes]));
  if (result.failure) return { status: "rejected", problems: [result.failure] };
  try {
    const report = (JSON.parse(result.stdout) as CheckerReport[])[0];
    if (!report) return { status: "rejected", problems: ["בודק ה-cutout לא החזיר דוח"] };
    if (report.status === "pass" && result.code === 0) return { status: "approved", problems: [] };
    if (report.status === "review_required" && result.code === 3) {
      return { status: "review-required", problems: [] };
    }
    if (report.status === "fail" && result.code === 1) {
      return { status: "rejected", problems: report.problems ?? ["בדיקת ה-cutout נכשלה"] };
    }
    return { status: "rejected", problems: ["הסטטוס וקוד היציאה של בודק ה-cutout אינם תואמים"] };
  } catch {
    return {
      status: "rejected",
      problems: [`בודק ה-cutout החזיר פלט לא תקין: ${(result.stderr || result.stdout).trim().slice(0, 300)}`],
    };
  }
}

async function validateRaster(fileBytes: Buffer, fileName: string): Promise<RasterValidation> {
  const result = await runPython(
    [imageCheckerPath(), "--json", "--stdin-name", fileName],
    fileBytes,
  );
  if (result.failure) return { problems: [result.failure], significantTransparency: false };
  try {
    const report = (JSON.parse(result.stdout) as RasterReport[])[0];
    if (report?.status === "pass" && result.code === 0) {
      return {
        problems: [],
        significantTransparency: report.significantTransparency === true,
      };
    }
    return {
      problems: report?.problems?.length
        ? report.problems
        : [`בודק התמונה נכשל: ${(result.stderr || result.stdout).trim().slice(0, 300)}`],
      significantTransparency: report?.significantTransparency === true,
    };
  } catch {
    return {
      problems: [`בודק התמונה החזיר פלט לא תקין: ${(result.stderr || result.stdout).trim().slice(0, 300)}`],
      significantTransparency: false,
    };
  }
}

export async function assertManagedDirectory(directory: string, expectedParent: string): Promise<string> {
  if (path.resolve(path.dirname(directory)) !== path.resolve(expectedParent)) {
    throw new Error(`Managed directory is outside its expected parent: ${directory}`);
  }
  const parentStat = await fs.lstat(expectedParent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error(`Managed parent is not a regular directory: ${expectedParent}`);
  }
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Managed path is not a regular directory: ${directory}`);
  }
  const realParent = await fs.realpath(expectedParent);
  const realDirectory = await fs.realpath(directory);
  if (path.dirname(realDirectory) !== realParent) {
    throw new Error(`Managed directory escapes its expected parent: ${directory}`);
  }
  return realDirectory;
}

export async function ensureManagedDirectory(directory: string, expectedParent: string): Promise<string> {
  try {
    await fs.lstat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await fs.mkdir(directory, { mode: 0o700 });
  }
  return assertManagedDirectory(directory, expectedParent);
}

export async function removeManagedChildDirectory(
  directory: string,
  expectedParent: string,
): Promise<void> {
  try {
    await fs.lstat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await assertManagedDirectory(directory, expectedParent);
  await fs.rm(directory, { recursive: true });
}

async function atomicWriteBuffer(filePath: string, value: Buffer): Promise<void> {
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, value, { mode: 0o600 });
    await fs.rename(temporary, filePath);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await atomicWriteBuffer(filePath, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"));
}

export async function atomicCreateManagedFile(
  filePath: string,
  expectedParent: string,
  value: Buffer | string,
): Promise<void> {
  if (path.dirname(path.resolve(filePath)) !== path.resolve(expectedParent)) {
    throw new Error(`Managed file is outside its expected parent: ${filePath}`);
  }
  await assertManagedDirectory(expectedParent, path.dirname(expectedParent));
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  const temporary = path.join(expectedParent, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    try {
      await fs.link(temporary, filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let existing: Buffer;
      try {
        existing = await readRegularFile(filePath, Math.max(bytes.length, 1));
      } catch {
        throw new Error(`Managed file already exists and is not a safe regular file: ${filePath}`);
      }
      if (!existing.equals(bytes)) {
        throw new Error(`Managed file already exists with different content: ${filePath}`);
      }
    }
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

async function readPlan(assetsDir: string, expectedAttemptId?: string): Promise<AssetPlan> {
  const planPath = path.join(assetsDir, ASSET_PLAN_NAME);
  let plan: AssetPlan;
  try {
    plan = JSON.parse(
      (await readRegularFile(planPath, MAX_CONTROL_FILE_BYTES)).toString("utf8"),
    ) as AssetPlan;
  } catch (error) {
    throw new Error(`Asset plan is missing or invalid at ${planPath}: ${String(error)}`);
  }
  if (
    plan.schemaVersion !== ASSET_SCHEMA_VERSION ||
    typeof plan.attemptId !== "string" ||
    !plan.attemptId ||
    !Array.isArray(plan.assets)
  ) {
    throw new Error(`Asset plan has an unsupported schema at ${planPath}`);
  }
  if (plan.assets.length > MAX_ASSET_COUNT) {
    throw new Error(`Asset plan exceeds the ${MAX_ASSET_COUNT} file limit`);
  }
  if (expectedAttemptId && plan.attemptId !== expectedAttemptId) {
    throw new Error(`Asset plan belongs to attempt ${plan.attemptId}, expected ${expectedAttemptId}`);
  }
  return plan;
}

/**
 * The plan's entries, for the orchestrator steps that run between the agent
 * and validation (Task 16's mockup render). An unreadable plan yields no
 * entries rather than an error of its own: validateAssetFolderSnapshot, which
 * runs right after, is the one place that reports what is wrong with it.
 */
export async function readAssetPlanEntries(
  assetsDir: string,
  expectedAttemptId?: string,
): Promise<AssetPlanEntry[]> {
  try {
    await assertManagedDirectory(assetsDir, path.dirname(assetsDir));
    return (await readPlan(assetsDir, expectedAttemptId)).assets;
  } catch {
    return [];
  }
}

export async function hasValidAssetPlan(assetsDir: string): Promise<boolean> {
  try {
    await assertManagedDirectory(assetsDir, path.dirname(assetsDir));
    await readPlan(assetsDir);
    return true;
  } catch {
    return false;
  }
}

const HARVEST_FILE_RE = /^(raw\/[^/]+|instagram-[A-Za-z0-9._]+\.png)$/;
const MAX_HARVEST_FILE_CHARS = 200;

/**
 * A harvestFile is a path inside the run's harvest directory, and nothing
 * else: no traversal, no absolute path, no backslash and no control
 * character. An asset that claims a malformed one is rejected outright,
 * because the field exists to prove where an image came from.
 */
export function isValidHarvestFile(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_HARVEST_FILE_CHARS &&
    !value.includes("..") &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !/[\u0000-\u001f\u007f]/.test(value) &&
    HARVEST_FILE_RE.test(value)
  );
}

export const HARVEST_FILE_INVALID_PROBLEM = "harvestFile לא תקין";

export const MOCKUP_RENDER_MISSING_PROBLEM = "מוקאפ בלי הוראת רינדור";
export const MOCKUP_FILE_FORMAT_PROBLEM = "קובץ מוקאפ חייב להיות WebP או PNG";
export const INPUTS_HTML_PROBLEM = "inputs מכיל HTML; מסכים מוצהרים ב-screens";
export const MOCKUP_INPUTS_MISSING_PROBLEM = "מוקאפ חייב להצהיר על קובצי הקלט שמהם הורכב";
export const RENDER_MAP_UNDECLARED_PROBLEM = "map מפנה למסך שלא הוצהר";
export const RENDER_INVALID_PROBLEM = "הוראת רינדור לא תקינה";
export const SCREEN_NAME_INVALID_PROBLEM = "שם מסך לא תקין";
export const SCREEN_FILE_MISSING_PROBLEM = "מסך מוצהר חסר";
export const SCREEN_SIZES_PROBLEM = "sizes.json לא מגדיר מידות תקינות לכל מסך מוצהר";
export const SCREENS_NOT_MOCKUP_PROBLEM = "screens ו-render מותרים רק למוקאפ";
export const SCREEN_CLAIMED_TWICE_PROBLEM = "מסך מוצהר ביותר מרשומה אחת";
/**
 * Task 16. A mockup file is finished work of the orchestrator, not of the
 * agent: it counts only when the receipt of THIS attempt says the renderer
 * produced exactly these bytes. A file from an earlier attempt, a row the
 * renderer rejected and a missing row are the same fact to the sheet.
 */
export const MOCKUP_RECEIPT_PROBLEM = "מוקאפ מניסיון קודם או ללא רינדור";

/** What the orchestrator's mockup render produced, as validation reads it. */
export interface MockupRenderContext {
  /** The receipt renderMockups wrote for this attempt. */
  receipt: MockupRenderReceipt;
  /**
   * The screen names that passed the render boundaries (validateScreens's
   * `ok`). Only these are excused from the undeclared-file check: a screen
   * the renderer refused to open is a stray file in the assets folder.
   */
  acceptedScreens: readonly string[];
}

/** The files under `screens/` an entry owns. Never a path outside that folder. */
export function screenFilesFor(entry: Pick<AssetPlanEntry, "screens">): string[] {
  return declaredScreenNames(entry).names.map((name) => `${SCREENS_DIR}/${name}.html`);
}

/**
 * The entry's `screens` list, or the one problem that makes it unusable. A
 * malformed list yields no names at all, so nothing it points at can be
 * mistaken for a file the agent was allowed to leave behind.
 */
function declaredScreenNames(
  entry: Pick<AssetPlanEntry, "screens">,
): { names: string[]; problems: string[] } {
  if (entry.screens === undefined) return { names: [], problems: [] };
  if (
    !Array.isArray(entry.screens) ||
    entry.screens.length > MAX_RENDER_REGIONS ||
    entry.screens.some((name) => typeof name !== "string" || !SCREEN_NAME_RE.test(name))
  ) {
    return { names: [], problems: [SCREEN_NAME_INVALID_PROBLEM] };
  }
  return { names: [...new Set(entry.screens)], problems: [] };
}

/** A render instruction the orchestrator could actually act on. */
export function isValidMockupRender(value: unknown): value is MockupRender {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const render = value as { base?: unknown; map?: unknown };
  if (!isMockupRenderBase(render.base)) return false;
  if (!render.map || typeof render.map !== "object" || Array.isArray(render.map)) return false;
  const pairs = Object.entries(render.map as Record<string, unknown>);
  if (!pairs.length || pairs.length > MAX_RENDER_REGIONS) return false;
  // A region id is the number the base frame's regions file gave the region:
  // the renderer parses it as an integer and composite.py receives it as one,
  // so a key in any other spelling is refused here, on the sheet, rather than
  // at the end of a render that could never have worked.
  return pairs.every(
    ([regionId, screen]) =>
      REGION_ID_RE.test(regionId) && typeof screen === "string" && SCREEN_NAME_RE.test(screen),
  );
}

/**
 * A screen file belongs to exactly one entry. Two mockups claiming the same
 * name would both be rendered from it, and neither could be rejected on its
 * own merits without leaving the file half owned.
 */
function screenNamesClaimedTwice(entries: readonly AssetPlanEntry[]): Set<string> {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    for (const name of declaredScreenNames(entry).names) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return new Set([...counts].filter(([, count]) => count > 1).map(([name]) => name));
}

/**
 * What the assets folder itself says about the declared screens: which HTML
 * files really exist as regular files, and what sizes.json accepts. Absent
 * (the plain plan-shape check) when there is no folder to look at yet.
 */
interface ScreenContext {
  present: ReadonlySet<string>;
  /** null when sizes.json is missing, unreadable or not an object. */
  sizes: ReadonlyMap<string, readonly [number, number]> | null;
}

function validatePlanEntry(entry: AssetPlanEntry, screens?: ScreenContext): string[] {
  const problems: string[] = [];
  // Read once, at the top: whether the entry is rendered from screens decides
  // both what it owns in the folder and whether it still owes an inputs list.
  const declared = declaredScreenNames(entry);
  problems.push(...declared.problems);
  const kinds: AssetKind[] = ["photo", "cutout", "mockup", "logo", "proof", "generated"];
  if (!isSafeRelativeFileName(entry.file)) problems.push("שם הקובץ אינו שם יחסי ובטוח");
  else if (!SAFE_RASTER_RE.test(entry.file)) {
    problems.push("סוג הקובץ אינו נתמך. יש להשתמש רק ב-PNG, WebP, JPEG או AVIF, ולא ב-SVG");
  }
  if (!kinds.includes(entry.kind)) problems.push(`סוג נכס לא נתמך: ${String(entry.kind)}`);
  if (entry.sourceFile && !isSafeRelativeFileName(entry.sourceFile)) problems.push("שם קובץ המקור אינו בטוח");
  else if (entry.sourceFile && !SAFE_RASTER_RE.test(entry.sourceFile)) {
    problems.push("קובץ מקור חייב להיות PNG, WebP, JPEG או AVIF");
  }
  if (entry.sourceFile === entry.file) problems.push("cutout לא יכול לשמש כמקור של עצמו");
  // inputs are IMAGE dependencies only. An HTML screen belongs in `screens`,
  // where it is rendered under the render boundaries instead of being treated
  // as a finished picture.
  const isHtmlInput = (input: unknown): boolean => typeof input === "string" && HTML_INPUT_RE.test(input);
  if (entry.inputs?.some(isHtmlInput)) problems.push(INPUTS_HTML_PROBLEM);
  if (entry.inputs?.some((input) => !isHtmlInput(input) && (!isSafeRelativeFileName(input) || !SAFE_RASTER_RE.test(input)))) {
    problems.push("רשימת התלויות מכילה שם קובץ לא בטוח");
  }
  // A rendered mockup's inputs are its screens: the orchestrator opens them,
  // expands the `asset:` references inside them and composites the result, so
  // there is nothing left for an `inputs` list to say. Requiring one made a
  // screen of pure text an impossible mockup. A mockup that declares neither
  // screens nor a usable render instruction is not rendered from anything, so
  // it still has to name what it was built from.
  const renderedFromScreens = declared.names.length > 0 && isValidMockupRender(entry.render);
  if (entry.kind === "mockup" && !renderedFromScreens && !entry.inputs?.length) {
    problems.push(MOCKUP_INPUTS_MISSING_PROBLEM);
  }
  // The renderer writes the mockup itself, through composite.py, which saves
  // an RGBA image by extension: JPEG raises and AVIF has no encoder. A mockup
  // declared with one of those could only ever end in "הרכבת המוקאפ נכשלה".
  if (entry.kind === "mockup" && isSafeRelativeFileName(entry.file) && !MOCKUP_FILE_RE.test(entry.file)) {
    problems.push(MOCKUP_FILE_FORMAT_PROBLEM);
  }
  if (entry.harvestFile !== undefined && !isValidHarvestFile(entry.harvestFile)) {
    problems.push(HARVEST_FILE_INVALID_PROBLEM);
  }

  // Only a mockup is rendered from screens, so only a mockup may declare them.
  // Otherwise a photo entry could excuse HTML files from the undeclared-file
  // check without anything ever rendering them.
  if (entry.kind !== "mockup" && (entry.screens !== undefined || entry.render !== undefined)) {
    problems.push(SCREENS_NOT_MOCKUP_PROBLEM);
  }
  if (entry.render !== undefined && !isValidMockupRender(entry.render)) problems.push(RENDER_INVALID_PROBLEM);
  // A mockup with no render instruction would reach the sheet as a file
  // nobody rendered, which is exactly the run that ended "no mockups".
  if (entry.kind === "mockup" && entry.render === undefined) problems.push(MOCKUP_RENDER_MISSING_PROBLEM);
  if (isValidMockupRender(entry.render)) {
    const names = new Set(declared.names);
    if (Object.values(entry.render.map).some((screen) => !names.has(screen))) {
      problems.push(RENDER_MAP_UNDECLARED_PROBLEM);
    }
  }
  if (screens && declared.names.length) {
    if (declared.names.some((name) => !screens.present.has(name))) problems.push(SCREEN_FILE_MISSING_PROBLEM);
    const sizes = screens.sizes;
    if (!sizes || declared.names.some((name) => !sizes.has(name))) problems.push(SCREEN_SIZES_PROBLEM);
  }
  return problems;
}

export const MAX_PLACEMENT_SECTION_CHARS = 80;
export const MAX_PLACEMENT_PROVES_CHARS = 200;

export interface MappedAsset {
  file: string;
  section: string;
  proves: string;
}

export interface AssetPlacement {
  mapped: MappedAsset[];
  logos: string[];
  rawMaterial: string[];
  unmapped: string[];
}

export function placementFields(
  entry: Pick<AssetPlanEntry, "section" | "proves">,
): { section: string; proves: string } | null {
  const section = typeof entry.section === "string" ? entry.section.trim() : "";
  const proves = typeof entry.proves === "string" ? entry.proves.trim() : "";
  if (!section || !proves) return null;
  if (section.length > MAX_PLACEMENT_SECTION_CHARS || proves.length > MAX_PLACEMENT_PROVES_CHARS) return null;
  return { section, proves };
}

/**
 * The declared files an entry is built from, as the sheet and the dependency
 * graph both read them: a cutout's source, plus any image inputs.
 *
 * A rendered mockup's real inputs are its screens, and a screen is not a plan
 * entry: it is owned through `screens`, excused from the undeclared-file check
 * there, and opened by the renderer, which resolves the `asset:` references
 * inside it. So `inputs` is optional on such a mockup, and what it still does
 * when present is link an approved picture the screens use, so the sheet lists
 * that picture as raw material instead of asking a human why it is unmapped.
 *
 * Every place that walks dependencies reads them through here, so the sheet,
 * the cycle check and the status propagation can never disagree about what a
 * dependency is.
 */
export function entryDependencies(
  entry: Pick<AssetPlanEntry, "sourceFile" | "inputs"> | undefined,
): string[] {
  return [entry?.sourceFile, ...(entry?.inputs ?? [])].filter((value): value is string => Boolean(value));
}

/**
 * The single source of truth for which assets the page must show. The contact
 * sheet, the builder prompt and the rendered-page check all call this, so they
 * can never disagree about what counts as mapped. A complete map wins over
 * being a logo or an input of another asset.
 */
export function classifyAssetPlacement(entries: readonly AssetPlanEntry[]): AssetPlacement {
  const referenced = new Set<string>();
  for (const entry of entries) {
    for (const dependency of entryDependencies(entry)) referenced.add(dependency);
  }
  const placement: AssetPlacement = { mapped: [], logos: [], rawMaterial: [], unmapped: [] };
  for (const entry of entries) {
    const fields = placementFields(entry);
    if (fields) placement.mapped.push({ file: entry.file, ...fields });
    else if (entry.kind === "logo") placement.logos.push(entry.file);
    else if (referenced.has(entry.file)) placement.rawMaterial.push(entry.file);
    else placement.unmapped.push(entry.file);
  }
  return placement;
}

export const PLACEMENT_MAP_MISSING_PROBLEM = "חסרה סקציה או טענה שהתמונה מוכיחה";

/**
 * A missing map asks a human to look; it is never a quality failure. So it
 * moves an approved asset to review-required, adds its problem to an asset that
 * is already review-required (so the human sees both reasons), and leaves a
 * rejected asset and its problems alone. Classification runs over every plan
 * entry, rejected ones included, so the source of a rejected cutout still
 * counts as raw material here.
 */
function applyPlacementRequirement(assets: AssetManifestEntry[]): void {
  const unmapped = new Set(classifyAssetPlacement(assets).unmapped);
  for (const asset of assets) {
    if (!unmapped.has(asset.file) || asset.status === "rejected") continue;
    asset.status = "review-required";
    if (!asset.problems.includes(PLACEMENT_MAP_MISSING_PROBLEM)) asset.problems.push(PLACEMENT_MAP_MISSING_PROBLEM);
  }
}

function worseStatus(left: AssetStatus, right: AssetStatus): AssetStatus {
  const rank: Record<AssetStatus, number> = { approved: 0, "review-required": 1, rejected: 2 };
  return rank[left] >= rank[right] ? left : right;
}

function dependencyCycles(entries: AssetManifestEntry[]): Set<string> {
  const byFile = new Map(entries.map((entry) => [entry.file, entry]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const cyclic = new Set<string>();
  const visit = (file: string, stack: string[]) => {
    if (visiting.has(file)) {
      const start = stack.indexOf(file);
      for (const member of stack.slice(start)) cyclic.add(member);
      return;
    }
    if (visited.has(file)) return;
    visiting.add(file);
    for (const input of entryDependencies(byFile.get(file))) {
      visit(input, [...stack, file]);
    }
    visiting.delete(file);
    visited.add(file);
  };
  for (const entry of entries) visit(entry.file, []);
  return cyclic;
}

function propagateDependencies(
  entries: AssetManifestEntry[],
  ignoredFiles: string[] = [],
  /** Screen file -> the entry whose malformed `screens` list left it unowned. */
  malformedScreenOwners: ReadonlyMap<string, string> = new Map(),
): AssetManifestEntry[] {
  const byFile = new Map(entries.map((entry) => [entry.file, { ...entry, problems: [...entry.problems] }]));
  const cyclic = dependencyCycles(entries);
  for (const file of cyclic) {
    const entry = byFile.get(file);
    if (entry) {
      entry.status = "rejected";
      entry.problems.push("מעגל תלות בין נכסים");
    }
  }

  for (const entry of byFile.values()) {
    for (const dependency of entryDependencies(entry)) {
      if (!byFile.has(dependency)) {
        entry.status = "rejected";
        entry.problems.push(`תלות שלא הוצהרה או חסרה: ${dependency}`);
      }
    }
  }

  for (let round = 0; round < byFile.size; round += 1) {
    let changed = false;
    for (const entry of byFile.values()) {
      let status = entry.status;
      for (const input of entryDependencies(entry)) {
        const dependency = byFile.get(input);
        if (dependency) status = worseStatus(status, dependency.status);
      }
      if (status !== entry.status) {
        entry.status = status;
        entry.problems.push("הנכס ירש כשל או דרישת בדיקה מאחד מקובצי הקלט שלו");
        changed = true;
      }
    }
    if (!changed) break;
  }

  const cutouts = [...byFile.values()].filter((entry) => entry.kind === "cutout");
  const worstCutout = cutouts.reduce<AssetStatus>(
    (status, entry) => worseStatus(status, entry.status),
    "approved",
  );
  if (worstCutout !== "approved") {
    for (const entry of byFile.values()) {
      if (entry.kind !== "mockup") continue;
      const next = worseStatus(entry.status, worstCutout);
      if (next !== entry.status) {
        entry.status = next;
        entry.problems.push("קיים cutout לא מאומת בתיקייה, ולכן אי אפשר לאשר שהמוקאפ אינו מכיל אותו");
      }
    }
  }
  if (ignoredFiles.length) {
    // A screen file that is unowned only because its own entry's `screens`
    // list is malformed is not a stray file the agent has to hunt for: saying
    // "undeclared files" about it sends it looking for something it never
    // wrote. The entry that has to be fixed is named instead.
    const stray = ignoredFiles.filter((file) => !malformedScreenOwners.has(file));
    // Only a regular file with an image extension is an image file. A
    // directory entry (it ends with "/") is still reported, because a folder
    // nobody declared is still material the mockup could have been built
    // from, but calling it an image sends the agent hunting for a picture
    // that was never there.
    const strayImages = stray.filter((file) => IMAGE_FILE_RE.test(file));
    const strayOther = stray.filter((file) => !IMAGE_FILE_RE.test(file));
    const malformed = new Map<string, string[]>();
    for (const file of ignoredFiles) {
      const owner = malformedScreenOwners.get(file);
      if (owner) malformed.set(owner, [...(malformed.get(owner) ?? []), file]);
    }
    for (const entry of byFile.values()) {
      if (entry.kind !== "mockup") continue;
      entry.status = "rejected";
      if (strayImages.length) {
        entry.problems.push(
          `קיימים קובצי תמונה לא מוצהרים בתיקייה (${strayImages.join(", ")}), ולכן אי אפשר לאמת את כל מקורות המוקאפ`,
        );
      }
      if (strayOther.length) {
        entry.problems.push(
          `קיימים פריטים לא מוצהרים בתיקייה (${strayOther.join(", ")}), ולכן אי אפשר לאמת את כל מקורות המוקאפ`,
        );
      }
      for (const [owner, files] of malformed) {
        entry.problems.push(
          `הצהרת ה-screens של ${owner} אינה תקינה, ולכן קובצי המסך שלה (${files.join(", ")}) אינם מוכרים בתיקייה`,
        );
      }
    }
  }
  return [...byFile.values()].sort((left, right) => left.file.localeCompare(right.file));
}

export async function snapshotAssetHashes(assetsDir: string): Promise<Record<string, string>> {
  let entries;
  try {
    entries = await fs.readdir(assetsDir, { withFileTypes: true });
  } catch {
    return {};
  }
  const hashes: Record<string, string> = {};
  for (const entry of entries) {
    if (!entry.isFile() || !IMAGE_FILE_RE.test(entry.name)) continue;
    hashes[entry.name] = await fileSha256(path.join(assetsDir, entry.name)).catch(() => "");
  }
  return hashes;
}

export async function readReusableAssetHashes(
  assetsDir: string,
  expectedManifestSha256?: string,
): Promise<Record<string, string>> {
  if (!expectedManifestSha256) return {};
  try {
    await assertManagedDirectory(assetsDir, path.dirname(assetsDir));
    const manifestBuffer = await readRegularFile(
      path.join(assetsDir, ASSET_MANIFEST_NAME),
      MAX_CONTROL_FILE_BYTES,
    );
    if (bufferSha256(manifestBuffer) !== expectedManifestSha256) return {};
    const manifest = JSON.parse(manifestBuffer.toString("utf8")) as AssetManifest;
    if (manifest.schemaVersion !== ASSET_SCHEMA_VERSION || !Array.isArray(manifest.assets)) return {};
    const reusable: Record<string, string> = {};
    for (const entry of manifest.assets.filter((asset) => asset.status !== "rejected")) {
      if (!isSafeAssetFileName(entry.file)) continue;
      const actualHash = await fileSha256(path.join(assetsDir, entry.file)).catch(() => "");
      if (actualHash && actualHash === entry.sha256) reusable[entry.file] = entry.sha256;
    }
    return reusable;
  } catch {
    return {};
  }
}

async function listAttemptEntriesRecursive(root: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (current: string, depth: number): Promise<void> => {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (files.length >= MAX_ATTEMPT_ENTRIES) {
        throw new Error(`Asset attempt exceeds the ${MAX_ATTEMPT_ENTRIES} filesystem entry limit`);
      }
      const absolute = path.join(current, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      // At any depth: the sandbox writes its control directory into whatever
      // folder the agent is working from, which was the assets folder in one
      // run and `screens/` in the next. An exclusion pinned to the top made
      // the harness's own scaffolding an undeclared file the moment the agent
      // moved a level down, and rejected every mockup with it. Nothing is
      // walked inside it either, so a file planted there is neither counted
      // against the entry limit nor reported; it can reach nothing, because
      // the builder only ever receives the assets the plan declared and the
      // manifest approved, and this directory declares none.
      if (entry.isDirectory() && entry.name === SANDBOX_CONTROL_DIR) continue;
      if (entry.isDirectory()) {
        files.push(`${relative}/`);
        if (depth >= MAX_ATTEMPT_DEPTH) {
          throw new Error(`Asset attempt exceeds the ${MAX_ATTEMPT_DEPTH} directory depth limit`);
        }
        await walk(absolute, depth + 1);
      } else {
        files.push(relative);
      }
    }
  };
  await walk(root, 0);
  return files.sort();
}

function isAllowedAttemptControlFile(
  file: string,
  declared: ReadonlySet<string>,
  allowedScreenFiles: ReadonlySet<string> = new Set(),
): boolean {
  // The screens folder is the single exception to the flat assets folder, and
  // only for the files some entry declared and whose entry validated. An
  // undeclared file there is an undeclared file like any other.
  if (file.includes("/")) return allowedScreenFiles.has(file);
  if ([ASSET_PLAN_NAME, ASSET_MANIFEST_NAME, ASSET_APPROVAL_NAME].includes(file)) return true;
  return file.endsWith(".cutout.json") && declared.has(file.slice(0, -".cutout.json".length));
}

/**
 * sizes.json as a map of screen name to the size the renderer may use. A
 * malformed file is null (every declared screen then fails), and a single
 * malformed or over-sized entry is simply absent, so the screen it belongs to
 * fails on its own.
 */
async function readScreenSizes(
  assetsDir: string,
): Promise<ReadonlyMap<string, readonly [number, number]> | null> {
  let parsed: unknown;
  try {
    const bytes = await readRegularFile(
      path.join(assetsDir, SCREENS_DIR, SCREEN_SIZES_NAME),
      MAX_CONTROL_FILE_BYTES,
    );
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const sizes = new Map<string, readonly [number, number]>();
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!SCREEN_NAME_RE.test(name) || !Array.isArray(value) || value.length !== 2) continue;
    const [width, height] = value as unknown[];
    if (!Number.isInteger(width) || !Number.isInteger(height)) continue;
    const [w, h] = [width as number, height as number];
    if (w < 1 || h < 1 || w > MAX_SCREEN_EDGE_PX || h > MAX_SCREEN_EDGE_PX) continue;
    sizes.set(name, [w, h]);
  }
  return sizes;
}

/** The screen names that really exist as regular files (never a symlink). */
async function readPresentScreens(
  assetsDir: string,
  actualEntries: readonly string[],
): Promise<Set<string>> {
  const present = new Set<string>();
  for (const file of actualEntries) {
    const name = SCREEN_HTML_RE.exec(file)?.[1];
    if (!name) continue;
    const stat = await fs.lstat(path.join(assetsDir, file)).catch(() => null);
    if (stat?.isFile()) present.add(name);
  }
  return present;
}

export async function validateAssetFolderSnapshot(
  assetsDir: string,
  options: AssetValidationOptions = {},
): Promise<AssetValidationSnapshot> {
  await assertManagedDirectory(assetsDir, path.dirname(assetsDir));
  const plan = await readPlan(assetsDir, options.expectedAttemptId);
  const baseline = options.baselineHashes ?? {};
  const reusable = options.reusableHashes ?? {};
  const sealedApproved = options.sealedApprovedHashes ?? {};
  const assetBytes = new Map<string, Buffer>();
  let totalAssetBytes = 0;
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const entry of plan.assets) {
    if (seen.has(entry.file)) duplicates.add(entry.file);
    seen.add(entry.file);
  }

  const declared = new Set(plan.assets.map((entry) => entry.file));
  const actualEntries = await listAttemptEntriesRecursive(assetsDir);
  // The plan-entry problems are computed first because they decide which
  // screens stay out of ignoredFiles: only the screens of an entry that
  // validated are excused, so a broken declaration cannot launder a file.
  const screenContext: ScreenContext = {
    present: await readPresentScreens(assetsDir, actualEntries),
    sizes: await readScreenSizes(assetsDir),
  };
  const claimedTwice = screenNamesClaimedTwice(plan.assets);
  const planProblems = plan.assets.map((entry) => {
    const problems = validatePlanEntry(entry, screenContext);
    if (duplicates.has(entry.file)) problems.push("שם הקובץ מופיע יותר מפעם אחת בתוכנית הנכסים");
    if (declaredScreenNames(entry).names.some((name) => claimedTwice.has(name))) {
      problems.push(SCREEN_CLAIMED_TWICE_PROBLEM);
    }
    return problems;
  });
  // The screen files an entry meant to own but could not, because its own
  // `screens` list is malformed: they are still unowned, and still fail the
  // folder check, but the sheet names the declaration to fix rather than
  // reporting a stray file the agent never wrote.
  const malformedScreenOwners = new Map<string, string>();
  plan.assets.forEach((entry, index) => {
    if (!planProblems[index]!.includes(SCREEN_NAME_INVALID_PROBLEM)) return;
    const raw = Array.isArray(entry.screens) ? entry.screens : [];
    for (const name of raw) {
      if (typeof name !== "string" || !SCREEN_NAME_RE.test(name)) continue;
      const file = `${SCREENS_DIR}/${name}.html`;
      if (!malformedScreenOwners.has(file)) malformedScreenOwners.set(file, String(entry.file));
    }
  });
  const allowedScreenFiles = new Set<string>([SCREEN_SIZES_FILE]);
  // Only a screen that also passed the render boundaries is excused, once the
  // renderer ran: a declaration alone never turns a file into allowed content.
  const acceptedScreens = options.mockupReceipt
    ? new Set(options.mockupReceipt.acceptedScreens)
    : null;
  plan.assets.forEach((entry, index) => {
    if (planProblems[index]!.length) return;
    for (const name of declaredScreenNames(entry).names) {
      if (acceptedScreens && !acceptedScreens.has(name)) continue;
      allowedScreenFiles.add(`${SCREENS_DIR}/${name}.html`);
    }
  });
  // The screens directory entry itself is excused only when it actually holds
  // something allowed. A screens/ folder with nothing but junk in it is
  // reported like any other stray directory.
  if (actualEntries.some((file) => allowedScreenFiles.has(file))) allowedScreenFiles.add(`${SCREENS_DIR}/`);
  const ignoredFiles = actualEntries.filter(
    (file) => !declared.has(file) && !isAllowedAttemptControlFile(file, declared, allowedScreenFiles),
  );

  const initial: AssetManifestEntry[] = [];
  for (const [planIndex, planEntry] of plan.assets.entries()) {
    const problems = [...planProblems[planIndex]!];
    const safeFile = isSafeAssetFileName(planEntry.file);
    const filePath = safeFile ? path.join(assetsDir, planEntry.file) : "";
    let hash = "";
    let previewable = false;
    let significantTransparency = false;
    /**
     * A mockup this attempt's renderer produced, by its own receipt row.
     * composite.py drops the white background, so such a file is transparent
     * by design, and the eye check for undeclared transparency does not apply
     * to it. Every other kind, and a mockup with no ok row of this attempt,
     * keeps the rule.
     */
    let renderedMockup = false;
    if (safeFile) {
      try {
        const bytes = await readRegularFile(filePath);
        if (bytes.length > MAX_ASSET_BYTES) {
          problems.push(`קובץ הנכס גדול מתקרת ${MAX_ASSET_BYTES / 1024 / 1024}MB`);
        } else if (totalAssetBytes + bytes.length > MAX_ASSET_SET_BYTES) {
          problems.push(`כלל הנכסים חורג מתקרת ${MAX_ASSET_SET_BYTES / 1024 / 1024}MB`);
        } else {
          totalAssetBytes += bytes.length;
          assetBytes.set(planEntry.file, bytes);
          hash = bufferSha256(bytes);
          const raster = await validateRaster(bytes, planEntry.file);
          problems.push(...raster.problems);
          significantTransparency = raster.significantTransparency;
          previewable = raster.problems.length === 0;
        }
      } catch (error) {
        problems.push(`הקובץ שהוצהר אינו קובץ רגיל וקריא: ${String(error)}`);
      }
    }

    if (hash && baseline[planEntry.file] === hash && reusable[planEntry.file] !== hash) {
      problems.push("הקובץ לא נוצר או השתנה בניסיון הזה, ואינו נכס מאומת שמותר למחזר");
    }

    // The mockup's own bytes must be the ones this attempt's renderer wrote.
    // The receipt is bound to the attempt through the plan, so a receipt left
    // by an earlier attempt qualifies nothing, however well-formed it is.
    if (options.mockupReceipt && planEntry.kind === "mockup") {
      const row = options.mockupReceipt.receipt.attemptId === plan.attemptId
        ? options.mockupReceipt.receipt.mockups.find((entry) => entry.file === planEntry.file)
        : undefined;
      if (!hash || !row || row.status !== "ok" || row.outputSha256 !== hash) {
        problems.push(MOCKUP_RECEIPT_PROBLEM);
      } else {
        renderedMockup = Boolean(planEntry.render);
      }
    }

    // What the entry IS, by the plan, and never by a file that happens to sit
    // beside it. A `<file>.cutout.json` receipt is evidence about a cutout, not
    // a way to reclassify an entry: a mockup with a planted sidecar used to
    // reach the manifest as kind "cutout", after which no required mockup row
    // could ever match it and coverage failed over a mockup sitting right
    // there. A mockup's own name is read the same way, for the same reason.
    const isCutout = planEntry.kind === "cutout"
      || (planEntry.kind !== "mockup" && CUTOUT_RE.test(planEntry.file));
    const status: AssetStatus = problems.length
      ? "rejected"
      : significantTransparency
          && !isCutout
          && !renderedMockup
          && sealedApproved[planEntry.file] !== hash
        ? "review-required"
        : "approved";
    const entry: AssetManifestEntry = {
      ...planEntry,
      kind: isCutout ? "cutout" : planEntry.kind,
      status,
      sha256: hash,
      problems,
      previewable,
    };
    if (status === "review-required") {
      entry.problems.push("זוהתה שקיפות משמעותית בנכס שלא הוצהר כ-cutout; נדרשת בדיקה בעין");
    }

    initial.push(entry);
  }

  const initialByFile = new Map(initial.map((entry) => [entry.file, entry]));
  for (const entry of initial.filter((asset) => asset.kind === "cutout" && asset.status !== "rejected")) {
    const source = entry.sourceFile ? initialByFile.get(entry.sourceFile) : undefined;
    if (!source || source.status === "rejected") {
      entry.status = "rejected";
      entry.problems.push("cutout חייב להצביע על sourceFile תקין שמוצהר באותה תוכנית");
      continue;
    }
    const checked = await checkCutout(
      assetBytes.get(entry.file) ?? Buffer.alloc(0),
      assetBytes.get(source.file) ?? Buffer.alloc(0),
      entry.file,
      source.file,
      sealedApproved[entry.file],
    );
    entry.status = checked.status;
    entry.problems.push(...checked.problems);
  }

  const assets = propagateDependencies(initial, ignoredFiles, malformedScreenOwners);
  if (options.requirePlacementMap) applyPlacementRequirement(assets);
  const manifest: AssetManifest = {
    schemaVersion: ASSET_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    attemptId: plan.attemptId,
    ignoredFiles,
    assets,
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await atomicWriteBuffer(path.join(assetsDir, ASSET_MANIFEST_NAME), manifestBytes);
  await fs.rm(path.join(assetsDir, ASSET_APPROVAL_NAME), { force: true });
  return {
    manifest,
    manifestSha256: bufferSha256(manifestBytes),
    assetBytes,
  };
}

export async function validateAssetFolder(
  assetsDir: string,
  options: AssetValidationOptions = {},
): Promise<AssetManifest> {
  return (await validateAssetFolderSnapshot(assetsDir, options)).manifest;
}

async function readApprovedAssetEntries(
  assetsDir: string,
  options: ReadApprovedAssetOptions = {},
): Promise<AssetManifestEntry[]> {
  await assertManagedDirectory(assetsDir, path.dirname(assetsDir));
  const manifestPath = path.join(assetsDir, ASSET_MANIFEST_NAME);
  const manifestBuffer = await readRegularFile(manifestPath, MAX_CONTROL_FILE_BYTES).catch((error) => {
    throw new Error(`Asset manifest is missing or invalid at ${manifestPath}: ${String(error)}`);
  });
  const actualManifestSha256 = bufferSha256(manifestBuffer);
  const manifest = JSON.parse(manifestBuffer.toString("utf8")) as AssetManifest;
  if (manifest.schemaVersion !== ASSET_SCHEMA_VERSION || !Array.isArray(manifest.assets)) {
    throw new Error(`Asset manifest has an unsupported schema at ${manifestPath}`);
  }
  if (options.expectedManifestSha256 && actualManifestSha256 !== options.expectedManifestSha256) {
    throw new Error("Asset manifest digest no longer matches the approved snapshot");
  }
  // A tampered harvestFile fails loading instead of quietly becoming a
  // missing field, which would turn a covered image map into an uncovered one.
  for (const asset of manifest.assets) {
    if (asset.harvestFile !== undefined && !isValidHarvestFile(asset.harvestFile)) {
      throw new Error(`Asset manifest contains an invalid harvestFile for ${String(asset.file)}`);
    }
    // Same reason for the mockup contract: a tampered screens list or render
    // instruction must fail loading, not quietly become a mockup nobody rendered.
    if (declaredScreenNames(asset).problems.length) {
      throw new Error(`Asset manifest contains an invalid screens list for ${String(asset.file)}`);
    }
    if (asset.render !== undefined && !isValidMockupRender(asset.render)) {
      throw new Error(`Asset manifest contains an invalid render declaration for ${String(asset.file)}`);
    }
  }
  let approvedReviewRequiredFiles = new Set<string>();
  if (options.requireApproval) {
    let approval: AssetApproval;
    try {
      approval = JSON.parse(
        (await readRegularFile(
          path.join(assetsDir, ASSET_APPROVAL_NAME),
          MAX_CONTROL_FILE_BYTES,
        )).toString("utf8"),
      ) as AssetApproval;
    } catch (error) {
      throw new Error(`Asset approval is missing or invalid: ${String(error)}`);
    }
    if (
      approval.schemaVersion !== ASSET_SCHEMA_VERSION ||
      approval.manifestSha256 !== actualManifestSha256 ||
      !Array.isArray(approval.approvedReviewRequiredFiles)
    ) {
      throw new Error("Asset approval digest does not match the current manifest");
    }
    const expectedReviewFiles = manifest.assets
      .filter((asset) => asset.status === "review-required")
      .map((asset) => asset.file)
      .sort();
    const recordedReviewFiles = [...approval.approvedReviewRequiredFiles].sort();
    if (JSON.stringify(recordedReviewFiles) !== JSON.stringify(expectedReviewFiles)) {
      throw new Error("Asset approval does not cover the current review-required files exactly");
    }
    approvedReviewRequiredFiles = new Set(recordedReviewFiles);
  }

  const approved = manifest.assets.filter(
    (asset) => asset.status === "approved" || approvedReviewRequiredFiles.has(asset.file),
  );
  for (const asset of approved) {
    if (!isSafeAssetFileName(asset.file)) throw new Error(`Asset manifest contains an unsafe file path: ${asset.file}`);
    const filePath = path.join(assetsDir, asset.file);
    const actualHash = await fileSha256(filePath).catch(() => "");
    if (!actualHash || actualHash !== asset.sha256) {
      throw new Error(`Approved asset changed after validation: ${asset.file}`);
    }
  }
  return approved.sort((left, right) => left.file.localeCompare(right.file));
}

export async function readApprovedAssetFiles(
  assetsDir: string,
  options: ReadApprovedAssetOptions = {},
): Promise<string[]> {
  return (await readApprovedAssetEntries(assetsDir, options)).map((asset) => asset.file);
}

/** The placement of the assets that passed the existing approval mechanism, and only those. */
export async function readApprovedAssetPlacement(
  assetsDir: string,
  expectedManifestSha256: string,
): Promise<AssetPlacement> {
  return classifyAssetPlacement(
    await readApprovedAssetEntries(assetsDir, { requireApproval: true, expectedManifestSha256 }),
  );
}

export async function readSealedApprovedAssetHashes(
  assetsDir: string,
  expectedManifestSha256?: string,
): Promise<Record<string, string>> {
  if (!expectedManifestSha256) return {};
  try {
    const entries = await readApprovedAssetEntries(assetsDir, {
      requireApproval: true,
      expectedManifestSha256,
    });
    return Object.fromEntries(entries.map((entry) => [entry.file, entry.sha256]));
  } catch {
    return {};
  }
}

export async function readAssetManifestSha256(assetsDir: string): Promise<string> {
  return fileSha256(path.join(assetsDir, ASSET_MANIFEST_NAME));
}

/**
 * One mockup a design brief requires, as the manifest checks read it: the name
 * the operator sees and the placement that identifies the asset. Structural on
 * purpose, so this module never has to import designBriefJson, which imports
 * this one (DesignBriefRequiredMockup satisfies it).
 */
export interface RequiredMockupRow {
  name: string;
  section: string;
  proves: string;
}

/**
 * The manifest entries that stand for one required mockup: a mockup placed in
 * the section the brief approved, proving the claim it approved. The name of
 * the required row is a label for the operator, never a file name, so the
 * placement fields are what identify the asset.
 */
export function mockupEntriesFor(
  assets: readonly AssetManifestEntry[],
  row: RequiredMockupRow,
): AssetManifestEntry[] {
  const section = row.section.trim();
  const proves = row.proves.trim();
  return assets.filter(
    (asset) => asset.kind === "mockup"
      && (asset.section ?? "").trim() === section
      && (asset.proves ?? "").trim() === proves,
  );
}

/**
 * The required mockups a sealed manifest does not carry, by name. A mockup
 * counts only while it is still headed for the page: approved, or marked for
 * the human look the gate itself resolves. Used by the 5.2 decide route, which
 * refuses an approval while one is missing, exactly as it refuses an unsealed
 * placement map.
 */
export function missingRequiredMockups(
  assets: readonly AssetManifestEntry[],
  required: readonly RequiredMockupRow[],
): string[] {
  // Distinct entries, for the same reason the coverage check demands them.
  const taken = new Set<string>();
  const missing: string[] = [];
  for (const row of required) {
    const match = mockupEntriesFor(assets, row).find(
      (asset) => !taken.has(asset.file)
        && (asset.status === "approved" || asset.status === "review-required"),
    );
    if (match) taken.add(match.file);
    else missing.push(row.name);
  }
  return missing;
}

/**
 * The manifest exactly as the contact sheet showed it: bound to the digest the
 * gate recorded, and read without sealing anything. The 5.2 gate reads it to
 * answer questions about the attempt (Task 16's required mockups) before it
 * decides whether an approval may be written at all.
 */
export async function readAssetManifestDraft(
  assetsDir: string,
  expectedDraftSha256: string,
): Promise<AssetManifest> {
  await assertManagedDirectory(assetsDir, path.dirname(assetsDir));
  const manifestPath = path.join(assetsDir, ASSET_MANIFEST_NAME);
  const manifestBuffer = await readRegularFile(manifestPath, MAX_CONTROL_FILE_BYTES);
  if (bufferSha256(manifestBuffer) !== expectedDraftSha256) {
    throw new Error("Asset manifest changed after the contact sheet was generated");
  }
  const manifest = JSON.parse(manifestBuffer.toString("utf8")) as AssetManifest;
  if (manifest.schemaVersion !== ASSET_SCHEMA_VERSION || !Array.isArray(manifest.assets)) {
    throw new Error(`Asset manifest has an unsupported schema at ${manifestPath}`);
  }
  return manifest;
}

export async function approveReviewRequiredAssets(
  assetsDir: string,
  expectedDraftSha256: string,
  contactSheet?: { file: string; sha256: string },
): Promise<{ manifest: AssetManifest; manifestSha256: string }> {
  await assertManagedDirectory(assetsDir, path.dirname(assetsDir));
  const verifyContactSheet = async (): Promise<void> => {
    if (!contactSheet) return;
    if (!/^contact-sheet-[A-Za-z0-9-]+\.html$/.test(contactSheet.file)) {
      throw new Error("Contact sheet filename is not safe");
    }
    const bytes = await readRegularFile(
      path.join(assetsDir, contactSheet.file),
      MAX_CONTACT_SHEET_BYTES,
    );
    if (bufferSha256(bytes) !== contactSheet.sha256) {
      throw new Error("Contact sheet changed after it was shown for approval");
    }
  };
  await verifyContactSheet();
  const manifest = await readAssetManifestDraft(assetsDir, expectedDraftSha256);
  const draftSha256 = expectedDraftSha256;
  for (const asset of manifest.assets.filter((entry) => entry.status !== "rejected")) {
    if (!isSafeAssetFileName(asset.file)) throw new Error(`Asset manifest contains an unsafe file path: ${asset.file}`);
    const actualHash = await fileSha256(path.join(assetsDir, asset.file)).catch(() => "");
    if (!actualHash || actualHash !== asset.sha256) {
      throw new Error(`Asset changed before human approval: ${asset.file}`);
    }
  }
  const manifestSha256 = draftSha256;
  const approval: AssetApproval = {
    schemaVersion: ASSET_SCHEMA_VERSION,
    approvedAt: new Date().toISOString(),
    manifestSha256,
    approvedReviewRequiredFiles: manifest.assets
      .filter((asset) => asset.status === "review-required")
      .map((asset) => asset.file)
      .sort(),
    contactSheetFile: contactSheet?.file,
    contactSheetSha256: contactSheet?.sha256,
  };
  await atomicWriteJson(path.join(assetsDir, ASSET_APPROVAL_NAME), approval);
  try {
    await verifyContactSheet();
  } catch (error) {
    await fs.rm(path.join(assetsDir, ASSET_APPROVAL_NAME), { force: true });
    throw error;
  }
  return { manifest, manifestSha256 };
}

export async function copyApprovedAssets(
  assetsDir: string,
  destinationDir: string,
  expectedManifestSha256: string,
): Promise<Record<string, string>> {
  await assertManagedDirectory(assetsDir, path.dirname(assetsDir));
  const assets = await readApprovedAssetEntries(assetsDir, {
    requireApproval: true,
    expectedManifestSha256,
  });
  await ensureManagedDirectory(destinationDir, path.dirname(destinationDir));
  const expected: Record<string, string> = {};
  for (const asset of assets) {
    const source = path.join(assetsDir, asset.file);
    const destination = path.join(destinationDir, asset.file);
    const temporary = path.join(destinationDir, `.${asset.file}.${randomUUID()}.tmp`);
    try {
      const sourceBytes = await readRegularFile(source);
      if (bufferSha256(sourceBytes) !== asset.sha256) {
        throw new Error(`Approved asset changed while it was copied: ${asset.file}`);
      }
      await fs.writeFile(temporary, sourceBytes, { flag: "wx", mode: 0o600 });
      await fs.rename(temporary, destination);
      expected[asset.file] = asset.sha256;
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
  }
  return expected;
}

async function listFilesRecursive(root: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (current: string): Promise<void> => {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile() || entry.isSymbolicLink()) {
        files.push(path.relative(root, absolute).split(path.sep).join("/"));
      }
    }
  };
  await walk(root);
  return files.sort();
}

export async function verifyPreparedAssets(
  destinationDir: string,
  expected: Record<string, string>,
): Promise<void> {
  await assertManagedDirectory(destinationDir, path.dirname(destinationDir));
  const actual = await listFilesRecursive(destinationDir);
  for (const relative of actual) {
    const expectedHash = expected[relative];
    if (!expectedHash) throw new Error(`Builder introduced an unapproved image: ${relative}`);
    const absolute = path.join(destinationDir, relative);
    const stat = await fs.lstat(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Builder replaced an approved image with a non-regular file: ${relative}`);
    }
    const actualHash = await fileSha256(absolute);
    if (actualHash !== expectedHash) throw new Error(`Builder changed an approved image: ${relative}`);
  }
  for (const [relative, expectedHash] of Object.entries(expected)) {
    if (!actual.includes(relative)) throw new Error(`Builder removed an approved image: ${relative}`);
    const actualHash = await fileSha256(path.join(destinationDir, relative));
    if (actualHash !== expectedHash) throw new Error(`Builder changed an approved image: ${relative}`);
  }
}
