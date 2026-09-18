import fs from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";
import type { ClientProfile } from "@/config/clientProfile";
import { ASSET_TYPES, type AssetType, type Run } from "@/types";

const MAX_BLUEPRINT_BYTES = 128 * 1024;

/**
 * התיקייה שבה יושבות התבניות: מהפרופיל, ואם אין, ליד קובץ הפרופיל שנטען.
 * נקראת רק ביצירת ריצה (app/api/runs/route.ts), והתוצאה נשמרת על הריצה.
 * נתיב פרופיל יחסי נפתר מול אותה תיקייה ש-loadClientProfile פותר מולה.
 */
export function resolvePageTypesDir(
  profile?: ClientProfile,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string | undefined {
  const configured = profile?.copy?.pageTypesDir;
  if (configured) return configured;
  const profilePath = env.CAMPAIGN_COUNCIL_CLIENT_PROFILE?.trim();
  if (!profilePath || profilePath.includes("\0")) return undefined;
  return path.join(path.dirname(path.resolve(cwd, profilePath)), "page-types");
}

/** התבנית של סוג הדף מתיקייה נתונה. קובץ חסר מחזיר ריק; קובץ חשוד נכשל רועש. */
export async function readPageTypeBlueprint(
  assetType: AssetType | undefined,
  dir: string | undefined,
): Promise<string> {
  if (!assetType || !ASSET_TYPES.includes(assetType)) return "";
  if (!dir || dir.includes("\0") || !path.isAbsolute(dir)) return "";

  const file = path.join(dir, `${assetType}.md`);
  const linkStat = await fs.lstat(file).catch(() => undefined);
  if (!linkStat) return "";
  if (!linkStat.isFile() || linkStat.isSymbolicLink()) {
    throw new Error(`תבנית סוג הדף ב-${file} אינה קובץ רגיל`);
  }

  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > MAX_BLUEPRINT_BYTES) {
      throw new Error(`תבנית סוג הדף ב-${file} השתנתה או חרגה ממגבלת הגודל`);
    }
    return (await handle.readFile("utf8")).trim();
  } finally {
    await handle.close();
  }
}

/**
 * הכלל היחיד לקריאת תבנית בזמן ריצה: רק מהתיקייה שנשמרה על הריצה כשנוצרה,
 * אף פעם לא מהסביבה החיה. אחרת ריצה של לקוח אחד, שממשיכה אחרי שהאפליקציה
 * הופנתה לפרופיל של לקוח אחר, מקבלת את התבניות הפרטיות שלו. ריצה ישנה בלי
 * תיקייה שמורה לא מקבלת תבנית, וממשיכה על ההוראות שבקוד.
 */
export function readRunPageTypeBlueprint(
  run: Pick<Run, "assetType" | "pageTypesDir">,
): Promise<string> {
  return readPageTypeBlueprint(run.assetType, run.pageTypesDir);
}
