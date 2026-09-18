import { describe, expect, it } from "vitest";
import { parseDesignBriefJson } from "@/orchestrator/designBriefJson";

const IMAGE_MAP = [{ harvestFile: "raw/01-portrait.jpg", section: "Hero", proves: "המנחה שבנתה את השיטה" }];

function brief(extra: Record<string, unknown>): string {
  return "כיוון עיצוב.\n```json\n" + JSON.stringify({ imageMap: IMAGE_MAP, ...extra }) + "\n```";
}

const MOCKUP = { name: "module-1", section: "Stack", proves: "מה מקבלים בפרק הראשון", base: "chapter" };

describe("parseDesignBriefJson requiredMockups", () => {
  it("is undefined when the brief never declares one", () => {
    expect(parseDesignBriefJson(brief({}))?.requiredMockups).toBeUndefined();
  });

  it("keeps a well formed list whole", () => {
    const parsed = parseDesignBriefJson(brief({
      requiredMockups: [MOCKUP, { ...MOCKUP, name: "program-stack", base: "devices" }],
    }));

    expect(parsed?.requiredMockups).toEqual([
      { name: "module-1", section: "Stack", proves: "מה מקבלים בפרק הראשון", base: "chapter" },
      { name: "program-stack", section: "Stack", proves: "מה מקבלים בפרק הראשון", base: "devices" },
    ]);
  });

  it("keeps an explicitly empty list as an empty list, not as a missing one", () => {
    expect(parseDesignBriefJson(brief({ requiredMockups: [] }))?.requiredMockups).toEqual([]);
  });

  it("drops the whole list when two mockups share a name", () => {
    expect(parseDesignBriefJson(brief({ requiredMockups: [MOCKUP, MOCKUP] }))?.requiredMockups).toBeUndefined();
  });

  it("drops the whole list on a malformed row, so half a list never reaches 5.2", () => {
    const rows: Record<string, unknown>[] = [
      { ...MOCKUP, base: "watch" },
      { ...MOCKUP, name: "" },
      { ...MOCKUP, name: "../etc/passwd" },
      { ...MOCKUP, section: "" },
      { ...MOCKUP, section: "ס".repeat(81) },
      { ...MOCKUP, proves: "מ".repeat(201) },
      { ...MOCKUP, proves: 7 },
    ];
    for (const row of rows) {
      expect(parseDesignBriefJson(brief({ requiredMockups: [row] }))?.requiredMockups, JSON.stringify(row))
        .toBeUndefined();
    }
  });

  it("ignores a requiredMockups that is not an array at all", () => {
    expect(parseDesignBriefJson(brief({ requiredMockups: "module-1" }))?.requiredMockups).toBeUndefined();
    expect(parseDesignBriefJson(brief({ requiredMockups: { name: "x" } }))?.requiredMockups).toBeUndefined();
  });

  it("does not let a broken mockup list void the image map", () => {
    const parsed = parseDesignBriefJson(brief({ requiredMockups: [{ ...MOCKUP, base: "watch" }] }));

    expect(parsed?.imageMap).toHaveLength(1);
    expect(parsed?.invalidRows).toBe(0);
  });
});
