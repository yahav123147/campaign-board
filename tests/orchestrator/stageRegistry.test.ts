import { describe, it, expect } from "vitest";
import { getStageDef, reconcileStages, finalCopySubTaskId } from "@/orchestrator/stageRegistry";
import { subTaskOrderViolation } from "@/orchestrator/executionOrder";
import type { Run, Stage, SubTask } from "@/types";

describe("stage 5 shape", () => {
  it("splits into brand brief, asset production, build, and local preview", () => {
    const ids = getStageDef(5).subTasks.map((st) => st.id);
    expect(ids).toEqual(["5.1", "5.2", "5.3", "5.4"]);
  });

  it("gives the brand brief real instructions, not a handler placeholder", () => {
    const brandBrief = getStageDef(5).subTasks[0];
    expect(brandBrief.instructions).not.toContain("handled by");
    expect(brandBrief.instructions.length).toBeGreaterThan(200);
  });

  it("gives asset production real instructions too", () => {
    const assets = getStageDef(5).subTasks[1];
    expect(assets.title).toContain("נכסים");
    expect(assets.instructions).not.toContain("handled by");
    expect(assets.instructions.length).toBeGreaterThan(200);
  });

  it("orders the presenter's real photos pulled from her public web presence", () => {
    // Sourcing a real photo is not generating a face. A course mockup with no
    // instructor on the screen reads as a template, not as her product.
    const assets = getStageDef(5).subTasks[1].instructions;
    expect(assets).toMatch(/תמונות אמיתיות של הפרזנטור/);
    expect(assets).toMatch(/כתובת המקור/);
    expect(assets).toMatch(/פנים של הפרזנטור/);
  });

  it("demands a mockup screen that reads as a thumbnail, not a dark title card", () => {
    // Measured on the 26.08 run: mean luminance of the screen area was 35/255
    // and two thirds of it was empty black.
    const assets = getStageDef(5).subTasks[1].instructions;
    expect(assets).toMatch(/מבחן האגודל/);
    expect(assets).toMatch(/260/);
    expect(assets).toMatch(/רבע מהמסך/);
  });

  it("picks the mockup template from the palette, not by taste", () => {
    // The collage was pulled from a bright noisy brand and applied to a dark
    // minimal one. The result read as busy and empty at the same time.
    const assets = getStageDef(5).subTasks[1].instructions;
    expect(assets).toMatch(/פלטה כהה ומינימלית/);
    expect(assets).toMatch(/עוגן דומיננטי/);
    expect(assets).toMatch(/שליש מגובה המסך/);
    expect(assets).toMatch(/כפתור פליי/);
  });

  it("forbids a front device from covering the one behind it", () => {
    const assets = getStageDef(5).subTasks[1].instructions;
    expect(assets).toMatch(/חפיפת מכשירים/);
    expect(assets).toMatch(/כותרת חתוכה/);
  });

  it("has testimonials marked up so the eye lands on the claim", () => {
    const assets = getStageDef(5).subTasks[1].instructions;
    expect(assets).toContain("marker.py");
    expect(assets).toMatch(/סימון אחד לכל צילום/);
  });

  it("says when not to cut out at all", () => {
    // A fill on a dark subject over a dark background left 1% of the photo and
    // that ghost reached a live page.
    const assets = getStageDef(5).subTasks[1].instructions;
    expect(assets).toMatch(/דמות כהה על רקע כהה/);
    expect(assets).toMatch(/אל תגזור/);
  });

  it("specifies the marketing collage template, not a clean lesson slide", () => {
    // The quality bar: cut-out presenter, layered real screenshots, themed
    // imagery, icon badges and a bold "פרק N" ribbon. Task 17 dropped the
    // product box and the drawn device: the devices come from the packaged
    // base frame now, and the agent designs the screen alone.
    const assets = getStageDef(5).subTasks[1].instructions;
    for (const required of ["גזור", "סרט כותרת", "פרק N", "באדג'ים עגולים"]) {
      expect(assets).toContain(required);
    }
    expect(assets).toContain("המכשיר עצמו מגיע ממסגרת הבסיס");
    expect(assets).not.toContain("קופסת מוצר");
  });

  it("keeps the mockup screen in the page's own palette", () => {
    // A "bright screen" rule turned the screen cream while the page was dark,
    // and the mockup read as another product's.
    const assets = getStageDef(5).subTasks[1].instructions;
    expect(assets).toMatch(/בפלטה של הדף/);
    expect(assets).toMatch(/אם הפלטה כהה, המסך כהה/);
  });

  it("makes the cut-out check a command to run, not a request to look", () => {
    // Trusting the agent's eye failed three rounds running: photos with their
    // background still on were composited straight onto the mockups.
    const assets = getStageDef(5).subTasks[1].instructions;
    expect(assets).toContain("cutout.py");
    expect(assets).toContain("check-cutout.py");
    expect(assets).toMatch(/לא נכנס למוקאפ/);
    expect(assets).toMatch(/הפנים לא נחתכות/);
  });

  it("requires a declared dependency plan so stale files and broken mockups stay out", () => {
    const assets = getStageDef(5).subTasks[1].instructions;
    expect(assets).toContain("asset-plan.json");
    expect(assets).toContain("sourceFile");
    expect(assets).toContain("inputs");
  });

  it("orders mockups produced from scratch, never copied from another project", () => {
    // The board is for new clients, who have no existing project to borrow
    // from. A mockup lifted off a reference page is not this client's product.
    const assets = getStageDef(5).subTasks[1].instructions;
    expect(assets).toContain("מאפס");
    expect(assets).toMatch(/אסור להעתיק מוקאפ/);
  });

  // Task 17: from scratch means the screens, not the mockup file. The agent
  // writes HTML screens and declares them; the orchestrator renders.
  it("hands the mockup render to the orchestrator and names the two declaration fields", () => {
    const assets = getStageDef(5).subTasks[1].instructions;
    expect(assets).toContain("screens/");
    expect(assets).toContain("sizes.json");
    expect(assets).toContain("`render`");
    expect(assets).toMatch(/האורקסטרטור מרנדר/);
    expect(assets).toMatch(/אתה לא מרכיב את קובץ המוקאפ ולא מפעיל דפדפן/);
  });
});

describe("reconcileStages", () => {
  const savedStage5: Stage = {
    number: 5,
    title: "עיצוב + בניית דף נחיתה Next.js",
    ownerSlug: "daniel-lp-designer",
    status: "error",
    output: "",
    errorMessage: "Preflight failed",
    feedbackHistory: [],
    subTasks: [
      { id: "5", title: "בניית דף נחיתה Next.js", status: "error", output: "", feedbackHistory: [] },
    ],
  };

  const approvedStage1: Stage = {
    number: 1,
    title: "מחקר שוק",
    ownerSlug: "rafael-researcher",
    status: "approved",
    output: "מסמך המחקר",
    feedbackHistory: [],
    subTasks: [
      { id: "1", title: "מסמך מחקר שוק", status: "approved", output: "מחקר", feedbackHistory: [] },
    ],
  };

  it("rebuilds a stage whose sub-tasks no longer match the registry", () => {
    const [stage5] = reconcileStages([savedStage5]);
    expect(stage5.subTasks.map((st) => st.id)).toEqual(["5.1", "5.2", "5.3", "5.4"]);
    expect(stage5.subTasks.every((st) => st.status === "pending")).toBe(true);
  });

  it("clears a stale error so the rebuilt stage can run again", () => {
    const [stage5] = reconcileStages([savedStage5]);
    expect(stage5.status).toBe("pending");
    expect(stage5.errorMessage).toBeUndefined();
  });

  it("leaves work that already matches the registry untouched", () => {
    const [stage1] = reconcileStages([approvedStage1]);
    expect(stage1).toEqual(approvedStage1);
  });

  it("keeps the output of a sub-task whose id and title both survived", () => {
    const registryTitle = getStageDef(5).subTasks[0].title;
    const partly: Stage = {
      ...savedStage5,
      subTasks: [
        { id: "5.1", title: registryTitle, status: "approved", output: "פלטה שאושרה", feedbackHistory: [] },
      ],
    };
    const [stage5] = reconcileStages([partly]);
    expect(stage5.subTasks[0]).toMatchObject({ id: "5.1", status: "approved", output: "פלטה שאושרה" });
    expect(stage5.subTasks[1].status).toBe("pending");
  });

  it("does not carry work across an id that was reused for a different job", () => {
    // 5.2 used to be the build; it is now asset production. Same id, new job.
    const reused: Stage = {
      ...savedStage5,
      subTasks: [
        { id: "5.2", title: "בניית דף נחיתה Next.js", status: "approved", output: "הדף הישן", feedbackHistory: [] },
      ],
    };
    const [stage5] = reconcileStages([reused]);
    const assets = stage5.subTasks.find((st) => st.id === "5.2")!;
    expect(assets.status).toBe("pending");
    expect(assets.output).toBe("");
  });

  it("בונה מחדש שלב שהכותרות שלו השתנו, גם כשהמזהים זהים", () => {
    // כותרות "ישנות" שאינן קיימות ברג'יסטרי היום, כדי שהבדיקה תיפול על שינוי
    // כותרת אמיתי ולא במקרה תואם את הכותרות הנוכחיות של שלב 4 בסקוויז.
    const savedSqueeze: Stage = {
      number: 4, title: "קופי לדף סקוויז", ownerSlug: "maya-lp-copywriter",
      status: "pending", output: "", feedbackHistory: [],
      subTasks: [
        { id: "4a", title: "Hero + Promise (ישן)", status: "approved", output: "הירו ישן", feedbackHistory: [] },
        { id: "4b", title: "רשימת תועלות (ישן)", status: "pending", output: "", feedbackHistory: [] },
        { id: "4c", title: "סמכות + CTA סופי (ישן)", status: "pending", output: "", feedbackHistory: [] },
      ],
    };
    const [stage4] = reconcileStages([savedSqueeze], "squeeze-page");
    expect(stage4.subTasks.map((st) => st.title)).toEqual(
      getStageDef(4, "squeeze-page").subTasks.map((st) => st.title),
    );
    expect(stage4.subTasks.every((st) => st.status === "pending")).toBe(true);
  });

  it("לא נוגע בשלב שכבר אושר, גם כשהשלד השתנה", () => {
    // כותרות "ישנות" שאינן קיימות ברג'יסטרי היום, כדי שהשלד יהיה במפורש לא
    // תואם. בלי זה ה-shape כבר תואם והבדיקה לא הייתה מוכיחה כלום על ההקפאה.
    const approvedOldSqueeze: Stage = {
      number: 4, title: "קופי לדף סקוויז", ownerSlug: "maya-lp-copywriter",
      status: "approved", output: "הדף שנבנה ממנו", feedbackHistory: [],
      subTasks: [
        { id: "4a", title: "Hero + Promise (ישן)", status: "approved", output: "הירו", feedbackHistory: [] },
        { id: "4b", title: "רשימת תועלות (ישן)", status: "approved", output: "תועלות", feedbackHistory: [] },
        { id: "4c", title: "סמכות + CTA סופי (ישן)", status: "approved", output: "סמכות", feedbackHistory: [] },
      ],
    };
    expect(reconcileStages([approvedOldSqueeze], "squeeze-page")[0]).toEqual(approvedOldSqueeze);
  });
});

/**
 * A1 / F3: a rebuilt stage used to keep or reset every sub-task on its own.
 * When an early sub-task was reset and a later one kept its progressed status,
 * the early one could not run (a later sub-task had progressed) and the later
 * one could not be reopened (an earlier one had not finished). The run was
 * stuck. The titles below are the real old squeeze titles from a saved run.
 */
describe("reconcileStages resets every sub-task after the first reset", () => {
  const OLD_SQUEEZE_TITLES = ["Hero + Promise", "רשימת תועלות", "סמכות + CTA סופי"] as const;

  function approvedStage(number: Stage["number"]): Stage {
    return {
      number, title: `שלב ${number}`, ownerSlug: "rafael-researcher",
      status: "approved", output: `פלט ${number}`, feedbackHistory: [],
      subTasks: [{ id: String(number), title: "משימה", status: "approved", output: "פלט", feedbackHistory: [] }],
    };
  }

  function squeezeRun(stage4: Stage): Run {
    return {
      id: "2026-09-06-141304", slug: "squeeze", brief: "בריף", createdAt: "2026-09-06T14:13:04.000Z",
      status: "approved", currentRound: null, messages: [], assetType: "squeeze-page",
      stages: [approvedStage(1), approvedStage(2), approvedStage(3), stage4],
      currentStage: 4,
    };
  }

  function oldSqueezeStage4(statuses: readonly SubTask["status"][]): Stage {
    return {
      number: 4, title: "קופי לדף סקוויז", ownerSlug: "maya-lp-copywriter",
      status: "running", output: "", feedbackHistory: [],
      subTasks: OLD_SQUEEZE_TITLES.map((title, i) => ({
        id: ["4a", "4b", "4c"][i]!,
        title,
        status: statuses[i]!,
        output: statuses[i] === "pending" ? "" : `טיוטה ${i}`,
        draftOutput: statuses[i] === "pending" ? undefined : `טיוטה ${i}`,
        critiques: statuses[i] === "pending" ? undefined : [],
        feedbackHistory: [],
      })),
    };
  }

  it("unlocks the real saved shape: 4a approved, 4b awaiting-decision, 4c pending", () => {
    const saved = oldSqueezeStage4(["approved", "awaiting-decision", "pending"]);
    const [stage4] = reconcileStages([saved], "squeeze-page");

    expect(stage4.subTasks.map((st) => st.status)).toEqual(["pending", "pending", "pending"]);
    expect(stage4.subTasks.map((st) => st.output)).toEqual(["", "", ""]);
    // 4b kept its title, so it keeps its identity, but its old work is cleared
    // with the same rule reopenSubTask applies.
    expect(stage4.subTasks[1]).toMatchObject({ id: "4b", title: "רשימת תועלות" });
    expect(stage4.subTasks[1].draftOutput).toBeUndefined();
    expect(stage4.subTasks[1].critiques).toBeUndefined();

    const run = squeezeRun(stage4);
    expect(subTaskOrderViolation(run, 4, "4a")).toBeUndefined();
  });

  it("migrates the real old squeeze titles onto the real current squeeze registry", () => {
    const saved = oldSqueezeStage4(["approved", "awaiting-decision", "pending"]);
    const [stage4] = reconcileStages([saved], "squeeze-page");
    const current = getStageDef(4, "squeeze-page").subTasks;

    expect(stage4.subTasks.map((st) => ({ id: st.id, title: st.title }))).toEqual(
      current.map((def) => ({ id: def.id, title: def.title })),
    );
    // Only 4b's title survived the rewrite; the other two really changed.
    expect(current.map((def) => def.title === OLD_SQUEEZE_TITLES[current.indexOf(def)])).toEqual([
      false, true, false,
    ]);
    expect(stage4.status).toBe("pending");
    // Running again from the start is allowed; nothing later blocks it.
    const run = squeezeRun(stage4);
    for (const id of ["4a"]) expect(subTaskOrderViolation(run, 4, id)).toBeUndefined();
    expect(subTaskOrderViolation(run, 4, "4b")).toMatch(/4a must finish first/);
  });

  it("keeps work before the first changed sub-task and resets everything after it", () => {
    const current = getStageDef(4, "squeeze-page").subTasks;
    const saved: Stage = {
      number: 4, title: "קופי לדף סקוויז", ownerSlug: "maya-lp-copywriter",
      status: "running", output: "", feedbackHistory: [],
      subTasks: [
        { id: "4a", title: current[0]!.title, status: "approved", output: "הירו מאושר", feedbackHistory: [] },
        { id: "4b", title: "רשימת תועלות (ישן)", status: "approved", output: "תועלות ישנות", feedbackHistory: [] },
        { id: "4c", title: current[2]!.title, status: "awaiting-decision", output: "טופס", feedbackHistory: ["משוב"] },
      ],
    };
    const [stage4] = reconcileStages([saved], "squeeze-page");

    expect(stage4.subTasks[0]).toMatchObject({ id: "4a", status: "approved", output: "הירו מאושר" });
    expect(stage4.subTasks[1]).toMatchObject({ id: "4b", status: "pending", output: "" });
    expect(stage4.subTasks[2]).toMatchObject({ id: "4c", status: "pending", output: "", feedbackHistory: ["משוב"] });
    expect(subTaskOrderViolation(squeezeRun(stage4), 4, "4b")).toBeUndefined();
  });

  it("does not leave a later approved sub-task behind when an earlier approved one was renamed", () => {
    const saved = oldSqueezeStage4(["approved", "approved", "pending"]);
    const [stage4] = reconcileStages([saved], "squeeze-page");

    expect(stage4.subTasks.map((st) => st.status)).toEqual(["pending", "pending", "pending"]);
    const run = squeezeRun(stage4);
    expect(subTaskOrderViolation(run, 4, "4a")).toBeUndefined();
  });
});

/**
 * A title comparison is only meaningful where a page type rewrote its own
 * stage-4 skeleton. Everywhere else a title is cosmetic: the stage-8 title
 * really changed in history ("אימות פיקסל + setup" became the current one on
 * 28.08), and resetting unapproved work over that locked the decide route.
 */
describe("reconcileStages compares titles only in stage 4 of a type with its own skeleton", () => {
  function unapprovedStage(
    number: Stage["number"],
    subTasks: readonly { id: string; title: string }[],
    status: SubTask["status"] = "awaiting-decision",
  ): Stage {
    return {
      number, title: `שלב ${number}`, ownerSlug: "rafael-researcher",
      status: "running", output: "", feedbackHistory: [],
      subTasks: subTasks.map((task, i) => ({
        id: task.id,
        title: task.title,
        status: i === 0 ? status : "pending",
        output: i === 0 ? "עבודה שמורה" : "",
        feedbackHistory: [],
      })),
    };
  }

  it("leaves an unapproved stage 8 with the old title untouched", () => {
    const saved = unapprovedStage(8, [{ id: "8", title: "אימות פיקסל + setup" }]);
    expect(getStageDef(8).subTasks.map((def) => def.id)).toEqual(["8"]);
    expect(reconcileStages([saved])[0]).toEqual(saved);
  });

  it("leaves an unapproved sales-page stage 4 with matching ids and drifted titles untouched", () => {
    const current = getStageDef(4, "sales-page").subTasks;
    const saved = unapprovedStage(4, current.map((def) => ({ id: def.id, title: `${def.title} (ישן)` })), "approved");
    expect(reconcileStages([saved], "sales-page")[0]).toEqual(saved);
  });

  it("leaves an unapproved stage 5 with matching ids and a drifted title untouched", () => {
    const current = getStageDef(5).subTasks;
    const saved = unapprovedStage(5, current.map((def, i) => ({ id: def.id, title: i === 0 ? "בריף מותג (ישן)" : def.title })));
    expect(reconcileStages([saved])[0]).toEqual(saved);
    // The same stage 5 inside a squeeze run is not its stage 4, so it is untouched too.
    expect(reconcileStages([saved], "squeeze-page")[0]).toEqual(saved);
  });

  it("still rebuilds a webinar-page stage 4 whose ids match but a title drifted", () => {
    const current = getStageDef(4, "webinar-page").subTasks;
    const saved = unapprovedStage(
      4,
      current.map((def, i) => ({ id: def.id, title: i === 0 ? `${def.title} (ישן)` : def.title })),
      "approved",
    );
    const [stage4] = reconcileStages([saved], "webinar-page");
    expect(stage4.subTasks.map((st) => ({ id: st.id, title: st.title }))).toEqual(
      current.map((def) => ({ id: def.id, title: def.title })),
    );
    expect(stage4.subTasks.every((st) => st.status === "pending" && st.output === "")).toBe(true);
  });
});

describe("Stage 7-9 publishing safety", () => {
  it("keeps paid Meta ads eligible to run on Saturday", () => {
    const stage7 = getStageDef(7).subTasks.map((task) => task.instructions).join("\n");
    expect(stage7).toContain("7 ימים, כולל שבת");
    expect(stage7).not.toContain("אסור שבת");
  });

  it("describes Stage 8 as typed read-only verification with no skip", () => {
    const stage8 = getStageDef(8);
    expect(stage8.title).toContain("קריאה בלבד");
    expect(stage8.subTasks[0].instructions).toContain("typed");
    expect(stage8.subTasks[0].instructions).toContain("had_pii");
    expect(stage8).not.toHaveProperty("conditional");
  });

  it("describes Stage 9 as a plan, not campaign creation", () => {
    const stage9 = getStageDef(9);
    expect(stage9.title).toContain("ללא ביצוע");
    expect(stage9.subTasks[0].title).toContain("תוכנית");
    expect(stage9.subTasks[0].title).not.toContain("יצירת קמפיין");
  });
});

describe("finalCopySubTaskId (F101)", () => {
  it("returns the human copy gate per asset type", () => {
    expect(finalCopySubTaskId("sales-page")).toBe("4e");
    expect(finalCopySubTaskId("squeeze-page")).toBe("4c");
  });
});
