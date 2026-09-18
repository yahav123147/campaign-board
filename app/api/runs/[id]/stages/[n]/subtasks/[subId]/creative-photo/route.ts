import { NextRequest, NextResponse } from "next/server";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { Readable } from "node:stream";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { getRun } from "@/orchestrator/runRegistry";
import type { StageNumber } from "@/types";
import {
  listPresenterPhotos,
  resolvePresenterDir,
  resolvePython,
} from "@/orchestrator/runStage7Creatives";
import { loadClientProfile } from "@/config/clientProfile";

const execFileAsync = promisify(execFile);
// 9MB לקובץ עצמו, כדי שעם מעטפת ה-multipart הבקשה תישאר מתחת ל-10MB של Next.
const MAX_UPLOAD_BYTES = 9 * 1024 * 1024;

/**
 * Adds one presenter photo to the tenant's photo library. The upload is
 * re-encoded through PIL (scripts/sanitize-photo.py) before it lands in the
 * library: that strips EXIF/GPS metadata from phone photos, normalizes
 * orientation, and doubles as the real file-type validation, because a
 * non-image fails the re-encode loudly.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; n: string; subId: string }> },
) {
  const { id, n: nStr, subId } = await params;
  const n = Number(nStr) as StageNumber;
  if (n !== 7 || subId !== "7.5") {
    return NextResponse.json({ error: "Photo upload applies only to stage 7.5" }, { status: 400 });
  }

  const run = getRun(id);
  const subTask = run?.stages
    ?.find((s) => s.number === n)?.subTasks.find((st) => st.id === subId);
  if (!subTask) return NextResponse.json({ error: "SubTask not found" }, { status: 404 });
  if (subTask.status === "running") {
    return NextResponse.json(
      { error: "אי אפשר להעלות תמונה בזמן שההפקה רצה. חכו לסיום או עצרו אותה." },
      { status: 409 },
    );
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "multipart form with a 'photo' file is required" }, { status: 400 });
  }
  const photo = form.get("photo");
  if (!(photo instanceof File) || photo.size === 0) {
    return NextResponse.json({ error: "multipart form with a 'photo' file is required" }, { status: 400 });
  }
  if (photo.size > MAX_UPLOAD_BYTES) {
    return NextResponse.json({ error: "התמונה גדולה מדי (מקסימום 9MB)" }, { status: 413 });
  }

  const profile = await loadClientProfile().catch(() => undefined);
  const snapshotTenant = run?.clientProfile?.tenant?.id;
  if (profile && snapshotTenant && profile.tenant?.id !== snapshotTenant) {
    return NextResponse.json(
      { error: `הפרופיל הפעיל שייך ללקוח '${profile.tenant?.id ?? "?"}' אבל הריצה של '${snapshotTenant}'. טענו את הפרופיל הנכון.` },
      { status: 409 },
    );
  }
  const targetDir = resolvePresenterDir(profile ?? run?.clientProfile ?? undefined);
  if (!targetDir) {
    return NextResponse.json(
      { error: "אין פרופיל לקוח טעון, אי אפשר לקבוע ספריית תמונות. בדקו את CAMPAIGN_COUNCIL_CLIENT_PROFILE." },
      { status: 409 },
    );
  }
  await fs.mkdir(targetDir, { recursive: true, mode: 0o700 });

  const uploadId = randomUUID();
  const tempPath = path.join(os.tmpdir(), `cc-upload-${uploadId}`);
  // הסניטציה כותבת לקובץ ביניים באותה תיקייה ורק rename אטומי מכניס אותו
  // לספרייה: כישלון באמצע קידוד לא משאיר קובץ פגום שהמתכנן יראה, ושם ייחודי
  // מונע דריסה בין העלאות סמוכות.
  const stagedPath = path.join(targetDir, `.tmp-${uploadId}`);
  const fileName = `upload-${Date.now()}-${uploadId.slice(0, 8)}.jpg`;
  const targetPath = path.join(targetDir, fileName);
  try {
    await fs.writeFile(tempPath, Readable.fromWeb(photo.stream() as never), { mode: 0o600 });
    await execFileAsync(
      await resolvePython(),
      [path.join(process.cwd(), "scripts", "sanitize-photo.py"), tempPath, stagedPath],
      { timeout: 60_000, maxBuffer: 1024 * 1024 },
    );
    await fs.rename(stagedPath, targetPath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { error: `הקובץ לא זוהה כתמונה תקינה (jpg/png/webp): ${detail.slice(0, 200)}` },
      { status: 400 },
    );
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    await fs.rm(stagedPath, { force: true }).catch(() => {});
  }

  const photos = await listPresenterPhotos(targetDir);
  return NextResponse.json({ ok: true, fileName, photos });
}
