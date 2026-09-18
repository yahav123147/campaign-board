import type { Metadata } from "next";
import "./globals.css";
import { loadClientProfile } from "@/config/clientProfile";
import { BoardNameProvider } from "@/components/BoardNameProvider";
import { DEFAULT_BOARD_NAME, boardNameFrom } from "@/lib/boardName";

/**
 * The installation's own name for the board, read from the client profile
 * rather than written here: this file is packaged and sent to clients, and the
 * packaging scanner refuses a packaged text file that carries a tenant's brand
 * name. A profile that cannot be loaded leaves the neutral default, exactly as
 * an unset name does.
 */
async function resolveBoardName(): Promise<string> {
  const profile = await loadClientProfile().catch(() => undefined);
  return profile ? boardNameFrom(profile.ui?.boardName) : DEFAULT_BOARD_NAME;
}

export async function generateMetadata(): Promise<Metadata> {
  return {
    title: await resolveBoardName(),
    description: "דיון רב-תחומי, אישור אנושי וביצוע מבוקר.",
  };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Resolved here too, so the header renders the real name in the server HTML
  // instead of painting the neutral default and swapping after a fetch.
  const boardName = await resolveBoardName();

  return (
    <html lang="he" dir="rtl">
      <body
        className="antialiased min-h-screen"
        style={{ background: "var(--color-paper)", color: "var(--color-ink)", fontFamily: "var(--font-heebo), system-ui, sans-serif" }}
      >
        <BoardNameProvider value={boardName}>{children}</BoardNameProvider>
      </body>
    </html>
  );
}
