import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  readPageTypeBlueprint,
  readRunPageTypeBlueprint,
  resolvePageTypesDir,
} from "@/orchestrator/pageTypeBlueprint";
import { validateClientProfile } from "@/config/clientProfile";
import type { ClientProfile } from "@/config/clientProfile";
import { runMiniDiscussion } from "@/orchestrator/runMiniDiscussion";
import { spawnAgent } from "@/orchestrator/spawnAgent";
import { loadAgents } from "@/orchestrator/loadAgents";
import { createRun, flushPersistence, __resetRegistryForTests } from "@/orchestrator/runRegistry";
import { eventBus } from "@/orchestrator/eventBus";
import type { Agent, AssetType, Run, SSEEvent } from "@/types";

vi.mock("@/orchestrator/spawnAgent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/orchestrator/spawnAgent")>()),
  spawnAgent: vi.fn(async () => ({ fullText: "פסק דין: עובר\nתוכן לדוגמה" })),
}));

vi.mock("@/orchestrator/loadAgents", () => ({
  loadAgents: vi.fn(async () => []),
}));

let workDir: string;

function testEnv(vars: Record<string, string>): NodeJS.ProcessEnv {
  return vars as unknown as NodeJS.ProcessEnv;
}

function profileWithPageTypesDir(pageTypesDir?: string): ClientProfile {
  return validateClientProfile({
    schemaVersion: 1,
    tenant: { id: "acme", displayName: "Acme", locale: "he-IL", timezone: "Asia/Jerusalem" },
    brand: { publicName: "Acme", facts: ["עובדה מאומתת"] },
    policies: {
      contentRules: [],
      advertisingRules: [],
      operationalRules: [],
      capabilities: {
        landingPageBuild: false,
        metaPixelRead: false,
        metaCampaignCreatePaused: false,
      },
    },
    ...(pageTypesDir ? { copy: { pageTypesDir } } : {}),
  });
}

beforeEach(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), "council-page-type-blueprint-"));
});

afterEach(async () => {
  await fs.rm(workDir, { recursive: true, force: true, maxRetries: 5 });
});

describe("resolving the page-type folder at run creation", () => {
  it("משתמש בתיקייה שהוגדרה בפרופיל", () => {
    const dir = path.join(workDir, "configured");
    expect(resolvePageTypesDir(profileWithPageTypesDir(dir), testEnv({}))).toBe(dir);
  });

  it("נופל חזרה לתיקייה שליד קובץ הפרופיל כשאין הגדרה", () => {
    const env = testEnv({ CAMPAIGN_COUNCIL_CLIENT_PROFILE: path.join(workDir, "client-profile.json") });
    expect(resolvePageTypesDir(undefined, env)).toBe(path.join(workDir, "page-types"));
  });

  it("פותר נתיב פרופיל יחסי מול תיקיית השורש שניתנה, לא מול תיקיית ההפעלה", () => {
    const env = testEnv({ CAMPAIGN_COUNCIL_CLIENT_PROFILE: "profiles/client-profile.json" });
    expect(resolvePageTypesDir(undefined, env, workDir)).toBe(path.join(workDir, "profiles", "page-types"));
  });

  it("לא מחזיר תיקייה כשאין פרופיל מוגדר", () => {
    expect(resolvePageTypesDir(undefined, testEnv({}))).toBeUndefined();
  });
});

describe("the page type blueprint loader", () => {
  it("קורא את התבנית של הסוג מהתיקייה שניתנה", async () => {
    await fs.mkdir(path.join(workDir, "page-types"), { recursive: true });
    await fs.writeFile(path.join(workDir, "page-types", "webinar-page.md"), "## המבנה המחייב\nפרטי שידור", "utf8");
    await expect(readPageTypeBlueprint("webinar-page", path.join(workDir, "page-types"))).resolves.toContain("פרטי שידור");
  });

  it("מחזיר ריק כשאין קובץ תבנית", async () => {
    await expect(readPageTypeBlueprint("webinar-page", path.join(workDir, "page-types"))).resolves.toBe("");
  });

  it("מחזיר ריק לתיקייה שאינה נתיב מוחלט", async () => {
    await fs.mkdir(path.join(workDir, "page-types"), { recursive: true });
    await fs.writeFile(path.join(workDir, "page-types", "webinar-page.md"), "תוכן", "utf8");
    await expect(readPageTypeBlueprint("webinar-page", path.relative(process.cwd(), path.join(workDir, "page-types"))))
      .resolves.toBe("");
  });

  it("מסרב ל-symlink", async () => {
    const dir = path.join(workDir, "page-types");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(workDir, "real.md"), "תוכן", "utf8");
    await fs.symlink(path.join(workDir, "real.md"), path.join(dir, "squeeze-page.md"));
    await expect(readPageTypeBlueprint("squeeze-page", dir)).rejects.toThrow();
  });

  // Spec 7.3: a file over the ceiling is refused, not truncated or injected.
  it("מסרב לקובץ שחורג ממגבלת הגודל", async () => {
    const dir = path.join(workDir, "page-types");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "upsell-page.md"), "א".repeat(128 * 1024), "utf8");
    await expect(readPageTypeBlueprint("upsell-page", dir)).rejects.toThrow(/מגבלת הגודל/);
  });

  // Spec 7.3: a value that is not a known asset type never becomes a file name.
  it("מחזיר ריק לערך שאינו סוג נכס מוכר, גם כשיש קובץ בשם הזה", async () => {
    const dir = path.join(workDir, "page-types");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "landing-page.md"), "תוכן שלא אמור להיקרא", "utf8");
    await expect(readPageTypeBlueprint("landing-page" as AssetType, dir)).resolves.toBe("");
  });
});

function makeAgent(slug: Agent["slug"], name: string): Agent {
  return {
    slug,
    name,
    role: name,
    color: "#000",
    order: 1,
    active: true,
    systemPrompt: `אתה ${name}.`,
    avatarPath: "/tmp/avatar.png",
  };
}

const miniDiscussionAgents: Agent[] = [
  makeAgent("maya-lp-copywriter", "מאיה"),
  makeAgent("roni-creative", "רוני"),
  makeAgent("omer-ad-copywriter", "עומר"),
  makeAgent("avishai-campaigner", "אבישי"),
  // Task 10 gave webinar-page's 4a its own critics (yoni, roni, daniel),
  // replacing the sales-page fallback this fixture used to exercise.
  makeAgent("yoni-strategist", "יוני"),
  makeAgent("daniel-lp-designer", "דניאל"),
];

function baseRun(id: string, assetType: Run["assetType"], pageTypesDir: string): Run {
  return {
    id,
    slug: "test-run",
    brief: "בריף לבדיקה",
    createdAt: "2026-09-12T10:00:00.000Z",
    status: "awaiting-decision",
    currentRound: null,
    messages: [],
    stages: [],
    assetType,
    clientProfile: profileWithPageTypesDir(),
    pageTypesDir,
  };
}

describe("reading a run's blueprint", () => {
  it("קורא רק מהתיקייה שנשמרה על הריצה", async () => {
    const dir = path.join(workDir, "page-types");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "squeeze-page.md"), "## מבנה\nתבנית הריצה", "utf8");
    await expect(readRunPageTypeBlueprint({ assetType: "squeeze-page", pageTypesDir: dir }))
      .resolves.toContain("תבנית הריצה");
    await expect(readRunPageTypeBlueprint({ assetType: "squeeze-page" })).resolves.toBe("");
  });
});

describe("the page-type blueprint injected into stage 4 prompts (not stage 7)", () => {
  let runsDir: string;

  beforeEach(async () => {
    runsDir = await fs.mkdtemp(path.join(os.tmpdir(), "council-mini-discussion-"));
    process.env.RUNS_DIR_OVERRIDE = runsDir;
    await fs.mkdir(path.join(runsDir, "logs"), { recursive: true });
    __resetRegistryForTests();
    vi.mocked(spawnAgent).mockClear();
    vi.mocked(loadAgents).mockClear();
    vi.mocked(loadAgents).mockResolvedValue(miniDiscussionAgents);
  });

  afterEach(async () => {
    // createRun queues writes into RUNS_DIR_OVERRIDE, and the registry reset
    // drops that queue without waiting. Let every write land before removing
    // the folder, or a late write races fs.rm and fails it with ENOTEMPTY.
    await flushPersistence();
    __resetRegistryForTests();
    delete process.env.RUNS_DIR_OVERRIDE;
    await fs.rm(runsDir, { recursive: true, force: true, maxRetries: 5 });
  });

  async function readDraftLog(stageNumber: number, subTaskId: string): Promise<string> {
    return fs.readFile(
      path.join(runsDir, "logs", `stage-${stageNumber}-${subTaskId}-phase1-draft.log`),
      "utf8",
    );
  }

  it("מזריק את התבנית לכותב, למבקר ולשוטר הציות בשלב 4, ולא בשלב 7 על אותו סוג דף", async () => {
    const pageTypesDir = path.join(runsDir, "page-types");
    await fs.mkdir(pageTypesDir, { recursive: true });
    await fs.writeFile(path.join(pageTypesDir, "webinar-page.md"), "## מבנה חובה\nסדר שידור מדויק", "utf8");

    createRun(baseRun("run-stage4", "webinar-page", pageTypesDir));
    await runMiniDiscussion("run-stage4", runsDir, 4, "4a");

    // webinar-page's real 4a (Task 10) has three critics (yoni, roni, daniel),
    // unlike the single-critic sales-page fallback this fixture predates.
    // Sequence: draft, one critique call per critic, revise, audit.
    const numCritics = 3;
    const calls = vi.mocked(spawnAgent).mock.calls;
    expect(calls).toHaveLength(2 + numCritics + 1);
    const draftPrompt = calls[0][0].prompt;
    const critiquePrompts = calls.slice(1, 1 + numCritics).map((c) => c[0].prompt);
    const revisePrompt = calls[1 + numCritics][0].prompt;
    const auditPrompt = calls[2 + numCritics][0].prompt;

    expect(draftPrompt).toContain("תבנית סוג הדף, גוברת על כללי מבנה כלליים");
    expect(draftPrompt).toContain("סדר שידור מדויק");
    expect(revisePrompt).toContain("תבנית סוג הדף, גוברת על כללי מבנה כלליים");
    expect(revisePrompt).toContain("סדר שידור מדויק");
    for (const critiquePrompt of critiquePrompts) {
      expect(critiquePrompt).toContain("תבנית סוג הדף שאתה שופט לפיה");
      expect(critiquePrompt).toContain("סדר שידור מדויק");
    }
    expect(auditPrompt).toContain("תבנית סוג הדף שאתה בודק ציות אליה");
    expect(auditPrompt).toContain("סדר שידור מדויק");

    // The persisted log carries the same injected text the model actually saw.
    const draftLog = await readDraftLog(4, "4a");
    expect(draftLog).toContain("תבנית סוג הדף, גוברת על כללי מבנה כלליים");
    expect(draftLog).toContain("סדר שידור מדויק");

    vi.mocked(spawnAgent).mockClear();

    // Same asset type, same blueprint file on disk, but stage 7 writes ads.
    createRun(baseRun("run-stage7", "webinar-page", pageTypesDir));
    await runMiniDiscussion("run-stage7", runsDir, 7, "7");

    const stage7Prompts = vi.mocked(spawnAgent).mock.calls.map((c) => c[0].prompt);
    expect(stage7Prompts.length).toBeGreaterThan(0);
    for (const prompt of stage7Prompts) {
      expect(prompt).not.toContain("תבנית סוג הדף");
      expect(prompt).not.toContain("סדר שידור מדויק");
    }
  });

  it("מזהיר על תבנית חסרה לסוג דף שאינו דף מכירה, דרך אותו אירוע שהריצה כבר משדרת בו", async () => {
    const missingDir = path.join(runsDir, "no-such-page-types-dir");
    const events: SSEEvent[] = [];
    const unsubscribe = eventBus.subscribe("run-missing", (e) => events.push(e));

    try {
      createRun(baseRun("run-missing", "premium-lead-page", missingDir));
      await runMiniDiscussion("run-missing", runsDir, 4, "4a");
    } finally {
      unsubscribe();
    }

    const warningEvent = events.find(
      (e) => e.type === "subtask-token" && e.token?.includes("תבנית סוג הדף (premium-lead-page) לא נמצאה"),
    );
    expect(warningEvent).toBeDefined();

    const draftLog = await readDraftLog(4, "4a");
    expect(draftLog).toContain("תבנית סוג הדף (premium-lead-page) לא נמצאה");
    // No blueprint content on disk, so no injected block despite the warning.
    expect(draftLog).not.toContain("תבנית סוג הדף, גוברת על כללי מבנה כלליים");
  });

  it("לא מזהיר על תבנית חסרה כשסוג הדף הוא דף מכירה, שאין לו תבנית מעצם הגדרתו", async () => {
    const missingDir = path.join(runsDir, "no-such-page-types-dir");
    const events: SSEEvent[] = [];
    const unsubscribe = eventBus.subscribe("run-sales", (e) => events.push(e));

    try {
      createRun(baseRun("run-sales", "sales-page", missingDir));
      await runMiniDiscussion("run-sales", runsDir, 4, "4a");
    } finally {
      unsubscribe();
    }

    const warningEvent = events.find(
      (e) => e.type === "subtask-token" && e.token?.includes("תבנית סוג הדף"),
    );
    expect(warningEvent).toBeUndefined();
  });
});
