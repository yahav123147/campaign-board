import { describe, expect, it } from "vitest";
import {
  extractPlanJson,
  assertPlanEntry,
  resolvePresenterDir,
  DEFAULT_PRESENTER_DIR,
  CREATIVES_DISABLED_MARKER,
} from "@/orchestrator/runStage7Creatives";
import { CREATIVE_MODE_CHOICE_MARKER, isCreativeMode } from "@/lib/creativeMode";

describe("stage 7.5 creative plan parsing", () => {
  it("extracts the first balanced JSON object from chatty output", () => {
    const text = 'הנה התוכנית:\n```json\n{"creatives":[{"ad":1,"file":"ad-1.png","mode":"generated","image_prompt":"dark premium desk scene, no text","spec":{"lines":[{"cy":800,"text":"שלום","size":80,"weight":900}]}}]}\n```\nבהצלחה { לא רלוונטי }';
    const plan = extractPlanJson(text);
    expect(plan.creatives).toHaveLength(1);
    expect(plan.creatives[0].file).toBe("ad-1.png");
  });

  it("caps the plan at three creatives", () => {
    const entry = '{"ad":1,"file":"a.png","mode":"generated","image_prompt":"x","spec":{"lines":[{"cy":1,"text":"א","size":10,"weight":400}]}}';
    const text = `{"creatives":[${entry},${entry},${entry},${entry},${entry}]}`;
    expect(extractPlanJson(text).creatives).toHaveLength(3);
  });

  it("rejects output with no JSON or an empty plan", () => {
    expect(() => extractPlanJson("אין לי תוכנית")).toThrow();
    expect(() => extractPlanJson('{"creatives":[]}')).toThrow();
  });

  it("keeps braces inside strings from confusing the parser", () => {
    const text = '{"creatives":[{"ad":1,"file":"a.png","mode":"generated","image_prompt":"scene with {curly} shapes","spec":{"lines":[{"cy":1,"text":"א","size":10,"weight":400}]}}]}';
    expect(extractPlanJson(text).creatives[0].image_prompt).toContain("{curly}");
  });

  it("picks the real plan when the agent first echoes the schema example (F97)", () => {
    const example = '{"creatives":[{"ad":1,"file":"ad-1.png","mode":"presenter","presenter_photo":"<שם קובץ מהרשימה>","spec":{"lines":[{"cy":850,"text":"<הוק>","size":92,"weight":900}]}}]}';
    const real = '{"creatives":[{"ad":1,"file":"ad-1.png","mode":"presenter","presenter_photo":"me.jpg","spec":{"lines":[{"cy":850,"text":"הוק אמיתי","size":92,"weight":900}]}}]}';
    const plan = extractPlanJson(`הנה הפורמט:\n${example}\nוהתוכנית שלי:\n${real}`);
    expect(plan.creatives[0].presenter_photo).toBe("me.jpg");
  });

  it("does not let a trailing example echo override an earlier real plan", () => {
    const real = '{"creatives":[{"ad":1,"file":"ad-1.png","mode":"presenter","presenter_photo":"me.jpg","spec":{"lines":[{"cy":850,"text":"הוק","size":92,"weight":900}]}}]}';
    const example = '{"creatives":[{"ad":1,"file":"ad-1.png","mode":"presenter","presenter_photo":"<placeholder>","spec":{"lines":[]}}]}';
    const plan = extractPlanJson(`${real}\nלפי הדוגמה ${example}`);
    expect(plan.creatives[0].presenter_photo).toBe("me.jpg");
  });

  it("skips broken JSON blocks and pseudo-JSON prose before the plan", () => {
    const broken = '{"creatives": לא באמת}';
    const real = '{"creatives":[{"ad":1,"file":"ad-1.png","mode":"generated","image_prompt":"clean scene","spec":{"lines":[{"cy":1,"text":"א","size":10,"weight":400}]}}]}';
    expect(extractPlanJson(`${broken}\n${real}`).creatives[0].image_prompt).toBe("clean scene");
  });

  it("accepts a rich variation entry and rejects thin or anchorless prompts", () => {
    const base = {
      ad: 1,
      file: "ad-1.png",
      mode: "variation" as const,
      presenter_photo: "me.jpg",
      spec: { lines: [{ cy: 850, text: "הוק", size: 92, weight: 900 }] },
    };
    const richPrompt =
      "Cinematic portrait of the same person as in the reference image, standing on a rooftop at golden hour, " +
      "wearing a dark knit sweater, shallow depth of field, warm rim light, confident calm expression, " +
      "clean empty lower third of the frame reserved for typography";
    expect(() => assertPlanEntry({ ...base, image_prompt: richPrompt }, ["me.jpg"])).not.toThrow();
    expect(() => assertPlanEntry({ ...base, image_prompt: "short prompt about a person" }, ["me.jpg"]))
      .toThrow(/עשיר/);
    expect(() => assertPlanEntry(
      { ...base, image_prompt: richPrompt.replace(/reference/gi, "original") }, ["me.jpg"],
    )).toThrow(/עוגן זהות/);
    expect(() => assertPlanEntry({ ...base, image_prompt: richPrompt }, ["other.jpg"]))
      .toThrow(/presenter_photo/);
  });

  it("exposes the creative mode contract to the UI", () => {
    expect(CREATIVE_MODE_CHOICE_MARKER.length).toBeGreaterThan(3);
    expect(isCreativeMode("typography")).toBe(true);
    expect(isCreativeMode("ai-variation")).toBe(true);
    expect(isCreativeMode("presenter")).toBe(false);
  });

  it("scopes the fallback photo library per tenant and disables it without one (F100)", () => {
    expect(resolvePresenterDir({ tenant: { id: "acme" } })).toBe(`${DEFAULT_PRESENTER_DIR}/acme`);
    expect(resolvePresenterDir({ tenant: { id: "a/b..c" } })).toBe(`${DEFAULT_PRESENTER_DIR}/a_b..c`);
    expect(resolvePresenterDir({ tenant: { id: "acme" }, creative: { presenterPhotosDir: "/x/photos" } }))
      .toBe("/x/photos");
    expect(resolvePresenterDir(undefined)).toBeUndefined();
    expect(resolvePresenterDir({})).toBeUndefined();
  });

  it("exposes a disabled marker for the express gate bypass", () => {
    expect(CREATIVES_DISABLED_MARKER.length).toBeGreaterThan(5);
  });
});
