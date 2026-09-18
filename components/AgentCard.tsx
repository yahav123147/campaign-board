"use client";
import type { AgentMeta } from "@/types";

interface AgentCardProps {
  agent: AgentMeta;
  status: "waiting" | "streaming" | "done" | "error";
  content: string;
}

export function AgentCard({ agent, status, content }: AgentCardProps) {
  if (status === "waiting") return null; // Don't show waiting agents in the thread

  return (
    <article className="flex gap-4 py-6 border-b border-zinc-200 last:border-b-0">
      <div className="flex-shrink-0">
        <div className="w-10 h-10 rounded-full bg-zinc-900 text-white grid place-items-center text-sm font-semibold">
          {agent.name.charAt(0)}
        </div>
      </div>
      <div className="flex-1 min-w-0">
        <header className="flex items-baseline gap-2 mb-2">
          <span className="font-semibold text-zinc-900">{agent.name}</span>
          <span className="text-xs text-zinc-500">{agent.role}</span>
          <span className="text-xs text-zinc-400 mr-auto">
            {status === "streaming" && "מדבר עכשיו"}
            {status === "done" && "סיים"}
            {status === "error" && "שגיאה"}
          </span>
        </header>
        {status === "error" && <p className="text-red-600 text-sm">⚠ שגיאה: {content}</p>}
        {(status === "streaming" || status === "done") && (
          <div className="text-zinc-800 text-[15px] leading-[1.75] whitespace-pre-wrap">
            {content}
            {status === "streaming" && <span className="inline-block w-2 h-4 bg-zinc-900 animate-pulse align-middle mr-1" />}
          </div>
        )}
      </div>
    </article>
  );
}
