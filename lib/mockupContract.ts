/**
 * The shape rules of the 5.2 mockup contract, in one place.
 *
 * The plan validation (orchestrator/assetQuality.ts), the renderer
 * (orchestrator/mockupRenderer.ts) and the run-state validator (lib/runStore.ts)
 * all have to agree on what a screen name is, which base frames exist and how
 * many mockups one attempt may declare. They used to keep private copies that
 * could only drift apart in silence, so the constants live here, where both
 * lib/ and orchestrator/ can import them.
 */

/**
 * The character budget of a screen name and of a required mockup's name: the
 * two are the same identifier in different places of the contract.
 */
export const MAX_MOCKUP_NAME_CHARS = 60;

/** A screen name: the agent names an HTML file `<name>.html` under screens/. */
export const SCREEN_NAME_RE = new RegExp(`^[A-Za-z0-9._-]{1,${MAX_MOCKUP_NAME_CHARS}}$`);

/**
 * The markup of one screen, counted without its embedded images: a screen is a
 * device screen, not a document, and the pictures on it have a budget of their
 * own. A file bigger than both budgets together is never even read.
 */
export const MAX_SCREEN_HTML_BYTES = 512 * 1024;
/** The embedded images and fonts of one mockup, across all of its screens. */
export const MAX_SCREEN_DATA_BYTES = 15 * 1024 * 1024;

/**
 * The most mockups one design brief may require of a single 5.2 attempt. A
 * longer list is discarded whole, and a page type that requires mockups stops
 * on it before the agent runs.
 */
export const MAX_REQUIRED_MOCKUPS = 24;

/**
 * The most screens one mockup may declare, and therefore the most regions its
 * `render.map` may fill.
 *
 * It is also the ceiling on the hashes one receipt row records: the run-state
 * validator refuses a hash record over 512 entries, and a receipt it refuses
 * stops the whole run from persisting. The plan validator rejects a longer
 * list, the renderer hashes no more than this many, and the stored receipt is
 * clamped to it, so the three agree by construction.
 */
export const MAX_RENDER_REGIONS = 16;

/**
 * A region id, as `render.map` spells it: the number detect_screens.py gave
 * the region, as a string of digits. composite.py receives it as an integer,
 * so anything else is a map the renderer could never act on, and the plan
 * validator says so on the sheet instead of leaving it to the render.
 */
export const REGION_ID_RE = /^\d+$/;

/**
 * The image formats a mockup file may be written in.
 *
 * composite.py saves an RGBA image by the output's extension: JPEG has no
 * alpha channel and raises, and AVIF has no encoder in the pinned Pillow. A
 * mockup declared with either is rejected by the composite every single time,
 * so the plan validator refuses it up front, with a reason the agent can act
 * on.
 */
export const MOCKUP_FILE_RE = /\.(?:webp|png)$/i;

/**
 * The characters of a receipt row's file name, as the run state stores it.
 *
 * The name comes from the agent's plan, and run.json is shape-validated on
 * every write: an over-long name must cost a truncated field, never the
 * ability to save the run. The writer (orchestrator/runStage5Assets.ts) clamps
 * to it and the validator (lib/runStore.ts) enforces it, so it lives here,
 * where both can read the same number.
 */
export const MAX_RECEIPT_FILE_CHARS = 256;

/** The packaged base frames a mockup may be composited onto. */
export const MOCKUP_RENDER_BASES = ["devices", "chapter"] as const;
export type MockupRenderBase = (typeof MOCKUP_RENDER_BASES)[number];

/** Whether a string names one of the packaged base frames. */
export function isMockupRenderBase(value: unknown): value is MockupRenderBase {
  return (MOCKUP_RENDER_BASES as readonly unknown[]).includes(value);
}

/**
 * The files one asset plan may declare, and therefore the most rows a render
 * receipt can carry: one per declared mockup.
 */
export const MAX_ASSET_COUNT = 80;
