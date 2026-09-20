import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { copyStandardBase, readCopyStandard, renderCopyStandard } from "@/orchestrator/copyStandard";
import { validateClientProfile } from "@/config/clientProfile";
import type { ClientProfile } from "@/config/clientProfile";

let workDir: string;

function profileWithStandard(standardPath?: string): ClientProfile {
  return validateClientProfile({
    schemaVersion: 1,
    tenant: { id: "acme", displayName: "Acme", locale: "he-IL", timezone: "Asia/Jerusalem" },
    brand: { publicName: "Acme", facts: ["עובדה מאומתת"] },
    policies: {
      contentRules: [],
      advertisingRules: [],
      operationalRules: [],
      capabilities: {
        landingPageBuild: false,
        metaPixelRead: false,
        metaCampaignCreatePaused: false,
      },
    },
    ...(standardPath ? { copy: { standardPath } } : {}),
  });
}

beforeEach(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), "council-copy-standard-"));
});

afterEach(async () => {
  await fs.rm(workDir, { recursive: true, force: true });
});

describe("the stage 4 copy standard", () => {
  it("reads the configured standard at run time", async () => {
    const standardPath = path.join(workDir, "copy-standard.md");
    await fs.writeFile(standardPath, "## כלל ברזל\n\nכותרת בגוף שלישי נפסלת.\n");

    await expect(readCopyStandard(profileWithStandard(standardPath)))
      .resolves.toContain("כותרת בגוף שלישי נפסלת");
  });

  it("adds nothing to a prompt when no standard is configured", async () => {
    await expect(readCopyStandard(profileWithStandard())).resolves.toBe("");
    expect(renderCopyStandard("", "כותרת")).toBe("");
  });

  it("refuses a symlinked standard", async () => {
    const real = path.join(workDir, "real.md");
    const link = path.join(workDir, "link.md");
    await fs.writeFile(real, "כלל");
    await fs.symlink(real, link);

    await expect(readCopyStandard(profileWithStandard(link))).rejects.toThrow(/regular file/);
  });

  it("refuses a missing standard rather than running without one", async () => {
    await expect(readCopyStandard(profileWithStandard(path.join(workDir, "nope.md"))))
      .rejects.toThrow(/missing|regular file/);
  });

  it("refuses an empty standard", async () => {
    const standardPath = path.join(workDir, "empty.md");
    await fs.writeFile(standardPath, "   \n");

    await expect(readCopyStandard(profileWithStandard(standardPath))).rejects.toThrow(/empty/);
  });

  it("refuses a standard larger than its limit", async () => {
    const standardPath = path.join(workDir, "huge.md");
    await fs.writeFile(standardPath, "x".repeat(256 * 1024 + 1));

    await expect(readCopyStandard(profileWithStandard(standardPath))).rejects.toThrow(/size limit/);
  });

  it("rejects a relative standard path in the profile", () => {
    expect(() => profileWithStandard("./copy-standard.md")).toThrow(/absolute path/);
  });
});

describe("copyStandardBase, what the strategy synthesis receives", () => {
  it("keeps the board's rules and drops the embedded skill, on the shipped default", async () => {
    // A client's synthesizer was handed the whole embedded copy skill, with its
    // "output structured JSON for the design agent" instructions, and rightly
    // refused to write a strategy document against it. The cut marker did not
    // match the heading the default file actually uses.
    const shipped = await fs.readFile(
      path.join(process.cwd(), "config", "standards", "copy-standard.default.md"),
      "utf8",
    );
    const base = copyStandardBase(shipped);

    expect(base).toContain("ההבטחה הגדולה: הנוסחה");
    expect(base).not.toContain("Elite Sales Page Architect");
    expect(base).not.toContain("Output structured JSON");
    expect(base).not.toContain("המתודולוגיה (מוטמעת במלואה)");
  });

  it("still honours the older skill marker", () => {
    expect(copyStandardBase("# תקן\nכלל\n\n# הסקיל: x\nskill body")).toBe("# תקן\nכלל");
  });
});
