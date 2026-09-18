// Render the HTML device screens of one asset attempt into PNGs, inside a
// browser somebody else owns. This script only renders: it connects to an
// existing Chrome over CDP, opens one page per screen, screenshots it and
// disconnects. It never launches Chrome, never creates or deletes a profile,
// and never owns browser cleanup: the caller that started Chrome terminates it.
//
// The screens are untrusted static content. Two fences hold here, and the
// caller's static scan is a third: script execution is disabled for the page
// before anything is loaded, and every request the page makes is intercepted,
// with only the screen files of this attempt and data: URIs allowed. The
// allowed set is built from the names in the sizes file and resolved through
// the filesystem, so nothing else under the folder is loadable, not an
// undeclared file and not a planted symlink. The allow/abort decision itself
// lives in renderPolicy.mjs, where it is tested.
//
// The sizes file names the screens to render: the caller writes it, and it
// holds only the screens that passed its own boundaries, so nothing else in
// the screens directory is ever opened.
//
// A screen that fails costs only itself: its PNG is removed, the next screen
// is still rendered, and the exit code reports the first failure. The caller
// then rejects only the mockups whose screens are missing. Every line this
// script prints names the screen it belongs to, as "[<screen>] …", so the
// caller can hand each mockup its own reason instead of the whole batch.
//
// Anything worth knowing about a screen (a font wait that did not settle, and
// the size the document really measured) is written to
// <outDir>/render-notes.json as { "<screen>": ["…"] }: on a successful run
// nobody reads stderr, and a mockup with fallback typography, or one whose
// screen barely fitted its box, would otherwise look perfect.
//
// Exit codes:
//   0  every screen rendered
//   1  bad usage, or an unexpected failure
//   2  a screen tried to load a blocked address (printed with the address)
//   3  a screen did not finish rendering in time
//   4  a screen's document was bigger than the size it declared
//
// Usage: node render_screens.mjs <cdpEndpoint> <screensDir> <sizesJson> <outDir>
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import {
  allowedScreenUrls,
  documentSize,
  isAllowedRequest,
  overflowsDeclaredSize,
  selectScreens,
} from './renderPolicy.mjs';

const EXIT_USAGE = 1;
const EXIT_BLOCKED = 2;
const EXIT_TIMEOUT = 3;
const EXIT_OVERFLOW = 4;

/** One screen, browser already running. */
const SCREEN_TIMEOUT_MS = Number(process.env.CAMPAIGN_COUNCIL_SCREEN_TIMEOUT_MS) || 20_000;

const [endpoint, screensDirArg, sizesJson, outDir] = process.argv.slice(2);
if (!endpoint || !screensDirArg || !sizesJson || !outDir) {
  console.error('usage: render_screens.mjs <cdpEndpoint> <screensDir> <sizesJson> <outDir>');
  process.exit(EXIT_USAGE);
}

// Resolved through the filesystem once, here: everything below compares
// against the folder as it really is, so a symlinked screens directory cannot
// move the whole attempt somewhere else while every path still looks local.
let screensDir;
try {
  screensDir = fs.realpathSync(path.resolve(screensDirArg));
} catch (error) {
  console.error(`screens directory unreadable: ${error.message}`);
  process.exit(EXIT_USAGE);
}

let sizes;
try {
  sizes = JSON.parse(fs.readFileSync(sizesJson, 'utf8'));
} catch (error) {
  console.error(`sizes file unreadable: ${error.message}`);
  process.exit(EXIT_USAGE);
}
const { screens, invalid } = selectScreens(sizes);
if (invalid.length) {
  console.error(`sizes file names a screen the renderer cannot open: ${invalid.join(', ')}`);
  process.exit(EXIT_USAGE);
}
// The fence: exactly the screens of this attempt, and nothing else under the
// folder. An undeclared file, a planted symlink and a traversal are all simply
// not on the list.
const allowed = allowedScreenUrls(screensDir, screens.map(([name]) => name));

const browser = await chromium.connectOverCDP(endpoint);
/** Collected instead of exiting inside the loop: the browser is disconnected first. */
const failures = [];
/** Non-fatal, per screen, for the caller's receipt. */
const notes = {};
const note = (name, message) => {
  notes[name] = [...(notes[name] ?? []), message];
  console.error(`[${name}] ${message}`);
};
try {
  const ctx = browser.contexts()[0];
  if (!ctx) throw new Error('no browser context on this endpoint');

  for (const [name, [width, height]] of screens) {
    const file = path.join(screensDir, `${name}.html`);
    const out = path.join(outDir, `${name}.png`);
    const page = await ctx.newPage();
    let blocked;
    let overflow;
    try {
      const session = await ctx.newCDPSession(page);
      // Before anything is loaded: the screen is static content, and nothing
      // on it is allowed to run.
      await session.send('Emulation.setScriptExecutionDisabled', { value: true });
      await session.send('Network.enable');
      await session.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
      session.on('Fetch.requestPaused', (event) => {
        const url = event.request.url;
        let verdict;
        if (isAllowedRequest(url, allowed)) {
          verdict = session.send('Fetch.continueRequest', { requestId: event.requestId });
        } else {
          if (!blocked) blocked = url;
          verdict = session.send('Fetch.failRequest', {
            requestId: event.requestId,
            errorReason: 'BlockedByClient',
          });
        }
        // The session closes with the page; a request that outlives it is not
        // an error worth failing the render for.
        verdict.catch(() => {});
      });

      await page.setViewportSize({ width, height });
      await page.goto(pathToFileURL(file).href, {
        waitUntil: 'load',
        timeout: SCREEN_TIMEOUT_MS,
      });
      // Text that is still swapping fonts would be screenshotted mid-layout.
      // A failure here is not fatal, but it is never silent: the mockup would
      // carry fallback typography and nothing else would say why.
      await page.evaluate(() => document.fonts.ready).catch((error) => {
        note(name, `רונדר בלי להמתין לגופנים: ${error.message}`);
      });
      if (blocked) throw new Error('blocked');
      // A screen that renders perfectly well can still be bigger than the box
      // it declared, and then the shot is taken through a window onto a bigger
      // page. In an RTL document that window starts at the start edge, so the
      // content comes out pushed aside and clipped, and nothing about the
      // picture says so. The measurement is taken here, once the fonts have
      // settled and the layout is final, and it goes on the receipt either way.
      const measured = await page.evaluate(() => {
        window.scrollTo(0, 0);
        const root = document.documentElement;
        const body = document.body;
        return {
          documentWidth: root ? root.scrollWidth : 0,
          documentHeight: root ? root.scrollHeight : 0,
          bodyWidth: body ? body.scrollWidth : 0,
          bodyHeight: body ? body.scrollHeight : 0,
          scrollX: window.scrollX,
          scrollY: window.scrollY,
        };
      });
      const [docWidth, docHeight] = documentSize(measured);
      note(name, `גודל המסמך ${docWidth}x${docHeight}`);
      if (measured.scrollX !== 0 || measured.scrollY !== 0) {
        note(name, `המסמך אינו בראשית הגלילה (x=${measured.scrollX}, y=${measured.scrollY})`);
      }
      if (overflowsDeclaredSize([docWidth, docHeight], [width, height])) {
        overflow = `המסך גולש מעבר לגודל המוצהר (${docWidth}x${docHeight} במקום ${width}x${height})`;
        throw new Error(overflow);
      }
      await page.screenshot({ path: out, timeout: SCREEN_TIMEOUT_MS });
      // A request can be paused after the check above and before the shot, so
      // the answer is only complete once the picture is taken.
      if (blocked) throw new Error('blocked');
    } catch (error) {
      // The screen failed, so whatever it left behind is not a screen: the
      // caller must find it missing and reject the mockup that owns it.
      fs.rmSync(out, { force: true });
      failures.push(blocked
        ? { code: EXIT_BLOCKED, name, message: `ניסה לטעון כתובת חסומה: ${blocked}` }
        : overflow
          ? { code: EXIT_OVERFLOW, name, message: overflow }
          : /Timeout|timeout/.test(error.message)
            ? { code: EXIT_TIMEOUT, name, message: 'לא סיים להיטען בזמן' }
            : { code: EXIT_USAGE, name, message: `לא רונדר: ${error.message}` });
    } finally {
      await page.close().catch(() => {});
    }
  }
} catch (error) {
  failures.push({ code: EXIT_USAGE, message: error.message });
} finally {
  // The notes belong to the run, not to its outcome: a screen that rendered
  // with fallback fonts has to be reportable even when another screen failed.
  try {
    if (Object.keys(notes).length) {
      fs.writeFileSync(path.join(outDir, 'render-notes.json'), JSON.stringify(notes));
    }
  } catch {}
  // Disconnect only: the browser belongs to the caller, which terminates it.
  try {
    await browser.close();
  } catch {}
}

if (failures.length) {
  for (const failure of failures) {
    console.error(failure.name ? `[${failure.name}] ${failure.message}` : failure.message);
  }
  process.exit(failures[0].code);
}
console.log('rendered', screens.length, 'screens');
