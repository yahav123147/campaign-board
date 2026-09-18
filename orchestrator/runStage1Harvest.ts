import path from "node:path";
import fs from "node:fs/promises";
import { runTrackedScript } from "./trackedScript";
import { spawnAgent } from "./spawnAgent";
import { loadAgents } from "./loadAgents";
import { eventBus } from "./eventBus";
import { getRun, updateRun } from "./runRegistry";
import { getStageDef, getSubTaskDef } from "./stageRegistry";
import { appendLog } from "@/lib/runStore";
import { markSubTaskAwaitingDecision, markSubTaskError, persistSubTaskFile } from "./runSubTask";
import { renderClientContext } from "./clientContext";
import { resolvePython } from "./runStage7Creatives";
import { absolutePathRule } from "./runStage5LpBuild";
import { agentTimeoutMs } from "./executionService";
import type { ExecutionControl } from "./executionService";

export const HARVEST_DIR = "harvest";
/**
 * The ceiling lib/runStore.ts validates a persisted harvest against. A larger
 * count makes every later saveRunState throw, so the run keeps executing while
 * nothing of it reaches the disk. The harvest script caps its saved images
 * below this on its own; the clamp here is what guarantees the record is
 * valid whatever the folder happens to hold.
 */
const MAX_PERSISTED_IMAGE_COUNT = 500;
const HARVEST_TIMEOUT_MS = 10 * 60_000;
// Case-insensitive, like the guard in app/api/runs/route.ts: a brief that was
// accepted there must yield the same URLs here.
const SITE_URL_RE = /https?:\/\/[^\s)]+/gi;
const EMAIL_RE = /\S+@\S+\.\S+/g;
// (a) An explicit label always wins, even over an "@" that appears earlier inside a URL.
const IG_LABEL_RE = /(?:אינסטגרם|instagram)\s*:\s*@?([A-Za-z0-9._]{2,30})/i;
// (b) A plain instagram.com/<handle> link, with or without a label.
const IG_URL_RE = /instagram\.com\/([A-Za-z0-9._]{2,30})/i;
// (c) A standalone "@handle" at the start of the text or after whitespace. Applied only
// after every URL span (SITE_URL_RE) and every email-shaped token are blanked out, so an
// "@" inside a URL path ("/@someone/") or an email ("info@example.com") is never read as
// an Instagram handle.
const IG_STANDALONE_RE = /(?:^|\s)@([A-Za-z0-9._]{2,30})/;

function trimHandle(handle: string): string {
  return handle.replace(/\.+$/, "");
}

export function siteUrlsFromBrief(brief: string): { urls: string[]; igHandle?: string } {
  const rawUrlMatches = brief.match(SITE_URL_RE) ?? [];
  const urls = [...new Set(rawUrlMatches.map((u) => u.replace(/[.,;]+$/, "")))];

  const labelMatch = brief.match(IG_LABEL_RE);
  if (labelMatch) return { urls, igHandle: trimHandle(labelMatch[1]!) };

  const urlHandleMatch = brief.match(IG_URL_RE);
  if (urlHandleMatch) return { urls, igHandle: trimHandle(urlHandleMatch[1]!) };

  let stripped = brief;
  for (const u of rawUrlMatches) stripped = stripped.split(u).join(" ".repeat(u.length));
  for (const e of stripped.match(EMAIL_RE) ?? []) stripped = stripped.split(e).join(" ".repeat(e.length));

  const standaloneMatch = stripped.match(IG_STANDALONE_RE);
  if (standaloneMatch) return { urls, igHandle: trimHandle(standaloneMatch[1]!) };

  return { urls };
}

/**
 * The Instagram handle a human last corrected on a sub-task's card: the newest
 * entry of its feedbackHistory that carries one, scanned newest to oldest.
 *
 * Reading only the current attempt's feedback would drop the correction the
 * moment the next rerun is about something else, or about nothing at all (a
 * plain retry sends no feedback), and the run would silently fall back to the
 * handle the brief happened to carry.
 */
export function latestHandleInFeedback(history: readonly string[]): string | undefined {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const handle = siteUrlsFromBrief(history[i] ?? "").igHandle;
    if (handle) return handle;
  }
  return undefined;
}

async function readJson(file: string): Promise<unknown> {
  try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return undefined; }
}

export async function runStage1Harvest(runId: string, runDir: string, feedback?: string, control?: ExecutionControl): Promise<void> {
  control?.throwIfAborted();
  const run = getRun(runId);
  if (!run?.stages) throw new Error(`Run ${runId} has no stages initialized`);
  const stageDef = getStageDef(1, run.assetType, "direct");
  const subTaskDef = getSubTaskDef(1, "1", run.assetType, "direct");
  const logName = "stage-1-1-harvest.log";
  const harvestDir = path.join(runDir, HARVEST_DIR);

  updateRun(runId, {
    currentStage: 1,
    stages: run.stages.map((s) => s.number === 1
      ? { ...s, status: "running" as const, errorMessage: undefined, currentSubTaskId: "1",
          subTasks: s.subTasks.map((st) => st.id === "1"
            ? { ...st, status: "running" as const, output: "", errorMessage: undefined, harvest: undefined, startedAt: new Date().toISOString(),
                feedbackHistory: feedback ? [...st.feedbackHistory, feedback] : st.feedbackHistory }
            : st) }
      : s),
  });
  eventBus.emit(runId, { type: "subtask-started", runId, stageNumber: 1, subTaskId: "1" });
  const emit = (token: string) => {
    control?.throwIfAborted();
    eventBus.emit(runId, { type: "subtask-token", runId, stageNumber: 1, subTaskId: "1", token });
    appendLog(runDir, logName, token).catch(() => {});
  };

  try {
    const { urls, igHandle: briefIgHandle } = siteUrlsFromBrief(run.brief);
    if (!urls.length) throw new Error("הבריף לא מכיל כתובת אתר (https://...)");
    // A correction: feedback on this stage's own card overrides the handle the
    // brief carries, and it survives every later rerun. The history is read
    // from the registry after the update above appended this attempt's own
    // feedback to it, so the newest correction anywhere in it wins.
    const stage1SubTask = getRun(runId)?.stages?.find((s) => s.number === 1)?.subTasks.find((st) => st.id === "1");
    const igHandle = latestHandleInFeedback(stage1SubTask?.feedbackHistory ?? []) ?? briefIgHandle;
    const script = path.join(process.cwd(), "vendor", "landing-skill", "scripts", "harvest_brand.py");
    const args = [script, harvestDir, ...urls, ...(igHandle ? ["--ig", igHandle] : [])];
    emit(`🌾 מריץ קציר מותג על ${urls.join(", ")}${igHandle ? ` (אינסטגרם: ${igHandle})` : ""}\n`);
    await fs.mkdir(harvestDir, { recursive: true });
    const { stdout } = await runTrackedScript({ command: await resolvePython(), args, cwd: runDir, signal: control?.signal, timeoutMs: HARVEST_TIMEOUT_MS, label: "harvest_brand.py" });
    await appendLog(runDir, logName, `\n# harvest_brand.py\n${stdout}\n`);
    control?.throwIfAborted();

    const rawFiles = (await fs.readdir(path.join(harvestDir, "raw")).catch(() => [] as string[])).filter((f) => /\.(jpe?g|png|webp|gif)$/i.test(f)).sort();
    const palette = await readJson(path.join(harvestDir, "palette.json"));
    const facts = await readJson(path.join(harvestDir, "facts.json"));
    emit(`📷 ${rawFiles.length} תמונות, גיליון ב-${HARVEST_DIR}/sheet.jpg\n\n`);

    const agents = await loadAgents();
    const owner = agents.find((a) => a.slug === stageDef.ownerSlug);
    if (!owner) throw new Error(`Owner ${stageDef.ownerSlug} not found`);
    const prompt = `${owner.systemPrompt}

---

${renderClientContext(run.clientProfile)}

## ה-Brief

${run.brief}

## תיקיית הקציר (קריאה בלבד): ${harvestDir}

ידית האינסטגרם לצילום ההוכחה: ${igHandle ? `@${igHandle}` : "אין ידית"}

### קבצי raw/
${rawFiles.map((f, i) => `${i + 1}. raw/${f}`).join("\n") || "(אין)"}

### palette.json
${JSON.stringify(palette ?? {}, null, 2)}

### facts.json
${JSON.stringify(facts ?? {}, null, 2)}

## המשימה שלך

${subTaskDef.instructions}${feedback ? `\n\n## ⚠️ משוב מבעל הסמכות האנושי על הריצה הקודמת\n\n> ${feedback}\n\nתקן בהתאם.` : ""}`;
    await appendLog(runDir, logName, `\n# Sort Prompt\n\n${prompt}\n\n# Output\n\n`);
    const { fullText } = await spawnAgent({
      prompt, cwd: harvestDir, permissionMode: "dontAsk",
      tools: ["Read", "Glob"], allowedTools: [absolutePathRule("Read", harvestDir, "/**")],
      strictMcpConfig: true, settingSources: [], disableSlashCommands: true,
      settings: { sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, filesystem: { denyRead: [process.env.HOME ?? "/"], allowRead: [harvestDir] }, network: { allowedDomains: [], allowLocalBinding: false, allowAllUnixSockets: false } } },
      signal: control?.signal,
      timeoutMs: agentTimeoutMs(control), onToken: emit,
    });
    control?.throwIfAborted();
    if (!fullText.trim()) throw new Error("סוכן המיון לא החזיר פלט");

    const harvest = {
      schemaVersion: 1 as const,
      sheetFile: "sheet.jpg" as const,
      imageCount: Math.min(rawFiles.length, MAX_PERSISTED_IMAGE_COUNT),
      harvestedAt: new Date().toISOString(),
      ...(igHandle ? { igHandle } : {}),
    };
    await persistSubTaskFile(runDir, 1, "1", fullText);
    const before = getRun(runId);
    if (before?.stages) {
      updateRun(runId, { stages: before.stages.map((s) => s.number === 1
        ? { ...s, subTasks: s.subTasks.map((st) => st.id === "1" ? { ...st, harvest } : st) }
        : s) });
    }
    await markSubTaskAwaitingDecision(runId, 1, "1", fullText);
    eventBus.emit(runId, { type: "subtask-completed", runId, stageNumber: 1, subTaskId: "1", content: fullText, harvest });
  } catch (err) {
    control?.throwIfAborted();
    const errorMessage = err instanceof Error ? err.message : String(err);
    await appendLog(runDir, logName, `\n\n## ERROR\n\n${errorMessage}\n`).catch(() => {});
    await markSubTaskError(runId, 1, "1", errorMessage);
    eventBus.emit(runId, { type: "subtask-error", runId, stageNumber: 1, subTaskId: "1", errorMessage });
    // A swallowed error would leave the attempt "completed" and the stage running (executionService.ts:193).
    throw err;
  }
}
