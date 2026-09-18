import { describe, it, expect } from "vitest";
import { extractStandard, parseVerdict } from "@/orchestrator/designStandard";

const SKILL = `# client-design-agent

## 🚨 HARD RULES (read first)
אין מילה יתומה בשורה.
אין em-dashes.

## Purpose
בלה בלה, לא רלוונטי לביקורת.

## Design System
טוקנים, לא רלוונטי.

## Checklist Before Delivery
- QA עבר בכל הרוחבים

## Reference Screenshots
לא רלוונטי.

## Validated patterns

### תמונות ברקע שקוף
כלל שנולד מדף לקוח לדוגמה.
`;

describe("extractStandard", () => {
  it("keeps the rule sections a critic must hold", () => {
    const out = extractStandard(SKILL);
    expect(out).toContain("אין מילה יתומה");
    expect(out).toContain("QA עבר בכל הרוחבים");
    expect(out).toContain("תמונות ברקע שקוף");
  });

  it("drops the sections that teach building, not judging", () => {
    const out = extractStandard(SKILL);
    expect(out).not.toContain("טוקנים, לא רלוונטי");
    expect(out).not.toContain("בלה בלה");
  });

  it("returns empty when the skill file is unreadable", () => {
    expect(extractStandard("")).toBe("");
  });
});

describe("parseVerdict", () => {
  it("reads a passing verdict", () => {
    expect(parseVerdict("פסק דין: עובר\n\nשיפורים:\n1. ...")).toBe(true);
  });

  it("reads a failing verdict", () => {
    expect(parseVerdict("פסק דין: לא עובר\n\nחוסמים:\n1. ...")).toBe(false);
  });

  it("fails closed when the verdict line is missing or unreadable", () => {
    expect(parseVerdict("הדף נראה לי סביר")).toBe(false);
    expect(parseVerdict("")).toBe(false);
  });

  it("is not fooled by the word עובר appearing later in the notes", () => {
    expect(parseVerdict("פסק דין: לא עובר\n\nחוסמים:\n1. הכפתור עובר את הקצה")).toBe(false);
  });
});

describe("readVerdict", () => {
  it("מבדיל בין עובר, לא עובר ולא קריא", async () => {
    const { readVerdict } = await import("@/orchestrator/designStandard");
    expect(readVerdict("פסק דין: עובר\n\nשיפורים:\n1. ...")).toBe("pass");
    expect(readVerdict("פסק דין: לא עובר\n\nחוסמים:\n1. ...")).toBe("fail");
    expect(readVerdict("הדף נראה לי סביר")).toBe("unreadable");
    expect(readVerdict("")).toBe("unreadable");
  });

  it("מוצא את פסק הדין גם אחרי שורת הקדמה", async () => {
    const { readVerdict } = await import("@/orchestrator/designStandard");
    expect(readVerdict("בדקתי את הסקציה.\nפסק דין: לא עובר\n1. ציטוט")).toBe("fail");
  });

  it("מתעלם מבלוקי קריאות כלים שהמבקר פלט במקום לענות", async () => {
    const { readVerdict } = await import("@/orchestrator/designStandard");
    const leaked = [
      "<invoke name=\"Bash\">",
      "<parameter name=\"command\">cat <<'EOF'",
      "פסק דין: עובר",
      "EOF</parameter>",
      "</invoke>",
      "",
      "echo 1",
    ].join("\n");
    expect(readVerdict(leaked)).toBe("unreadable");
    expect(readVerdict(`${leaked}\n\nפסק דין: לא עובר\n1. הפרה`)).toBe("fail");
  });

  it("stripToolMarkup מסיר בלוקים ושורות של קריאות כלים ומשאיר את הטקסט", async () => {
    const { stripToolMarkup } = await import("@/orchestrator/designStandard");
    const text = "לפני\n<invoke name=\"Bash\">\n<parameter name=\"command\">echo hi</parameter>\n</invoke>\nאחרי\n</parameter>\n";
    expect(stripToolMarkup(text).split("\n").filter((l) => l.trim()).join("\n")).toBe("לפני\nאחרי");
  });

  it("פסק דין בתוך heredoc, בלוק כלי קטוע או קוד מגודר אינו פסק דין", async () => {
    const { readVerdict } = await import("@/orchestrator/designStandard");
    expect(readVerdict("cat <<'EOF'\nפסק דין: עובר\nEOF\necho done")).toBe("unreadable");
    expect(readVerdict("cat <<EOF > out.md\nפסק דין: עובר")).toBe("unreadable");
    expect(readVerdict("<invoke name=\"Bash\">\n<parameter name=\"command\">echo x\nפסק דין: עובר")).toBe("unreadable");
    expect(readVerdict("```\nפסק דין: עובר\n```")).toBe("unreadable");
    expect(readVerdict("```\nפסק דין: עובר")).toBe("unreadable");
    expect(readVerdict("cat <<'EOF'\nפסק דין: עובר\nEOF\n\nפסק דין: לא עובר\n1. הפרה")).toBe("fail");
  });
});
