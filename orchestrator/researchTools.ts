/**
 * The two tools a research turn is allowed to reach the open web with.
 *
 * `--tools` only decides which tools exist for a turn. Permission is decided
 * separately, and under the default permission mode a headless `claude -p`
 * turn cannot answer a prompt, so an unlisted tool is refused rather than
 * asked about. The researcher therefore has to be granted the tools twice:
 * once so they exist, once so they may be used. Without the second grant he
 * reports that no search tool was available and falls back to writing from
 * general knowledge, which is exactly the opinion a research stage is there
 * to replace.
 *
 * Nothing else is granted. These turns get no shell, no filesystem and no MCP
 * server, so a hostile page can only ever influence text the human reviews.
 */
export const RESEARCH_TOOLS = ["WebSearch", "WebFetch"] as const;

/** Tools that exist for this turn: the research pair, or nothing at all. */
export function researchToolsFor(needsResearch: boolean): readonly string[] {
  return needsResearch ? [...RESEARCH_TOOLS] : [];
}

/**
 * Permission for the same pair. Kept identical to `researchToolsFor` on
 * purpose: a turn may only use what it was given, never more.
 */
export function researchPermissionsFor(needsResearch: boolean): readonly string[] {
  return needsResearch ? [...RESEARCH_TOOLS] : [];
}
