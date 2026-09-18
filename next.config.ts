import type { NextConfig } from "next";

const scriptPolicy = process.env.NODE_ENV === "development"
  ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
  : "script-src 'self' 'unsafe-inline'";

export function previewOrigin(): string {
  const raw = process.env.PREVIEW_PORT?.trim() || "4322";
  if (!/^\d+$/.test(raw)) throw new Error("PREVIEW_PORT must be an integer between 1024 and 65535");
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
    throw new Error("PREVIEW_PORT must be an integer between 1024 and 65535");
  }
  return `http://127.0.0.1:${port}`;
}

const nextConfig: NextConfig = {
  // Next מתיר כברירת מחדל רק localhost; 127.0.0.1 מותר דרך `next dev -H 127.0.0.1`
  // (כמו בסקריפט dev) או דרך הרשימה הזו. השורה קיימת כדי שגם הרצה ידנית של
  // `npx next dev --port 4321` בלי הדגל לא תשאיר את הדפדפן ב-127.0.0.1 בלי
  // hydration (אף כפתור לא חי). חשיפה מודעת (dev בלבד): ההתאמה היא לפי hostname
  // בלי פורט, ולכן גם שרת התצוגה ב-127.0.0.1:4322, שמגיש דפים מג'ונרטים, עובר
  // את חסימת ה-dev-resources של הבורד; אותה חשיפה קיימת ממילא דרך הדגל -H.
  allowedDevOrigins: ["127.0.0.1"],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Frame-Options", value: "DENY" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
          },
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              "base-uri 'self'",
              "object-src 'none'",
              "frame-ancestors 'none'",
              "form-action 'self'",
              scriptPolicy,
              "style-src 'self' 'unsafe-inline'",
              "font-src 'self' data:",
              "img-src 'self' data: blob:",
              "connect-src 'self'",
              `frame-src ${previewOrigin()}`,
            ].join("; "),
          },
        ],
      },
    ];
  },
};

export default nextConfig;
