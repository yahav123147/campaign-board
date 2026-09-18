import { stripToolMarkup } from "./designStandard";
import type { CriticRubricName } from "./stageRegistry";

export interface CriticRubric {
  name: CriticRubricName;
  thresholds: { avg: number; min: number };
  dimensions: string[];
  /** The rubric text without its frontmatter, injected into the critic prompt. */
  text: string;
}

export interface CriticFix { quote: string; rule: string; fix: string }

export type CriticVerdict =
  | { kind: "approve" | "revise" | "block"; scores: Record<string, number>; avg: number; min: number; fixes: CriticFix[]; reason?: string }
  | { kind: "unreadable" };

const DEFAULT_THRESHOLDS = { avg: 8, min: 7 };

export function parseCriticRubric(name: CriticRubricName, raw: string): CriticRubric {
  // Normalise CRLF/CR to bare LF first: every regex below anchors on "\n",
  // and a rubric saved on Windows would otherwise never match the frontmatter
  // fence, silently keep the default thresholds, and leak the whole
  // frontmatter block into rubric.text (and from there into the critic prompt).
  let text = raw.replace(/\r\n?/g, "\n").trim();
  const thresholds = { ...DEFAULT_THRESHOLDS };
  const fm = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (fm) {
    for (const line of fm[1]!.split("\n")) {
      const m = line.match(/^(avg|min):\s*([0-9]+(?:\.[0-9]+)?)\s*$/);
      if (m) thresholds[m[1] as "avg" | "min"] = Number(m[2]);
    }
    text = text.slice(fm[0].length).trim();
  }
  const section = text.match(/##\s*ממדים\s*\n([\s\S]*?)(?:\n##\s|$)/);
  const dimensions = (section?.[1] ?? "")
    .split("\n")
    .map((l) => l.match(/^\s*\d+\.\s+(.+?)\s*$/)?.[1])
    .filter((d): d is string => !!d);
  if (!dimensions.length) throw new Error(`הרובריקה ${name} חייבת סעיף "## ממדים" עם רשימה ממוספרת`);
  const seen = new Set<string>();
  for (const dim of dimensions) {
    if (seen.has(dim)) throw new Error(`הרובריקה ${name} מכילה ממד כפול: "${dim}"`);
    seen.add(dim);
  }
  return { name, thresholds, dimensions, text };
}

export function renderRubricForCritic(rubric: CriticRubric): string {
  return `## הרובריקה שאתה שופט לפיה (ציון 1 עד 10 לכל ממד; מעבר = ממוצע ≥ ${rubric.thresholds.avg} וגם מינימום ≥ ${rubric.thresholds.min})\n\n${rubric.text}`;
}

function round2(n: number): number { return Math.round(n * 100) / 100; }

export function parseCriticVerdict(text: string, rubric: CriticRubric): CriticVerdict {
  const clean = stripToolMarkup(text);
  const m = clean.match(/<critic>\s*([\s\S]*?)\s*<\/critic>/);
  if (!m) return { kind: "unreadable" };
  let parsed: unknown;
  try { parsed = JSON.parse(m[1]!); } catch { return { kind: "unreadable" }; }
  if (!parsed || typeof parsed !== "object") return { kind: "unreadable" };
  const obj = parsed as Record<string, unknown>;
  const rawScores = obj.scores;
  if (!rawScores || typeof rawScores !== "object") return { kind: "unreadable" };
  const scores: Record<string, number> = {};
  for (const dim of rubric.dimensions) {
    const v = (rawScores as Record<string, unknown>)[dim];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 1 || v > 10) return { kind: "unreadable" };
    scores[dim] = v;
  }
  const values = Object.values(scores);
  const avg = round2(values.reduce((a, b) => a + b, 0) / values.length);
  const min = Math.min(...values);
  const fixes: CriticFix[] = Array.isArray(obj.fixes)
    ? obj.fixes.filter((f): f is CriticFix => !!f && typeof f === "object"
        && typeof (f as CriticFix).quote === "string" && typeof (f as CriticFix).rule === "string" && typeof (f as CriticFix).fix === "string")
    : [];
  // The declared verdict is validated, never inferred: a missing or unknown
  // value is unreadable (the critic did not vote), a REVISE stands even when
  // the scores clear the thresholds (the critic saw something the numbers do
  // not show), and an APPROVE below the thresholds becomes REVISE (the numbers
  // saw something the critic waved through). Same rule as the 15.09 verdict fix.
  const declared = typeof obj.verdict === "string" ? obj.verdict.trim().toUpperCase() : "";
  if (declared !== "APPROVE" && declared !== "REVISE" && declared !== "BLOCK") return { kind: "unreadable" };
  if (declared === "BLOCK") {
    return { kind: "block", scores, avg, min, fixes, reason: typeof obj.reason === "string" ? obj.reason : undefined };
  }
  const passes = avg >= rubric.thresholds.avg && min >= rubric.thresholds.min;
  if (declared === "REVISE") return { kind: "revise", scores, avg, min, fixes };
  return { kind: passes ? "approve" : "revise", scores, avg, min, fixes };
}
