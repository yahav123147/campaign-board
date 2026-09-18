import { describe, expect, it } from "vitest";
import {
  stageOfTotalLabel,
  stageProgressDots,
  strategyEditNote,
} from "@/lib/runPageStageState";
import { stageRegistryFor } from "@/orchestrator/stageRegistry";
import type { AssetType, Stage } from "@/types";

/**
 * A5: the run page used to assume nine stages ("שלב N מתוך 9", nine fallback
 * dots, "כל 9 השלבים"). An upsell run has five. The total must come from the
 * run's own stage list.
 */
function stagesFor(assetType: AssetType): Stage[] {
  return stageRegistryFor(assetType).map((def) => ({
    number: def.number,
    title: def.title,
    ownerSlug: def.ownerSlug,
    status: def.number === 1 ? "approved" : def.number === 2 ? "running" : "pending",
    output: "",
    feedbackHistory: [],
    subTasks: [],
  }));
}

describe("stage totals on the run page", () => {
  it("labels an upsell stage out of five", () => {
    const stages = stagesFor("upsell-page");
    expect(stageOfTotalLabel(5, stages)).toBe("שלב 5 מתוך 5");
  });

  it("labels a sales-page stage out of nine", () => {
    expect(stageOfTotalLabel(4, stagesFor("sales-page"))).toBe("שלב 4 מתוך 9");
  });

  it("draws one progress dot per stage of the run", () => {
    expect(stageProgressDots(stagesFor("upsell-page"))).toEqual(["done", "active", "pending", "pending", "pending"]);
    expect(stageProgressDots(stagesFor("sales-page"))).toHaveLength(9);
  });

  it("never invents a fixed count before the run has stages", () => {
    expect(stageProgressDots([])).toEqual([]);
  });

  it("tells the strategy editor how many stages its edit flows into, without an em-dash", () => {
    const note = strategyEditNote(stagesFor("upsell-page").length);
    expect(note).toContain("לכל 5 השלבים");
    expect(note).not.toContain("9");
    expect(note).not.toContain(String.fromCharCode(0x2014));
  });
});
