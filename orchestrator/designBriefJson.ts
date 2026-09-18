import {
  isValidHarvestFile,
  MAX_PLACEMENT_PROVES_CHARS,
  MAX_PLACEMENT_SECTION_CHARS,
  MOCKUP_RENDER_BASES,
} from "./assetQuality";
import type { MockupRenderBase } from "./assetQuality";
import { MAX_MOCKUP_NAME_CHARS, MAX_REQUIRED_MOCKUPS } from "@/lib/mockupContract";

/**
 * The machine-readable half of a direct-run design brief (stage 3): the
 * ```json block the art director writes under the prose. Stage 3's critic
 * loop and stage 5.2 both read it, so they cannot disagree about what the
 * approved image map says.
 */
export interface DesignBriefImageMapRow {
  harvestFile: string;
  section: string;
  proves: string;
}

/**
 * One device mockup the page type's assets section requires: the name the 5.2
 * plan declares it under, where it goes, what it proves, and which packaged
 * base frame it is composited onto.
 */
export interface DesignBriefRequiredMockup {
  name: string;
  section: string;
  proves: string;
  base: MockupRenderBase;
}

const MOCKUP_NAME_RE = new RegExp(`^[A-Za-z0-9._-]{1,${MAX_MOCKUP_NAME_CHARS}}$`);

export interface DesignBriefJson {
  /** Rows a 5.2 asset could actually cover: three strings within the placement limits. */
  imageMap: DesignBriefImageMapRow[];
  /** Rows that were dropped. Even one of them makes the whole map unusable for 5.2. */
  invalidRows: number;
  /** Why rows were dropped, in the operator's words, without repeats. */
  invalidReasons: string[];
  /** Every harvestFile the map names, valid row or not, for the stage 3 critic hint. */
  harvestFiles: string[];
  /**
   * The mockups the page type's template requires, or undefined when the
   * brief declares none and when the list it declares is unusable. A half
   * list is never returned: a page type that requires mockups stops on it.
   */
  requiredMockups?: DesignBriefRequiredMockup[];
  colors?: unknown;
  playbook?: unknown;
  specialElements?: unknown;
  hardBans?: unknown;
  vibe?: unknown;
}

const REASON_FIELDS = "שדה חסר או ריק";
const REASON_HARVEST_FILE = "שם קובץ בקציר לא תקין";
const REASON_SECTION = `סקציה ארוכה מ-${MAX_PLACEMENT_SECTION_CHARS} תווים`;
const REASON_PROVES = `טענה ארוכה מ-${MAX_PLACEMENT_PROVES_CHARS} תווים`;

/** A row, or the reason it can never become an asset in the sheet. */
function readRow(
  row: { harvestFile?: unknown; section?: unknown; proves?: unknown },
): { row: DesignBriefImageMapRow } | { reason: string } {
  const { harvestFile, section, proves } = row;
  if (typeof harvestFile !== "string" || typeof section !== "string" || typeof proves !== "string") {
    return { reason: REASON_FIELDS };
  }
  if (!harvestFile.trim() || !section.trim() || !proves.trim()) return { reason: REASON_FIELDS };
  if (!isValidHarvestFile(harvestFile)) return { reason: REASON_HARVEST_FILE };
  // The same limits placementFields enforces: a longer value could never be
  // matched by any asset, so the row is unusable rather than merely ugly.
  if (section.trim().length > MAX_PLACEMENT_SECTION_CHARS) return { reason: REASON_SECTION };
  if (proves.trim().length > MAX_PLACEMENT_PROVES_CHARS) return { reason: REASON_PROVES };
  return { row: { harvestFile, section, proves } };
}

/**
 * The whole requiredMockups list, or undefined. Applied whole or not at all,
 * for the same reason the image map is: a list quietly shortened by one row
 * is a mockup nobody would ever notice missing.
 */
function readRequiredMockups(value: unknown): DesignBriefRequiredMockup[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (value.length > MAX_REQUIRED_MOCKUPS) return undefined;
  const mockups: DesignBriefRequiredMockup[] = [];
  const names = new Set<string>();
  for (const raw of value as unknown[]) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const { name, section, proves, base } = raw as Record<string, unknown>;
    if (typeof name !== "string" || !MOCKUP_NAME_RE.test(name) || names.has(name)) return undefined;
    if (typeof section !== "string" || typeof proves !== "string") return undefined;
    if (!section.trim() || !proves.trim()) return undefined;
    if (section.trim().length > MAX_PLACEMENT_SECTION_CHARS) return undefined;
    if (proves.trim().length > MAX_PLACEMENT_PROVES_CHARS) return undefined;
    if (!(MOCKUP_RENDER_BASES as readonly unknown[]).includes(base)) return undefined;
    names.add(name);
    mockups.push({ name, section, proves, base: base as MockupRenderBase });
  }
  return mockups;
}

/**
 * null when there is no ```json block, when it does not parse, or when it
 * carries no imageMap array. A brief whose map vanished is never read as a
 * valid empty map: that difference is what lets stage 5.2 stop instead of
 * building a page with no approved images.
 */
export function parseDesignBriefJson(text: string): DesignBriefJson | null {
  const block = text.match(/```json\s*([\s\S]*?)```/)?.[1];
  if (!block) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(block) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.imageMap)) return null;

  const imageMap: DesignBriefImageMapRow[] = [];
  const harvestFiles: string[] = [];
  const invalidReasons: string[] = [];
  let invalidRows = 0;
  for (const raw of parsed.imageMap as unknown[]) {
    const row = (raw && typeof raw === "object" ? raw : {}) as {
      harvestFile?: unknown;
      section?: unknown;
      proves?: unknown;
    };
    if (typeof row.harvestFile === "string" && row.harvestFile) harvestFiles.push(row.harvestFile);
    const read = readRow(row);
    if ("row" in read) {
      imageMap.push(read.row);
      continue;
    }
    invalidRows += 1;
    if (!invalidReasons.includes(read.reason)) invalidReasons.push(read.reason);
  }
  const requiredMockups = readRequiredMockups(parsed.requiredMockups);
  return {
    imageMap,
    invalidRows,
    invalidReasons,
    harvestFiles,
    ...(requiredMockups ? { requiredMockups } : {}),
    colors: parsed.colors,
    playbook: parsed.playbook,
    specialElements: parsed.specialElements,
    hardBans: parsed.hardBans,
    vibe: parsed.vibe,
  };
}
