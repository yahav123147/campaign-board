import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  archiveEntryViolation,
  packageClient,
  validateArchiveEntries,
  validateClientArchiveContents,
  validateGitTree,
} from "@/scripts/package-client.mjs";

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

async function write(root: string, relative: string, contents: string) {
  const target = path.join(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, contents);
}

async function createRepository() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "campaign-client-package-"));
  temporaryRoots.push(root);
  await write(root, "package.json", JSON.stringify({
    name: "campaign-council",
    version: "1.2.3",
    private: true,
    scripts: {
      build: "echo build",
      dev: "echo dev",
      doctor: "echo doctor",
      start: "echo start",
      test: "echo test",
    },
  }));
  await write(root, "package-lock.json", JSON.stringify({
    name: "campaign-council",
    version: "1.2.3",
    lockfileVersion: 3,
    packages: { "": { name: "campaign-council", version: "1.2.3" } },
  }));
  await write(root, ".env.example", [
    "CAMPAIGN_COUNCIL_CLIENT_PROFILE=",
    "CAMPAIGN_COUNCIL_USE_DEVELOPMENT_PROFILE=0",
    "CAMPAIGN_COUNCIL_DATA_DIR=",
    "LANDING_PAGES_DIR=",
    "PORT=3000",
    "PREVIEW_PORT=4322",
    "META_GRAPH_API_VERSION=v26.0",
    "",
  ].join("\n"));
  await write(root, "config/client-profile.example.json", JSON.stringify({
    policies: {
      capabilities: {
        landingPageBuild: false,
        metaPixelRead: false,
        metaCampaignCreatePaused: false,
      },
    },
    meta: {
      accountId: null,
      pixelId: null,
      customConversionId: null,
      pageId: null,
      instagramActorId: null,
      domain: null,
      tokenKeychainService: null,
    },
  }));
  await write(root, ".gitignore", "/dist\n");
  await write(root, "README.md", "# Client package\n");
  await write(root, "app/api/runs/route.ts", "export const safe = true;\n");
  // הריפו האמיתי מכיל vitest.config.mts; הפיקסטורה חייבת לשקף סיומות שהסורק
  // חייב להכיר, אחרת שבירת אריזה אמיתית עוברת מתחת לרדאר (F101).
  await write(root, "vitest.config.mts", "export default {};\n");
  for (const required of [
    "config/clientProfile.ts",
    "config/standards/copy-standard.default.md",
    "config/standards/ads-standard.default.md",
    "config/standards/creative-standard.default.md",
    "config/standards/critics/copy-critic.default.md",
    "config/standards/critics/design-brief-critic.default.md",
    "config/standards/critics/design-strategy-standard.default.md",
    "config/standards/page-types/premium-lead-page.default.md",
    "config/standards/page-types/webinar-page.default.md",
    "config/standards/page-types/squeeze-page.default.md",
    "config/standards/page-types/upsell-page.default.md",
    "setup.sh",
    "scripts/configure-client.mjs",
    "scripts/linux-process-sandbox.py",
    "templates/landing/.gitignore",
    "templates/landing/next.config.ts",
    "templates/landing/package-lock.json",
    "templates/landing/package.json",
    "templates/landing/postcss.config.mjs",
    "templates/landing/public/robots.txt",
    "templates/landing/src/app/globals.css",
    "templates/landing/src/app/layout.tsx",
    "templates/landing/src/app/page.tsx",
    "templates/landing/tsconfig.json",
    "scripts/compose-ad.py",
    "scripts/openai-image.mjs",
    "scripts/sanitize-photo.py",
    "assets/fonts/Heebo.ttf",
    "vendor/landing-skill/SKILL.md",
    "vendor/landing-skill/INSTALL.md",
    "vendor/landing-skill/scripts/landing-qa.mjs",
    "vendor/landing-skill/scripts/orphanLines.mjs",
    "vendor/landing-skill/scripts/visibleBox.mjs",
    "vendor/landing-skill/scripts/harvest_brand.py",
    "vendor/landing-skill/scripts/ig_shot.mjs",
    "vendor/landing-skill/scripts/igOverlay.mjs",
    "vendor/course-mockups/render_screens.mjs",
    "vendor/course-mockups/renderPolicy.mjs",
    "vendor/course-mockups/detect_screens.py",
    "vendor/course-mockups/composite.py",
    "config/standards/mockups/base-devices.default.png",
    "config/standards/mockups/base-chapter.default.png",
    "app/page.tsx",
    "orchestrator/stageRegistry.ts",
    "scripts/doctor.mjs",
    "scripts/cutout.py",
    "scripts/check-visible-images.mjs",
    "scripts/measure-text-deserts.mjs",
    "scripts/shoot.mjs",
    "scripts/slice-shot.py",
    "requirements-image-core.txt",
    "next.config.ts",
    "tsconfig.json",
  ]) {
    await write(root, required, "fixture\n");
  }
  await execFileAsync("git", ["init", "-q"], { cwd: root });
  await execFileAsync("git", ["add", "."], { cwd: root });
  await execFileAsync("git", [
    "-c", "user.name=Package Test",
    "-c", "user.email=package-test@localhost",
    "commit", "-qm", "fixture",
  ], { cwd: root });
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, {
    recursive: true,
    force: true,
  })));
});

describe("client archive path policy", () => {
  it("allows source routes named runs but blocks root run data", () => {
    expect(archiveEntryViolation("campaign-council/app/api/runs/route.ts")).toBeUndefined();
    expect(archiveEntryViolation("campaign-council/runs/private/state.json")).toMatch(/run data/);
  });

  it("allows only the inert root dotenv example", () => {
    expect(archiveEntryViolation("campaign-council/.env.example")).toBeUndefined();
    for (const entry of [
      "campaign-council/.env",
      "campaign-council/.env.local",
      "campaign-council/.env.production",
      "campaign-council/config/.env.example",
    ]) {
      expect(archiveEntryViolation(entry)).toMatch(/dotenv/);
    }
  });

  it("rejects private profiles, key material, duplicate paths, and missing setup files", () => {
    expect(archiveEntryViolation("campaign-council/config/client-profile.acme.json"))
      .toMatch(/client profile/);
    expect(archiveEntryViolation("campaign-council/certs/signing.pem")).toMatch(/credential/);
    expect(() => validateArchiveEntries([
      "campaign-council/",
      "campaign-council/README.md",
      "campaign-council/README.md",
    ])).toThrow(/duplicate archive entry/);
  });

  it("rejects symlinks and submodules in the committed tree", () => {
    expect(() => validateGitTree("120000 blob 0123456789abcdef\tlinked-file\0"))
      .toThrow(/symlinks or submodules/);
    expect(() => validateGitTree("160000 commit 0123456789abcdef\tvendor\0"))
      .toThrow(/symlinks or submodules/);
  });

  it("rejects tenant-specific content without embedding it in this fixture", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "campaign-client-content-"));
    temporaryRoots.push(root);
    await write(root, "source.ts", `export const workspace = "${["/", "Users", "/", "someone"].join("")}";\n`);

    await expect(validateClientArchiveContents(root)).rejects.toThrow(/developer home path/);
    const privateName = ["next", "-level", "-notes.md"].join("");
    expect(archiveEntryViolation(`campaign-council/${privateName}`)).toMatch(/entry name/);
  });
});

import { createHash } from "node:crypto";
import { clientContentViolation, privateTermViolation } from "@/scripts/package-client.mjs";

describe("private term hashes", () => {
  // Synthetic terms only: this file ships to clients, so the real private
  // names are never spelled here. The scanner matches them by hash.
  const sha = (text: string) => createHash("sha256").update(text.normalize("NFC").toLowerCase()).digest("hex");
  const hashes = new Map([
    [sha("zorbix"), "synthetic name"],
    [sha("קלמן"), "synthetic hebrew name"],
    [sha("blue harbor"), "synthetic pair"],
    [sha("424242"), "synthetic id"],
  ]);

  it("matches a whole word regardless of case, never inside a longer word", () => {
    expect(privateTermViolation("Meet ZORBIX today", hashes)).toBe("synthetic name");
    expect(privateTermViolation("zorbixes and prezorbix", hashes)).toBeUndefined();
  });

  it("matches a Hebrew word behind a one-letter prefix", () => {
    expect(privateTermViolation("שיחה עם לקלמן", hashes)).toBe("synthetic hebrew name");
    expect(privateTermViolation("מקלמנים", hashes)).toBeUndefined();
  });

  it("matches a two-word term across punctuation", () => {
    expect(privateTermViolation("see blue-harbor.webp", hashes)).toBe("synthetic pair");
  });

  it("separates digits from letters so an identifier inside a handle still matches", () => {
    expect(privateTermViolation("act_424242", hashes)).toBe("synthetic id");
    expect(privateTermViolation("act_4242420", hashes)).toBeUndefined();
  });

  it("runs as part of the archive content check", () => {
    expect(clientContentViolation("nothing private here")).toBeUndefined();
  });
});

it("refuses to package file types the privacy scanner does not inspect (F101)", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "campaign-client-ext-"));
  temporaryRoots.push(root);
  await write(root, "data/leads.csv", "name\nJane Doe\n");
  await expect(validateClientArchiveContents(root)).rejects.toThrow(/does not inspect/);
});

describe("packageClient", () => {
  it("builds a traceable archive and checksum from a clean repository", async () => {
    const root = await createRepository();
    const result = await packageClient({ root });
    expect(path.basename(result.archive)).toMatch(/^campaign-council-client-1\.2\.3-[0-9a-f]{12}\.tar\.gz$/);
    expect(path.basename(result.checksum)).toMatch(/^campaign-council-client-1\.2\.3-[0-9a-f]{12}\.sha256$/);

    const { stdout: listing } = await execFileAsync("tar", ["-tzf", result.archive]);
    expect(listing).toContain("campaign-council/app/api/runs/route.ts");
    const checksum = await fs.readFile(result.checksum, "utf8");
    expect(checksum).toMatch(new RegExp(`^[0-9a-f]{64}  ${path.basename(result.archive)}\\n$`));

    const repeated = await packageClient({ root });
    expect(await fs.readFile(repeated.checksum, "utf8")).toBe(checksum);
  });

  it("refuses a committed dotenv file that is not export-ignored", async () => {
    const root = await createRepository();
    await write(root, ".env.production", "ACCESS_TOKEN=synthetic-test-value\n");
    await execFileAsync("git", ["add", "-f", ".env.production"], { cwd: root });
    await execFileAsync("git", [
      "-c", "user.name=Package Test",
      "-c", "user.email=package-test@localhost",
      "commit", "-qm", "unsafe env fixture",
    ], { cwd: root });

    await expect(packageClient({ root })).rejects.toThrow(/dotenv files/);
    await expect(fs.readdir(path.join(root, "dist"))).resolves.toEqual([]);
  });

  it("refuses uncommitted changes and a symbolic-link output directory", async () => {
    const dirtyRoot = await createRepository();
    await write(dirtyRoot, "README.md", "# Uncommitted change\n");
    await expect(packageClient({ root: dirtyRoot })).rejects.toThrow(/clean Git worktree/);

    const linkedRoot = await createRepository();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "campaign-client-output-"));
    temporaryRoots.push(outside);
    await fs.symlink(outside, path.join(linkedRoot, "dist"));
    await expect(packageClient({ root: linkedRoot })).rejects.toThrow(/real directory/);
  });
});
