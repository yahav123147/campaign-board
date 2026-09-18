import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AssetManifestEntry } from "@/orchestrator/assetQuality";
import type { Run, StageStatus } from "@/types";

const { finalizeMock } = vi.hoisted(() => ({ finalizeMock: vi.fn(async () => {}) }));

vi.mock("@/orchestrator/runStage", () => ({ finalizeStageIfComplete: finalizeMock, startStageExecution: vi.fn() }));
vi.mock("@/orchestrator/runStage5Preview", () => ({ deliverStage5LandingPage: vi.fn() }));
vi.mock("@/orchestrator/runSubTask", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/orchestrator/runSubTask")>()),
  startSubTaskExecution: vi.fn(async () => ({ ok: true as const, attemptId: "attempt-5-3" })),
}));

import { POST } from "@/app/api/runs/[id]/stages/[n]/subtasks/[subId]/decide/route";
import { __resetRegistryForTests, createRun, flushPersistence, getRun } from "@/orchestrator/runRegistry";
import { initializeStages } from "@/orchestrator/initializeStages";
import { createRunDir } from "@/lib/runStore";

const REQUIRED_MOCKUPS = [
  { name: "module-1", section: "Stack", proves: "מה מקבלים בפרק הראשון", base: "chapter" },
  { name: "program-stack", section: "Stack", proves: "כל מה שנכנס לתוכנית", base: "devices" },
];

const BRIEF = "כיוון עיצוב לאקמה.\n```json\n" + JSON.stringify({
  playbook: "Dark Premium",
  imageMap: [{ harvestFile: "raw/01-portrait.jpg", section: "Hero", proves: "המנחה שבנתה את השיטה" }],
  requiredMockups: REQUIRED_MOCKUPS,
}) + "\n```";

const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

function entry(over: Partial<AssetManifestEntry>): AssetManifestEntry {
  return {
    file: "x.webp",
    kind: "photo",
    status: "approved",
    sha256: "",
    problems: [],
    previewable: true,
    ...over,
  };
}

/** The two rendered mockups of a good attempt, plus the photo of the image map. */
function fullAssets(): AssetManifestEntry[] {
  return [
    entry({ file: "hero.webp", section: "Hero", proves: "המנחה שבנתה את השיטה", harvestFile: "raw/01-portrait.jpg" }),
    entry({ file: "module-1-mockup.webp", kind: "mockup", section: "Stack", proves: "מה מקבלים בפרק הראשון" }),
    entry({ file: "program-stack.webp", kind: "mockup", section: "Stack", proves: "כל מה שנכנס לתוכנית" }),
  ];
}

let runsDir: string;

function directRun(id: string, designBrief: string): Run {
  const statuses = new Map<string, StageStatus>([["5.2", "awaiting-decision"]]);
  const stages = initializeStages("sales-page", "direct").map((stage) => (stage.number < 5
    ? {
        ...stage,
        status: "approved" as const,
        output: `פלט ${stage.number}`,
        subTasks: stage.subTasks.map((sub) => ({
          ...sub,
          status: "approved" as const,
          output: sub.id === "3" ? designBrief : `פלט ${sub.id}`,
        })),
      }
    : {
        ...stage,
        status: "running" as const,
        subTasks: stage.subTasks.map((sub) => ({
          ...sub,
          status: statuses.get(sub.id) ?? ("pending" as const),
          output: sub.id === "5.2" ? "גיליון הנכסים" : "",
        })),
      }));
  return {
    id,
    slug: "sales",
    brief: "בריף לבדיקה של אקמה https://acme.example",
    createdAt: "2026-09-16T10:00:00.000Z",
    status: "approved",
    currentRound: null,
    messages: [],
    currentStage: 5,
    assetType: "sales-page",
    pipeline: "direct",
    stages,
  };
}

/**
 * A run whose 5.2 sits at the gate over a real assets folder: the files, the
 * manifest the sheet was built from, and the sheet itself, all digest-bound
 * exactly as runStage5Assets leaves them.
 */
async function prepareGate(id: string, assets: AssetManifestEntry[], designBrief = BRIEF): Promise<void> {
  const runDir = await createRunDir(id);
  const assetsDir = path.join(runDir, "assets");
  await fs.mkdir(assetsDir, { recursive: true });
  const sealed = [] as AssetManifestEntry[];
  for (const asset of assets) {
    const bytes = `bytes-of-${asset.file}`;
    if (asset.status !== "rejected") await fs.writeFile(path.join(assetsDir, asset.file), bytes);
    sealed.push({ ...asset, sha256: sha256(bytes) });
  }
  const manifest = JSON.stringify({
    schemaVersion: 1,
    generatedAt: "2026-09-16T10:05:00.000Z",
    attemptId: "attempt-under-test",
    ignoredFiles: [],
    assets: sealed,
  }, null, 2);
  await fs.writeFile(path.join(assetsDir, "asset-manifest.json"), manifest);
  const sheetFile = "contact-sheet-attempt-under-test.html";
  const sheetHtml = "<html>גיליון</html>";
  await fs.writeFile(path.join(assetsDir, sheetFile), sheetHtml);

  const run = directRun(id, designBrief);
  const subTask = run.stages![0].subTasks.find(() => false)
    ?? run.stages!.find((stage) => stage.number === 5)!.subTasks.find((task) => task.id === "5.2")!;
  subTask.assetManifestDraftSha256 = sha256(manifest);
  subTask.assetContactSheetFile = sheetFile;
  subTask.assetContactSheetSha256 = sha256(sheetHtml);
  createRun(run);
  await flushPersistence();
}

function decide(id: string) {
  return POST(
    new NextRequest(`http://127.0.0.1:3000/api/runs/${id}/stages/5/subtasks/5.2/decide`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "approve" }),
    }),
    { params: Promise.resolve({ id, n: "5", subId: "5.2" }) },
  );
}

function status52(id: string) {
  return getRun(id)?.stages?.find((stage) => stage.number === 5)?.subTasks.find((task) => task.id === "5.2")?.status;
}

beforeEach(async () => {
  runsDir = await fs.mkdtemp(path.join(os.tmpdir(), "council-stage52-mockup-gate-"));
  process.env.RUNS_DIR_OVERRIDE = runsDir;
  __resetRegistryForTests();
  finalizeMock.mockClear();
});

afterEach(async () => {
  await flushPersistence();
  __resetRegistryForTests();
  delete process.env.RUNS_DIR_OVERRIDE;
  await fs.rm(runsDir, { recursive: true, force: true, maxRetries: 5 });
});

describe("the 5.2 gate and the required mockups", () => {
  it("approves when every required mockup is in the sealed manifest", async () => {
    const id = "2026-09-16-gate-mockups-present";
    await prepareGate(id, fullAssets());

    const response = await decide(id);

    expect(response.status).toBe(202);
    expect(status52(id)).toBe("approved");
    // The approval sealed the manifest, exactly as it does without mockups.
    const sealed = getRun(id)?.stages?.find((stage) => stage.number === 5)
      ?.subTasks.find((task) => task.id === "5.2");
    expect(sealed?.assetManifestSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("refuses while a required mockup is missing from the manifest", async () => {
    const id = "2026-09-16-gate-mockups-missing";
    await prepareGate(id, fullAssets().filter((asset) => asset.file !== "program-stack.webp"));

    const response = await decide(id);

    expect(response.status).toBe(409);
    const { error } = await response.json() as { error: string };
    expect(error).toContain("מוקאפ נדרש חסר או נפסל");
    // The refusal names the mockup, so the operator knows what to rerun.
    expect(error).toContain("program-stack");
    expect(error).not.toContain("module-1");
    expect(status52(id)).toBe("awaiting-decision");
    // Nothing was sealed on a refused approval.
    const dir = path.join(runsDir, id, "assets");
    await expect(fs.access(path.join(dir, "asset-approval.json"))).rejects.toThrow();
  });

  it("refuses while a required mockup is in the manifest but rejected", async () => {
    const id = "2026-09-16-gate-mockups-rejected";
    await prepareGate(id, fullAssets().map((asset) => (asset.file === "module-1-mockup.webp"
      ? { ...asset, status: "rejected" as const, problems: ["מוקאפ מניסיון קודם או ללא רינדור"] }
      : asset)));

    const response = await decide(id);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("module-1"),
    });
    expect(status52(id)).toBe("awaiting-decision");
  });

  it("refuses a mockup placed somewhere other than the section the brief approved", async () => {
    const id = "2026-09-16-gate-mockups-wrong-section";
    await prepareGate(id, fullAssets().map((asset) => (asset.file === "program-stack.webp"
      ? { ...asset, section: "סקציה אחרת" }
      : asset)));

    const response = await decide(id);

    expect(response.status).toBe(409);
    expect(status52(id)).toBe("awaiting-decision");
  });

  it("accepts a required mockup the sheet marked for a human look", async () => {
    const id = "2026-09-16-gate-mockups-review-required";
    await prepareGate(id, fullAssets().map((asset) => (asset.file === "module-1-mockup.webp"
      ? { ...asset, status: "review-required" as const }
      : asset)));

    const response = await decide(id);

    expect(response.status).toBe(202);
    expect(status52(id)).toBe("approved");
  });

  it("leaves a run whose brief requires no mockups exactly as it was", async () => {
    const id = "2026-09-16-gate-mockups-none-required";
    const brief = "כיוון עיצוב לאקמה.\n```json\n" + JSON.stringify({
      playbook: "Dark Premium",
      imageMap: [{ harvestFile: "raw/01-portrait.jpg", section: "Hero", proves: "המנחה שבנתה את השיטה" }],
    }) + "\n```";
    await prepareGate(id, [fullAssets()[0]!], brief);

    const response = await decide(id);

    expect(response.status).toBe(202);
    expect(status52(id)).toBe("approved");
  });
});
