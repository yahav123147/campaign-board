import { describe, expect, it } from "vitest";
import { parseCriticRubric, parseCriticVerdict, renderRubricForCritic } from "@/orchestrator/criticRubric";
import { auditBlocksExpress, CRITIC_BLOCKED_MARKER, CRITIC_UNRESOLVED_MARKER } from "@/orchestrator/copyStandard";

const RUBRIC = `---
avg: 8
min: 7
---
# מבקר קופי

## ממדים
1. מבנה לפי תבנית סוג הדף
2. ההבטחה הגדולה
3. טענה מול הוכחה

## חסימות
- שם של מנטור מתחרה
`;

describe("parseCriticRubric", () => {
  it("reads thresholds and dimensions", () => {
    const rubric = parseCriticRubric("copy-critic", RUBRIC);
    expect(rubric.thresholds).toEqual({ avg: 8, min: 7 });
    expect(rubric.dimensions).toEqual(["מבנה לפי תבנית סוג הדף", "ההבטחה הגדולה", "טענה מול הוכחה"]);
    expect(renderRubricForCritic(rubric)).toContain("מבנה לפי תבנית סוג הדף");
  });
  it("falls back to avg 8 / min 7 without frontmatter and refuses a rubric without dimensions", () => {
    expect(parseCriticRubric("copy-critic", "## ממדים\n1. א").thresholds).toEqual({ avg: 8, min: 7 });
    expect(() => parseCriticRubric("copy-critic", "# ריק")).toThrow(/ממדים/);
  });
  it("parses a CRLF rubric: authored thresholds, dimensions, and no leaked frontmatter in text", () => {
    const crlf = RUBRIC.replace(/\n/g, "\r\n");
    const rubric = parseCriticRubric("copy-critic", crlf);
    expect(rubric.thresholds).toEqual({ avg: 8, min: 7 });
    expect(rubric.dimensions).toEqual(["מבנה לפי תבנית סוג הדף", "ההבטחה הגדולה", "טענה מול הוכחה"]);
    expect(rubric.text).not.toContain("avg:");
  });
  it("trims trailing spaces off a dimension line", () => {
    const rubric = parseCriticRubric("copy-critic", "## ממדים\n1. מבנה   \n2. הבטחה");
    expect(rubric.dimensions).toEqual(["מבנה", "הבטחה"]);
  });
  it("refuses a rubric with a duplicate dimension name", () => {
    expect(() =>
      parseCriticRubric("copy-critic", "## ממדים\n1. מבנה\n2. הבטחה\n3. מבנה"),
    ).toThrow(/כפול/);
  });
});

describe("parseCriticVerdict", () => {
  const rubric = parseCriticRubric("copy-critic", RUBRIC);
  const block = (json: unknown) => `הערות.\n<critic>${JSON.stringify(json)}</critic>`;

  it("approves when every dimension is scored and both thresholds hold", () => {
    const v = parseCriticVerdict(block({ scores: { "מבנה לפי תבנית סוג הדף": 9, "ההבטחה הגדולה": 8, "טענה מול הוכחה": 8 }, verdict: "APPROVE", fixes: [] }), rubric);
    expect(v).toMatchObject({ kind: "approve", avg: 8.33, min: 8 });
  });
  it("turns a self-declared APPROVE into revise when a threshold fails, keeping the fixes", () => {
    const v = parseCriticVerdict(block({ scores: { "מבנה לפי תבנית סוג הדף": 9, "ההבטחה הגדולה": 6, "טענה מול הוכחה": 9 }, verdict: "APPROVE", fixes: [{ quote: "ציטוט", rule: "הבטחה", fix: "חדד" }] }), rubric);
    expect(v.kind).toBe("revise");
    expect(v.kind === "revise" && v.fixes[0]?.fix).toBe("חדד");
  });
  it("a declared REVISE stands even when the scores clear the thresholds", () => {
    const v = parseCriticVerdict(block({ scores: { "מבנה לפי תבנית סוג הדף": 9, "ההבטחה הגדולה": 9, "טענה מול הוכחה": 9 }, verdict: "REVISE", fixes: [{ quote: "א", rule: "ב", fix: "ג" }] }), rubric);
    expect(v.kind).toBe("revise");
  });
  it("a missing or unknown verdict is unreadable, whatever the scores", () => {
    expect(parseCriticVerdict(block({ scores: { "מבנה לפי תבנית סוג הדף": 10, "ההבטחה הגדולה": 10, "טענה מול הוכחה": 10 }, fixes: [] }), rubric).kind).toBe("unreadable");
    expect(parseCriticVerdict(block({ scores: { "מבנה לפי תבנית סוג הדף": 10, "ההבטחה הגדולה": 10, "טענה מול הוכחה": 10 }, verdict: "BOGUS", fixes: [] }), rubric).kind).toBe("unreadable");
  });
  it("keeps BLOCK regardless of scores", () => {
    const v = parseCriticVerdict(block({ scores: { "מבנה לפי תבנית סוג הדף": 10, "ההבטחה הגדולה": 10, "טענה מול הוכחה": 10 }, verdict: "BLOCK", reason: "מנטור מתחרה", fixes: [] }), rubric);
    expect(v).toMatchObject({ kind: "block", reason: "מנטור מתחרה" });
  });
  it("is unreadable without a block, with broken JSON, with a missing dimension, or inside a tool call", () => {
    expect(parseCriticVerdict("בלי בלוק", rubric).kind).toBe("unreadable");
    expect(parseCriticVerdict("<critic>{oops</critic>", rubric).kind).toBe("unreadable");
    expect(parseCriticVerdict(block({ scores: { "ההבטחה הגדולה": 8 }, verdict: "APPROVE", fixes: [] }), rubric).kind).toBe("unreadable");
    expect(parseCriticVerdict(`<invoke name="Bash">\n${block({ scores: {}, verdict: "APPROVE" })}\n</invoke>`, rubric).kind).toBe("unreadable");
  });
});

describe("express markers", () => {
  it("blocks express on a critic block and on an unresolved loop", () => {
    expect(auditBlocksExpress(`${CRITIC_BLOCKED_MARKER}: מנטור מתחרה\n\nטקסט`)).toBe(true);
    expect(auditBlocksExpress(`${CRITIC_UNRESOLVED_MARKER} 3 סבבים\n\nטקסט`)).toBe(true);
    expect(auditBlocksExpress("טקסט")).toBe(false);
  });
});
