import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRunDir } from "@/lib/runStore";
import {
  __resetRegistryForTests,
  createRun,
  flushPersistence,
} from "@/orchestrator/runRegistry";
import { GET } from "@/app/api/runs/[id]/harvest/[file]/route";
import type { Run } from "@/types";

const RUN_ID = "2026-09-15-harvest-sheet";

let runsDir: string;

function run(): Run {
  return {
    id: RUN_ID,
    slug: "harvest-sheet",
    brief: "A sufficiently long harvest route test brief",
    createdAt: "2026-09-15T10:00:00.000Z",
    status: "approved",
    currentRound: null,
    messages: [],
    pipeline: "direct",
  };
}

function request(file: string): NextRequest {
  return new NextRequest(
    `http://127.0.0.1:4321/api/runs/${RUN_ID}/harvest/${encodeURIComponent(file)}`,
  );
}

function call(file: string) {
  return GET(request(file), { params: Promise.resolve({ id: RUN_ID, file }) });
}

beforeEach(async () => {
  runsDir = await fs.mkdtemp(path.join(os.tmpdir(), "council-harvest-route-"));
  process.env.RUNS_DIR_OVERRIDE = runsDir;
  __resetRegistryForTests();
});

afterEach(async () => {
  await flushPersistence();
  __resetRegistryForTests();
  delete process.env.RUNS_DIR_OVERRIDE;
  await fs.rm(runsDir, { recursive: true, force: true, maxRetries: 5 });
});

describe("GET /api/runs/:id/harvest/:file", () => {
  it("serves the harvest sheet as an uncached jpeg", async () => {
    createRun(run());
    const dir = await createRunDir(RUN_ID);
    await fs.mkdir(path.join(dir, "harvest"), { recursive: true });
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x01]);
    await fs.writeFile(path.join(dir, "harvest", "sheet.jpg"), bytes);

    const response = await call("sheet.jpg");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(Buffer.from(await response.arrayBuffer()).equals(bytes)).toBe(true);
  });

  it("returns 404 when the sheet was never harvested", async () => {
    createRun(run());
    await createRunDir(RUN_ID);

    const response = await call("sheet.jpg");

    expect(response.status).toBe(404);
  });

  it("returns 404 when the run does not exist", async () => {
    const response = await call("sheet.jpg");

    expect(response.status).toBe(404);
  });

  it("refuses any other file name", async () => {
    createRun(run());
    const dir = await createRunDir(RUN_ID);
    await fs.writeFile(path.join(dir, "run.json"), "{}");

    for (const file of ["../run.json", "other.png"]) {
      const response = await call(file);
      expect(response.status).toBe(400);
    }
  });
});
