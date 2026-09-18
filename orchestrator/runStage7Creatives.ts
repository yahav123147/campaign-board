import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadAgents } from "./loadAgents";
import { spawnAgent } from "./spawnAgent";
import { eventBus } from "./eventBus";
import { getRun, updateRun } from "./runRegistry";
import { appendLog } from "@/lib/runStore";
import {
  markSubTaskAwaitingDecision,
  markSubTaskError,
  persistSubTaskFile,
} from "./runSubTask";
import {
  atomicCreateManagedFile,
  createAssetThumbnailDataUrls,
  isSafeAssetFileName,
  validateAssetFolderSnapshot,
  MAX_CONTACT_SHEET_BYTES,
} from "./assetQuality";
import { buildContactSheetWithStatus } from "./contactSheet";
import { openInBrowser } from "./previewServer";
import { agentTimeoutMs } from "./executionService";
import type { ExecutionControl } from "./executionService";
import { loadClientProfile } from "@/config/clientProfile";
import { readCreativeStandard, renderCopyStandard } from "./copyStandard";
import { CREATIVE_MODE_CHOICE_MARKER, RUNNER_FEEDBACK_SENTINELS, type CreativeMode } from "@/lib/creativeMode";

const execFileAsync = promisify(execFile);
const STAGE = 7 as const;
const SUB_ID = "7.5";
const MAX_CREATIVES = 3;
const IMAGE_RE = /\.(png|jpe?g|webp)$/i;

/** Base of the fallback photo libraries for tenants whose profile sets no presenterPhotosDir. */
export const DEFAULT_PRESENTER_DIR = path.join(os.homedir(), ".config", "campaign-council", "presenter-photos");

/**
 * One resolution policy for the photo library, shared by the runner and the
 * routes. The fallback is scoped per tenant id: a machine that runs several
 * client profiles must never show client A's face in client B's plan, so a
 * profile-less (or tenant-less) context resolves to no library at all.
 */
export function resolvePresenterDir(
  profile: { tenant?: { id?: string | null }; creative?: { presenterPhotosDir?: string | null } } | undefined,
): string | undefined {
  const configured = profile?.creative?.presenterPhotosDir;
  if (configured) return configured;
  const tenantId = profile?.tenant?.id;
  if (!tenantId) return undefined;
  const safeTenant = tenantId.replace(/[^A-Za-z0-9._-]/g, "_");
  return path.join(DEFAULT_PRESENTER_DIR, safeTenant);
}

/**
 * Prepended to the sub-task output when creative production is not configured
 * for the tenant. The express auto-approver treats a gate carrying this marker
 * as routine, so a profile without image generation flows straight through.
 */
export const CREATIVES_DISABLED_MARKER = "🚫 הפקת קריאייטיבים כבויה בפרופיל";

interface CreativePlanLine {
  cy: number;
  text?: string;
  two_tone?: { right: string; left: string };
  size: number;
  weight: number;
  color?: string;
  right_color?: string;
  left_color?: string;
}

interface CreativePlanEntry {
  ad: number;
  file: string;
  mode: "generated" | "presenter" | "variation";
  image_prompt?: string;
  presenter_photo?: string;
  /** Models drift on the key name; both are accepted. */
  presenter_image?: string;
  focus?: { fx?: number; fy?: number };
  caption?: string;
  spec: {
    top_scrim?: { end: number };
    bottom_scrim?: { start: number; mid: number };
    lines: CreativePlanLine[];
    bar?: { text: string; by: number; bw: number };
    brand?: { cy: number; text: string };
  };
}

/** Find the first balanced JSON object in agent output and parse it. */
export function extractPlanJson(text: string): { creatives: CreativePlanEntry[] } {
  // הסוכן מתבקש להחזיר JSON בלבד, אבל בפועל הוא לפעמים מצטט קודם את דוגמת
  // הסכמה מהפרומפט (עם placeholders). לכן נאספים כל אובייקטי ה-JSON המאוזנים
  // בטקסט, והתוכנית היא האחרון שנפרס בהצלחה עם מערך creatives לא ריק.
  let best: { creatives: CreativePlanEntry[] } | undefined;
  let sawBalanced = false;
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf("{", cursor);
    if (start === -1) break;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) {
      // '{' תועה בפרוזה שלא נסגר לא מפיל את הסריקה; ממשיכים תו אחד קדימה
      // כדי שתוכנית תקינה שמופיעה אחריו עדיין תימצא.
      cursor = start + 1;
      continue;
    }
    sawBalanced = true;
    try {
      const raw = text.slice(start, end + 1);
      const parsed = JSON.parse(raw) as { creatives?: CreativePlanEntry[] };
      if (Array.isArray(parsed.creatives) && parsed.creatives.length > 0) {
        const candidate = { creatives: parsed.creatives.slice(0, MAX_CREATIVES) };
        // דוגמת הסכמה מהפרומפט מזוהה לפי ערכי placeholder כמו "<שם קובץ מהרשימה>";
        // תוכנית אמיתית לעולם לא פותחת ערך מחרוזת ב-<.
        const looksLikeTemplate = raw.includes('"<');
        if (!looksLikeTemplate || !best) best = candidate;
      }
    } catch {
      // בלוק מאוזן שאינו JSON תקין (למשל פסאודו-דוגמה בטקסט חופשי), ממשיכים הלאה.
    }
    cursor = end + 1;
  }
  if (best) return best;
  if (!text.includes("{")) throw new Error("הסוכן לא החזיר JSON של תוכנית קריאייטיבים");
  if (!sawBalanced) throw new Error("ה-JSON של תוכנית הקריאייטיבים לא נסגר");
  throw new Error("תוכנית הקריאייטיבים ריקה או לא בפורמט הנדרש");
}

export function assertPlanEntry(entry: CreativePlanEntry, presenterPhotos: string[]): void {
  if (!isSafeAssetFileName(entry.file) || !entry.file.endsWith(".png")) {
    throw new Error(`שם קובץ לא חוקי בתוכנית: ${String(entry.file).slice(0, 60)}`);
  }
  if (entry.mode !== "generated" && entry.mode !== "presenter" && entry.mode !== "variation") {
    throw new Error(`mode לא מוכר בתוכנית: ${String(entry.mode).slice(0, 30)}`);
  }
  if (entry.mode === "generated") {
    const prompt = (entry.image_prompt ?? "").trim();
    if (prompt.length < 20) throw new Error(`image_prompt חסר או קצר מדי עבור ${entry.file}`);
    if (/[֐-׿]/.test(prompt)) {
      throw new Error(`image_prompt חייב להיות באנגלית בלבד (${entry.file}); העברית נכנסת רק בשכבת הטקסט`);
    }
  } else {
    const photo = entry.presenter_photo ?? entry.presenter_image;
    if (!photo || !presenterPhotos.includes(photo)) {
      throw new Error(`presenter_photo חסר או לא קיים בתיקיית הפרזנטור עבור ${entry.file}`);
    }
    entry.presenter_photo = photo;
    if (entry.mode === "variation") {
      // איכות הווריאציה נקבעת על ידי התיאור; פרומפט רזה נפסל לפני שריפת קרדיטים.
      const prompt = (entry.image_prompt ?? "").trim();
      if (prompt.length < 120) {
        throw new Error(`image_prompt של וריאציה חייב להיות עשיר ומפורט (לפחות 120 תווים) עבור ${entry.file}`);
      }
      if (/[֐-׿]/.test(prompt)) {
        throw new Error(`image_prompt חייב להיות באנגלית בלבד (${entry.file}); העברית נכנסת רק בשכבת הטקסט`);
      }
      if (!/reference/i.test(prompt)) {
        throw new Error(`image_prompt של וריאציה חייב לכלול עוגן זהות ("the same person as in the reference image") עבור ${entry.file}`);
      }
    }
  }
  if (!entry.spec || !Array.isArray(entry.spec.lines) || entry.spec.lines.length === 0) {
    throw new Error(`spec.lines חסר עבור ${entry.file}`);
  }
}

/** The image venv from setup.sh when present; otherwise whatever python3 the server sees. */
export async function resolvePython(): Promise<string> {
  const venvPython = path.join(os.homedir(), ".campaign-council-venv", "bin", "python3");
  try {
    await fs.access(venvPython);
    return venvPython;
  } catch {
    return "python3";
  }
}

async function readKeychainSecret(service: string): Promise<string> {
  if (process.platform !== "darwin") {
    throw new Error("קריאת מפתח OpenAI נתמכת כרגע רק ב-macOS Keychain");
  }
  const { stdout } = await execFileAsync(
    "/usr/bin/security",
    ["find-generic-password", "-s", service, "-w"],
    { timeout: 15_000 },
  );
  const secret = stdout.trim();
  if (!secret) throw new Error(`ה-Keychain לא החזיר מפתח עבור השירות ${service}`);
  return secret;
}

export async function listPresenterPhotos(dir: string | undefined): Promise<string[]> {
  if (!dir) return [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const files = entries.filter((entry) => entry.isFile() && IMAGE_RE.test(entry.name));
    // כשהספרייה גדולה מהתקרה שומרים את החדשות לפי mtime, אחרת תמונה שהלקוח
    // הרגע העלה נחתכת מהרשימה שהמתכנן רואה; הפלט אלפביתי ליציבות הפרומפט.
    const withTimes = await Promise.all(files.map(async (entry) => ({
      name: entry.name,
      mtime: (await fs.stat(path.join(dir, entry.name))).mtimeMs,
    })));
    return withTimes
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 12)
      .map((item) => item.name)
      .sort();
  } catch {
    return [];
  }
}

export async function runStage7Creatives(
  runId: string,
  runDir: string,
  feedback?: string,
  control?: ExecutionControl,
): Promise<void> {
  control?.throwIfAborted();
  const run = getRun(runId);
  if (!run?.stages) throw new Error(`Run ${runId} not found`);
  const profile = run.clientProfile;

  const logName = `stage-7-7.5-creatives.log`;
  const emit = (token: string) => {
    control?.throwIfAborted();
    eventBus.emit(runId, { type: "subtask-token", runId, stageNumber: STAGE, subTaskId: SUB_ID, token });
    appendLog(runDir, logName, token).catch(() => {});
  };
  const setSubTask = (patch: Record<string, unknown>) => {
    const stages = (getRun(runId)?.stages ?? []).map((s) =>
      s.number === STAGE
        ? {
            ...s,
            status: "running" as const,
            currentSubTaskId: SUB_ID,
            subTasks: s.subTasks.map((st) => (st.id === SUB_ID ? { ...st, ...patch } : st)),
          }
        : s,
    );
    updateRun(runId, { stages, currentStage: STAGE });
  };
  const finish = async (output: string) => {
    await persistSubTaskFile(runDir, STAGE, SUB_ID, output);
    control?.throwIfAborted();
    await markSubTaskAwaitingDecision(runId, STAGE, SUB_ID, output);
    eventBus.emit(runId, { type: "subtask-completed", runId, stageNumber: STAGE, subTaskId: SUB_ID, content: output });
  };

  try {
    // הדיספץ' של 7.5 עוקף את הסימון הגנרי של runSubTask, ולכן התת-משימה חייבת
    // לסמן את עצמה: בלי זה היא נשארת awaiting-decision בזמן הפקה פעילה,
    // וההיסטוריה לא שומרת משוב שהמנגנון של החלפת-מצב צריך לשאת הלאה (F101).
    const existingSubTask = run.stages
      .find((s) => s.number === STAGE)?.subTasks.find((st) => st.id === SUB_ID);
    setSubTask({
      status: "running",
      output: "",
      errorMessage: undefined,
      startedAt: new Date().toISOString(),
      ...(feedback
        ? { feedbackHistory: [...(existingSubTask?.feedbackHistory ?? []), feedback] }
        : {}),
    });
    eventBus.emit(runId, { type: "subtask-started", runId, stageNumber: STAGE, subTaskId: SUB_ID });

    // Keychain service and capability are operator infrastructure, not
    // campaign content: read them live so a run created before the feature
    // (or before the operator enabled it) can still produce creatives.
    let liveProfileError = "";
    const liveProfile = await loadClientProfile().catch((error) => {
      liveProfileError = error instanceof Error ? error.message : String(error);
      return undefined;
    });
    // הפרופיל החי משרת תשתית, אבל רק אם הוא של אותו לקוח: מפעיל עם פרופיל B
    // טעון אסור שיריץ את הריצה של A עם המפתח והתמונות של B (F101).
    const snapshotTenant = profile?.tenant?.id;
    const liveTenant = liveProfile?.tenant?.id;
    if (liveProfile && snapshotTenant && liveTenant !== snapshotTenant) {
      throw new Error(
        `הפרופיל הפעיל שייך ללקוח '${liveTenant ?? "?"}' אבל הריצה נוצרה עבור '${snapshotTenant}'. טענו את הפרופיל הנכון (CAMPAIGN_COUNCIL_CLIENT_PROFILE) והריצו שוב.`,
      );
    }
    const effective = liveProfile ?? profile;
    const keychainService = effective?.creative?.openaiKeychainService;
    const capabilityOn = effective?.policies?.capabilities?.creativeImageGen === true;
    if (!capabilityOn || !keychainService) {
      const reason = `${!capabilityOn
        ? "policies.capabilities.creativeImageGen אינו מופעל בפרופיל."
        : "creative.openaiKeychainService אינו מוגדר בפרופיל."}${liveProfileError ? `\n\n(קריאת הפרופיל החי נכשלה: ${liveProfileError})` : ""}`;
      await finish(
        `${CREATIVES_DISABLED_MARKER}\n\n${reason}\n\nהמודעות משלב 7 כוללות Creative brief מילולי לכל מודעה; אפשר להפיק את התמונות ידנית, או להפעיל את היכולת בפרופיל ולהריץ את השלב מחדש.`,
      );
      return;
    }

    const stage7 = run.stages.find((s) => s.number === STAGE);
    const adsOutput = stage7?.subTasks.find((st) => st.id === "7")?.output ?? "";
    if (!adsOutput.trim()) throw new Error("אין תוצר מודעות מאושר משלב 7");
    const brandBrief =
      run.stages.find((s) => s.number === 5)?.subTasks.find((st) => st.id === "5.1")?.output ?? "";

    const presenterDir = resolvePresenterDir(effective ?? undefined);
    const presenterPhotos = await listPresenterPhotos(presenterDir);
    const creativeStandard = await readCreativeStandard(effective);

    // הבחירה בין טיפוגרפיה על תמונה אמיתית לווריאציית AI שייכת ללקוח, והיא
    // חייבת לקרות לפני ההפקה: 7.5 מוזנק אוטומטית אחרי אישור שלב 7, אז בלי
    // עצירה מפורשת ההפקה הייתה רצה בברירת מחדל שהלקוח מעולם לא בחר.
    const subTaskRecord = run.stages
      .find((s) => s.number === STAGE)?.subTasks.find((st) => st.id === SUB_ID);
    const chosenMode: CreativeMode | undefined = subTaskRecord?.creativeMode;
    // עוצרים לבחירה רק בריצה נקייה: ריצת משוב אנושי בלי מצב שמור ממשיכה
    // בברירת המחדל (טיפוגרפיה), אחרת המשוב היה נבלע במסך הבחירה והולך לאיבוד.
    // פידבק-סנטינל של כפתורי התחל/נסה-שוב אינו משוב אנושי ולכן כן עוצרים עליו.
    const humanFeedback = feedback && !RUNNER_FEEDBACK_SENTINELS.includes(feedback);
    if (!chosenMode && !humanFeedback) {
      const photoList = presenterPhotos.length
        ? `תמונות זמינות בספרייה (${presenterPhotos.length}):\n${presenterPhotos.map((ph) => `- ${ph}`).join("\n")}`
        : "אין עדיין תמונות בספרייה. כדי לבחור וריאציית AI, העלו קודם תמונה בכפתור ההעלאה.";
      await finish(
        `${CREATIVE_MODE_CHOICE_MARKER}\n\nלפני הפקת הקריאייטיבים, בחרו איך הם ייוצרו:\n\n1. **טקסט על התמונה שלי**: ${presenterPhotos.length
          ? "התמונה האמיתית נשארת כמו שהיא, ומעליה מונחת שכבת הטיפוגרפיה. ללא עלות ג'נרוט."
          : "אין עדיין תמונות בספרייה, ולכן במצב הזה הרקעים ייוצרו במודל התמונות (קרדיטים מחשבון ה-OpenAI שבפרופיל) והטיפוגרפיה תונח מעליהם. כדי שזה יהיה באמת בחינם, העלו תמונה קודם."}\n2. **וריאציית AI מהתמונה שלי**: התמונה נשלחת למודל התמונות ומצוירת מחדש כסצנה חדשה, כולל הפנים. עלות: קרדיטים מחשבון ה-OpenAI שבפרופיל, ותוצאה שעשויה להיראות מעט AI.\n\n${photoList}\n\nבשני המצבים הטקסט העברי מונח רק בשכבת הטיפוגרפיה, והתוצאות מחכות לאישור שלכם בשער הזה.`,
      );
      return;
    }

    // ---------- Phase A: the plan ----------
    const agents = await loadAgents();
    const planner = agents.find((a) => a.slug === "uri-art-director") ?? agents.find((a) => a.slug === "roni-creative");
    if (!planner) throw new Error("לא נמצא סוכן ארט לתכנון הקריאייטיבים");

    const feedbackBlock = feedback
      ? `\n\n## ⚠️ משוב מבעל הסמכות האנושי על הסבב הקודם\n\n> ${feedback}\n\nתקן בהתאם, ורק בהתאם.`
      : "";
    const effectiveMode: CreativeMode = chosenMode ?? "typography";
    const presenterBlock = effectiveMode === "ai-variation"
      ? `הלקוח בחר במצב וריאציית AI. כל הקריאייטיבים חייבים להיות mode "variation" עם שני שדות חובה: presenter_photo (שם קובץ מהרשימה למטה) ו-image_prompt באנגלית. ה-image_prompt הוא המוצר: תיאור עשיר ומדויק של לפחות 120 תווים שכולל (1) את עוגן הזהות המילולי "the same person as in the reference image", (2) סצנה, תאורה, לבוש, זווית צילום ומצב רוח, (3) קומפוזיציה עם שליש תחתון נקי ופנוי לטיפוגרפיה. תמונות הרפרנס:\n${presenterPhotos.map((p) => `- ${p}`).join("\n")}`
      : presenterPhotos.length
      ? `תמונות פרזנטור אמיתיות זמינות (mode "presenter" משתמש באחת מהן כרקע, בלי שום ג'נרוט של אדם):\n${presenterPhotos.map((p) => `- ${p}`).join("\n")}`
      : `אין תמונות פרזנטור. כל הקריאייטיבים חייבים להיות mode "generated" בלי בני אדם בכלל ב-image_prompt.`;

    const planPrompt = `${planner.systemPrompt}

---

# המשימה: תוכנית הפקה ל-3 קריאייטיבים סטטיים (פיד 4:5)

לפניך שלוש מודעות מאושרות עם Creative brief לכל אחת, ובריף מותג. תרגם כל מודעה לתוכנית הפקה מדויקת אחת.

## המודעות המאושרות

${adsOutput}

## בריף המותג

${brandBrief || "(אין בריף מותג; לך על רקעים כהים פרימיום)"}

## ${presenterBlock}

${renderCopyStandard(creativeStandard, "ספר הכללים של הקריאייטיב, מנצח את הטעם שלך. כל תוכנית חייבת לעמוד בו סעיף-סעיף: מבנה 4 שכבות הטקסט, פס CTA עם פועל בהווה-רבים, שורת מותג, ומיקומי העוגן")}

## חוקים קשיחים

1. **image_prompt באנגלית בלבד**. חובה לכלול בסופו: "no text, no letters, no words, no typography, no watermark". ${effectiveMode === "ai-variation" ? 'במצב variation מתארים את האדם מתמונת הרפרנס במלואו, עם עוגן הזהות.' : 'מתאר סצנה/רקע בלבד. אסור לתאר בני אדם או פנים (אנשים רק דרך mode presenter עם תמונה אמיתית).'}
2. בטקסטים: אותיות עברית ולטינית, ספרות ופיסוק בלבד. בלי אימוג'ים, בלי סימני ✓/✔ ובלי תווים מיוחדים (הפונט לא תומך). צבעים: לבן והזהב של המותג בלבד ללינים, אלא אם בריף המותג קובע פלטה אחרת. **כל העברית נכנסת רק ב-spec.lines וב-bar** (שכבת טיפוגרפיה שמונחת אחר כך). קח את ההוק, הכותרת וה-CTA מהמודעה עצמה, מילה במילה. אסור להמציא טקסט חדש.
3. צבעי טקסט: "white", "gold", "soft", או HEX בפורמט "#RRGGBB" מתוך פלטת בריף המותג. מערכת קואורדינטות 1080x1350. טקסטים בשליש התחתון (cy בין 760 ל-1300), bottom_scrim תמיד. גדלים: הוק 72-96, משני 48-60, CTA בפס bar.
4. פלט: JSON בלבד, בלי הסבר, בפורמט:

${effectiveMode === "ai-variation" ? 'דוגמה למצב variation (שני השדות חובה): {"ad":1,"file":"ad-1.png","mode":"variation","presenter_photo":"<שם קובץ מהרשימה>","image_prompt":"<rich English description with the identity anchor>","focus":{"fx":0.5,"fy":0.3},"caption":"תיאור קצר","spec":{...כמו בדוגמה למטה}}\n\n' : ''}דוגמה לשני המצבים (השדה presenter_photo חובה במצב presenter, בשם הזה בדיוק):
{"creatives":[{"ad":1,"file":"ad-1.png","mode":"presenter","presenter_photo":"<שם קובץ מהרשימה>","focus":{"fx":0.55,"fy":0.3},"caption":"תיאור קצר בעברית","spec":{"bottom_scrim":{"start":560,"mid":840},"lines":[{"cy":850,"text":"<הוק>","size":92,"weight":900,"color":"white"},{"cy":950,"text":"<payoff>","size":60,"weight":800,"color":"gold"},{"cy":1040,"text":"<אמפתיה 1>","size":43,"weight":500,"color":"soft"},{"cy":1095,"text":"<אמפתיה 2>","size":43,"weight":500,"color":"soft"}],"bar":{"text":"<פועל בהווה-רבים> ‹","by":1160,"bw":720},"brand":{"cy":1290,"text":"<שם המוצר>"}}},{"ad":2,"file":"ad-2.png","mode":"generated","image_prompt":"...","focus":{"fx":0.5,"fy":0.3},"caption":"...","spec":{"bottom_scrim":{"start":600,"mid":880},"lines":[{"cy":800,"text":"...","size":84,"weight":900,"color":"white"},{"cy":900,"text":"...","size":54,"weight":700,"color":"gold"}],"bar":{"text":"טקסט CTA ‹","by":1140,"bw":720}}}]}${feedbackBlock}`;

    await appendLog(runDir, logName, `# Plan Prompt\n\n${planPrompt}\n\n# Output\n\n`);
    // ניסיון תכנון אחד + ריטריי יחיד וחסום: סוכנים החזירו בפועל דוגמת סכמה או
    // טקסט קריאות-כלים במקום JSON (F97), וריצה שלמה לא נופלת על עווית אחת כזו.
    let plan: { creatives: CreativePlanEntry[] } | undefined;
    let lastPlanError: unknown;
    for (let planTry = 0; planTry < 2 && !plan; planTry++) {
      const retrySuffix = planTry === 0
        ? ""
        : `\n\n## תיקון חובה\n\nהפלט הקודם שלך לא היה JSON תקין של תוכנית (${lastPlanError instanceof Error ? lastPlanError.message : "פורמט שגוי"}). החזר עכשיו אך ורק אובייקט JSON אחד עם המפתח creatives, בלי מלל, בלי קריאות כלים ובלי לצטט את הדוגמה.`;
      emit(`🎨 ${planner.name} מתכנן ${MAX_CREATIVES} קריאייטיבים...${planTry ? " (ניסיון שני)" : ""}\n`);
      const { fullText: planText } = await spawnAgent({
        prompt: planPrompt + retrySuffix,
        permissionMode: "default",
        tools: [],
        strictMcpConfig: true,
        settingSources: [],
        disableSlashCommands: true,
        signal: control?.signal,
        timeoutMs: agentTimeoutMs(control),
        onToken: emit,
      });
      control?.throwIfAborted();
      try {
        const candidate = extractPlanJson(planText);
        for (const entry of candidate.creatives) {
          assertPlanEntry(entry, presenterPhotos);
          // הלקוח בחר את המצב בשער; תוכנית שסוטה ממנו שורפת קרדיטים או
          // מג'נרטת פנים בלי הסכמה, ולכן נפסלת לפני ייצור.
          if (effectiveMode === "ai-variation" && entry.mode !== "variation") {
            throw new Error(`הלקוח בחר וריאציית AI אבל ${entry.file} תוכנן במצב ${entry.mode}; כל הקריאייטיבים חייבים mode "variation"`);
          }
          if (effectiveMode !== "ai-variation" && entry.mode === "variation") {
            throw new Error(`הלקוח לא בחר וריאציית AI אבל ${entry.file} תוכנן במצב variation; מותר רק presenter או generated`);
          }
          // מסך הבחירה הבטיח "ללא עלות ג'נרוט" כשיש תמונות; תוכנית generated
          // במצב הזה הייתה מפעילה את סקריפט התמונות בתשלום למרות ההבטחה (F101).
          if (effectiveMode !== "ai-variation" && presenterPhotos.length > 0 && entry.mode !== "presenter") {
            throw new Error(`הלקוח בחר טקסט על התמונה האמיתית ויש תמונות בספרייה, אבל ${entry.file} תוכנן במצב ${entry.mode} בתשלום; חובה mode "presenter"`);
          }
        }
        plan = candidate;
      } catch (error) {
        lastPlanError = error;
        await appendLog(runDir, logName, `\n[plan-retry] ניסיון ${planTry + 1} נפסל: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
    if (!plan) throw lastPlanError instanceof Error ? lastPlanError : new Error(String(lastPlanError));

    // ---------- Phase B: deterministic production ----------
    const creativesDir = path.join(runDir, "creatives");
    const workDir = path.join(runDir, "creatives-work");
    await fs.rm(creativesDir, { recursive: true, force: true });
    await fs.rm(workDir, { recursive: true, force: true });
    await fs.mkdir(creativesDir, { recursive: true, mode: 0o700 });
    await fs.mkdir(workDir, { recursive: true, mode: 0o700 });

    const attemptId = randomUUID();
    const apiKey = await readKeychainSecret(keychainService);
    const repoRoot = process.cwd();

    for (const entry of plan.creatives) {
      control?.throwIfAborted();
      let backgroundPath: string;
      if (entry.mode === "generated" || entry.mode === "variation") {
        emit(entry.mode === "variation"
          ? `🪞 מייצר וריאציית AI מ-${entry.presenter_photo} עבור ${entry.file}...\n`
          : `🖼️ מייצר רקע עבור ${entry.file}...\n`);
        const promptPath = path.join(workDir, `${entry.file}.prompt.txt`);
        backgroundPath = path.join(workDir, `${entry.file}.bg.png`);
        await fs.writeFile(promptPath, `${entry.image_prompt!.trim()}\nno text, no letters, no words, no typography, no watermark`);
        const imageArgs = [
          path.join(repoRoot, "scripts", "openai-image.mjs"),
          "--prompt-file", promptPath,
          "--out", backgroundPath,
          "--size", "1024x1536",
          ...(entry.mode === "variation" ? ["--input", path.join(presenterDir!, entry.presenter_photo!)] : []),
        ];
        try {
          await execFileAsync(process.execPath, imageArgs, {
            timeout: 300_000, env: { ...process.env, OPENAI_API_KEY: apiKey }, maxBuffer: 1024 * 1024,
          });
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          if (entry.mode === "variation") {
            throw new Error(
              `יצירת וריאציית ה-AI עבור ${entry.file} נכשלה. לפעמים המודל מסרב לערוך תמונות של אנשים אמיתיים; אפשר לנסות שוב עם משוב, להעלות תמונה אחרת, או לבחור במצב "טקסט על התמונה שלי".\n\nפרטים טכניים: ${detail.slice(0, 400)}`,
            );
          }
          throw error;
        }
      } else {
        backgroundPath = path.join(presenterDir!, entry.presenter_photo!);
        emit(`🧑 משתמש בתמונת פרזנטור אמיתית עבור ${entry.file}\n`);
      }

      const spec = {
        out: path.join(creativesDir, entry.file),
        scene: {
          image: backgroundPath,
          fx: entry.focus?.fx ?? 0.5,
          fy: entry.focus?.fy ?? 0.35,
        },
        ...(entry.spec.top_scrim ? { top_scrim: entry.spec.top_scrim } : {}),
        bottom_scrim: entry.spec.bottom_scrim ?? { start: 600, mid: 880 },
        lines: entry.spec.lines,
        ...(entry.spec.bar ? { bar: entry.spec.bar } : {}),
        ...(entry.spec.brand ? { brand: entry.spec.brand } : {}),
      };
      const specPath = path.join(workDir, `${entry.file}.spec.json`);
      await fs.writeFile(specPath, JSON.stringify(spec, null, 2));
      emit(`🪄 מרכיב טיפוגרפיה עברית על ${entry.file}...\n`);
      await execFileAsync(await resolvePython(), [path.join(repoRoot, "scripts", "compose-ad.py"), specPath], {
        timeout: 120_000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env },
      });
    }

    const assetPlan = {
      schemaVersion: 1 as const,
      attemptId,
      assets: plan.creatives.map((entry) => ({ file: entry.file, kind: "generated" as const })),
    };
    await fs.writeFile(path.join(creativesDir, "asset-plan.json"), JSON.stringify(assetPlan, null, 2));

    // ---------- Phase C: validation + human contact sheet ----------
    control?.throwIfAborted();
    const validation = await validateAssetFolderSnapshot(creativesDir, { expectedAttemptId: attemptId });
    const { manifest, manifestSha256: assetManifestDraftSha256, assetBytes } = validation;
    setSubTask({ assetManifestDraftSha256, assetManifestSha256: undefined });

    const sheetFiles = manifest.assets.map((asset) => asset.file);
    const captions = Object.fromEntries(
      plan.creatives.map((entry) => [entry.file, entry.caption ?? `מודעה ${entry.ad}`]),
    );
    const statuses = Object.fromEntries(
      manifest.assets.map((asset) => [
        asset.file,
        {
          status: asset.status,
          kind: asset.kind,
          sourceFile: asset.sourceFile,
          problems: asset.problems,
          previewable: asset.previewable && isSafeAssetFileName(asset.file),
        },
      ]),
    );
    const cacheKeys = Object.fromEntries(manifest.assets.map((asset) => [asset.file, asset.sha256]));
    const thumbnails = await createAssetThumbnailDataUrls(
      assetBytes,
      manifest.assets.filter((asset) => asset.previewable && assetBytes.has(asset.file)).map((asset) => asset.file),
    );
    const sheetHtml = buildContactSheetWithStatus(sheetFiles, captions, statuses, cacheKeys, thumbnails);
    if (Buffer.byteLength(sheetHtml, "utf8") > MAX_CONTACT_SHEET_BYTES) {
      throw new Error("גיליון הקריאייטיבים גדול מדי להצגה בטוחה");
    }
    const sheetFile = `contact-sheet-${attemptId}-${assetManifestDraftSha256.slice(0, 16)}.html`;
    const sheetPath = path.join(creativesDir, sheetFile);
    await atomicCreateManagedFile(sheetPath, creativesDir, sheetHtml);
    const assetContactSheetSha256 = createHash("sha256").update(sheetHtml).digest("hex");
    setSubTask({ assetContactSheetFile: sheetFile, assetContactSheetSha256 });

    const sheetUrl = `file://${sheetPath}`;
    const opened = openInBrowser(sheetUrl);
    const rejected = manifest.assets.filter((asset) => asset.status === "rejected");

    const output = [
      `## 🖼️ ${sheetUrl}`,
      "",
      opened
        ? "גיליון הקריאייטיבים נפתח לך בדפדפן. תסתכל על כל תמונה לפני שאתה מאשר: טקסט תקין, בלי פנים מומצאות, בלי אותיות מרוסקות."
        : "פתח את הקישור למעלה ותבדוק כל תמונה לפני אישור.",
      "",
      ...plan.creatives.map((entry) => `- **${entry.file}** (${entry.mode === "presenter" ? "תמונת פרזנטור אמיתית" : entry.mode === "variation" ? "וריאציית AI מהתמונה" : "רקע מג'ונרט"}): ${entry.caption ?? ""}`),
      ...(rejected.length ? ["", `⚠️ ${rejected.length} קבצים נפסלו אוטומטית בבדיקת האיכות.`] : []),
      "",
      "אישור השער חותם את הסט; משוב מריץ סבב תיקון.",
    ].join("\n");
    await finish(output);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    await markSubTaskError(runId, STAGE, SUB_ID, errorMessage);
    if (!control?.signal.aborted) {
      eventBus.emit(runId, { type: "subtask-error", runId, stageNumber: STAGE, subTaskId: SUB_ID, errorMessage });
    }
    throw error;
  }
}
