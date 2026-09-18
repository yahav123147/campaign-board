import { NextRequest, NextResponse } from "next/server";
import { generateRunId, briefToSlug } from "@/lib/slug";
import { createNewRunDir, saveBrief } from "@/lib/runStore";
import { createRun, listRunSummaries, updateRun, flushPersistence } from "@/orchestrator/runRegistry";
import { startDiscussionExecution } from "@/orchestrator/runDiscussion";
import { isAssetType, isPipeline, type AssetType, type Pipeline, type Run } from "@/types";
import { loadClientProfile } from "@/config/clientProfile";
import { resolvePageTypesDir, readPageTypeBlueprint } from "@/orchestrator/pageTypeBlueprint";
import { initializeStages } from "@/orchestrator/initializeStages";
import { startStageExecution } from "@/orchestrator/runStage";
import { eventBus } from "@/orchestrator/eventBus";
import { httpBodyError, readJsonBody } from "@/lib/httpBody";
import { MAX_BRIEF_CHARS, trimmedString } from "@/lib/inputLimits";

// Case-insensitive: a brief pasted with an uppercase scheme carries the same URL.
const SITE_URL_RE = /https?:\/\/[^\s)]+/i;

export async function POST(req: NextRequest) {
  let body: { brief?: string; assetType?: string; pipeline?: string };
  try {
    body = await readJsonBody(req);
  } catch (error) {
    const issue = httpBodyError(error);
    return NextResponse.json({ error: issue.error }, { status: issue.status });
  }

  const brief = trimmedString(body.brief);
  if (!brief || brief.length < 10) {
    return NextResponse.json({ error: "Brief must be at least 10 characters" }, { status: 400 });
  }
  if (brief.length > MAX_BRIEF_CHARS) {
    return NextResponse.json(
      { error: `Brief must be at most ${MAX_BRIEF_CHARS} characters` },
      { status: 400 },
    );
  }

  let assetType: AssetType = "sales-page";
  if (body.assetType !== undefined) {
    if (!isAssetType(body.assetType)) {
      return NextResponse.json({ error: "Unsupported assetType" }, { status: 400 });
    }
    assetType = body.assetType;
  }

  let clientProfile;
  try {
    clientProfile = await loadClientProfile();
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Client profile is not available" },
      { status: 503 },
    );
  }

  let pipeline: Pipeline = clientProfile.pipeline?.default ?? "council";
  if (body.pipeline !== undefined) {
    if (!isPipeline(body.pipeline)) {
      return NextResponse.json({ error: "Unsupported pipeline" }, { status: 400 });
    }
    pipeline = body.pipeline;
  }
  // Resolved once, here, from the profile this run starts with. Every later
  // read uses this stored folder, never the environment at that moment.
  const pageTypesDir = resolvePageTypesDir(clientProfile);
  if (pipeline === "direct") {
    if (!SITE_URL_RE.test(brief)) {
      return NextResponse.json(
        { error: "ריצה ישירה מתחילה בקציר מותג: הבריף חייב לכלול כתובת אתר מלאה (https://...)" },
        { status: 400 },
      );
    }
    if (assetType !== "sales-page") {
      const blueprint = await readPageTypeBlueprint(assetType, pageTypesDir).catch(() => "");
      if (!blueprint) {
        return NextResponse.json(
          { error: `אין תבנית לסוג הדף ${assetType} בתיקיית page-types. ריצה ישירה לא נסוגה לתבנית דף מכירה; הוסף את הקובץ ונסה שוב.` },
          { status: 400 },
        );
      }
    }
  }

  let id = "";
  let runDir = "";
  for (let attempt = 0; attempt < 5; attempt += 1) {
    id = generateRunId();
    try {
      runDir = await createNewRunDir(id);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  if (!runDir) {
    return NextResponse.json({ error: "Could not allocate a unique run id" }, { status: 503 });
  }
  const slug = briefToSlug(brief);
  await saveBrief(runDir, brief);

  const run: Run = {
    id, slug, brief, createdAt: new Date().toISOString(),
    status: "pending", currentRound: null, messages: [],
    clientProfile,
    assetType,
    pipeline,
    ...(pageTypesDir ? { pageTypesDir } : {}),
  };
  createRun(run);

  if (pipeline === "direct") {
    const stages = initializeStages(assetType, pipeline);
    updateRun(id, { status: "approved", stages, currentStage: 1 });
    await flushPersistence();
    eventBus.emit(id, { type: "stages-initialized", runId: id, stages, pipeline });
    const started = await startStageExecution(id, runDir, 1);
    if (!started.ok) {
      return NextResponse.json(
        { error: started.error, attemptId: started.activeAttemptId },
        { status: 409 },
      );
    }
    return NextResponse.json({ id, slug, attemptId: started.attemptId }, { status: 202 });
  }

  const started = await startDiscussionExecution(id, runDir);
  if (!started.ok) {
    return NextResponse.json(
      { error: started.error, attemptId: started.activeAttemptId },
      { status: 409 },
    );
  }

  return NextResponse.json({ id, slug, attemptId: started.attemptId }, { status: 202 });
}

export async function GET() {
  const runs = await listRunSummaries();
  return NextResponse.json({ runs });
}
