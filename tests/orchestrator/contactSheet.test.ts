import { describe, it, expect } from "vitest";
import { buildContactSheet, buildContactSheetWithStatus } from "@/orchestrator/contactSheet";

const FILES = ["hero-portrait.webp", "module-3-mockup.webp", "logo-ynet.webp"];

describe("buildContactSheet", () => {
  it("shows every asset, referenced relatively so file:// works", () => {
    const html = buildContactSheet(FILES, {});
    for (const f of FILES) {
      expect(html).toContain(`src="${f}"`);
      expect(html).toContain(f);
    }
    expect(html).not.toContain("http://");
  });

  it("puts the caption from the manifest next to its file", () => {
    const html = buildContactSheet(FILES, { "logo-ynet.webp": "רצועת עיתונות · נשאב מהאתר של המציגה" });
    expect(html).toContain("רצועת עיתונות");
  });

  it("marks an asset with no caption instead of leaving it bare", () => {
    const html = buildContactSheet(["mystery.webp"], {});
    expect(html).toContain("ללא מקור");
  });

  it("is right to left and says what the page is for", () => {
    const html = buildContactSheet(FILES, {});
    expect(html).toContain('dir="rtl"');
    expect(html).toContain("לאישור");
  });

  it("says so plainly when nothing was produced", () => {
    expect(buildContactSheet([], {})).toContain("לא הופק אף נכס");
  });

  it("escapes a caption so a quote cannot break the markup", () => {
    const html = buildContactSheet(["a.webp"], { "a.webp": 'כיתוב עם "מרכאות" ו-<תג>' });
    expect(html).toContain("&quot;");
    expect(html).toContain("&lt;תג&gt;");
  });

  it("shows rejected cutouts beside their source with an explicit badge", () => {
    const html = buildContactSheetWithStatus(
      ["portrait.webp", "portrait-cut.webp"],
      {},
      {
        "portrait.webp": { status: "approved", kind: "photo" },
        "portrait-cut.webp": {
          status: "rejected",
          kind: "cutout",
          sourceFile: "portrait.webp",
          problems: ["הדמות נמחקה"],
        },
      },
    );
    expect(html).toContain("נדחה");
    expect(html).toContain("מקור להשוואה: portrait.webp");
    expect(html).toContain("הדמות נמחקה");
    expect(html).toContain('class="comparison"');
    expect(html).toContain('class="image-panel source-panel"');
    expect(html).toContain('src="portrait.webp" alt="מקור portrait.webp"');
    expect(html).toContain('class="image-panel candidate-panel"');
    expect(html).toContain('src="portrait-cut.webp" alt="מועמד portrait-cut.webp"');
  });

  it("does not load a source path that is outside the preview allowlist", () => {
    const html = buildContactSheetWithStatus(
      ["portrait-cut.webp"],
      {},
      {
        "portrait-cut.webp": {
          status: "rejected",
          kind: "cutout",
          sourceFile: "../private.webp",
          problems: ["מקור לא בטוח"],
        },
      },
    );

    expect(html).not.toContain('src="../private.webp"');
    expect(html).toContain("מקור לא בטוח");
  });

  it("cache-busts a preview with the validated content hash", () => {
    const html = buildContactSheetWithStatus(
      ["portrait.webp"],
      {},
      { "portrait.webp": { status: "approved", kind: "photo" } },
      { "portrait.webp": "abc123" },
    );

    expect(html).toContain('src="portrait.webp?v=abc123"');
  });

  it("embeds each sealed snapshot only once even when several cutouts share a source", () => {
    const files = ["source.webp", "one-cut.webp", "two-cut.webp"];
    const html = buildContactSheetWithStatus(
      files,
      {},
      {
        "source.webp": { status: "approved", kind: "photo" },
        "one-cut.webp": {
          status: "review-required",
          kind: "cutout",
          sourceFile: "source.webp",
        },
        "two-cut.webp": {
          status: "review-required",
          kind: "cutout",
          sourceFile: "source.webp",
        },
      },
      {},
      {
        "source.webp": "data:image/webp;base64,UNIQUE_SOURCE_BYTES",
        "one-cut.webp": "data:image/webp;base64,ONE_BYTES",
        "two-cut.webp": "data:image/webp;base64,TWO_BYTES",
      },
    );

    expect(html.split("UNIQUE_SOURCE_BYTES")).toHaveLength(2);
    expect(html.match(/data-snapshot-file="source\.webp"/g)?.length).toBe(3);
  });

  it("shows a rejected placeholder without loading a non-previewable file", () => {
    const html = buildContactSheetWithStatus(
      ["linked.webp"],
      {},
      {
        "linked.webp": {
          status: "rejected",
          kind: "photo",
          previewable: false,
          problems: ["symlink"],
        },
      },
    );

    expect(html).toContain("התצוגה נחסמה");
    expect(html).not.toContain('src="linked.webp"');
  });

  it("shows the section and the claim each mapped asset proves, escaped", () => {
    const html = buildContactSheetWithStatus(["hero.webp"], {}, {
      "hero.webp": { status: "approved", kind: "photo", section: "Hero", proves: "״30 לקוחות״ <b>" },
    });
    expect(html).toContain("סקציה: Hero · מוכיחה: ״30 לקוחות״ &lt;b&gt;");
  });

  it("shows no placement line for an asset without a map", () => {
    const html = buildContactSheetWithStatus(["logo.webp"], {}, {
      "logo.webp": { status: "approved", kind: "logo" },
    });
    expect(html).not.toContain("סקציה:");
  });
});

import { parseAssetCaptions } from "@/orchestrator/contactSheet";

const TABLE = `
| שם קובץ | סקציה | מקור | הערה |
|---|---|---|---|
| hero-portrait.webp | Hero | עובד מ-presenter-hero.png | רקע שקוף |
| logo-ynet.webp | רצועת עיתונות | קיים | גובה אחיד |
| \`module-3-mockup.webp\` | Stack | הופק | course-mockups |
`;

describe("parseAssetCaptions", () => {
  it("maps each file to what the table says about it", () => {
    const captions = parseAssetCaptions(TABLE);
    expect(captions["hero-portrait.webp"]).toContain("Hero");
    expect(captions["hero-portrait.webp"]).toContain("רקע שקוף");
  });

  it("reads a filename the agent wrapped in backticks", () => {
    expect(parseAssetCaptions(TABLE)["module-3-mockup.webp"]).toContain("Stack");
  });

  it("skips the header and separator rows", () => {
    const captions = parseAssetCaptions(TABLE);
    expect(Object.keys(captions)).toEqual([
      "hero-portrait.webp",
      "logo-ynet.webp",
      "module-3-mockup.webp",
    ]);
  });

  it("returns nothing for prose with no table", () => {
    expect(parseAssetCaptions("הפקתי כמה תמונות")).toEqual({});
  });
});
