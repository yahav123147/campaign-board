import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { landingBuildFailureMessage } from "@/orchestrator/runStage5LpBuild";

describe("landingBuildFailureMessage", () => {
  const output = [
    "   Creating an optimized production build ...",
    "src/app/council-x/page.tsx(423,13): error TS2322: Type '{ hidden: { opacity: number; }; }' is not assignable to type 'Variants'.",
    "  Property 'visible' is incompatible with index signature.",
    "                    Type 'string' is not assignable to type 'Easing | Easing[] | undefined'.",
    "Failed to type check.",
  ].join("\n");

  it("leads with the compiler's located error lines, then the raw tail, then the hint", () => {
    const message = landingBuildFailureMessage(1, output, " hint");
    expect(message.startsWith("Landing build failed (exit 1): src/app/council-x/page.tsx(423,13): error TS2322:")).toBe(true);
    expect(message).toContain("---\n");
    expect(message).toContain("Failed to type check.");
    expect(message.endsWith(" hint")).toBe(true);
  });

  it("keeps the raw tail alone when the output carries no located error", () => {
    const message = landingBuildFailureMessage(2, "boom\nno such module", "");
    expect(message).toBe("Landing build failed (exit 2): boom\nno such module");
  });

  it("caps the located lines at five and the tail at 4000 characters", () => {
    const many = Array.from({ length: 9 }, (_, i) => `a.tsx(${i},1): error TS1: e${i}`).join("\n") + "\n" + "x".repeat(10_000);
    const message = landingBuildFailureMessage(1, many, "");
    expect((message.match(/error TS1/g) ?? []).length).toBe(5);
    expect(message.length).toBeLessThan(5_000);
  });
});

describe("the builder's hard rules name the easing type trap", () => {
  // WSL2 acceptance runs 35772211794, 35850777432 and 35877627654 all failed
  // the build on `ease: "easeOut"` widened to string; the skill's own
  // examples wrote it that way. The rule and the examples must agree.
  it("tells the agent how to type framer-motion easing", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "orchestrator", "runStage5LpBuild.ts"), "utf8");
    expect(source).toContain("Type-check floor");
    expect(source).toContain('ease: "easeOut" as const');
  });
  it("ships skill examples whose easing is typed, never a bare string", () => {
    for (const file of ["SKILL.md", path.join("references", "animations.md")]) {
      const skill = fs.readFileSync(path.join(process.cwd(), "vendor", "landing-skill", file), "utf8");
      const bare = [...skill.matchAll(/ease:\s*"[^"]+"(?!\s*as const)/g)];
      expect(bare.map((match) => match[0]), file).toEqual([]);
    }
  });
});
