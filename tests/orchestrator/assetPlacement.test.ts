import { describe, expect, it } from "vitest";
import {
  classifyAssetPlacement,
  placementFields,
  type AssetPlanEntry,
} from "@/orchestrator/assetQuality";

const map = { section: "Hero", proves: "״30 לקוחות בחודש בלי מודעות״" };

describe("placementFields", () => {
  it("trims and accepts a complete map", () => {
    expect(placementFields({ section: "  Hero ", proves: " כותרת " })).toEqual({ section: "Hero", proves: "כותרת" });
  });

  it("treats empty, non-string and over-long values as missing", () => {
    expect(placementFields({ section: "Hero" })).toBeNull();
    expect(placementFields({ section: "   ", proves: "x" })).toBeNull();
    expect(placementFields({ section: 7 as unknown as string, proves: "x" })).toBeNull();
    expect(placementFields({ section: "s".repeat(81), proves: "x" })).toBeNull();
    expect(placementFields({ section: "s", proves: "p".repeat(201) })).toBeNull();
    expect(placementFields({ section: "s".repeat(80), proves: "p".repeat(200) })).not.toBeNull();
  });
});

describe("classifyAssetPlacement", () => {
  it("applies the four precedence rules in order", () => {
    const entries: AssetPlanEntry[] = [
      { file: "hero.webp", kind: "photo", ...map },
      { file: "logo-mapped.webp", kind: "logo", ...map },
      { file: "logo.webp", kind: "logo" },
      { file: "portrait.webp", kind: "photo" },
      { file: "portrait-cut.webp", kind: "cutout", sourceFile: "portrait.webp", ...map },
      { file: "screen.webp", kind: "photo", section: "Stack", proves: "מה מקבלים" },
      { file: "module-mockup.webp", kind: "mockup", inputs: ["screen.webp"], ...map },
      { file: "stray.webp", kind: "generated" },
    ];

    const placement = classifyAssetPlacement(entries);

    expect(placement.mapped.map((a) => a.file)).toEqual([
      "hero.webp", "logo-mapped.webp", "portrait-cut.webp", "screen.webp", "module-mockup.webp",
    ]);
    expect(placement.logos).toEqual(["logo.webp"]);
    expect(placement.rawMaterial).toEqual(["portrait.webp"]);
    expect(placement.unmapped).toEqual(["stray.webp"]);
  });
});
