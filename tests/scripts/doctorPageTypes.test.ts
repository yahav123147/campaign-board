import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NON_SALES_PAGE_ASSET_TYPES, pageTypesCheck } from "../../scripts/doctor.mjs";
import { ASSET_TYPES } from "@/types";

/**
 * The doctor must be exactly as strict as the runtime loader
 * (orchestrator/pageTypeBlueprint.ts): a template only counts when it is a
 * regular file, not a symlink and not a directory. And a relative profile
 * path must resolve against the same root the profile itself was loaded from.
 */
let workDir: string;

const minimalProfile = { copy: undefined };

async function installTemplates(dir: string, types: readonly string[] = NON_SALES_PAGE_ASSET_TYPES) {
  await fs.mkdir(dir, { recursive: true });
  for (const type of types) {
    await fs.writeFile(path.join(dir, `${type}.md`), `# ${type}`, "utf8");
  }
}

beforeEach(async () => {
  workDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "council-doctor-page-types-")));
});

afterEach(async () => {
  await fs.rm(workDir, { recursive: true, force: true, maxRetries: 5 });
});

describe("doctor page-type templates check", () => {
  // Spec 7.10: the doctor checks exactly the types that read a template.
  it("checks every asset type except the sales page, and nothing else", () => {
    expect([...NON_SALES_PAGE_ASSET_TYPES].sort()).toEqual(
      ASSET_TYPES.filter((type) => type !== "sales-page").sort(),
    );
  });

  it("passes when every template is a regular file", async () => {
    const dir = path.join(workDir, "page-types");
    await installTemplates(dir);
    const result = await pageTypesCheck({ copy: { pageTypesDir: dir } }, {}, workDir);
    expect(result.status).toBe("pass");
  });

  // Spec 7.10: a missing template is reported, not silently accepted.
  it("warns and names the type when a template is missing", async () => {
    const dir = path.join(workDir, "page-types");
    await installTemplates(dir, NON_SALES_PAGE_ASSET_TYPES.filter((type) => type !== "webinar-page"));
    const result = await pageTypesCheck({ copy: { pageTypesDir: dir } }, {}, workDir);
    expect(result.status).toBe("warn");
    expect(result.summary).toContain("webinar-page");
  });

  it("warns on a template that is a symlink, which the loader refuses", async () => {
    const dir = path.join(workDir, "page-types");
    await installTemplates(dir, NON_SALES_PAGE_ASSET_TYPES.filter((type) => type !== "squeeze-page"));
    await fs.writeFile(path.join(workDir, "real.md"), "# real", "utf8");
    await fs.symlink(path.join(workDir, "real.md"), path.join(dir, "squeeze-page.md"));
    const result = await pageTypesCheck({ copy: { pageTypesDir: dir } }, {}, workDir);
    expect(result.status).toBe("warn");
    expect(result.summary).toContain("squeeze-page");
  });

  it("warns on a template path that is a directory, which the loader refuses", async () => {
    const dir = path.join(workDir, "page-types");
    await installTemplates(dir, NON_SALES_PAGE_ASSET_TYPES.filter((type) => type !== "upsell-page"));
    await fs.mkdir(path.join(dir, "upsell-page.md"));
    const result = await pageTypesCheck({ copy: { pageTypesDir: dir } }, {}, workDir);
    expect(result.status).toBe("warn");
    expect(result.summary).toContain("upsell-page");
  });

  // F4: launched from a directory other than the repository root, a relative
  // profile path must still point at the folder next to the loaded profile.
  it("resolves a relative profile path against the doctor's root, not the launching directory", async () => {
    expect(process.cwd()).not.toBe(workDir);
    const dir = path.join(workDir, "profiles", "page-types");
    await installTemplates(dir);
    const env = { CAMPAIGN_COUNCIL_CLIENT_PROFILE: "profiles/client-profile.json" };

    const result = await pageTypesCheck(minimalProfile, env, workDir);

    expect(result.status).toBe("pass");
    expect(result.summary).toContain(dir);
  });
});
