import { describe, expect, it } from "vitest";
import { renderAssetPlacementBlock, renderPlacementTable } from "@/orchestrator/runStage5LpBuild";

describe("builder asset placement block", () => {
  const placement = {
    mapped: [{ file: "hero.webp", section: "Hero", proves: "״30 | לקוחות״\nבחודש" }],
    logos: ["logo-press.webp"],
    rawMaterial: ["portrait.webp"],
    unmapped: ["old-proof.webp"],
  };

  it("renders the mapped table with escaped pipes and newlines", () => {
    const table = renderPlacementTable("demo", placement.mapped);
    expect(table).toContain("| File | Section | Proves |");
    expect(table).toContain("| `public/demo/hero.webp` | Hero | ״30 \\| לקוחות״ בחודש |");
  });

  it("lists logos, raw material and approved-without-map assets separately", () => {
    const block = renderAssetPlacementBlock("demo", placement);
    expect(block).toContain("visible at 390px AND at 1280px");
    expect(block).toContain(
      "Do not place a mapped image inside a carousel, a marquee or an inner scroll container, and make every scroll-reveal animation around a mapped image reveal once (`viewport={{ once: true }}` or `useInView(ref, { once: true })`).",
    );
    expect(block).toContain("### Logos\n- `public/demo/logo-press.webp`");
    expect(block).toContain("### Raw material");
    expect(block).toContain("- `public/demo/portrait.webp`");
    expect(block).toContain("### Approved without a map (you may use these)\n- `public/demo/old-proof.webp`");
    expect(block).toContain("Do not add or copy any other image");
  });

  it("keeps the empty-manifest wording", () => {
    expect(renderAssetPlacementBlock("demo", { mapped: [], logos: [], rawMaterial: [], unmapped: [] }))
      .toBe("## Approved assets\n\n(the validated asset manifest contains no approved images)");
  });
});
