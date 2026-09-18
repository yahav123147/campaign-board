import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { archivePreviousAssets, isolateAssetAttemptDirectory } from "@/orchestrator/runStage5Assets";
import { readReusableAssetHashes } from "@/orchestrator/assetQuality";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "council-assets-"));
});

describe("archivePreviousAssets", () => {
  it("clears the folder of the previous run's images", async () => {
    await fs.writeFile(path.join(dir, "presenter-hero.webp"), "x");
    await fs.writeFile(path.join(dir, "logo-ynet.webp"), "x");

    await archivePreviousAssets(dir, "2026-08-26T19-00-00");

    const left = (await fs.readdir(dir)).filter((f) => f.endsWith(".webp"));
    expect(left).toEqual([]);
  });

  it("keeps them, so nothing produced earlier is destroyed", async () => {
    await fs.writeFile(path.join(dir, "presenter-hero.webp"), "x");

    await archivePreviousAssets(dir, "2026-08-26T19-00-00");

    const archived = await fs.readdir(`${dir}-prev-2026-08-26T19-00-00`);
    expect(archived).toContain("presenter-hero.webp");
  });

  it("puts the archive OUTSIDE the working folder", async () => {
    // Left inside, the previous run's images are one copy away, and a clean
    // run quietly reuses them instead of producing anything.
    await fs.writeFile(path.join(dir, "presenter-hero.webp"), "x");

    await archivePreviousAssets(dir, "2026-08-26T19-00-00");

    const inside = await fs.readdir(dir);
    expect(inside).toEqual([]);
  });

  it("takes the old contact sheet with them", async () => {
    await fs.writeFile(path.join(dir, "contact-sheet-attempt-digest.html"), "<html></html>");

    await archivePreviousAssets(dir, "2026-08-26T19-00-00");

    expect(await fs.readdir(dir)).not.toContain("contact-sheet-attempt-digest.html");
  });

  it("archives the manifest and cutout receipts with the images", async () => {
    await fs.writeFile(path.join(dir, "portrait-cut.webp"), "image");
    await fs.writeFile(path.join(dir, "portrait-cut.webp.cutout.json"), "{}");
    await fs.writeFile(path.join(dir, "asset-plan.json"), "{}");
    await fs.writeFile(path.join(dir, "asset-manifest.json"), "{}");
    await fs.writeFile(path.join(dir, "asset-approval.json"), "{}");

    await archivePreviousAssets(dir, "2026-08-26T19-00-00");

    expect(await fs.readdir(dir)).toEqual([]);
    expect(await fs.readdir(`${dir}-prev-2026-08-26T19-00-00`)).toEqual([
      "asset-approval.json",
      "asset-manifest.json",
      "asset-plan.json",
      "portrait-cut.webp",
      "portrait-cut.webp.cutout.json",
    ]);
  });

  it("does nothing on a first run", async () => {
    await archivePreviousAssets(dir, "2026-08-26T19-00-00");
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it("keeps only byte-sealed reusable files and their receipts for feedback", async () => {
    const reusableBytes = Buffer.from("validated-image");
    const reusableHash = createHash("sha256").update(reusableBytes).digest("hex");
    await fs.writeFile(path.join(dir, "keep.webp"), reusableBytes);
    await fs.writeFile(path.join(dir, "keep.webp.cutout.json"), "{}");
    const manifest = `${JSON.stringify({
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      attemptId: "prior",
      ignoredFiles: [],
      assets: [
        {
          file: "keep.webp",
          kind: "photo",
          status: "approved",
          sha256: reusableHash,
          problems: [],
          previewable: true,
        },
      ],
    })}\n`;
    const manifestHash = createHash("sha256").update(manifest).digest("hex");
    await fs.writeFile(path.join(dir, "asset-manifest.json"), manifest);
    await fs.writeFile(path.join(dir, "asset-approval.json"), "{}");
    await fs.writeFile(path.join(dir, "ignored.webp"), "old-image");
    await fs.mkdir(path.join(dir, "nested"));
    await fs.writeFile(path.join(dir, "nested", "hidden.webp"), "old-nested-image");
    await fs.writeFile(path.join(dir, "contact-sheet-old.html"), "old sheet");

    await isolateAssetAttemptDirectory(
      dir,
      { "keep.webp": reusableHash },
      "feedback-attempt",
    );

    expect(await fs.readdir(dir)).toEqual([
      "asset-approval.json",
      "asset-manifest.json",
      "keep.webp",
      "keep.webp.cutout.json",
    ]);
    expect(await fs.readdir(`${dir}-prev-feedback-attempt`)).toEqual([
      "contact-sheet-old.html",
      "ignored.webp",
      "nested",
    ]);
    expect(await readReusableAssetHashes(dir, manifestHash)).toEqual({ "keep.webp": reusableHash });

    await isolateAssetAttemptDirectory(dir, { "keep.webp": reusableHash }, "retry-after-crash");
    expect(await readReusableAssetHashes(dir, manifestHash)).toEqual({ "keep.webp": reusableHash });
  });
});

import { shouldArchivePrevious } from "@/orchestrator/runStage5Assets";

describe("shouldArchivePrevious", () => {
  it("archives when a finished set is superseded by a fresh brand brief", () => {
    // No feedback means the chain reached 5.2 from an approved 5.1: a new brief,
    // so the previous set belongs to a different design and steps aside.
    expect(shouldArchivePrevious("approved", undefined)).toBe(true);
    expect(shouldArchivePrevious("awaiting-decision", undefined)).toBe(true);
  });

  it("keeps the files when the reviewer asked for a fix", () => {
    // Feedback means iterate. Re-downloading photos and logos that are already
    // right, to change six mockups, wastes a quarter of an hour every round.
    expect(shouldArchivePrevious("awaiting-decision", "תתקן את המוקאפים")).toBe(false);
    expect(shouldArchivePrevious("approved", "תתקן את המוקאפים")).toBe(false);
  });

  it("keeps the files when the previous attempt crashed", () => {
    expect(shouldArchivePrevious("error", undefined)).toBe(false);
  });

  it("has nothing to archive on a first run", () => {
    expect(shouldArchivePrevious("pending", undefined)).toBe(false);
    expect(shouldArchivePrevious(undefined, undefined)).toBe(false);
  });
});
