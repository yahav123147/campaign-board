// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { CriticBoard } from "@/components/CriticBoard";
import type { CriticRound } from "@/types";

const rounds: CriticRound[] = [
  { round: 1, verdict: "revise", scores: { "מבנה": 9, "הבטחה": 6 }, avg: 7.5, min: 6, fixes: [{ quote: "שורה", rule: "הבטחה", fix: "חדד את המנגנון" }], at: "2026-09-15T10:00:00.000Z" },
  { round: 2, verdict: "approve", scores: { "מבנה": 9, "הבטחה": 8 }, avg: 8.5, min: 8, fixes: [], at: "2026-09-15T10:05:00.000Z" },
];

describe("CriticBoard", () => {
  it("shows one column per round, the dimension rows, verdict badges and the fixes", () => {
    render(<CriticBoard rounds={rounds} dimensions={["מבנה", "הבטחה"]} />);
    expect(screen.getByText("סבב 1")).toBeTruthy();
    expect(screen.getByText("סבב 2")).toBeTruthy();
    expect(screen.getByText("הבטחה")).toBeTruthy();
    expect(screen.getByText("לתיקון")).toBeTruthy();
    expect(screen.getByText("עבר")).toBeTruthy();
    expect(screen.getByText(/חדד את המנגנון/)).toBeTruthy();
  });
  it("marks the round in progress", () => {
    render(<CriticBoard rounds={rounds.slice(0, 1)} dimensions={["מבנה", "הבטחה"]} currentRound={2} />);
    expect(screen.getByText(/סבב 2.*בביקורת/)).toBeTruthy();
  });
});
