import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientProfile } from "@/config/clientProfile";
import type { Run, Stage } from "@/types";

const PROFILE: ClientProfile = {
  schemaVersion: 1,
  tenant: { id: "acme", displayName: "Acme", locale: "en-US", timezone: "UTC" },
  brand: { publicName: "Acme", facts: ["Verified"] },
  policies: {
    contentRules: [],
    advertisingRules: [],
    operationalRules: [],
    capabilities: {
      landingPageBuild: false,
      metaPixelRead: true,
      metaCampaignCreatePaused: true,
    },
  },
  landing: { publicBaseUrl: "https://offers.example.test" },
  meta: {
    accountId: "act_123456789",
    pixelId: "123456789",
    customConversionId: "423456789",
    pageId: "223456789",
    instagramActorId: "323456789",
    domain: "offers.example.test",
    tokenKeychainService: "secret-service-name",
  },
};

const mocks = vi.hoisted(() => ({
  currentRun: null as Run | null,
  spawnAgent: vi.fn(),
  appendLog: vi.fn(async () => undefined),
  saveRunArtifact: vi.fn(async () => undefined),
  emit: vi.fn(),
}));

vi.mock("@/orchestrator/spawnAgent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/orchestrator/spawnAgent")>()), spawnAgent: mocks.spawnAgent }));
vi.mock("@/lib/runStore", () => ({
  appendLog: mocks.appendLog,
  saveRunArtifact: mocks.saveRunArtifact,
}));
vi.mock("@/orchestrator/eventBus", () => ({ eventBus: { emit: mocks.emit } }));
vi.mock("@/orchestrator/runRegistry", () => ({
  getRun: () => mocks.currentRun,
  updateRun: (_id: string, patch: Partial<Run>) => {
    if (mocks.currentRun) mocks.currentRun = { ...mocks.currentRun, ...patch };
  },
}));
import { runStage9MetaCampaign } from "@/orchestrator/runStage9MetaCampaign";
import { stage8ReportSha256 } from "@/orchestrator/runStage8PixelVerify";

function stages(): Stage[] {
  const stage8Output = "# typed verification\n\n> RESULT: PASS";
  return [
    {
      number: 7,
      title: "copy",
      ownerSlug: "omer-ad-copywriter",
      status: "approved",
      output: "approved copy",
      feedbackHistory: [],
      subTasks: [{ id: "7", title: "copy", status: "approved", output: "approved copy", feedbackHistory: [] }],
    },
    {
      number: 8,
      title: "verify",
      ownerSlug: "avishai-campaigner",
      status: "approved",
      output: stage8Output,
      feedbackHistory: [],
      subTasks: [
        {
          id: "8",
          title: "verify",
          status: "approved",
          output: stage8Output,
          feedbackHistory: [],
          metaVerification: {
            schemaVersion: 1,
            ready: true,
            reportSha256: stage8ReportSha256(stage8Output),
            checkedAt: "2026-08-27T12:00:00.000Z",
          },
        },
      ],
    },
    {
      number: 9,
      title: "plan",
      ownerSlug: "avishai-campaigner",
      status: "pending",
      output: "",
      feedbackHistory: [],
      subTasks: [{ id: "9", title: "plan", status: "pending", output: "", feedbackHistory: [] }],
    },
  ];
}

describe("Stage 9 executor", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "stage9-plan-only-"));
    mocks.spawnAgent.mockReset();
    mocks.appendLog.mockClear();
    mocks.emit.mockClear();
    mocks.spawnAgent.mockResolvedValue({
      fullText: "תוכנית מפורטת לבדיקת אדם בלבד. ".repeat(10),
      exitCode: 0,
      durationMs: 5,
    });
    mocks.currentRun = {
      id: "2026-08-27-1200-stage-nine-plan",
      slug: "stage-nine-plan",
      brief: "brief",
      createdAt: "2026-08-27T12:00:00.000Z",
      status: "approved",
      currentRound: null,
      messages: [],
      clientProfile: PROFILE,
      strategyDoc: "strategy",
      stages: stages(),
      currentStage: 9,
    };
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("invokes Claude with no tools, strict MCP isolation, and default permissions", async () => {
    await runStage9MetaCampaign(mocks.currentRun!.id, directory);

    expect(mocks.spawnAgent).toHaveBeenCalledOnce();
    expect(mocks.spawnAgent.mock.calls[0][0]).toMatchObject({
      permissionMode: "default",
      tools: [],
      strictMcpConfig: true,
      settingSources: [],
      disableSlashCommands: true,
    });
    const prompt = mocks.spawnAgent.mock.calls[0][0].prompt as string;
    expect(prompt).not.toContain("secret-service-name");
    expect(prompt).not.toMatch(/\bcurl\b|access_token|find-generic-password|bypassPermissions/i);
    expect(mocks.currentRun?.stages?.find((stage) => stage.number === 9)?.subTasks[0].status)
      .toBe("awaiting-decision");
  });

  it("fails closed for legacy runs without a profile snapshot", async () => {
    mocks.currentRun!.clientProfile = undefined;

    await expect(runStage9MetaCampaign(mocks.currentRun!.id, directory)).rejects.toThrow(
      /no client-profile snapshot/i,
    );
    expect(mocks.spawnAgent).not.toHaveBeenCalled();
  });
});
