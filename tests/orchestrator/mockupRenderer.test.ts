import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  MOCKUP_BASE_MISSING_PROBLEM,
  MOCKUP_BASE_TOO_LARGE_PROBLEM,
  MOCKUP_COMPOSITE_PROBLEM,
  MOCKUP_OUTPUT_MISSING_PROBLEM,
  MOCKUP_REGION_PROBLEM,
  MOCKUP_REGIONS_PROBLEM,
  MOCKUP_SCREEN_SIZE_PROBLEM,
  RENDER_UNAVAILABLE_PROBLEM,
  SCREEN_ASSET_FILE_PROBLEM,
  SCREEN_ASSET_NAME_PROBLEM,
  SCREEN_DATA_BUDGET_PROBLEM,
  SCREEN_EVENT_ATTRIBUTE_PROBLEM,
  SCREEN_EXTERNAL_REFERENCE_PROBLEM,
  SCREEN_FILE_PROBLEM,
  SCREEN_JAVASCRIPT_URL_PROBLEM,
  SCREENS_DIR_PROBLEM,
  SCREEN_SCRIPT_PROBLEM,
  SCREEN_SIZE_PROBLEM,
  SCREEN_TOO_LARGE_PROBLEM,
  __resetMockupBaseMemoForTests,
  describeMockupBases,
  fileSha256,
  renderMockups,
  validateScreens,
} from "@/orchestrator/mockupRenderer";
import { MAX_RENDER_REGIONS, RENDER_INVALID_PROBLEM, RENDER_MAP_UNDECLARED_PROBLEM, type AssetPlanEntry } from "@/orchestrator/assetQuality";
import { FAKE_CHROME } from "./fakeChrome";
import { PACKAGED_BASE_SHA256, packagedBaseSha256 } from "./mockupBaseRegions";

/**
 * The boundaries are checked before any browser exists, so this half of the
 * suite never starts a process: a screen that violates one is never rendered.
 */

let assetsDir: string;
let screensDir: string;

const PLAIN_SCREEN = "<html><body><h1>שיעור ראשון</h1></body></html>";

function mockup(overrides: Partial<AssetPlanEntry> = {}): AssetPlanEntry {
  return {
    file: "module-1-mockup.webp",
    kind: "mockup",
    inputs: ["presenter-portrait.webp"],
    screens: ["ch1-laptop"],
    render: { base: "chapter", map: { "1": "ch1-laptop" } },
    ...overrides,
  };
}

async function writeScreen(name: string, html: string): Promise<void> {
  await fs.writeFile(path.join(screensDir, `${name}.html`), html);
}

async function writeSizes(sizes: unknown): Promise<void> {
  await fs.writeFile(path.join(screensDir, "sizes.json"), JSON.stringify(sizes));
}

beforeEach(async () => {
  assetsDir = await fs.mkdtemp(path.join(os.tmpdir(), "council-mockup-assets-"));
  screensDir = path.join(assetsDir, "screens");
  await fs.mkdir(screensDir);
  await writeSizes({ "ch1-laptop": [1200, 800] });
  await writeScreen("ch1-laptop", PLAIN_SCREEN);
});

afterEach(async () => {
  await fs.rm(assetsDir, { recursive: true, force: true });
});

describe("validateScreens", () => {
  it("accepts a plain screen and reports the size it must be rendered at", async () => {
    const result = await validateScreens(assetsDir, [mockup()]);

    expect(result.rejected).toEqual([]);
    expect(result.ok).toEqual([
      {
        index: 0,
        entry: "module-1-mockup.webp",
        name: "ch1-laptop",
        file: path.join(screensDir, "ch1-laptop.html"),
        html: PLAIN_SCREEN,
        width: 1200,
        height: 800,
        mapped: true,
      },
    ]);
  });

  it("checks a declared screen that no region maps, and marks it unmapped", async () => {
    await writeSizes({ "ch1-laptop": [1200, 800], "ch1-spare": [600, 400] });
    await writeScreen("ch1-spare", PLAIN_SCREEN);

    const result = await validateScreens(assetsDir, [
      mockup({ screens: ["ch1-laptop", "ch1-spare"] }),
    ]);

    expect(result.rejected).toEqual([]);
    expect(result.ok.map((screen) => [screen.name, screen.mapped])).toEqual([
      ["ch1-laptop", true],
      ["ch1-spare", false],
    ]);
  });

  it("rejects the mockup when a declared screen nothing maps is a symlink", async () => {
    const outside = path.join(assetsDir, "outside.html");
    await fs.writeFile(outside, PLAIN_SCREEN);
    await writeSizes({ "ch1-laptop": [1200, 800], "ch1-spare": [600, 400] });
    await fs.symlink(outside, path.join(screensDir, "ch1-spare.html"));

    const result = await validateScreens(assetsDir, [
      mockup({ screens: ["ch1-laptop", "ch1-spare"] }),
    ]);

    expect(result.ok).toEqual([]);
    expect(result.rejected[0]?.reason).toContain(SCREEN_FILE_PROBLEM);
  });

  it("rejects everything when the screens folder itself is a symlink", async () => {
    const elsewhere = await fs.mkdtemp(path.join(os.tmpdir(), "council-mockup-elsewhere-"));
    await fs.writeFile(path.join(elsewhere, "ch1-laptop.html"), PLAIN_SCREEN);
    await fs.writeFile(
      path.join(elsewhere, "sizes.json"),
      JSON.stringify({ "ch1-laptop": [1200, 800] }),
    );
    await fs.rm(screensDir, { recursive: true, force: true });
    await fs.symlink(elsewhere, screensDir);

    const result = await validateScreens(assetsDir, [mockup()]);

    expect(result.ok).toEqual([]);
    expect(result.rejected[0]?.reason).toContain(SCREENS_DIR_PROBLEM);
    await fs.rm(elsewhere, { recursive: true, force: true });
  });

  it("rejects a screen carrying an event attribute behind a slash", async () => {
    await writeScreen("ch1-laptop", '<html><body><div/onclick="go()">שלום</div></body></html>');

    const result = await validateScreens(assetsDir, [mockup()]);

    expect(result.ok).toEqual([]);
    expect(result.rejected[0]?.reason).toContain(SCREEN_EVENT_ATTRIBUTE_PROBLEM);
  });

  it("rejects a screen whose file is missing", async () => {
    await fs.rm(path.join(screensDir, "ch1-laptop.html"));

    const result = await validateScreens(assetsDir, [mockup()]);

    expect(result.ok).toEqual([]);
    expect(result.rejected[0]?.entry).toBe("module-1-mockup.webp");
    expect(result.rejected[0]?.reason).toContain(SCREEN_FILE_PROBLEM);
  });

  it("rejects a screen that is a symlink rather than a regular file", async () => {
    const outside = path.join(assetsDir, "outside.html");
    await fs.writeFile(outside, PLAIN_SCREEN);
    await fs.rm(path.join(screensDir, "ch1-laptop.html"));
    await fs.symlink(outside, path.join(screensDir, "ch1-laptop.html"));

    const result = await validateScreens(assetsDir, [mockup()]);

    expect(result.ok).toEqual([]);
    expect(result.rejected[0]?.reason).toContain(SCREEN_FILE_PROBLEM);
  });

  it("rejects a screen larger than the html size limit", async () => {
    await writeScreen("ch1-laptop", `<html><body>${"a".repeat(520 * 1024)}</body></html>`);

    const result = await validateScreens(assetsDir, [mockup()]);

    expect(result.ok).toEqual([]);
    expect(result.rejected[0]?.reason).toContain(SCREEN_TOO_LARGE_PROBLEM);
  });

  it("rejects a screen with no usable size in sizes.json", async () => {
    await writeSizes({ "ch1-laptop": [1200, 9000] });

    const result = await validateScreens(assetsDir, [mockup()]);

    expect(result.ok).toEqual([]);
    expect(result.rejected[0]?.reason).toContain(SCREEN_SIZE_PROBLEM);
  });

  it("rejects a screen when sizes.json itself is unreadable", async () => {
    await fs.writeFile(path.join(screensDir, "sizes.json"), "{not json");

    const result = await validateScreens(assetsDir, [mockup()]);

    expect(result.ok).toEqual([]);
    expect(result.rejected[0]?.reason).toContain(SCREEN_SIZE_PROBLEM);
  });

  it("rejects a screen carrying a script tag", async () => {
    await writeScreen("ch1-laptop", "<html><body><script>fetch('/x')</script></body></html>");

    const result = await validateScreens(assetsDir, [mockup()]);

    expect(result.ok).toEqual([]);
    expect(result.rejected[0]?.reason).toContain(SCREEN_SCRIPT_PROBLEM);
  });

  it("rejects a screen carrying an event attribute", async () => {
    await writeScreen("ch1-laptop", '<html><body><div onload="go()">שלום</div></body></html>');

    const result = await validateScreens(assetsDir, [mockup()]);

    expect(result.ok).toEqual([]);
    expect(result.rejected[0]?.reason).toContain(SCREEN_EVENT_ATTRIBUTE_PROBLEM);
  });

  it("rejects a screen carrying a javascript: url", async () => {
    await writeScreen("ch1-laptop", '<html><body><a href="javascript:go()">קדימה</a></body></html>');

    const result = await validateScreens(assetsDir, [mockup()]);

    expect(result.ok).toEqual([]);
    expect(result.rejected[0]?.reason).toContain(SCREEN_JAVASCRIPT_URL_PROBLEM);
  });

  it("rejects a screen that references an external address", async () => {
    await writeScreen("ch1-laptop", '<html><body><img src="https://example.com/a.png"></body></html>');

    const result = await validateScreens(assetsDir, [mockup()]);

    expect(result.ok).toEqual([]);
    expect(result.rejected[0]?.reason).toContain(SCREEN_EXTERNAL_REFERENCE_PROBLEM);
  });

  it("rejects a screen whose stylesheet imports an external address", async () => {
    await writeScreen(
      "ch1-laptop",
      '<html><head><style>@import url("https://fonts.example/x.css");</style></head><body>א</body></html>',
    );

    const result = await validateScreens(assetsDir, [mockup()]);

    expect(result.ok).toEqual([]);
    expect(result.rejected[0]?.reason).toContain(SCREEN_EXTERNAL_REFERENCE_PROBLEM);
  });

  it("accepts an address that is only shown as text, because nothing loads it", async () => {
    await writeScreen("ch1-laptop", "<html><body><p>https://example.com</p></body></html>");

    const result = await validateScreens(assetsDir, [mockup()]);

    expect(result.rejected).toEqual([]);
    expect(result.ok).toHaveLength(1);
  });

  it("rejects an entry whose embedded data payloads exceed the budget", async () => {
    const half = `<img src="data:image/png;base64,${"A".repeat(8 * 1024 * 1024)}">`;
    await writeSizes({ "ch1-laptop": [1200, 800], "ch1-tablet": [800, 1200] });
    await writeScreen("ch1-laptop", `<html><body>${half}</body></html>`);
    await writeScreen("ch1-tablet", `<html><body>${half}</body></html>`);

    const result = await validateScreens(assetsDir, [
      mockup({
        screens: ["ch1-laptop", "ch1-tablet"],
        render: { base: "chapter", map: { "1": "ch1-laptop", "2": "ch1-tablet" } },
      }),
    ]);

    expect(result.ok).toEqual([]);
    expect(result.rejected[0]?.reason).toContain(SCREEN_DATA_BUDGET_PROBLEM);
  });

  /**
   * `asset:<file>` is how a screen names an approved picture from the assets
   * folder. The agent used to base64 the presenter's portrait into every
   * screen by hand: 25 KB of markup became a 27 KB file, each one took about
   * ten minutes to write, and the 5.2 acceptance run of 2026-09-16 ran out of
   * budget after four of eight screens. The expansion happens here, in the copy
   * the renderer opens, so the agent writes eleven characters instead.
   */
  describe("asset: references", () => {
    async function writeAsset(name: string, bytes: Buffer | string): Promise<void> {
      await fs.writeFile(path.join(assetsDir, name), bytes);
    }

    it("expands an img reference into a data: URI in the copy it renders", async () => {
      await writeAsset("portrait.webp", "webp-bytes");
      const source = `<html><body><img src="asset:portrait.webp"></body></html>`;
      await writeScreen("ch1-laptop", source);

      const result = await validateScreens(assetsDir, [mockup()]);

      expect(result.rejected).toEqual([]);
      const expected = Buffer.from("webp-bytes").toString("base64");
      expect(result.ok[0]!.html).toBe(
        `<html><body><img src="data:image/webp;base64,${expected}"></body></html>`,
      );
      // The agent's own file is evidence: the receipt hashes it, so it is never
      // rewritten.
      expect(await fs.readFile(path.join(screensDir, "ch1-laptop.html"), "utf8")).toBe(source);
    });

    it("expands a reference inside a CSS url() too", async () => {
      await writeAsset("bg.png", "png-bytes");
      await writeScreen("ch1-laptop", "<html><style>body{background:url(asset:bg.png)}</style></html>");

      const result = await validateScreens(assetsDir, [mockup()]);

      expect(result.rejected).toEqual([]);
      expect(result.ok[0]!.html).toContain(
        `url(data:image/png;base64,${Buffer.from("png-bytes").toString("base64")})`,
      );
    });

    it("gives jpg and jpeg the one media type they share", async () => {
      await writeAsset("a.jpg", "one");
      await writeAsset("b.jpeg", "two");
      await writeScreen("ch1-laptop", `<img src="asset:a.jpg"><img src="asset:b.jpeg">`);

      const result = await validateScreens(assetsDir, [mockup()]);

      expect(result.rejected).toEqual([]);
      expect(result.ok[0]!.html).toBe(
        `<img src="data:image/jpeg;base64,${Buffer.from("one").toString("base64")}">`
        + `<img src="data:image/jpeg;base64,${Buffer.from("two").toString("base64")}">`,
      );
    });

    it("rejects a reference to a file that is not in the assets folder", async () => {
      await writeScreen("ch1-laptop", `<img src="asset:missing.webp">`);

      const result = await validateScreens(assetsDir, [mockup()]);

      expect(result.ok).toEqual([]);
      expect(result.rejected[0]!.reason).toContain(SCREEN_ASSET_FILE_PROBLEM);
      expect(result.rejected[0]!.reason).toContain("missing.webp");
    });

    it("rejects a reference that tries to walk out of the assets folder", async () => {
      const outside = path.join(path.dirname(assetsDir), "secret.webp");
      await fs.writeFile(outside, "secret");

      await writeScreen("ch1-laptop", `<img src="asset:../secret.webp">`);

      const result = await validateScreens(assetsDir, [mockup()]);

      expect(result.ok).toEqual([]);
      expect(result.rejected[0]!.reason).toContain(SCREEN_ASSET_NAME_PROBLEM);
      await fs.rm(outside, { force: true });
    });

    it("rejects a reference to a symlink, however it resolves", async () => {
      const outside = path.join(path.dirname(assetsDir), "linked.webp");
      await fs.writeFile(outside, "secret");
      await fs.symlink(outside, path.join(assetsDir, "portrait.webp"));
      await writeScreen("ch1-laptop", `<img src="asset:portrait.webp">`);

      const result = await validateScreens(assetsDir, [mockup()]);

      expect(result.ok).toEqual([]);
      expect(result.rejected[0]!.reason).toContain(SCREEN_ASSET_FILE_PROBLEM);
      await fs.rm(outside, { force: true });
    });

    it.each(["notes.txt", "logo.svg", "photo.avif"])(
      "rejects %s, which is not a picture the screen may embed",
      async (name) => {
        await writeAsset(name, "bytes");
        await writeScreen("ch1-laptop", `<img src="asset:${name}">`);

        const result = await validateScreens(assetsDir, [mockup()]);

        expect(result.ok).toEqual([]);
        expect(result.rejected[0]!.reason).toContain(SCREEN_ASSET_NAME_PROBLEM);
      },
    );

    it("rejects an empty reference instead of leaving it in the markup", async () => {
      await writeScreen("ch1-laptop", `<img src="asset:">`);

      const result = await validateScreens(assetsDir, [mockup()]);

      expect(result.ok).toEqual([]);
      expect(result.rejected[0]!.reason).toContain(SCREEN_ASSET_NAME_PROBLEM);
    });

    it("counts the expanded bytes, not the eleven characters, against the data budget", async () => {
      // One reference, expanded, is over the budget on its own.
      await writeAsset("huge.png", Buffer.alloc(12 * 1024 * 1024, 7));
      await writeScreen("ch1-laptop", `<img src="asset:huge.png"><img src="asset:huge.png">`);

      const result = await validateScreens(assetsDir, [mockup()]);

      expect(result.ok).toEqual([]);
      expect(result.rejected[0]!.reason).toContain(SCREEN_DATA_BUDGET_PROBLEM);
    }, 30_000);

    it("scans the expanded markup, so a reference cannot smuggle a script past", async () => {
      await writeAsset("portrait.webp", "bytes");
      await writeScreen("ch1-laptop", `<img src="asset:portrait.webp"><script src="x"></script>`);

      const result = await validateScreens(assetsDir, [mockup()]);

      expect(result.ok).toEqual([]);
      expect(result.rejected[0]!.reason).toContain(SCREEN_SCRIPT_PROBLEM);
    });
  });

  it("rejects a mockup whose render instruction is unusable", async () => {
    const result = await validateScreens(assetsDir, [
      mockup({ render: { base: "poster" as never, map: { "1": "ch1-laptop" } } }),
    ]);

    expect(result.ok).toEqual([]);
    expect(result.rejected[0]?.reason).toContain(RENDER_INVALID_PROBLEM);
  });

  it("rejects a mockup whose map names a screen it never declared", async () => {
    const result = await validateScreens(assetsDir, [
      mockup({ render: { base: "chapter", map: { "1": "ch9-laptop" } } }),
    ]);

    expect(result.ok).toEqual([]);
    expect(result.rejected[0]?.reason).toContain(RENDER_MAP_UNDECLARED_PROBLEM);
  });

  it("keeps a sound mockup when another one is rejected", async () => {
    await writeSizes({ "ch1-laptop": [1200, 800], "ch2-laptop": [1200, 800] });
    await writeScreen("ch2-laptop", "<html><body><script>x</script></body></html>");

    const result = await validateScreens(assetsDir, [
      mockup(),
      mockup({
        file: "module-2-mockup.webp",
        screens: ["ch2-laptop"],
        render: { base: "chapter", map: { "1": "ch2-laptop" } },
      }),
    ]);

    expect(result.ok.map((screen) => screen.name)).toEqual(["ch1-laptop"]);
    expect(result.rejected.map((rejection) => rejection.entry)).toEqual(["module-2-mockup.webp"]);
  });
});

/**
 * The renderer's lifecycle, against real supervisors and local fakes: a fake
 * browser, a fake render script and a fake interpreter. No live Chrome, no
 * Playwright and no network. Every test proves the browser tree is dead and
 * the throwaway profile is gone before it returns.
 */

const FAKE_RENDER = `import fs from "node:fs";
import path from "node:path";

const [endpoint, screensDir, sizesJson, outDir] = process.argv.slice(2);
const sizes = JSON.parse(fs.readFileSync(sizesJson, "utf8"));
const first = Object.keys(sizes).sort()[0];
fs.writeFileSync(process.env.FAKE_RENDER_FIXTURE, JSON.stringify({
  renderPid: process.pid,
  endpoint,
  screensDir,
  sizesJson,
  outDir,
  screens: Object.keys(sizes).sort(),
  // What the script would really open: the markup as it reaches the browser.
  screenHtml: first ? fs.readFileSync(path.join(screensDir, first + ".html"), "utf8") : "",
}));

const mode = process.env.FAKE_RENDER_MODE || "ok";
if (mode === "fail") {
  console.error("המסך ch1-laptop ניסה לטעון כתובת חסומה");
  process.exit(2);
}
if (mode === "partial") {
  // Some screens fail; the others are still rendered, as the real script does,
  // and every failure line names the screen it belongs to.
  const skipped = (process.env.FAKE_RENDER_SKIP || "").split(",").filter(Boolean);
  for (const name of Object.keys(sizes)) {
    if (!skipped.includes(name)) fs.writeFileSync(path.join(outDir, name + ".png"), "png:" + name);
  }
  for (const name of skipped) console.error("[" + name + "] המסך לא סיים להיטען בזמן");
  process.exit(3);
}
if (mode === "overflow") {
  // A screen whose document grew past the size it declared: no picture, a
  // failure line that names it, and the measured size in the notes either way.
  const overflowing = (process.env.FAKE_RENDER_OVERFLOW || "").split(",").filter(Boolean);
  const notes = {};
  for (const [name, size] of Object.entries(sizes)) {
    const [w, h] = size;
    const grew = overflowing.includes(name);
    const measured = (grew ? w + 420 : w) + "x" + h;
    notes[name] = ["\u05d2\u05d5\u05d3\u05dc \u05d4\u05de\u05e1\u05de\u05da " + measured];
    if (grew) {
      console.error("[" + name + "] \u05d4\u05de\u05e1\u05da \u05d2\u05d5\u05dc\u05e9 \u05de\u05e2\u05d1\u05e8 \u05dc\u05d2\u05d5\u05d3\u05dc \u05d4\u05de\u05d5\u05e6\u05d4\u05e8 (" + measured + " \u05d1\u05de\u05e7\u05d5\u05dd " + w + "x" + h + ")");
    } else {
      fs.writeFileSync(path.join(outDir, name + ".png"), "png:" + name);
    }
  }
  fs.writeFileSync(path.join(outDir, "render-notes.json"), JSON.stringify(notes));
  process.exit(4);
}
if (mode === "notes") {
  for (const name of Object.keys(sizes)) {
    fs.writeFileSync(path.join(outDir, name + ".png"), "png:" + name);
  }
  const notes = {};
  for (const name of Object.keys(sizes)) notes[name] = ["רונדר בלי להמתין לגופנים"];
  fs.writeFileSync(path.join(outDir, "render-notes.json"), JSON.stringify(notes));
  process.exit(0);
}
if (mode === "lock") {
  for (const name of Object.keys(sizes)) {
    fs.writeFileSync(path.join(outDir, name + ".png"), "png:" + name);
  }
  // Nothing may be removed from the picture directory afterwards.
  fs.chmodSync(outDir, 0o500);
  process.exit(0);
}
if (mode === "hang") {
  // Refuses SIGTERM: only a process-group owner can end it.
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
} else {
  for (const name of Object.keys(sizes)) {
    fs.writeFileSync(path.join(outDir, name + ".png"), "png:" + name);
  }
  process.exit(0);
}
`;

/**
 * Stands in for the interpreter resolvePython() picks. It logs every call, so
 * a test can state exactly which script ran with which arguments.
 */
const FAKE_PYTHON = `#!/usr/bin/env node
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const argv = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_PYTHON_LOG, JSON.stringify(argv) + "\\n");
const script = argv[0] || "";
const option = (name) => argv[argv.indexOf(name) + 1];

if (script.endsWith("detect_screens.py")) {
  if (process.env.FAKE_PYTHON_MODE === "detect-fail") {
    console.error("detect failed");
    process.exit(3);
  }
  // A frame of real device photography: the first region alone needs a screen
  // 5000 px wide, above the render ceiling.
  const huge = process.env.FAKE_PYTHON_MODE === "detect-huge";
  fs.writeFileSync(option("--labels"), "labels");
  fs.writeFileSync(option("--regions"), JSON.stringify({
    schemaVersion: 1,
    baseSha256: crypto.createHash("sha256").update(fs.readFileSync(argv[1])).digest("hex"),
    labels: option("--labels"),
    regions: [
      // 600x400 in base pixels: a screen for it is rendered at 1200x800.
      { id: 1, x0: 0, x1: huge ? 2499 : 599, y0: 0, y1: 399, area: 240000 },
      { id: 2, x0: 700, x1: 1299, y0: 0, y1: 399, area: 240000 },
    ],
  }));
  process.exit(0);
}
if (script.endsWith("composite.py")) {
  // A composite that never returns, for the mockup whose output name says so:
  // the script's own cap has to cost that mockup and no other.
  if (process.env.FAKE_PYTHON_MODE === "composite-hang" && argv[2].includes("hang")) {
    setInterval(() => {}, 1000);
  } else if (process.env.FAKE_PYTHON_MODE === "composite-no-output") {
    // Exits 0 and writes nothing: the output is not there when the digest is
    // taken.
    process.exit(0);
  } else if (process.env.FAKE_PYTHON_MODE === "composite-fail") {
    console.error("composite failed");
    process.exit(3);
  } else if (process.env.FAKE_PYTHON_MODE === "composite-noisy") {
    // Its own wording, not the renderer's deadline.
    console.error("upstream call timed out");
    process.exit(3);
  } else {
    fs.writeFileSync(argv[2], "mockup:" + path.basename(argv[2]));
    process.exit(0);
  }
}
console.error("unexpected script " + script);
process.exit(1);
`;

interface RenderFixture {
  renderPid: number;
  endpoint: string;
  screensDir: string;
  sizesJson: string;
  outDir: string;
  screens: string[];
  screenHtml: string;
}

interface ChromeFixture {
  chromePid: number;
  childPid: number;
  port?: number;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs = 8_000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return true;
    if (Date.now() > end) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("renderMockups", () => {
  let workDir: string;
  let basesDir: string;
  let cacheDir: string;
  let tempParent: string;
  let fakeChrome: string;
  let chromeFixtureFile: string;
  let renderFixtureFile: string;
  let pythonLog: string;
  let fakePython: string;

  beforeEach(async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), "council-mockup-render-"));
    basesDir = path.join(workDir, "bases");
    cacheDir = path.join(workDir, "cache");
    tempParent = path.join(workDir, "temp");
    await fs.mkdir(basesDir);
    await fs.mkdir(tempParent);
    await fs.writeFile(path.join(basesDir, "base-chapter.default.png"), "chapter-base-bytes");
    await fs.writeFile(path.join(basesDir, "base-devices.default.png"), "devices-base-bytes");

    fakeChrome = path.join(workDir, "fake-chrome.cjs");
    await fs.writeFile(fakeChrome, FAKE_CHROME, { mode: 0o755 });
    const fakeRender = path.join(workDir, "fake-render.mjs");
    await fs.writeFile(fakeRender, FAKE_RENDER);
    fakePython = path.join(workDir, "fake-python.cjs");
    await fs.writeFile(fakePython, FAKE_PYTHON, { mode: 0o755 });

    chromeFixtureFile = path.join(workDir, "chrome.json");
    renderFixtureFile = path.join(workDir, "render.json");
    pythonLog = path.join(workDir, "python.log");
    await fs.writeFile(pythonLog, "");

    process.env.CAMPAIGN_COUNCIL_CHROME_PATH = fakeChrome;
    process.env.CAMPAIGN_COUNCIL_RENDER_SCREENS_PATH = fakeRender;
    process.env.CAMPAIGN_COUNCIL_MOCKUP_CACHE_DIR = cacheDir;
    process.env.CAMPAIGN_COUNCIL_MOCKUP_TEMP_PARENT = tempParent;
    __resetMockupBaseMemoForTests();
    process.env.FAKE_CHROME_FIXTURE = chromeFixtureFile;
    process.env.FAKE_RENDER_FIXTURE = renderFixtureFile;
    process.env.FAKE_PYTHON_LOG = pythonLog;
    delete process.env.FAKE_CHROME_MODE;
    delete process.env.FAKE_RENDER_MODE;
    delete process.env.FAKE_RENDER_SKIP;
    delete process.env.FAKE_RENDER_OVERFLOW;
    delete process.env.FAKE_PYTHON_MODE;
    delete process.env.CAMPAIGN_COUNCIL_MOCKUP_PYTHON_TIMEOUT_MS;
  });

  afterEach(async () => {
    const chrome = await readChromeFixture().catch(() => undefined);
    const render = await readRenderFixture().catch(() => undefined);
    for (const pid of [chrome?.chromePid, chrome?.childPid, render?.renderPid]) {
      if (pid && alive(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
    }
    await fs.rm(workDir, { recursive: true, force: true });
    for (const name of [
      "CAMPAIGN_COUNCIL_CHROME_PATH",
      "CAMPAIGN_COUNCIL_RENDER_SCREENS_PATH",
      "CAMPAIGN_COUNCIL_MOCKUP_CACHE_DIR",
      "CAMPAIGN_COUNCIL_MOCKUP_TEMP_PARENT",
      "FAKE_CHROME_FIXTURE",
      "FAKE_RENDER_FIXTURE",
      "FAKE_PYTHON_LOG",
      "FAKE_CHROME_MODE",
      "FAKE_RENDER_MODE",
      "FAKE_RENDER_SKIP",
      "FAKE_RENDER_OVERFLOW",
      "FAKE_PYTHON_MODE",
      "CAMPAIGN_COUNCIL_MOCKUP_PYTHON_TIMEOUT_MS",
    ]) {
      delete process.env[name];
    }
  });

  async function readChromeFixture(): Promise<ChromeFixture> {
    return JSON.parse(await fs.readFile(chromeFixtureFile, "utf8")) as ChromeFixture;
  }

  async function readRenderFixture(): Promise<RenderFixture> {
    return JSON.parse(await fs.readFile(renderFixtureFile, "utf8")) as RenderFixture;
  }

  async function pythonCalls(): Promise<string[][]> {
    const log = await fs.readFile(pythonLog, "utf8");
    return log.split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]);
  }

  async function expectNothingLeftBehind(): Promise<void> {
    const chrome = await readChromeFixture().catch(() => undefined);
    if (chrome) {
      expect(await waitUntil(() => !alive(chrome.chromePid)), "the browser is still alive").toBe(true);
      expect(await waitUntil(() => !alive(chrome.childPid)), "the browser child is still alive").toBe(true);
    }
    const render = await readRenderFixture().catch(() => undefined);
    if (render) {
      expect(await waitUntil(() => !alive(render.renderPid)), "the render script is still alive").toBe(true);
    }
    // The throwaway profile and the render scratch directory live here.
    expect(await fs.readdir(tempParent)).toEqual([]);
  }

  function render(overrides: Partial<Parameters<typeof renderMockups>[0]> = {}) {
    return renderMockups({
      assetsDir,
      attemptId: "attempt-1",
      entries: [mockup()],
      basesDir,
      python: fakePython,
      deadline: Date.now() + 20_000,
      ...overrides,
    });
  }

  it("renders the declared screens and composites them onto the base frame", async () => {
    const receipt = await render();

    expect(receipt.schemaVersion).toBe(1);
    expect(receipt.attemptId).toBe("attempt-1");
    expect(receipt.baseSha256.chapter).toBe(
      await fileSha256(path.join(basesDir, "base-chapter.default.png")),
    );
    expect(receipt.mockups).toHaveLength(1);
    const entry = receipt.mockups[0]!;
    expect(entry.status).toBe("ok");
    expect(entry.reason).toBeUndefined();
    expect(entry.screensSha256["ch1-laptop"]).toBe(
      await fileSha256(path.join(screensDir, "ch1-laptop.html")),
    );
    expect(entry.outputSha256).toBe(await fileSha256(path.join(assetsDir, "module-1-mockup.webp")));
    // The screens that passed the boundaries travel with the receipt: the
    // caller needs them to know which files under screens/ may be excused,
    // and must not have to re-read the folder to learn it.
    expect(receipt.acceptedScreens).toEqual(["ch1-laptop"]);

    // The render script was told the endpoint of the browser the orchestrator
    // owns, and only the screens that passed the boundaries.
    const fixture = await readRenderFixture();
    const chrome = await readChromeFixture();
    expect(fixture.endpoint).toBe(`http://127.0.0.1:${chrome.port}`);
    // The renderer opens its own copy of the screens, never the agent's folder:
    // the copy is where `asset:` references are already data: URIs, and the
    // agent's file stays exactly as the receipt hashed it.
    expect(fixture.screensDir).not.toBe(screensDir);
    expect(fixture.screens).toEqual(["ch1-laptop"]);
    expect(fixture.screenHtml).toBe(PLAIN_SCREEN);

    const composite = (await pythonCalls()).find((call) => call[0]?.endsWith("composite.py"))!;
    expect(composite[1]).toBe(path.join(basesDir, "base-chapter.default.png"));
    expect(composite[2]).toBe(path.join(assetsDir, "module-1-mockup.webp"));
    expect(composite).toContain("--scale");
    expect(composite[composite.indexOf("--scale") + 1]).toBe("2");
    expect(composite[composite.indexOf("--map") + 1]).toBe(
      `1=${path.join(fixture.outDir, "ch1-laptop.png")}`,
    );

    await expectNothingLeftBehind();
  }, 30_000);

  it("renders a copy in which the screen's asset: reference is already a data: URI", async () => {
    await fs.writeFile(path.join(assetsDir, "portrait.webp"), "webp-bytes");
    const source = `<html><body><img src="asset:portrait.webp"></body></html>`;
    await fs.writeFile(path.join(screensDir, "ch1-laptop.html"), source);

    const receipt = await render();

    expect(receipt.mockups[0]!.status).toBe("ok");
    const fixture = await readRenderFixture();
    expect(fixture.screenHtml).toBe(
      `<html><body><img src="data:image/webp;base64,${Buffer.from("webp-bytes").toString("base64")}"></body></html>`,
    );
    // The agent's own file is what the receipt hashed, so it is untouched.
    expect(await fs.readFile(path.join(screensDir, "ch1-laptop.html"), "utf8")).toBe(source);
    expect(receipt.mockups[0]!.screensSha256["ch1-laptop"]).toBe(
      await fileSha256(path.join(screensDir, "ch1-laptop.html")),
    );

    await expectNothingLeftBehind();
  }, 30_000);

  // The 5.2 prompt tells the agent which region ids exist and how big each
  // screen has to be. It reads them from the same detection the renderer runs,
  // so the two can never disagree about a frame.
  it("describes each base frame's region ids and the screen size each needs", async () => {
    const described = await describeMockupBases(basesDir, fakePython);

    expect(described.map((base) => base.base)).toEqual(["devices", "chapter"]);
    for (const base of described) {
      expect(base.error).toBeUndefined();
      // 600x400 base pixels per region, composited at scale 2.
      expect(base.regions).toEqual([
        { id: 1, width: 1200, height: 800 },
        { id: 2, width: 1200, height: 800 },
      ]);
    }
  }, 20_000);

  // The prompt is built on every 5.2 attempt. A detection that failed once in
  // this process must not cost another PYTHON_TIMEOUT_MS on the next attempt.
  it("does not retry a failed detection in the same process", async () => {
    process.env.FAKE_PYTHON_MODE = "detect-fail";
    const first = await describeMockupBases(basesDir, fakePython);
    const afterFirst = (await pythonCalls()).filter((call) => call[0]?.endsWith("detect_screens.py")).length;

    const second = await describeMockupBases(basesDir, fakePython);

    const afterSecond = (await pythonCalls()).filter((call) => call[0]?.endsWith("detect_screens.py")).length;
    expect(afterFirst).toBe(2);
    expect(afterSecond).toBe(afterFirst);
    expect(first[0]!.error).toContain(MOCKUP_REGIONS_PROBLEM);
    expect(second[0]!.error).toContain(MOCKUP_REGIONS_PROBLEM);
  }, 20_000);

  it("describes a replaced base frame again instead of serving the memo", async () => {
    process.env.FAKE_PYTHON_MODE = "detect-fail";
    await describeMockupBases(basesDir, fakePython);
    await fs.writeFile(path.join(basesDir, "base-chapter.default.png"), "a different base frame");

    const again = await describeMockupBases(basesDir, fakePython);

    const detections = (await pythonCalls())
      .filter((call) => call[0]?.endsWith("detect_screens.py"))
      .filter((call) => String(call[1]).endsWith("base-chapter.default.png"));
    expect(detections).toHaveLength(2);
    expect(again[1]!.error).toContain(MOCKUP_REGIONS_PROBLEM);
  }, 20_000);

  // Fix round 2: an installed frame the process cannot read degrades like any
  // other unreadable frame. It used to throw out of the prompt build.
  it("reports an installed frame it cannot read instead of failing the caller", async () => {
    const frame = path.join(basesDir, "base-devices.default.png");
    await fs.chmod(frame, 0o000);

    const described = await describeMockupBases(basesDir, fakePython);

    await fs.chmod(frame, 0o644);
    expect(described[0]!.regions).toEqual([]);
    expect(described[0]!.error).toBeTruthy();
    // The other frame is unaffected.
    expect(described[1]!.regions).toHaveLength(2);
  }, 20_000);

  it("reports a base frame whose regions cannot be read instead of guessing them", async () => {
    process.env.FAKE_PYTHON_MODE = "detect-fail";
    await fs.rm(path.join(basesDir, "base-devices.default.png"));

    const described = await describeMockupBases(basesDir, fakePython);

    const [devices, chapter] = described;
    expect(devices!.regions).toEqual([]);
    expect(devices!.error).toContain(MOCKUP_BASE_MISSING_PROBLEM);
    expect(chapter!.regions).toEqual([]);
    expect(chapter!.error).toContain(MOCKUP_REGIONS_PROBLEM);
  }, 20_000);

  // I3: a frame bigger than the render ceiling is the operator's installation,
  // not the agent's plan. The prompt must not advertise a size sizes.json is
  // then judged invalid for, and the sheet must not blame the agent for it.
  it("reports a base frame whose region needs a screen over the ceiling as unusable", async () => {
    process.env.FAKE_PYTHON_MODE = "detect-huge";

    const described = await describeMockupBases(basesDir, fakePython);

    for (const base of described) {
      expect(base.regions).toEqual([]);
      expect(base.unusable).toBe(true);
      expect(base.error).toContain(MOCKUP_BASE_TOO_LARGE_PROBLEM);
      // The region and the size it demands, so the operator knows what to change.
      expect(base.error).toContain("אזור 1");
      expect(base.error).toContain("5000x800");
      expect(base.error).toContain("4096");
    }
  }, 20_000);

  it("rejects every mockup on an over-sized base frame with the frame's own reason", async () => {
    process.env.FAKE_PYTHON_MODE = "detect-huge";
    // The agent obeyed a prompt built before the ceiling was checked, so
    // sizes.json carries the size the region really needs.
    await writeSizes({ "ch1-laptop": [5000, 800] });

    const receipt = await render();

    const row = receipt.mockups[0]!;
    expect(row.status).toBe("rejected");
    expect(row.reason).toContain(MOCKUP_BASE_TOO_LARGE_PROBLEM);
    expect(row.reason).toContain("אזור 1");
    // Never the reason that blames the agent's sizes.json for the operator's frame.
    expect(row.reason).not.toContain(SCREEN_SIZE_PROBLEM);
    await expectNothingLeftBehind();
  }, 30_000);

  it("detects the base frame's regions once and reuses the cache", async () => {
    await render();
    await render();

    const detections = (await pythonCalls()).filter((call) => call[0]?.endsWith("detect_screens.py"));
    expect(detections).toHaveLength(1);
    await expectNothingLeftBehind();
  }, 40_000);

  it("detects the regions again when the base frame was replaced", async () => {
    await render();
    await fs.writeFile(path.join(basesDir, "base-chapter.default.png"), "a different base frame");

    const receipt = await render();

    const detections = (await pythonCalls()).filter((call) => call[0]?.endsWith("detect_screens.py"));
    expect(detections).toHaveLength(2);
    expect(receipt.baseSha256.chapter).toBe(
      await fileSha256(path.join(basesDir, "base-chapter.default.png")),
    );
    await expectNothingLeftBehind();
  }, 40_000);

  it("rejects the mockup whose screen broke a boundary and renders the other one", async () => {
    await writeSizes({ "ch1-laptop": [1200, 800], "ch2-laptop": [1200, 800] });
    await writeScreen("ch2-laptop", "<html><body><script>x</script></body></html>");

    const receipt = await render({
      entries: [
        mockup(),
        mockup({
          file: "module-2-mockup.webp",
          screens: ["ch2-laptop"],
          render: { base: "chapter", map: { "1": "ch2-laptop" } },
        }),
      ],
    });

    expect(receipt.mockups.map((entry) => [entry.file, entry.status])).toEqual([
      ["module-1-mockup.webp", "ok"],
      ["module-2-mockup.webp", "rejected"],
    ]);
    expect(receipt.mockups[1]?.reason).toContain(SCREEN_SCRIPT_PROBLEM);
    // The rejected screen was never handed to the browser.
    expect((await readRenderFixture()).screens).toEqual(["ch1-laptop"]);
    await expectNothingLeftBehind();
  }, 30_000);

  // I4: the receipt is written into the run state, whose validator caps a hash
  // record at 512 entries and fails the whole save otherwise.
  it("records no more screen hashes than the plan contract allows", async () => {
    const names = Array.from({ length: 40 }, (_, index) => `ch${index}-laptop`);
    for (const name of names) await writeScreen(name, PLAIN_SCREEN);
    await writeSizes(Object.fromEntries(names.map((name) => [name, [1200, 800]])));

    const receipt = await render({
      entries: [mockup({ screens: names, render: { base: "chapter", map: { "1": names[0]! } } })],
    });

    expect(Object.keys(receipt.mockups[0]!.screensSha256).length).toBeLessThanOrEqual(MAX_RENDER_REGIONS);
    await expectNothingLeftBehind();
  }, 30_000);

  // Minor 5: composite.py has a cap of its own, and the design says a composite
  // failure rejects that entry and the rest still render. Only the attempt's
  // own deadline ends the run.
  it("rejects only the mockup whose composite timed out, and renders the rest", async () => {
    process.env.FAKE_PYTHON_MODE = "composite-hang";
    // This cap also covers healthy supervised subprocess startup. Leave enough
    // time under full-suite load; the selected fixture hangs indefinitely.
    process.env.CAMPAIGN_COUNCIL_MOCKUP_PYTHON_TIMEOUT_MS = "5000";
    await writeSizes({ "ch1-laptop": [1200, 800], "ch2-laptop": [1200, 800] });
    await writeScreen("ch2-laptop", PLAIN_SCREEN);

    const receipt = await render({
      deadline: Date.now() + 60_000,
      entries: [
        mockup({ file: "module-hang-mockup.webp" }),
        mockup({
          file: "module-2-mockup.webp",
          screens: ["ch2-laptop"],
          render: { base: "chapter", map: { "1": "ch2-laptop" } },
        }),
      ],
    });

    expect(receipt.mockups[0]?.status).toBe("rejected");
    expect(receipt.mockups[0]?.reason).toContain(MOCKUP_COMPOSITE_PROBLEM);
    expect(receipt.mockups[1]?.status).toBe("ok");
    await expectNothingLeftBehind();
  }, 40_000);

  // Minor 7: the digest is what binds the file to the receipt, so the row is
  // "ok" only once it is in hand. A vanished output used to throw the render.
  it("rejects the mockup when the composite left no file behind", async () => {
    process.env.FAKE_PYTHON_MODE = "composite-no-output";

    const receipt = await render();

    expect(receipt.mockups[0]?.status).toBe("rejected");
    expect(receipt.mockups[0]?.reason).toContain(MOCKUP_OUTPUT_MISSING_PROBLEM);
    expect(receipt.mockups[0]?.outputSha256).toBeUndefined();
    await expectNothingLeftBehind();
  }, 30_000);

  it("starts no browser when every mockup was rejected at the boundary", async () => {
    await writeScreen("ch1-laptop", "<html><body><script>x</script></body></html>");

    const receipt = await render();

    expect(receipt.mockups[0]?.status).toBe("rejected");
    await expect(fs.stat(chromeFixtureFile)).rejects.toThrow();
    await expectNothingLeftBehind();
  }, 30_000);

  it("rejects a mockup that maps a region the base frame does not offer", async () => {
    const receipt = await render({
      entries: [mockup({ render: { base: "chapter", map: { "7": "ch1-laptop" } } })],
    });

    expect(receipt.mockups[0]?.status).toBe("rejected");
    expect(receipt.mockups[0]?.reason).toContain(MOCKUP_REGION_PROBLEM);
    // Nothing was rendered and nothing was composited for it.
    await expect(fs.stat(chromeFixtureFile)).rejects.toThrow();
    expect((await pythonCalls()).some((call) => call[0]?.endsWith("composite.py"))).toBe(false);
    await expectNothingLeftBehind();
  }, 30_000);

  it("rejects a mockup whose base frame is not installed", async () => {
    await fs.rm(path.join(basesDir, "base-chapter.default.png"));

    const receipt = await render();

    expect(receipt.mockups[0]?.status).toBe("rejected");
    expect(receipt.mockups[0]?.reason).toContain(MOCKUP_BASE_MISSING_PROBLEM);
    await expect(fs.stat(chromeFixtureFile)).rejects.toThrow();
    await expectNothingLeftBehind();
  }, 30_000);

  it("rejects every mockup when the browser does not start, without failing the run", async () => {
    process.env.FAKE_CHROME_MODE = "crash";

    const receipt = await render();

    expect(receipt.mockups[0]?.status).toBe("rejected");
    expect(receipt.mockups[0]?.reason).toBe(RENDER_UNAVAILABLE_PROBLEM);
    await expectNothingLeftBehind();
  }, 30_000);

  it("rejects only the mockup whose screen failed, and keeps the other one", async () => {
    process.env.FAKE_RENDER_MODE = "partial";
    process.env.FAKE_RENDER_SKIP = "ch2-laptop";
    await writeSizes({ "ch1-laptop": [1200, 800], "ch2-laptop": [1200, 800] });
    await writeScreen("ch2-laptop", PLAIN_SCREEN);

    const receipt = await render({
      entries: [
        mockup(),
        mockup({
          file: "module-2-mockup.webp",
          screens: ["ch2-laptop"],
          render: { base: "chapter", map: { "1": "ch2-laptop" } },
        }),
      ],
    });

    expect(receipt.mockups.map((entry) => [entry.file, entry.status])).toEqual([
      ["module-1-mockup.webp", "ok"],
      ["module-2-mockup.webp", "rejected"],
    ]);
    expect(receipt.mockups[1]?.reason).toContain("ch2-laptop");
    expect(receipt.mockups[0]?.outputSha256).toBeTruthy();
    delete process.env.FAKE_RENDER_SKIP;
    await expectNothingLeftBehind();
  }, 30_000);

  it("renders only the screens a region maps", async () => {
    await writeSizes({ "ch1-laptop": [1200, 800], "ch1-spare": [1200, 800] });
    await writeScreen("ch1-spare", PLAIN_SCREEN);

    const receipt = await render({
      entries: [mockup({ screens: ["ch1-laptop", "ch1-spare"] })],
    });

    expect(receipt.mockups[0]?.status).toBe("ok");
    expect((await readRenderFixture()).screens).toEqual(["ch1-laptop"]);
    await expectNothingLeftBehind();
  }, 30_000);

  it("rejects a mockup whose screen does not fill its region", async () => {
    await writeSizes({ "ch1-laptop": [1200, 900] });

    const receipt = await render();

    expect(receipt.mockups[0]?.status).toBe("rejected");
    expect(receipt.mockups[0]?.reason).toContain(MOCKUP_SCREEN_SIZE_PROBLEM);
    // The reason names the size the screen has to be rendered at.
    expect(receipt.mockups[0]?.reason).toContain("1200x800");
    await expect(fs.stat(chromeFixtureFile)).rejects.toThrow();
    await expectNothingLeftBehind();
  }, 30_000);

  // Minor 1: the region-id rule now lives in the contract, so a key that is
  // not digits is an invalid render instruction the sheet states as such,
  // rather than a region the frame happens not to offer.
  it("rejects a mockup whose region id is not a plain number", async () => {
    const receipt = await render({
      entries: [mockup({ render: { base: "chapter", map: { "1.0": "ch1-laptop" } } })],
    });

    expect(receipt.mockups[0]?.status).toBe("rejected");
    expect(receipt.mockups[0]?.reason).toContain(RENDER_INVALID_PROBLEM);
    await expect(fs.stat(chromeFixtureFile)).rejects.toThrow();
    await expectNothingLeftBehind();
  }, 30_000);

  it("rejects the run when the deadline passes while the browser is starting", async () => {
    process.env.FAKE_CHROME_MODE = "never-ready";

    await expect(render({ deadline: Date.now() + 700 })).rejects.toThrow(/זמן/);

    await expectNothingLeftBehind();
  }, 30_000);

  it("rejects the mockups when the render script exits non-zero", async () => {
    process.env.FAKE_RENDER_MODE = "fail";

    const receipt = await render();

    expect(receipt.mockups[0]?.status).toBe("rejected");
    expect(receipt.mockups[0]?.reason).toContain("כתובת חסומה");
    expect((await pythonCalls()).some((call) => call[0]?.endsWith("composite.py"))).toBe(false);
    await expectNothingLeftBehind();
  }, 30_000);

  it("rejects the mockup when the composite fails", async () => {
    process.env.FAKE_PYTHON_MODE = "composite-fail";

    const receipt = await render();

    expect(receipt.mockups[0]?.status).toBe("rejected");
    expect(receipt.mockups[0]?.reason).toContain(MOCKUP_COMPOSITE_PROBLEM);
    expect(receipt.mockups[0]?.outputSha256).toBeUndefined();
    await expectNothingLeftBehind();
  }, 30_000);

  it("carries the render script's per-screen notes into the receipt of a rendered mockup", async () => {
    process.env.FAKE_RENDER_MODE = "notes";

    const receipt = await render();

    expect(receipt.mockups[0]?.status).toBe("ok");
    expect(receipt.mockups[0]?.notes).toEqual(["ch1-laptop: רונדר בלי להמתין לגופנים"]);
    await expectNothingLeftBehind();
  }, 30_000);

  // F9: the screen that broke the acceptance run rendered perfectly well, it
  // was simply bigger than the box it declared, so the shot came out shifted
  // and clipped. The renderer now measures the document and refuses it, and
  // the measurement rides along on every row either way.
  it("rejects only the mockup whose screen overflowed its declared size", async () => {
    process.env.FAKE_RENDER_MODE = "overflow";
    process.env.FAKE_RENDER_OVERFLOW = "ch1-laptop";
    await writeSizes({ "ch1-laptop": [1200, 800], "ch2-laptop": [1200, 800] });
    await writeScreen("ch2-laptop", PLAIN_SCREEN);

    const receipt = await render({
      entries: [
        mockup(),
        mockup({
          file: "module-2-mockup.webp",
          screens: ["ch2-laptop"],
          render: { base: "chapter", map: { "1": "ch2-laptop" } },
        }),
      ],
    });

    expect(receipt.mockups.map((entry) => [entry.file, entry.status])).toEqual([
      ["module-1-mockup.webp", "rejected"],
      ["module-2-mockup.webp", "ok"],
    ]);
    expect(receipt.mockups[0]?.reason).toContain("המסך גולש מעבר לגודל המוצהר");
    expect(receipt.mockups[0]?.reason).toContain("1620x800 במקום 1200x800");
    expect(receipt.mockups[0]?.reason).not.toContain("ch2-laptop");
    // The size is on the sheet for the screen that rendered too, so a mockup
    // that came out right can still be checked against the box it declared.
    expect(receipt.mockups[0]?.notes).toEqual(["ch1-laptop: גודל המסמך 1620x800"]);
    expect(receipt.mockups[1]?.notes).toEqual(["ch2-laptop: גודל המסמך 1200x800"]);
    expect(receipt.mockups[1]?.outputSha256).toBeTruthy();
    await expectNothingLeftBehind();
  }, 30_000);

  it("gives each rejected mockup only the failure lines naming its own screens", async () => {
    process.env.FAKE_RENDER_MODE = "partial";
    process.env.FAKE_RENDER_SKIP = "ch1-laptop,ch2-laptop";
    await writeSizes({ "ch1-laptop": [1200, 800], "ch2-laptop": [1200, 800] });
    await writeScreen("ch2-laptop", PLAIN_SCREEN);

    const receipt = await render({
      entries: [
        mockup(),
        mockup({
          file: "module-2-mockup.webp",
          screens: ["ch2-laptop"],
          render: { base: "chapter", map: { "1": "ch2-laptop" } },
        }),
      ],
    });

    expect(receipt.mockups.map((entry) => entry.status)).toEqual(["rejected", "rejected"]);
    expect(receipt.mockups[0]?.reason).toContain("ch1-laptop");
    expect(receipt.mockups[0]?.reason).not.toContain("ch2-laptop");
    expect(receipt.mockups[1]?.reason).toContain("ch2-laptop");
    expect(receipt.mockups[1]?.reason).not.toContain("ch1-laptop");
    delete process.env.FAKE_RENDER_SKIP;
    await expectNothingLeftBehind();
  }, 30_000);

  it("returns the receipt when the render scratch directory cannot be removed", async () => {
    process.env.FAKE_RENDER_MODE = "lock";

    const receipt = await render();

    // Everything rendered, so a scratch directory left behind is a warning and
    // never a reason to throw away a finished run.
    expect(receipt.mockups[0]?.status).toBe("ok");
    expect(receipt.warnings?.join(" ")).toContain("תיקיית הרינדור");
    const leftovers = await fs.readdir(tempParent);
    expect(leftovers.some((name) => name.startsWith("council-mockup-profile-"))).toBe(false);
    for (const name of leftovers) {
      await fs.chmod(path.join(tempParent, name, "png"), 0o700).catch(() => {});
    }
  }, 30_000);

  it("keeps a composite failure per mockup even when its message mentions a timeout", async () => {
    process.env.FAKE_PYTHON_MODE = "composite-noisy";

    const receipt = await render();

    expect(receipt.mockups[0]?.status).toBe("rejected");
    expect(receipt.mockups[0]?.reason).toContain(MOCKUP_COMPOSITE_PROBLEM);
    await expectNothingLeftBehind();
  }, 30_000);

  it("reaps the browser and the render script when the run is cancelled", async () => {
    process.env.FAKE_RENDER_MODE = "hang";
    const controller = new AbortController();

    const running = render({ signal: controller.signal });
    expect(await waitUntil(async () => Boolean(await readRenderFixture().catch(() => undefined)))).toBe(true);
    controller.abort();

    await expect(running).rejects.toThrow(/בוטל/);
    await expectNothingLeftBehind();
  }, 30_000);

  it("reaps the browser and the render script when the deadline passes", async () => {
    process.env.FAKE_RENDER_MODE = "hang";

    const running = render({ deadline: Date.now() + 1_500 });

    await expect(running).rejects.toThrow(/זמן/);
    await expectNothingLeftBehind();
  }, 30_000);
});

/**
 * The prompt suites assert the geometry of the packaged frames from a seeded
 * cache. Nothing there notices a frame being replaced, so this does.
 */
describe("the seeded packaged-frame fixture", () => {
  it("still matches the base frames installed in the repository", async () => {
    for (const base of ["devices", "chapter"] as const) {
      expect(await packagedBaseSha256(base), base).toBe(PACKAGED_BASE_SHA256[base]);
    }
  });
});
