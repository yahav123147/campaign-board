import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CLIENT_PRIVATE_CONTENT_PATTERNS,
  clientContentViolation,
} from "@/scripts/package-client.mjs";

const ROOT = process.cwd();
const THIS_FILE = "tests/orchestrator/tenantNeutralRuntime.test.ts";

function sourceFilesUnder(relativeDirectory: string): string[] {
  const root = path.join(ROOT, relativeDirectory);
  const result: string[] = [];

  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const relative = path.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) {
      result.push(...sourceFilesUnder(relative));
    } else if (/\.(?:ts|tsx|md|json)$/.test(entry.name)) {
      result.push(relative);
    }
  }

  return result;
}

const RUNTIME_PROMPT_AND_UI_FILES = [
  ...sourceFilesUnder("agents").filter((file) => file.endsWith("prompt.md")),
  "orchestrator/clientContext.ts",
  "orchestrator/promptBuilder.ts",
  "orchestrator/stageRegistry.ts",
  ...sourceFilesUnder("components"),
  "app/layout.tsx",
  "app/page.tsx",
  "app/archive/page.tsx",
  "app/runs/[id]/page.tsx",
];

// שולחים ללקוחות בתוך הארכיון (ראו scripts/package-client.mjs), ולכן צריכים
// לעבור את אותה בדיקת ניטרליות כמו הפרומפטים והממשק.
const PAGE_TYPE_TEMPLATE_FILES = sourceFilesUnder("config/standards/page-types");

const FORBIDDEN_TENANT_MATERIAL = CLIENT_PRIVATE_CONTENT_PATTERNS
  .map((pattern) => pattern.expression);

// רשימה מפורשת, בנוסף לבודק המשותף. הדפוס לשם המותג באנגלית דורש רווח או מקף
// בין שתי המילים ולכן לא תופס דומיין שבו הן צמודות. שמות של אנשים ומזהי חשבון
// לא מופיעים כאן בכלל, גם לא בחלקים: הבודק המשותף מזהה אותם לפי hash, כי הקובץ
// הזה נשלח ללקוחות. בדיקת ה-em-dash קיימת גם היא, בהמשך.
const EXPLICIT_TENANT_STRINGS = [
  ["נקסט", "לבל"].join(" "),
  ["the", "next", "level"].join(""),
  ["next", "level"].join(""),
];

describe("tenant-neutral runtime prompts and UI", () => {
  it.each([...RUNTIME_PROMPT_AND_UI_FILES, ...PAGE_TYPE_TEMPLATE_FILES])(
    "contains no legacy tenant material: %s",
    (file) => {
      const source = fs.readFileSync(path.join(ROOT, file), "utf8");

      expect(clientContentViolation(source), `${file} contains private material`).toBeUndefined();
      for (const forbidden of FORBIDDEN_TENANT_MATERIAL) {
        expect(source, `${file} contains ${forbidden}`).not.toMatch(forbidden);
      }
    },
  );

  it.each(PAGE_TYPE_TEMPLATE_FILES)(
    "אינו מכיל מחרוזת שוכר מפורשת (רשימה מפורשת): %s",
    (file) => {
      const source = fs.readFileSync(path.join(ROOT, file), "utf8").toLowerCase();

      for (const forbidden of EXPLICIT_TENANT_STRINGS) {
        expect(source, `${file} contains explicit tenant string #${EXPLICIT_TENANT_STRINGS.indexOf(forbidden)}`)
          .not.toContain(forbidden.toLowerCase());
      }
    },
  );

  it.each(PAGE_TYPE_TEMPLATE_FILES)("שולח ללקוחות תבנית נקייה בלי em-dashes: %s", (file) => {
    const source = fs.readFileSync(path.join(ROOT, file), "utf8");

    expect(source, `${file} contains an em-dash`).not.toContain("—");
  });

  it("states the actual local context boundary in the brief form", () => {
    const source = fs.readFileSync(path.join(ROOT, "components/BriefInput.tsx"), "utf8");

    // The sentence now names the agents rather than one working mode, because
    // the form offers two. The boundary it states is the same one.
    expect(source).toContain("רואים רק את הבריף");
    expect(source).toContain("אין גישה אוטומטית");
  });

  // The tests and scanner also ship. Keep them under the same content check.
  it("is itself clean enough to ship in the client archive", () => {
    for (const file of [THIS_FILE, "tests/config/criticDefaults.test.ts", "tests/scripts/package-client.test.ts", "scripts/package-client.mjs"]) {
      const source = fs.readFileSync(path.join(ROOT, file), "utf8");
      expect(clientContentViolation(source), file).toBeUndefined();
    }
  });
});
