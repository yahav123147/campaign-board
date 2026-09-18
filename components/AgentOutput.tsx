"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { swatchColor } from "./swatch";

/**
 * Agent output is markdown: headings, tables, bold. Rendering it as plain text
 * put raw `##` and `|---|---|` in front of the reviewer, which is not something to
 * hand a client.
 */
export function AgentOutput({ text }: { text: string }) {
  return (
    <article
      className="agent-output text-[15px] leading-[1.85]"
      style={{ color: "var(--color-ink)", fontFamily: "var(--font-heebo), system-ui, sans-serif" }}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code({ children, ...props }) {
            const raw = String(children ?? "");
            const color = swatchColor(raw);
            if (!color) return <code {...props}>{children}</code>;
            return (
              <code {...props} className="swatch">
                <span className="swatch-chip" style={{ background: color }} aria-hidden />
                {raw}
              </code>
            );
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </article>
  );
}
