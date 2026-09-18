import { describe, it, expect } from "vitest";
import { buildPriorContext } from "@/orchestrator/runSubTask";
import { getStageDef } from "@/orchestrator/stageRegistry";
import type { Run } from "@/types";

/**
 * Task 10: a webinar page's stage 4 ends with confirmation/thank-you copy
 * (4e) flagged excludeFromPage, so it never renders into the registration
 * page. `pageCopyForBuild` already keeps it out of the page. But
 * `buildPriorContext` (orchestrator/runSubTask.ts) used to hand a later
 * stage the whole approved stage output, thank-you copy included, so stage
 * 5.1's brand brief and stage 6's ad angles would still see "your seat is
 * saved" even though no one registered yet in that context. This file proves
 * the fix: flagged sub-tasks are filtered out of prior context too, while
 * still being written, approved, saved and shown in the run itself (that
 * part is unchanged and covered by assetTypeSections.test.ts's
 * pageCopyForBuild suite).
 */
function webinarRun(): Run {
  return {
    id: "test-webinar-run",
    slug: "webinar-test",
    brief: "בריף לבדיקה",
    createdAt: "2026-09-12T10:00:00.000Z",
    status: "awaiting-decision",
    currentRound: null,
    messages: [],
    assetType: "webinar-page",
    stages: [
      {
        number: 4,
        title: "קופי לדף וובינר",
        ownerSlug: "maya-lp-copywriter",
        status: "approved",
        output: "הירו\n\n---\n\nגילויים\n\n---\n\nסמכות\n\n---\n\nטופס הרשמה\n\n---\n\nהמקום שלך שמור",
        feedbackHistory: [],
        subTasks: [
          { id: "4a", title: "Hero + פרטי השידור", status: "approved", output: "הירו", feedbackHistory: [] },
          { id: "4b", title: "מה תגלה בשידור + למי זה", status: "approved", output: "גילויים", feedbackHistory: [] },
          { id: "4c", title: "המנחה: סמכות והוכחה", status: "approved", output: "סמכות", feedbackHistory: [] },
          { id: "4d", title: "הרשמה + CTA סופי + שאלות לוגיסטיות", status: "approved", output: "טופס הרשמה", feedbackHistory: [] },
          { id: "4e", title: "קופי אישור ודף תודה", status: "approved", output: "המקום שלך שמור", feedbackHistory: [] },
        ],
      },
    ],
  } as Run;
}

describe("buildPriorContext skips an approved stage whose output is only separators", () => {
  // A4: joining several empty sub-task outputs gives "\n\n---\n\n...", which is
  // truthy, so a stage header used to be pushed with nothing under it.
  it("does not push a header for an approved stage whose sub-task outputs are all empty", () => {
    const run = webinarRun();
    const stage4 = run.stages![0]!;
    run.stages = [{
      ...stage4,
      output: "",
      subTasks: stage4.subTasks.map((task) => ({ ...task, output: "" })),
    }];

    expect(buildPriorContext(run, 5, "5.1")).toBe("(אין שלבים קודמים)");
  });

  it("still includes a stage when at least one sub-task has content", () => {
    const run = webinarRun();
    const stage4 = run.stages![0]!;
    run.stages = [{
      ...stage4,
      subTasks: stage4.subTasks.map((task) => ({ ...task, output: task.id === "4c" ? "סמכות" : "" })),
    }];

    const context = buildPriorContext(run, 5, "5.1");
    expect(context).toContain("### שלב 4");
    expect(context).toContain("סמכות");
  });
});

describe("buildPriorContext filters excludeFromPage sub-tasks out of later prompts", () => {
  it("keeps the webinar thank-you copy out of stage 5's brand-brief prior context", () => {
    const context = buildPriorContext(webinarRun(), 5, "5.1");
    expect(context).toContain("הירו");
    expect(context).toContain("טופס הרשמה");
    expect(context).not.toContain("המקום שלך שמור");
  });

  it("keeps the webinar thank-you copy out of stage 6's ad-angles prior context", () => {
    const context = buildPriorContext(webinarRun(), 6, "6");
    expect(context).toContain("סמכות");
    expect(context).not.toContain("המקום שלך שמור");
  });

  it("still surfaces the stage normally when nothing is flagged (sales page unaffected)", () => {
    const run: Run = {
      id: "test-sales-run",
      slug: "sales-test",
      brief: "בריף",
      createdAt: "2026-09-12T10:00:00.000Z",
      status: "awaiting-decision",
      currentRound: null,
      messages: [],
      assetType: "sales-page",
      stages: [
        {
          number: 4,
          title: "קופי לדף מכירה",
          ownerSlug: "maya-lp-copywriter",
          status: "approved",
          output: "הירו\n\n---\n\nסיפור",
          feedbackHistory: [],
          subTasks: [
            { id: "4a", title: "Hero + Promise", status: "approved", output: "הירו", feedbackHistory: [] },
            { id: "4b", title: "סיפור המייסד, הצוות או המותג", status: "approved", output: "סיפור", feedbackHistory: [] },
          ],
        },
      ],
    } as Run;
    const context = buildPriorContext(run, 5, "5.1");
    expect(context).toContain("הירו");
    expect(context).toContain("סיפור");
  });

  /**
   * The within-stage branch (later sub-task of the SAME stage reading earlier
   * approved sub-tasks) must skip a flagged sub-task too, not just the
   * cross-stage branch. Webinar's real 4e sits last so this path is never hit
   * on real data; this test flags 4a of the real registry temporarily (same
   * technique assetTypeSections.test.ts uses) to exercise the branch directly.
   */
  it("also skips a flagged sub-task inside the same stage's own prior context", () => {
    const def = getStageDef(4, "webinar-page").subTasks.find((t) => t.id === "4a")!;
    expect(def.excludeFromPage).toBeUndefined();
    def.excludeFromPage = true;
    try {
      const run: Run = {
        id: "test-webinar-samestage",
        slug: "webinar-samestage",
        brief: "בריף",
        createdAt: "2026-09-12T10:00:00.000Z",
        status: "awaiting-decision",
        currentRound: null,
        messages: [],
        assetType: "webinar-page",
        stages: [
          {
            number: 4,
            title: "קופי לדף וובינר",
            ownerSlug: "maya-lp-copywriter",
            status: "pending",
            output: "",
            feedbackHistory: [],
            subTasks: [
              { id: "4a", title: "Hero + פרטי השידור", status: "approved", output: "לא אמור לדלוף", feedbackHistory: [] },
              { id: "4b", title: "מה תגלה בשידור + למי זה", status: "pending", output: "", feedbackHistory: [] },
            ],
          },
        ],
      } as Run;
      const context = buildPriorContext(run, 4, "4b");
      expect(context).not.toContain("לא אמור לדלוף");
    } finally {
      delete def.excludeFromPage;
    }
  });
});
