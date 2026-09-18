import { describe, expect, it } from "vitest";
import { DEFAULT_BOARD_NAME, MAX_BOARD_NAME_CHARS, boardNameFrom } from "@/lib/boardName";

/**
 * The board's name is configuration, not source. The packaging scanner refuses
 * any packaged text file carrying a tenant's brand name, and config/clientProfile.ts
 * is itself packaged, so the operator's name for the board reaches the UI only
 * through their own profile file. This is the resolution, with its fallback.
 */
describe("the board's name", () => {
  it("is what the installation chose", () => {
    expect(boardNameFrom("הבורד של הלקוח")).toBe("הבורד של הלקוח");
  });

  it.each<[string, unknown]>([
    ["nothing at all", undefined],
    ["an explicit null", null],
    ["an empty string", ""],
    ["whitespace only", "   \n\t "],
    ["a number", 42],
    ["an object", { boardName: "x" }],
  ])("falls back to the neutral default given %s", (_label, value) => {
    expect(boardNameFrom(value)).toBe(DEFAULT_BOARD_NAME);
  });

  it("keeps the default tenant-neutral, so a packaged copy carries no one's brand", () => {
    expect(DEFAULT_BOARD_NAME).not.toMatch(/נקסט|next/i);
  });

  it("trims a name that would push the navigation off the header row", () => {
    const long = "ב".repeat(MAX_BOARD_NAME_CHARS + 20);
    expect(boardNameFrom(long)).toHaveLength(MAX_BOARD_NAME_CHARS);
  });

  it("does not leave a trailing space where it cut", () => {
    expect(boardNameFrom(`${"ב".repeat(MAX_BOARD_NAME_CHARS - 1)} מילה`)).toBe("ב".repeat(MAX_BOARD_NAME_CHARS - 1));
  });

  it("keeps a name exactly at the limit whole", () => {
    const exact = "ב".repeat(MAX_BOARD_NAME_CHARS);
    expect(boardNameFrom(exact)).toBe(exact);
  });
});
