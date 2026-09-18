"use client";
import type { AgentMeta } from "@/types";

type AgentStatus = "waiting" | "streaming" | "done" | "error";

interface CouncilHeaderProps {
  agents: AgentMeta[];
  statuses: Record<string, AgentStatus>;
}

export function CouncilHeader({ agents, statuses }: CouncilHeaderProps) {
  return (
    <div className="flex flex-wrap justify-center gap-4 py-5 border-b border-zinc-200 mb-8">
      {agents.map((a) => {
        const s = statuses[a.slug] ?? "waiting";
        return (
          <div key={a.slug} className="flex flex-col items-center w-16">
            <div
              className={`w-10 h-10 rounded-full grid place-items-center text-sm font-semibold transition-all ${
                s === "streaming" ? "bg-zinc-900 text-white ring-2 ring-zinc-300 ring-offset-2" :
                s === "done" ? "bg-zinc-900 text-white" :
                s === "error" ? "bg-zinc-100 text-red-600 ring-1 ring-red-300" :
                "bg-zinc-100 text-zinc-400"
              }`}
            >
              {a.name.charAt(0)}
            </div>
            <div className="text-[11px] text-zinc-500 mt-1.5 truncate w-full text-center">{a.name.split(" ")[0]}</div>
          </div>
        );
      })}
    </div>
  );
}
