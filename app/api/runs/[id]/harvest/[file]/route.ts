import { NextResponse } from "next/server";
import { ensureRunLoaded } from "@/orchestrator/runRegistry";
import { runDirFor } from "@/lib/runStore";
import path from "node:path";
import fs from "node:fs/promises";

export const dynamic = "force-dynamic";

/** The only file this route will ever serve out of a run's harvest folder. */
const SHEET_FILE = "sheet.jpg";

/**
 * Stage 1 of a direct run leaves a contact sheet of the harvested images in the
 * run folder. The card shows it inline, so it needs a URL. Nothing else in that
 * folder is reachable here: the file name is compared against one literal, so a
 * traversal segment is refused before any path is built.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; file: string }> },
) {
  const { id, file } = await params;
  if (file !== SHEET_FILE) {
    return NextResponse.json({ error: "Unknown harvest file" }, { status: 400 });
  }

  const run = await ensureRunLoaded(id);
  if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });

  let bytes: Buffer;
  try {
    bytes = await fs.readFile(path.join(runDirFor(id), "harvest", SHEET_FILE));
  } catch {
    return NextResponse.json({ error: "Harvest sheet not found" }, { status: 404 });
  }

  return new NextResponse(new Uint8Array(bytes), {
    headers: { "Content-Type": "image/jpeg", "Cache-Control": "no-store" },
  });
}
