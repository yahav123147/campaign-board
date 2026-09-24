import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "דפי הנחיתה",
  description: "סביבת דפי הנחיתה המקומית",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="he" dir="rtl"><body>{children}</body></html>;
}
