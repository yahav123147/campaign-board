import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  commitLandingDelivery,
  prepareLandingWorktree,
} from "@/orchestrator/landingWorktree";

// Every test here drives real git: worktrees, commits, filters. Alone they take
// up to 4s, which the 5s default left no room for once the full suite loaded
// the machine; on a fresh clone they timed out on every run.
vi.setConfig({ testTimeout: 30_000 });

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function repositoryFixture(): Promise<{ root: string; runDir: string }> {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "council-worktree-"));
  temporaryDirectories.push(parent);
  const root = path.join(parent, "landing");
  const runDir = path.join(parent, "run");
  await fs.mkdir(root);
  await fs.mkdir(runDir);
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.email", "tests@example.test");
  await git(root, "config", "user.name", "Campaign Council Tests");
  await fs.writeFile(path.join(root, "package.json"), "{}\n");
  await git(root, "add", "package.json");
  await git(root, "commit", "-m", "fixture");
  return { root, runDir };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("prepareLandingWorktree", () => {
  it("creates a per-run branch without switching or modifying the base checkout", async () => {
    const { root, runDir } = await repositoryFixture();
    await fs.writeFile(path.join(root, "local-notes.txt"), "uncommitted\n");

    const prepared = await prepareLandingWorktree({
      baseRepository: root,
      runDir,
      branchName: "campaign-council-test-run",
    });

    expect(prepared.reused).toBe(false);
    expect(await git(root, "branch", "--show-current")).toBe("main");
    expect(await git(prepared.worktreePath, "branch", "--show-current")).toBe(
      "campaign-council-test-run",
    );
    await expect(fs.access(path.join(prepared.worktreePath, "local-notes.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recovers the exact worktree on a retry", async () => {
    const { root, runDir } = await repositoryFixture();
    const first = await prepareLandingWorktree({
      baseRepository: root,
      runDir,
      branchName: "campaign-council-retry",
    });
    const second = await prepareLandingWorktree({
      baseRepository: root,
      runDir,
      branchName: "campaign-council-retry",
    });

    expect(second).toMatchObject({
      worktreePath: first.worktreePath,
      branchName: first.branchName,
      initialHead: first.initialHead,
      reused: true,
    });
  });

  it("rejects a symlinked landing repository", async () => {
    const { root, runDir } = await repositoryFixture();
    const link = path.join(path.dirname(root), "landing-link");
    await fs.symlink(root, link);

    await expect(prepareLandingWorktree({
      baseRepository: link,
      runDir,
      branchName: "campaign-council-symlink",
    })).rejects.toThrow(/non-symlink directory/);
  });

  it("rejects an existing same-name worktree from a different repository", async () => {
    const { root, runDir } = await repositoryFixture();
    const fake = path.join(runDir, "landing-worktree");
    await fs.mkdir(fake);
    await git(fake, "init", "-b", "campaign-council-wrong-repository");
    await git(fake, "config", "user.email", "tests@example.test");
    await git(fake, "config", "user.name", "Campaign Council Tests");
    await fs.writeFile(path.join(fake, "package.json"), "{}\n");
    await git(fake, "add", "package.json");
    await git(fake, "commit", "-m", "fixture");

    await expect(prepareLandingWorktree({
      baseRepository: root,
      runDir,
      branchName: "campaign-council-wrong-repository",
    })).rejects.toThrow(/different Git repository/i);
  });
});

describe("commitLandingDelivery", () => {
  async function preparedDelivery(runId: string) {
    const { root, runDir } = await repositoryFixture();
    const branchName = `campaign-council-${runId}`;
    const prepared = await prepareLandingWorktree({
      baseRepository: root,
      runDir,
      branchName,
    });
    const slug = `page-${runId}`;
    await fs.mkdir(path.join(prepared.worktreePath, "src", "app", slug), { recursive: true });
    await fs.mkdir(path.join(prepared.worktreePath, "public", slug), { recursive: true });
    const pageSource =
      '"use client"; export default function Page() { return <div />; }\n';
    await fs.writeFile(
      path.join(prepared.worktreePath, "src", "app", slug, "page.tsx"),
      pageSource,
    );
    const assetBytes = "asset";
    await fs.writeFile(path.join(prepared.worktreePath, "public", slug, "hero.webp"), assetBytes);
    return {
      root,
      branchName,
      prepared,
      slug,
      expectedFiles: {
        [`src/app/${slug}/page.tsx`]: sha256(pageSource),
        [`public/${slug}/hero.webp`]: sha256(assetBytes),
      },
    };
  }

  it("commits only the sealed page paths and is idempotent after persistence failure", async () => {
    const runId = "delivery-one";
    const { root, branchName, prepared, slug, expectedFiles } = await preparedDelivery(runId);
    const allowedPaths = [`src/app/${slug}/`, `public/${slug}/`];

    const first = await commitLandingDelivery({
      workspacePath: prepared.worktreePath,
      branchName,
      initialHead: prepared.initialHead,
      allowedPaths,
      expectedFiles,
      runId,
    });
    expect(first.reused).toBe(false);
    expect(first.commitSha).not.toBe(prepared.initialHead);
    expect(await git(prepared.worktreePath, "status", "--porcelain")).toBe("");
    expect(await git(prepared.worktreePath, "show", "--format=", "--name-only", "HEAD"))
      .toContain(`src/app/${slug}/page.tsx`);
    expect(await git(root, "rev-parse", "main")).toBe(prepared.initialHead);

    const recovered = await commitLandingDelivery({
      workspacePath: prepared.worktreePath,
      branchName,
      initialHead: prepared.initialHead,
      allowedPaths,
      expectedFiles,
      runId,
    });
    expect(recovered).toEqual({ commitSha: first.commitSha, reused: true });
  });

  it("refuses to hide an unrelated worktree change inside the delivery commit", async () => {
    const runId = "delivery-scope";
    const { root, branchName, prepared, slug, expectedFiles } = await preparedDelivery(runId);
    await fs.writeFile(path.join(prepared.worktreePath, "package.json"), '{"changed":true}\n');

    await expect(commitLandingDelivery({
      workspacePath: prepared.worktreePath,
      branchName,
      initialHead: prepared.initialHead,
      allowedPaths: [`src/app/${slug}/`, `public/${slug}/`],
      expectedFiles,
      runId,
    })).rejects.toThrow(/outside its allowed scope/);
    expect(await git(root, "rev-parse", branchName)).toBe(prepared.initialHead);
  });

  it("commits ignored sealed files and preserves a multi-chunk binary exactly", async () => {
    const runId = "delivery-ignored";
    const { root, runDir } = await repositoryFixture();
    await fs.writeFile(path.join(root, ".gitignore"), "*.css\n*.webp\n");
    await git(root, "add", ".gitignore");
    await git(root, "commit", "-m", "ignore generated files");
    const branchName = `campaign-council-${runId}`;
    const prepared = await prepareLandingWorktree({ baseRepository: root, runDir, branchName });
    const slug = "page-delivery-ignored";
    const sourceDir = path.join(prepared.worktreePath, "src", "app", slug);
    const assetDir = path.join(prepared.worktreePath, "public", slug);
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.mkdir(assetDir, { recursive: true });
    const page = '"use client"; import "./styles.css"; export default function Page() { return <div />; }\n';
    const css = ".root { color: red; }\n";
    const asset = Buffer.alloc(200 * 1024);
    for (let index = 0; index < asset.length; index++) asset[index] = index % 251;
    await fs.writeFile(path.join(sourceDir, "page.tsx"), page);
    await fs.writeFile(path.join(sourceDir, "styles.css"), css);
    await fs.writeFile(path.join(assetDir, "hero.webp"), asset);
    const expectedFiles = {
      [`src/app/${slug}/page.tsx`]: sha256(page),
      [`src/app/${slug}/styles.css`]: sha256(css),
      [`public/${slug}/hero.webp`]: sha256(asset),
    };

    const delivery = await commitLandingDelivery({
      workspacePath: prepared.worktreePath,
      branchName,
      initialHead: prepared.initialHead,
      allowedPaths: [`src/app/${slug}/`, `public/${slug}/`],
      expectedFiles,
      runId,
    });

    expect(await git(prepared.worktreePath, "show", `${delivery.commitSha}:src/app/${slug}/styles.css`))
      .toBe(css.trim());
    const committedAsset = await execFileAsync(
      "git",
      ["cat-file", "blob", `${delivery.commitSha}:public/${slug}/hero.webp`],
      { cwd: prepared.worktreePath, encoding: "buffer" },
    );
    expect(Buffer.from(committedAsset.stdout)).toEqual(asset);
  });

  it("bypasses configured clean filters and commits the sealed bytes", async () => {
    const runId = "delivery-filter";
    const { root, runDir } = await repositoryFixture();
    await fs.writeFile(path.join(root, ".gitattributes"), "*.tsx filter=upper\n");
    await git(root, "add", ".gitattributes");
    await git(root, "commit", "-m", "add clean filter attribute");
    await git(root, "config", "filter.upper.clean", "tr a-z A-Z");
    await git(root, "config", "filter.upper.smudge", "cat");
    await git(root, "config", "filter.upper.required", "true");
    const branchName = `campaign-council-${runId}`;
    const prepared = await prepareLandingWorktree({ baseRepository: root, runDir, branchName });
    const slug = "page-delivery-filter";
    const sourceDir = path.join(prepared.worktreePath, "src", "app", slug);
    const assetDir = path.join(prepared.worktreePath, "public", slug);
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.mkdir(assetDir, { recursive: true });
    const page = '"use client"; export default function Page() { return <main>lowercase</main>; }\n';
    const asset = "asset";
    await fs.writeFile(path.join(sourceDir, "page.tsx"), page);
    await fs.writeFile(path.join(assetDir, "hero.webp"), asset);

    const delivery = await commitLandingDelivery({
      workspacePath: prepared.worktreePath,
      branchName,
      initialHead: prepared.initialHead,
      allowedPaths: [`src/app/${slug}/`, `public/${slug}/`],
      expectedFiles: {
        [`src/app/${slug}/page.tsx`]: sha256(page),
        [`public/${slug}/hero.webp`]: sha256(asset),
      },
      runId,
    });

    const blob = await execFileAsync(
      "git",
      ["cat-file", "blob", `${delivery.commitSha}:src/app/${slug}/page.tsx`],
      { cwd: prepared.worktreePath, encoding: "buffer" },
    );
    expect(Buffer.from(blob.stdout)).toEqual(Buffer.from(page));
  });
});

describe("mirrorWorkspaceRuntimeFiles", () => {
  it("links node_modules and copies only gitignored .env files into the worktree", async () => {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const { execFileSync } = await import("node:child_process");
    const { mirrorWorkspaceRuntimeFiles } = await import("@/orchestrator/landingWorktree");
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "lw-base-"));
    const wt = await fs.mkdtemp(path.join(os.tmpdir(), "lw-wt-"));
    execFileSync("git", ["init", "-q"], { cwd: base });
    await fs.writeFile(path.join(base, ".gitignore"), "node_modules\n.env.local\n");
    await fs.mkdir(path.join(base, "node_modules"));
    await fs.writeFile(path.join(base, ".env.local"), "SECRET=1\n");
    await fs.writeFile(path.join(base, ".env.example"), "SECRET=\n");
    // The real target is a git worktree of the base and carries its .gitignore.
    execFileSync("git", ["init", "-q"], { cwd: wt });
    await fs.copyFile(path.join(base, ".gitignore"), path.join(wt, ".gitignore"));
    const mirrored = await mirrorWorkspaceRuntimeFiles(base, wt);
    expect(mirrored.sort()).toEqual([".env.local", "node_modules"]);
    expect((await fs.lstat(path.join(wt, "node_modules"))).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(path.join(wt, ".env.local"), "utf8")).toBe("SECRET=1\n");
    await expect(fs.lstat(path.join(wt, ".env.example"))).rejects.toThrow();
    expect(await mirrorWorkspaceRuntimeFiles(base, wt)).toEqual([]);
  });

  it("refuses a directory-only node_modules pattern, naming the cause, and leaves no link behind", async () => {
    // WSL2 acceptance run 35759101651: the shipped template ignored
    // "node_modules/" (directories only); the worktree's symlink was not
    // ignored and stage 5.3 stopped with "unrelated uncommitted changes".
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const { execFileSync } = await import("node:child_process");
    const { mirrorWorkspaceRuntimeFiles } = await import("@/orchestrator/landingWorktree");
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "lw-base-"));
    const wt = await fs.mkdtemp(path.join(os.tmpdir(), "lw-wt-"));
    execFileSync("git", ["init", "-q"], { cwd: base });
    execFileSync("git", ["init", "-q"], { cwd: wt });
    await fs.writeFile(path.join(base, ".gitignore"), "node_modules/\n");
    await fs.copyFile(path.join(base, ".gitignore"), path.join(wt, ".gitignore"));
    await fs.mkdir(path.join(base, "node_modules"));
    await expect(mirrorWorkspaceRuntimeFiles(base, wt)).rejects.toThrow(/trailing slash/);
    await expect(fs.lstat(path.join(wt, "node_modules"))).rejects.toThrow();
  });

  it("ships a landing template whose .gitignore also covers the worktree's node_modules link", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const ignore = await fs.readFile(path.join(process.cwd(), "templates", "landing", ".gitignore"), "utf8");
    const lines = ignore.split("\n").map((line) => line.trim());
    expect(lines).toContain("node_modules");
    expect(lines).not.toContain("node_modules/");
  });
});
