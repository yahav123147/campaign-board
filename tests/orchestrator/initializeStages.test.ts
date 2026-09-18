import { describe, expect, it } from "vitest";
import { initializeStages } from "@/orchestrator/initializeStages";

describe("initializeStages", () => {
  it("builds pending stages from the ladder of the given pipeline", () => {
    const direct = initializeStages("sales-page", "direct");
    expect(direct.map((s) => s.number)).toEqual([1, 2, 3, 5]);
    expect(direct.every((s) => s.status === "pending" && s.subTasks.every((t) => t.status === "pending" && t.output === ""))).toBe(true);
    expect(initializeStages("upsell-page", undefined).map((s) => s.number)).toEqual([1, 2, 3, 4, 5]);
  });
});
