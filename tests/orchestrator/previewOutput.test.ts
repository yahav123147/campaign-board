import { describe, it, expect } from "vitest";
import { assessQaGate, formatPreviewOutput, compactQa } from "@/orchestrator/runStage5Preview";

// Synthetic QA noise. The orphan lines only need the shape the parser sees: a
// `/` marking where the line broke, and enough of them to prove the compactor
// drops the body and keeps the verdicts. Never paste a real page's copy here —
// this file ships to clients, and the packaging scanner matches private names
// and ids, not a tenant's sentences.
const QA_NOISE = `FAIL 320px overflow=0 clipped=0 orphans=4 smalltext=5
orphan: שלוש שנים חיפשתי שיטה שתעבוד. ואז מצאתי / אחת.
orphan: שווה: 500 קרדיטים (שעת ייעוץ פרונטלי + חומרי / הכנה)
orphan: בונוס 3: גישה לקבוצה הסגורה / של הבוגרים.
FAIL 360px overflow=0 clipped=0 orphans=5 smalltext=5
orphan: המחיר שלך היום: [מחיר / מהפרופיל]
RESULT: FAIL (6 widths)`;

describe("preview output", () => {
  const url = "http://localhost:4322/council-test";

  it("opens with the link so it is never buried under the QA dump", () => {
    const out = formatPreviewOutput(url, "campaign-council-x", compactQa(QA_NOISE), false);
    expect(out.split("\n").slice(0, 4).join("\n")).toContain(url);
  });

  it("repeats the link at the end, next to the approve buttons", () => {
    const out = formatPreviewOutput(url, "campaign-council-x", compactQa(QA_NOISE), false);
    expect(out.trimEnd().split("\n").slice(-4).join("\n")).toContain(url);
  });

  it("keeps only the per-width verdicts, not every orphan line", () => {
    const compact = compactQa(QA_NOISE);
    expect(compact).toContain("FAIL 320px");
    expect(compact).toContain("RESULT: FAIL (6 widths)");
    expect(compact).not.toContain("שלוש שנים חיפשתי");
  });

  it("says the page was opened in the browser when it was", () => {
    const out = formatPreviewOutput(url, "b", compactQa(QA_NOISE), true);
    expect(out).toContain("נפתח לך בדפדפן");
  });

  it("accepts only a zero-exit PASS covering every requested viewport", () => {
    const raw = [320, 360, 390, 430, 768, 1280]
      .map((width) => `PASS ${width}px overflow=0`)
      .concat("RESULT: PASS")
      .join("\n");
    expect(assessQaGate(0, raw)).toMatchObject({ passed: true });
    expect(assessQaGate(1, raw)).toMatchObject({ passed: false });
    expect(assessQaGate(0, raw.replace("PASS 430px", "FAIL 430px"))).toMatchObject({
      passed: false,
    });
    expect(assessQaGate(0, raw.replace(/^PASS 430px.*\n/m, ""))).toMatchObject({ passed: false });
    expect(assessQaGate(0, raw.replace("RESULT: PASS", ""))).toMatchObject({ passed: false });
  });

  it("turns crashes and malformed PASS output into an explicit blocking verdict", () => {
    const assessed = assessQaGate(-1, "QA gate timed out\nRESULT: PASS");
    expect(assessed.passed).toBe(false);
    expect(assessed.summary).toContain("RESULT: FAIL");
    expect(formatPreviewOutput(url, "b", assessed.summary, false, assessed.passed))
      .toContain("חסם מסירה");
  });
});
