import { describe, expect, it } from "vitest";
import { brandBriefForBuild, renderDesignBriefBlock } from "@/orchestrator/runStage5LpBuild";
import { parseReference } from "@/orchestrator/designStandard";
import type { Run } from "@/types";

const run = (pipeline: "council" | "direct"): Run => ({
  id: "r", slug: "r", brief: "b", createdAt: "2026-09-15T10:00:00.000Z", status: "approved", currentRound: null, messages: [], pipeline,
  stages: [
    { number: 3, title: "בריף עיצוב", ownerSlug: "uri-art-director", status: "approved", output: "", feedbackHistory: [], subTasks: [{ id: "3", title: "בריף עיצוב", status: "approved", output: "REFERENCE_URL: https://example.com/ref\n```json\n{\"playbook\":\"Dark Premium\",\"colors\":{\"base\":\"#111\",\"accent\":\"#f49\",\"text\":\"#fff\"},\"vibe\":[\"חד\"],\"specialElements\":[\"מונה\"],\"hardBans\":[\"קו זהב\"],\"imageMap\":[]}\n```", feedbackHistory: [] }] },
    { number: 5, title: "בנייה", ownerSlug: "daniel-lp-designer", status: "running", output: "", feedbackHistory: [], subTasks: [{ id: "5.1", title: "בריף מותג", status: "approved", output: "בריף 5.1", feedbackHistory: [] }] },
  ],
} as Run);

describe("brandBriefForBuild / renderDesignBriefBlock", () => {
  it("picks stage 3 for direct and 5.1 for council", () => {
    expect(brandBriefForBuild(run("direct"))).toContain("REFERENCE_URL");
    expect(brandBriefForBuild(run("council"))).toBe("בריף 5.1");
  });
  it("renders the JSON fields as binding build rules with the precedence sentence, and nothing for council", () => {
    const block = renderDesignBriefBlock(run("direct"));
    expect(block).toContain("Dark Premium");
    expect(block).toContain("#f49");
    expect(block).toContain("קו זהב");
    expect(block).toContain("תבנית סוג הדף > בריף העיצוב > תקן העיצוב הכללי");
    expect(renderDesignBriefBlock(run("council"))).toBe("");
  });
});

describe("parseReference on a stage 3 output that also carries a ```json block", () => {
  it("still finds the REFERENCE_URL line", () => {
    const stage3Output = run("direct").stages?.find((s) => s.number === 3)?.subTasks.find((st) => st.id === "3")?.output ?? "";
    expect(parseReference(stage3Output)).toEqual({ url: "https://example.com/ref" });
  });
});
