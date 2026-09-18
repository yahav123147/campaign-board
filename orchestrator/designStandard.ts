import path from "node:path";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import type { ClientProfile } from "@/config/clientProfile";

const MAX_DESIGN_STANDARD_BYTES = 512 * 1024;

/**
 * The sections a critic needs. The skill also teaches how to *build* (tokens,
 * animation, section library); a critic judging a rendered page does not need
 * those, and they would only dilute the rules he is meant to enforce.
 */
const WANTED = [
  { from: /^## .*HARD RULES/m, to: /^## Purpose/m },
  { from: /^## Checklist Before Delivery/m, to: /^## Reference Screenshots/m },
  { from: /^## Validated patterns/m, to: null },
];

function slice(text: string, from: RegExp, to: RegExp | null): string {
  const start = text.search(from);
  if (start === -1) return "";
  const rest = text.slice(start);
  if (!to) return rest.trim();
  const relativeEnd = rest.slice(1).search(to);
  return (relativeEnd === -1 ? rest : rest.slice(0, relativeEnd + 1)).trim();
}

/** Pull the judging sections out of the configured design standard's text. */
export function extractStandard(skillText: string): string {
  if (!skillText.trim()) return "";
  return WANTED.map(({ from, to }) => slice(skillText, from, to))
    .filter(Boolean)
    .join("\n\n");
}

export async function resolveContainedWorkspaceFile(
  workspace: string,
  relativeFile: string,
  maxBytes = MAX_DESIGN_STANDARD_BYTES,
): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new RangeError("Workspace file limit must be a positive integer");
  }
  const rootPath = path.resolve(workspace);
  const rootStat = await fs.lstat(rootPath);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("The configured landing workspace is missing or unsafe");
  }
  const root = await fs.realpath(rootPath);
  const candidatePath = path.resolve(root, ...relativeFile.split("/"));
  if (!pathIsWithin(candidatePath, root)) {
    throw new Error("The configured workspace file escaped the landing workspace");
  }
  const candidateStat = await fs.lstat(candidatePath);
  if (
    !candidateStat.isFile() ||
    candidateStat.isSymbolicLink() ||
    candidateStat.size > maxBytes
  ) {
    throw new Error("The configured workspace file is missing, unsafe, or too large");
  }
  const candidate = await fs.realpath(candidatePath);
  if (!pathIsWithin(candidate, root)) {
    throw new Error("The configured workspace file resolves outside the landing workspace");
  }
  return candidate;
}

/** Read the configured design standard at critique time so it cannot drift. */
export async function readDesignStandard(
  landingWorkspace: string,
  relativeFile: string,
): Promise<string> {
  const skillPath = await resolveContainedWorkspaceFile(
    landingWorkspace,
    relativeFile,
    MAX_DESIGN_STANDARD_BYTES,
  );
  const handle = await fs.open(skillPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > MAX_DESIGN_STANDARD_BYTES) {
      throw new Error("The configured design standard changed or exceeded its size limit");
    }
    const standard = extractStandard(await handle.readFile("utf8"));
    if (!standard) throw new Error("The configured design standard contains no judging rules");
    return standard;
  } finally {
    await handle.close();
  }
}

/**
 * Read the WHOLE configured design skill, for the page builder. The critics
 * get the judging slices; the builder needs everything the skill teaches
 * (tokens, section library, typography, validated patterns) or it falls back
 * to a default playbook and the page comes out generic (finding F73,
 * 31.08.2026: no section hooks, flat type hierarchy).
 */
export async function readFullDesignStandard(
  landingWorkspace: string,
  relativeFile: string,
): Promise<string> {
  const skillPath = await resolveContainedWorkspaceFile(
    landingWorkspace,
    relativeFile,
    MAX_DESIGN_STANDARD_BYTES,
  );
  const handle = await fs.open(skillPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > MAX_DESIGN_STANDARD_BYTES) {
      throw new Error("The configured design standard changed or exceeded its size limit");
    }
    const text = (await handle.readFile("utf8")).trim();
    if (!text) throw new Error("The configured design standard is empty");
    return text;
  } finally {
    await handle.close();
  }
}

export type Verdict = "pass" | "fail" | "unreadable";

/**
 * A critic that runs with no tools sometimes answers with a tool call anyway
 * (an `<invoke name="Bash">` block, a heredoc, `<parameter>` lines) instead of
 * a verdict (seen twice on 14.09.2026). Those lines are never a judgment, so
 * they are removed before the verdict line is looked for: a verdict that only
 * appears inside a leaked command is not a verdict.
 */
export function stripToolMarkup(text: string): string {
  const withoutBlocks = text
    // A tool-call block, closed or cut off mid-way (a truncated block runs to the end).
    .replace(/<invoke\b[\s\S]*?(?:<\/invoke>|$)/g, "")
    .replace(/<function_calls>[\s\S]*?(?:<\/function_calls>|$)/g, "")
    // Fenced code, closed or unclosed: a verdict typed inside a code sample is not a verdict.
    .replace(/```[\s\S]*?(?:```|$)/g, "")
    // A shell heredoc body (`cat <<'EOF' ... EOF`), closed or unclosed.
    .replace(/<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?[^\n]*\n[\s\S]*?(?:^\s*\1\s*$|$(?![\s\S]))/gm, "");
  return withoutBlocks
    .split("\n")
    .filter((line) => !/^\s*<\/?(invoke|parameter|function_calls|function_results)\b/.test(line))
    .join("\n");
}

/**
 * A critic opens with `פסק דין: עובר` or `פסק דין: לא עובר`. The line may sit
 * after a short preamble; it is the first line that names a verdict.
 * No such line, or one without a readable value, is `unreadable`: the critic
 * did not vote. Callers decide what that means (retry, leave to a human), and
 * must never present it as a real "לא עובר" with an invented violation list.
 */
export function readVerdict(critique: string): Verdict {
  const line = stripToolMarkup(critique).split("\n").find((l) => l.includes("פסק דין"));
  if (!line) return "unreadable";
  const value = line.split(":").slice(1).join(":").trim();
  if (!value) return "unreadable";
  if (/^לא\s+עובר/.test(value)) return "fail";
  if (/^עובר/.test(value)) return "pass";
  return "unreadable";
}

/** Boolean view for gating: only an explicit pass waves a page through. */
export function parseVerdict(critique: string): boolean {
  return readVerdict(critique) === "pass";
}

export interface ReferenceProject {
  /** A live page that sets the bar for this build. */
  url?: string;
  /** A local project folder: design-brief.json, assets/, an existing page. */
  dir?: string;
}

/**
 * The brand brief ends with a machine-readable reference block. It is how
 * 5.1 hands the builder an existing project instead of making it start blind:
 *
 *   REFERENCE_URL: https://…   (or none)
 *   REFERENCE_DIR: /absolute/path/to/project    (or none)
 */
export function parseReference(brandBrief: string): ReferenceProject {
  const read = (key: string): string | undefined => {
    const line = brandBrief
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.startsWith(`${key}:`));
    if (!line) return undefined;
    const value = line.slice(key.length + 1).trim();
    if (!value || value.toLowerCase() === "none") return undefined;
    // Only accept a real URL or absolute path, never prose that mentions the key.
    if (key === "REFERENCE_URL") return /^https?:\/\/\S+$/.test(value) ? value : undefined;
    return value.startsWith("/") ? value : undefined;
  };

  const ref: ReferenceProject = {};
  const url = read("REFERENCE_URL");
  const dir = read("REFERENCE_DIR");
  if (url) ref.url = url;
  if (dir) ref.dir = dir;
  return ref;
}

function pathIsWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function urlMatchesPrefix(target: URL, prefix: URL): boolean {
  if (target.origin !== prefix.origin) return false;
  const basePath = prefix.pathname.length > 1 ? prefix.pathname.replace(/\/+$/, "") : "/";
  if (basePath === "/") return true;
  return target.pathname === basePath || target.pathname.startsWith(`${basePath}/`);
}

/**
 * Model output is never authority for a URL or local path. A reference is
 * usable only when the immutable client profile explicitly allowlists it.
 */
export async function authorizeReferenceProject(
  reference: ReferenceProject,
  profile: ClientProfile,
): Promise<ReferenceProject> {
  const authorized: ReferenceProject = {};

  if (reference.url) {
    let target: URL;
    try {
      target = new URL(reference.url);
    } catch {
      throw new Error("The brand brief declared an invalid reference URL");
    }
    if (
      (target.protocol !== "https:" && target.protocol !== "http:") ||
      target.username ||
      target.password ||
      target.search ||
      target.hash
    ) {
      throw new Error("The reference URL must be a credential-free HTTP(S) URL without query or fragment");
    }
    const prefixes = profile.landing?.referenceUrlPrefixes ?? [];
    const allowed = prefixes.some((value) => {
      try {
        return urlMatchesPrefix(target, new URL(value));
      } catch {
        return false;
      }
    });
    if (!allowed) {
      throw new Error("The reference URL is not allowlisted by this run's client profile");
    }
    authorized.url = target.href;
  }

  if (reference.dir) {
    const candidatePath = path.resolve(reference.dir);
    const candidateStat = await fs.lstat(candidatePath).catch(() => undefined);
    if (!candidateStat?.isDirectory() || candidateStat.isSymbolicLink()) {
      throw new Error("The reference directory is missing, not a directory, or a symbolic link");
    }
    const candidate = await fs.realpath(candidatePath);
    let allowed = false;
    for (const configuredRoot of profile.landing?.referenceRoots ?? []) {
      const rootPath = path.resolve(configuredRoot);
      const rootStat = await fs.lstat(rootPath).catch(() => undefined);
      if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) continue;
      const root = await fs.realpath(rootPath);
      if (pathIsWithin(candidate, root)) {
        allowed = true;
        break;
      }
    }
    if (!allowed) {
      throw new Error("The reference directory is not contained by an allowlisted client root");
    }
    authorized.dir = candidate;
  }

  return authorized;
}
