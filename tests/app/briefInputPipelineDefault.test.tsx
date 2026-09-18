// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

import { BriefInput } from "@/components/BriefInput";

const config = { body: { pipelineDefault: "direct" } as unknown, ok: true };

beforeEach(() => {
  config.body = { pipelineDefault: "direct" };
  config.ok = true;
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: config.ok,
    json: async () => config.body,
  })));
});
// globals are off in vitest.config.mts, so the automatic cleanup hook is
// never registered and each render would stack on the previous one.
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const pipelineButton = (label: string) => screen.getByRole("button", { name: new RegExp(label) });

describe("BriefInput pipeline default", () => {
  it("seeds the selection from GET /api/config", async () => {
    render(<BriefInput />);

    // Until the profile answers, the safe default stays selected.
    expect(pipelineButton("מועצה").getAttribute("aria-pressed")).toBe("true");
    await waitFor(() => expect(pipelineButton("דף נחיתה בלחיצת כפתור").getAttribute("aria-pressed")).toBe("true"));
    expect(pipelineButton("מועצה").getAttribute("aria-pressed")).toBe("false");
    expect(vi.mocked(fetch).mock.calls[0]![0]).toBe("/api/config");
  });

  it("keeps council when the profile cannot be read", async () => {
    config.ok = false;
    config.body = { error: "פרופיל הלקוח לא נטען" };

    render(<BriefInput />);

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(pipelineButton("מועצה").getAttribute("aria-pressed")).toBe("true");
  });
});
