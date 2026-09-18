import { NextResponse } from "next/server";
import { loadClientProfile } from "@/config/clientProfile";

/**
 * The one piece of the client profile the brief form needs before a run
 * exists: which pipeline the installation starts on (spec decision 16). The
 * form hardcoded "council" and the profile default only applied server-side,
 * so a direct-first installation still had to switch by hand on every run.
 *
 * Nothing else about the client is exposed here: this response is fetched by
 * the page on load, so it carries the selection default and no more. The
 * board's name is not here either: the root layout resolves it on the server
 * and hands it to the header directly, so there is one source for it. A
 * profile that fails to load answers 503, like POST /api/runs, instead of
 * inventing a default the installation did not choose.
 */
export async function GET() {
  try {
    const profile = await loadClientProfile();
    return NextResponse.json({ pipelineDefault: profile.pipeline?.default ?? "council" });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Client profile is not available" },
      { status: 503 },
    );
  }
}
