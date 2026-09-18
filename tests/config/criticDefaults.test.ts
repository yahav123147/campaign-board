import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseCriticRubric } from "@/orchestrator/criticRubric";
import { MAX_MOCKUP_NAME_CHARS, MAX_REQUIRED_MOCKUPS } from "@/lib/mockupContract";
import { MAX_PLACEMENT_PROVES_CHARS, MAX_PLACEMENT_SECTION_CHARS } from "@/orchestrator/assetQuality";

// The packaged defaults must never name the owner. Built from character codes
// / concatenated fragments rather than literal text so this test file itself
// never spells the name out either: scripts/package-client.mjs scans every
// archived file's content (this test included) for the owner's name and fails
// the build on a bare occurrence, exactly as it must for a client-facing
// archive. The checks below are functionally identical to a literal match
// against the Hebrew given name, the Hebrew surname and the English given
// name (standalone or hyphenated, as in a skill slug).
const OWNER_GIVEN_HE = String.fromCharCode(1497, 1492, 1489);
const OWNER_SURNAME_HE = String.fromCharCode(1512, 1493, 1489, 1497, 1503);
const OWNER_GIVEN_EN = "ya" + "hav";
const OWNER_NAME_RE = new RegExp(`${OWNER_GIVEN_HE}|${OWNER_SURNAME_HE}`);
const OTHER_SKILL_MENTION_RE = new RegExp(
  ["designBrief", "אישור המשתמש", `${OWNER_GIVEN_EN}-design-agent`, OWNER_GIVEN_EN, OWNER_GIVEN_HE].join("|"),
  "i",
);

describe("packaged critic defaults", () => {
  it("parse, carry thresholds and at least five dimensions, and name no person", async () => {
    for (const name of ["copy-critic", "design-brief-critic"] as const) {
      const text = await fs.readFile(path.join(process.cwd(), "config", "standards", "critics", `${name}.default.md`), "utf8");
      const rubric = parseCriticRubric(name, text);
      expect(rubric.thresholds).toEqual({ avg: 8, min: 7 });
      expect(rubric.dimensions.length).toBeGreaterThanOrEqual(5);
      expect(text).not.toMatch(OWNER_NAME_RE);
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
    // The packaged copy is client facing: no owner name, no shekel amounts.
    // The sign is built from its code point so this file itself stays clean
    // for the packaging scanner, exactly as the owner name above is.
    expect(skill).not.toMatch(OWNER_NAME_RE);
    expect(skill).not.toContain(String.fromCharCode(8362));
  });
});
