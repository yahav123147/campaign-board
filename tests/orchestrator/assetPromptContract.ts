import { expect } from "vitest";
import { MAX_SCREEN_DATA_BYTES, MAX_SCREEN_HTML_BYTES } from "@/lib/mockupContract";

/**
 * The parts of the 5.2 prompt that must read the same in both pipelines.
 *
 * The council run and the direct run write their screens into the same folder
 * and are rendered by the same renderer, so a boundary stated to one and not
 * to the other is a rule the other one only meets as a rejection. Asserting
 * them from one place is what keeps the two prompts from drifting.
 */

/**
 * The command the prompt hands the agent for embedding an approved image,
 * without its interpreter. Kept here so both pipelines assert the same string
 * and so the direct suite can execute it.
 */
export const BASE64_RECIPE =
  `-c 'import base64,sys;print(base64.b64encode(open(sys.argv[1],"rb").read()).decode())'`;

interface MockupPlanEntry {
  kind?: string;
  screens?: string[];
  render?: { base?: string; map?: Record<string, string> };
}

/** The asset-plan schema block of the prompt, parsed. */
export function assetPlanExample(prompt: string): { assets: MockupPlanEntry[] } {
  const blocks = [...prompt.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) => match[1]!);
  const block = blocks.find((text) => text.includes('"assets"'));
  expect(block, "the prompt carries an asset-plan schema block").toBeDefined();
  return JSON.parse(block!) as { assets: MockupPlanEntry[] };
}

/** The `sizes.json` example the mockups section shows, parsed. */
export function sizesExample(prompt: string): Record<string, [number, number]> {
  const match = prompt.match(/למשל `(\{[^`]*\})`/);
  expect(match, "the prompt shows a sizes.json example").not.toBeNull();
  return JSON.parse(match![1]!) as Record<string, [number, number]>;
}

/** The line of the base listing that describes one base frame. */
export function baseListingLine(prompt: string, base: string): string {
  const line = prompt.split("\n").find((candidate) => candidate.startsWith(`- בסיס \`${base}\``));
  expect(line, `the prompt lists the base ${base}`).toBeDefined();
  return line!;
}

/** The render contract: who renders, and what the agent must not do. */
export function expectRenderContract(prompt: string): void {
  expect(prompt).not.toContain("אין דפדפן");
  expect(prompt).not.toContain("רינדור מחוץ לארגז החול");
  expect(prompt).toContain("המוקאפים מרונדרים על ידי האורקסטרטור אחרי שתסיים");
  expect(prompt).toContain("אל תפעיל דפדפן");
  expect(prompt).toContain("composite.py");
  expect(prompt).toContain("נכס mockup בלי screens ובלי render אינו מוקאפ");
  // The orchestrator writes the mockup file, so the agent must not.
  expect(prompt).toContain("אל תיצור בעצמך את הקובץ ששמו מופיע ב-file");
  // And the formats composite.py can actually write with an alpha channel:
  // a .jpg or .avif mockup is rejected by the plan validator, so the prompt
  // has to say so before the agent spends an attempt on one.
  expect(prompt).toContain("`.webp` או `.png` בלבד");
  // What a mockup declares is its screens and its render. The old sentence
  // told the agent to declare "all the input files", which was the contract
  // before the orchestrator rendered the screens itself.
  expect(prompt).not.toContain("לכל mockup חובה להצהיר את כל קובצי הקלט ב-inputs");
  expect(prompt).toContain("לכל mockup חובה להצהיר את המסכים שלו ב-screens ואת ההרכבה ב-render");
}

/**
 * The order the work has to happen in, and the budget it has to happen inside.
 *
 * The 5.2 acceptance run wrote four of eight required mockup screens and then
 * lost the turn to its timer. A missing required mockup fails the whole
 * sub-task, while any other asset is merely reported, so the screens are
 * written first and the agent is told how many minutes it actually has.
 */
export function expectScreensFirstOrder(prompt: string, budgetMinutes: number): void {
  expect(prompt).toContain("כתוב קודם את");
  expect(prompt).toContain("ורק אחר כך חיתוכים, הוכחות ושאר נכסים");
  expect(prompt).toContain(`הזמן שלך בריצה הזאת מוגבל ל-${budgetMinutes} דקות`);
  expect(prompt).toContain("אל תשקיע בנכס משני לפני שכל המסכים הנדרשים כתובים");
}

/**
 * Every boundary validateScreens and the render policy enforce, in the terms
 * the agent needs: a picture reaches a screen only as an embedded data: URI,
 * and the two budgets are stated as the numbers the code uses.
 */
export function expectScreenBoundaries(prompt: string): void {
  expect(prompt).toContain("data:");
  // How the presenter's photo actually gets onto a screen: by name, expanded
  // by the renderer. Hand-embedding it turned every 2 KB screen into a 27 KB
  // file and cost the 5.2 acceptance run half of its required mockups.
  expect(prompt).toContain('src="asset:');
  expect(prompt).toContain("url(asset:");
  expect(prompt).toContain("אל תטמיע base64 בעצמך");
  expect(prompt).toContain(".jpeg");
  // The recipe stays, for a picture that is not an approved asset file. It goes
  // through the run's python, not through `base64`: the BSD build this Board
  // runs on rejects a bare file operand, and b64encode never wraps its output.
  expect(prompt).toContain(BASE64_RECIPE);
  expect(prompt).not.toMatch(/`base64 [^-]/);
  expect(prompt).toContain("data:image/webp;base64");
  // The two mistakes the sandbox invites: a sibling path and a web font.
  expect(prompt).toContain("../portrait-cut.webp");
  expect(prompt).toContain("Google Fonts");
  expect(prompt).toContain(`${MAX_SCREEN_DATA_BYTES / (1024 * 1024)} מגה-בייט`);
  expect(prompt).toContain(`${MAX_SCREEN_HTML_BYTES / 1024} קילו-בייט`);
  expect(prompt).toContain("<script>");
  expect(prompt).toContain("javascript:");
  expect(prompt).toContain("onclick=");
  expect(prompt).toContain("@import");
  expect(prompt).toContain("מסך שחורג מאחד הגבולות האלה נפסל");
  // F9: the boundary the 5.2 acceptance run had no way to know about. A glow
  // at `inset-inline-end: -420px` with `overflow: hidden` on body alone grew
  // the document past its declared box; in RTL the shot then started at the
  // start edge and every headline was clipped. The agent is told the rule in
  // its own terms, and told that the renderer measures.
  expect(prompt).toContain("html, body { overflow: hidden }");
  expect(prompt).toContain("inset-inline-end");
  expect(prompt).toContain("scrollWidth");
  expect(prompt).toContain("מסך שגודל הגלילה שלו גדול מהגודל המוצהר נפסל");
}

/**
 * The worked examples must be legal against the base listing in the same
 * prompt: the region ids exist on the base the example names, every mapped
 * screen is declared, and every size in the sizes.json example is the size
 * that region requires.
 */
export function expectLegalWorkedExamples(prompt: string): void {
  const plan = assetPlanExample(prompt);
  const entry = plan.assets.find((asset) => asset.kind === "mockup");
  expect(entry, "the schema block shows a mockup entry").toBeDefined();
  const base = entry!.render?.base;
  expect(base, "the mockup example names a base").toBeDefined();
  const listing = baseListingLine(prompt, base!);
  const map = entry!.render?.map ?? {};
  expect(Object.keys(map).length, "the mockup example maps at least one region").toBeGreaterThan(0);

  const sizes = sizesExample(prompt);
  expect(Object.keys(sizes).sort()).toEqual([...(entry!.screens ?? [])].sort());
  for (const [id, screen] of Object.entries(map)) {
    expect(id, "region ids are digits only").toMatch(/^\d+$/);
    expect(entry!.screens, `the mapped screen ${screen} is declared`).toContain(screen);
    const size = sizes[screen];
    expect(size, `the sizes example covers ${screen}`).toBeDefined();
    // The one assertion that matters: the example is the geometry the
    // renderer will demand for that region, not a plausible looking number.
    expect(listing).toContain(`אזור "${id}" דורש מסך ${size![0]}x${size![1]} פיקסלים`);
  }
}
