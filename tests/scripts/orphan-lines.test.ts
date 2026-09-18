import { describe, expect, it } from "vitest";
import {
  LINE_OVERLAP_RATIO,
  ORPHAN_LINE_WIDTH_RATIO,
  groupVisualLines,
  hasOrphanLine,
  orphanReport,
} from "@/vendor/landing-skill/scripts/orphanLines.mjs";

/**
 * The orphan rule of the delivery gate, stated as a table of rectangles.
 *
 * Every element below is a real measurement taken from Chrome 1.62 at 16px
 * system-ui with `line-height: 1.7`, dumped through the same TreeWalker the
 * gate itself uses, so the table is the browser's arithmetic and not a guess.
 *
 * The 10th acceptance run failed the page with `orphans=24` at all six widths,
 * every reported line being the assumption marker: `orphan: * / בסוף התגרשנו.`
 * The gate bucketed words by their rounded top, and a `<sup>` is raised, so the
 * marker always sat in a bucket of its own even though its rectangle overlaps
 * the sentence's by most of its height. Lines are grouped by vertical overlap
 * instead, and the real rule underneath it is untouched: a line holding one
 * short word, with another line to have held it, still fails.
 */

interface Token {
  text: string;
  top: number;
  bottom: number;
  width: number;
}

interface Element {
  width: number;
  tokens: Token[];
}

/** `בסוף התגרשנו.<sup>*</sup>` at 600px: the marker rides 5px higher than its sentence. */
const raisedMarker: Element = {
  width: 600,
  tokens: [
    { text: "בסוף", top: 32.3, bottom: 50.3, width: 33.6 },
    { text: "התגרשנו.", top: 32.3, bottom: 50.3, width: 63.3 },
    { text: "*", top: 27, bottom: 44, width: 6.6 },
  ],
};

/** The same sentence with no marker: one line, and never flagged. */
const plainSentence: Element = {
  width: 600,
  tokens: [
    { text: "בסוף", top: 83.5, bottom: 101.5, width: 33.6 },
    { text: "התגרשנו.", top: 83.5, bottom: 101.5, width: 63.3 },
  ],
};

/** A lowered marker is the same shape upside down, so it merges the same way. */
const loweredMarker: Element = {
  width: 600,
  tokens: [
    { text: "בסוף", top: 32.3, bottom: 50.3, width: 33.6 },
    { text: "התגרשנו.", top: 32.3, bottom: 50.3, width: 63.3 },
    { text: "1", top: 38, bottom: 55, width: 6.6 },
  ],
};

/** Three real lines at 300px; the last one holds a single short word. */
const genuineOrphan: Element = {
  width: 300,
  tokens: [
    { text: "שער", top: 134.7, bottom: 152.7, width: 30.2 },
    { text: "האיכות", top: 134.7, bottom: 152.7, width: 47.4 },
    { text: "בודק", top: 134.7, bottom: 152.7, width: 32.6 },
    { text: "כל", top: 134.7, bottom: 152.7, width: 16.9 },
    { text: "שורה", top: 134.7, bottom: 152.7, width: 34 },
    { text: "בדף", top: 134.7, bottom: 152.7, width: 28.6 },
    { text: "לפני", top: 134.7, bottom: 152.7, width: 27.5 },
    { text: "המסירה", top: 134.7, bottom: 152.7, width: 52.5 },
    { text: "ומחפש", top: 161.9, bottom: 179.9, width: 46.8 },
    { text: "שורה", top: 161.9, bottom: 179.9, width: 34 },
    { text: "שנשארה", top: 161.9, bottom: 179.9, width: 58.5 },
    { text: "בה", top: 161.9, bottom: 179.9, width: 19.4 },
    { text: "מילה", top: 161.9, bottom: 179.9, width: 32.1 },
    { text: "אחת", top: 161.9, bottom: 179.9, width: 31.9 },
    { text: "בלבד", top: 161.9, bottom: 179.9, width: 35.3 },
    { text: "סוף", top: 189.1, bottom: 207.1, width: 24.7 },
  ],
};

/** Exactly two lines, the second holding one short word: the shape the rule exists for. */
const twoLinesShortLast: Element = {
  width: 300,
  tokens: [
    { text: "ומחפש", top: 161.9, bottom: 179.9, width: 46.8 },
    { text: "שורה", top: 161.9, bottom: 179.9, width: 34 },
    { text: "שנשארה", top: 161.9, bottom: 179.9, width: 58.5 },
    { text: "בה", top: 161.9, bottom: 179.9, width: 19.4 },
    { text: "מילה", top: 161.9, bottom: 179.9, width: 32.1 },
    { text: "סוף", top: 189.1, bottom: 207.1, width: 24.7 },
  ],
};

/** A URL is one word that fills its own line: nothing could have wrapped with it. */
const longUrlLine: Element = {
  width: 260,
  tokens: [
    { text: "כתובת", top: 240.3, bottom: 258.3, width: 44.7 },
    { text: "הדף", top: 240.3, bottom: 258.3, width: 29.2 },
    { text: "לבדיקה", top: 240.3, bottom: 258.3, width: 49.8 },
    { text: "היא", top: 240.3, bottom: 258.3, width: 23.7 },
    {
      text: "https://example.test/a/very/long/path/that/fills/its/own/line",
      top: 267.5,
      bottom: 285.5,
      width: 412.9,
    },
  ],
};

describe("visual line grouping", () => {
  it.each<[string, Element, number]>([
    ["a raised marker joins the sentence it sits on", raisedMarker, 1],
    ["a lowered marker joins it too", loweredMarker, 1],
    ["a sentence with no marker is one line", plainSentence, 1],
    ["three wrapped lines stay three lines", genuineOrphan, 3],
    ["a line holding only a URL is its own line", longUrlLine, 2],
  ])("%s", (_label, element, lines) => {
    expect(groupVisualLines(element.tokens)).toHaveLength(lines);
  });

  it("measures nothing from no tokens at all", () => {
    expect(groupVisualLines([])).toEqual([]);
    expect(groupVisualLines(undefined)).toEqual([]);
    expect(hasOrphanLine({ width: 600, tokens: [] })).toBe(false);
    expect(orphanReport({ width: 600, tokens: [] })).toBeUndefined();
    expect(orphanReport(undefined)).toBeUndefined();
  });

  it("reads a rectangle the browser could not measure as nothing, instead of as a line", () => {
    expect(groupVisualLines([
      { text: "מילה", top: Number.NaN, bottom: 50.3, width: 33.6 },
      { text: "שנייה", top: 32.3, bottom: 50.3, width: 0 },
      { text: "שלישית", top: 50.3, bottom: 32.3, width: 33.6 },
    ])).toEqual([]);
  });

  it("keeps the words of a line in the order they were measured", () => {
    expect(groupVisualLines(twoLinesShortLast.tokens).map((line) => line.words)).toEqual([
      ["ומחפש", "שורה", "שנשארה", "בה", "מילה"],
      ["סוף"],
    ]);
  });
});

describe("orphan lines", () => {
  it.each<[string, Element, boolean]>([
    // The acceptance failure itself, at the width the page was judged on.
    ["a raised marker is not a line of its own", raisedMarker, false],
    ["a lowered marker is not one either", loweredMarker, false],
    ["a single line cannot orphan anything", plainSentence, false],
    ["a long URL alone on its line is not an orphan", longUrlLine, false],
    ["a last line holding one short word is", genuineOrphan, true],
    ["two lines whose second holds one short word are too", twoLinesShortLast, true],
  ])("%s", (_label, element, flagged) => {
    expect(hasOrphanLine(element)).toBe(flagged);
    expect(orphanReport(element) === undefined).toBe(!flagged);
  });

  it("prints the lines of the element it flagged, in order", () => {
    expect(orphanReport(twoLinesShortLast)).toBe("ומחפש שורה שנשארה בה מילה / סוף");
  });

  it("states the two ratios the rule is made of", () => {
    expect(ORPHAN_LINE_WIDTH_RATIO).toBe(0.45);
    expect(LINE_OVERLAP_RATIO).toBe(0.5);
  });
});
