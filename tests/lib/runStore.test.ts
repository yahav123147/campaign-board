import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  MAX_RUN_STATE_BYTES,
  RUN_STATE_SCHEMA_VERSION,
  appendLog,
  assertValidRunId,
  createNewRunDir,
  createRunDir,
  saveBrief,
  saveTranscript,
  saveStrategy,
  saveRunState,
  saveRunArtifact,
  loadRunState,
  listRunIds,
  readRunSummary,
  runsRoot,
} from "@/lib/runStore";
import type { Run } from "@/types";

let testRunsDir: string;

beforeEach(async () => {
  testRunsDir = await fs.mkdtemp(path.join(os.tmpdir(), "council-test-"));
  process.env.RUNS_DIR_OVERRIDE = testRunsDir;
});

describe("runStore", () => {
  it("createRunDir creates a folder for a run id", async () => {
    const dir = await createRunDir("2026-05-10-1430");
    const stat = await fs.stat(dir);
    expect(stat.isDirectory()).toBe(true);
    expect(dir).toContain("2026-05-10-1430");
  });

  it("createNewRunDir never reuses an existing run folder", async () => {
    await createNewRunDir("unique-run");
    await expect(createNewRunDir("unique-run")).rejects.toMatchObject({ code: "EEXIST" });
  });

  it("rejects traversal and separator characters in run ids", () => {
    expect(() => assertValidRunId("../outside")).toThrow("Invalid run id");
    expect(() => assertValidRunId("nested/run")).toThrow("Invalid run id");
    expect(() => assertValidRunId("safe-run_01.2")).not.toThrow();
  });

  it.each([
    ["filesystem root", path.parse(process.cwd()).root],
    ["home directory", os.homedir()],
    ["project directory", process.cwd()],
    ["temporary root", os.tmpdir()],
  ])("refuses a broad RUNS_DIR_OVERRIDE target: %s", (_label, unsafePath) => {
    process.env.RUNS_DIR_OVERRIDE = unsafePath;
    expect(() => runsRoot()).toThrow(/dedicated subdirectory/i);
  });

  it("requires configured storage paths to be absolute", () => {
    process.env.RUNS_DIR_OVERRIDE = "relative-runs";
    expect(() => runsRoot()).toThrow(/absolute dedicated directory/i);
  });

  it("refuses a broad configured data directory before appending runs", () => {
    delete process.env.RUNS_DIR_OVERRIDE;
    process.env.CAMPAIGN_COUNCIL_DATA_DIR = process.cwd();
    try {
      expect(() => runsRoot()).toThrow(/dedicated subdirectory/i);
    } finally {
      delete process.env.CAMPAIGN_COUNCIL_DATA_DIR;
      process.env.RUNS_DIR_OVERRIDE = testRunsDir;
    }
  });

  it("saveBrief writes brief.md", async () => {
    const dir = await createRunDir("2026-05-10-1430");
    await saveBrief(dir, "השקת קמפיין חדש");
    const content = await fs.readFile(path.join(dir, "brief.md"), "utf-8");
    expect(content).toBe("השקת קמפיין חדש");
  });

  it("saveTranscript appends rounds in order", async () => {
    const dir = await createRunDir("2026-05-10-1430");
    await saveTranscript(dir, "## סבב 1\nתוכן");
    const content = await fs.readFile(path.join(dir, "transcript.md"), "utf-8");
    expect(content).toContain("## סבב 1");
  });

  it("saveStrategy writes strategy.md", async () => {
    const dir = await createRunDir("2026-05-10-1430");
    await saveStrategy(dir, "# Strategy");
    const content = await fs.readFile(path.join(dir, "strategy.md"), "utf-8");
    expect(content).toBe("# Strategy");
  });

  it("rejects path traversal in log filenames", async () => {
    const dir = await createRunDir("2026-05-10-1431");
    await expect(appendLog(dir, "../outside.log", "bad")).rejects.toThrow("Invalid log filename");
    await expect(fs.access(path.join(testRunsDir, "outside.log"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not follow an existing log symlink", async () => {
    const dir = await createRunDir("2026-05-10-1432");
    const outside = path.join(testRunsDir, "outside-log.txt");
    await fs.writeFile(outside, "unchanged");
    await fs.symlink(outside, path.join(dir, "logs", "linked.log"));

    await expect(appendLog(dir, "linked.log", "leaked")).rejects.toThrow(
      "Log path is not a regular file",
    );
    expect(await fs.readFile(outside, "utf8")).toBe("unchanged");
  });

  it("writes stage artifacts atomically in private root and subtask layouts", async () => {
    const dir = await createRunDir("2026-05-10-artifacts");
    await saveRunArtifact(dir, "stage-5.md", "stage output");
    await saveRunArtifact(dir, "stage-5/5.3.md", "subtask output");

    expect(await fs.readFile(path.join(dir, "stage-5.md"), "utf8")).toBe("stage output");
    expect(await fs.readFile(path.join(dir, "stage-5", "5.3.md"), "utf8"))
      .toBe("subtask output");
    expect((await fs.stat(path.join(dir, "stage-5.md"))).mode & 0o777).toBe(0o600);
    expect((await fs.stat(path.join(dir, "stage-5"))).mode & 0o777).toBe(0o700);
  });

  it("rejects artifact traversal and does not follow an artifact directory symlink", async () => {
    const dir = await createRunDir("2026-05-10-artifact-symlink");
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "council-artifact-outside-"));
    await fs.symlink(outside, path.join(dir, "stage-5"));

    await expect(saveRunArtifact(dir, "../outside.md", "bad"))
      .rejects.toThrow("Invalid run artifact path");
    await expect(saveRunArtifact(dir, "stage-5/5.3.md", "bad"))
      .rejects.toThrow(/unsafe|not a regular directory/i);
    await expect(fs.access(path.join(outside, "5.3.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("replaces an artifact-file symlink without changing its target", async () => {
    const dir = await createRunDir("2026-05-10-artifact-file-link");
    const outside = path.join(testRunsDir, "outside-artifact.md");
    await fs.writeFile(outside, "unchanged");
    await fs.symlink(outside, path.join(dir, "stage-8.md"));

    await saveRunArtifact(dir, "stage-8.md", "safe replacement");
    expect(await fs.readFile(outside, "utf8")).toBe("unchanged");
    expect(await fs.readFile(path.join(dir, "stage-8.md"), "utf8")).toBe("safe replacement");
    expect((await fs.lstat(path.join(dir, "stage-8.md"))).isSymbolicLink()).toBe(false);
  });
});

describe("runStore persistence", () => {
  const baseRun = (id: string): Run => ({
    id,
    slug: "test-run",
    brief: "בריף לבדיקה",
    createdAt: "2026-08-26T10:00:00.000Z",
    status: "awaiting-decision",
    currentRound: null,
    messages: [],
  });

  it("saveRunState writes run.json and loadRunState reads it back", async () => {
    const dir = await createRunDir("2026-08-26-1000");
    const run = baseRun("2026-08-26-1000");
    await saveRunState(dir, run);
    const onDisk = await fs.readFile(path.join(dir, "run.json"), "utf-8");
    expect(JSON.parse(onDisk)).toMatchObject({
      brief: "בריף לבדיקה",
      _storageSchemaVersion: RUN_STATE_SCHEMA_VERSION,
    });
    const loaded = await loadRunState("2026-08-26-1000");
    expect(loaded).toEqual(run);
  });

  it("round-trips the page-type folder a run was created with", async () => {
    const id = "2026-09-12-page-types";
    const dir = await createRunDir(id);
    const run: Run = { ...baseRun(id), assetType: "webinar-page", pageTypesDir: "/srv/client-a/page-types" };
    await saveRunState(dir, run);
    const loaded = await loadRunState(id);
    expect(loaded?.pageTypesDir).toBe("/srv/client-a/page-types");
    expect(loaded).toEqual(run);
  });

  it("refuses a stored page-type folder that is not an absolute path", async () => {
    const id = "2026-09-12-page-types-relative";
    const dir = await createRunDir(id);
    const invalid = { ...baseRun(id), pageTypesDir: "relative/page-types" } as Run;
    await expect(saveRunState(dir, invalid)).rejects.toThrow("Invalid run state");
  });

  it("round-trips archived strategy revisions without losing their transcripts", async () => {
    const id = "2026-08-26-strategy-history";
    const dir = await createRunDir(id);
    const run: Run = {
      ...baseRun(id),
      strategyRevisions: [{
        strategyDoc: "first strategy",
        feedback: "make it sharper",
        archivedAt: "2026-08-26T11:00:00.000Z",
        messages: [{
          agentSlug: "yoni-strategist",
          round: 1,
          content: "first transcript",
          status: "done",
          startedAt: "2026-08-26T10:00:00.000Z",
          completedAt: "2026-08-26T10:01:00.000Z",
        }],
      }],
    };
    await saveRunState(dir, run);

    expect((await loadRunState(id))?.strategyRevisions).toEqual(run.strategyRevisions);
  });

  it("rejects malformed strategy revision history", async () => {
    const id = "2026-08-26-bad-strategy-history";
    const dir = await createRunDir(id);
    const invalid = {
      ...baseRun(id),
      strategyRevisions: [{
        strategyDoc: "old",
        feedback: "feedback",
        archivedAt: "not-a-date",
        messages: [],
      }],
    } as unknown as Run;

    await expect(saveRunState(dir, invalid)).rejects.toThrow("Invalid run state");
  });

  it("uses private modes and leaves no predictable temporary state file", async () => {
    const dir = await createRunDir("2026-08-26-private");
    await saveRunState(dir, baseRun("2026-08-26-private"));
    await saveBrief(dir, "private brief");

    const dirMode = (await fs.stat(dir)).mode & 0o777;
    const logsMode = (await fs.stat(path.join(dir, "logs"))).mode & 0o777;
    const stateMode = (await fs.stat(path.join(dir, "run.json"))).mode & 0o777;
    const briefMode = (await fs.stat(path.join(dir, "brief.md"))).mode & 0o777;
    expect({ dirMode, logsMode, stateMode, briefMode }).toEqual({
      dirMode: 0o700,
      logsMode: 0o700,
      stateMode: 0o600,
      briefMode: 0o600,
    });
    expect((await fs.readdir(dir)).some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  it("refuses to persist a run in another run's directory", async () => {
    const dir = await createRunDir("2026-08-26-correct");
    await expect(saveRunState(dir, baseRun("2026-08-26-wrong"))).rejects.toThrow(
      "Run id does not match its directory",
    );
  });

  it("rejects a run.json whose embedded id does not match its folder", async () => {
    const dir = await createRunDir("2026-08-26-folder-id");
    await fs.writeFile(
      path.join(dir, "run.json"),
      JSON.stringify(baseRun("2026-08-26-embedded-id")),
      { mode: 0o600 },
    );
    expect(await loadRunState("2026-08-26-folder-id")).toBeNull();
  });

  it("rejects unsupported storage schema versions", async () => {
    const id = "2026-08-26-new-schema";
    const dir = await createRunDir(id);
    await fs.writeFile(
      path.join(dir, "run.json"),
      JSON.stringify({ ...baseRun(id), _storageSchemaVersion: RUN_STATE_SCHEMA_VERSION + 1 }),
      { mode: 0o600 },
    );
    expect(await loadRunState(id)).toBeNull();
  });

  it("reports a present corrupt run.json as an error instead of a completed legacy run", async () => {
    const id = "2026-08-26-corrupt-summary";
    const dir = await createRunDir(id);
    await saveBrief(dir, "recoverable brief");
    await fs.writeFile(path.join(dir, "run.json"), "{broken", { mode: 0o600 });

    await expect(readRunSummary(id)).resolves.toMatchObject({
      id,
      brief: "recoverable brief",
      status: "error",
      hasState: true,
      stateError: expect.stringContaining("run.json"),
    });
  });

  it("normalizes feedback history omitted by an older run schema", async () => {
    const id = "2026-08-26-legacy-fields";
    const dir = await createRunDir(id);
    const legacy = {
      ...baseRun(id),
      stages: [{
        number: 5,
        title: "Legacy stage",
        ownerSlug: "daniel-lp-designer",
        status: "approved",
        output: "done",
        subTasks: [{ id: "5.4", title: "Legacy task", status: "approved", output: "done" }],
      }],
    };
    await fs.writeFile(path.join(dir, "run.json"), JSON.stringify(legacy), { mode: 0o600 });

    const loaded = await loadRunState(id);
    expect(loaded?.stages?.[0].feedbackHistory).toEqual([]);
    expect(loaded?.stages?.[0].subTasks[0].feedbackHistory).toEqual([]);
  });

  it("rejects malformed Stage 8 verification receipts on write and read", async () => {
    const id = "2026-08-26-invalid-meta-receipt";
    const dir = await createRunDir(id);
    const invalidRun = {
      ...baseRun(id),
      stages: [{
        number: 8,
        title: "Meta verification",
        ownerSlug: "avishai-campaigner",
        status: "approved",
        output: "PASS",
        feedbackHistory: [],
        subTasks: [{
          id: "8",
          title: "Verify",
          status: "approved",
          output: "PASS",
          feedbackHistory: [],
          metaVerification: {
            schemaVersion: 1,
            ready: true,
            reportSha256: "not-a-sha256",
            checkedAt: "not-a-date",
          },
        }],
      }],
    } as unknown as Run;

    await expect(saveRunState(dir, invalidRun)).rejects.toThrow("Invalid run state");
    await fs.writeFile(path.join(dir, "run.json"), JSON.stringify(invalidRun), { mode: 0o600 });
    expect(await loadRunState(id)).toBeNull();
  });

  it("round-trips a valid harvest.igHandle and rejects a malformed one", async () => {
    const harvestStage = (igHandle: unknown) => ({
      number: 1,
      title: "קציר מותג",
      ownerSlug: "rafael-researcher",
      status: "approved",
      output: "done",
      feedbackHistory: [],
      subTasks: [{
        id: "1",
        title: "קציר",
        status: "approved",
        output: "done",
        feedbackHistory: [],
        harvest: {
          schemaVersion: 1,
          sheetFile: "sheet.jpg",
          imageCount: 3,
          harvestedAt: "2026-08-26T10:00:00.000Z",
          igHandle,
        },
      }],
    });

    const validId = "2026-08-26-valid-ig-handle";
    const validDir = await createRunDir(validId);
    const validRun = { ...baseRun(validId), stages: [harvestStage("michal.adar")] } as unknown as Run;
    await saveRunState(validDir, validRun);
    const loaded = await loadRunState(validId);
    expect(loaded?.stages?.[0]?.subTasks[0]?.harvest).toMatchObject({ igHandle: "michal.adar" });

    const invalidId = "2026-08-26-invalid-ig-handle";
    const invalidDir = await createRunDir(invalidId);
    // "@" is not part of the stored handle, and this string exceeds the 30-char ceiling too.
    const invalidRun2 = { ...baseRun(invalidId), stages: [harvestStage("not a valid handle!")] } as unknown as Run;
    await expect(saveRunState(invalidDir, invalidRun2)).rejects.toThrow("Invalid run state");
    await fs.writeFile(path.join(invalidDir, "run.json"), JSON.stringify(invalidRun2), { mode: 0o600 });
    expect(await loadRunState(invalidId)).toBeNull();
  });

  it("preserves both review results and rejects a malformed imageMapCheck", async () => {
    const id = "2026-09-13-image-map-check";
    const dir = await createRunDir(id);
    const check = {
      schemaVersion: 1,
      passed: false,
      mappedCount: 2,
      missing: [{ file: "hero.webp", section: "Hero", proves: "כותרת", widths: [390] }],
      attemptStartedAt: "2026-09-13T10:00:00.000Z",
      assetManifestSha256: "a".repeat(64),
      pageSourceManifestSha256: "b".repeat(64),
      checkedAt: "2026-09-13T10:05:00.000Z",
    };
    const designReview = { schemaVersion: 1, passed: false, failing: [], silent: ["אורי"], checkedAt: check.checkedAt };
    const runWith = (imageMapCheck: unknown) => ({
      id,
      slug: id,
      brief: "A sufficiently long image map persistence brief",
      createdAt: "2026-09-13T10:00:00.000Z",
      status: "approved",
      currentRound: null,
      messages: [],
      currentStage: 5,
      stages: [{
        number: 5,
        title: "Landing page",
        ownerSlug: "daniel-lp-designer",
        status: "running",
        output: "",
        feedbackHistory: [],
        subTasks: [{ id: "5.3", title: "Build", status: "awaiting-decision", output: "x", feedbackHistory: [], imageMapCheck, designReview }],
      }],
    }) as unknown as Run;

    await expect(saveRunState(dir, runWith(check))).resolves.not.toThrow();
    expect((await loadRunState(id))?.stages?.[0].subTasks[0]).toMatchObject({ imageMapCheck: check, designReview });
    await expect(saveRunState(dir, runWith({ ...check, missing: [{ ...check.missing[0], widths: [768] }] })))
      .rejects.toThrow("Invalid run state");
    await expect(saveRunState(dir, runWith({ ...check, assetManifestSha256: "short" })))
      .rejects.toThrow("Invalid run state");
  });

  it("rejects an imageMapCheck whose verdict contradicts its missing list or failure", async () => {
    const id = "2026-09-13-image-map-check-consistency";
    const dir = await createRunDir(id);
    const base = {
      schemaVersion: 1,
      mappedCount: 2,
      attemptStartedAt: "2026-09-13T10:00:00.000Z",
      assetManifestSha256: "a".repeat(64),
      pageSourceManifestSha256: "b".repeat(64),
      checkedAt: "2026-09-13T10:05:00.000Z",
    };
    const entry = { file: "hero.webp", section: "Hero", proves: "כותרת", widths: [390] };
    const runWith = (imageMapCheck: unknown) => ({
      id,
      slug: id,
      brief: "A sufficiently long image map persistence brief",
      createdAt: "2026-09-13T10:00:00.000Z",
      status: "approved",
      currentRound: null,
      messages: [],
      currentStage: 5,
      stages: [{
        number: 5,
        title: "Landing page",
        ownerSlug: "landing-designer",
        status: "running",
        output: "",
        feedbackHistory: [],
        subTasks: [{ id: "5.3", title: "Build", status: "awaiting-decision", output: "x", feedbackHistory: [], imageMapCheck }],
      }],
    }) as unknown as Run;

    // Every shape the writers produce is accepted.
    await expect(saveRunState(dir, runWith({ ...base, passed: true, missing: [] }))).resolves.not.toThrow();
    await expect(saveRunState(dir, runWith({ ...base, passed: false, missing: [entry] }))).resolves.not.toThrow();
    await expect(saveRunState(dir, runWith({ ...base, passed: false, missing: [], failure: "probe failed" }))).resolves.not.toThrow();
    await expect(saveRunState(dir, runWith({ ...base, passed: false, missing: [entry], failure: "stale" }))).resolves.not.toThrow();

    for (const inconsistent of [
      { ...base, passed: true, missing: [], failure: "probe failed" },
      { ...base, passed: true, missing: [entry] },
      { ...base, passed: false, missing: [] },
      { ...base, passed: false, missing: [{ ...entry, widths: [390, 390] }] },
    ]) {
      await expect(saveRunState(dir, runWith(inconsistent)), JSON.stringify(inconsistent)).rejects.toThrow("Invalid run state");
    }
  });

  it("round-trips a mockup render receipt on 5.2 and rejects a malformed one", async () => {
    const id = "2026-09-16-mockup-render-receipt";
    const dir = await createRunDir(id);
    const receipt = {
      schemaVersion: 1,
      attemptId: "attempt-5-2",
      baseSha256: { chapter: "c".repeat(64) },
      mockups: [
        {
          file: "module-1-mockup.webp",
          screensSha256: { "ch1-laptop": "d".repeat(64) },
          outputSha256: "e".repeat(64),
          status: "ok",
          notes: ["הגופנים לא הספיקו להיטען"],
        },
        {
          file: "program-stack.webp",
          screensSha256: {},
          status: "rejected",
          reason: "הרינדור לא זמין",
        },
      ],
      renderedAt: "2026-09-16T10:05:00.000Z",
      warnings: ["תיקיית עבודה זמנית לא נמחקה"],
    };
    const runWith = (mockupRender: unknown) => ({
      id,
      slug: id,
      brief: "A sufficiently long mockup receipt persistence brief",
      createdAt: "2026-09-16T10:00:00.000Z",
      status: "approved",
      currentRound: null,
      messages: [],
      currentStage: 5,
      stages: [{
        number: 5,
        title: "Landing page",
        ownerSlug: "daniel-lp-designer",
        status: "running",
        output: "",
        feedbackHistory: [],
        subTasks: [{ id: "5.2", title: "נכסים", status: "awaiting-decision", output: "x", feedbackHistory: [], mockupRender }],
      }],
    }) as unknown as Run;

    await expect(saveRunState(dir, runWith(receipt))).resolves.not.toThrow();
    expect((await loadRunState(id))?.stages?.[0].subTasks[0]).toMatchObject({ mockupRender: receipt });

    // A row the renderer refused keeps the file name the agent wrote, and the
    // agent writes Hebrew: the receipt must still save, or the whole run would
    // silently stop persisting over a name the plan validation rejects anyway.
    const hebrewRow = {
      ...receipt,
      mockups: [{ file: "מוקאפ-פרק-1.webp", screensSha256: {}, status: "rejected", reason: "שם קובץ המוקאפ אינו שם יחסי ובטוח" }],
    };
    await expect(saveRunState(dir, runWith(hebrewRow))).resolves.not.toThrow();
    expect((await loadRunState(id))?.stages?.[0].subTasks[0]?.mockupRender?.mockups[0])
      .toMatchObject({ file: "מוקאפ-פרק-1.webp", status: "rejected" });

    for (const malformed of [
      { ...receipt, schemaVersion: 2 },
      { ...receipt, attemptId: "" },
      { ...receipt, renderedAt: "not-a-date" },
      { ...receipt, baseSha256: { chapter: "short" } },
      // A base the renderer has no frame for is not a receipt this app wrote.
      { ...receipt, baseSha256: { watch: "c".repeat(64) } },
      { ...receipt, mockups: [{ ...receipt.mockups[0], file: "x".repeat(300) }] },
      { ...receipt, mockups: [{ ...receipt.mockups[0], file: 42 }] },
      { ...receipt, mockups: [{ ...receipt.mockups[0], status: "maybe" }] },
      { ...receipt, mockups: [{ ...receipt.mockups[0], outputSha256: "short" }] },
      // An "ok" row with no rendered output contradicts itself.
      { ...receipt, mockups: [{ file: "module-1-mockup.webp", screensSha256: {}, status: "ok" }] },
      { ...receipt, mockups: [{ ...receipt.mockups[0], screensSha256: { "ch1-laptop": "short" } }] },
      { ...receipt, mockups: "module-1-mockup.webp" },
      { ...receipt, warnings: [42] },
    ]) {
      await expect(saveRunState(dir, runWith(malformed)), JSON.stringify(malformed)).rejects.toThrow("Invalid run state");
    }

    const invalidDir = await createRunDir(`${id}-invalid`);
    const onDisk = runWith({ ...receipt, mockups: [{ ...receipt.mockups[0], status: "maybe" }] });
    await fs.writeFile(path.join(invalidDir, "run.json"), JSON.stringify({ ...onDisk, id: `${id}-invalid` }), { mode: 0o600 });
    expect(await loadRunState(`${id}-invalid`)).toBeNull();
  });

  it("rejects non-canonical execution keys and multiple running owners", async () => {
    const id = "2026-08-26-invalid-attempt-keys";
    const dir = await createRunDir(id);
    const now = Date.now();
    const attempt = {
      attemptId: "attempt",
      ownerId: "owner",
      state: "running" as const,
      retrySafety: "safe" as const,
      startedAt: now,
      heartbeatAt: now,
      leaseExpiresAt: now + 10_000,
      deadlineAt: now + 20_000,
    };
    const badKey = {
      ...baseRun(id),
      executionAttempts: { "not-a-target": attempt },
    } as Run;
    await expect(saveRunState(dir, badKey)).rejects.toThrow("Invalid run state");

    const duplicateOwners = {
      ...baseRun(id),
      executionAttempts: {
        [`run:${id}`]: attempt,
        [`subtask:${id}:5:5.2`]: { ...attempt, attemptId: "attempt-2" },
      },
    } as Run;
    await expect(saveRunState(dir, duplicateOwners)).rejects.toThrow("Invalid run state");
  });

  it("does not mark another local server's unexpired lease as interrupted", async () => {
    const id = "2026-08-26-live-other-server";
    const dir = await createRunDir(id);
    const now = Date.now();
    const run: Run = {
      ...baseRun(id),
      status: "discussing",
      executionAttempts: {
        [`run:${id}`]: {
          attemptId: "live-attempt",
          ownerId: "other-server",
          state: "running",
          retrySafety: "safe",
          startedAt: now,
          heartbeatAt: now,
          leaseExpiresAt: now + 30_000,
          deadlineAt: now + 60_000,
        },
      },
    };
    await saveRunState(dir, run);

    await expect(loadRunState(id)).resolves.toMatchObject({
      status: "discussing",
      executionAttempts: {
        [`run:${id}`]: { state: "running", attemptId: "live-attempt" },
      },
    });
  });

  it("validates and normalizes a persisted client profile", async () => {
    const id = "2026-08-26-client-profile";
    const dir = await createRunDir(id);
    const run = {
      ...baseRun(id),
      clientProfile: {
        schemaVersion: 1,
        tenant: {
          id: "client-one",
          displayName: "  Client One  ",
          locale: "en-us",
          timezone: "UTC",
        },
        brand: {
          publicName: "  Public Brand  ",
          facts: ["  Verified fact  "],
        },
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
      },
    } as Run;

    await saveRunState(dir, run);
    const onDisk = JSON.parse(await fs.readFile(path.join(dir, "run.json"), "utf8"));
    expect(onDisk.clientProfile.tenant).toMatchObject({
      displayName: "Client One",
      locale: "en-US",
    });
    expect(onDisk.clientProfile.brand).toMatchObject({
      publicName: "Public Brand",
      facts: ["Verified fact"],
    });
    expect((await loadRunState(id))?.clientProfile).toEqual(onDisk.clientProfile);
  });

  it("rejects an unvalidated client profile on write and read", async () => {
    const id = "2026-08-26-invalid-profile";
    const dir = await createRunDir(id);
    const invalidRun = {
      ...baseRun(id),
      clientProfile: { schemaVersion: 1, secret: "must-not-survive" },
    } as unknown as Run;

    await expect(saveRunState(dir, invalidRun)).rejects.toThrow("Invalid run state");
    await fs.writeFile(path.join(dir, "run.json"), JSON.stringify(invalidRun), { mode: 0o600 });
    expect(await loadRunState(id)).toBeNull();
  });

  it("rejects oversized state files before parsing them", async () => {
    const id = "2026-08-26-oversized";
    const dir = await createRunDir(id);
    await fs.writeFile(
      path.join(dir, "run.json"),
      Buffer.alloc(MAX_RUN_STATE_BYTES + 1, 0x20),
      { mode: 0o600 },
    );
    expect(await loadRunState(id)).toBeNull();
  });

  it("keeps the previous state intact when an oversized save is rejected", async () => {
    const id = "2026-08-26-oversized-save";
    const dir = await createRunDir(id);
    const original = baseRun(id);
    await saveRunState(dir, original);

    await expect(
      saveRunState(dir, { ...original, brief: "x".repeat(MAX_RUN_STATE_BYTES) }),
    ).rejects.toThrow("Run state exceeds its allowed size");
    expect(await loadRunState(id)).toEqual(original);
  });

  it("does not follow a symlinked run.json", async () => {
    const id = "2026-08-26-linked-state";
    const dir = await createRunDir(id);
    const outside = path.join(testRunsDir, "outside-state.json");
    await fs.writeFile(outside, JSON.stringify(baseRun(id)), { mode: 0o600 });
    await fs.symlink(outside, path.join(dir, "run.json"));
    expect(await loadRunState(id)).toBeNull();
  });

  it("does not list symlinked run directories", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "council-outside-"));
    await fs.symlink(outside, path.join(testRunsDir, "2026-08-26-linked-dir"));
    expect(await listRunIds()).not.toContain("2026-08-26-linked-dir");
  });

  it("loadRunState returns null for an unknown run", async () => {
    expect(await loadRunState("2026-01-01-0000")).toBeNull();
  });

  it("loadRunState marks a stage left mid-run as interrupted", async () => {
    const dir = await createRunDir("2026-08-26-1100");
    const run: Run = {
      ...baseRun("2026-08-26-1100"),
      status: "discussing",
      stages: [
        {
          number: 1, title: "אסטרטגיה", ownerSlug: "yoni-strategist",
          status: "approved", output: "בוצע", feedbackHistory: [], subTasks: [],
        },
        {
          number: 5, title: "עיצוב", ownerSlug: "daniel-lp-designer",
          status: "running", output: "", feedbackHistory: [],
          subTasks: [{ id: "5", title: "בניית דף", status: "running", output: "", feedbackHistory: [] }],
        },
      ],
    };
    await saveRunState(dir, run);
    const loaded = await loadRunState("2026-08-26-1100");
    expect(loaded?.stages?.[0].status).toBe("approved");
    expect(loaded?.stages?.[1].status).toBe("error");
    expect(loaded?.stages?.[1].errorMessage).toContain("נקטע");
    expect(loaded?.stages?.[1].subTasks[0].status).toBe("error");
    expect(loaded?.status).toBe("error");
  });

  it("listRunIds returns newest first and includes runs with no run.json", async () => {
    await createRunDir("2026-05-10-1939");
    const dir = await createRunDir("2026-08-26-1200");
    await saveRunState(dir, baseRun("2026-08-26-1200"));
    expect(await listRunIds()).toEqual(["2026-08-26-1200", "2026-05-10-1939"]);
  });

  it("readRunSummary uses run.json when present", async () => {
    const dir = await createRunDir("2026-08-26-1300");
    await saveRunState(dir, { ...baseRun("2026-08-26-1300"), brief: "השקת מועדון" });
    const summary = await readRunSummary("2026-08-26-1300");
    expect(summary).toMatchObject({ id: "2026-08-26-1300", brief: "השקת מועדון", status: "awaiting-decision", hasState: true });
  });

  it("readRunSummary falls back to brief.md for legacy runs with no run.json", async () => {
    const dir = await createRunDir("2026-05-11-0810");
    await saveBrief(dir, "קמפיין ישן מלפני השמירה");
    const summary = await readRunSummary("2026-05-11-0810");
    expect(summary.brief).toBe("קמפיין ישן מלפני השמירה");
    expect(summary.hasState).toBe(false);
  });

  it("copies a legacy run to the configured data directory without deleting the source", async () => {
    const legacyRoot = await fs.mkdtemp(path.join(os.tmpdir(), "council-legacy-"));
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "council-data-"));
    const id = "2026-08-26-legacy-copy";
    const legacyDir = path.join(legacyRoot, id);
    await fs.mkdir(path.join(legacyDir, "logs"), { recursive: true });
    await fs.writeFile(path.join(legacyDir, "run.json"), JSON.stringify(baseRun(id)));
    await fs.writeFile(path.join(legacyDir, "brief.md"), "legacy brief");
    await fs.writeFile(path.join(legacyDir, "logs", "old.log"), "legacy log");

    delete process.env.RUNS_DIR_OVERRIDE;
    process.env.CAMPAIGN_COUNCIL_DATA_DIR = dataRoot;
    process.env.RUNS_LEGACY_DIR_OVERRIDE = legacyRoot;
    try {
      expect((await loadRunState(id))?.id).toBe(id);
      const migratedDir = path.join(dataRoot, "runs", id);
      expect(await fs.readFile(path.join(migratedDir, "logs", "old.log"), "utf8")).toBe("legacy log");
      expect(await fs.readFile(path.join(legacyDir, "logs", "old.log"), "utf8")).toBe("legacy log");
      expect((await fs.stat(migratedDir)).mode & 0o777).toBe(0o700);
      expect((await fs.stat(path.join(migratedDir, "run.json"))).mode & 0o777).toBe(0o600);
    } finally {
      delete process.env.CAMPAIGN_COUNCIL_DATA_DIR;
      delete process.env.RUNS_LEGACY_DIR_OVERRIDE;
      process.env.RUNS_DIR_OVERRIDE = testRunsDir;
    }
  });

  it("rejects an unsafe legacy run without deleting or partially migrating it", async () => {
    const legacyRoot = await fs.mkdtemp(path.join(os.tmpdir(), "council-legacy-unsafe-"));
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "council-data-unsafe-"));
    const outside = path.join(legacyRoot, "outside.txt");
    const id = "2026-08-26-legacy-link";
    const legacyDir = path.join(legacyRoot, id);
    await fs.mkdir(legacyDir);
    await fs.writeFile(path.join(legacyDir, "run.json"), JSON.stringify(baseRun(id)));
    await fs.writeFile(outside, "outside");
    await fs.symlink(outside, path.join(legacyDir, "linked.txt"));

    delete process.env.RUNS_DIR_OVERRIDE;
    process.env.CAMPAIGN_COUNCIL_DATA_DIR = dataRoot;
    process.env.RUNS_LEGACY_DIR_OVERRIDE = legacyRoot;
    try {
      expect(await loadRunState(id)).toBeNull();
      expect((await fs.lstat(path.join(legacyDir, "linked.txt"))).isSymbolicLink()).toBe(true);
      await expect(fs.access(path.join(dataRoot, "runs", id))).rejects.toMatchObject({ code: "ENOENT" });
      const leftovers = await fs.readdir(path.join(dataRoot, "runs"));
      expect(leftovers.filter((name) => name.includes(id))).toEqual([]);
    } finally {
      delete process.env.CAMPAIGN_COUNCIL_DATA_DIR;
      delete process.env.RUNS_LEGACY_DIR_OVERRIDE;
      process.env.RUNS_DIR_OVERRIDE = testRunsDir;
    }
  });

  it("does not reuse a run id that still exists only in legacy storage", async () => {
    const legacyRoot = await fs.mkdtemp(path.join(os.tmpdir(), "council-legacy-id-"));
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "council-data-id-"));
    const id = "2026-08-26-existing-legacy";
    await fs.mkdir(path.join(legacyRoot, id));

    delete process.env.RUNS_DIR_OVERRIDE;
    process.env.CAMPAIGN_COUNCIL_DATA_DIR = dataRoot;
    process.env.RUNS_LEGACY_DIR_OVERRIDE = legacyRoot;
    try {
      await expect(createNewRunDir(id)).rejects.toMatchObject({ code: "EEXIST" });
      await expect(fs.access(path.join(legacyRoot, id))).resolves.toBeUndefined();
    } finally {
      delete process.env.CAMPAIGN_COUNCIL_DATA_DIR;
      delete process.env.RUNS_LEGACY_DIR_OVERRIDE;
      process.env.RUNS_DIR_OVERRIDE = testRunsDir;
    }
  });
});
