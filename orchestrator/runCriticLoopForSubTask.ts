// orchestrator/runCriticLoopForSubTask.ts
import fs from "node:fs/promises";
import path from "node:path";
import { getRun } from "./runRegistry";
import { getSubTaskDef } from "./stageRegistry";
import { renderCopyStandard, readCopyStandard, readCriticRubric, readDesignStrategyStandard } from "./copyStandard";
import { runCriticLoop } from "./runCriticLoop";
import type { StageNumber } from "@/types";
import type { ClientProfile } from "@/config/clientProfile";
import type { ExecutionControl } from "./executionService";
import { parseCriticRubric } from "./criticRubric";
import { readRunPageTypeBlueprint } from "./pageTypeBlueprint";
import { HARVEST_DIR } from "./runStage1Harvest";
import { parseDesignBriefJson } from "./designBriefJson";

function stageOutput(run: { stages?: { number: number; subTasks: { id: string; output: string }[] }[] }, stageNumber: number, subTaskId: string): string {
  return run.stages?.find((s) => s.number === stageNumber)?.subTasks.find((t) => t.id === subTaskId)?.output ?? "";
}

/** Lines of stage 1's image table: every markdown row whose second cell starts with raw/. */
function imageTableLines(harvestOutput: string): string[] {
  return harvestOutput.split("\n").filter((l) => /^\|\s*\d+\s*\|\s*raw\//.test(l));
}

/**
 * What the current draft's image map gets wrong, in the critic's words: files
 * the harvest does not hold, and rows the 5.2 seed would reject outright (a
 * malformed harvestFile, an over-long section or proves). Every file the map
 * names is checked, including rows that are broken in another way too, because
 * a row that points at a nonexistent file must reach the critic even then.
 */
function imageMapProblems(designBrief: string, existing: readonly string[]): string {
  const parsed = parseDesignBriefJson(designBrief);
  const missing = (parsed?.harvestFiles ?? []).filter((file) => !existing.includes(file));
  const blocks: string[] = [];
  if (missing.length) blocks.push(`## קבצים שאינם קיימים (חובה לתקן)\n\n${missing.join("\n")}`);
  if (parsed?.invalidReasons.length) {
    blocks.push(`## שורות פסולות במפת התמונות (חובה לתקן)\n\n${parsed.invalidReasons.join("\n")}`);
  }
  return blocks.join("\n\n");
}

/**
 * Whose first person the page is written in, for the writer and the critic
 * alike. A tenant's copy standard is written around its own owner, and its
 * examples carry that name; a writer who reads an example as the rule puts the
 * wrong speaker on a client's page, or hedges by listing the voice as an
 * assumption for the client to approve. The profile decides it instead. The
 * block cancels no rule of the standard: it only says who the speaker is.
 * Empty for "brand-owner" and for a profile that says nothing, which is the
 * behaviour every run had before this setting existed.
 */
function voiceBlock(profile: ClientProfile | undefined): string {
  if (profile?.copy?.voice?.firstPerson !== "presenter") return "";
  return `## קול הכתיבה

הדף נכתב בגוף ראשון של המציג ששמו מופיע בבריף ובמאגר העובדות. דוגמאות בספר הכללים שמופיע בהן שמו של בעל הדייר הן דוגמאות בלבד, והן לא הופכות אותו לדובר של הדף הזה. קול הכתיבה נקבע כאן ואינו הנחה: אל תרשום אותו ברשימת ההנחות לאישור הלקוח.`;
}

export async function runCriticLoopForSubTask(runId: string, runDir: string, stageNumber: StageNumber, subTaskId: string, feedback?: string, control?: ExecutionControl): Promise<void> {
  const run = getRun(runId);
  if (!run?.stages) throw new Error(`Run ${runId} has no stages initialized`);
  const subTaskDef = getSubTaskDef(stageNumber, subTaskId, run.assetType, run.pipeline);
  if (!subTaskDef.critic) throw new Error(`Sub-task ${subTaskId} has no critic`);
  const profile = run.clientProfile;
  const rubric = parseCriticRubric(subTaskDef.critic.rubric, await readCriticRubric(profile, subTaskDef.critic.rubric));
  const maxRounds = profile?.pipeline?.criticMaxRounds ?? subTaskDef.critic.maxRounds;
  const harvest = stageOutput(run, 1, "1");

  if (stageNumber === 2) {
    const blueprint = await readRunPageTypeBlueprint(run);
    const extraContext = [
      renderCopyStandard(blueprint, "תבנית סוג הדף, גוברת על כללי מבנה כלליים").trim(),
      voiceBlock(profile),
      `## מאגר העובדות המאושר (מקור האמת היחיד לטענות)\n\n${harvest || "(אין: שלב 1 לא הפיק מאגר)"}`,
      `## תמונות זמינות\n\n${imageTableLines(harvest).join("\n") || "(אין)"}`,
    ].filter(Boolean).join("\n\n");
    return runCriticLoop({ runId, runDir, stageNumber, subTaskId, feedback, control, standard: await readCopyStandard(profile), rubric, extraContext, maxRounds });
  }
  if (stageNumber === 3) {
    const rawDir = path.join(runDir, HARVEST_DIR, "raw");
    const existing = (await fs.readdir(rawDir).catch(() => [] as string[])).sort().map((f) => `raw/${f}`);
    const extraContext = [
      `## הקופי המאושר\n\n${stageOutput(run, 2, "2")}`,
      `## טבלת התמונות והפלטה משלב 1\n\n${harvest}`,
      `## קבצים קיימים בקציר\n\n${existing.join("\n") || "(אין)"}`,
    ].join("\n\n");
    // Checked on the CURRENT draft every round: the critic sees which mapped files do not exist and which rows are unusable, and the rubric's hard rules turn both into REVISE.
    const criticContextFor = async (draft: string): Promise<string> => imageMapProblems(draft, existing);
    return runCriticLoop({ runId, runDir, stageNumber, subTaskId, feedback, control, standard: await readDesignStrategyStandard(profile), rubric, extraContext, maxRounds, criticContextFor });
  }
  throw new Error(`No critic loop wiring for stage ${stageNumber}`);
}
