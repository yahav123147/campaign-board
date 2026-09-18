import { describe, expect, it } from "vitest";
import {
  finalCopySubTaskId, getStageDef, getSubTaskDef, pageCopyForBuild, pageTypeRequiresMockups,
  reconcileStages, stageRegistryFor,
} from "@/orchestrator/stageRegistry";
import { stageOfTotalLabel } from "@/lib/runPageStageState";
import type { Run, Stage } from "@/types";
import { MAX_MOCKUP_NAME_CHARS, MAX_REQUIRED_MOCKUPS } from "@/lib/mockupContract";
import { MAX_PLACEMENT_PROVES_CHARS, MAX_PLACEMENT_SECTION_CHARS } from "@/orchestrator/assetQuality";

describe("the direct ladder", () => {
  it("has four stages numbered 1, 2, 3, 5 with one sub-task each except the build", () => {
    const ladder = stageRegistryFor("sales-page", "direct");
    expect(ladder.map((s) => s.number)).toEqual([1, 2, 3, 5]);
    expect(ladder.map((s) => s.subTasks.map((t) => t.id))).toEqual([["1"], ["2"], ["3"], ["5.2", "5.3", "5.4"]]);
    expect(getStageDef(3, "sales-page", "direct").ownerSlug).toBe("uri-art-director");
    expect(getSubTaskDef(2, "2", "sales-page", "direct").critic).toEqual({ slug: "roni-creative", rubric: "copy-critic", maxRounds: 3 });
    expect(getSubTaskDef(3, "3", "sales-page", "direct").critic?.maxRounds).toBe(2);
    expect(() => getStageDef(4, "sales-page", "direct")).toThrow(/not in registry/);
  });

  it("stage 3 instructions never offer to map an instagram proof that stage 1 never harvested", () => {
    expect(getSubTaskDef(3, "3", "sales-page", "direct").instructions).not.toContain("instagram-");
  });

  it("is the same ladder for every page type; the council ladder is untouched", () => {
    expect(stageRegistryFor("squeeze-page", "direct").map((s) => s.number)).toEqual([1, 2, 3, 5]);
    expect(stageRegistryFor("sales-page").map((s) => s.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(stageRegistryFor("upsell-page", "council").map((s) => s.number)).toEqual([1, 2, 3, 4, 5]);
  });

  it("the final copy gate of a direct run is sub-task 2, and the builder reads stage 2", () => {
    expect(finalCopySubTaskId("sales-page", "direct")).toBe("2");
    expect(finalCopySubTaskId("squeeze-page")).toBe("4c");
    const run = {
      pipeline: "direct", assetType: "sales-page",
      stages: [{ number: 2, title: "קופי לדף", ownerSlug: "maya-lp-copywriter", status: "approved", output: "", feedbackHistory: [],
        subTasks: [{ id: "2", title: "קופי לדף", status: "approved", output: "הקופי המלא", feedbackHistory: [] }] }],
    } as unknown as Run;
    expect(pageCopyForBuild(run)).toBe("הקופי המלא");
  });

  it("reconciles a direct run against the direct ladder", () => {
    const stages: Stage[] = stageRegistryFor("sales-page", "direct").map((def) => ({
      number: def.number, title: def.title, ownerSlug: def.ownerSlug, status: "pending", output: "", feedbackHistory: [],
      subTasks: def.subTasks.map((t) => ({ id: t.id, title: t.title, status: "pending", output: "", feedbackHistory: [] })),
    }));
    expect(reconcileStages(stages, "sales-page", "direct")).toEqual(stages);
  });

  // Task 14: which page types may never run 5.2 without a requiredMockups list.
  it("requires mockups for the two page types whose template shows a program", () => {
    expect(pageTypeRequiresMockups("sales-page")).toBe(true);
    expect(pageTypeRequiresMockups("premium-lead-page")).toBe(true);
    for (const type of ["webinar-page", "squeeze-page", "upsell-page"] as const) {
      expect(pageTypeRequiresMockups(type)).toBe(false);
    }
    expect(pageTypeRequiresMockups()).toBe(true);
  });

  it("stage 3 instructions state the requiredMockups contract", () => {
    const instructions = getSubTaskDef(3, "3", "sales-page", "direct").instructions;
    expect(instructions).toContain("requiredMockups");
    expect(instructions).toContain("devices");
    expect(instructions).toContain("chapter");
  });

  // Task 17: the standing 5.2 instructions must teach the same contract the
  // prompt and the validator enforce, and must not send the agent off to run a
  // mockup tool of its own.
  it("the 5.2 instructions describe the screens and render fields, not a self-service mockup tool", () => {
    for (const pipeline of ["council", "direct"] as const) {
      const instructions = getSubTaskDef(5, "5.2", "sales-page", pipeline).instructions;
      expect(instructions, pipeline).toContain("screens");
      expect(instructions, pipeline).toContain("render");
      expect(instructions, pipeline).toContain("sizes.json");
      expect(instructions, pipeline).toContain("asset-plan.json");
      expect(instructions, pipeline).not.toContain("course-mockups");
      expect(instructions, pipeline).not.toContain("Playwright");
    }
  });

  // Fix round 1, Critical: the standing instructions must not describe the
  // screens as plain static HTML, which invites a sibling src or a web font.
  it("the 5.2 instructions state that pictures and fonts reach a screen only as data: URIs", () => {
    for (const pipeline of ["council", "direct"] as const) {
      const instructions = getSubTaskDef(5, "5.2", "sales-page", pipeline).instructions;
      expect(instructions, pipeline).toContain("data:");
      expect(instructions, pipeline).toContain("<script>");
      expect(instructions, pipeline).toContain("javascript:");
      expect(instructions, pipeline).toMatch(/בלי גישה לרשת/);
    }
  });

  // Task 17: the stage 3 brief states the rules the 5.2 validator enforces, so
  // a brief that would stop the run is caught while it is still being written.
  it("stage 3 instructions state every requiredMockups rule the validator enforces", () => {
    const instructions = getSubTaskDef(3, "3", "sales-page", "direct").instructions;
    expect(instructions).toContain("דף מכירה ובדף ליד פרימיום");
    expect(instructions).toContain("מוקאפ אחד לכל מודול");
    expect(instructions).toContain("80 תווים");
    expect(instructions).toContain("200 תווים");
    // Missing, empty and malformed all stop 5.2 before the agent is spawned.
    expect(instructions).toContain("רשימה חסרה, ריקה או שבורה");
    expect(instructions).toContain("לפני שהסוכן רץ");
    // Each row becomes its own mockup entry in the asset plan.
    expect(instructions).toContain("נכס mockup משלה");
    // Fix round 1, Minor 3: the caps the validator actually applies, from the
    // constants, so prose and code can never state different numbers.
    expect(instructions).toContain(`עד ${MAX_REQUIRED_MOCKUPS} מוקאפים`);
    expect(instructions).toContain(`עד ${MAX_MOCKUP_NAME_CHARS} תווים`);
    expect(instructions).toContain(`${MAX_PLACEMENT_SECTION_CHARS} תווים`);
    expect(instructions).toContain(`${MAX_PLACEMENT_PROVES_CHARS} תווים`);
    // Fix round 1, Minor 1: device names must not contradict the frames.
    expect(instructions).not.toContain("מסך שולחני, לפטופ, טאבלט וטלפון");
  });

  it("labels stages by position, not by number", () => {
    const stages = stageRegistryFor("sales-page", "direct").map((def) => ({
      number: def.number, title: def.title, ownerSlug: def.ownerSlug, status: "pending" as const, output: "", feedbackHistory: [], subTasks: [],
    }));
    expect(stageOfTotalLabel(5, stages)).toBe("שלב 4 מתוך 4");
    expect(stageOfTotalLabel(1, stages)).toBe("שלב 1 מתוך 4");
  });
});
