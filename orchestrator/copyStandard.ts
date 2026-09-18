import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import type { ClientProfile } from "@/config/clientProfile";
import type { CriticRubricName } from "./stageRegistry";

const MAX_COPY_STANDARD_BYTES = 256 * 1024;

/**
 * Prepended to a section that failed the skill-compliance audit twice. The
 * express auto-approver refuses gates whose output carries this marker, so an
 * uncompliant section always reaches a human.
 */
export const SKILL_AUDIT_FAILED_MARKER = "⚠️ ביקורת ציות לסקיל: לא עובר";

/**
 * Prepended to a section whose compliance audit never produced a readable
 * verdict, even after one re-ask. This is not a failure: nobody found a
 * violation. But the section is unaudited, so express leaves it to a human.
 */
export const SKILL_AUDIT_SKIPPED_MARKER = "⚠️ ביקורת ציות לסקיל: לא רצה (המבקר לא החזיר פסק דין)";

/** Prepended by runCriticLoop when the critic hit a hard ban. Express leaves it to a human. */
export const CRITIC_BLOCKED_MARKER = "⛔ ביקורת: חסימה";
/** Prepended by runCriticLoop when maxRounds passed without APPROVE. Express leaves it to a human. */
export const CRITIC_UNRESOLVED_MARKER = "⚠️ ביקורת: לא עבר אחרי";

/** True for output the express auto-approver must leave to a human: a failed or an unaudited section. */
export function auditBlocksExpress(content: unknown): boolean {
  return typeof content === "string"
    && [SKILL_AUDIT_FAILED_MARKER, SKILL_AUDIT_SKIPPED_MARKER, CRITIC_BLOCKED_MARKER, CRITIC_UNRESOLVED_MARKER]
      .some((marker) => content.startsWith(marker));
}

/**
 * The craft standard for stage 4.
 *
 * Stage 5 already works this way: its critics read the design standard off the
 * disk at critique time, so the rules cannot drift from whatever a prompt was
 * written against months ago. Copy had no equivalent, which left three critics
 * judging a headline with nothing but their own taste and left the writer with
 * a one paragraph instruction. This closes that gap with the same contract.
 *
 * It is read at run time, never copied into a prompt template, and it is
 * optional: a tenant that configures no standard keeps the previous behaviour.
 */
export async function readCopyStandard(profile?: ClientProfile): Promise<string> {
  return readStandardAt(profile?.copy?.standardPath);
}

/**
 * The ads craft standard for stage 7. Sales-page structure rules do not apply
 * to a 125-character primary text, so ads get their own standard; a tenant
 * that configured none keeps the previous behaviour and stage 7 reads the
 * page standard (F88, 01.09.2026).
 */
export async function readAdsCopyStandard(profile?: ClientProfile): Promise<string> {
  return readStandardAt(profile?.copy?.adsStandardPath ?? profile?.copy?.standardPath);
}

/** The creative craft standard for stage 7.5. Empty when the tenant configured none. */
export async function readCreativeStandard(profile?: ClientProfile): Promise<string> {
  return readStandardAt(profile?.creative?.standardPath);
}

/**
 * The board's own rulebook, without the embedded copy skill that follows it.
 *
 * Stage 4 needs the full methodology, but the strategy synthesis only needs the
 * rules it keeps breaking (the big-promise formula, singular address, voice).
 * Injecting the whole file there would bury them in a methodology the
 * synthesizer is not writing against (F109).
 */
export function copyStandardBase(standard: string): string {
  const marker = standard.indexOf("\n# הסקיל:");
  const base = marker === -1 ? standard : standard.slice(0, marker);
  return base.trim();
}

export async function readStandardAt(standardPath: string | undefined): Promise<string> {
  if (!standardPath) return "";

  const linkStat = await fs.lstat(standardPath).catch(() => undefined);
  if (!linkStat?.isFile() || linkStat.isSymbolicLink()) {
    throw new Error("The configured copy standard is missing or is not a regular file");
  }

  const handle = await fs.open(standardPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > MAX_COPY_STANDARD_BYTES) {
      throw new Error("The configured copy standard changed or exceeded its size limit");
    }
    const text = (await handle.readFile("utf8")).trim();
    if (!text) throw new Error("The configured copy standard is empty");
    return text;
  } finally {
    await handle.close();
  }
}

const DEFAULT_CRITICS_DIR = path.join(process.cwd(), "config", "standards", "critics");

/** The live rubric for a critic, or the packaged default. Never empty: a critic without a rubric is a critic with only taste. */
export async function readCriticRubric(profile: ClientProfile | undefined, name: CriticRubricName): Promise<string> {
  const live = profile?.copy?.critics?.rubricsDir ? path.join(profile.copy.critics.rubricsDir, `${name}.md`) : undefined;
  if (live) return readStandardAt(live);
  return readStandardAt(path.join(DEFAULT_CRITICS_DIR, `${name}.default.md`));
}

/** The design-strategy standard (the design-strategist skill) stage 3 writes against. */
export async function readDesignStrategyStandard(profile: ClientProfile | undefined): Promise<string> {
  return readStandardAt(profile?.copy?.critics?.designStrategyStandardPath ?? path.join(DEFAULT_CRITICS_DIR, "design-strategy-standard.default.md"));
}

/**
 * Render the standard for a prompt. A tenant with no standard configured gets
 * an empty string rather than a placeholder, so nothing is added to the prompt
 * at all and the previous behaviour is preserved exactly.
 */
export function renderCopyStandard(standard: string, heading: string): string {
  if (!standard) return "";
  return `\n\n---\n\n## ${heading}\n\n${standard}`;
}
