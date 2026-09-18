// What the render script is allowed to load, and which screens it opens.
//
// This is the security-critical half of render_screens.mjs, kept in a module
// of its own so it can be stated as a table in a test instead of being
// reachable only through a live browser.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SCREEN_NAME_RE = /^[A-Za-z0-9._-]{1,60}$/;

/**
 * The exact file URLs this attempt may load: one per screen the caller
 * accepted, under the screens folder as the filesystem really resolves it.
 *
 * A prefix would have been a fence around the folder, not around the screens:
 * any .html that happened to sit there, including one the caller's boundary
 * scan never read, would have loaded. The caller already names exactly the
 * screens it accepted (the sizes file it wrote), so the allowed set is those
 * names and nothing else.
 */
export function allowedScreenUrls(screensDir, names) {
  const dir = path.resolve(screensDir);
  return new Set(
    [...names]
      .filter((name) => SCREEN_NAME_RE.test(name))
      .map((name) => pathToFileURL(path.join(dir, `${name}.html`)).href),
  );
}

/**
 * Only the screen files of this attempt, and the pictures embedded in them.
 *
 * The address is parsed and then resolved through the filesystem before it is
 * compared, so a traversal, however it is spelled, and a symlink that points
 * out of the folder are both normalised into what they really are and then
 * fail the membership test. Everything else, the network, blob:, about: and
 * any other local file, is refused. A path that cannot be resolved at all (it
 * does not exist any more) is refused too: the fence never guesses.
 */
export function isAllowedRequest(url, allowed, realpath = fs.realpathSync) {
  if (typeof url !== 'string') return false;
  if (url.startsWith('data:')) return true;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'file:') return false;
  let real;
  try {
    real = realpath(fileURLToPath(parsed));
  } catch {
    return false;
  }
  return allowed.has(pathToFileURL(real).href);
}

/**
 * The screens named in the sizes file the caller wrote. A name or a size the
 * renderer cannot act on is never silently skipped: it is returned in
 * `invalid`, and the script refuses the whole file.
 */
export function selectScreens(sizes) {
  const screens = [];
  const invalid = [];
  for (const [name, size] of Object.entries(sizes ?? {})) {
    const usable = SCREEN_NAME_RE.test(name)
      && Array.isArray(size)
      && size.length === 2
      && size.every((value) => Number.isInteger(value) && value > 0);
    if (usable) screens.push([name, [size[0], size[1]]]);
    else invalid.push(name);
  }
  return { screens, invalid };
}

/**
 * How much bigger than its declared box a document may measure before it is
 * refused. A sub-pixel layout can round a full-bleed element up by one, and
 * one pixel of scroll never moved a screenshot anybody could see.
 */
export const OVERFLOW_TOLERANCE_PX = 1;

/** A measurement the browser could not give a usable number for is nothing. */
function usable(value) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * The document's real scrollable size, from the two boxes that can grow.
 *
 * `overflow: hidden` on body alone propagates to the viewport and leaves body
 * itself visible, so the root box obeys while body keeps growing; the reverse
 * happens when the root box is the one carrying the overflow. Whichever is
 * larger on an axis is the size the screenshot actually had to fit into.
 *
 * @returns {[number, number]} the measured width and height
 */
export function documentSize({ documentWidth, documentHeight, bodyWidth, bodyHeight }) {
  return [
    Math.max(usable(documentWidth), usable(bodyWidth)),
    Math.max(usable(documentHeight), usable(bodyHeight)),
  ];
}

/**
 * Whether a document of this size overflows the viewport the screen declared.
 *
 * This, and not the scroll offset, is the robust rule: in an RTL document the
 * initial scroll origin already sits at the start edge, so an offset of zero
 * proves nothing and a negative offset is normal. A document wider or taller
 * than its box means the shot was taken through a window onto a bigger page,
 * whichever corner that window happened to start at.
 *
 * @param {[number, number]} measured the document's width and height
 * @param {[number, number]} declared the size the screen declared in sizes.json
 * @param {number} [tolerance]
 */
export function overflowsDeclaredSize(measured, declared, tolerance = OVERFLOW_TOLERANCE_PX) {
  const [width, height] = measured;
  const [w, h] = declared;
  return width > w + tolerance || height > h + tolerance;
}
