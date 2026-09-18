import { describe, expect, it } from "vitest";
import {
  CENTRE_TOLERANCE_PX,
  intersectHorizontally,
  isBrokenZeroHeight,
  isOffCentre,
  visibleCentreOffset,
  visibleRect,
} from "../../vendor/landing-skill/scripts/visibleBox.mjs";

// The numbers are the ones the acceptance page produced at 390px: a press
// collage deliberately rendered at 106.13% of its frame and anchored to the
// start edge, so the crop falls on the other side. Its own rectangle is 10px
// off centre; the frame that clips it is centred exactly.
const VIEWPORT = 390;
const CROPPED_IMAGE = { left: 28, right: 382 };
const CENTRED_FRAME = { left: 28, right: 362 };

describe("visible box", () => {
  it("reads a deliberately cropped image by the frame that clips it", () => {
    expect(visibleCentreOffset(CROPPED_IMAGE, [CENTRED_FRAME], VIEWPORT)).toBe(0);
    expect(isOffCentre(CROPPED_IMAGE, [CENTRED_FRAME], VIEWPORT)).toBe(false);
  });

  it("still reports the same image when nothing clips it", () => {
    expect(visibleCentreOffset(CROPPED_IMAGE, [], VIEWPORT)).toBe(10);
    expect(isOffCentre(CROPPED_IMAGE, [], VIEWPORT)).toBe(true);
  });

  it("still catches a genuinely crooked figure inside a clipping frame", () => {
    const shifted = { left: 120, right: 380 };
    const frame = { left: 100, right: 380 };
    expect(visibleCentreOffset(shifted, [frame], VIEWPORT)).toBe(55);
    expect(isOffCentre(shifted, [frame], VIEWPORT)).toBe(true);
  });

  it("forgives an offset inside the tolerance", () => {
    const nearlyCentred = { left: 28 + CENTRE_TOLERANCE_PX, right: 362 + CENTRE_TOLERANCE_PX };
    expect(isOffCentre(nearlyCentred, [], VIEWPORT)).toBe(false);
  });

  it("applies every clipping frame, innermost or outermost", () => {
    expect(visibleRect(CROPPED_IMAGE, [{ left: 0, right: 390 }, CENTRED_FRAME]))
      .toEqual({ left: 28, right: 362 });
  });

  it("measures nothing when a frame leaves nothing visible", () => {
    expect(visibleRect(CROPPED_IMAGE, [{ left: 500, right: 600 }])).toBeUndefined();
    expect(visibleCentreOffset(CROPPED_IMAGE, [{ left: 500, right: 600 }], VIEWPORT)).toBeUndefined();
    expect(isOffCentre(CROPPED_IMAGE, [{ left: 500, right: 600 }], VIEWPORT)).toBe(false);
  });

  it("measures nothing from a rectangle the browser could not give a width for", () => {
    expect(visibleRect({ left: 40, right: 40 }, [])).toBeUndefined();
    expect(visibleRect(undefined, [])).toBeUndefined();
    expect(intersectHorizontally(undefined, CENTRED_FRAME)).toBeUndefined();
    expect(visibleCentreOffset(CROPPED_IMAGE, [], 0)).toBeUndefined();
  });
});

// The acceptance page ships the hero portrait twice, once in a figure shown
// only on narrow screens and once in a figure shown only on wide ones, so at
// every width exactly one of them measures no height.
describe("zero height images", () => {
  it("forgives a responsive variant the layout has put away", () => {
    expect(isBrokenZeroHeight({ height: 0, laidOut: false })).toBe(false);
  });

  it("still reports an image the layout placed that renders no height", () => {
    expect(isBrokenZeroHeight({ height: 0, laidOut: true })).toBe(true);
  });

  it("says nothing about an image that has height", () => {
    expect(isBrokenZeroHeight({ height: 320, laidOut: true })).toBe(false);
    expect(isBrokenZeroHeight({ height: 320, laidOut: false })).toBe(false);
  });

  it("measures nothing from no measurement at all", () => {
    expect(isBrokenZeroHeight(undefined)).toBe(false);
  });
});
