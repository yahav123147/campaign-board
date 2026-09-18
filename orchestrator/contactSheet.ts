function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * A page that shows every asset produced for a landing page, so the reviewer approves
 * images by looking at them. Written next to the files and opened with file://,
 * so every src is a plain relative filename.
 */
export function buildContactSheet(files: string[], captions: Record<string, string>): string {
  return buildContactSheetWithStatus(files, captions, {});
}

export interface ContactSheetStatus {
  status: "approved" | "review-required" | "rejected";
  kind: string;
  sourceFile?: string;
  problems?: string[];
  previewable?: boolean;
  section?: string;
  proves?: string;
}

export function buildContactSheetWithStatus(
  files: string[],
  captions: Record<string, string>,
  statuses: Record<string, ContactSheetStatus>,
  cacheKeys: Record<string, string> = {},
  snapshotSources: Record<string, string> = {},
): string {
  const visibleFiles = new Set(files);
  const imageAttributes = (file: string) => snapshotSources[file]
    ? `data-snapshot-file="${escapeHtml(file)}"`
    : `src="${escapeHtml(`${file}${cacheKeys[file] ? `?v=${encodeURIComponent(cacheKeys[file])}` : ""}`)}"`;
  const cards = files
    .map((file) => {
      const caption = captions[file]?.trim() || "ללא מקור";
      const metadata = statuses[file];
      const status = metadata?.status ?? "approved";
      const statusLabel =
        status === "approved" ? "מאומת" : status === "review-required" ? "דורש בדיקה בעין" : "נדחה";
      const details = [
        metadata?.sourceFile ? `מקור להשוואה: ${metadata.sourceFile}` : "",
        ...(metadata?.problems ?? []),
      ].filter(Boolean);
      const placementLine = metadata?.section && metadata?.proves
        ? `סקציה: ${metadata.section} · מוכיחה: ${metadata.proves}`
        : "";
      const canPreview = metadata?.previewable !== false;
      const sourceCanPreview = metadata?.sourceFile
        ? visibleFiles.has(metadata.sourceFile) && statuses[metadata.sourceFile]?.previewable !== false
        : false;
      const imageMarkup =
        canPreview && metadata?.kind === "cutout" && metadata.sourceFile && sourceCanPreview
          ? `<div class="comparison">
          <div class="image-panel source-panel">
            <span class="image-label">מקור</span>
            <img ${imageAttributes(metadata.sourceFile)} alt="מקור ${escapeHtml(metadata.sourceFile)}" loading="lazy" />
          </div>
          <div class="image-panel candidate-panel">
            <span class="image-label">מועמד לגזירה</span>
            <img ${imageAttributes(file)} alt="מועמד ${escapeHtml(file)}" loading="lazy" />
          </div>
        </div>`
          : canPreview
            ? `<img ${imageAttributes(file)} alt="${escapeHtml(file)}" loading="lazy" />`
            : `<div class="preview-blocked">התצוגה נחסמה כי הקובץ אינו raster רגיל ומפוענח</div>`;
      return `      <figure>
        ${imageMarkup}
        <figcaption>
          <b class="badge ${escapeHtml(status)}">${escapeHtml(statusLabel)}</b>
          <strong>${escapeHtml(file)}</strong>
          <span>${escapeHtml(caption)}</span>
          ${placementLine ? `<span class="placement">${escapeHtml(placementLine)}</span>` : ""}
          ${details.length ? `<span class="details">${escapeHtml(details.join(" · "))}</span>` : ""}
        </figcaption>
      </figure>`;
    })
    .join("\n");

  const body = files.length
    ? `    <div class="grid">\n${cards}\n    </div>`
    : `    <p class="empty">לא הופק אף נכס. אין תמונות להכניס לדף.</p>`;

  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>נכסי הדף לאישור</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; padding: 32px; background: #fafaf9; color: #0f0f12;
         font-family: Heebo, -apple-system, "Segoe UI", system-ui, sans-serif; }
  header { max-width: 1100px; margin: 0 auto 28px; }
  h1 { font-size: 24px; margin: 0 0 6px; font-weight: 600; }
  header p { margin: 0; color: #6b6b72; font-size: 14px; line-height: 1.6; }
  .grid { max-width: 1100px; margin: 0 auto; display: grid;
          grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 20px; }
  figure { margin: 0; background: #fff; border: 1px solid #e5e5e7; border-radius: 8px; overflow: hidden; }
  /* Mid-tone checker: a white logo and a black cutout both have to read on it. */
  img { display: block; width: 100%; height: 220px; object-fit: contain;
        background: repeating-conic-gradient(#9a9a9a 0% 25%, #c4c4c4 0% 50%) 50% / 16px 16px; }
  .comparison { display: grid; grid-template-columns: 1fr 1fr; direction: ltr; }
  .image-panel { position: relative; min-width: 0; }
  .image-panel + .image-panel { border-left: 1px solid #e5e5e7; }
  .image-panel img { height: 220px; }
  .source-panel img { background: #e7e5e4; }
  .image-label { position: absolute; z-index: 1; top: 8px; left: 8px; padding: 3px 7px;
                 border-radius: 999px; background: rgba(15,15,18,.82); color: white; font-size: 10px; }
  .preview-blocked { display: grid; place-items: center; min-height: 220px; padding: 24px;
                     background: #fee2e2; color: #991b1b; text-align: center; font-size: 13px; }
  figcaption { padding: 12px 14px; border-top: 1px solid #e5e5e7; }
  figcaption strong { display: block; font-size: 13px; word-break: break-all; }
  figcaption span { display: block; margin-top: 4px; font-size: 12px; color: #6b6b72; line-height: 1.5; }
  .badge { display: inline-block; margin-bottom: 8px; padding: 3px 8px; border-radius: 999px;
           font-size: 11px; background: #dcfce7; color: #166534; }
  .badge.review-required { background: #fef3c7; color: #92400e; }
  .badge.rejected { background: #fee2e2; color: #991b1b; }
  .details { font-weight: 600; }
  .empty { max-width: 1100px; margin: 0 auto; color: #991b1b; font-size: 15px; }
  @media (prefers-color-scheme: dark) {
    body { background: #0f0f12; color: #f2f2f2; }
    figure { background: #17171b; border-color: #2a2a30; }
    figcaption { border-color: #2a2a30; }
    .image-panel + .image-panel { border-color: #2a2a30; }
    header p, figcaption span { color: #9a9aa2; }
  }
</style>
</head>
<body>
  <header>
    <h1>נכסי הדף לאישור</h1>
    <p>אלה התמונות והמוקאפים שייכנסו לדף המכירה. הרקע המשובץ מסמן שקיפות.
       מה שלא מתאים, תגיד בתיבת המשוב ואפשר להחליף לפני שהדף נבנה.</p>
  </header>
${body}
${Object.keys(snapshotSources).length
  ? `<script>
  const snapshotSources = ${JSON.stringify(snapshotSources).replace(/</g, "\\u003c")};
  for (const image of document.querySelectorAll("img[data-snapshot-file]")) {
    const source = snapshotSources[image.dataset.snapshotFile];
    if (source) image.src = source;
  }
</script>`
  : ""}
</body>
</html>
`;
}

/**
 * The asset agent reports a markdown table: file | section | source | note.
 * Pull the caption for each file out of it, best effort: a missing caption only
 * costs a label on the sheet, so a malformed row is skipped, never fatal.
 */
export function parseAssetCaptions(report: string): Record<string, string> {
  const captions: Record<string, string> = {};
  for (const line of report.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) continue;
    const clean = trimmed.split("|").slice(1, -1).map((c) => c.replace(/`/g, "").trim());
    if (clean.length < 2) continue;
    const file = clean[0];
    if (!/\.(webp|png|jpe?g|avif|mp4)$/i.test(file)) continue;
    captions[file] = clean.slice(1).filter(Boolean).join(" · ");
  }
  return captions;
}
