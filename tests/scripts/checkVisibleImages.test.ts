import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { htmlPage, startProbeFixtureServer } from "./probeFixtureServer";

const execFileAsync = promisify(execFile);
const SCRIPT = path.join(process.cwd(), "scripts/check-visible-images.mjs");
const IMG = 'width="300" height="200"';

type Probe = Record<"390" | "1280", Array<{ kind: string; url: string; loaded: boolean; visible: boolean }>>;

const pages = {
  "p-visible": { html: htmlPage(`<img src="/p-visible/hero.png" ${IMG}>`), images: ["hero.png"] },
  "p-display-none": { html: htmlPage(`<img style="display:none" src="/p-display-none/hero.png" ${IMG}>`), images: ["hero.png"] },
  "p-mobile-hidden": {
    html: htmlPage(`<img class="d" src="/p-mobile-hidden/hero.png" ${IMG}>`, "<style>@media (max-width:600px){.d{display:none}}</style>"),
    images: ["hero.png"],
  },
  "p-parent-opacity": { html: htmlPage(`<div style="opacity:0"><img src="/p-parent-opacity/hero.png" ${IMG}></div>`), images: ["hero.png"] },
  "p-broken": { html: htmlPage(`<img src="/p-broken/missing.png" ${IMG}>`), images: [] },
  "p-srcset": {
    html: htmlPage(`<img src="/p-srcset/a.png" srcset="/p-srcset/a.png 1x, /p-srcset/b.png 2x" ${IMG}>`),
    images: ["a.png", "b.png"],
  },
  "p-lazy": {
    html: htmlPage(`<div style="height:4000px"></div><img loading="lazy" src="/p-lazy/hero.png" ${IMG}>`),
    images: ["hero.png"],
  },
  "p-background": {
    html: htmlPage(`<div style="width:300px;height:200px;background-image:url('/p-background/bg.png')"></div>`),
    images: ["bg.png"],
  },
  "p-collapsed-parent": {
    html: htmlPage(`<div style="height:0;overflow:hidden"><img src="/p-collapsed-parent/hero.png" ${IMG}></div>`),
    images: ["hero.png"],
  },
  "p-thin-strip": {
    html: htmlPage(`<div style="height:10px;overflow:hidden"><img src="/p-thin-strip/hero.png" ${IMG}></div>`),
    images: ["hero.png"],
  },
  "p-small-slice": {
    html: htmlPage(`<div style="height:40px;overflow:hidden"><img src="/p-small-slice/hero.png" ${IMG}></div>`),
    images: ["hero.png"],
  },
  "p-clip-hidden": {
    html: htmlPage(`<div style="clip-path:inset(100%)"><img src="/p-clip-hidden/hero.png" ${IMG}></div>`),
    images: ["hero.png"],
  },
  "p-clip-rounded": {
    html: htmlPage(`<div style="clip-path:inset(0 round 12px)"><img style="pointer-events:none" src="/p-clip-rounded/hero.png" ${IMG}></div>`),
    images: ["hero.png"],
  },
  "p-clip-tiny": {
    html: htmlPage(`<img style="clip-path:polygon(0 0, 5% 0, 0 5%)" src="/p-clip-tiny/hero.png" ${IMG}>`),
    images: ["hero.png"],
  },
  "p-clip-tall": {
    html: htmlPage(`<img style="display:block;clip-path:inset(0 round 8px)" src="/p-clip-tall/hero.png" width="300" height="2400">`),
    images: ["hero.png"],
  },
  "p-details-closed": {
    html: htmlPage(`<details><summary>שאלה</summary><img src="/p-details-closed/hero.png" ${IMG}></details>`),
    images: ["hero.png"],
  },
  "p-hidden-until-found": {
    html: htmlPage(`<div hidden="until-found"><img src="/p-hidden-until-found/hero.png" ${IMG}></div>`),
    images: ["hero.png"],
  },
  "p-content-visibility-hidden": {
    html: htmlPage(`<div style="content-visibility:hidden"><img src="/p-content-visibility-hidden/hero.png" ${IMG}></div>`),
    images: ["hero.png"],
  },
  "p-smooth-scroll": {
    html: htmlPage(
      `<img style="display:block;clip-path:inset(0 round 8px)" src="/p-smooth-scroll/tall.png" width="300" height="2400">` +
        `<div style="height:4000px"></div><img loading="lazy" src="/p-smooth-scroll/lazy.png" ${IMG}>`,
      "<style>html{scroll-behavior:smooth}</style>",
    ),
    images: ["tall.png", "lazy.png"],
  },
  "p-reveal-toggle": {
    html: htmlPage(
      `<div style="height:1400px"></div><div class="reveal"><img src="/p-reveal-toggle/first.png" ${IMG}></div>` +
        `<div style="height:2600px"></div><div class="reveal"><img src="/p-reveal-toggle/second.png" ${IMG}></div>` +
        `<div style="height:2600px"></div>` +
        `<script>const io=new IntersectionObserver((entries)=>{for(const e of entries)e.target.classList.toggle("in",e.isIntersecting)});` +
        `document.querySelectorAll(".reveal").forEach((el)=>io.observe(el));</script>`,
      "<style>.reveal{opacity:0;transition:opacity .2s}.reveal.in{opacity:1}</style>",
    ),
    images: ["first.png", "second.png"],
  },
  "p-reveal-delayed": {
    html: htmlPage(
      `<div style="height:5200px"></div><div class="late"><img src="/p-reveal-delayed/late.png" ${IMG}></div>` +
        `<script>const io=new IntersectionObserver((entries)=>{for(const e of entries)e.target.classList.toggle("in",e.isIntersecting)});` +
        `document.querySelectorAll(".late").forEach((el)=>io.observe(el));</script>`,
      "<style>.late{opacity:0;transition:opacity .3s ease 0s}.late.in{opacity:1;transition-delay:.9s}</style>",
    ),
    images: ["late.png"],
  },
};

let server: Awaited<ReturnType<typeof startProbeFixtureServer>>;

beforeAll(async () => {
  server = await startProbeFixtureServer(pages);
});
afterAll(async () => {
  await server.close();
});

async function probe(page: string): Promise<Probe> {
  const { stdout } = await execFileAsync(process.execPath, [SCRIPT, `${server.origin}/${page}`], { timeout: 120_000 });
  return JSON.parse(stdout) as Probe;
}

function shown(result: Probe, width: "390" | "1280", pathname: string): boolean {
  return result[width].some((item) => new URL(item.url).pathname === pathname && item.loaded && item.visible);
}

describe("check-visible-images.mjs", { timeout: 180_000 }, () => {
  it("reports a plainly visible image at both widths", async () => {
    const result = await probe("p-visible");
    expect(shown(result, "390", "/p-visible/hero.png")).toBe(true);
    expect(shown(result, "1280", "/p-visible/hero.png")).toBe(true);
  });

  it("does not count display:none, a mobile-only hide or a transparent parent", async () => {
    const none = await probe("p-display-none");
    expect(shown(none, "390", "/p-display-none/hero.png") || shown(none, "1280", "/p-display-none/hero.png")).toBe(false);

    const mobile = await probe("p-mobile-hidden");
    expect(shown(mobile, "390", "/p-mobile-hidden/hero.png")).toBe(false);
    expect(shown(mobile, "1280", "/p-mobile-hidden/hero.png")).toBe(true);

    const faded = await probe("p-parent-opacity");
    expect(shown(faded, "1280", "/p-parent-opacity/hero.png")).toBe(false);
  });

  it("does not count an image that failed to load", async () => {
    const result = await probe("p-broken");
    expect(shown(result, "1280", "/p-broken/missing.png")).toBe(false);
  });

  it("reports only the srcset candidate the browser actually chose", async () => {
    const result = await probe("p-srcset");
    const paths = result["1280"].map((item) => new URL(item.url).pathname);
    expect(paths).toContain("/p-srcset/a.png");
    expect(paths).not.toContain("/p-srcset/b.png");
  });

  it("counts a lazy image once scrolling loads it", async () => {
    const result = await probe("p-lazy");
    expect(shown(result, "390", "/p-lazy/hero.png")).toBe(true);
  });

  it("counts a visible CSS background image", async () => {
    const result = await probe("p-background");
    expect(result["1280"].find((item) => new URL(item.url).pathname === "/p-background/bg.png")).toMatchObject({
      kind: "background",
      loaded: true,
      visible: true,
    });
  });

  it("does not count an image clipped away by a collapsed parent, a thin strip or a small slice", async () => {
    for (const page of ["p-collapsed-parent", "p-thin-strip", "p-small-slice"]) {
      const result = await probe(page);
      expect(shown(result, "390", `/${page}/hero.png`), page).toBe(false);
      expect(shown(result, "1280", `/${page}/hero.png`), page).toBe(false);
    }
  });

  it("measures clip-path by hit-testing instead of trusting the parent rectangle", async () => {
    const hidden = await probe("p-clip-hidden");
    expect(shown(hidden, "390", "/p-clip-hidden/hero.png") || shown(hidden, "1280", "/p-clip-hidden/hero.png")).toBe(false);

    const rounded = await probe("p-clip-rounded");
    expect(shown(rounded, "390", "/p-clip-rounded/hero.png")).toBe(true);
    expect(shown(rounded, "1280", "/p-clip-rounded/hero.png")).toBe(true);

    const tiny = await probe("p-clip-tiny");
    expect(shown(tiny, "1280", "/p-clip-tiny/hero.png")).toBe(false);

    const tall = await probe("p-clip-tall");
    expect(shown(tall, "390", "/p-clip-tall/hero.png")).toBe(true);
  });

  it("does not count an image inside closed details, hidden-until-found or content-visibility:hidden", async () => {
    for (const page of ["p-details-closed", "p-hidden-until-found", "p-content-visibility-hidden"]) {
      const result = await probe(page);
      expect(shown(result, "390", `/${page}/hero.png`), page).toBe(false);
      expect(shown(result, "1280", `/${page}/hero.png`), page).toBe(false);
    }
  });

  it("scrolls and hit-tests instantly even when the page sets scroll-behavior:smooth", async () => {
    const result = await probe("p-smooth-scroll");
    expect(shown(result, "390", "/p-smooth-scroll/tall.png")).toBe(true);
    expect(shown(result, "390", "/p-smooth-scroll/lazy.png")).toBe(true);
  });

  it("measures each image while it is in view, so a reveal that hides again off-screen still counts", async () => {
    const result = await probe("p-reveal-toggle");
    for (const width of ["390", "1280"] as const) {
      expect(shown(result, width, "/p-reveal-toggle/first.png"), `first ${width}`).toBe(true);
      expect(shown(result, width, "/p-reveal-toggle/second.png"), `second ${width}`).toBe(true);
    }
  });

  it("waits for a delayed reveal near the bottom before measuring it", async () => {
    const result = await probe("p-reveal-delayed");
    expect(shown(result, "390", "/p-reveal-delayed/late.png")).toBe(true);
    expect(shown(result, "1280", "/p-reveal-delayed/late.png")).toBe(true);
  });

  it("still does not count a permanently transparent parent at either width", async () => {
    const faded = await probe("p-parent-opacity");
    expect(shown(faded, "390", "/p-parent-opacity/hero.png")).toBe(false);
    expect(shown(faded, "1280", "/p-parent-opacity/hero.png")).toBe(false);
  });
});
