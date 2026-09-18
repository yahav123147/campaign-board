// Real mobile screenshot of a public Instagram profile, taken inside a browser somebody else
// owns. This script only captures: it connects to an existing Chrome over CDP, uses that
// browser's default context (the one backed by the copied session), emulates an iPhone at the
// page level, validates that the requested profile actually rendered, screenshots it and
// disconnects.
//
// It never launches Chrome, never creates or deletes a profile directory, and never owns
// browser cleanup: the caller that started Chrome terminates it.
//
// A screenshot is evidence, so it is saved only after the page proved itself: the requested
// handle identifies the page as a whole username, the session is signed in, and a follower
// count is readable. Instagram answers a broken session or a removed profile with a normal 200
// page, so without this check an error screen is saved as "live proof". The page is classified
// exactly as it was served, before any overlay is cleared, because a signed-out page hides the
// profile behind a login dialog, and the login elements themselves count as much as the
// wording. Each refusal has its own exit code, so the caller can tell the cases apart:
//   1  bad usage, or an unexpected failure
//   2  the requested profile page is not available
//   3  a login wall, a redirect to the login page, or a signed-out session
//   4  the profile rendered without a readable follower count
//   5  a rate limit or a challenge page
//   6  the profile rendered but a pop-up covered the follower count
//
// A validated page is not yet a photographable page. Instagram covers a
// signed-in profile with sheets of its own ("לשמור את פרטי ההתחברות שלך?", the
// notifications prompt), and the count behind them stays perfectly readable in
// the DOM: a capture that reads the number and shoots anyway files a picture of
// a dialog as live proof. So the overlays are cleared and the count is proved
// visible before the shutter, and a page that stays covered is refused with an
// exit code of its own instead of producing a picture nobody can read.
//
// Usage: node ig_shot.mjs <cdpEndpoint> <handle> <out.png>
import fs from 'node:fs';
import { chromium, devices } from 'playwright';
import {
  DISMISS_LABELS,
  MAX_OVERLAY_PASSES,
  OBSTRUCTED_MESSAGE,
  clearOverlaysAndProve,
} from './igOverlay.mjs';

const EXIT_USAGE = 1;
const EXIT_MISSING_PAGE = 2;
const EXIT_LOGIN_WALL = 3;
const EXIT_NO_FOLLOWERS = 4;
const EXIT_RATE_LIMIT = 5;
const EXIT_OBSTRUCTED = 6;

const [endpoint, handle, out] = process.argv.slice(2);
if (!endpoint || !handle || !out) {
  console.error('usage: ig_shot.mjs <cdpEndpoint> <handle> <out.png>');
  process.exit(EXIT_USAGE);
}

/** The screens Instagram serves instead of a profile, in both languages it answers in. */
const MISSING_PAGE = [
  /מצטערים, דף זה אינו זמין/,
  /Sorry, this page isn['’]t available/i,
];
const RATE_LIMIT = [
  /Please wait a few minutes before you try again/i,
  /Try Again Later/i,
  /נסה שוב מאוחר יותר/,
  /המתן כמה דקות/,
  /confirm you['’]re human/i,
  /אשר שאתה אנושי/,
];
const CHALLENGE_URL = /\/(?:challenge|accounts\/suspended)/;
const LOGIN_URL = /\/accounts\/login/;
const LOGIN_HEADING = /^(?:התחבר|Log in)/i;
/**
 * A signed-out page offers to create an account. A session that is actually
 * logged in never renders these, so they settle the question on their own: the
 * logged-out profile page carries the handle in its title and the follower text
 * in its body, and would otherwise pass every other check.
 */
const SIGNED_OUT_CTA = [
  /\bSign up\b/i,
  /\bCreate new account\b/i,
  /הירשם/,
  /צור חשבון חדש/,
];
/**
 * The same offer inside the login overlay. Instagram renders that overlay as a
 * dialog above the profile, and its text is not part of document.body.innerText
 * in every layout, so a page whose body reads clean is still a signed-out page
 * when the dialog offers to open an account.
 *
 * Only the sign-up offer counts here, never a "log in" wording on its own: a
 * live session renders dialogs of its own ("התחבר לחשבון אחר", a session
 * notice), and refusing on those turns a signed-in profile into a false login
 * wall. A real login modal carries the login elements, which are read below.
 */
const SIGNED_OUT_DIALOG = SIGNED_OUT_CTA;
/**
 * Digits with an optional magnitude word, next to "followers" in either
 * language. Hebrew Instagram writes "12.3 אלף" rather than "12.3K" and injects
 * bidi marks (U+200E/U+200F) around the number, which \s does not cover.
 */
const FOLLOWERS = /(\d[\d.,]*)[\s‎‏]*(K|M|אלף|אלפים|מיליון)?[\s‎‏]*(?:עוקבים|followers)/i;
const MAGNITUDE = { 'אלף': 'K', 'אלפים': 'K', 'מיליון': 'M' };

/**
 * The handle identifies the proof, so it is matched as a whole username and
 * never as a substring: read loosely, the page of acme.studio.other answers a
 * request for acme.studio, and the screenshot is filed under the wrong account.
 * A username is made of letters, digits, dots and underscores, so a match only
 * counts where the next character is none of those.
 */
const HANDLE_CHAR = '[A-Za-z0-9._]';
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const quoted = escapeRe(handle);
/** "@handle" in the page text, ending where the handle ends. */
const HANDLE_MENTION = new RegExp(`@${quoted}(?!${HANDLE_CHAR})`, 'i');
/** The profile tab title, "name (@handle)": the closing bracket is the boundary. */
const HANDLE_TITLE = new RegExp(`(?:^${quoted}\\s*\\(@${quoted}\\)|\\(@${quoted}\\))`, 'i');
/** The profile URL a page declares for itself, in the canonical link or og:url. */
const PROFILE_URL = new RegExp(`^https?://(?:www\\.)?instagram\\.com/${quoted}/?(?:[?#]|$)`, 'i');

const device = devices['iPhone 14 Pro Max'];
const browser = await chromium.connectOverCDP(endpoint);
/** Set instead of exiting inside the try: the browser is disconnected first. */
let refusal;
let captured;
try {
  // The default context carries the copied cookies. A fresh browser context would be
  // incognito, with no session at all, and Instagram would show a logged-out wall.
  const ctx = browser.contexts()[0];
  if (!ctx) throw new Error('no default browser context on this endpoint');
  const p = ctx.pages()[0] || (await ctx.newPage());

  await p.setViewportSize({ width: 430, height: 932 });
  const session = await ctx.newCDPSession(p);
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: 430,
    height: 932,
    deviceScaleFactor: 3,
    mobile: true,
  });
  await session.send('Emulation.setUserAgentOverride', {
    userAgent: device.userAgent,
    acceptLanguage: 'he-IL',
  });
  await session.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });

  await p.goto(`https://www.instagram.com/${handle}/`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(5000);

  // Read the page exactly as it was served. The login modal is a role="dialog"
  // overlay, so deleting dialogs before classifying (which is what the capture
  // used to do) erases the very evidence that the session is signed out.
  const state = await p.evaluate(() => {
    const attr = (selector, name) => {
      const el = document.querySelector(selector);
      return (el && el.getAttribute(name)) || '';
    };
    return {
      text: (document.body && document.body.innerText) || '',
      title: document.title || '',
      url: location.href,
      headings: Array.from(document.querySelectorAll('h1,h2'))
        .map((h) => (h.innerText || '').trim())
        .filter(Boolean),
      // What the page says it is, independently of any wording on it.
      canonical: attr('link[rel="canonical"]', 'href'),
      ogUrl: attr('meta[property="og:url"]', 'content'),
      // The login elements themselves, not the words around them.
      loginForm: Boolean(document.querySelector('form[action*="login"]'))
        || Boolean(document.querySelector('input[name="username"]')
          && document.querySelector('input[name="password"]')),
      dialogText: Array.from(document.querySelectorAll('div[role="dialog"]'))
        .map((d) => (d.innerText || '').trim())
        .filter(Boolean)
        .join('\n'),
    };
  });

  // What the page declares itself to be settles the account on its own, and it
  // outranks any wording: the requested handle can appear in a bio or a partner
  // credit on a page that belongs to somebody else. A declared URL that is not
  // the requested profile is therefore a refusal, not a missing signal, and the
  // mention and the title only decide when the page declares nothing at all.
  const declaredUrls = [state.canonical, state.ogUrl].filter(Boolean);
  const wrongAccount = declaredUrls.some((url) => !PROFILE_URL.test(url));
  const hasProfileHeader = declaredUrls.length
    ? !wrongAccount
    : HANDLE_MENTION.test(state.text) || HANDLE_TITLE.test(state.title);
  const heading = state.headings[0] || '';
  const followers = state.text.match(FOLLOWERS);
  // A login form or a signed-out overlay settles the session on its own, even on
  // a page that carries the right handle and a follower count.
  const signedOut = SIGNED_OUT_CTA.some((re) => re.test(state.text))
    || state.loginForm
    || SIGNED_OUT_DIALOG.some((re) => re.test(state.dialogText));
  // The failure wordings are read only when the page is already doubtful. A real
  // profile may quote them in a bio or a caption, and a bio must not refuse a
  // profile that rendered with its own follower count.
  const doubtful = !hasProfileHeader || !followers;

  if (LOGIN_URL.test(state.url) || signedOut) {
    refusal = { code: EXIT_LOGIN_WALL, message: `אינסטגרם דורשת התחברות ולא הציגה את הפרופיל ${handle}` };
  } else if (CHALLENGE_URL.test(state.url)) {
    refusal = { code: EXIT_RATE_LIMIT, message: `אינסטגרם החזירה דף חסימה או אימות במקום הפרופיל ${handle}` };
  } else if (!hasProfileHeader && LOGIN_HEADING.test(heading)) {
    refusal = { code: EXIT_LOGIN_WALL, message: `אינסטגרם דורשת התחברות ולא הציגה את הפרופיל ${handle}` };
  } else if (doubtful && MISSING_PAGE.some((re) => re.test(state.text))) {
    refusal = { code: EXIT_MISSING_PAGE, message: `הדף של ${handle} אינו זמין באינסטגרם` };
  } else if (doubtful && RATE_LIMIT.some((re) => re.test(state.text))) {
    refusal = { code: EXIT_RATE_LIMIT, message: `אינסטגרם החזירה דף חסימה או אימות במקום הפרופיל ${handle}` };
  } else if (wrongAccount) {
    refusal = { code: EXIT_MISSING_PAGE, message: `הדף שייך לחשבון אחר ולא לפרופיל ${handle}` };
  } else if (!hasProfileHeader) {
    refusal = { code: EXIT_MISSING_PAGE, message: `הדף שנטען אינו הפרופיל ${handle}` };
  } else if (!followers) {
    refusal = { code: EXIT_NO_FOLLOWERS, message: `לא נמצא מספר עוקבים בדף של ${handle}` };
  } else {
    const magnitude = followers[2] || '';
    // Only now, with the page classified, are the overlays cleared for the
    // shot, and only a count that is demonstrably the topmost thing at the
    // centre of its own box, inside the viewport, is photographed.
    const cleared = await p.evaluate(clearOverlaysAndProve, {
      labels: DISMISS_LABELS,
      maxPasses: MAX_OVERLAY_PASSES,
      countPattern: { source: FOLLOWERS.source, flags: FOLLOWERS.flags },
    });
    await p.waitForTimeout(800);
    if (!cleared.visible) {
      refusal = { code: EXIT_OBSTRUCTED, message: OBSTRUCTED_MESSAGE };
    } else {
      captured = {
        handle,
        followers: `${followers[1]}${MAGNITUDE[magnitude] || magnitude.toUpperCase()}`,
        followersRaw: followers[0].trim(),
        // How many sheets stood between the capture and the profile. The
        // acceptance reads it here: a proof taken over a cleared pop-up and one
        // taken over an empty page are not the same evidence.
        obstructionCleared: cleared.dismissed,
        capturedAt: new Date().toISOString(),
      };
      await p.screenshot({ path: out });
      // The sidecar, next to the image: the caller reads the validated count
      // from here instead of parsing a console line.
      fs.writeFileSync(`${out}.json`, JSON.stringify(captured, null, 2));
    }
  }
} finally {
  // Disconnect only: the browser belongs to the caller, which terminates it.
  try {
    await browser.close();
  } catch {}
}

if (refusal) {
  console.error(refusal.message);
  process.exit(refusal.code);
}
console.log('saved', out, 'followers:', captured.followers);
