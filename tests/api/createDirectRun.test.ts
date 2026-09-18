import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const started = vi.hoisted(() => ({ discussion: vi.fn(), stage: vi.fn() }));
vi.mock("@/orchestrator/runDiscussion", () => ({
  startDiscussionExecution: vi.fn(async (id: string) => { started.discussion(id); return { ok: true, attemptId: "d" }; }),
}));
vi.mock("@/orchestrator/runStage", () => ({
  startStageExecution: vi.fn(async (id: string, _dir: string, n: number) => { started.stage(id, n); return { ok: true, attemptId: "s" }; }),
}));
vi.mock("@/config/clientProfile", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/config/clientProfile")>();
  return { ...mod, loadClientProfile: vi.fn(async () => mod.validateClientProfile({
    schemaVersion: 1,
    tenant: { id: "acme", displayName: "Acme", locale: "he-IL", timezone: "Asia/Jerusalem" },
    brand: { publicName: "Acme", facts: ["עובדה מאומתת"] },
    policies: { contentRules: [], advertisingRules: [], operationalRules: [],
      capabilities: { landingPageBuild: true, metaPixelRead: false, metaCampaignCreatePaused: false } },
    copy: { pageTypesDir: process.env.TEST_PAGE_TYPES_DIR },
  })) };
});

import { POST } from "@/app/api/runs/route";
import { getRun, __resetRegistryForTests, flushPersistence } from "@/orchestrator/runRegistry";

let runsDir: string;
beforeEach(async () => {
  runsDir = await fs.mkdtemp(path.join(os.tmpdir(), "council-create-direct-"));
  process.env.RUNS_DIR_OVERRIDE = runsDir;
  process.env.TEST_PAGE_TYPES_DIR = path.join(runsDir, "page-types");
  await fs.mkdir(process.env.TEST_PAGE_TYPES_DIR, { recursive: true });
  __resetRegistryForTests();
  started.discussion.mockClear(); started.stage.mockClear();
});
afterEach(async () => {
  await flushPersistence(); __resetRegistryForTests();
  delete process.env.RUNS_DIR_OVERRIDE; delete process.env.TEST_PAGE_TYPES_DIR;
  await fs.rm(runsDir, { recursive: true, force: true, maxRetries: 5 });
});

function post(body: Record<string, unknown>) {
  return POST(new NextRequest("http://127.0.0.1:4321/api/runs", {
    method: "POST", headers: { "Content-Type": "application/json", Origin: "http://127.0.0.1:4321", "X-Campaign-Council-Request": "1" },
    body: JSON.stringify(body),
  }));
}

describe("POST /api/runs with pipeline=direct", () => {
  it("skips the discussion, initialises the direct ladder and starts stage 1", async () => {
    const res = await post({ brief: "דף מכירה לתוכנית של מיכל אדר, האתר: https://example.com", assetType: "sales-page", pipeline: "direct" });
    expect(res.status).toBe(202);
    const { id } = await res.json();
    const run = getRun(id)!;
    expect(run.pipeline).toBe("direct");
    expect(run.status).toBe("approved");
    expect(run.stages?.map((s) => s.number)).toEqual([1, 2, 3, 5]);
    expect(started.discussion).not.toHaveBeenCalled();
    expect(started.stage).toHaveBeenCalledWith(id, 1);
  });

  it("accepts a site URL written with an uppercase scheme", async () => {
    const res = await post({ brief: "דף מכירה לתוכנית, האתר: HTTPS://Example.com", pipeline: "direct" });
    expect(res.status).toBe(202);
    expect(started.stage).toHaveBeenCalledTimes(1);
  });

  it("refuses a direct brief without a site URL", async () => {
    const res = await post({ brief: "דף מכירה לתוכנית של מיכל אדר בלי כתובת", pipeline: "direct" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/כתובת/);
    expect(started.stage).not.toHaveBeenCalled();
  });

  it("refuses a direct run of a non-sales page type whose template is missing", async () => {
    const res = await post({ brief: "סקוויז https://example.com", assetType: "squeeze-page", pipeline: "direct" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/תבנית/);
  });

  it("still runs the discussion for a council run", async () => {
    const res = await post({ brief: "בריף רגיל של עשרה תווים לפחות" });
    expect(res.status).toBe(202);
    expect(started.discussion).toHaveBeenCalledTimes(1);
    expect(started.stage).not.toHaveBeenCalled();
  });
});
