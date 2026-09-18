import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

vi.mock("@/orchestrator/runDiscussion", () => ({
  startDiscussionExecution: vi.fn(async () => ({ ok: true, attemptId: "attempt-test" })),
}));

import { POST as createRunRoute } from "@/app/api/runs/route";
import { __resetRegistryForTests, flushPersistence, getRun } from "@/orchestrator/runRegistry";
import { readRunPageTypeBlueprint } from "@/orchestrator/pageTypeBlueprint";
import type { Run } from "@/types";

/**
 * F1: a run must read page-type templates from the folder that belonged to the
 * profile it was created with. Resolving the folder from the live environment
 * at call time let a run of one client, resumed after the app was pointed at
 * another client's profile, pull that other client's private templates.
 */
const PROFILE_ENV = "CAMPAIGN_COUNCIL_CLIENT_PROFILE";
let workDir: string;
let runsDir: string;
let savedProfileEnv: string | undefined;

async function writeClient(name: string, blueprint: string): Promise<string> {
  const dir = path.join(workDir, name);
  await fs.mkdir(path.join(dir, "page-types"), { recursive: true });
  await fs.writeFile(path.join(dir, "page-types", "webinar-page.md"), blueprint, "utf8");
  const profilePath = path.join(dir, "client-profile.json");
  await fs.writeFile(profilePath, JSON.stringify({
    schemaVersion: 1,
    tenant: { id: name, displayName: name, locale: "he-IL", timezone: "Asia/Jerusalem" },
    brand: { publicName: name, facts: ["עובדה מאומתת"] },
    policies: {
      contentRules: [],
      advertisingRules: [],
      operationalRules: [],
      capabilities: { landingPageBuild: false, metaPixelRead: false, metaCampaignCreatePaused: false },
    },
  }), "utf8");
  return profilePath;
}

function createRequest(): NextRequest {
  return new NextRequest("http://127.0.0.1:3000/api/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ brief: "בריף ארוך מספיק לבדיקה של יצירת ריצה", assetType: "webinar-page" }),
  });
}

beforeEach(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), "council-run-page-types-"));
  runsDir = path.join(workDir, "runs");
  await fs.mkdir(runsDir, { recursive: true });
  process.env.RUNS_DIR_OVERRIDE = runsDir;
  savedProfileEnv = process.env[PROFILE_ENV];
  __resetRegistryForTests();
});

afterEach(async () => {
  await flushPersistence().catch(() => undefined);
  __resetRegistryForTests();
  if (savedProfileEnv === undefined) delete process.env[PROFILE_ENV];
  else process.env[PROFILE_ENV] = savedProfileEnv;
  delete process.env.RUNS_DIR_OVERRIDE;
  await fs.rm(workDir, { recursive: true, force: true, maxRetries: 5 });
});

describe("a run keeps the page-type folder of the profile it was created with", () => {
  it("stores the resolved folder at creation and keeps reading it after the environment moves", async () => {
    const clientA = await writeClient("client-a", "## מבנה\nתבנית של לקוח א");
    const clientB = await writeClient("client-b", "## מבנה\nתבנית פרטית של לקוח ב");
    process.env[PROFILE_ENV] = clientA;

    const response = await createRunRoute(createRequest());
    expect(response.status).toBe(202);
    const { id } = await response.json() as { id: string };
    const run = getRun(id)!;
    expect(run.pageTypesDir).toBe(path.join(workDir, "client-a", "page-types"));

    // The app restarts pointed at another client's profile.
    process.env[PROFILE_ENV] = clientB;

    const blueprint = await readRunPageTypeBlueprint(run);
    expect(blueprint).toContain("תבנית של לקוח א");
    expect(blueprint).not.toContain("לקוח ב");
  });

  it("gives a legacy run with no stored folder no blueprint, even when the environment has one", async () => {
    process.env[PROFILE_ENV] = await writeClient("client-b", "## מבנה\nתבנית פרטית של לקוח ב");
    const legacy: Run = {
      id: "2026-09-06-141304", slug: "legacy", brief: "בריף", createdAt: "2026-09-06T14:13:04.000Z",
      status: "approved", currentRound: null, messages: [], assetType: "webinar-page",
    };

    await expect(readRunPageTypeBlueprint(legacy)).resolves.toBe("");
  });
});
