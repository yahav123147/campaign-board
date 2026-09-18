import { describe, it, expect } from "vitest";
import {
  renderPageTypeStructureBlock,
  buildLpBuildPrompt,
  buildCritiquePrompt,
} from "@/orchestrator/runStage5LpBuild";

/**
 * The design standard skill (vendor/landing-skill/SKILL.md) is written for a
 * sales page and opens with a hard rule: a media logo strip is the first
 * thing on the page. An upsell page must open on the order state instead, so
 * both the builder and the three design critics need the page-type blueprint
 * AND an explicit rule that its structure section wins over the skill's
 * structural rules, including that logo strip.
 *
 * This is not the natural home for a full end-to-end run of stage 5.3: that
 * needs a Git worktree, a running preview server and real screenshots, none
 * of which this suite sets up. Instead, per the pattern already established
 * for this file (buildWorkspacePermissions, resolveNextCli in
 * stage5Permissions.test.ts), the two prompt templates are exported as pure
 * functions and composed here directly with fixture inputs.
 */
const upsellBlueprint = [
  "## המבנה המחייב",
  "הדף נפתח במצב הזמנה: מה הוזמן, מתי, ומה השלב הבא. אין hero מכירתי בראש הדף.",
].join("\n");

describe("the page type structure block", () => {
  it("carries the blueprint content and the binding precedence rule", () => {
    const block = renderPageTypeStructureBlock("upsell-page", upsellBlueprint);
    expect(block).toContain("## תבנית סוג הדף (upsell-page)");
    expect(block).toContain("מצב הזמנה");
    expect(block).toContain(
      "**קדימות:** סעיף המבנה של התבנית מנצח כל כלל מבנה בספר הכללים, כולל סדר הסקציות ורצועת הלוגו בראש הדף.",
    );
    expect(block).toContain("כלל שהתבנית מוציאה אינו חוסם.");
    expect(block).toContain(
      "כללי המלאכה שאינם מבנה נשארים חוסמים: היררכיית גדלים, ריתמוס רקעים, אפס letter-spacing בעברית, ונכסים אמיתיים בלבד.",
    );
  });

  // A2: a sales page has no blueprint, and its builder and design critics must
  // get exactly the prompts they got before page types existed: no heading,
  // no placeholder and no precedence line naming the logo strip.
  it("renders nothing at all when there is no blueprint", () => {
    expect(renderPageTypeStructureBlock("sales-page", "")).toBe("");
    expect(renderPageTypeStructureBlock("upsell-page", "")).toBe("");
  });

  it("keeps the builder and critic prompts byte-identical to a prompt with no block when there is no blueprint", () => {
    const buildArgs = {
      editInPlace: false,
      pagePath: "src/app/demo/page.tsx",
      slug: "demo",
      brandBrief: "בריף מותג לדוגמה",
      referenceBlock: "",
      fullStandard: "## Design standard body",
      standard: "",
      assetsBlock: "## נכסים\n(אין)",
      clientContext: "",
      lpCopy: "קופי לדוגמה",
      brief: "בריף לדוגמה",
      strategyDoc: undefined,
      feedbackBlock: "",
      designBriefBlock: "",
    };
    expect(buildLpBuildPrompt({ ...buildArgs, pageTypeStructureBlock: renderPageTypeStructureBlock("sales-page", "") }))
      .toBe(buildLpBuildPrompt({ ...buildArgs, pageTypeStructureBlock: "" }));

    const critiqueArgs = {
      systemPrompt: "אתה אורי, מנהל אמנותי.",
      round: 1,
      shotList: "- 390px: /tmp/shot-390.png",
      referenceList: "",
      brandBrief: "בריף מותג לדוגמה",
      standard: "## ספר הכללים",
    };
    const critique = buildCritiquePrompt({ ...critiqueArgs, pageTypeStructureBlock: renderPageTypeStructureBlock("sales-page", "") });
    expect(critique).toBe(buildCritiquePrompt({ ...critiqueArgs, pageTypeStructureBlock: "" }));
    // Task 10 added a fixed line to the mandatory checks that mentions the
    // page-type template in plain prose ("בדיקה שתבנית סוג הדף מבטלת אינה
    // חוסם"), so a bare substring match on "תבנית סוג הדף" now matches that
    // unconditional line too. The heading marker ("## תבנית סוג הדף") is what
    // actually indicates an injected page-type block, and stays the right
    // signal that none leaked in here.
    expect(critique).not.toContain("## תבנית סוג הדף");
    expect(critique).not.toContain("**קדימות:**");
  });
});

describe("the builder's prompt carries the blueprint and the precedence rule", () => {
  it("places the block right after the full design standard section", () => {
    const block = renderPageTypeStructureBlock("upsell-page", upsellBlueprint);
    const prompt = buildLpBuildPrompt({
      editInPlace: false,
      pagePath: "src/app/demo/page.tsx",
      slug: "demo",
      brandBrief: "בריף מותג לדוגמה",
      referenceBlock: "",
      fullStandard: "## Design standard body\nרצועת לוגו של מדיה חובה בראש כל דף.",
      standard: "",
      pageTypeStructureBlock: block,
      assetsBlock: "## נכסים\n(אין)",
      clientContext: "",
      lpCopy: "קופי לדוגמה",
      brief: "בריף לדוגמה",
      strategyDoc: undefined,
      feedbackBlock: "",
      designBriefBlock: "",
    });

    expect(prompt).toContain("מצב הזמנה");
    expect(prompt).toContain("**קדימות:**");
    expect(prompt).toContain("Design standard (the FULL skill, binding end to end)");
    expect(prompt.indexOf("רצועת לוגו של מדיה חובה בראש כל דף.")).toBeLessThan(
      prompt.indexOf("## תבנית סוג הדף"),
    );
  });

  it("places the design-brief block after the full standard and before the page-type block", () => {
    const block = renderPageTypeStructureBlock("upsell-page", upsellBlueprint);
    const prompt = buildLpBuildPrompt({
      editInPlace: false,
      pagePath: "src/app/demo/page.tsx",
      slug: "demo",
      brandBrief: "בריף מותג לדוגמה",
      referenceBlock: "",
      fullStandard: "## Design standard body\nרצועת לוגו של מדיה חובה בראש כל דף.",
      standard: "",
      pageTypeStructureBlock: block,
      assetsBlock: "## נכסים\n(אין)",
      clientContext: "",
      lpCopy: "קופי לדוגמה",
      brief: "בריף לדוגמה",
      strategyDoc: undefined,
      feedbackBlock: "",
      designBriefBlock: "## בריף העיצוב\nX",
    });

    const fullStandardMarker = "רצועת לוגו של מדיה חובה בראש כל דף.";
    const pageTypeMarker = "## תבנית סוג הדף";
    expect(prompt.indexOf(fullStandardMarker)).toBeLessThan(prompt.indexOf("## בריף העיצוב"));
    expect(prompt.indexOf("## בריף העיצוב")).toBeLessThan(prompt.indexOf(pageTypeMarker));
  });
});

describe("each design critic's prompt carries the same block", () => {
  it("places it right after the current skill rule book section", () => {
    const block = renderPageTypeStructureBlock("upsell-page", upsellBlueprint);
    const prompt = buildCritiquePrompt({
      systemPrompt: "אתה אורי, מנהל אמנותי.",
      round: 1,
      shotList: "- 390px: /tmp/shot-390.png",
      referenceList: "",
      brandBrief: "בריף מותג לדוגמה",
      standard: "## ספר הכללים\nרצועת לוגו של מדיה בראש כל דף.",
      pageTypeStructureBlock: block,
    });

    expect(prompt).toContain("מצב הזמנה");
    expect(prompt).toContain("**קדימות:**");
    expect(prompt).toContain("## ספר הכללים העדכני של סקיל העיצוב");
    expect(prompt.indexOf("רצועת לוגו של מדיה בראש כל דף.")).toBeLessThan(
      prompt.indexOf("## תבנית סוג הדף"),
    );
  });
});

describe("design critic mandatory checks", () => {
  const args = {
    systemPrompt: "אתה אורי, מנהל אמנותי.",
    round: 1,
    shotList: "- 390px: /tmp/shot-390.png",
    referenceList: "",
    brandBrief: "בריף מותג לדוגמה",
    standard: "## ספר הכללים",
  };

  it("lists nine mandatory checks, including the four image-map checks", () => {
    const prompt = buildCritiquePrompt({ ...args, pageTypeStructureBlock: "" });
    expect(prompt).toContain("6. הירו דומיננטי:");
    expect(prompt).toContain("7. עדויות קריאות:");
    expect(prompt).toContain("8. כפתור קרוב:");
    expect(prompt).toContain("9. התמונה הנכונה ליד הכותרת:");
  });

  it("injects the approved image map and the desert warning before the checks", () => {
    const prompt = buildCritiquePrompt({
      ...args,
      pageTypeStructureBlock: "",
      placementBlock: "| File | Section | Proves |\n|---|---|---|\n| `public/demo/hero.webp` | Hero | כותרת |",
      desertWarning: "הקטע הארוך ביותר בלי תמונה או כפתור ב-390px: 3.4 מסכים",
    });
    const mapAt = prompt.indexOf("## מפת התמונות שאושרה");
    const warningAt = prompt.indexOf("## אזהרה, לא חוסם: מדבר טקסט במובייל");
    const checksAt = prompt.indexOf("## בדיקות חובה");
    expect(mapAt).toBeGreaterThan(-1);
    expect(warningAt).toBeGreaterThan(mapAt);
    expect(checksAt).toBeGreaterThan(warningAt);
  });

  it("keeps the page-type precedence block after the rule book on upsell and squeeze pages", () => {
    for (const type of ["upsell-page", "squeeze-page"] as const) {
      const block = renderPageTypeStructureBlock(type, "## המבנה המחייב\nמבנה לדוגמה");
      const prompt = buildCritiquePrompt({ ...args, pageTypeStructureBlock: block, placementBlock: "טבלה" });
      expect(prompt.indexOf("**קדימות:**")).toBeGreaterThan(prompt.indexOf("## ספר הכללים"));
      expect(prompt.indexOf("**קדימות:**")).toBeLessThan(prompt.indexOf("## בדיקות חובה"));
    }
  });
});
