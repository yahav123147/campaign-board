import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { MOCKUP_RENDER_BASES, type MockupRenderBase } from "@/lib/mockupContract";
import { mockupBaseFile, mockupCacheRoot, packagedMockupBasesDir } from "@/orchestrator/mockupRenderer";

/**
 * The regions detect_screens.py finds in the packaged base frames, and a way to
 * put them in the renderer's cache.
 *
 * The 5.2 prompt reads the regions at prompt-build time, and a prompt test
 * must not depend on a python with numpy and scipy being installed on the
 * machine running the suite. Seeding the cache exercises the same path the
 * orchestrator takes on a second run: the cache is keyed by the frame's
 * sha256, computed here from the frame on disk, so the seed is always the one
 * that is read back.
 */
export const PACKAGED_BASE_REGIONS: Record<MockupRenderBase, { id: number; x0: number; x1: number; y0: number; y1: number }[]> = {
  // Laptop, then phone.
  devices: [
    { id: 1, x0: 120, x1: 1719, y0: 200, y1: 1199 },
    { id: 2, x0: 1840, x1: 2199, y0: 310, y1: 1089 },
  ],
  // One tablet.
  chapter: [{ id: 1, x0: 200, x1: 1399, y0: 200, y1: 1799 }],
};

/** The size a screen must be rendered at to fill that region, at scale 2. */
export function seededScreenSize(base: MockupRenderBase, id: number): [number, number] {
  const region = PACKAGED_BASE_REGIONS[base].find((candidate) => candidate.id === id)!;
  return [(region.x1 - region.x0 + 1) * 2, (region.y1 - region.y0 + 1) * 2];
}

/**
 * Write a regions cache for the packaged frames. Set
 * CAMPAIGN_COUNCIL_MOCKUP_CACHE_DIR to a temp directory first, or this writes
 * into the real cache.
 */
export async function seedPackagedMockupRegions(): Promise<void> {
  for (const base of MOCKUP_RENDER_BASES) {
    const file = mockupBaseFile(packagedMockupBasesDir(), base);
    const sha256 = createHash("sha256").update(await fs.readFile(file)).digest("hex");
    const cacheDir = path.join(mockupCacheRoot(), sha256);
    await fs.mkdir(cacheDir, { recursive: true });
    const labels = path.join(cacheDir, "labels.npy");
    await fs.writeFile(labels, "labels");
    await fs.writeFile(
      path.join(cacheDir, "regions.json"),
      JSON.stringify({ schemaVersion: 1, baseSha256: sha256, labels, regions: PACKAGED_BASE_REGIONS[base] }),
    );
  }
}

/**
 * The frames the geometry above was read off. Asserted by a test, so a
 * replaced base frame fails loudly instead of leaving the prompt suites
 * asserting a geometry the installation no longer has.
 */
export const PACKAGED_BASE_SHA256: Record<MockupRenderBase, string> = {
  devices: "991d4de4b82b6a6741e931611e70e1a487635659bd2d4dee369269e1bf319b44",
  chapter: "61f26322a8cd6a6105c8b073d5d22e083561aa909aa6619346a914889e7b0551",
};

/** The sha256 of a packaged base frame as it is installed right now. */
export async function packagedBaseSha256(base: MockupRenderBase): Promise<string> {
  const file = mockupBaseFile(packagedMockupBasesDir(), base);
  return createHash("sha256").update(await fs.readFile(file)).digest("hex");
}
