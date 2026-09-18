import { describe, expect, it } from "vitest";
import { minimumAgentQuorum } from "@/orchestrator/runDiscussion";

describe("discussion quorum policy", () => {
  it.each([
    [1, 1],
    [2, 2],
    [3, 3],
    [4, 3],
    [7, 6],
    [8, 6],
  ])("requires a strong quorum for %i speakers", (total, expected) => {
    expect(minimumAgentQuorum(total)).toBe(expected);
  });

  it("rejects an empty council", () => {
    expect(() => minimumAgentQuorum(0)).toThrow(/positive/);
  });
});
