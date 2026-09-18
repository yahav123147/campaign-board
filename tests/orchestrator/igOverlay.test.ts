import { describe, expect, it } from "vitest";
// The capture script's page half, as a module: a plain fake DOM stands in for
// the browser, so the overlay rules are stated here instead of being reachable
// only through a live Instagram page.
import { DISMISS_LABELS, MAX_OVERLAY_PASSES, OBSTRUCTED_MESSAGE, clearOverlaysAndProve } from "@/vendor/landing-skill/scripts/igOverlay.mjs";

const COUNT_PATTERN = { source: "(\\d[\\d.,]*)\\s*(K|M|אלף)?\\s*(?:עוקבים|followers)", flags: "i" };

interface FakeNode {
  name: string;
  innerText: string;
  position: string;
  parentElement: FakeNode | null;
  rect: { left: number; top: number; width: number; height: number };
  removed: boolean;
  clicked: boolean;
  getBoundingClientRect(): { left: number; top: number; width: number; height: number; right: number; bottom: number };
  contains(other: unknown): boolean;
  remove(): void;
  click(): void;
}

function node(name: string, props: Partial<FakeNode> = {}): FakeNode {
  const self: FakeNode = {
    name,
    innerText: "",
    position: "static",
    parentElement: null,
    rect: { left: 0, top: 0, width: 0, height: 0 },
    removed: false,
    clicked: false,
    getBoundingClientRect() {
      const r = self.rect;
      return { left: r.left, top: r.top, width: r.width, height: r.height, right: r.left + r.width, bottom: r.top + r.height };
    },
    contains(other: unknown) {
      return other === self;
    },
    remove() {
      self.removed = true;
    },
    click() {
      self.clicked = true;
    },
    ...props,
  };
  return self;
}

interface WorldOptions {
  /** An overlay that sits over the count. */
  overlay?: FakeNode;
  /** A sheet that stays over the count however many times it is removed. */
  persistent?: boolean;
  dialogs?: FakeNode[];
  buttons?: FakeNode[];
  countRect?: { left: number; top: number; width: number; height: number };
}

function world(options: WorldOptions = {}) {
  const body = node("body");
  const count = node("count", {
    innerText: "12.3K עוקבים",
    rect: options.countRect ?? { left: 20, top: 200, width: 120, height: 20 },
  });
  count.parentElement = body;
  const dialogs = options.dialogs ?? [];
  const buttons = options.buttons ?? [];
  const overlay = options.overlay;
  if (overlay) overlay.parentElement = body;
  const doc = {
    body: Object.assign(body, { style: {} as Record<string, string> }),
    documentElement: node("html"),
    querySelectorAll(selector: string): FakeNode[] {
      if (selector.includes("dialog")) return dialogs.filter((d) => !d.removed);
      if (selector.includes("button")) return buttons.filter((b) => !b.removed);
      if (selector.includes("span")) return [count];
      return [];
    },
    elementFromPoint(): FakeNode {
      const covering = overlay && !overlay.clicked && (options.persistent || !overlay.removed);
      return covering ? overlay! : count;
    },
  };
  const win = {
    innerWidth: 430,
    innerHeight: 932,
    getComputedStyle: (el: FakeNode) => ({ position: el.position }),
  };
  return { doc, win, count, overlay, body };
}

function run(scene: ReturnType<typeof world>) {
  return clearOverlaysAndProve({
    doc: scene.doc,
    win: scene.win,
    labels: DISMISS_LABELS,
    maxPasses: MAX_OVERLAY_PASSES,
    countPattern: COUNT_PATTERN,
  }) as { dismissed: number; visible: boolean; reason: string };
}

describe("clearOverlaysAndProve", () => {
  it("proves an unobstructed count without dismissing anything", () => {
    const scene = world();

    const result = run(scene);

    expect(result).toMatchObject({ visible: true, dismissed: 0 });
  });

  it("removes the classified dialogs and releases the body scroll", () => {
    const scene = world({ dialogs: [node("login-dialog"), node("presentation")] });

    const result = run(scene);

    expect(result.visible).toBe(true);
    expect(result.dismissed).toBe(2);
    expect(scene.doc.body.style.overflow).toBe("auto");
  });

  it.each(DISMISS_LABELS as string[])(
    "clicks the sheet's %s button instead of leaving it over the profile",
    (label) => {
      const sheet = node("save-login", { position: "fixed" });
      const button = node("not-now", { innerText: ` ${label} ` });
      const scene = world({ overlay: sheet, buttons: [button] });
      // The button belongs to the sheet: clicking it takes the sheet away.
      button.click = () => {
        button.clicked = true;
        sheet.clicked = true;
      };

      const result = run(scene);

      expect(button.clicked).toBe(true);
      expect(result).toMatchObject({ visible: true, dismissed: 1 });
    },
  );

  it("removes the outermost fixed ancestor of a sheet that answers to no button", () => {
    const sheet = node("save-login-sheet", { position: "fixed" });
    const scene = world({ overlay: sheet });

    const result = run(scene);

    expect(sheet.removed).toBe(true);
    expect(result).toMatchObject({ visible: true, dismissed: 1 });
  });

  it("refuses a sheet that covers the count however often it is removed", () => {
    const sheet = node("stubborn", { position: "fixed" });
    const scene = world({ overlay: sheet, persistent: true });

    const result = run(scene);

    expect(result.visible).toBe(false);
    expect(result.reason).toBe("covered");
  });

  it("refuses an overlay it cannot attribute to a positioned ancestor", () => {
    const scene = world({ overlay: node("inline-cover") });

    const result = run(scene);

    expect(result).toMatchObject({ visible: false, reason: "covered" });
  });

  it("refuses a count that was scrolled out of the viewport", () => {
    const scene = world({ countRect: { left: 20, top: 1_400, width: 120, height: 20 } });

    const result = run(scene);

    expect(result).toMatchObject({ visible: false, reason: "out-of-view" });
  });

  it("refuses a page whose count element is not in the DOM at all", () => {
    const scene = world();
    scene.doc.querySelectorAll = () => [];

    const result = run(scene);

    expect(result).toMatchObject({ visible: false, reason: "no-count" });
  });

  it("states the refusal in Hebrew, with no em-dash", () => {
    expect(OBSTRUCTED_MESSAGE).toBe("הפרופיל מוסתר על ידי חלון קופץ ולא צולם");
    expect(OBSTRUCTED_MESSAGE).not.toContain("—");
  });
});
