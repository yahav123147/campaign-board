import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { authorizeReferenceProject, parseReference } from "@/orchestrator/designStandard";
import { describeReference } from "@/orchestrator/runStage5LpBuild";
import { validateClientProfile } from "@/config/clientProfile";

describe("parseReference", () => {
  it("reads the reference block the brand brief ends with", () => {
    const brief = `# בריף מותג\n\nבלה בלה\n\nREFERENCE_URL: https://reference.example.test/\nREFERENCE_DIR: /srv/client/reference-page\n`;
    expect(parseReference(brief)).toEqual({
      url: "https://reference.example.test/",
      dir: "/srv/client/reference-page",
    });
  });

  it("treats 'none' as no reference", () => {
    const brief = `REFERENCE_URL: none\nREFERENCE_DIR: none`;
    expect(parseReference(brief)).toEqual({});
  });

  it("returns nothing when the brief has no reference block at all", () => {
    expect(parseReference("בריף בלי רפרנס")).toEqual({});
  });

  it("takes one without the other", () => {
    expect(parseReference("REFERENCE_URL: https://x.com/\nREFERENCE_DIR: none")).toEqual({
      url: "https://x.com/",
    });
  });

  it("ignores a reference the agent wrote inside a sentence", () => {
    expect(parseReference("כדאי להסתכל על REFERENCE_URL: כלשהו אם הלקוח ייתן")).toEqual({});
  });
});

describe("authorizeReferenceProject", () => {
  const profile = (root: string) => validateClientProfile({
    schemaVersion: 1,
    tenant: { id: "client", displayName: "Client", locale: "en-US", timezone: "UTC" },
    brand: { publicName: "Brand", facts: ["Verified fact"] },
    policies: {
      contentRules: [],
      advertisingRules: [],
      operationalRules: [],
      capabilities: { landingPageBuild: true, metaPixelRead: false, metaCampaignCreatePaused: false },
    },
    landing: {
      workspacePath: "/tmp/landing",
      referenceUrlPrefixes: ["https://example.test/approved/"],
      referenceRoots: [root],
    },
  });

  it("accepts only configured URL prefixes and contained real directories", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "reference-root-"));
    const child = path.join(root, "campaign");
    await fs.mkdir(child);

    await expect(authorizeReferenceProject({
      url: "https://example.test/approved/page",
      dir: child,
    }, profile(root))).resolves.toEqual({
      url: "https://example.test/approved/page",
      dir: await fs.realpath(child),
    });
    await expect(authorizeReferenceProject({
      url: "https://example.test/not-approved",
    }, profile(root))).rejects.toThrow(/not allowlisted/);
  });

  it("rejects symlinks and directories outside configured roots", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "reference-root-"));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "reference-outside-"));
    const link = path.join(root, "link");
    await fs.symlink(outside, link);

    await expect(authorizeReferenceProject({ dir: link }, profile(root))).rejects.toThrow(/symbolic link/);
    await expect(authorizeReferenceProject({ dir: outside }, profile(root))).rejects.toThrow(/not contained/);
  });
});

describe("describeReference", () => {
  it("does not follow a symlinked brief or list symlinked assets", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "reference-description-"));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "reference-secret-"));
    const secret = path.join(outside, "secret.txt");
    await fs.writeFile(secret, "DO_NOT_EXPOSE");
    await fs.symlink(secret, path.join(root, "design-brief.json"));
    await fs.mkdir(path.join(root, "assets"));
    await fs.symlink(secret, path.join(root, "assets", "secret.png"));

    const description = await describeReference({ dir: root });
    expect(description).toContain("ignored");
    expect(description).not.toContain("DO_NOT_EXPOSE");
    expect(description).not.toContain("secret.png");
  });

  it("bounds oversized reference briefs", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "reference-description-"));
    await fs.writeFile(path.join(root, "design-brief.json"), "x".repeat(65 * 1024));
    const description = await describeReference({ dir: root });
    expect(description).toContain("ignored");
    expect(description).not.toContain("x".repeat(1_000));
  });
});
