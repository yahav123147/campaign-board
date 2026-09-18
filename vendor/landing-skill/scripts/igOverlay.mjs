// What stands between the capture and the profile, and how the capture proves
// the follower count was really visible when the picture was taken.
//
// This is the page half of ig_shot.mjs, kept in a module of its own for the
// same reason as the renderer's policy module: the rules can be stated as a
// table against a plain fake DOM in a test, instead of being reachable only
// through a live Instagram page.
//
// Instagram covers a signed-in profile with sheets of its own: "לשמור את פרטי
// ההתחברות שלך?" and the notifications prompt both sit over the profile header
// while the count behind them stays perfectly readable in the DOM. A capture
// that reads the number off the DOM and shoots the page anyway files a picture
// of a dialog as live proof, which is exactly what run 2026-09-16 filed.

/** The buttons those sheets answer to, in both languages Instagram serves. */
export const DISMISS_LABELS = ['לא עכשיו', 'Not now', 'Not Now'];

/**
 * How many times the topmost element over the count may be removed before the
 * page is given up on. Bounded on purpose: a sheet that re-renders itself must
 * cost a refusal, never a loop.
 */
export const MAX_OVERLAY_PASSES = 4;

/** What the caller says when the count could not be uncovered. */
export const OBSTRUCTED_MESSAGE = 'הפרופיל מוסתר על ידי חלון קופץ ולא צולם';

/**
 * Clear what covers the profile, then prove the count is visible.
 *
 * It runs inside the page: Playwright serializes it by source and rebuilds it
 * there, so it may not close over anything in this module and everything it
 * needs arrives in `options`. The document and the window are the page's own
 * globals in the browser, and injected fakes in a test.
 *
 * Returns `{ dismissed, visible, reason }`. `visible` is true only when the
 * element carrying the count is the topmost thing at the centre of its own box
 * and that box lies inside the viewport. Anything else is a refusal: a proof
 * nobody can read off the picture is not a proof.
 */
export function clearOverlaysAndProve(options) {
  const doc = (options && options.doc) || document;
  const win = (options && options.win) || window;
  const labels = (options && options.labels) || [];
  const passes = (options && options.maxPasses) || 1;
  const pattern = new RegExp(options.countPattern.source, options.countPattern.flags);
  let dismissed = 0;

  const all = (selector) => {
    try {
      return Array.prototype.slice.call(doc.querySelectorAll(selector) || []);
    } catch {
      return [];
    }
  };
  const textOf = (el) => String((el && (el.innerText || el.textContent)) || '');
  const drop = (el) => {
    if (!el || typeof el.remove !== 'function') return false;
    el.remove();
    return true;
  };

  // The overlays the classification already read as part of the page: the
  // login dialog and the presentation layer it sits in. They are removed only
  // here, after the page was classified, never before it.
  for (const node of all('div[role="dialog"],div[role="presentation"]')) {
    if (drop(node)) dismissed += 1;
  }
  if (doc.body && doc.body.style) doc.body.style.overflow = 'auto';

  // The sheets that answer to a button rather than to removal. Clicking is
  // what Instagram itself expects, and it takes the whole sheet away.
  for (const node of all('button,div[role="button"],a[role="button"]')) {
    if (labels.indexOf(textOf(node).trim()) === -1) continue;
    if (typeof node.click !== 'function') continue;
    node.click();
    dismissed += 1;
  }

  const countElement = () => {
    let best = null;
    for (const el of all('span,a,li,div')) {
      const text = textOf(el);
      if (!pattern.test(text)) continue;
      if (!best || text.length < textOf(best).length) best = el;
    }
    return best;
  };
  const positionOf = (el) => {
    try {
      return (win.getComputedStyle(el) || {}).position;
    } catch {
      return undefined;
    }
  };
  // The outermost positioned ancestor, not the innermost: a sheet is a fixed
  // container full of static children, and removing the child the pointer
  // happened to hit leaves the sheet itself over the profile.
  const offender = (el) => {
    let node = el;
    let chosen = null;
    while (node && node !== doc.body && node !== doc.documentElement) {
      const position = positionOf(node);
      if (position === 'fixed' || position === 'absolute') chosen = node;
      node = node.parentElement;
    }
    return chosen;
  };

  for (let pass = 0; pass < passes; pass += 1) {
    const count = countElement();
    if (!count) return { dismissed, visible: false, reason: 'no-count' };
    const rect = count.getBoundingClientRect();
    const inViewport = rect.width > 0
      && rect.height > 0
      && rect.top >= 0
      && rect.left >= 0
      && rect.bottom <= win.innerHeight
      && rect.right <= win.innerWidth;
    if (!inViewport) return { dismissed, visible: false, reason: 'out-of-view' };
    const top = typeof doc.elementFromPoint === 'function'
      ? doc.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
      : null;
    const uncovered = Boolean(top) && (
      top === count
      || (typeof count.contains === 'function' && count.contains(top))
      || (typeof top.contains === 'function' && top.contains(count))
    );
    if (uncovered) return { dismissed, visible: true, reason: '' };
    if (!drop(offender(top))) return { dismissed, visible: false, reason: 'covered' };
    dismissed += 1;
  }
  return { dismissed, visible: false, reason: 'covered' };
}
