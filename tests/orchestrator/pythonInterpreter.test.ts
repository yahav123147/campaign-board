import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolvePython } from "@/orchestrator/pythonInterpreter";

describe("resolvePython", () => {
  it("prefers the venv setup.sh builds under the home directory", async () => {
    const seen: string[] = [];
    const python = await resolvePython({ home: "/home/tester", access: async (file) => { seen.push(file); } });
    expect(python).toBe("/home/tester/.campaign-council-venv/bin/python3");
    expect(seen).toEqual(["/home/tester/.campaign-council-venv/bin/python3"]);
  });
  it("falls back to PATH's python3 only when there is no venv", async () => {
    const python = await resolvePython({ home: "/home/tester", access: async () => { throw new Error("ENOENT"); } });
    expect(python).toBe("python3");
  });
});

describe("image tools never spawn PATH's python3 directly", () => {
  // Regression from the WSL2 acceptance run: the asset checker spawned bare
  // "python3", the system interpreter without Pillow, while the doctor had
  // checked the venv and reported ready. Every image tool goes through the
  // resolver.
  it("assetQuality resolves its interpreter instead of naming python3", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "orchestrator", "assetQuality.ts"), "utf8");
    expect(source).not.toMatch(/spawn\(\s*["']python3["']/);
    expect(source).toContain("resolvePython");
  });
});
