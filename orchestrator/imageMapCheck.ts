import type { ImageMapCheck, ImageMapWidth } from "@/types";
import type { AssetPlacement, MappedAsset } from "./assetQuality";
import { approvedAssetBasename, hashPageSourceManifest } from "./pagePostflight";

export const IMAGE_MAP_WIDTHS: readonly ImageMapWidth[] = [390, 1280];

export interface ProbedImage {
  kind: "img" | "background";
  url: string;
  loaded: boolean;
  visible: boolean;
  width: number;
  height: number;
  areaRatio: number;
}

export type VisibilityProbe = Record<"390" | "1280", ProbedImage[]>;

export function missingMappedImages(
  probe: VisibilityProbe,
  mapped: readonly MappedAsset[],
  page: { pageUrl: string; slug: string },
): ImageMapCheck["missing"] {
  const files = new Set(mapped.map((asset) => asset.file));
  const shownByWidth = new Map<ImageMapWidth, Set<string>>();
  for (const width of IMAGE_MAP_WIDTHS) {
    const shown = new Set<string>();
    for (const image of probe[String(width) as "390" | "1280"] ?? []) {
      if (!image.loaded || !image.visible) continue;
      const basename = approvedAssetBasename(image.url, page.pageUrl, page.slug, files);
      if (basename) shown.add(basename);
    }
    shownByWidth.set(width, shown);
  }
  return mapped.flatMap((asset) => {
    const widths = IMAGE_MAP_WIDTHS.filter((width) => !shownByWidth.get(width)!.has(asset.file));
    return widths.length ? [{ file: asset.file, section: asset.section, proves: asset.proves, widths: [...widths] }] : [];
  });
}

export async function runImageMapCheck(args: {
  pageUrl: string;
  slug: string;
  placement: AssetPlacement;
  pageSourceHashes: Record<string, string>;
  assetManifestSha256: string;
  attemptStartedAt: string;
  probe: (url: string) => Promise<VisibilityProbe>;
}): Promise<ImageMapCheck> {
  const binding = {
    schemaVersion: 1 as const,
    mappedCount: args.placement.mapped.length,
    attemptStartedAt: args.attemptStartedAt,
    assetManifestSha256: args.assetManifestSha256,
    pageSourceManifestSha256: hashPageSourceManifest(args.pageSourceHashes),
  };
  if (args.placement.mapped.length === 0) {
    return { ...binding, passed: true, missing: [], checkedAt: new Date().toISOString() };
  }
  try {
    const probe = await args.probe(args.pageUrl);
    const missing = missingMappedImages(probe, args.placement.mapped, args);
    return { ...binding, passed: missing.length === 0, missing, checkedAt: new Date().toISOString() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...binding,
      passed: false,
      missing: [],
      failure: `בדיקת הנראות לא הושלמה: ${message}`.slice(0, 500),
      checkedAt: new Date().toISOString(),
    };
  }
}

export interface DesertMeasurement {
  pageScreens: number;
  worstScreens: number;
  atScreen: number;
}

export const DESERT_WARNING_SCREENS = 3.0;

export function renderDesertWarning(measurement: DesertMeasurement, threshold = DESERT_WARNING_SCREENS): string {
  if (measurement.worstScreens < threshold) return "";
  return `הקטע הארוך ביותר בלי תמונה או כפתור ב-390px: ${measurement.worstScreens} מסכים, החל ממסך ${measurement.atScreen} מתוך ${measurement.pageScreens}. זו אזהרה בלבד ואינה חוסם.`;
}

/** A failed or skipped measurement is its own state, never shown as "fine". */
export type DesertStatus = { kind: "ok" } | { kind: "warning"; text: string } | { kind: "incomplete"; reason: string };

export function renderDesertSummary(status: DesertStatus): string {
  if (status.kind === "ok") return "תקין";
  if (status.kind === "warning") return status.text;
  return `⚠️ המדידה לא הושלמה: ${status.reason}`;
}

/** Null when the check belongs to this attempt, this asset manifest and this page source; otherwise why not. */
export function imageMapCheckIsCurrent(
  check: ImageMapCheck | undefined,
  current: { attemptStartedAt?: string; assetManifestSha256?: string; pageSourceHashes?: Record<string, string> },
): string | null {
  if (!check) return "אין תוצאת בדיקת מפת תמונות";
  if (!current.attemptStartedAt || check.attemptStartedAt !== current.attemptStartedAt) {
    return "בדיקת המפה שייכת לניסיון אחר";
  }
  if (!current.assetManifestSha256 || check.assetManifestSha256 !== current.assetManifestSha256) {
    return "בדיקת המפה נעשתה מול מניפסט נכסים אחר";
  }
  if (!current.pageSourceHashes || check.pageSourceManifestSha256 !== hashPageSourceManifest(current.pageSourceHashes)) {
    return "הדף השתנה אחרי בדיקת המפה";
  }
  return null;
}
