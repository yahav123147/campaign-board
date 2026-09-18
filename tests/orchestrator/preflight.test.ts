import { describe, it, expect } from "vitest";
import { blockingStatusLines } from "@/orchestrator/runStage5LpBuild";

const PORCELAIN = ` M src/app/course-machine/TopSections.tsx
?? src/app/council-abc-2026-08-26-1314/
?? public/council-abc-2026-08-26-1314/
 m ruflo
`;

describe("blockingStatusLines", () => {
  it("blocks unrelated uncommitted work", () => {
    expect(blockingStatusLines(PORCELAIN, [])).toContain(" M src/app/course-machine/TopSections.tsx");
  });

  it("does not block on the page this run owns", () => {
    const blocking = blockingStatusLines(PORCELAIN, [
      "src/app/council-abc-2026-08-26-1314/",
      "public/council-abc-2026-08-26-1314/",
    ]);
    expect(blocking.join("\n")).not.toContain("council-abc");
  });

  it("still blocks a different run's leftovers", () => {
    const blocking = blockingStatusLines("?? src/app/council-other-2026-01-01-0000/\n", [
      "src/app/council-abc-2026-08-26-1314/",
    ]);
    expect(blocking).toHaveLength(1);
  });

  it("ignores submodule-internal changes", () => {
    expect(blockingStatusLines(" m ruflo\n", [])).toEqual([]);
  });

  it("returns nothing for a clean tree", () => {
    expect(blockingStatusLines("", [])).toEqual([]);
  });
});
