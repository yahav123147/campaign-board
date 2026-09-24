import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mockupBrowserExecutablePath } from "../scripts/browser-executable.mjs";
import { runsRoot } from "@/lib/runStore";
import type { MockupRenderReceipt, MockupRenderReceiptEntry } from "@/types";
import {
  MAX_SCREEN_DATA_BYTES,
  MAX_SCREEN_HTML_BYTES,
  MOCKUP_RENDER_BASES,
  REGION_ID_RE,
  SCREEN_NAME_RE,
} from "@/lib/mockupContract";
import {
  MAX_RENDER_REGIONS,
  MAX_SCREEN_EDGE_PX,
  RENDER_INVALID_PROBLEM,
  RENDER_MAP_UNDECLARED_PROBLEM,
  SCREENS_DIR,
  SCREEN_SIZES_NAME,
  isSafeAssetFileName,
  isValidMockupRender,
  type AssetPlanEntry,
  type MockupRender,
  type MockupRenderBase,
} from "./assetQuality";
import {
  hasExited,
  spawnSupervised,
  startSupervisedChrome,
  terminateAndWait,
  type OwnedChrome,
} from "./liveProofBrowser";
import { TrackedScriptTimeoutError, runTrackedScript } from "./trackedScript";

/**
 * Device mockups, rendered by the orchestrator (Task 13).
 *
 * The 5.2 agent writes HTML screens under `<assetsDir>/screens/` and declares
 * them on its mockup entries; the browser belongs to the orchestrator, because
 * the agent's sandbox cannot start one and because a rendered mockup is a
 * finished asset, not agent output. Here the screens are checked against the
 * render boundaries, rendered to PNG inside a Chrome this module owns from
 * launch to reaping, and composited onto a packaged base frame.
 *
 * The screens are treated as static, untrusted content throughout: the static
 * scan below refuses anything that would execute or fetch, the render script
 * disables script execution and aborts every request that is not the screen
 * file itself or a data: URI, and neither fence stands in for the other.
 *
 * The regions cache lives with the run data, never next to the base frame:
 * the packaged bases sit in a read-only directory in a client installation, so
 * detect_screens.py is told explicitly where to write its label map and its
 * regions file. The cache directory is keyed by the base's sha256, and the
 * regions file records that sha256 as well, so replacing a base frame never
 * reuses the previous frame's regions.
 */

/**
 * The two screen budgets live in lib/mockupContract.ts with the rest of the
 * contract, because the 5.2 instructions have to state them in the agent's
 * terms and orchestrator/stageRegistry.ts must not pull this module (and its
 * browser supervision) in to read a number. Re-exported here so the renderer
 * stays the one module a caller needs.
 */
export { MAX_SCREEN_DATA_BYTES, MAX_SCREEN_HTML_BYTES };

export const SCREEN_FILE_PROBLEM = "מסך חסר או שאינו קובץ רגיל";
export const SCREENS_DIR_PROBLEM = "תיקיית המסכים אינה תיקייה רגילה";
export const SCREEN_TOO_LARGE_PROBLEM = "קובץ המסך גדול מהמותר";
export const SCREEN_SIZE_PROBLEM = "sizes.json לא מגדיר מידות תקינות למסך";
export const SCREEN_SCRIPT_PROBLEM = "המסך מכיל תגית script";
export const SCREEN_EVENT_ATTRIBUTE_PROBLEM = "המסך מכיל מאפיין אירוע";
export const SCREEN_JAVASCRIPT_URL_PROBLEM = "המסך מכיל כתובת javascript:";
export const SCREEN_EXTERNAL_REFERENCE_PROBLEM = "המסך מפנה לכתובת חיצונית";
export const SCREEN_DATA_BUDGET_PROBLEM = "נפח התמונות המוטמעות במסך חורג מהמותר";
export const SCREEN_ASSET_NAME_PROBLEM = "הפניית asset אינה שם קובץ תמונה בטוח בתיקיית הנכסים";
export const SCREEN_ASSET_FILE_PROBLEM = "הפניית asset מצביעה על קובץ שאינו קיים בתיקיית הנכסים";
export const SCREEN_NAME_PROBLEM = "שם מסך לא תקין";
export const ENTRY_FILE_PROBLEM = "שם קובץ המוקאפ אינו שם יחסי ובטוח";

const SCRIPT_RE = /<script/i;
// HTML accepts "/" as an attribute separator too, so <div/onclick="…"> must
// not slip past the static fence.
const EVENT_ATTRIBUTE_RE = /[\s/]on[a-z]+\s*=/i;
const JAVASCRIPT_URL_RE = /javascript:/i;
/**
 * A reference the browser would actually load: an attribute or a stylesheet
 * pointing at an address off this machine. A bare address in the page text is
 * not a reference, and a screen may well show one as copy.
 */
const EXTERNAL_REFERENCE_RES = [
  /(?:src|srcset|href|poster|action|formaction|data|ping)\s*=\s*["']?\s*(?:https?:)?\/\//i,
  /url\(\s*["']?\s*(?:https?:)?\/\//i,
  /@import\s+["']\s*(?:https?:)?\/\//i,
];
const DATA_URI_RE = /data:[^"')\s]+/gi;
/**
 * How a screen names an approved picture: `src="asset:portrait.webp"`, or the
 * same inside a CSS `url(asset:portrait.webp)`.
 *
 * The 5.2 agent used to base64 the presenter's portrait into every screen by
 * hand. A 25 KB payload turned each 2 KB screen into a 27 KB file that took
 * about ten minutes to write, and the acceptance run of 2026-09-16 spent its
 * whole budget on four of the eight screens it owed. The expansion belongs to
 * the renderer, which already reads both the screen and the assets folder.
 *
 * The capture is deliberately greedy up to the first delimiter: a reference
 * the rules cannot accept must be refused by name, never left in the markup as
 * an address the browser would try to resolve.
 */
const ASSET_REF_RE = /asset:([^"')\s>]*)/g;
/** The picture formats a screen may embed this way, and how they are declared. */
const ASSET_REF_MEDIA_TYPES: Readonly<Record<string, string>> = {
  ".webp": "image/webp",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

/** One screen the renderer may open, and the size it is rendered at. */
export interface ScreenSpec {
  /** The mockup entry this screen belongs to, by position in the plan. */
  index: number;
  entry: string;
  name: string;
  /** The absolute path, already resolved inside the screens folder. */
  file: string;
  /**
   * The markup the renderer actually opens: the agent's file with every
   * `asset:` reference expanded into a data: URI. The agent's own file is
   * never rewritten, because the receipt hashes it as written.
   */
  html: string;
  width: number;
  height: number;
  /**
   * Whether a region of the base frame points at this screen. An unmapped
   * screen is still checked, because it sits in the folder and a mapped screen
   * could pull it in, but nothing renders it.
   */
  mapped: boolean;
}

export interface ScreenRejection {
  /** The entry's position in the plan: two entries may name one file. */
  index: number;
  entry: string;
  reason: string;
}

export interface ScreenValidation {
  ok: ScreenSpec[];
  rejected: ScreenRejection[];
}

function reason(problem: string, screen?: string): string {
  return screen ? `${problem} (${screen})` : problem;
}

/**
 * sizes.json as the renderer reads it: a map of screen name to the viewport it
 * is rendered at. A malformed file is null, so every screen fails on it; a
 * single malformed or over-sized entry is simply absent, so only its own
 * screen fails.
 */
async function readScreenSizes(
  screensDir: string,
): Promise<ReadonlyMap<string, readonly [number, number]> | null> {
  let parsed: unknown;
  try {
    const raw = await fs.readFile(path.join(screensDir, SCREEN_SIZES_NAME), "utf8");
    parsed = JSON.parse(raw);
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

/** The static scan. Returns the problem that disqualifies the screen, if any. */
function scanScreenHtml(html: string): string | undefined {
  if (SCRIPT_RE.test(html)) return SCREEN_SCRIPT_PROBLEM;
  if (EVENT_ATTRIBUTE_RE.test(html)) return SCREEN_EVENT_ATTRIBUTE_PROBLEM;
  if (JAVASCRIPT_URL_RE.test(html)) return SCREEN_JAVASCRIPT_URL_PROBLEM;
  if (EXTERNAL_REFERENCE_RES.some((pattern) => pattern.test(html))) {
    return SCREEN_EXTERNAL_REFERENCE_PROBLEM;
  }
  return undefined;
}

function dataUriBytes(html: string): number {
  let total = 0;
  for (const match of html.matchAll(DATA_URI_RE)) total += match[0].length;
  return total;
}

/**
 * Expand every `asset:` reference in one screen into a data: URI.
 *
 * The name is held to the same rule as a file in the plan: a bare relative
 * name of a regular file directly in the assets folder, in one of the picture
 * formats a screen may embed, resolved through the filesystem so a traversal
 * and a symlink are both refused for what they really are. An unusable
 * reference is a problem, never a silent pass-through: left in the markup it
 * would reach the browser as an address to resolve.
 */
async function expandAssetReferences(
  html: string,
  assetsDir: string,
  assetsReal: string | null,
): Promise<{ html: string } | { problem: string }> {
  const names = [...new Set([...html.matchAll(ASSET_REF_RE)].map((match) => match[1] ?? ""))];
  if (!names.length) return { html };
  const expanded = new Map<string, string>();
  for (const name of names) {
    const extension = path.extname(name).toLowerCase();
    const mediaType = ASSET_REF_MEDIA_TYPES[extension];
    if (!mediaType || !isSafeAssetFileName(name)) {
      return { problem: `${SCREEN_ASSET_NAME_PROBLEM} (${name || "ריק"})` };
    }
    if (!assetsReal) return { problem: `${SCREEN_ASSET_FILE_PROBLEM} (${name})` };
    const file = path.join(assetsDir, name);
    const stat = await fs.lstat(file).catch(() => null);
    const real = await fs.realpath(file).catch(() => null);
    if (!stat?.isFile() || real !== path.join(assetsReal, name)) {
      return { problem: `${SCREEN_ASSET_FILE_PROBLEM} (${name})` };
    }
    // Read only what could still fit the budget: the budget is checked on the
    // expanded markup below, and nothing is served by holding 80 MB first.
    if (stat.size > MAX_SCREEN_DATA_BYTES) {
      return { problem: `${SCREEN_DATA_BUDGET_PROBLEM} (${name})` };
    }
    const bytes = await fs.readFile(file).catch(() => null);
    if (!bytes) return { problem: `${SCREEN_ASSET_FILE_PROBLEM} (${name})` };
    expanded.set(name, `data:${mediaType};base64,${bytes.toString("base64")}`);
  }
  return { html: html.replace(ASSET_REF_RE, (match, name: string) => expanded.get(name) ?? match) };
}

/**
 * Check every declared screen against the render boundaries. A mockup whose
 * screens are all sound contributes its screens to `ok`; a mockup with one
 * unusable screen is rejected whole, because a half-rendered device frame is
 * not a mockup. Nothing here starts a process, so a violation is refused
 * before a browser exists.
 */
export async function validateScreens(
  assetsDir: string,
  entries: readonly AssetPlanEntry[],
): Promise<ScreenValidation> {
  const screensDir = path.join(assetsDir, SCREENS_DIR);
  const sizes = await readScreenSizes(screensDir);
  const ok: ScreenSpec[] = [];
  const rejected: ScreenRejection[] = [];
  // The folder itself is resolved once: only the leaf is lstat'ed below, so a
  // symlinked screens directory would otherwise move every screen elsewhere
  // while each one still looked like a regular file in its own folder.
  const screensStat = await fs.lstat(screensDir).catch(() => null);
  const screensReal = screensStat?.isDirectory() ? await fs.realpath(screensDir).catch(() => null) : null;
  // Resolved once for the same reason: a symlinked assets folder would move
  // every `asset:` reference elsewhere while each file still looked local.
  const assetsReal = await fs.realpath(assetsDir).catch(() => null);

  for (const [index, entry] of entries.entries()) {
    const file = typeof entry.file === "string" ? entry.file : "";
    if (!isSafeAssetFileName(file)) {
      rejected.push({ index, entry: String(entry.file), reason: ENTRY_FILE_PROBLEM });
      continue;
    }
    if (!isValidMockupRender(entry.render)) {
      rejected.push({ index, entry: file, reason: RENDER_INVALID_PROBLEM });
      continue;
    }
    const declared = Array.isArray(entry.screens) ? entry.screens : [];
    if (declared.some((name) => typeof name !== "string" || !SCREEN_NAME_RE.test(name))) {
      rejected.push({ index, entry: file, reason: SCREEN_NAME_PROBLEM });
      continue;
    }
    const names = new Set(declared);
    if (Object.values(entry.render.map).some((screen) => !names.has(screen))) {
      rejected.push({ index, entry: file, reason: RENDER_MAP_UNDECLARED_PROBLEM });
      continue;
    }
    if (!screensReal) {
      rejected.push({ index, entry: file, reason: SCREENS_DIR_PROBLEM });
      continue;
    }

    const specs: ScreenSpec[] = [];
    const mapped = new Set(Object.values(entry.render.map));
    let problem: string | undefined;
    let dataBytes = 0;
    // Every declared screen is checked, not only the mapped ones: an unchecked
    // file sits in the folder the browser is allowed to read, and a mapped
    // screen can pull it in. Only the mapped ones are rendered afterwards.
    for (const name of names) {
      const screenFile = path.join(screensDir, `${name}.html`);
      const stat = await fs.lstat(screenFile).catch(() => null);
      const real = await fs.realpath(screenFile).catch(() => null);
      if (!stat?.isFile() || real !== path.join(screensReal, `${name}.html`)) {
        problem = reason(SCREEN_FILE_PROBLEM, name);
        break;
      }
      if (stat.size > MAX_SCREEN_HTML_BYTES + MAX_SCREEN_DATA_BYTES) {
        problem = reason(SCREEN_TOO_LARGE_PROBLEM, name);
        break;
      }
      const size = sizes?.get(name);
      if (!size) {
        problem = reason(SCREEN_SIZE_PROBLEM, name);
        break;
      }
      const html = await fs.readFile(screenFile, "utf8").catch(() => null);
      if (html === null) {
        problem = reason(SCREEN_FILE_PROBLEM, name);
        break;
      }
      // The markup budget is the agent's own writing, so it is counted on the
      // file as written: an `asset:` reference costs eleven characters here,
      // which is the whole point of offering it.
      if (Buffer.byteLength(html) - dataUriBytes(html) > MAX_SCREEN_HTML_BYTES) {
        problem = reason(SCREEN_TOO_LARGE_PROBLEM, name);
        break;
      }
      const resolved = await expandAssetReferences(html, assetsDir, assetsReal);
      if ("problem" in resolved) {
        problem = reason(resolved.problem, name);
        break;
      }
      // Everything after this reads the copy the browser will open: a reference
      // that expanded into something the fences refuse must be refused here.
      const found = scanScreenHtml(resolved.html);
      if (found) {
        problem = reason(found, name);
        break;
      }
      dataBytes += dataUriBytes(resolved.html);
      if (dataBytes > MAX_SCREEN_DATA_BYTES) {
        problem = reason(SCREEN_DATA_BUDGET_PROBLEM, name);
        break;
      }
      specs.push({
        index,
        entry: file,
        name,
        file: screenFile,
        html: resolved.html,
        width: size[0],
        height: size[1],
        mapped: mapped.has(name),
      });
    }
    if (problem) rejected.push({ index, entry: file, reason: problem });
    else ok.push(...specs);
  }
  return { ok, rejected };
}

/** The sha256 of a file, as the receipt records it. */
export async function fileSha256(file: string): Promise<string> {
  return createHash("sha256").update(await fs.readFile(file)).digest("hex");
}

export const RENDER_UNAVAILABLE_PROBLEM = "הרינדור לא זמין";
export const MOCKUP_BASE_MISSING_PROBLEM = "מסגרת הבסיס לא מותקנת";
export const MOCKUP_REGIONS_PROBLEM = "לא ניתן לזהות את המסכים במסגרת הבסיס";
export const MOCKUP_REGION_PROBLEM = "אזור שאינו קיים במסגרת הבסיס";
export const MOCKUP_BASE_TOO_LARGE_PROBLEM = "מסגרת הבסיס גדולה מדי לרינדור";
export const MOCKUP_SCREEN_OUTPUT_PROBLEM = "המסך לא רונדר";
export const MOCKUP_SCREEN_SIZE_PROBLEM = "מידות המסך אינן תואמות לאזור במסגרת הבסיס";
export const MOCKUP_COMPOSITE_PROBLEM = "הרכבת המוקאפ נכשלה";
export const MOCKUP_OUTPUT_MISSING_PROBLEM = "קובץ המוקאפ לא נמצא אחרי ההרכבה";

/** Where the render script leaves what it noticed about screens it rendered. */
const RENDER_NOTES_NAME = "render-notes.json";
const RENDER_CANCELLED = "רינדור המוקאפים בוטל";
const RENDER_TIMED_OUT = "רינדור המוקאפים חרג מהזמן שהוקצב";
/** The screens are rendered at twice the region size, as composite.py expects. */
const COMPOSITE_SCALE = 2;
/** The deadline of a single detection or composite of one base frame. */
const PYTHON_TIMEOUT_DEFAULT_MS = 120_000;

/**
 * A single detection or composite. It is the script's own cap, not the
 * attempt's: exceeding it costs that mockup, while the attempt's deadline
 * (`args.deadline`) is what ends the run. Overridable so a test can reach the
 * cap without waiting two minutes for it.
 */
function pythonTimeoutMs(): number {
  const override = Number(process.env.CAMPAIGN_COUNCIL_MOCKUP_PYTHON_TIMEOUT_MS);
  return Number.isFinite(override) && override > 0 ? override : PYTHON_TIMEOUT_DEFAULT_MS;
}

/**
 * The receipt shapes live in types/index.ts, because the run state carries one
 * on the 5.2 sub-task and types/ may not import from orchestrator/. They are
 * re-exported here so the renderer stays the one module a caller needs.
 */
export type { MockupRenderReceipt, MockupRenderReceiptEntry } from "@/types";

/**
 * What one render produced: the receipt itself, and the screens that passed
 * the render boundaries on the way. The accepted names are the caller's, not
 * the record's: only the screens listed here may be excused from the asset
 * folder's undeclared-file check, and runStage5Assets drops the field before
 * the receipt is stored on the sub-task.
 */
export interface MockupRenderOutcome extends MockupRenderReceipt {
  acceptedScreens: string[];
}

export interface RenderMockupsArgs {
  assetsDir: string;
  attemptId: string;
  entries: readonly AssetPlanEntry[];
  /** Where the base frames are installed. Defaults to the packaged ones. */
  basesDir?: string;
  /** The interpreter resolvePython() picked. */
  python: string;
  signal?: AbortSignal;
  deadline: number;
}

/**
 * The render script, resolved from this repository because that is where
 * Playwright is installed. Overridable so lifecycle tests can inject a fake.
 */
export function renderScreensScriptPath(): string {
  return process.env.CAMPAIGN_COUNCIL_RENDER_SCREENS_PATH
    || path.join(process.cwd(), "vendor", "course-mockups", "render_screens.mjs");
}

/** The base frames shipped with the Board, when the profile names no other directory. */
export function packagedMockupBasesDir(): string {
  return path.join(process.cwd(), "config", "standards", "mockups");
}

export function mockupBaseFile(basesDir: string, base: MockupRenderBase): string {
  return path.join(basesDir, `base-${base}.default.png`);
}

/**
 * Where the detected regions are cached: with the run data, never next to the
 * base frame, because a client installation keeps the packaged files read
 * only. Each base frame gets a directory of its own, named after its sha256.
 */
export function mockupCacheRoot(): string {
  const override = process.env.CAMPAIGN_COUNCIL_MOCKUP_CACHE_DIR?.trim();
  if (override) return path.resolve(override);
  return path.join(path.dirname(runsRoot()), "cache", "mockups");
}

/** Where the throwaway profile and the render scratch directory are created. */
function mockupTempParent(): string {
  return process.env.CAMPAIGN_COUNCIL_MOCKUP_TEMP_PARENT?.trim() || os.tmpdir();
}

function vendoredScript(name: string): string {
  return path.join(process.cwd(), "vendor", "course-mockups", name);
}

/** One screen of a base frame, in base pixels, as detect_screens.py found it. */
interface BaseRegion {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

interface BaseFrame {
  file: string;
  sha256: string;
  regions: Map<number, BaseRegion>;
  labels: string;
}

interface RegionsFile {
  baseSha256?: unknown;
  labels?: unknown;
  regions?: unknown;
}

async function readRegionsFile(file: string, sha256: string): Promise<BaseFrame["regions"] | null> {
  let parsed: RegionsFile;
  try {
    parsed = JSON.parse(await fs.readFile(file, "utf8")) as RegionsFile;
  } catch {
    return null;
  }
  if (parsed.baseSha256 !== sha256 || !Array.isArray(parsed.regions)) return null;
  const regions = new Map<number, BaseRegion>();
  for (const value of parsed.regions) {
    const region = value as { id?: unknown; x0?: unknown; x1?: unknown; y0?: unknown; y1?: unknown };
    const numbers = [region.id, region.x0, region.x1, region.y0, region.y1];
    if (!numbers.every((number) => Number.isInteger(number))) continue;
    regions.set(region.id as number, {
      x0: region.x0 as number,
      x1: region.x1 as number,
      y0: region.y0 as number,
      y1: region.y1 as number,
    });
  }
  return regions;
}

/** The size a screen has to be rendered at to fill a region exactly. */
export function screenSizeForRegion(region: BaseRegion): readonly [number, number] {
  return [(region.x1 - region.x0 + 1) * COMPOSITE_SCALE, (region.y1 - region.y0 + 1) * COMPOSITE_SCALE];
}

/**
 * The frame cannot be rendered on in this installation, and why.
 *
 * A region's exact screen is twice its bounding box, and a screen over
 * MAX_SCREEN_EDGE_PX is refused everywhere the size is read (sizes.json, the
 * boundaries). Real device photography crosses that line easily, so the frame
 * is reported unusable, by region and by size, instead of the prompt
 * advertising a size the validator then silently drops and the sheet blaming
 * the agent for a frame the operator installed.
 */
function baseTooLargeProblem(regions: BaseFrame["regions"]): string | undefined {
  const over = [...regions.entries()]
    .sort(([left], [right]) => left - right)
    .map(([id, region]) => ({ id, size: screenSizeForRegion(region) }))
    .filter(({ size }) => size[0] > MAX_SCREEN_EDGE_PX || size[1] > MAX_SCREEN_EDGE_PX);
  if (!over.length) return undefined;
  const listed = over.map(({ id, size }) => `אזור ${id} דורש מסך ${size[0]}x${size[1]}`).join(", ");
  return `${MOCKUP_BASE_TOO_LARGE_PROBLEM}: ${listed}, מעל התקרה של ${MAX_SCREEN_EDGE_PX} פיקסלים לצלע`;
}

/**
 * The base frame's regions, detected once per frame and reused afterwards.
 * The cache is keyed by the frame's sha256 and the cached file repeats it, so
 * a replaced frame is detected again rather than composited onto stale
 * regions.
 */
/**
 * What loading a base frame actually needs. Narrower than RenderMockupsArgs so
 * the prompt builder, which has no assets folder and no plan, can ask for the
 * same regions the renderer will use.
 */
interface BaseFrameArgs {
  basesDir?: string;
  python: string;
  signal?: AbortSignal;
  deadline: number;
}

/** A frame that cannot be used, and whether anything the agent does could help. */
interface BaseFrameProblem {
  error: string;
  /** The frame was read and is simply too big: only the operator can fix it. */
  unusable?: boolean;
}

async function loadBaseFrame(
  base: MockupRenderBase,
  args: BaseFrameArgs,
): Promise<BaseFrame | BaseFrameProblem> {
  const file = mockupBaseFile(args.basesDir ?? packagedMockupBasesDir(), base);
  const stat = await fs.stat(file).catch(() => null);
  if (!stat?.isFile()) return { error: `${MOCKUP_BASE_MISSING_PROBLEM}: ${file}` };
  const sha256 = await fileSha256(file);
  const cacheDir = path.join(mockupCacheRoot(), sha256);
  const regionsFile = path.join(cacheDir, "regions.json");
  const labels = path.join(cacheDir, "labels.npy");

  let regions = await readRegionsFile(regionsFile, sha256);
  if (regions && !(await fs.stat(labels).catch(() => null))?.isFile()) regions = null;
  if (!regions) {
    // Detection writes into a directory of its own and the finished pair is
    // moved into place in one step, so a second run never reads a half-written
    // label map for the same frame.
    await fs.mkdir(mockupCacheRoot(), { recursive: true });
    const staging = await fs.mkdtemp(path.join(mockupCacheRoot(), "detecting-"));
    try {
      await runTrackedScript({
        command: args.python,
        args: [
          vendoredScript("detect_screens.py"),
          file,
          "--labels",
          path.join(staging, "labels.npy"),
          "--regions",
          path.join(staging, "regions.json"),
        ],
        cwd: process.cwd(),
        signal: args.signal,
        timeoutMs: remainingMs(args.deadline, pythonTimeoutMs()),
        label: "detect_screens.py",
      });
      regions = await readRegionsFile(path.join(staging, "regions.json"), sha256);
      if (!regions?.size) return { error: MOCKUP_REGIONS_PROBLEM };
      // The cached document names where its label map ended up, not where it
      // was written.
      const document = JSON.parse(await fs.readFile(path.join(staging, "regions.json"), "utf8")) as RegionsFile;
      document.labels = labels;
      await fs.writeFile(path.join(staging, "regions.json"), JSON.stringify(document, null, 2));
      await fs.rename(staging, cacheDir).catch(async (error: NodeJS.ErrnoException) => {
        // Another run finished first: its cache is the same frame, by name.
        if (!(await readRegionsFile(regionsFile, sha256))?.size) throw error;
      });
    } catch (error) {
      throwIfCancelled(args.signal, error);
      return { error: `${MOCKUP_REGIONS_PROBLEM}: ${messageOf(error)}` };
    } finally {
      await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
    }
  }
  const tooLarge = baseTooLargeProblem(regions);
  if (tooLarge) return { error: tooLarge, unusable: true };
  return { file, sha256, regions, labels };
}

/** One region of a base frame, and the exact screen size it needs. */
export interface MockupBaseRegionSize {
  /** The region id, as detect_screens.py numbered it. */
  id: number;
  width: number;
  height: number;
}

/** One installed base frame, as the 5.2 prompt describes it to the agent. */
export interface MockupBaseDescription {
  base: MockupRenderBase;
  regions: MockupBaseRegionSize[];
  /** Why the frame cannot be used. Present only when `regions` is empty. */
  error?: string;
  /**
   * The frame was read and this installation cannot render on it: a region
   * needs a screen over MAX_SCREEN_EDGE_PX. Unlike an unreadable frame,
   * nothing the agent writes will make it work, so the prompt tells the agent
   * not to declare a mockup on it at all.
   */
  unusable?: boolean;
}

/**
 * One described frame per base file and content hash, for the life of the
 * process.
 *
 * The on-disk regions cache already spares a second detection of a frame that
 * detected successfully, but a frame that FAILED detection (no numpy in the
 * interpreter, a corrupt PNG) has nothing cached and would pay
 * DESCRIBE_TIMEOUT_MS again on every 5.2 attempt. The key carries the frame's
 * sha256, so a replaced frame is described again rather than served stale.
 */
const describedBases = new Map<string, MockupBaseDescription>();

/**
 * The detection deadline for one base frame at prompt-build time: the same
 * 120 s the render path allows for one script. Two frames means a cold,
 * broken installation can hold the prompt for up to four minutes once, and the
 * memo above means only once per process.
 */
const DESCRIBE_TIMEOUT_MS = PYTHON_TIMEOUT_DEFAULT_MS;

/** Drops the memo, so a test can describe the same frame twice. */
export function __resetMockupBaseMemoForTests(): void {
  describedBases.clear();
}

/**
 * The installed base frames and the screen size each of their regions needs,
 * for the 5.2 prompt.
 *
 * It runs the same detection the renderer runs and fills the same cache, so
 * the sizes the agent is told are the sizes the renderer will enforce, and the
 * region ids it is told are the keys `render.map` accepts. A frame that cannot
 * be read here is reported and never guessed: the prompt says so, 5.2 still
 * runs, and the renderer rejects what does not fit with its own reason.
 */
export async function describeMockupBases(
  basesDir: string,
  python: string,
  signal?: AbortSignal,
): Promise<MockupBaseDescription[]> {
  const descriptions: MockupBaseDescription[] = [];
  for (const base of MOCKUP_RENDER_BASES) {
    const file = mockupBaseFile(basesDir, base);
    // A frame that is not installed is not memoised: the check costs nothing
    // and an operator who installs the frame should not have to restart.
    const stat = await fs.stat(file).catch(() => null);
    if (!stat?.isFile()) {
      descriptions.push({ base, regions: [], error: `${MOCKUP_BASE_MISSING_PROBLEM}: ${file}` });
      continue;
    }
    // Hashing the frame is a read and can fail (EACCES, a bad sector), so it
    // sits inside the guarded region with the detection: an installed frame
    // this process cannot read degrades to the unreadable line like any other,
    // it never fails the prompt build.
    let key: string | undefined;
    let frame: BaseFrame | BaseFrameProblem;
    try {
      key = `${file}:${await fileSha256(file)}`;
      const memo = describedBases.get(key);
      if (memo) {
        descriptions.push(memo);
        continue;
      }
      frame = await loadBaseFrame(base, {
        basesDir,
        python,
        signal,
        deadline: Date.now() + DESCRIBE_TIMEOUT_MS,
      });
    } catch (error) {
      // A cancelled run is the run's failure and stops here; anything else is
      // one unreadable frame, never a prompt that fails to build.
      if (signal?.aborted) throw error;
      frame = { error: messageOf(error) };
    }
    const described: MockupBaseDescription = "error" in frame
      ? { base, regions: [], error: frame.error, ...(frame.unusable ? { unusable: true } : {}) }
      : {
        base,
        regions: [...frame.regions.entries()]
          .sort(([a], [b]) => a - b)
          .map(([id, region]) => {
            const [width, height] = screenSizeForRegion(region);
            return { id, width, height };
          }),
      };
    // A cancelled run never reaches here, so nothing half read is remembered.
    // A frame whose hash could not be read has no key to remember it by, and
    // is simply described again next time.
    if (key) describedBases.set(key, described);
    descriptions.push(described);
  }
  return descriptions;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function remainingMs(deadline: number, cap: number): number {
  return Math.max(1_000, Math.min(cap, deadline - Date.now()));
}

/**
 * A cancelled run is the run's own failure, never a rejected mockup: it is
 * rethrown so the caller stops, instead of being written into the receipt.
 */
function throwIfCancelled(signal: AbortSignal | undefined, error: unknown): void {
  if (signal?.aborted) throw new Error(RENDER_CANCELLED);
  if (error instanceof TrackedScriptTimeoutError) throw new Error(RENDER_TIMED_OUT);
}

/**
 * Run the render script against an endpoint this module owns. Like the
 * Instagram capture, it never settles on a timer: cancellation and the
 * deadline request termination and then wait for the close event, so the
 * caller can delete the profile knowing nothing is still writing to it.
 */
async function runScreenRender(args: {
  endpoint: string;
  screensDir: string;
  sizesJson: string;
  outDir: string;
  signal?: AbortSignal;
  deadline: number;
}): Promise<{ error: string } | undefined> {
  if (args.signal?.aborted) throw new Error(RENDER_CANCELLED);
  const { child, closed, stderr } = spawnSupervised(
    process.execPath,
    [renderScreensScriptPath(), args.endpoint, args.screensDir, args.sizesJson, args.outDir],
    process.cwd(),
    "render_screens.mjs",
  );

  let failure: Error | undefined;
  const stop = (error: Error) => {
    failure ??= error;
    if (!hasExited(child)) void terminateAndWait(child, closed);
  };
  const onAbort = () => stop(new Error(RENDER_CANCELLED));
  const timer = setTimeout(() => stop(new Error(RENDER_TIMED_OUT)), Math.max(0, args.deadline - Date.now()));
  timer.unref();
  args.signal?.addEventListener("abort", onAbort, { once: true });
  child.once("error", (error) => stop(new Error(`render_screens.mjs לא רץ: ${error.message}`)));

  try {
    const code = await closed;
    if (failure) throw failure;
    if (code !== 0) return { error: stderr().trim() || `render_screens.mjs: קוד יציאה ${code}` };
    return undefined;
  } finally {
    clearTimeout(timer);
    args.signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Render every mockup the plan declares and composite it onto its base frame.
 *
 * The result is a receipt, not a throw: a screen that broke a boundary, a
 * render that failed and a composite that failed each reject their own mockup
 * and leave the rest of the run alone, and a browser that refuses to start
 * rejects them all with "הרינדור לא זמין". Only the run's own failures, the
 * cancellation and the deadline, reject the promise, and they do it after the
 * browser tree is reaped and the profile is gone.
 */
export async function renderMockups(args: RenderMockupsArgs): Promise<MockupRenderOutcome> {
  if (args.signal?.aborted) throw new Error(RENDER_CANCELLED);
  const screensDir = path.join(args.assetsDir, SCREENS_DIR);
  // One row per plan entry, by position: two entries may name the same file,
  // and rejecting one of them must never reject the other.
  const rows: MockupRenderReceiptEntry[] = [];
  for (const entry of args.entries) {
    rows.push({
      file: String(entry.file),
      screensSha256: await screenHashes(screensDir, entry),
      status: "rejected",
      reason: RENDER_UNAVAILABLE_PROBLEM,
    });
  }
  const reject = (index: number, reason: string) => {
    const row = rows[index];
    if (row) {
      row.status = "rejected";
      row.reason = reason;
      delete row.outputSha256;
    }
  };

  const boundaries = await validateScreens(args.assetsDir, args.entries);
  for (const rejection of boundaries.rejected) reject(rejection.index, rejection.reason);

  // The base frames and their regions are resolved before the browser starts:
  // a mockup that maps a region its frame does not offer, or a screen that
  // would not fill its region, is refused without anything being launched.
  const baseSha256: Record<string, string> = {};
  const frames = new Map<MockupRenderBase, BaseFrame>();
  const renderable: { index: number; frame: BaseFrame; render: MockupRender; screens: ScreenSpec[] }[] = [];
  const byEntry = new Map<number, ScreenSpec[]>();
  for (const spec of boundaries.ok) {
    byEntry.set(spec.index, [...(byEntry.get(spec.index) ?? []), spec]);
  }
  // Each declared frame is resolved once, before any per-entry decision: a
  // frame this installation cannot render on has to outrank what the
  // boundaries said about an entry's screens, which were written to the sizes
  // that very frame demanded. The detection itself is cached per frame hash
  // and the 5.2 prompt already filled that cache, so this costs no new python.
  const frameProblems = new Map<MockupRenderBase, BaseFrameProblem>();
  for (const entry of args.entries) {
    if (!isValidMockupRender(entry.render)) continue;
    const base = entry.render.base;
    if (frames.has(base) || frameProblems.has(base)) continue;
    const loaded = await loadBaseFrame(base, args);
    if ("error" in loaded) {
      frameProblems.set(base, loaded);
      continue;
    }
    frames.set(base, loaded);
    baseSha256[base] = loaded.sha256;
  }
  for (const [index, entry] of args.entries.entries()) {
    if (!isValidMockupRender(entry.render)) continue;
    const base = entry.render.base;
    const problem = frameProblems.get(base);
    // A frame over the render ceiling is the operator's installation, not the
    // agent's plan: every mockup on it is rejected with the frame's own
    // reason, whatever its screens looked like.
    if (problem?.unusable) {
      reject(index, problem.error);
      continue;
    }
    const mapped = (byEntry.get(index) ?? []).filter((screen) => screen.mapped);
    if (!mapped.length) continue;
    if (problem) {
      reject(index, problem.error);
      continue;
    }
    const frame = frames.get(base)!;
    // A region id reaches composite.py as an integer, so anything else is
    // refused here with the precise reason instead of failing the composite.
    const unknown = Object.keys(entry.render.map).filter(
      (regionId) => !REGION_ID_RE.test(regionId) || !frame.regions.has(Number(regionId)),
    );
    if (unknown.length) {
      reject(index, `${MOCKUP_REGION_PROBLEM}: ${unknown.join(", ")}`);
      continue;
    }
    // A screen smaller than its region leaves the rest of the device screen
    // black, and composite.py would still exit 0. The renderer is the only
    // place that holds both numbers, so it is the place to refuse.
    const mismatched = Object.entries(entry.render.map)
      .map(([regionId, name]) => {
        const expected = screenSizeForRegion(frame.regions.get(Number(regionId))!);
        const screen = mapped.find((candidate) => candidate.name === name);
        if (screen && screen.width === expected[0] && screen.height === expected[1]) return undefined;
        return `${name} ${expected[0]}x${expected[1]}`;
      })
      .filter((note): note is string => note !== undefined);
    if (mismatched.length) {
      reject(index, `${MOCKUP_SCREEN_SIZE_PROBLEM}: ${mismatched.join(", ")}`);
      continue;
    }
    renderable.push({ index, frame, render: entry.render, screens: mapped });
  }

  const warnings: string[] = [];
  const receipt = (): MockupRenderOutcome => ({
    schemaVersion: 1,
    attemptId: args.attemptId,
    baseSha256,
    mockups: rows,
    renderedAt: new Date().toISOString(),
    acceptedScreens: boundaries.ok.map((screen) => screen.name),
    ...(warnings.length ? { warnings } : {}),
  });
  // Nothing left to render: no browser is started at all.
  if (!renderable.length) return receipt();

  const screens = renderable.flatMap(({ screens: owned }) => owned);
  let workDir: string | undefined;
  let profileDir: string | undefined;
  let chrome: OwnedChrome | undefined;
  let failure: Error | undefined;
  try {
    // Both directories are created inside the try, so the first one is removed
    // even when the second cannot be created.
    workDir = await fs.mkdtemp(path.join(mockupTempParent(), "council-mockup-render-"));
    await fs.chmod(workDir, 0o700);
    profileDir = await fs.mkdtemp(path.join(mockupTempParent(), "council-mockup-profile-"));
    await fs.chmod(profileDir, 0o700);
    const outDir = path.join(workDir, "png");
    await fs.mkdir(outDir);
    // The browser opens a copy of the screens, never the agent's folder: the
    // copy is where every `asset:` reference is already a data: URI, and the
    // agent's own file has to stay byte for byte what the receipt hashed.
    const renderScreensDir = path.join(workDir, SCREENS_DIR);
    await fs.mkdir(renderScreensDir);
    for (const screen of screens) {
      await fs.writeFile(path.join(renderScreensDir, `${screen.name}.html`), screen.html);
    }
    const sizesJson = path.join(workDir, "sizes.json");
    // Only the screens that passed the boundaries are named, so the script
    // never opens anything else that happens to sit in the screens folder.
    await fs.writeFile(
      sizesJson,
      JSON.stringify(Object.fromEntries(screens.map((screen) => [screen.name, [screen.width, screen.height]]))),
    );

    let unavailable = false;
    let renderError: string | undefined;
    try {
      // The profile is empty on purpose: the screens are local files, and no
      // session of the operator's has any business inside this browser.
      chrome = await startSupervisedChrome({
        executablePath: await mockupBrowserExecutablePath(),
        headless: true,
        profileDir,
        signal: args.signal,
        deadline: args.deadline,
        label: "chrome (mockups)",
      });
    } catch {
      // A browser that refuses to start is an operational failure, not a bad
      // plan: every declared mockup is rejected and the run reaches the sheet.
      // The run's own failures still reject, wherever they land.
      if (args.signal?.aborted) throw new Error(RENDER_CANCELLED);
      if (Date.now() > args.deadline) throw new Error(RENDER_TIMED_OUT);
      unavailable = true;
    }
    if (chrome) {
      renderError = (await runScreenRender({
        endpoint: chrome.endpoint,
        screensDir: renderScreensDir,
        sizesJson,
        outDir,
        signal: args.signal,
        deadline: args.deadline,
      }))?.error;
    }

    const notes = await readRenderNotes(path.join(outDir, RENDER_NOTES_NAME));
    for (const { index, frame, render, screens: owned } of renderable) {
      const file = rows[index]!.file;
      if (unavailable) {
        reject(index, RENDER_UNAVAILABLE_PROBLEM);
        continue;
      }
      const own = owned.map((screen) => screen.name);
      const carried = own.flatMap((name) => (notes[name] ?? []).map((line) => `${name}: ${line}`));
      if (carried.length) rows[index]!.notes = carried;
      const out = path.join(args.assetsDir, file);
      const pairs = Object.entries(render.map);
      // A failing screen costs its own mockup and no other: what decides is
      // which pictures are actually there, not the exit code of the batch.
      const absent: string[] = [];
      for (const [, name] of pairs) {
        const png = path.join(outDir, `${name}.png`);
        if (!(await fs.stat(png).catch(() => null))?.isFile()) absent.push(name);
      }
      if (absent.length) {
        // Only the lines that name this mockup's own screens: the script's
        // stderr covers the whole batch, and another mockup's blocked address
        // has no business on this row of the sheet.
        reject(index, [`${MOCKUP_SCREEN_OUTPUT_PROBLEM}: ${absent.join(", ")}`, linesFor(own, renderError)]
          .filter(Boolean)
          .join("; "));
        continue;
      }
      try {
        await runTrackedScript({
          command: args.python,
          args: [
            vendoredScript("composite.py"),
            frame.file,
            out,
            "--scale",
            String(COMPOSITE_SCALE),
            "--labels",
            frame.labels,
            "--map",
            ...pairs.map(([regionId, name]) => `${regionId}=${path.join(outDir, `${name}.png`)}`),
          ],
          cwd: process.cwd(),
          signal: args.signal,
          timeoutMs: remainingMs(args.deadline, pythonTimeoutMs()),
          label: "composite.py",
        });
      } catch (error) {
        if (args.signal?.aborted) throw new Error(RENDER_CANCELLED);
        // composite.py's own cap is this mockup's failure, like any other
        // composite failure, and the rest of the plan still renders. Only the
        // attempt's deadline, which belongs to the whole render, ends the run.
        if (error instanceof TrackedScriptTimeoutError && Date.now() >= args.deadline) {
          throw new Error(RENDER_TIMED_OUT);
        }
        reject(index, `${MOCKUP_COMPOSITE_PROBLEM}: ${messageOf(error)}`);
        continue;
      }
      // The row is marked ok only once the bytes are in hand: a composite that
      // exited 0 over an output that is not there is this mockup's failure,
      // never the whole render's, and a row without its digest could never be
      // matched to the file anyway.
      const row = rows[index]!;
      let outputSha256: string;
      try {
        outputSha256 = await fileSha256(out);
      } catch (error) {
        reject(index, `${MOCKUP_OUTPUT_MISSING_PROBLEM}: ${messageOf(error)}`);
        continue;
      }
      row.status = "ok";
      delete row.reason;
      row.outputSha256 = outputSha256;
    }
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  } finally {
    // Cleanup does not observe the signal: a cancelled run still has to leave
    // no browser, no render process and no directory behind. Every step runs
    // whatever the previous one did, and a cleanup failure is reported beside
    // the run's real failure instead of replacing it.
    const cleanup: string[] = [];
    await chrome?.closeAndWait().catch((error) => {
      cleanup.push(`הדפדפן לא נסגר: ${messageOf(error)}`);
    });
    if (profileDir) {
      await fs.rm(profileDir, { recursive: true, force: true }).catch((error) => {
        cleanup.push(`לא ניתן למחוק את פרופיל הביניים ${profileDir}: ${messageOf(error)}`);
      });
    }
    if (workDir) {
      await fs.rm(workDir, { recursive: true, force: true }).catch((error) => {
        cleanup.push(`לא ניתן למחוק את תיקיית הרינדור ${workDir}: ${messageOf(error)}`);
      });
    }
    // A leftover directory is never worth discarding a finished run: the
    // mockups are already written into the assets folder, and a receipt nobody
    // receives cannot be acted on. It rides along as a warning, and only a run
    // that has no receipt to return, a cancellation or the deadline, still
    // throws, carrying the note with it.
    if (cleanup.length) {
      const note = cleanup.join("; ");
      if (failure) failure = new Error(`${failure.message}; ${note}`);
      else warnings.push(note);
    }
  }

  if (failure) throw failure;
  return receipt();
}

/**
 * The render script's per-screen notes, if it left any. A missing or malformed
 * sidecar is simply no notes: it is a report, not a result.
 */
async function readRenderNotes(file: string): Promise<Record<string, string[]>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const notes: Record<string, string[]> = {};
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!SCREEN_NAME_RE.test(name) || !Array.isArray(value)) continue;
    const lines = value.filter((line): line is string => typeof line === "string");
    if (lines.length) notes[name] = lines;
  }
  return notes;
}

/**
 * The lines of the script's output that name one of these screens. Every line
 * it prints starts with "[<screen>] "; a message that names no screen at all
 * (the script failed before the loop) belongs to whoever is asking.
 */
function linesFor(screens: readonly string[], stderr: string | undefined): string {
  if (!stderr) return "";
  const lines = stderr.split("\n").map((line) => line.trim()).filter(Boolean);
  const own = lines.filter((line) => screens.some((name) => line.startsWith(`[${name}] `)));
  return (own.length ? own : lines).join("; ");
}

/**
 * The sha256 of every screen file the entry declared and that exists, up to the
 * contract's ceiling.
 *
 * The receipt is written into the run state, whose validator refuses a hash
 * record over 512 entries and fails the whole save, silently, for the rest of
 * the run. An entry declaring more screens than the plan allows is rejected
 * anyway, so nothing is lost by hashing only as many as the contract permits,
 * and the receipt can never be the record that stops the run from persisting.
 */
async function screenHashes(
  screensDir: string,
  entry: AssetPlanEntry,
): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  const declared = [...new Set(Array.isArray(entry.screens) ? entry.screens : [])]
    .slice(0, MAX_RENDER_REGIONS);
  for (const name of declared) {
    if (typeof name !== "string" || !SCREEN_NAME_RE.test(name)) continue;
    const file = path.join(screensDir, `${name}.html`);
    const stat = await fs.lstat(file).catch(() => null);
    if (stat?.isFile()) hashes[name] = await fileSha256(file);
  }
  return hashes;
}
