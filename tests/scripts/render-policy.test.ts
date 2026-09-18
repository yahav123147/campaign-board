import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  OVERFLOW_TOLERANCE_PX,
  SCREEN_NAME_RE as POLICY_SCREEN_NAME_RE,
  allowedScreenUrls,
  documentSize,
  isAllowedRequest,
  overflowsDeclaredSize,
  selectScreens,
} from "@/vendor/course-mockups/renderPolicy.mjs";
import { SCREEN_NAME_RE } from "@/lib/mockupContract";
import { SCREEN_HTML_RE } from "@/orchestrator/assetQuality";

/**
 * The allow/abort decision the render script enforces inside the browser. It
 * lives in its own module so it can be stated here as a table, instead of
 * being reachable only through a live Chrome.
 *
 * The fence is a membership test against the exact screens of this attempt,
 * resolved through the real filesystem: a folder prefix would let any file
 * that happens to sit under screens/ be painted into a mockup, including one
 * the caller never saw and one that is a symlink to somewhere else entirely.
 */

let screensDir: string;
let outside: string;
let allowed: Set<string>;
const screenUrl = (relative: string) => pathToFileURL(path.join(screensDir, relative)).href;

beforeAll(() => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "render-policy-")));
  outside = path.join(root, "secret.html");
  fs.writeFileSync(outside, "<p>not a screen</p>");
  screensDir = path.join(root, "screens");
  fs.mkdirSync(screensDir);
  // A sibling whose name begins with the screens folder's name: the trap a
  // prefix comparison falls into.
  fs.mkdirSync(`${screensDir}-backup`);
  fs.writeFileSync(path.join(`${screensDir}-backup`, "ch1-laptop.html"), "<p>copy</p>");
  for (const name of ["ch1-laptop", "ch1-tablet", "leak"]) {
    fs.writeFileSync(path.join(screensDir, `${name}.html`), "<p>screen</p>");
  }
  fs.writeFileSync(path.join(screensDir, "logo.png"), "png");
  // The confused-deputy case: a file under screens/ that points elsewhere.
  fs.symlinkSync(outside, path.join(screensDir, "planted.html"));
  // And a DECLARED name that is a symlink: the name is on the list, the bytes
  // are not the caller's.
  fs.symlinkSync(outside, path.join(screensDir, "ch1-swapped.html"));
  allowed = allowedScreenUrls(screensDir, ["ch1-laptop", "ch1-tablet", "ch1-swapped"]);
});

afterAll(() => {
  fs.rmSync(path.dirname(screensDir), { recursive: true, force: true });
});

describe("render request policy", () => {
  it.each([
    ["the declared screen itself", () => screenUrl("ch1-laptop.html"), true],
    ["the other declared screen", () => screenUrl("ch1-tablet.html"), true],
    ["an embedded picture", () => "data:image/png;base64,AAAA", true],
    // The four the fence exists for.
    ["an undeclared html file in the same folder", () => screenUrl("leak.html"), false],
    ["a declared name that is a symlink out of the folder", () => screenUrl("ch1-swapped.html"), false],
    ["a planted symlink under the folder", () => screenUrl("planted.html"), false],
    ["a sibling directory that shares the prefix", () => `${pathToFileURL(screensDir).href}-backup/ch1-laptop.html`, false],
    ["a traversal out of the folder", () => screenUrl("../secret.html"), false],
    ["a traversal spelled through a subpath", () => `${pathToFileURL(screensDir).href}/sub/../../secret.html`, false],
    ["a percent-encoded traversal", () => `${pathToFileURL(screensDir).href}/%2e%2e/secret.html`, false],
    ["a picture file next to the screens", () => screenUrl("logo.png"), false],
    ["a file outside the attempt", () => "file:///etc/passwd", false],
    ["a blob url", () => "blob:null/8a9d4ce5-0000-4000-8000-000000000000", false],
    ["the empty page", () => "about:blank", false],
    ["a redirect target on the network", () => "https://example.test/redirected.html", false],
    ["plain http", () => "http://127.0.0.1:4322/ch1-laptop.html", false],
    ["an address that cannot be parsed", () => "not a url", false],
  ])("%s", (_label, url, ok) => {
    expect(isAllowedRequest((url as () => string)(), allowed)).toBe(ok);
  });

  it("allows nothing at all when the attempt declared no screens", () => {
    expect(isAllowedRequest(screenUrl("ch1-laptop.html"), allowedScreenUrls(screensDir, []))).toBe(false);
  });
});

describe("screen selection", () => {
  it("keeps the usable sizes and names the ones it refuses", () => {
    expect(selectScreens({
      "ch1-laptop": [1200, 800],
      "ch1-tablet": [800, 1200],
    })).toEqual({
      screens: [["ch1-laptop", [1200, 800]], ["ch1-tablet", [800, 1200]]],
      invalid: [],
    });
  });

  it.each([
    ["a name the renderer cannot open", { "../escape": [100, 100] }],
    ["a size that is not a pair", { "ch1-laptop": [100] }],
    ["a size that is not whole", { "ch1-laptop": [100.5, 100] }],
    ["a size that is not positive", { "ch1-laptop": [0, 100] }],
    ["a size that is not a number", { "ch1-laptop": ["100", "100"] }],
  ])("refuses %s", (_label, sizes) => {
    const selected = selectScreens(sizes as Record<string, unknown>);
    expect(selected.screens).toEqual([]);
    expect(selected.invalid).toHaveLength(1);
  });
});

interface Measured {
  documentWidth: number;
  documentHeight: number;
  bodyWidth: number;
  bodyHeight: number;
}

const box = (
  documentWidth: number,
  documentHeight: number,
  bodyWidth: number,
  bodyHeight: number,
): Measured => ({ documentWidth, documentHeight, bodyWidth, bodyHeight });

describe("document overflow", () => {
  /**
   * The 5.2 acceptance run shipped a screen whose decorative glow sat at
   * `inset-inline-end: -420px` with `overflow: hidden` on body alone. Body's
   * overflow propagates to the viewport and leaves body itself visible, so the
   * document really was wider than the declared box; in an RTL document the
   * initial scroll origin sits at the start edge, the screenshot came out
   * shifted, and every headline was clipped on the right. The renderer
   * recorded it as "ok".
   *
   * The measurement is taken from both boxes because either one can be the
   * one that grew, and the verdict is a pure function of those four numbers
   * and the size the caller declared.
   */
  const cases: [string, Measured, [number, number], boolean][] = [
    ["exactly the declared size", box(2400, 3200, 2400, 3200), [2400, 3200], false],
    ["smaller than the declared size", box(2400, 1800, 1200, 1800), [2400, 3200], false],
    ["one pixel over, inside the tolerance", box(2401, 3201, 0, 0), [2400, 3200], false],
    ["two pixels over on the width", box(2402, 3200, 0, 0), [2400, 3200], true],
    ["two pixels over on the height", box(2400, 3202, 0, 0), [2400, 3200], true],
    // The acceptance case itself: the root box is obedient, body is the one
    // the glow widened.
    ["a body wider than the root box", box(2400, 3200, 2820, 3200), [2400, 3200], true],
    ["a root box taller than body", box(2400, 3620, 2400, 3200), [2400, 3200], true],
  ];

  it.each(cases)("%s", (_label, measured, declared, overflows) => {
    expect(overflowsDeclaredSize(documentSize(measured), declared)).toBe(overflows);
  });

  it("takes the larger of the two boxes on each axis", () => {
    expect(documentSize(box(2400, 3620, 2820, 3200))).toEqual([2820, 3620]);
  });

  it("reads a measurement it cannot use as nothing, instead of guessing an overflow", () => {
    expect(documentSize(box(Number.NaN, Number.POSITIVE_INFINITY, -5, 3200))).toEqual([0, 3200]);
  });

  it("states the tolerance as one pixel", () => {
    expect(OVERFLOW_TOLERANCE_PX).toBe(1);
  });
});

describe("one screen-name rule", () => {
  /**
   * The rule lives in lib/mockupContract.ts, but vendor JS cannot import from
   * the app and the folder scan matches a path rather than a name, so two hand
   * copies exist. A name the validator accepts and the policy refuses would be
   * a screen that is declared, written, and then never loaded; the reverse
   * would be a fence wider than the contract. They are held together here.
   */
  it.each([
    ["ch1-laptop", true],
    ["ch1_laptop.v2", true],
    ["a", true],
    ["a".repeat(60), true],
    ["a".repeat(61), false],
    ["", false],
    ["../escape", false],
    ["screens/nested", false],
    ["with space", false],
    ["מסך", false],
  ])("%s", (name, allowed) => {
    expect(SCREEN_NAME_RE.test(name)).toBe(allowed);
    expect(POLICY_SCREEN_NAME_RE.test(name)).toBe(allowed);
    expect(SCREEN_HTML_RE.test(`screens/${name}.html`)).toBe(allowed);
  });

  it("is spelled identically in the render policy", () => {
    expect(POLICY_SCREEN_NAME_RE.source).toBe(SCREEN_NAME_RE.source);
  });
});
