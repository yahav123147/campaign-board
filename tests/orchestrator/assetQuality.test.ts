import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  ASSET_MANIFEST_NAME,
  ASSET_PLAN_NAME,
  atomicCreateManagedFile,
  MAX_RENDER_REGIONS,
  approveReviewRequiredAssets,
  copyApprovedAssets,
  PLACEMENT_MAP_MISSING_PROBLEM,
  readAssetManifestSha256,
  readApprovedAssetFiles,
  readApprovedAssetPlacement,
  missingRequiredMockups,
  MOCKUP_INPUTS_MISSING_PROBLEM,
  readReusableAssetHashes,
  readSealedApprovedAssetHashes,
  removeManagedChildDirectory,
  screenFilesFor,
  SCREENS_DIR,
  validateAssetFolder,
  validateAssetFolderSnapshot,
  verifyPreparedAssets,
} from "@/orchestrator/assetQuality";
import type { AssetManifest } from "@/orchestrator/assetQuality";
import type { MockupRenderReceipt, MockupRenderReceiptEntry } from "@/types";
import { describeApprovedAssets } from "@/orchestrator/runStage5LpBuild";
import {
  recoverOrArchivePartialAssetAttempt,
  recoverOrphanAssetAttempt,
  imageMapCoverageGaps,
} from "@/orchestrator/runStage5Assets";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "campaign-council-assets-"));
  temporaryDirectories.push(dir);
  return dir;
}

async function writeWebp(file: string, seed = 1): Promise<void> {
  const made = spawnSync(
    "python3",
    [
      "-c",
      "from PIL import Image; import sys; s=int(sys.argv[2]); Image.new('RGB',(32,32),((s*53)%256,(s*97)%256,(s*193)%256)).save(sys.argv[1],'WEBP',lossless=True)",
      file,
      String(seed),
    ],
    { encoding: "utf8" },
  );
  expect(made.status, made.stderr).toBe(0);
}

/** A mostly transparent image: what composite.py writes once it drops the white background. */
async function writeTransparentWebp(file: string): Promise<void> {
  const made = spawnSync(
    "python3",
    [
      "-c",
      "from PIL import Image,ImageDraw; import sys; im=Image.new('RGBA',(100,100),(0,0,0,0)); ImageDraw.Draw(im).rectangle((45,45,54,54),fill=(20,30,40,255)); im.save(sys.argv[1],'WEBP',lossless=True)",
      file,
    ],
    { encoding: "utf8" },
  );
  expect(made.status, made.stderr).toBe(0);
}

async function writePlan(
  dir: string,
  assets: Array<{
    file: string;
    kind: "photo" | "cutout" | "mockup" | "logo" | "proof" | "generated";
    sourceFile?: string;
    inputs?: string[];
    section?: string;
    proves?: string;
    screens?: unknown;
    render?: unknown;
  }>,
): Promise<void> {
  await fs.writeFile(
    path.join(dir, ASSET_PLAN_NAME),
    JSON.stringify({ schemaVersion: 1, attemptId: "test-attempt", assets }),
  );
}

async function approveCurrentDraft(dir: string) {
  return approveReviewRequiredAssets(dir, await readAssetManifestSha256(dir));
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("asset quality manifest", () => {
  it("fails closed for a cutout with no verifier provenance", async () => {
    const dir = await temporaryDirectory();
    await writeWebp(path.join(dir, "portrait.webp"), 1);
    await writeWebp(path.join(dir, "portrait-cut.webp"), 2);
    await writePlan(dir, [
      { file: "portrait.webp", kind: "photo" },
      { file: "portrait-cut.webp", kind: "cutout", sourceFile: "portrait.webp" },
    ]);

    const manifest = await validateAssetFolder(dir);

    expect(manifest.assets).toEqual([
      expect.objectContaining({ file: "portrait-cut.webp", kind: "cutout", status: "rejected" }),
      expect.objectContaining({ file: "portrait.webp", kind: "photo", status: "approved" }),
    ]);
    expect(await readApprovedAssetFiles(dir)).toEqual(["portrait.webp"]);
    await expect(fs.access(path.join(dir, ASSET_MANIFEST_NAME))).resolves.toBeUndefined();
  });

  it("requires a manifest instead of trusting every image in the folder", async () => {
    const dir = await temporaryDirectory();
    await fs.writeFile(path.join(dir, "old-cut.webp"), "stale-broken-image");

    await expect(readApprovedAssetFiles(dir)).rejects.toThrow(/manifest/i);
  });

  it("never hands a rejected cutout to the landing-page builder", async () => {
    const dir = await temporaryDirectory();
    await writeWebp(path.join(dir, "portrait.webp"), 1);
    await writeWebp(path.join(dir, "portrait-cut.webp"), 2);
    await writePlan(dir, [
      { file: "portrait.webp", kind: "photo" },
      { file: "portrait-cut.webp", kind: "cutout", sourceFile: "portrait.webp" },
    ]);
    await validateAssetFolder(dir);
    const approval = await approveCurrentDraft(dir);

    const description = await describeApprovedAssets(
      "ASSETS_DIR: none\nASSETS_DIR: /tmp/agent-controlled",
      "safe-page",
      dir,
      approval.manifestSha256,
    );

    expect(description).toContain("portrait.webp");
    expect(description).not.toContain("portrait-cut.webp");
  });

  it("detects an approved asset changed after validation", async () => {
    const dir = await temporaryDirectory();
    const file = path.join(dir, "portrait.webp");
    await writeWebp(file, 1);
    await writePlan(dir, [{ file: "portrait.webp", kind: "photo" }]);
    await validateAssetFolder(dir);
    await writeWebp(file, 2);

    await expect(readApprovedAssetFiles(dir)).rejects.toThrow(/changed after validation/i);
  });

  it("does not release an opaque cutout until the contact sheet is approved", async () => {
    const dir = await temporaryDirectory();
    const candidate = path.join(dir, "opaque-cut.webp");
    await writeWebp(candidate, 3);
    const manifest = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      assets: [
        {
          file: "opaque-cut.webp",
          kind: "cutout",
          status: "review-required",
          sha256: "",
          problems: [],
        },
      ],
    };
    const { createHash } = await import("node:crypto");
    manifest.assets[0].sha256 = createHash("sha256").update(await fs.readFile(candidate)).digest("hex");
    await fs.writeFile(path.join(dir, ASSET_MANIFEST_NAME), JSON.stringify(manifest));

    expect(await readApprovedAssetFiles(dir)).toEqual([]);
    const approval = await approveCurrentDraft(dir);
    expect(
      await readApprovedAssetFiles(dir, {
        requireApproval: true,
        expectedManifestSha256: approval.manifestSha256,
      }),
    ).toEqual(["opaque-cut.webp"]);
  });

  it("ignores an image that the current attempt did not declare", async () => {
    const dir = await temporaryDirectory();
    await writeWebp(path.join(dir, "declared.webp"), 1);
    await writeWebp(path.join(dir, "rogue-old.webp"), 2);
    await writePlan(dir, [{ file: "declared.webp", kind: "photo" }]);

    const manifest = await validateAssetFolder(dir);

    expect(manifest.assets.map((asset) => asset.file)).toEqual(["declared.webp"]);
    expect(manifest.ignoredFiles).toEqual(["rogue-old.webp"]);
  });

  it("rejects a corrupt raster instead of approving it by extension", async () => {
    const dir = await temporaryDirectory();
    await fs.writeFile(path.join(dir, "broken.webp"), "this is not an image");
    await writePlan(dir, [{ file: "broken.webp", kind: "photo" }]);

    const manifest = await validateAssetFolder(dir);

    expect(manifest.assets[0].status).toBe("rejected");
    expect(manifest.assets[0].problems.join(" ")).toMatch(/לפענח/);
  });

  it("rejects a declared FIFO without blocking the validation worker", async () => {
    if (process.platform === "win32") return;
    const dir = await temporaryDirectory();
    const fifo = path.join(dir, "hang.webp");
    const made = spawnSync("mkfifo", [fifo], { encoding: "utf8" });
    expect(made.status, made.stderr).toBe(0);
    await writePlan(dir, [{ file: "hang.webp", kind: "photo" }]);

    const manifest = await validateAssetFolder(dir);

    expect(manifest.assets[0].status).toBe("rejected");
    expect(manifest.assets[0].problems.join(" ")).toMatch(/regular|רגיל/i);
  }, 2_000);

  it("rejects SVG assets instead of exposing active markup in the contact sheet", async () => {
    const dir = await temporaryDirectory();
    await fs.writeFile(
      path.join(dir, "active.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );
    await writePlan(dir, [{ file: "active.svg", kind: "logo" }]);

    const manifest = await validateAssetFolder(dir);

    expect(manifest.assets[0].status).toBe("rejected");
    expect(manifest.assets[0].problems.join(" ")).toMatch(/SVG/);
  });

  it("checks a declared cutout even when its filename has no cut suffix", async () => {
    const dir = await temporaryDirectory();
    await writeWebp(path.join(dir, "source.webp"), 1);
    await writeWebp(path.join(dir, "hero-portrait.webp"), 2);
    await writePlan(dir, [
      { file: "source.webp", kind: "photo" },
      { file: "hero-portrait.webp", kind: "cutout", sourceFile: "source.webp" },
    ]);

    const manifest = await validateAssetFolder(dir);

    expect(manifest.assets.find((asset) => asset.file === "hero-portrait.webp")?.status).toBe("rejected");
  });

  it("requires human review for a new source-preserving cutout", async () => {
    const dir = await temporaryDirectory();
    const source = path.join(dir, "source.webp");
    const candidate = path.join(dir, "hero-portrait.webp");
    const madeSource = spawnSync(
      "python3",
      [
        "-c",
        "from PIL import Image,ImageDraw; import sys; im=Image.new('RGBA',(100,120),(0,0,0,0)); ImageDraw.Draw(im).rectangle((20,10,80,119),fill=(120,30,30,255)); im.save(sys.argv[1],'WEBP',lossless=True)",
        source,
      ],
      { encoding: "utf8" },
    );
    expect(madeSource.status, madeSource.stderr).toBe(0);
    const cutout = spawnSync("python3", [path.join(process.cwd(), "scripts", "cutout.py"), source, candidate], {
      encoding: "utf8",
    });
    expect(cutout.status, cutout.stderr).toBe(0);
    await writePlan(dir, [
      { file: "source.webp", kind: "photo" },
      { file: "hero-portrait.webp", kind: "cutout", sourceFile: "source.webp" },
    ]);

    const manifest = await validateAssetFolder(dir);

    expect(manifest.assets.find((asset) => asset.file === "hero-portrait.webp")?.status).toBe("review-required");

    const approval = await approveCurrentDraft(dir);
    const sealed = await readSealedApprovedAssetHashes(dir, approval.manifestSha256);
    expect(sealed["hero-portrait.webp"]).toBeTruthy();
    const reused = await validateAssetFolder(dir, {
      reusableHashes: sealed,
      sealedApprovedHashes: sealed,
    });
    expect(reused.assets.find((asset) => asset.file === "hero-portrait.webp")?.status).toBe("approved");
  });

  it("flags a transparent ghost even when the producer labels it as a photo", async () => {
    const dir = await temporaryDirectory();
    const file = path.join(dir, "ghost.webp");
    const made = spawnSync(
      "python3",
      [
        "-c",
        "from PIL import Image,ImageDraw; import sys; im=Image.new('RGBA',(100,100),(0,0,0,0)); ImageDraw.Draw(im).rectangle((45,45,54,54),fill=(20,30,40,255)); im.save(sys.argv[1],'WEBP',lossless=True)",
        file,
      ],
      { encoding: "utf8" },
    );
    expect(made.status, made.stderr).toBe(0);
    await writePlan(dir, [{ file: "ghost.webp", kind: "photo" }]);

    const manifest = await validateAssetFolder(dir);

    expect(manifest.assets[0].status).toBe("review-required");
    expect(manifest.assets[0].problems.join(" ")).toMatch(/שקיפות/);
  });

  it("rejects a mockup when any of its declared inputs is rejected", async () => {
    const dir = await temporaryDirectory();
    await writeWebp(path.join(dir, "source.webp"), 1);
    await writeWebp(path.join(dir, "portrait-cut.webp"), 2);
    await writeWebp(path.join(dir, "mockup.webp"), 3);
    await writePlan(dir, [
      { file: "source.webp", kind: "photo" },
      { file: "portrait-cut.webp", kind: "cutout", sourceFile: "source.webp" },
      { file: "mockup.webp", kind: "mockup", inputs: ["portrait-cut.webp"] },
    ]);

    const manifest = await validateAssetFolder(dir);

    expect(manifest.assets.find((asset) => asset.file === "mockup.webp")?.status).toBe("rejected");
  });

  it("rejects every mockup when an image, including a nested one, is undeclared", async () => {
    const dir = await temporaryDirectory();
    await writeWebp(path.join(dir, "source.webp"), 1);
    await writeWebp(path.join(dir, "mockup.webp"), 2);
    await fs.mkdir(path.join(dir, "old"));
    await writeWebp(path.join(dir, "old", "hidden.webp"), 3);
    await writePlan(dir, [
      { file: "source.webp", kind: "photo" },
      { file: "mockup.webp", kind: "mockup", inputs: ["source.webp"] },
    ]);

    const manifest = await validateAssetFolder(dir);

    expect(manifest.ignoredFiles).toEqual(["old/", "old/hidden.webp"]);
    expect(manifest.assets.find((asset) => asset.file === "mockup.webp")?.status).toBe("rejected");
  });

  it("rejects a mockup when an undeclared nested source has an unknown extension", async () => {
    const dir = await temporaryDirectory();
    await writeWebp(path.join(dir, "source.webp"), 1);
    await writeWebp(path.join(dir, "mockup.webp"), 2);
    await fs.mkdir(path.join(dir, "intermediate"));
    await fs.writeFile(path.join(dir, "intermediate", "source.gif"), "GIF89a");
    await writePlan(dir, [
      { file: "source.webp", kind: "photo" },
      { file: "mockup.webp", kind: "mockup", inputs: ["source.webp"] },
    ]);

    const manifest = await validateAssetFolder(dir);

    expect(manifest.ignoredFiles).toContain("intermediate/source.gif");
    expect(manifest.assets.find((asset) => asset.file === "mockup.webp")?.status).toBe("rejected");
  });

  it("fails closed instead of skipping an over-deep asset directory", async () => {
    const dir = await temporaryDirectory();
    await writeWebp(path.join(dir, "mockup.webp"), 2);
    await fs.mkdir(path.join(dir, "a", "b", "c", "d", "e", "f"), { recursive: true });
    await fs.writeFile(path.join(dir, "a", "b", "c", "d", "e", "f", "source.gif"), "GIF89a");
    await writePlan(dir, [{ file: "mockup.webp", kind: "mockup", inputs: ["mockup.webp"] }]);

    await expect(validateAssetFolder(dir)).rejects.toThrow(/depth limit/i);
  });

  it("returns the exact bytes and digest used for validation as one snapshot", async () => {
    const dir = await temporaryDirectory();
    const file = path.join(dir, "portrait.webp");
    await writeWebp(file, 1);
    await writePlan(dir, [{ file: "portrait.webp", kind: "photo" }]);

    const snapshot = await validateAssetFolderSnapshot(dir);
    const shownBytes = snapshot.assetBytes.get("portrait.webp");
    expect(shownBytes).toBeTruthy();
    await writeWebp(file, 2);

    expect(snapshot.assetBytes.get("portrait.webp")).toEqual(shownBytes);
    expect(await readAssetManifestSha256(dir)).toBe(snapshot.manifestSha256);
    await expect(
      readApprovedAssetFiles(dir, { expectedManifestSha256: snapshot.manifestSha256 }),
    ).rejects.toThrow(/changed after validation/i);
  });

  it("recovers a validated orphan attempt when state persistence missed its digest", async () => {
    const dir = await temporaryDirectory();
    await writeWebp(path.join(dir, "portrait.webp"), 7);
    await writePlan(dir, [{ file: "portrait.webp", kind: "photo" }]);
    await validateAssetFolderSnapshot(dir);
    await fs.writeFile(path.join(dir, "contact-sheet-old-attempt.html"), "old sheet");

    const recovered = await recoverOrphanAssetAttempt(dir, "retry");

    expect(recovered.reusableHashes).toHaveProperty("portrait.webp");
    expect(await readReusableAssetHashes(dir, recovered.manifestSha256)).toEqual(
      recovered.reusableHashes,
    );
    expect(await fs.readdir(`${dir}-prev-retry-sheets`)).toEqual([
      "contact-sheet-old-attempt.html",
    ]);
  });

  it("archives a crash-before-plan attempt and lets the retry start clean", async () => {
    const dir = await temporaryDirectory();
    await writeWebp(path.join(dir, "partial.webp"), 9);

    const recovered = await recoverOrArchivePartialAssetAttempt(dir, "retry");

    expect(recovered).toEqual({ reusableHashes: {}, recovered: false });
    expect(await fs.readdir(dir)).toEqual([]);
    expect(await fs.readdir(`${dir}-prev-retry-partial`)).toEqual(["partial.webp"]);
  });

  it("never follows a pre-existing contact-sheet symlink", async () => {
    const dir = await temporaryDirectory();
    const outside = path.join(await temporaryDirectory(), "outside.html");
    await fs.writeFile(outside, "do not overwrite");
    const sheet = path.join(dir, "contact-sheet-attempt-hash.html");
    await fs.symlink(outside, sheet);

    await expect(
      atomicCreateManagedFile(sheet, dir, "safe snapshot"),
    ).rejects.toThrow(/regular file|different content/i);
    expect(await fs.readFile(outside, "utf8")).toBe("do not overwrite");
  });

  it("refuses approval when the displayed contact sheet changed", async () => {
    const dir = await temporaryDirectory();
    await writeWebp(path.join(dir, "portrait.webp"), 1);
    await writePlan(dir, [{ file: "portrait.webp", kind: "photo" }]);
    await validateAssetFolder(dir);
    const draft = await readAssetManifestSha256(dir);
    const sheetFile = "contact-sheet-attempt-hash.html";
    const original = "<html>shown snapshot</html>";
    await atomicCreateManagedFile(path.join(dir, sheetFile), dir, original);
    await fs.writeFile(path.join(dir, sheetFile), "<html>tampered</html>");

    await expect(
      approveReviewRequiredAssets(dir, draft, {
        file: sheetFile,
        sha256: createHash("sha256").update(original).digest("hex"),
      }),
    ).rejects.toThrow(/contact sheet changed/i);
    await expect(fs.access(path.join(dir, "asset-approval.json"))).rejects.toThrow();
  });

  it("rejects a cutout that points to itself as its source", async () => {
    const dir = await temporaryDirectory();
    await writeWebp(path.join(dir, "self-cut.webp"), 1);
    await writePlan(dir, [
      { file: "self-cut.webp", kind: "cutout", sourceFile: "self-cut.webp" },
    ]);

    const manifest = await validateAssetFolder(dir);

    expect(manifest.assets[0].status).toBe("rejected");
    expect(manifest.assets[0].problems.join(" ")).toMatch(/מקור של עצמו|מעגל תלות/);
  });

  it("detects manifest tampering after human approval", async () => {
    const dir = await temporaryDirectory();
    await writeWebp(path.join(dir, "portrait.webp"), 1);
    await writePlan(dir, [{ file: "portrait.webp", kind: "photo" }]);
    await validateAssetFolder(dir);
    const approval = await approveCurrentDraft(dir);
    const manifestPath = path.join(dir, ASSET_MANIFEST_NAME);
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    manifest.generatedAt = "tampered";
    await fs.writeFile(manifestPath, JSON.stringify(manifest));

    await expect(
      readApprovedAssetFiles(dir, {
        requireApproval: true,
        expectedManifestSha256: approval.manifestSha256,
      }),
    ).rejects.toThrow(/digest|approval/i);
  });

  it("rejects an unchanged stale file unless the prior manifest allows reuse", async () => {
    const dir = await temporaryDirectory();
    const file = path.join(dir, "stale.webp");
    await writeWebp(file, 1);
    await writePlan(dir, [{ file: "stale.webp", kind: "photo" }]);
    const { createHash } = await import("node:crypto");
    const hash = createHash("sha256").update(await fs.readFile(file)).digest("hex");

    const rejected = await validateAssetFolder(dir, {
      expectedAttemptId: "test-attempt",
      baselineHashes: { "stale.webp": hash },
      reusableHashes: {},
    });
    expect(rejected.assets[0].status).toBe("rejected");

    const reused = await validateAssetFolder(dir, {
      expectedAttemptId: "test-attempt",
      baselineHashes: { "stale.webp": hash },
      reusableHashes: { "stale.webp": hash },
    });
    expect(reused.assets[0].status).toBe("approved");
  });

  it("does not reuse a prior asset whose bytes no longer match its recorded hash", async () => {
    const dir = await temporaryDirectory();
    const file = path.join(dir, "portrait.webp");
    await writeWebp(file, 1);
    await writePlan(dir, [{ file: "portrait.webp", kind: "photo" }]);
    await validateAssetFolder(dir);
    const priorManifestSha256 = await readAssetManifestSha256(dir);
    expect(await readReusableAssetHashes(dir, priorManifestSha256)).toHaveProperty("portrait.webp");

    await writeWebp(file, 2);

    expect(await readReusableAssetHashes(dir, priorManifestSha256)).toEqual({});
  });

  it("copies only sealed assets and detects an image the builder adds", async () => {
    const dir = await temporaryDirectory();
    const destination = await temporaryDirectory();
    await writeWebp(path.join(dir, "portrait.webp"), 1);
    await writePlan(dir, [{ file: "portrait.webp", kind: "photo" }]);
    await validateAssetFolder(dir);
    const approval = await approveCurrentDraft(dir);

    const expected = await copyApprovedAssets(dir, destination, approval.manifestSha256);
    expect(await fs.readdir(destination)).toEqual(["portrait.webp"]);
    await verifyPreparedAssets(destination, expected);

    await fs.rm(path.join(destination, "portrait.webp"));
    await expect(verifyPreparedAssets(destination, expected)).rejects.toThrow(/removed an approved image/i);
    await fs.copyFile(path.join(dir, "portrait.webp"), path.join(destination, "portrait.webp"));

    await fs.rm(path.join(destination, "portrait.webp"));
    await fs.symlink(path.join(dir, "portrait.webp"), path.join(destination, "portrait.webp"));
    await expect(verifyPreparedAssets(destination, expected)).rejects.toThrow(/non-regular file/i);
    await fs.rm(path.join(destination, "portrait.webp"));
    await fs.copyFile(path.join(dir, "portrait.webp"), path.join(destination, "portrait.webp"));

    await fs.writeFile(path.join(destination, "rogue.webp"), "not-approved");
    await expect(verifyPreparedAssets(destination, expected)).rejects.toThrow(/unapproved image/i);
  });

  it("refuses approval when the manifest differs from the contact-sheet snapshot", async () => {
    const dir = await temporaryDirectory();
    await writeWebp(path.join(dir, "portrait.webp"), 1);
    await writePlan(dir, [{ file: "portrait.webp", kind: "photo" }]);
    await validateAssetFolder(dir);
    const displayedDraft = await readAssetManifestSha256(dir);
    const manifestPath = path.join(dir, ASSET_MANIFEST_NAME);
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    manifest.generatedAt = "changed-after-display";
    await fs.writeFile(manifestPath, JSON.stringify(manifest));

    await expect(approveReviewRequiredAssets(dir, displayedDraft)).rejects.toThrow(
      /changed after the contact sheet/i,
    );
  });

  it("keeps the draft manifest immutable and can repeat approval after a crash", async () => {
    const dir = await temporaryDirectory();
    await writeWebp(path.join(dir, "portrait.webp"), 1);
    await writePlan(dir, [{ file: "portrait.webp", kind: "photo" }]);
    await validateAssetFolder(dir);
    const draftBytes = await fs.readFile(path.join(dir, ASSET_MANIFEST_NAME));
    const draftSha256 = await readAssetManifestSha256(dir);

    const first = await approveReviewRequiredAssets(dir, draftSha256);
    const second = await approveReviewRequiredAssets(dir, draftSha256);

    expect(first.manifestSha256).toBe(draftSha256);
    expect(second.manifestSha256).toBe(draftSha256);
    expect(await fs.readFile(path.join(dir, ASSET_MANIFEST_NAME))).toEqual(draftBytes);
  });

  it("rejects path traversal and symlink entries without following them", async () => {
    const dir = await temporaryDirectory();
    const outsideDir = await temporaryDirectory();
    const outside = path.join(outsideDir, "outside.webp");
    await fs.writeFile(outside, "private-file");
    await fs.symlink(outside, path.join(dir, "linked.webp"));
    await writePlan(dir, [
      { file: "../outside.webp", kind: "photo" },
      { file: "linked.webp", kind: "photo" },
    ]);

    const manifest = await validateAssetFolder(dir);

    expect(manifest.assets.every((asset) => asset.status === "rejected")).toBe(true);
    expect(manifest.assets.find((asset) => asset.file === "../outside.webp")?.problems.join(" ")).toMatch(/בטוח/);
    expect(manifest.assets.find((asset) => asset.file === "linked.webp")?.problems.join(" ")).toMatch(/רגיל/);
    expect(manifest.assets.find((asset) => asset.file === "linked.webp")?.previewable).toBe(false);
  });

  it("rejects an assets directory that was replaced with a symlink", async () => {
    const realDir = await temporaryDirectory();
    const parent = await temporaryDirectory();
    const linkedDir = path.join(parent, "assets");
    await fs.symlink(realDir, linkedDir);

    await expect(validateAssetFolder(linkedDir)).rejects.toThrow(/regular directory/i);
  });

  it("never recursively removes a managed child that is a symlink", async () => {
    const outside = await temporaryDirectory();
    const parent = await temporaryDirectory();
    const linked = path.join(parent, "page");
    await fs.writeFile(path.join(outside, "keep.txt"), "do not remove");
    await fs.symlink(outside, linked);

    await expect(removeManagedChildDirectory(linked, parent)).rejects.toThrow(/regular directory/i);
    await expect(fs.readFile(path.join(outside, "keep.txt"), "utf8")).resolves.toBe("do not remove");
  });
});

describe("placement map requirement (stage 5.2 only)", () => {
  const map = { section: "Hero", proves: "״30 לקוחות בחודש״" };

  it("leaves an unmapped generated asset approved when the flag is off (stage 7.5 path)", async () => {
    const dir = await temporaryDirectory();
    await writeWebp(path.join(dir, "creative-1.webp"), 1);
    await writePlan(dir, [{ file: "creative-1.webp", kind: "generated" }]);

    const { manifest } = await validateAssetFolderSnapshot(dir);

    expect(manifest.assets[0]).toMatchObject({ status: "approved" });
    expect(manifest.assets[0].problems).not.toContain(PLACEMENT_MAP_MISSING_PROBLEM);
  });

  it("marks an unmapped placeable asset review-required when the flag is on", async () => {
    const dir = await temporaryDirectory();
    await writeWebp(path.join(dir, "hero.webp"), 1);
    await writeWebp(path.join(dir, "logo.webp"), 2);
    await writePlan(dir, [
      { file: "hero.webp", kind: "photo" },
      { file: "logo.webp", kind: "logo" },
    ]);

    const { manifest } = await validateAssetFolderSnapshot(dir, { requirePlacementMap: true });
    const byFile = new Map(manifest.assets.map((a) => [a.file, a]));

    expect(byFile.get("hero.webp")).toMatchObject({ status: "review-required" });
    expect(byFile.get("hero.webp")!.problems).toContain(PLACEMENT_MAP_MISSING_PROBLEM);
    expect(byFile.get("logo.webp")).toMatchObject({ status: "approved" });
  });

  it("never turns a rejected unmapped asset into review-required", async () => {
    const dir = await temporaryDirectory();
    await fs.writeFile(path.join(dir, "broken.webp"), "not an image");
    await writePlan(dir, [{ file: "broken.webp", kind: "photo" }]);

    const { manifest } = await validateAssetFolderSnapshot(dir, { requirePlacementMap: true });

    expect(manifest.assets[0]).toMatchObject({ status: "rejected" });
    expect(manifest.assets[0].problems).not.toContain(PLACEMENT_MAP_MISSING_PROBLEM);
  });

  it("adds the mapping problem to an asset already review-required for transparency, keeping both reasons", async () => {
    const dir = await temporaryDirectory();
    const made = spawnSync(
      "python3",
      [
        "-c",
        "from PIL import Image; import sys; im=Image.new('RGBA',(32,32),(200,50,50,255)); [im.putpixel((x,y),(0,0,0,0)) for x in range(16) for y in range(32)]; im.save(sys.argv[1],'WEBP',lossless=True)",
        path.join(dir, "badge.webp"),
      ],
      { encoding: "utf8" },
    );
    expect(made.status, made.stderr).toBe(0);
    await writePlan(dir, [{ file: "badge.webp", kind: "photo" }]);

    // Precondition: without the flag this asset is already review-required for transparency.
    // If this fails, raise the transparent share in the fixture until it holds; do not change the code.
    const withoutFlag = await validateAssetFolderSnapshot(dir);
    expect(withoutFlag.manifest.assets[0]).toMatchObject({ status: "review-required" });

    const { manifest } = await validateAssetFolderSnapshot(dir, { requirePlacementMap: true });

    expect(manifest.assets[0]).toMatchObject({ status: "review-required" });
    expect(manifest.assets[0].problems).toEqual(expect.arrayContaining([
      expect.stringContaining("שקיפות משמעותית"),
      PLACEMENT_MAP_MISSING_PROBLEM,
    ]));
  });

  it("exempts the source of a cutout even when the cutout itself is rejected", async () => {
    const dir = await temporaryDirectory();
    await writeWebp(path.join(dir, "portrait.webp"), 1);
    await writeWebp(path.join(dir, "portrait-cut.webp"), 2);
    await writePlan(dir, [
      { file: "portrait.webp", kind: "photo" },
      { file: "portrait-cut.webp", kind: "cutout", sourceFile: "portrait.webp", ...map },
    ]);

    const { manifest } = await validateAssetFolderSnapshot(dir, { requirePlacementMap: true });
    const byFile = new Map(manifest.assets.map((a) => [a.file, a]));

    expect(byFile.get("portrait-cut.webp")).toMatchObject({ status: "rejected" });
    expect(byFile.get("portrait.webp")).toMatchObject({ status: "approved" });
  });

  it("hands the builder only approved assets, even when a rejected one is mapped", async () => {
    const dir = await temporaryDirectory();
    await writeWebp(path.join(dir, "hero.webp"), 1);
    await writeWebp(path.join(dir, "portrait.webp"), 2);
    await writeWebp(path.join(dir, "portrait-cut.webp"), 3);
    await writePlan(dir, [
      { file: "hero.webp", kind: "photo", ...map },
      { file: "portrait.webp", kind: "photo" },
      { file: "portrait-cut.webp", kind: "cutout", sourceFile: "portrait.webp", section: "סיפור", proves: "הרגע שהכל השתנה" },
    ]);
    await validateAssetFolderSnapshot(dir, { requirePlacementMap: true });
    const approval = await approveCurrentDraft(dir);

    const placement = await readApprovedAssetPlacement(dir, approval.manifestSha256);

    expect(placement.mapped).toEqual([{ file: "hero.webp", ...map }]);
    expect(placement.mapped.map((a) => a.file)).not.toContain("portrait-cut.webp");
    // In validation portrait.webp was raw material (its cutout was in the plan) and stayed approved.
    // Among approved assets only, its cutout is gone, so the builder sees it as unmapped.
    expect(placement.unmapped).toEqual(["portrait.webp"]);
  });

  it("reads an old manifest with no placement fields", async () => {
    const dir = await temporaryDirectory();
    await writeWebp(path.join(dir, "portrait.webp"), 1);
    await writePlan(dir, [{ file: "portrait.webp", kind: "photo" }]);
    await validateAssetFolder(dir);
    const approval = await approveCurrentDraft(dir);

    const placement = await readApprovedAssetPlacement(dir, approval.manifestSha256);

    expect(placement).toEqual({ mapped: [], logos: [], rawMaterial: [], unmapped: ["portrait.webp"] });
  });

  it("keeps the requirement when an orphaned 5.2 attempt is recovered", async () => {
    const dir = await temporaryDirectory();
    await writeWebp(path.join(dir, "hero.webp"), 1);
    await writePlan(dir, [{ file: "hero.webp", kind: "photo" }]);

    await recoverOrphanAssetAttempt(dir, "2026-09-13T10-00-00");
    const manifest = JSON.parse(await fs.readFile(path.join(dir, ASSET_MANIFEST_NAME), "utf8"));

    expect(manifest.assets[0]).toMatchObject({ file: "hero.webp", status: "review-required" });
  });
});

describe("harvestFile on an asset plan entry (direct run image map)", () => {
  it("preserves harvestFile from the plan through the persisted and approved manifest", async () => {
    const dir = await temporaryDirectory();
    await writeWebp(path.join(dir, "hero.webp"));
    const row = { harvestFile: "raw/01-portrait.jpg", section: "Hero", proves: "המציג" };
    await fs.writeFile(path.join(dir, ASSET_PLAN_NAME), JSON.stringify({
      schemaVersion: 1, attemptId: "test-attempt",
      assets: [{ file: "hero.webp", kind: "photo", ...row }],
    }));

    const snapshot = await validateAssetFolderSnapshot(dir);

    expect(snapshot.manifest.assets[0]).toMatchObject(row);
    const persisted = JSON.parse(await fs.readFile(path.join(dir, ASSET_MANIFEST_NAME), "utf8")) as AssetManifest;
    expect(persisted.assets[0]).toMatchObject(row);
    expect(imageMapCoverageGaps(persisted.assets, [row])).toEqual([]);
    const approval = await approveCurrentDraft(dir);
    await expect(readApprovedAssetFiles(dir, {
      requireApproval: true, expectedManifestSha256: approval.manifestSha256,
    })).resolves.toEqual(["hero.webp"]);
    const afterApproval = JSON.parse(await fs.readFile(path.join(dir, ASSET_MANIFEST_NAME), "utf8")) as AssetManifest;
    expect(afterApproval.assets[0]?.harvestFile).toBe(row.harvestFile);
  });

  it.each([42, null, "", "../portrait.jpg", "/raw/portrait.jpg", "raw/a\\b.jpg", "raw/a\u0000.jpg"])(
    "rejects malformed harvestFile %j instead of making it review-required",
    async (harvestFile) => {
      const dir = await temporaryDirectory();
      await writeWebp(path.join(dir, "hero.webp"));
      await fs.writeFile(path.join(dir, ASSET_PLAN_NAME), JSON.stringify({
        schemaVersion: 1, attemptId: "test-attempt",
        assets: [{ file: "hero.webp", kind: "photo", section: "Hero", proves: "המציג", harvestFile }],
      }));

      const { manifest } = await validateAssetFolderSnapshot(dir);

      expect(manifest.assets[0]).toMatchObject({ status: "rejected", problems: expect.arrayContaining(["harvestFile לא תקין"]) });
      expect(manifest.assets[0]?.status).not.toBe("review-required");
    },
  );

  it("rejects a malformed harvestFile when loading an existing manifest", async () => {
    const dir = await temporaryDirectory();
    await writeWebp(path.join(dir, "hero.webp"));
    await fs.writeFile(path.join(dir, ASSET_PLAN_NAME), JSON.stringify({
      schemaVersion: 1, attemptId: "test-attempt",
      assets: [{ file: "hero.webp", kind: "photo", section: "Hero", proves: "המציג", harvestFile: "raw/portrait.jpg" }],
    }));
    await validateAssetFolderSnapshot(dir);
    const persisted = JSON.parse(await fs.readFile(path.join(dir, ASSET_MANIFEST_NAME), "utf8"));
    persisted.assets[0].harvestFile = "../portrait.jpg";
    await fs.writeFile(path.join(dir, ASSET_MANIFEST_NAME), JSON.stringify(persisted));

    // No expected digest: isolate field validation, rather than failing only on the changed seal.
    await expect(readApprovedAssetFiles(dir)).rejects.toThrow(/harvestFile/);
  });
});

/**
 * Task 14 (the mockup plan contract). The 5.2 agent writes the HTML screens
 * and declares them; the orchestrator renders them later. Everything the
 * agent leaves under screens/ that it did not declare is an undeclared file
 * like any other, so nothing can slip into the assets folder through that
 * directory.
 */
describe("the mockup screen contract", () => {
  async function writeScreens(
    dir: string,
    screens: Record<string, [number, number]>,
    sizes?: unknown,
  ): Promise<void> {
    const screensDir = path.join(dir, SCREENS_DIR);
    await fs.mkdir(screensDir, { recursive: true });
    for (const name of Object.keys(screens)) {
      await fs.writeFile(path.join(screensDir, `${name}.html`), `<h1>${name}</h1>`, "utf8");
    }
    await fs.writeFile(
      path.join(screensDir, "sizes.json"),
      JSON.stringify(sizes === undefined ? screens : sizes),
      "utf8",
    );
  }

  async function mockupDir(
    over: Record<string, unknown> = {},
    sizes?: unknown,
  ): Promise<string> {
    const dir = await temporaryDirectory();
    await writeWebp(path.join(dir, "presenter-portrait.webp"), 1);
    await writeWebp(path.join(dir, "module-1-mockup.webp"), 2);
    await writeScreens(dir, { "ch1-laptop": [1440, 900], "ch1-tablet": [1024, 768] }, sizes);
    await writePlan(dir, [
      { file: "presenter-portrait.webp", kind: "photo", section: "Hero", proves: "המנחה" },
      {
        file: "module-1-mockup.webp",
        kind: "mockup",
        inputs: ["presenter-portrait.webp"],
        screens: ["ch1-laptop", "ch1-tablet"],
        render: { base: "chapter", map: { "1": "ch1-laptop", "10": "ch1-tablet" } },
        section: "Stack",
        proves: "מה מקבלים בכל פרק",
        ...over,
      },
    ]);
    return dir;
  }

  const mockupOf = (manifest: AssetManifest) =>
    manifest.assets.find((asset) => asset.file === "module-1-mockup.webp")!;

  it("names the screen files a declared entry owns", () => {
    expect(screenFilesFor({ screens: ["ch1-laptop", "ch1-tablet"] })).toEqual([
      "screens/ch1-laptop.html",
      "screens/ch1-tablet.html",
    ]);
    expect(screenFilesFor({})).toEqual([]);
    expect(screenFilesFor({ screens: ["../etc/passwd"] })).toEqual([]);
  });

  it("approves a declared mockup and keeps its screens out of the ignored files", async () => {
    const dir = await mockupDir();

    const manifest = await validateAssetFolder(dir);

    expect(mockupOf(manifest).status).toBe("approved");
    expect(mockupOf(manifest).problems).toEqual([]);
    expect(manifest.ignoredFiles).toEqual([]);
    // The manifest carries the contract forward for the renderer and the sheet.
    expect(mockupOf(manifest).screens).toEqual(["ch1-laptop", "ch1-tablet"]);
    expect(mockupOf(manifest).render).toEqual({ base: "chapter", map: { "1": "ch1-laptop", "10": "ch1-tablet" } });
    await expect(readApprovedAssetFiles(dir)).resolves.toContain("module-1-mockup.webp");
  });

  // A rendered mockup's inputs are its screens: the orchestrator opens them,
  // resolves their `asset:` references and composites the result. Demanding an
  // `inputs` list as well made a screen of pure text an impossible mockup.
  it("accepts a rendered mockup that declares no inputs at all", async () => {
    const dir = await mockupDir({ inputs: undefined });

    const manifest = await validateAssetFolder(dir);

    expect(mockupOf(manifest).problems).toEqual([]);
    expect(mockupOf(manifest).status).toBe("approved");
    // And its screens are still its own: the sheet must not call them strays.
    expect(manifest.ignoredFiles).toEqual([]);
    expect(mockupOf(manifest).screens).toEqual(["ch1-laptop", "ch1-tablet"]);
  });

  it("still validates inputs when a rendered mockup declares them", async () => {
    const manifest = await validateAssetFolder(
      await mockupDir({ inputs: ["../outside.webp"] }),
    );

    expect(mockupOf(manifest).problems).toContain("רשימת התלויות מכילה שם קובץ לא בטוח");
    expect(mockupOf(manifest).status).toBe("rejected");
  });

  it("still demands inputs from a mockup that declares neither screens nor render", async () => {
    const manifest = await validateAssetFolder(
      await mockupDir({ inputs: undefined, screens: undefined, render: undefined }),
    );

    expect(mockupOf(manifest).problems).toContain(MOCKUP_INPUTS_MISSING_PROBLEM);
    expect(mockupOf(manifest).problems).toContain("מוקאפ בלי הוראת רינדור");
    expect(mockupOf(manifest).status).toBe("rejected");
  });

  it("rejects a mockup with no render instruction", async () => {
    const manifest = await validateAssetFolder(await mockupDir({ render: undefined }));

    expect(mockupOf(manifest).problems).toContain("מוקאפ בלי הוראת רינדור");
    expect(mockupOf(manifest).status).toBe("rejected");
  });

  it("rejects an HTML screen smuggled into inputs instead of screens", async () => {
    const manifest = await validateAssetFolder(
      await mockupDir({ inputs: ["presenter-portrait.webp", "ch1-laptop.html"] }),
    );

    expect(mockupOf(manifest).problems).toContain("inputs מכיל HTML; מסכים מוצהרים ב-screens");
    expect(mockupOf(manifest).status).toBe("rejected");
  });

  it("rejects a render map that points at a screen the entry never declared", async () => {
    const manifest = await validateAssetFolder(
      await mockupDir({ render: { base: "chapter", map: { "1": "ch1-laptop", "10": "ch9-tablet" } } }),
    );

    expect(mockupOf(manifest).problems).toContain("map מפנה למסך שלא הוצהר");
    expect(mockupOf(manifest).status).toBe("rejected");
  });

  it("rejects a base that is not one of the two packaged frames", async () => {
    const manifest = await validateAssetFolder(
      await mockupDir({ render: { base: "watch", map: { "1": "ch1-laptop" } } }),
    );

    expect(mockupOf(manifest).problems).toContain("הוראת רינדור לא תקינה");
    expect(mockupOf(manifest).status).toBe("rejected");
  });

  it("rejects a declared screen with no HTML file on disk", async () => {
    const manifest = await validateAssetFolder(
      await mockupDir({
        screens: ["ch1-laptop", "ch1-tablet", "ch2-laptop"],
        render: { base: "chapter", map: { "1": "ch2-laptop" } },
      }),
    );

    expect(mockupOf(manifest).problems).toContain("מסך מוצהר חסר");
    expect(mockupOf(manifest).status).toBe("rejected");
  });

  // I4: the receipt records one hash per declared screen, and the run-state
  // validator caps a hash record. The plan's own ceiling is what keeps the two
  // apart, so it is asserted here rather than left to the renderer.
  it("rejects an entry that declares more screens than the contract allows", async () => {
    const tooMany = Array.from({ length: MAX_RENDER_REGIONS + 1 }, (_, index) => `ch${index}-laptop`);

    const manifest = await validateAssetFolder(await mockupDir({ screens: tooMany }));

    expect(mockupOf(manifest).problems).toContain("שם מסך לא תקין");
    expect(mockupOf(manifest).status).toBe("rejected");
  });

  // Minor 1: the renderer parses a region id as an integer, so the plan
  // validator refuses any other spelling on the sheet instead of leaving the
  // agent to discover it at the end of a render.
  it("rejects a render map whose region id is not digits", async () => {
    const manifest = await validateAssetFolder(
      await mockupDir({ render: { base: "chapter", map: { hero: "ch1-laptop" } } }),
    );

    expect(mockupOf(manifest).problems).toContain("הוראת רינדור לא תקינה");
    expect(mockupOf(manifest).status).toBe("rejected");
  });

  // Minor 4: composite.py saves an RGBA image by extension. JPEG raises and
  // AVIF has no encoder, so such a mockup could only ever fail the composite.
  it.each(["module-1-mockup.jpg", "module-1-mockup.avif"])(
    "rejects a mockup declared as %s, which cannot be written with alpha",
    async (file) => {
      const manifest = await validateAssetFolder(await mockupDir({ file }));

      const entry = manifest.assets.find((asset) => asset.file === file)!;
      expect(entry.problems).toContain("קובץ מוקאפ חייב להיות WebP או PNG");
      expect(entry.status).toBe("rejected");
    },
  );

  it("accepts a mockup declared as PNG", async () => {
    const manifest = await validateAssetFolder(await mockupDir());

    expect(mockupOf(manifest).problems).not.toContain("קובץ מוקאפ חייב להיות WebP או PNG");
  });

  // Minor 12: a screen file left unowned by its own entry's malformed `screens`
  // list is not a stray file the agent has to hunt for. The sheet names the
  // declaration to fix.
  it("says the screens declaration is malformed instead of reporting stray files", async () => {
    const dir = await mockupDir({ screens: ["ch1-laptop", "ch1-tablet", "../etc/passwd"] });

    const manifest = await validateAssetFolder(dir);

    const problems = mockupOf(manifest).problems.join(" | ");
    expect(problems).toContain("הצהרת ה-screens של module-1-mockup.webp אינה תקינה");
    expect(problems).toContain("screens/ch1-laptop.html");
    expect(problems).not.toContain("קובצי תמונה לא מוצהרים בתיקייה");
    expect(mockupOf(manifest).status).toBe("rejected");
  });

  // Minor 13: a sidecar is evidence about a cutout, not a way to reclassify an
  // entry. A mockup that becomes a "cutout" can never match a required row.
  it("keeps a mockup a mockup when a cutout receipt is planted beside it", async () => {
    const dir = await mockupDir();
    await fs.writeFile(path.join(dir, "module-1-mockup.webp.cutout.json"), "{}");

    const manifest = await validateAssetFolder(dir);

    expect(mockupOf(manifest).kind).toBe("mockup");
    expect(manifest.ignoredFiles).toEqual([]);
  });

  it("rejects a screen name outside the allowed character set", async () => {
    const manifest = await validateAssetFolder(await mockupDir({ screens: ["../etc/passwd"] }));

    expect(mockupOf(manifest).problems).toContain("שם מסך לא תקין");
    expect(mockupOf(manifest).status).toBe("rejected");
  });

  it("rejects a sizes.json that misses a declared screen or exceeds the pixel ceiling", async () => {
    const missing = await validateAssetFolder(await mockupDir({}, { "ch1-laptop": [1440, 900] }));
    expect(mockupOf(missing).problems).toContain("sizes.json לא מגדיר מידות תקינות לכל מסך מוצהר");

    const huge = await validateAssetFolder(
      await mockupDir({}, { "ch1-laptop": [1440, 900], "ch1-tablet": [1024, 4097] }),
    );
    expect(mockupOf(huge).problems).toContain("sizes.json לא מגדיר מידות תקינות לכל מסך מוצהר");
    expect(mockupOf(huge).status).toBe("rejected");
  });

  it("treats an undeclared file under screens/ like any other undeclared file", async () => {
    const dir = await mockupDir();
    await fs.writeFile(path.join(dir, SCREENS_DIR, "extra.html"), "<b>rogue</b>", "utf8");
    await writeWebp(path.join(dir, SCREENS_DIR, "x.png"), 7);

    const manifest = await validateAssetFolder(dir);

    expect(manifest.ignoredFiles).toContain("screens/extra.html");
    expect(manifest.ignoredFiles).toContain("screens/x.png");
    // The declared screens and sizes.json stay out of the ignored list.
    expect(manifest.ignoredFiles).not.toContain("screens/ch1-laptop.html");
    expect(manifest.ignoredFiles).not.toContain("screens/sizes.json");
    expect(mockupOf(manifest).status).toBe("rejected");
  });

  it("stops ignoring the screens of an entry whose own validation failed", async () => {
    const dir = await mockupDir({ render: undefined });

    const manifest = await validateAssetFolder(dir);

    expect(manifest.ignoredFiles).toContain("screens/ch1-laptop.html");
    expect(manifest.ignoredFiles).toContain("screens/ch1-tablet.html");
  });

  it("refuses screens and render on an entry that is not a mockup, and excuses none of its files", async () => {
    const dir = await temporaryDirectory();
    await writeWebp(path.join(dir, "hero.webp"), 1);
    await writeScreens(dir, { "ch1-laptop": [1440, 900] });
    await writePlan(dir, [{
      file: "hero.webp",
      kind: "photo",
      screens: ["ch1-laptop"],
      render: { base: "chapter", map: { "1": "ch1-laptop" } },
    }]);

    const manifest = await validateAssetFolder(dir);

    expect(manifest.assets[0]!.problems).toContain("screens ו-render מותרים רק למוקאפ");
    expect(manifest.assets[0]!.status).toBe("rejected");
    // The HTML it pointed at is an undeclared file like any other.
    expect(manifest.ignoredFiles).toContain("screens/ch1-laptop.html");
  });

  it("refuses two mockups that claim the same screen file", async () => {
    const dir = await temporaryDirectory();
    await writeWebp(path.join(dir, "presenter-portrait.webp"), 1);
    await writeWebp(path.join(dir, "module-1-mockup.webp"), 2);
    await writeWebp(path.join(dir, "module-2-mockup.webp"), 3);
    await writeScreens(dir, { "ch1-laptop": [1440, 900], "ch2-laptop": [1440, 900] });
    const mockup = (file: string, screens: string[]) => ({
      file,
      kind: "mockup" as const,
      inputs: ["presenter-portrait.webp"],
      screens,
      render: { base: "chapter", map: { "1": screens[0]! } },
    });
    await writePlan(dir, [
      { file: "presenter-portrait.webp", kind: "photo" },
      mockup("module-1-mockup.webp", ["ch1-laptop"]),
      mockup("module-2-mockup.webp", ["ch1-laptop", "ch2-laptop"]),
    ]);

    const manifest = await validateAssetFolder(dir);

    for (const file of ["module-1-mockup.webp", "module-2-mockup.webp"]) {
      const entry = manifest.assets.find((asset) => asset.file === file)!;
      expect(entry.problems, file).toContain("מסך מוצהר ביותר מרשומה אחת");
      expect(entry.status, file).toBe("rejected");
    }
    // Neither entry validated, so neither excuses the file they fought over.
    expect(manifest.ignoredFiles).toContain("screens/ch1-laptop.html");
  });

  it("reports a screens folder that holds nothing the plan declared, like any stray directory", async () => {
    const dir = await temporaryDirectory();
    await writeWebp(path.join(dir, "hero.webp"), 1);
    await fs.mkdir(path.join(dir, SCREENS_DIR));
    await fs.writeFile(path.join(dir, SCREENS_DIR, "rogue.html"), "<b>rogue</b>", "utf8");
    await writePlan(dir, [{ file: "hero.webp", kind: "photo" }]);

    const manifest = await validateAssetFolder(dir);

    expect(manifest.ignoredFiles).toEqual(["screens/", "screens/rogue.html"]);
  });

  // Acceptance 8, G2: the agent harness creates a `.claude/.cc-writes/` control
  // directory inside its own cwd, which is the assets folder. It belongs to the
  // sandbox, not to the attempt, so it is not material anyone has to declare.
  it("never lists the sandbox control directory among the undeclared files", async () => {
    const dir = await mockupDir();
    await fs.mkdir(path.join(dir, ".claude", ".cc-writes"), { recursive: true });

    const manifest = await validateAssetFolder(dir);

    expect(manifest.ignoredFiles).toEqual([]);
    expect(mockupOf(manifest).problems).toEqual([]);
    expect(mockupOf(manifest).status).toBe("approved");
  });

  // Acceptance 9, F9d: the next run created the same control directory a level
  // down, under `screens/`, because that is where the agent was working. An
  // exclusion that only held at the top of the folder made the harness's own
  // scaffolding an undeclared file again and rejected every mockup with it.
  // The directory belongs to the sandbox wherever it lands.
  it("never lists the sandbox control directory nested under the screens folder", async () => {
    const dir = await mockupDir();
    await fs.mkdir(path.join(dir, SCREENS_DIR, ".claude", ".cc-writes"), { recursive: true });

    const manifest = await validateAssetFolder(dir);

    expect(manifest.ignoredFiles).toEqual([]);
    expect(mockupOf(manifest).problems).toEqual([]);
    expect(mockupOf(manifest).status).toBe("approved");
  });

  // Whatever is inside it is not walked either, so a file planted there is
  // neither counted nor reported. Nothing can reach the page through it: the
  // builder only ever receives the assets the plan declared and the manifest
  // approved, and this directory declares nothing.
  it("walks nothing inside the nested sandbox directory, whatever was put there", async () => {
    const dir = await mockupDir();
    const control = path.join(dir, SCREENS_DIR, ".claude", ".cc-writes");
    await fs.mkdir(control, { recursive: true });
    await writeWebp(path.join(control, "planted.webp"), 7);
    await fs.writeFile(path.join(control, "planted.html"), "<b>rogue</b>", "utf8");

    const manifest = await validateAssetFolder(dir);

    expect(manifest.ignoredFiles).toEqual([]);
    expect(mockupOf(manifest).status).toBe("approved");
    expect(manifest.assets.map((asset) => asset.file)).not.toContain("planted.webp");
  });

  it("still reports a planted screen file while the nested sandbox directory is there", async () => {
    const dir = await mockupDir();
    await fs.mkdir(path.join(dir, SCREENS_DIR, ".claude", ".cc-writes"), { recursive: true });
    await fs.writeFile(path.join(dir, SCREENS_DIR, "x.html"), "<b>rogue</b>", "utf8");

    const manifest = await validateAssetFolder(dir);

    expect(manifest.ignoredFiles).toEqual(["screens/x.html"]);
    expect(mockupOf(manifest).status).toBe("rejected");
  });

  it("still reports a planted screen file while the sandbox directory is there", async () => {
    const dir = await mockupDir();
    await fs.mkdir(path.join(dir, ".claude", ".cc-writes"), { recursive: true });
    await fs.writeFile(path.join(dir, SCREENS_DIR, "x.html"), "<b>rogue</b>", "utf8");

    const manifest = await validateAssetFolder(dir);

    expect(manifest.ignoredFiles).toEqual(["screens/x.html"]);
    expect(mockupOf(manifest).status).toBe("rejected");
  });

  // A directory is still a stray entry the reviewer has to see, but calling it
  // an image file sends the agent hunting for a picture that does not exist.
  it("lists a stray directory without calling it an image file", async () => {
    const dir = await mockupDir();
    await fs.mkdir(path.join(dir, "junk"));

    const manifest = await validateAssetFolder(dir);

    expect(manifest.ignoredFiles).toEqual(["junk/"]);
    const problems = mockupOf(manifest).problems.join(" | ");
    expect(problems).toContain("junk/");
    expect(problems).not.toContain("קובצי תמונה לא מוצהרים");
    expect(mockupOf(manifest).status).toBe("rejected");
  });

  // The transparency rule stays whole for a mockup nothing rendered in this
  // attempt: only a receipt row turns transparency into the expected outcome.
  it("still demands an eye check for a transparent mockup with no render receipt", async () => {
    const dir = await mockupDir();
    await writeTransparentWebp(path.join(dir, "module-1-mockup.webp"));

    const manifest = await validateAssetFolder(dir);

    expect(mockupOf(manifest).status).toBe("review-required");
    expect(mockupOf(manifest).problems.join(" ")).toMatch(/שקיפות/);
  });

  /**
   * Task 16: the receipt binds a finished mockup file to THIS attempt's render.
   * Without one, or with one from another attempt, a mockup file left in the
   * folder could re-qualify without anything having rendered it.
   */
  describe("the render receipt", () => {
    const sha256 = async (file: string): Promise<string> =>
      createHash("sha256").update(await fs.readFile(file)).digest("hex");

    async function receiptFor(
      dir: string,
      over: Partial<MockupRenderReceiptEntry> = {},
      receiptOver: Partial<MockupRenderReceipt> = {},
    ): Promise<{ receipt: MockupRenderReceipt; acceptedScreens: string[] }> {
      return {
        receipt: {
          schemaVersion: 1,
          // The same attempt the plan on disk declares (writePlan).
          attemptId: "test-attempt",
          baseSha256: { chapter: "c".repeat(64) },
          mockups: [{
            file: "module-1-mockup.webp",
            screensSha256: {},
            outputSha256: await sha256(path.join(dir, "module-1-mockup.webp")),
            status: "ok",
            ...over,
          }],
          renderedAt: "2026-09-16T10:05:00.000Z",
          ...receiptOver,
        },
        acceptedScreens: ["ch1-laptop", "ch1-tablet"],
      };
    }

    it("approves a mockup the receipt of this attempt rendered", async () => {
      const dir = await mockupDir();

      const manifest = await validateAssetFolder(dir, { mockupReceipt: await receiptFor(dir) });

      expect(mockupOf(manifest).problems).toEqual([]);
      expect(mockupOf(manifest).status).toBe("approved");
      expect(manifest.ignoredFiles).toEqual([]);
    });

    it("rejects a mockup with no row in the receipt", async () => {
      const dir = await mockupDir();
      const context = await receiptFor(dir);

      const manifest = await validateAssetFolder(dir, {
        mockupReceipt: { ...context, receipt: { ...context.receipt, mockups: [] } },
      });

      expect(mockupOf(manifest).problems).toContain("מוקאפ מניסיון קודם או ללא רינדור");
      expect(mockupOf(manifest).status).toBe("rejected");
    });

    it("rejects a mockup whose row is rejected", async () => {
      const dir = await mockupDir();

      const manifest = await validateAssetFolder(dir, {
        mockupReceipt: await receiptFor(dir, { status: "rejected", outputSha256: undefined, reason: "הרינדור לא זמין" }),
      });

      expect(mockupOf(manifest).problems).toContain("מוקאפ מניסיון קודם או ללא רינדור");
      expect(mockupOf(manifest).status).toBe("rejected");
    });

    it("rejects a file whose digest is not the one the receipt recorded", async () => {
      const dir = await mockupDir();

      const manifest = await validateAssetFolder(dir, {
        mockupReceipt: await receiptFor(dir, { outputSha256: "f".repeat(64) }),
      });

      expect(mockupOf(manifest).problems).toContain("מוקאפ מניסיון קודם או ללא רינדור");
      expect(mockupOf(manifest).status).toBe("rejected");
    });

    it("rejects a receipt that belongs to another attempt, however right its rows look", async () => {
      const dir = await mockupDir();
      const context = await receiptFor(dir, {}, { attemptId: "attempt-previous" });

      const manifest = await validateAssetFolder(dir, { mockupReceipt: context });

      expect(mockupOf(manifest).problems).toContain("מוקאפ מניסיון קודם או ללא רינדור");
      expect(mockupOf(manifest).status).toBe("rejected");
    });

    // Acceptance 8, G1: composite.py drops the white background, so an
    // orchestrator-rendered mockup is transparent by design. Demanding an eye
    // check for it rejected every mockup the renderer itself had just approved.
    it("approves a transparent mockup whose receipt row is ok for this attempt", async () => {
      const dir = await mockupDir();
      await writeTransparentWebp(path.join(dir, "module-1-mockup.webp"));

      const manifest = await validateAssetFolder(dir, { mockupReceipt: await receiptFor(dir) });

      expect(mockupOf(manifest).problems).toEqual([]);
      expect(mockupOf(manifest).status).toBe("approved");
    });

    it("still demands an eye check for a photo with the same transparency", async () => {
      const dir = await mockupDir();
      await writeTransparentWebp(path.join(dir, "module-1-mockup.webp"));
      await writeTransparentWebp(path.join(dir, "presenter-portrait.webp"));

      const manifest = await validateAssetFolder(dir, { mockupReceipt: await receiptFor(dir) });

      const photo = manifest.assets.find((asset) => asset.file === "presenter-portrait.webp")!;
      expect(photo.status).toBe("review-required");
      expect(photo.problems.join(" ")).toMatch(/שקיפות/);
    });

    it("excuses only the screens that passed the render boundaries", async () => {
      const dir = await mockupDir();
      const context = await receiptFor(dir);

      const manifest = await validateAssetFolder(dir, {
        mockupReceipt: { ...context, acceptedScreens: ["ch1-laptop"] },
      });

      // The screen the renderer refused is an undeclared file like any other.
      expect(manifest.ignoredFiles).toEqual(["screens/ch1-tablet.html"]);
      expect(manifest.ignoredFiles).not.toContain("screens/ch1-laptop.html");
    });
  });

  /** Task 16: the rule the 5.2 gate refuses an approval on. */
  describe("missingRequiredMockups", () => {
    const row = (name: string, proves = "מה מקבלים בכל פרק") => ({ name, section: "Stack", proves });
    const asset = (file: string, over: Partial<AssetManifest["assets"][number]> = {}) => ({
      file,
      kind: "mockup" as const,
      status: "approved" as const,
      sha256: "a".repeat(64),
      problems: [],
      previewable: true,
      section: "Stack",
      proves: "מה מקבלים בכל פרק",
      ...over,
    });

    it("matches by the approved placement, trimmed, and accepts a review-required mockup", () => {
      expect(missingRequiredMockups([asset("m1.webp", { section: " Stack " })], [row("module-1")])).toEqual([]);
      expect(missingRequiredMockups([asset("m1.webp", { status: "review-required" })], [row("module-1")])).toEqual([]);
      expect(missingRequiredMockups([asset("m1.webp", { status: "rejected" })], [row("module-1")])).toEqual(["module-1"]);
      expect(missingRequiredMockups([asset("m1.webp", { kind: "photo" })], [row("module-1")])).toEqual(["module-1"]);
      expect(missingRequiredMockups([], [row("module-1")])).toEqual(["module-1"]);
    });

    it("gives every required row its own mockup", () => {
      const rows = [row("module-1"), row("module-2")];

      // Two rows with the same section and claim need two files.
      expect(missingRequiredMockups([asset("m1.webp")], rows)).toEqual(["module-2"]);
      expect(missingRequiredMockups([asset("m1.webp"), asset("m2.webp")], rows)).toEqual([]);
    });
  });

  it("rejects a tampered render declaration when loading an existing manifest", async () => {
    const dir = await mockupDir();
    await validateAssetFolderSnapshot(dir);
    const persisted = JSON.parse(await fs.readFile(path.join(dir, ASSET_MANIFEST_NAME), "utf8"));
    persisted.assets.find((asset: { file: string }) => asset.file === "module-1-mockup.webp").render = {
      base: "../../etc",
      map: {},
    };
    await fs.writeFile(path.join(dir, ASSET_MANIFEST_NAME), JSON.stringify(persisted));

    await expect(readApprovedAssetFiles(dir)).rejects.toThrow(/render/i);
  });
});
