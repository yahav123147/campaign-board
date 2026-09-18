// Which words share one visual line, and when a line is a one-word orphan.
//
// This is the measuring half of landing-qa.mjs, kept in a module of its own
// for the same reason as the renderer's policy module: the rule can be stated
// as a table of measured rectangles in a test, instead of being reachable only
// through a live browser.
//
// The gate used to bucket every word by its rounded top. A raised marker, the
// assumption asterisk a page prints as <sup>*</sup>, sits a few pixels higher
// than the sentence it belongs to, so it landed in a bucket of its own and was
// reported as a line holding one short word, at every width. It never was one:
// its rectangle overlaps the sentence's by most of its height, and the eye
// reads them as the same line. Lines are grouped by vertical overlap, which is
// what "the same line" means to the eye, instead of by an exact top.

/**
 * How much of the element's width a one-word line may fill before it stops
 * being an orphan. A long URL that fills its own line is not an orphan: there
 * was nothing to wrap with it.
 */
export const ORPHAN_LINE_WIDTH_RATIO = 0.45;

/**
 * How much of the shorter rectangle two rectangles must share vertically to be
 * one line. More than half: a raised marker overlaps its sentence by most of
 * its own height, while the next line down, at any line-height a body page
 * uses, overlaps by far less than that or not at all.
 */
export const LINE_OVERLAP_RATIO = 0.5;

/** A measurement the browser could not give a usable number for is nothing. */
function measured(token) {
  return Boolean(token)
    && Number.isFinite(token.top)
    && Number.isFinite(token.bottom)
    && Number.isFinite(token.width)
    && token.bottom > token.top
    && token.width > 0;
}

/** Whether a token's rectangle sits on the line built so far. */
function sharesLine(line, token) {
  const overlap = Math.min(line.bottom, token.bottom) - Math.max(line.top, token.top);
  const shorter = Math.min(line.bottom - line.top, token.bottom - token.top);
  return overlap > shorter * LINE_OVERLAP_RATIO;
}

/**
 * The words of an element grouped into the lines they really render on.
 *
 * @param {Array<{text?: string, top: number, bottom: number, width: number}>} [tokens]
 *   one rectangle per word, as the browser measured it.
 * @returns {Array<{top: number, bottom: number, width: number, words: string[]}>}
 *   the lines, top-most first; `width` is the ink the words take on that line.
 */
export function groupVisualLines(tokens) {
  const lines = [];
  const usable = (Array.isArray(tokens) ? tokens : []).filter(measured);
  for (const token of [...usable].sort((a, b) => a.top - b.top)) {
    const line = lines[lines.length - 1];
    if (line && sharesLine(line, token)) {
      line.top = Math.min(line.top, token.top);
      line.bottom = Math.max(line.bottom, token.bottom);
      line.width += token.width;
      line.words.push(String(token.text ?? ''));
    } else {
      lines.push({
        top: token.top,
        bottom: token.bottom,
        width: token.width,
        words: [String(token.text ?? '')],
      });
    }
  }
  return lines;
}

/**
 * The orphan line of one element, if it has one: a line holding a single short
 * word while another line exists to have held it.
 */
export function hasOrphanLine(element) {
  const lines = groupVisualLines(element?.tokens);
  if (lines.length < 2) return false;
  const width = Number.isFinite(element?.width) && element.width > 0 ? element.width : 1;
  return lines.some((line) => line.words.length <= 1 && line.width / width < ORPHAN_LINE_WIDTH_RATIO);
}

/**
 * What the gate prints for an element that holds an orphan: its lines, in
 * order, separated by " / ", so the reader can see which word was left alone.
 * `undefined` when the element is fine.
 */
export function orphanReport(element) {
  if (!hasOrphanLine(element)) return undefined;
  return groupVisualLines(element?.tokens)
    .map((line) => line.words.join(' '))
    .join(' / ')
    .slice(0, 90);
}
