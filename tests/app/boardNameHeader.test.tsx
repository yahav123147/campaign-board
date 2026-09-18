// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

import { BriefInput } from "@/components/BriefInput";
import { BoardNameProvider } from "@/components/BoardNameProvider";
import { DEFAULT_BOARD_NAME } from "@/lib/boardName";

/**
 * The board's name is configuration, not source: the packaging scanner refuses
 * any packaged text file carrying a tenant's brand name, so the installation's
 * own name reaches the header from the root layout, which resolves it from the
 * client profile on the server.
 *
 * It is provided rather than fetched. Fetching it painted the neutral default
 * first and swapped a moment later, a visible flash on every page load.
 */
beforeEach(() => {
  // The brief form fetches its pipeline default separately; the name must not
  // depend on that request answering, or on it answering at all.
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ pipelineDefault: "council" }) })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const heading = () => screen.getByRole("heading", { level: 1 });

describe("the board name in the header", () => {
  it("renders the provided name immediately, with no intermediate default", () => {
    render(<BoardNameProvider value="הבורד של הלקוח"><BriefInput /></BoardNameProvider>);
    expect(heading().textContent).toBe("הבורד של הלקוח");
  });

  it("falls back to the neutral default with no provider in the tree", () => {
    render(<BriefInput />);
    expect(heading().textContent).toBe(DEFAULT_BOARD_NAME);
  });

  it("shows the neutral default when the installation names no board", () => {
    render(<BoardNameProvider value={DEFAULT_BOARD_NAME}><BriefInput /></BoardNameProvider>);
    expect(heading().textContent).toBe(DEFAULT_BOARD_NAME);
  });
});
