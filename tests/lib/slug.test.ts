import { describe, it, expect } from "vitest";
import { generateRunId, briefToSlug } from "@/lib/slug";

describe("generateRunId", () => {
  it("returns a sortable timestamp plus URL-safe entropy", () => {
    const id = generateRunId(new Date("2026-05-10T14:30:45.123Z"), "abcdef123456");
    expect(id).toMatch(/^2026-05-10-\d{6}-123-abcdef123456$/);
  });

  it("is timezone-aware (uses local time)", () => {
    const id = generateRunId();
    expect(id).toMatch(/^\d{4}-\d{2}-\d{2}-\d{6}-\d{3}-[a-f0-9]{16}$/);
  });

  it("cannot collide when two runs start in the same minute", () => {
    const when = new Date("2026-05-10T14:30:45.123Z");
    expect(generateRunId(when)).not.toBe(generateRunId(when));
  });
});

describe("briefToSlug", () => {
  it("converts Hebrew brief to ascii slug", () => {
    const slug = briefToSlug("השקה של מחזור חדש לסדנת Claude Code");
    expect(slug).toMatch(/^[a-z0-9-]+$/);
    expect(slug).toContain("claude-code");
  });

  it("truncates long briefs", () => {
    const long = "a".repeat(200);
    const slug = briefToSlug(long);
    expect(slug.length).toBeLessThanOrEqual(50);
  });
});
