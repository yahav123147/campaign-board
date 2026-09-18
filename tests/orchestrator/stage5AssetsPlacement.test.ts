import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Run } from "@/types";
import { getStageDef } from "@/orchestrator/stageRegistry";
import { renderApprovedCopyBlock } from "@/orchestrator/runStage5Assets";

const HEADLINE = "״איך להביא 30 לקוחות בחודש בלי לשלם על מודעות״";

function runWithStage4(outputs: Record<string, string>): Run {
  const definition = getStageDef(4, "sales-page");
  const subTasks = definition.subTasks.map((st) => ({
    id: st.id,
    title: st.title,
    status: "approved" as const,
    output: outputs[st.id] ?? "",
    feedbackHistory: [],
  }));
  return {
    id: "placement-copy",
    slug: "placement-copy",
    brief: "בריף לבדיקה",
    createdAt: "2026-09-13T10:00:00.000Z",
    status: "approved",
    currentRound: null,
    messages: [],
    assetType: "sales-page",
    stages: [{
      number: 4,
      title: definition.title,
      ownerSlug: definition.ownerSlug,
      status: "approved",
      output: subTasks.map((st) => st.output).filter(Boolean).join("\n\n---\n\n"),
      feedbackHistory: [],
      subTasks,
    }],
  } as Run;
}

describe("stage 5.2 approved copy", () => {
  it("puts a real headline from the approved stage 4 copy into the asset prompt", () => {
    const firstId = getStageDef(4, "sales-page").subTasks[0].id;
    const { block, warning } = renderApprovedCopyBlock(runWithStage4({ [firstId]: `# Hero\n\n${HEADLINE}` }));
    expect(block).toContain("### הקופי שאושר בשלב 4");
    expect(block).toContain(HEADLINE);
    expect(warning).toBe("");
  });

  it("says so and warns when there is no approved copy", () => {
    const { block, warning } = renderApprovedCopyBlock(runWithStage4({}));
    expect(block).toContain("אין קופי מאושר משלב 4");
    expect(warning).toContain("לא נמצא קופי מאושר משלב 4");
  });
});

describe("stage 5.2 validation call sites", () => {
  it("passes the placement flag in all three stage 5.2 validations and never in stage 7.5", async () => {
    const assets = await fs.readFile(path.join(process.cwd(), "orchestrator/runStage5Assets.ts"), "utf8");
    const creatives = await fs.readFile(path.join(process.cwd(), "orchestrator/runStage7Creatives.ts"), "utf8");
    expect(assets.match(/validateAssetFolderSnapshot\(/g)).toHaveLength(3);
    expect(assets.match(/requirePlacementMap: true/g)).toHaveLength(3);
    expect(creatives).not.toContain("requirePlacementMap");
  });
});
