import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseCriticRubric } from "@/orchestrator/criticRubric";
import { MAX_MOCKUP_NAME_CHARS, MAX_REQUIRED_MOCKUPS } from "@/lib/mockupContract";
import { MAX_PLACEMENT_PROVES_CHARS, MAX_PLACEMENT_SECTION_CHARS } from "@/orchestrator/assetQuality";
import { clientContentViolation } from "@/scripts/package-client.mjs";

// Keep private identity values out of the tests too, including reversible
// character-code or fragment encodings. The shared scanner owns that policy.
const OTHER_SKILL_MENTION_RE = /designBrief|אישור המשתמש/i;

describe("packaged critic defaults", () => {
  it("parse, carry thresholds and at least five dimensions, and name no person", async () => {
    for (const name of ["copy-critic", "design-brief-critic"] as const) {
      const text = await fs.readFile(path.join(process.cwd(), "config", "standards", "critics", `${name}.default.md`), "utf8");
      const rubric = parseCriticRubric(name, text);
      expect(rubric.thresholds).toEqual({ avg: 8, min: 7 });
      expect(rubric.dimensions.length).toBeGreaterThanOrEqual(5);
      expect(clientContentViolation(text)).toBeUndefined();
    }
    // Task 14: dimension 5 is where a missing requiredMockups list is caught,
    // before 5.2 has to stop the run over it.
    const designBrief = await fs.readFile(path.join(process.cwd(), "config", "standards", "critics", "design-brief-critic.default.md"), "utf8");
    expect(designBrief).toContain("requiredMockups");
    expect(designBrief).toContain("devices");
    expect(designBrief).toContain("chapter");
    const strategy = await fs.readFile(path.join(process.cwd(), "config", "standards", "critics", "design-strategy-standard.default.md"), "utf8");
    expect(strategy).toMatch(/playbook/i);
    expect(strategy).toContain("imageMap");
    expect(strategy).toContain("harvestFile");
    expect(clientContentViolation(strategy)).toBeUndefined();
    expect(strategy).not.toMatch(OTHER_SKILL_MENTION_RE);
    expect(strategy).not.toMatch(/גבר|נשי|נשים|גברי/);
  });

  // Task 17: the critic holds the same rules 5.2 enforces, so a brief that
  // would stop the run is caught while it is still being scored.
  it("dimension 5 of the design-brief critic carries every requiredMockups rule", async () => {
    const designBrief = await fs.readFile(path.join(process.cwd(), "config", "standards", "critics", "design-brief-critic.default.md"), "utf8");
    expect(designBrief).toContain("מוקאפ לכל מודול");
    expect(designBrief).toContain("רשימה חסרה, ריקה או שבורה");
    // One entry per row: two rows may not lean on one mockup.
    expect(designBrief).toContain("רשומה נפרדת");
    // Fix round 1, Minor 3: the caps the validator applies, asserted from the
    // constants so the packaged markdown cannot drift away from the code.
    expect(designBrief).toContain(`עד ${MAX_REQUIRED_MOCKUPS} מוקאפים`);
    expect(designBrief).toContain(`עד ${MAX_MOCKUP_NAME_CHARS} תווים`);
    expect(designBrief).toContain(`${MAX_PLACEMENT_SECTION_CHARS} תווים`);
    expect(designBrief).toContain(`${MAX_PLACEMENT_PROVES_CHARS} תווים`);
  });

  it("the packaged landing skill no longer tells the builder to run the marker tool itself", async () => {
    const skill = await fs.readFile(path.join(process.cwd(), "vendor", "landing-skill", "SKILL.md"), "utf8");
    expect(skill).not.toContain("marker.py");
  });

  // Task 17: the builder places mockups, it never produces them. The skill
  // used to send it to the course-mockups skill and to Codex for exactly that.
  it("the packaged landing skill says the mockups arrive rendered from 5.2", async () => {
    const skill = await fs.readFile(path.join(process.cwd(), "vendor", "landing-skill", "SKILL.md"), "utf8");
    expect(skill).toContain("5.2");
    expect(skill).not.toMatch(/use the `course-mockups` skill/);
    expect(skill).not.toMatch(/codex exec -i/);
    // The presenter stays a requirement, now on the screens 5.2 writes.
    expect(skill).toMatch(/presenter/i);
    expect(clientContentViolation(skill)).toBeUndefined();
  });
});
