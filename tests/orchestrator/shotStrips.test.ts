import { describe, expect, it } from "vitest";
import {
  MAX_STRIPS_PER_SHOT,
  MAX_STRIP_HEIGHT_PX,
  captureWidthFromFile,
  planStrips,
  pngPixelSize,
  renderShotList,
} from "@/orchestrator/shotStrips";

/** A PNG header carrying exactly the size fields the planner reads. */
function pngHeader(width: number, height: number): Uint8Array {
  const header = new Uint8Array(24);
  header.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const write = (offset: number, value: number) => {
    header[offset] = (value >>> 24) & 0xff;
    header[offset + 1] = (value >>> 16) & 0xff;
    header[offset + 2] = (value >>> 8) & 0xff;
    header[offset + 3] = value & 0xff;
  };
  write(16, width);
  write(20, height);
  return header;
}

/**
 * The cut that makes a full-page capture readable to a design critic, stated
 * as a table of heights.
 *
 * The two heights that matter here are measured, not invented: the 10th
 * acceptance run handed the three design critics `round-2-390.png` at
 * 390x21244 and `round-2-1280.png` at 1280x20196, one file each, and all three
 * failed the page. Uri Segev named the reason as his first blocker and asked
 * for strips of up to 2000px. The other two produced blockers the pixels
 * contradict, which is the failure this module exists to prevent.
 */
describe("planning the strips of one capture", () => {
  it.each<[string, number, number]>([
    ["the measured 390px capture", 21_244, 11],
    ["the measured 1280px capture", 20_196, 11],
    ["a capture shorter than one strip", 900, 1],
    ["a capture exactly one strip tall", 2_000, 1],
    ["one pixel past a strip boundary", 2_001, 2],
  ])("cuts %s into the expected number of strips", (_label, height, expected) => {
    expect(planStrips(height)).toHaveLength(expected);
  });

  it.each<[string, number]>([
    ["the measured 390px capture", 21_244],
    ["the measured 1280px capture", 20_196],
    ["a capture shorter than one strip", 900],
    ["one pixel past a strip boundary", 2_001],
    ["a page at the capture ceiling", 80_000],
  ])("covers %s exactly once, with no overlap and no gap", (_label, height) => {
    const strips = planStrips(height);
    expect(strips[0].top).toBe(0);
    strips.forEach((strip, i) => {
      expect(strip.index).toBe(i + 1);
      expect(strip.height).toBeGreaterThan(0);
      if (i > 0) expect(strip.top).toBe(strips[i - 1].top + strips[i - 1].height);
    });
    const last = strips[strips.length - 1];
    expect(last.top + last.height).toBe(height);
  });

  it("keeps every strip within the readable height until the count would exceed the cap", () => {
    for (const strip of planStrips(21_244)) {
      expect(strip.height).toBeLessThanOrEqual(MAX_STRIP_HEIGHT_PX);
    }
  });

  // The cap binds the number of files, never the coverage: a page at the
  // capture ceiling grows its strips instead of adding a 40th file, and is
  // still four times more readable than the single capture it replaces.
  it("grows the strip rather than the file count for a page at the capture ceiling", () => {
    const strips = planStrips(80_000);
    expect(strips).toHaveLength(MAX_STRIPS_PER_SHOT);
    expect(strips[0].height).toBe(Math.ceil(80_000 / MAX_STRIPS_PER_SHOT));
    expect(strips[0].height).toBeLessThan(21_244);
  });

  it("honours an explicit cap and strip height", () => {
    expect(planStrips(10_000, { maxStripHeight: 1_000 })).toHaveLength(10);
    expect(planStrips(10_000, { maxStripHeight: 1_000, maxStrips: 4 })).toHaveLength(4);
  });

  it("plans nothing from a height the caller could not measure, instead of a bad cut", () => {
    expect(planStrips(0)).toEqual([]);
    expect(planStrips(-1)).toEqual([]);
    expect(planStrips(Number.NaN)).toEqual([]);
    expect(planStrips(Number.POSITIVE_INFINITY)).toEqual([]);
  });
});

describe("reading a capture's size from its header", () => {
  it.each<[string, number, number]>([
    ["the measured 390px capture", 390, 21_244],
    ["the measured 1280px capture", 1280, 20_196],
    ["a page at the capture ceiling", 1280, 80_000],
  ])("reads %s", (_label, width, height) => {
    expect(pngPixelSize(pngHeader(width, height))).toEqual({ width, height });
  });

  it("reads nothing from bytes that are not a PNG header", () => {
    expect(pngPixelSize(new Uint8Array(0))).toBeUndefined();
    expect(pngPixelSize(new Uint8Array(24))).toBeUndefined();
    expect(pngPixelSize(pngHeader(390, 21_244).slice(0, 20))).toBeUndefined();
    expect(pngPixelSize(pngHeader(390, 0))).toBeUndefined();
    expect(pngPixelSize(pngHeader(0, 21_244))).toBeUndefined();
  });

  // A height read as a negative number would plan no strips at all and quietly
  // hand the critics the unreadable file the fix exists to replace.
  it("reads a 32-bit size as unsigned, never as a negative height", () => {
    const size = pngPixelSize(pngHeader(390, 0xf000_0000));
    expect(size?.height).toBeGreaterThan(0);
  });
});

describe("which width a capture file is", () => {
  it.each<[string, number | undefined]>([
    ["round-2-390.png", 390],
    ["/s/round-2-1280.png", 1280],
    ["/s/reference-390.png", 390],
    ["/s/round-10-2560.png", 2560],
  ])("reads %s as its own width", (file, width) => {
    expect(captureWidthFromFile(file)).toBe(width);
  });

  // A strip's suffix is two digits, so the strip files of a capture never
  // masquerade as a width of their own.
  it("does not mistake a strip file for a capture", () => {
    expect(captureWidthFromFile("round-2-390-strip-01.png")).toBeUndefined();
    expect(captureWidthFromFile("round-2-390-strip-11.png", 390)).toBe(390);
  });

  it("falls back when the name says nothing", () => {
    expect(captureWidthFromFile("shot.png")).toBeUndefined();
    expect(captureWidthFromFile("shot.png", 390)).toBe(390);
    expect(captureWidthFromFile("", 1280)).toBe(1280);
  });
});

describe("the shot list a critic reads", () => {
  it("says the strips are one page, in order, so eleven files are not read as eleven pages", () => {
    const list = renderShotList([
      { width: 390, files: ["/s/round-2-390-strip-01.png", "/s/round-2-390-strip-02.png"] },
      { width: 1280, files: ["/s/round-2-1280-strip-01.png"] },
    ]);
    expect(list).toContain("**דף אחד**");
    expect(list).toContain("רצופות מלמעלה למטה");
    expect(list).toContain("- 390px, 2 רצועות רצופות מלמעלה למטה:");
    expect(list).toContain("  1. /s/round-2-390-strip-01.png");
    expect(list).toContain("  2. /s/round-2-390-strip-02.png");
    expect(list).toContain("- 1280px: /s/round-2-1280-strip-01.png");
  });

  it("stays the plain one-line-per-width list when nothing was sliced", () => {
    const list = renderShotList([
      { width: 390, files: ["/s/round-2-390.png"] },
      { width: 1280, files: ["/s/round-2-1280.png"] },
    ]);
    expect(list).toBe("- 390px: /s/round-2-390.png\n- 1280px: /s/round-2-1280.png");
  });

  it("renders nothing when no width produced a file", () => {
    expect(renderShotList([])).toBe("");
    expect(renderShotList([{ width: 390, files: [] }])).toBe("");
  });
});
