import { NextResponse } from "next/server";
import { ensureRunLoaded } from "@/orchestrator/runRegistry";
import { lpSlugFor } from "@/orchestrator/runStage5LpBuild";
import { previewIsOwnedAndOpen, previewUrlFor } from "@/orchestrator/previewServer";
import { landingWorktreePath } from "@/orchestrator/landingWorktree";
import { runDirFor } from "@/lib/runStore";
import path from "node:path";
import fs from "node:fs/promises";

export const dynamic = "force-dynamic";

/**
 * Where this run's page is being served, and whether anything is answering
 * there, so the board can show the page instead of linking away to it.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const run = await ensureRunLoaded(id);
  if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });

  const slug = lpSlugFor(run.brief, id);
  const url = previewUrlFor(slug);
  const build = run.stages?.find((s) => s.number === 5)?.subTasks.find((st) => st.id === "5.3");
  const expectedWorktree = landingWorktreePath(runDirFor(id));
  const worktree = build?.landingWorktreePath && path.resolve(build.landingWorktreePath) === expectedWorktree
    ? expectedWorktree
    : null;
  const up = worktree ? await previewIsOwnedAndOpen(worktree) : false;

  // When the page files were last written, so a page from an earlier build is
  // never mistaken for the result of the run in progress.
  let builtAt: string | null = null;
  try {
    if (!worktree) throw new Error("No sealed worktree");
    const stat = await fs.stat(path.join(worktree, "src/app", slug));
    builtAt = stat.mtime.toISOString();
  } catch {
    builtAt = null;
  }

  const stale = Boolean(builtAt) && build?.status !== "approved" && build?.status !== "awaiting-decision";

  return NextResponse.json({ url, slug, up, builtAt, stale, buildStatus: build?.status ?? null });
}
