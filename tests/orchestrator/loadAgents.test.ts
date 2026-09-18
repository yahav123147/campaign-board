import { describe, it, expect } from "vitest";
import { loadAgents } from "@/orchestrator/loadAgents";

describe("loadAgents", () => {
  it("loads all 9 agents from agents/ directory", async () => {
    const agents = await loadAgents();
    expect(agents).toHaveLength(9);
  });

  it("includes Yoni with correct metadata", async () => {
    const agents = await loadAgents();
    const yoni = agents.find(a => a.slug === "yoni-strategist");
    expect(yoni).toBeDefined();
    expect(yoni!.name).toBe("יוני בן-דוד");
    expect(yoni!.role).toBe("אסטרטג");
    expect(yoni!.color).toBe("#3B5BFD");
    expect(yoni!.order).toBe(1);
    expect(yoni!.systemPrompt.length).toBeGreaterThan(100);
  });

  it("returns agents sorted by order", async () => {
    const agents = await loadAgents();
    const orders = agents.map(a => a.order);
    expect(orders).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});

describe("art director", () => {
  it("is loadable as a critic but stays out of the 3-round discussion", async () => {
    const agents = await loadAgents();
    const uri = agents.find((a) => a.slug === "uri-art-director");
    expect(uri).toBeDefined();
    expect(uri?.active).toBe(false);
    expect(uri?.systemPrompt).toContain("חוסם");
  });
});
