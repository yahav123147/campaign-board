"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { apiFetch } from "@/lib/clientApi";
import { useBoardName } from "@/lib/useBoardName";
import { MAX_BRIEF_CHARS } from "@/lib/inputLimits";
import { isPipeline, type AssetType, type Pipeline } from "@/types";

const ASSET_CHOICES: { value: AssetType; label: string; hint: string }[] = [
  { value: "sales-page", label: "דף מכירה", hint: "יש מחיר. כולל stack, ערבות ו-FAQ" },
  { value: "premium-lead-page", label: "דף ליד פרימיום", hint: "מועמדות ושיחת התאמה. בלי מחיר" },
  { value: "webinar-page", label: "דף וובינר", hint: "הרשמה לשידור חי במועד ידוע" },
  { value: "squeeze-page", label: "דף סקוויז", hint: "ההצעה היא צפייה או הרשמה. בלי מחיר" },
  { value: "upsell-page", label: "דף אפסייל", hint: "מוצג אחרי רכישה. הריצה נעצרת אחרי בניית הדף" },
];

const PIPELINE_CHOICES: { value: Pipeline; label: string; hint: string }[] = [
  { value: "council", label: "המועצה שעוזרת לך להשחיז רעיון גדול", hint: "דיון של 8 סוכנים וסינתזה, 9 שלבים" },
  { value: "direct", label: "דף נחיתה בלחיצת כפתור", hint: "סוכן ומבקר עם ציון לכל שלב, 4 שלבים. הבריף חייב לכלול כתובת אתר" },
];

export function BriefInput() {
  const [brief, setBrief] = useState("");
  const [assetType, setAssetType] = useState<AssetType>("sales-page");
  const [pipeline, setPipeline] = useState<Pipeline>("council");
  // A click is the human's decision and the profile default never overrides it,
  // not even when the request answers late.
  const pipelineChosen = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const boardName = useBoardName();
  const router = useRouter();

  // The installation's default pipeline lives in the client profile, which is
  // a server file. Read once on mount; "council" stays the selection whenever
  // the profile is unavailable or names nothing.
  useEffect(() => {
    let cancelled = false;
    apiFetch("/api/config")
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { pipelineDefault?: unknown } | null) => {
        if (cancelled || pipelineChosen.current || !body) return;
        if (isPipeline(body.pipelineDefault)) setPipeline(body.pipelineDefault);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const submit = async () => {
    if (brief.trim().length < 10) { setError("הבריף חייב להיות לפחות 10 תווים."); return; }
    if (brief.trim().length > MAX_BRIEF_CHARS) { setError(`הבריף מוגבל ל-${MAX_BRIEF_CHARS.toLocaleString()} תווים.`); return; }
    setSubmitting(true); setError(null);
    try {
      const res = await apiFetch("/api/runs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ brief: brief.trim(), assetType, pipeline }) });
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error ?? "שגיאה לא ידועה"); }
      const { id } = await res.json();
      router.push(`/runs/${id}`);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); setSubmitting(false); }
  };

  return (
    <div className="max-w-2xl mx-auto px-6 py-24">
      <header className="text-center mb-12">
        <h1 className="font-display text-4xl font-medium tracking-tight mb-3" style={{ color: "var(--color-ink)" }}>{boardName}</h1>
        <p className="text-sm" style={{ color: "var(--color-ink-muted)" }}>מועצת מומחים · דיון מובנה · שלבים עם אישור אנושי</p>
      </header>

      <fieldset className="mb-6">
        <legend className="mb-3 text-sm" style={{ color: "var(--color-ink-muted)" }}>איזה דף בונים?</legend>
        <div className="flex flex-wrap gap-3">
          {ASSET_CHOICES.map((choice) => {
            const selected = assetType === choice.value;
            return (
              <button
                key={choice.value}
                type="button"
                onClick={() => setAssetType(choice.value)}
                aria-pressed={selected}
                className="flex-1 rounded-md p-3 text-right transition-colors"
                style={{
                  background: selected ? "var(--color-ink)" : "var(--color-surface)",
                  color: selected ? "var(--color-paper)" : "var(--color-ink)",
                  border: `1px solid ${selected ? "var(--color-ink)" : "var(--color-rule)"}`,
                  minWidth: "180px",
                }}
              >
                <span className="block text-[15px]">{choice.label}</span>
                <span className="block mt-1 text-xs" style={{ opacity: 0.75 }}>{choice.hint}</span>
              </button>
            );
          })}
        </div>
      </fieldset>

      <fieldset className="mb-6">
        <legend className="mb-3 text-sm" style={{ color: "var(--color-ink-muted)" }}>אופן העבודה</legend>
        <div className="flex flex-wrap gap-3">
          {PIPELINE_CHOICES.map((choice) => {
            const selected = pipeline === choice.value;
            return (
              <button
                key={choice.value}
                type="button"
                onClick={() => { pipelineChosen.current = true; setPipeline(choice.value); }}
                aria-pressed={selected}
                className="flex-1 rounded-md p-3 text-right transition-colors"
                style={{
                  background: selected ? "var(--color-ink)" : "var(--color-surface)",
                  color: selected ? "var(--color-paper)" : "var(--color-ink)",
                  border: `1px solid ${selected ? "var(--color-ink)" : "var(--color-rule)"}`,
                  minWidth: "180px",
                }}
              >
                <span className="block text-[15px]">{choice.label}</span>
                <span className="block mt-1 text-xs" style={{ opacity: 0.75 }}>{choice.hint}</span>
              </button>
            );
          })}
        </div>
      </fieldset>

      <label className="block mb-3 text-sm" style={{ color: "var(--color-ink-muted)" }}>{pipeline === "direct" ? "מה צריך לדעת כדי לבנות את הדף?" : "על איזה קמפיין מתייעצים?"}</label>
      <textarea
        value={brief}
        onChange={(e) => setBrief(e.target.value)}
        rows={14}
        maxLength={MAX_BRIEF_CHARS}
        placeholder={`תן עובדות. הניסוח, הזווית והרעיון הגדול הם העבודה של הסוכנים, לא שלך.

חובה לדף נחיתה בלחיצת כפתור: כתובת האתר של הלקוח, ואם יש אינסטגרם גם הידית. מהאתר נאספות התמונות, הפלטה והעובדות עם המקור שלהן, ואותן אתה לא צריך להביא.

• ההצעה: מה זה, מחיר, מטבע, מבנה תשלום, אחריות, תנאי גישה ומה נכלל
• הפרזנטור: מי מדבר בגוף ראשון בדף, מה הסמכות שלו ולמה דווקא להקשיב לו
• מה המוצר עושה, שלב אחרי שלב. איך הוא לוקח את הלקוח מ-A ל-B
• הבעיה, במילים של הלקוחות עצמם. ציטוטים עדיפים על תיאור
• התועלת: מה יוצא ללקוח מזה, כפי שהוא היה מנסח את זה
• מה השתנה לאחרונה ויוצר סיבה אמיתית לעכשיו. אם אין, כתוב "אין"
• עדויות כצילומי מסך אמיתיים, ולכל אחת: האם היא על המוצר הזה או על משהו אחר
• הוכחות סמכות: עיתונות, טלוויזיה, פודקאסט, ותק. לכל אחת הטענה שהיא מוכיחה
• נכסים שקיימים פיזית: תמונות של הפרזנטור, צילומים, לוגו, מסגרות מוקאפ
• מה אסור לומר: מגבלות רגולציה, טענות שנדחו, שפה אסורה

כל טענה צריכה מקור. מספר בלי מקור הופך להנחה מסומנת בכוכבית שמחכה לאישור שלך, ודף עם עשר כוכביות הוא דף חלש.

הסוכנים רואים רק את הבריף, את פרופיל הלקוח ואת התוצרים שנשמרו בריצה. חוץ מהחוקר, אין להם גישה לרשת. אין גישה אוטומטית לקבצים, לזיכרון אישי או לחשבונות חיצוניים, וקובץ, URL או שירות זמינים רק אם ההתקנה נתנה אליהם גישה מפורשת.`}
        className="w-full rounded-md p-4 text-[15px] leading-[1.75] focus:outline-none transition-colors"
        style={{ background: "var(--color-surface)", border: "1px solid var(--color-rule)", color: "var(--color-ink)" }}
      />
      <p className="mt-2 text-xs text-left" style={{ color: "var(--color-ink-muted)" }}>
        {brief.length.toLocaleString()} / {MAX_BRIEF_CHARS.toLocaleString()}
      </p>
      {error && <p className="mt-3 text-sm" style={{ color: "var(--color-danger)" }}>{error}</p>}

      <button
        onClick={submit}
        disabled={submitting}
        className="mt-6 w-full font-medium py-3.5 rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        style={{ background: "var(--color-accent)", color: "white" }}
      >
        {pipeline === "direct"
          ? (submitting ? "מתחיל לבנות את הדף…" : "צור דף נחיתה")
          : (submitting ? "מתחיל דיון…" : "התחל דיון")}
      </button>

      <p className="mt-6 text-center text-sm">
        <Link href="/archive" className="hover:underline" style={{ color: "var(--color-ink-muted)" }}>
          ארכיון הריצות הקודמות →
        </Link>
      </p>
    </div>
  );
}
