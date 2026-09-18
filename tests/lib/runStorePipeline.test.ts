import { describe, expect, it, beforeEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isPipeline, PIPELINES } from "@/types";
import { createRunDir, loadRunState, saveRunState } from "@/lib/runStore";
import type { Run } from "@/types";

let testRunsDir: string;

beforeEach(async () => {
  testRunsDir = await fs.mkdtemp(path.join(os.tmpdir(), "council-test-"));
  process.env.RUNS_DIR_OVERRIDE = testRunsDir;
});

const baseRun = (id: string): Run => ({
  id,
  slug: "test-run",
  brief: "בריף לבדיקה",
  createdAt: "2026-08-26T10:00:00.000Z",
  status: "awaiting-decision",
  currentRound: null,
  messages: [],
});

describe("run.pipeline", () => {
  it("lists both pipelines and recognises them", () => {
    expect(PIPELINES).toEqual(["council", "direct"]);
    expect(isPipeline("direct")).toBe(true);
    expect(isPipeline("board")).toBe(false);
  });

  it("round-trips a valid pipeline and refuses an unknown one", async () => {
    const validId = "2026-09-15-pipeline-valid";
    const validDir = await createRunDir(validId);
    const run: Run = { ...baseRun(validId), pipeline: "direct" };
    await saveRunState(validDir, run);
    const loaded = await loadRunState(validId);
    expect(loaded?.pipeline).toBe("direct");

    const invalidId = "2026-09-15-pipeline-invalid";
    const invalidDir = await createRunDir(invalidId);
    await fs.writeFile(
      path.join(invalidDir, "run.json"),
      JSON.stringify({ ...baseRun(invalidId), pipeline: "board" }),
      { mode: 0o600 },
    );
    expect(await loadRunState(invalidId)).toBeNull();
  });
});
