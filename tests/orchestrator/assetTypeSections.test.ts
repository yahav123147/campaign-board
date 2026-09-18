import { describe, it, expect } from "vitest";
import {
  assetPreambleFor,
  finalCopySubTaskId,
  getStageDef,
  getSubTaskDef,
  pageCopyForBuild,
  reconcileStages,
  stageRegistryFor,
} from "@/orchestrator/stageRegistry";
import { renderMissingPageTypeBlueprintWarning } from "@/orchestrator/runStage5Assets";
import { isAssetType, ASSET_TYPES } from "@/types";
import type { Stage } from "@/types";

const salesStage4 = () => getStageDef(4, "sales-page");
const squeezeStage4 = () => getStageDef(4, "squeeze-page");

/**
 * A squeeze page whose only ask is "watch this" has no stack, no price and no
 * guarantee. Handing it the sales-page section set made the writers produce
 * tables of missing data instead of copy, because the sections asked for
 * material that does not exist for a free offer.
 */
describe("stage 4 writes the sections the chosen page actually has", () => {
  it("keeps stack and risk reversal on a sales page", () => {
    const titles = salesStage4().subTasks.map((task) => task.title);
    expect(titles).toContain("Stack: מה מקבלים");
    expect(titles).toContain("Risk Reversal + FAQ + CTA סופי");
  });

  it("gives a squeeze page the house structure: hero, benefits, form block + authority, no pain section", () => {
    const titles = squeezeStage4().subTasks.map((task) => task.title);
    expect(titles).toEqual(["Hero + הבטחה + שורת נכס + CTA", "רשימת תועלות", "בלוק הטופס + סמכות"]);
    expect(titles).not.toContain("Stack: מה מקבלים");
    expect(titles).not.toContain("הבעיה, במילים של הקורא");
  });

  it("tells the squeeze writer there is no money and no objection handling on the page", () => {
    const finalSection = getSubTaskDef(4, "4c", "squeeze-page").instructions;
    expect(finalSection).toContain("בלי מחיר, בלי ערבות, בלי stack, בלי FAQ, בלי התנגדויות");
    expect(getSubTaskDef(4, "4b", "squeeze-page").instructions).toContain("אסור: סקציית כאב");
  });

  it("leaves every other stage identical between the two", () => {
    const sales = stageRegistryFor("sales-page");
    const squeeze = stageRegistryFor("squeeze-page");
    for (const stage of sales) {
      if (stage.number === 4) continue;
      expect(squeeze.find((s) => s.number === stage.number)).toBe(stage);
    }
  });

  it("defaults to the sales page for runs saved before the choice existed", () => {
    expect(getStageDef(4)).toBe(salesStage4());
    expect(reconcileStages([])).toEqual([]);
  });

  it("reconciles a saved squeeze run against the squeeze sections", () => {
    const saved: Stage[] = [{
      number: 4,
      title: "קופי לדף סקוויז",
      ownerSlug: "maya-lp-copywriter",
      status: "pending",
      output: "",
      feedbackHistory: [],
      subTasks: [
        { id: "4a", title: "Hero + הבטחה + שורת נכס + CTA", status: "approved", output: "כותרת", feedbackHistory: [] },
      ],
    }];
    const [stage] = reconcileStages(saved, "squeeze-page");
    expect(stage.subTasks.map((task) => task.id)).toEqual(["4a", "4b", "4c"]);
    // Approved work keeps its output through the reconcile.
    expect(stage.subTasks[0].output).toBe("כותרת");
  });

  it("rejects an unknown asset type at the boundary", () => {
    expect(isAssetType("squeeze-page")).toBe(true);
    expect(isAssetType("sales-page")).toBe(true);
    expect(isAssetType("webinar")).toBe(false);
    expect(isAssetType(undefined)).toBe(false);
  });
});

/**
 * The line above the H1 does one of two jobs and the writer picks by which
 * lever the move actually has: an authority fact that survives a cold reader,
 * or a tee-up that stretches him into the headline. It never opens with pain,
 * and it is never invented when the material carries neither.
 */
describe("the hero carries an eyebrow above the headline", () => {
  it.each([["sales-page"], ["squeeze-page"]] as const)("%s asks for one", (assetType) => {
    const hero = getSubTaskDef(4, "4a", assetType).instructions;
    expect(hero).toContain("שורת פתיחה מעל הכותרת");
    expect(hero).toContain("(א) **סמכות.**");
    expect(hero).toContain("(ב) **הרמה להנחתה.**");
  });

  it.each([["sales-page"], ["squeeze-page"]] as const)("%s hands off to the headline with a colon", (assetType) => {
    const hero = getSubTaskDef(4, "4a", assetType).instructions;
    expect(hero).toContain("מסתיימת בנקודתיים ומוסרת את המקל לכותרת");
    expect(hero).toContain("קייסטאדי חדש חושף:");
    // A badge row of attributes is the failure mode this replaces.
    expect(hero).toContain("אינה תג ואינה רשימת מאפיינים");
  });

  it.each([["sales-page"], ["squeeze-page"]] as const)("%s forbids repeating the headline", (assetType) => {
    const hero = getSubTaskDef(4, "4a", assetType).instructions;
    expect(hero).toContain("לא חוזרת על שום מילה שהכותרת כבר נושאת");
    // A name only earns the line when a cold reader already knows it.
    expect(hero).toContain("שם אדם בשורה רק אם הוא מוכר");
  });

  it.each([["sales-page"], ["squeeze-page"]] as const)("%s forbids opening on pain", (assetType) => {
    expect(getSubTaskDef(4, "4a", assetType).instructions)
      .toContain("לעולם לא נפתחת בכאב");
  });

  it.each([["sales-page"], ["squeeze-page"]] as const)("%s marks it missing instead of inventing", (assetType) => {
    expect(getSubTaskDef(4, "4a", assetType).instructions)
      .toContain("[נדרשת שורת פתיחה: עובדת סמכות מאושרת או עובדה לניגוד]");
  });

  it.each([["sales-page"], ["squeeze-page"]] as const)("%s bans an unverifiable title", (assetType) => {
    expect(getSubTaskDef(4, "4a", assetType).instructions)
      .toContain("אסור תואר שאי אפשר לאמת");
  });
});

/**
 * Two real squeeze pages (89 and 149 words) converted through a form block
 * with its own heading, instruction, fields, button, reassurance line and an
 * unchecked opt-in checkbox. The old skeleton never named that section, so
 * stage 4 never wrote the words closest to the money.
 */
describe("stage 4 squeeze page gets a form block, not just authority", () => {
  it("נותן לדף הסקוויז בלוק טופס, לא רק סמכות", () => {
    const titles = getStageDef(4, "squeeze-page").subTasks.map((t) => t.title);
    expect(titles).toEqual(["Hero + הבטחה + שורת נכס + CTA", "רשימת תועלות", "בלוק הטופס + סמכות"]);
    const form = getSubTaskDef(4, "4c", "squeeze-page").instructions;
    expect(form).toContain("צ'קבוקס");
    expect(form).toContain("אינו מסומן מראש");
    expect(form).toContain("בלי מחיר, בלי ערבות, בלי stack, בלי FAQ, בלי התנגדויות");
  });

  it("מבקש שורת נכס ומיקרו-קופי בהירו, ואוסר להמציא זמן הגעה", () => {
    const hero = getSubTaskDef(4, "4a", "squeeze-page").instructions;
    expect(hero).toContain("שורת הנכס");
    expect(hero).toContain("[נדרש: סוג הנכס החינמי, שם ואורך]");
    expect(hero).toContain("אסור להמציא זמן הגעה");
    expect(hero).toContain("שלושה מצבים");
  });
});

describe("no stage 4 section may produce em-dashes", () => {
  it.each([
    ["sales-page"], ["squeeze-page"], ["premium-lead-page"], ["webinar-page"], ["upsell-page"],
  ] as const)("%s", (assetType) => {
    for (const task of getStageDef(4, assetType).subTasks) {
      expect(task.instructions, task.title).toContain("אל תשתמש ב-em-dashes");
    }
  });
});

describe("asset type selection", () => {
  it("מכיר בחמשת סוגי הדף", () => {
    expect([...ASSET_TYPES]).toEqual([
      "sales-page", "premium-lead-page", "webinar-page", "squeeze-page", "upsell-page",
    ]);
    expect(isAssetType("webinar-page")).toBe(true);
    expect(isAssetType("landing-page")).toBe(false);
  });
});

/**
 * A premium-lead page recruits applications for a fit call; it never sells on
 * the page. The product owner ruled "who this is not for" mandatory (design
 * doc section 3), and missing sales-team criteria must be marked, never
 * invented. The final sub-task also carries the page's ban on a fixed seat
 * counter and on price.
 */
describe("premium lead page stage 4", () => {
  it("מחייב בדף ליד פרימיום גם מי לא מתאים, ואוסר מחיר ועוגן", () => {
    const ids = getStageDef(4, "premium-lead-page").subTasks.map((t) => t.id);
    expect(ids).toEqual(["4a", "4b", "4c", "4d", "4e"]);
    expect(finalCopySubTaskId("premium-lead-page")).toBe("4e");
    const fit = getSubTaskDef(4, "4b", "premium-lead-page").instructions;
    expect(fit).toContain("זה לא בשבילך אם");
    expect(fit).toContain("[נדרש: קריטריוני אי-התאמה מצוות המכירות]");
    const close = getSubTaskDef(4, "4e", "premium-lead-page").instructions;
    expect(close).toContain("בלי מונה מקומות");
    expect(close).toMatch(/אסור:.*מחיר/);
  });
});

/**
 * A webinar page sells an hour, not a purchase, and has two conversions:
 * registration and show-up. The design doc (section 5.2) splits the old
 * combined 4d into 4d (registration, final CTA, logistics questions) and 4e
 * (confirmation and thank-you copy), and 4e is flagged excludeFromPage so the
 * builder never puts "your seat is saved" into the registration page itself.
 * finalCopySubTaskId must derive 4e from the registry, never a hard-coded id.
 */
describe("webinar page stage 4", () => {
  it("מפריד את קופי דף התודה מהדף עצמו", () => {
    const subs = getStageDef(4, "webinar-page").subTasks;
    expect(subs.map((t) => t.id)).toEqual(["4a", "4b", "4c", "4d", "4e"]);
    expect(subs.at(-1)!.excludeFromPage).toBe(true);
    expect(finalCopySubTaskId("webinar-page")).toBe("4e");
    expect(subs.at(-1)!.instructions).toContain("הוספה ליומן");
  });

  it("מחייב פרטי שידור מלאים ואוסר להבטיח הקלטה בלי אישור", () => {
    const hero = getSubTaskDef(4, "4a", "webinar-page").instructions;
    expect(hero).toContain("[נדרש: שעה ואזור זמן]");
    expect(hero).toContain("אזור זמן");
    expect(getSubTaskDef(4, "4d", "webinar-page").instructions).toContain("אסור להבטיח הקלטה");
  });
});

/**
 * An upsell page only exists inside a checkout session: nobody reaches it
 * from an ad. The run ends after stage 5 builds the page, so stages 6 to 9
 * (ad angles, ad copy and creatives, pixel verification, campaign plan) never
 * run for this type. Stage 4 opens on the order state, not the eyebrow and
 * big-promise formula every other type uses.
 */
describe("upsell page stage 4 and stage list", () => {
  it("מסיים ריצת אפסייל אחרי בניית הדף", () => {
    expect(stageRegistryFor("upsell-page").map((s) => s.number)).toEqual([1, 2, 3, 4, 5]);
    expect(finalCopySubTaskId("upsell-page")).toBe("4c");
  });

  it("פותח את דף האפסייל במצב ההזמנה ולא בהבטחה גדולה", () => {
    const open = getSubTaskDef(4, "4a", "upsell-page").instructions;
    expect(open).toContain("הקורא כבר קנה");
    expect(open).toContain("[נדרש: מבנה המשפך אחרי הדף, כמה שלבים ומה בכל אחד]");
    const decide = getSubTaskDef(4, "4c", "upsell-page").instructions;
    expect(decide).toContain("[נדרש: מנגנון החיוב אחרי הרכישה]");
  });
});

/**
 * Stage 5.2's instructions were written for a sales page, where every module
 * gets a mockup. A webinar, squeeze or upsell page has no modules, so those
 * instructions must not survive unqualified into the asset prompt.
 */
describe("stage 5.2 asset preamble knows which page it serves", () => {
  it("לא מבקש מוקאפ לכל מודול בדף שאין בו מודולים", () => {
    expect(assetPreambleFor("sales-page")).toContain("מוקאפ לכל מודול");
    expect(assetPreambleFor("premium-lead-page")).toContain("מוקאפ לכל מודול");
    for (const type of ["webinar-page", "squeeze-page", "upsell-page"] as const) {
      expect(assetPreambleFor(type)).not.toContain("מוקאפ לכל מודול");
      expect(assetPreambleFor(type)).toContain("סעיף הנכסים בתבנית סוג הדף");
    }
  });

  it("defaults to the sales page preamble", () => {
    expect(assetPreambleFor()).toBe(assetPreambleFor("sales-page"));
  });
});

/**
 * Stage 5.2 asks Daniel to produce assets for a page type, and the section
 * 4.3 spec requires the same visible warning stage 4 already gives (F
 * page-types) when a non sales-page run has no blueprint file on disk: the
 * run is not blocked, but the operator needs to see why the assets came out
 * as if for a plain sales page.
 */
describe("stage 5.2 warns when a non sales-page run has no blueprint on disk", () => {
  it("warns for a page type that should carry a blueprint but has none", () => {
    expect(renderMissingPageTypeBlueprintWarning("upsell-page", "")).toBe(
      "⚠️ תבנית סוג הדף (upsell-page) לא נמצאה. ממשיכים על ההוראות שבקוד.\n",
    );
  });

  it("says nothing once a blueprint is found", () => {
    expect(renderMissingPageTypeBlueprintWarning("upsell-page", "## מבנה\nתוכן")).toBe("");
  });

  it("says nothing for a sales page, which has no blueprint by design", () => {
    expect(renderMissingPageTypeBlueprintWarning("sales-page", "")).toBe("");
  });

  it("says nothing for a legacy run with no asset type at all", () => {
    expect(renderMissingPageTypeBlueprintWarning(undefined, "")).toBe("");
  });
});

/**
 * A webinar page's last stage-4 sub-task will be the thank-you page copy
 * (Task 10): text like "your seat is saved", which belongs to the
 * confirmation flow and must never be rendered into the registration page
 * itself. `excludeFromPage` on a SubTaskDef is how a page type marks such a
 * sub-task, and `pageCopyForBuild` is what the stage 5.3 builder actually
 * reads instead of the raw stage output.
 */
describe("the copy the builder receives skips sub-tasks marked excludeFromPage", () => {
  it("לא מכניס לקופי לבנייה חלק שסומן ככזה שלא נבנה בדף", () => {
    // Task 10 registers a dedicated webinar-page stage 4 whose last sub-task
    // carries excludeFromPage for real. Until then, "webinar-page" falls back
    // to the same shared stage-4 def as every other non-squeeze type, so this
    // test flags one of its real sub-task defs for the duration of the
    // assertion and restores it immediately after, to exercise the actual
    // getStageDef -> pageCopyForBuild path rather than a hand-rolled filter.
    const def = getStageDef(4, "sales-page").subTasks.find((task) => task.id === "4e")!;
    expect(def.excludeFromPage).toBeUndefined();
    def.excludeFromPage = true;
    try {
      const run = {
        assetType: "webinar-page" as const,
        stages: [{
          number: 4 as const, title: "קופי לדף וובינר", ownerSlug: "maya-lp-copywriter" as const,
          status: "approved" as const, output: "", feedbackHistory: [],
          subTasks: [
            { id: "4a", title: "x", status: "approved" as const, output: "הירו", feedbackHistory: [] },
            { id: "4e", title: "y", status: "approved" as const, output: "המקום שלך שמור", feedbackHistory: [] },
          ],
        }],
      };
      const copy = pageCopyForBuild(run as never);
      expect(copy).toContain("הירו");
      expect(copy).not.toContain("המקום שלך שמור");
    } finally {
      delete def.excludeFromPage;
    }
  });

  it("builds the full joined stage 4 copy for every type that marks no sub-task excludeFromPage", () => {
    for (const assetType of ["sales-page", "premium-lead-page", "squeeze-page", "upsell-page"] as const) {
      const subTasks = getStageDef(4, assetType).subTasks.map((def, i) => ({
        id: def.id,
        title: def.title,
        status: "approved" as const,
        output: `output-${i}`,
        feedbackHistory: [],
      }));
      const run = {
        assetType,
        stages: [{
          number: 4 as const,
          title: "קופי",
          ownerSlug: "maya-lp-copywriter" as const,
          status: "approved" as const,
          output: "",
          feedbackHistory: [],
          subTasks,
        }],
      };
      // This is exactly what `finalizeStageIfComplete` in runStage.ts assembles
      // into `stage.output` (same separator), i.e. what the builder read before
      // this task existed.
      const expected = subTasks.map((task) => task.output).join("\n\n---\n\n");
      expect(pageCopyForBuild(run as never)).toBe(expected);
    }
  });

  /**
   * finalizeStageIfComplete (orchestrator/runStage.ts:90) joins every
   * sub-task's output unconditionally, empty ones included, into the
   * persisted stage.output the old code read. pageCopyForBuild must match
   * that exactly for anything not flagged excludeFromPage, including the one
   * case where an approved sub-task's output is an empty string: dropping it
   * would silently disagree with the persisted value for the same stage.
   */
  it("matches finalizeStageIfComplete's join when an approved sub-task has an empty output", () => {
    const subTasks = getStageDef(4, "sales-page").subTasks.map((def, i) => ({
      id: def.id,
      title: def.title,
      status: "approved" as const,
      output: i === 1 ? "" : `output-${i}`,
      feedbackHistory: [],
    }));
    const run = {
      assetType: "sales-page" as const,
      stages: [{
        number: 4 as const,
        title: "קופי",
        ownerSlug: "maya-lp-copywriter" as const,
        status: "approved" as const,
        output: "",
        feedbackHistory: [],
        subTasks,
      }],
    };
    // The same unconditional join finalizeStageIfComplete performs: no falsy
    // filter, so the empty segment survives with its separators on both sides.
    const expected = subTasks.map((task) => task.output).join("\n\n---\n\n");
    expect(pageCopyForBuild(run as never)).toBe(expected);
  });

  it("returns an empty string, not a crash, when the run has no stage 4", () => {
    const run = { assetType: "sales-page" as const, stages: [] };
    expect(pageCopyForBuild(run as never)).toBe("");
  });

  it("returns an empty string when the run has no stages at all", () => {
    const run = { assetType: "sales-page" as const };
    expect(pageCopyForBuild(run as never)).toBe("");
  });
});
