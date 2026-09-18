import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { htmlPage, startProbeFixtureServer } from "./probeFixtureServer";

const execFileAsync = promisify(execFile);
const SCRIPT = path.join(process.cwd(), "scripts/measure-text-deserts.mjs");
const TEXT = `<p style="font-size:16px;line-height:1.7">${"מילים ".repeat(1_500)}</p>`;

const pages = {
  "d-gradient-body": {
    html: htmlPage(TEXT, "<style>body{background:linear-gradient(#000,#222)}</style>"),
    images: [],
  },
  "d-tall-background": {
    html: htmlPage(`<section style="background-image:url('/d-tall-background/bg.png')">${TEXT}</section>`),
    images: ["bg.png"],
  },
  "d-local-images": {
    html: htmlPage([0, 1, 2, 3, 4, 5].map((i) => `<p>${"מילים ".repeat(250)}</p><img src="/d-local-images/i${i}.png" width="300" height="200">`).join("")),
    images: [0, 1, 2, 3, 4, 5].map((i) => `i${i}.png`),
  },
  "d-gradient-link-cta": {
    html: htmlPage(
      [0, 1, 2, 3, 4, 5]
        .map(
          (i) =>
            `<p>${"מילים ".repeat(250)}</p><a href="#" style="display:block;width:300px;height:56px;background-color:transparent;background-image:linear-gradient(135deg,#e8849a,#fdc0c7);border-radius:8px;">קבע פגישה ${i}</a>`,
        )
        .join(""),
    ),
    images: [],
  },
  "d-smooth-scroll-lazy": {
    html: htmlPage(
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
        .map(
          (i) =>
            `<p style="font-size:16px;line-height:1.7">${"מילים ".repeat(510)}</p><img src="/d-smooth-scroll-lazy/i${i}.png" width="300" height="200" loading="lazy">`,
        )
        .join(""),
      "<style>html{scroll-behavior:smooth}</style>",
    ),
    images: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => `i${i}.png`),
  },
};

let server: Awaited<ReturnType<typeof startProbeFixtureServer>>;
beforeAll(async () => { server = await startProbeFixtureServer(pages); });
afterAll(async () => { await server.close(); });

async function measure(page: string) {
  const { stdout } = await execFileAsync(process.execPath, [SCRIPT, `${server.origin}/${page}`], { timeout: 120_000 });
  return JSON.parse(stdout) as { pageScreens: number; worstScreens: number; atScreen: number };
}

describe("measure-text-deserts.mjs", { timeout: 180_000 }, () => {
  it("does not treat a gradient on body as an anchor", async () => {
    const result = await measure("d-gradient-body");
    expect(result.pageScreens).toBeGreaterThan(3);
    expect(result.worstScreens).toBeCloseTo(result.pageScreens, 1);
  });

  it("does not treat a url() background on a section taller than 1.5 screens as an anchor", async () => {
    const result = await measure("d-tall-background");
    expect(result.worstScreens).toBeCloseTo(result.pageScreens, 1);
  });

  it("counts loaded local images as anchors", async () => {
    const result = await measure("d-local-images");
    expect(result.worstScreens).toBeLessThan(result.pageScreens / 2);
  });

  it("counts a gold gradient CTA link with a transparent backgroundColor as an anchor", async () => {
    const result = await measure("d-gradient-link-cta");
    expect(result.worstScreens).toBeLessThan(result.pageScreens / 2);
  });

  it("still loads lazy images below the fold when the page uses scroll-behavior: smooth", async () => {
    const result = await measure("d-smooth-scroll-lazy");
    expect(result.worstScreens).toBeLessThan(result.pageScreens / 2);
  });
});
