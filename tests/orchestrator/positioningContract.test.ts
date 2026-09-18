import { describe, it, expect } from "vitest";
import { getSubTaskDef } from "@/orchestrator/stageRegistry";

const positioning = () => getSubTaskDef(2, "2").instructions;
const angles = () => getSubTaskDef(3, "3").instructions;

/**
 * Six questions decide whether a move is any good: the presenter's authority,
 * the benefit, the problem, why now, the mechanism, and the big idea. Three of
 * them had no seat in the pipeline at all, so nothing downstream could use
 * them. These assertions keep each one with the agent whose charter owns it.
 */
describe("the positioning stage owns the problem and the fact-gated why-now", () => {
  it("asks for the central problem as its own field", () => {
    expect(positioning()).toContain("## הבעיה המרכזית");
  });

  it("keeps the promise and the authority it already owned", () => {
    expect(positioning()).toContain("## הבטחה מרכזית");
    expect(positioning()).toContain("## סמכות");
  });

  it("gates why-now on a supplied fact and accepts 'there is none'", () => {
    const text = positioning();
    expect(text).toContain("## למה עכשיו");
    expect(text).toContain("אין עילת דחיפות אמיתית בחומר שסופק");
    // The copywriter downstream is forbidden from inventing urgency, so this
    // stage must not manufacture it upstream either.
    expect(text).toContain("אסור להמציא דחיפות");
  });
});

describe("the creative stage owns the mechanism and the big idea", () => {
  it("asks for a named mechanism that moves the customer from A to B", () => {
    expect(angles()).toContain("## המנגנון");
  });

  it("asks what makes the idea big, new and different", () => {
    const text = angles();
    expect(text).toContain("## הרעיון הגדול");
    expect(text).toContain("גדול, חדש ושונה");
  });

  it("derives the three angles from the big idea instead of three frames", () => {
    expect(angles()).toContain("שלוש הזוויות נגזרות מהרעיון הגדול");
  });

  it("leaves the big idea out of the strategist's economics seat", () => {
    expect(positioning()).not.toContain("הרעיון הגדול");
  });
});
