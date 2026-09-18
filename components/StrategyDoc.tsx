"use client";
interface StrategyDocProps { content: string; }

export function StrategyDoc({ content }: StrategyDocProps) {
  return (
    <section className="bg-zinc-50 border border-zinc-200 rounded-lg p-8 mb-8">
      <h2 className="text-sm font-medium text-zinc-500 mb-5 tracking-wide uppercase">מסמך אסטרטגיה</h2>
      <pre className="whitespace-pre-wrap text-[15px] leading-[1.75] text-zinc-900" style={{ fontFamily: "var(--font-heebo), system-ui, sans-serif" }}>{content}</pre>
    </section>
  );
}
