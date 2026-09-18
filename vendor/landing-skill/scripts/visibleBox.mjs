// What a reader actually sees of an image, and how far it sits off centre.
//
// The mobile centring check used to measure the image's own rectangle. A
// deliberately cropped image is wider than the frame that clips it, and it is
// anchored to one edge so the crop falls on the other, so its own rectangle is
// never centred even when the visible frame is. That reported a centred figure
// as off centre at every mobile width (17.09.2026). What the eye judges is the
// part that survives the clipping, so that is what gets measured.

/** How far from the viewport centre a figure may sit before it reads as crooked. */
export const CENTRE_TOLERANCE_PX = 6;

/** A rectangle is nothing unless it has a real position and a real width. */
function usable(rect) {
  return Boolean(rect)
    && Number.isFinite(rect.left)
    && Number.isFinite(rect.right)
    && rect.right > rect.left;
}

/**
 * The horizontal overlap of two rectangles, or nothing when they do not meet.
 *
 * @param {{left: number, right: number}} [a]
 * @param {{left: number, right: number}} [b]
 * @returns {{left: number, right: number}|undefined}
 */
export function intersectHorizontally(a, b) {
  if (!usable(a) || !usable(b)) return undefined;
  const left = Math.max(a.left, b.left);
  const right = Math.min(a.right, b.right);
  return right > left ? { left, right } : undefined;
}

/**
 * The part of an image its clipping frames leave visible.
 *
 * @param {{left: number, right: number}} [rect] the image's own rectangle.
 * @param {Array<{left: number, right: number}>} [clips]
 *   the rectangles of every ancestor that clips its overflow, outermost or
 *   innermost, order does not matter.
 */
export function visibleRect(rect, clips) {
  if (!usable(rect)) return undefined;
  let visible = { left: rect.left, right: rect.right };
  for (const clip of Array.isArray(clips) ? clips : []) {
    const next = intersectHorizontally(visible, clip);
    if (!next) return undefined;
    visible = next;
  }
  return visible;
}

/**
 * How far the visible part of an image sits from the centre of the viewport,
 * rounded to whole pixels. `undefined` when there is nothing to measure.
 */
export function visibleCentreOffset(rect, clips, viewportWidth) {
  const visible = visibleRect(rect, clips);
  if (!visible || !Number.isFinite(viewportWidth) || viewportWidth <= 0) return undefined;
  return Math.round((visible.left + visible.right) / 2 - viewportWidth / 2);
}

/** Whether the visible part of an image reads as off centre. */
export function isOffCentre(rect, clips, viewportWidth) {
  const offset = visibleCentreOffset(rect, clips, viewportWidth);
  return offset !== undefined && Math.abs(offset) > CENTRE_TOLERANCE_PX;
}

/**
 * Whether a zero-height image is a broken image or simply one the layout has
 * put away. A responsive page ships the same picture twice, once for narrow
 * screens and once for wide, and hides the other with `display:none`, so at
 * every width exactly one of them measures zero. That is the layout working,
 * not a picture that failed to render, and counting it failed a healthy page
 * at all six widths (17.09.2026). Only an image the layout actually placed
 * can be broken.
 *
 * @param {{height: number, laidOut: boolean}} [measurement]
 *   `laidOut` is false for an image no ancestor renders: in the browser that
 *   is `offsetParent === null`, which is exactly how the orphan check decides
 *   whether an element is on the page at all.
 */
export function isBrokenZeroHeight(measurement) {
  return Boolean(measurement)
    && measurement.laidOut === true
    && measurement.height === 0;
}
