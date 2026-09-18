"use client";
import { AgentCard } from "./AgentCard";
import type { AgentMeta, RoundNumber } from "@/types";

interface RoundViewProps {
  round: RoundNumber;
  agents: AgentMeta[];
  contents: Record<string, string>;
  statuses: Record<string, "waiting" | "streaming" | "done" | "error">;
}

const ROUND_TITLES: Record<RoundNumber, string> = {
  1: "סבב 1 — עמדות פתיחה",
  2: "סבב 2 — קונטרות",
  3: "סבב 3 — התכנסות",
};

export function RoundView({ round, agents, contents, statuses }: RoundViewProps) {
  // Sort agents by their order field so the boardroom always flows in the same direction
  const ordered = [...agents].sort((a, b) => a.order - b.order);
  return (
    <section className="mb-12">
      <h2 className="text-sm font-medium text-zinc-500 mb-4 tracking-wide uppercase">{ROUND_TITLES[round]}</h2>
      <div className="bg-white">
        {ordered.map((a) => (
          <AgentCard
            key={a.slug}
            agent={a}
            status={statuses[a.slug] ?? "waiting"}
            content={contents[a.slug] ?? ""}
          />
        ))}
      </div>
    </section>
  );
}
