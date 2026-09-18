import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildWorkspacePermissions } from "@/orchestrator/runStage5LpBuild";

describe("Stage 5 builder permissions", () => {
  it("allows reads in the worktree and writes only in the generated route", () => {
    const workspace = path.resolve("/safe/worktree");
    const route = path.join(workspace, "src", "app", "campaign-page");
    expect(buildWorkspacePermissions(workspace, route)).toEqual({
      permissions: {
        allow: [
          `Read(/${workspace}/**)`,
          `Edit(/${route}/**)`,
          "Glob",
          "Grep",
        ],
        deny: [
          `Edit(/${workspace}/public/**)`,
        ],
      },
    });
  });

  it("prefixes absolute paths with // so Claude Code does not read them as project-relative", () => {
    const allow = (buildWorkspacePermissions("/safe/worktree", "/safe/worktree/src/app/x") as { permissions: { allow: string[] } }).permissions.allow;
    expect(allow[0]).toBe("Read(//safe/worktree/**)");
    expect(allow.every((rule) => !/^(Read|Write|Edit)\(\/[^/]/.test(rule))).toBe(true);
  });

  // A Write(path) rule makes the CLI exit 1 before the agent starts: only
  // Edit(path) rules are matched by its file permission checks (17.09.2026).
  it("never emits a Write path rule, in allow or in deny", () => {
    const { permissions } = buildWorkspacePermissions(
      "/safe/worktree",
      "/safe/worktree/src/app/x",
    ) as { permissions: { allow: string[]; deny: string[] } };
    expect([...permissions.allow, ...permissions.deny].some((rule) => rule.startsWith("Write("))).toBe(false);
    expect(permissions.allow).toContain("Edit(//safe/worktree/src/app/x/**)");
  });

  it("rejects a writable route outside the isolated worktree", () => {
    expect(() => buildWorkspacePermissions("/safe/worktree", "/safe/other"))
      .toThrow(/inside its isolated worktree/);
  });
});

describe("Stage 5 Next.js CLI resolution", () => {
  it("prefers next/dist/bin/next over a .bin shim", async () => {
    const { resolveNextCli } = await import("@/orchestrator/runStage5LpBuild");
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nm-"));
    await fs.mkdir(path.join(dir, "next", "dist", "bin"), { recursive: true });
    await fs.writeFile(path.join(dir, "next", "dist", "bin", "next"), "#!/usr/bin/env node\n");
    await fs.mkdir(path.join(dir, ".bin"), { recursive: true });
    await fs.writeFile(path.join(dir, ".bin", "next"), "#!/bin/sh\nexec node x\n");
    expect(await resolveNextCli(dir)).toBe(await fs.realpath(path.join(dir, "next", "dist", "bin", "next")));
  });
});
