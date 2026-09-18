// How a full-page capture is cut into strips a design critic can actually read.
//
// `shoot` writes one file per width with `fullPage: true`. A real sales page
// came out 390x21244 and 1280x20196. A vision model handed that aspect ratio
// sees a compressed sliver: in the 10th acceptance run all three design critics
// failed the page from those two files, and only one of them said why. Uri
// Segev reported it honestly as his first blocker ("no text is legible, six
// mandatory checks cannot be performed") and asked for strips of up to 2000px.
// The other two did not say it and wrote confident blockers that the pixels
// contradict: the hero portrait "swallowed by the text block" is full width and
// dominant, the four authority proofs "not adjacent to their claims" each sit
// under the sentence they prove, the testimonial cards "almost empty light
// frames" are dark message screenshots with legible Hebrew, and the module
// mockups "almost empty light rectangles" measure dark and detailed. One
// blocker out of roughly ten was real.
//
// A refusal is recoverable. A confident false blocker sends the builder to
// change a page that was right. So the critics get strips, and this module is
// the arithmetic of the cut, stated so it can be tested as a table instead of
// only through a live browser, a preview server and a real capture.

/** The tallest strip a critic reads comfortably. Uri Segev's own number. */
export const MAX_STRIP_HEIGHT_PX = 2_000;

/**
 * The most strips one capture may become. Every strip costs a Read permission
 * rule and a file the critic must open, so a pathological page grows its strip
 * height instead of its strip count: `shoot` allows a page up to 80,000px, and
 * at this cap that page yields strips of about 5,715px, still four times more
 * readable than the single file it replaces.
 */
export const MAX_STRIPS_PER_SHOT = 14;

export interface Strip {
  /** 1-based, top-most first, the order the critic must read them in. */
  readonly index: number;
  readonly top: number;
  readonly height: number;
}

export interface StripPlanOptions {
  readonly maxStripHeight?: number;
  readonly maxStrips?: number;
}

/**
 * The strips one capture of `totalHeight` pixels is cut into: contiguous,
 * top-most first, together covering exactly the whole capture and nothing
 * beyond it. A height the caller could not measure yields no strips at all,
 * so the caller falls back to the full capture rather than to a bad cut.
 */
export function planStrips(totalHeight: number, options: StripPlanOptions = {}): Strip[] {
  if (!Number.isFinite(totalHeight) || totalHeight <= 0) return [];
  const maxStripHeight = positive(options.maxStripHeight, MAX_STRIP_HEIGHT_PX);
  const maxStrips = positive(options.maxStrips, MAX_STRIPS_PER_SHOT);
  const total = Math.floor(totalHeight);

  // The cap binds the count, never the coverage: grow the strip instead.
  const stripHeight = Math.ceil(total / maxStripHeight) > maxStrips
    ? Math.ceil(total / maxStrips)
    : maxStripHeight;

  const strips: Strip[] = [];
  for (let top = 0; top < total; top += stripHeight) {
    strips.push({ index: strips.length + 1, top, height: Math.min(stripHeight, total - top) });
  }
  return strips;
}

function positive(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value as number) > 0 ? Math.floor(value as number) : fallback;
}

/**
 * The viewport width a capture was taken at, read from the name `shoot` gave
 * it (`round-2-390.png`, `reference-1280.png`).
 *
 * The critic prompt used to pair files with widths by array index. `shoot`
 * logs a width that fails and carries on with a shorter array, so a run that
 * captured only 1280 would have labelled it "390px" and told three critics to
 * judge mobile rules against a desktop page. The name is the only thing that
 * actually knows which width a file is.
 */
export function captureWidthFromFile(file: string, fallback?: number): number | undefined {
  // Three or four digits: every width `shoot` accepts is 320 to 2560, while a
  // strip's own suffix is two digits, so a strip file can never match here.
  const match = /-(\d{3,4})\.png$/i.exec(String(file ?? "").trim());
  if (!match) return fallback;
  const width = Number(match[1]);
  return Number.isSafeInteger(width) && width > 0 ? width : fallback;
}

/** PNG's fixed preamble: the 8-byte signature, then the IHDR length and type. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/**
 * The pixel size of a PNG, read from its header.
 *
 * The strip plan needs the capture's height, and the header carries it in the
 * first 24 bytes: spawning an image library just to be told a number the file
 * states up front is a process the round does not need.
 */
export function pngPixelSize(header: Uint8Array): { width: number; height: number } | undefined {
  if (!header || header.length < 24) return undefined;
  if (PNG_SIGNATURE.some((byte, i) => header[i] !== byte)) return undefined;
  const read = (offset: number) =>
    ((header[offset] << 24) | (header[offset + 1] << 16) | (header[offset + 2] << 8) | header[offset + 3]) >>> 0;
  const width = read(16);
  const height = read(20);
  if (width <= 0 || height <= 0) return undefined;
  return { width, height };
}

export interface ShotGroup {
  readonly width: number;
  /** The strip files of this width, in reading order. A single entry is an unsliced capture. */
  readonly files: readonly string[];
}

/**
 * The "## הדף" list a design critic reads, which has to say out loud that the
 * files are consecutive slices of ONE page. Told only their paths, a critic
 * reads eleven files as eleven pages and reports the same section eleven times.
 */
export function renderShotList(groups: readonly ShotGroup[]): string {
  const usable = groups.filter((group) => group.files.length > 0);
  if (!usable.length) return "";
  const sliced = usable.some((group) => group.files.length > 1);

  const blocks = usable.map((group) => {
    if (group.files.length === 1) return `- ${group.width}px: ${group.files[0]}`;
    const lines = group.files.map((file, i) => `  ${i + 1}. ${file}`).join("\n");
    return `- ${group.width}px, ${group.files.length} רצועות רצופות מלמעלה למטה:\n${lines}`;
  });

  const preamble = sliced
    ? [
        "הצילומים חתוכים לרצועות. כל רוחב הוא **דף אחד** שנחתך לרצועות רצופות,",
        "מלמעלה למטה, בלי חפיפה ובלי חסר. תפתח את כולן לפי הסדר ותקרא אותן",
        "כדף אחד רציף. אותה סקציה שמופיעה בשתי רצועות היא סקציה אחת שנחתכה",
        "בגבול, לא שתי סקציות. אותו דף מופיע בכל רוחב.",
        "",
      ].join("\n")
    : "";

  return `${preamble}${blocks.join("\n")}`;
}
