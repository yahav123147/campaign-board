#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { packageClient } from "./package-client.mjs";

// Test the actual distributable with its own installed dependencies. The setup
// fixture stubs external installers and Claude; this smoke never runs AI or
// writes a client profile into the operator's home directory.
const packaged = await packageClient();
const checksum = (await fs.readFile(packaged.checksum, "utf8")).split(/\s+/)[0];
assert.equal(createHash("sha256").update(await fs.readFile(packaged.archive)).digest("hex"), checksum);

const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "council-client-smoke-")));
try {
  execFileSync("tar", ["-xzf", packaged.archive, "-C", temporary], { stdio: "inherit", timeout: 60_000 });
  const client = path.join(temporary, "campaign-council");
  for (const forbidden of [".git", ".env.local", "runs", "node_modules"]) {
    await assert.rejects(fs.lstat(path.join(client, forbidden)), { code: "ENOENT" });
  }
  const run = (command, args, timeout, cwd = client) => execFileSync(command, args, {
    cwd,
    stdio: ["ignore", "inherit", "inherit"],
    timeout,
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
  });
  run("npm", ["ci"], 600_000);
  run("npx", ["vitest", "run", "tests/scripts/setup.test.ts", "--maxWorkers=2"], 120_000);
  const privateClient = path.join(temporary, "private-client");
  run("npm", ["run", "configure", "--",
    "--name", "Example Client",
    "--id", "ci-client",
    "--fact", "The client provides a service described in its approved brief.",
    "--directory", privateClient,
    "--locale", "en-US", "--timezone", "UTC",
  ], 600_000);
  const profile = JSON.parse(await fs.readFile(path.join(privateClient, "profile.json"), "utf8"));
  assert.equal(profile.tenant.id, "ci-client");
  assert.ok(Object.values(profile.policies.capabilities).every((enabled) => enabled === false));
  run("npm", ["run", "build"], 600_000, path.join(privateClient, "landing"));
  run("npm", ["run", "build"], 600_000);
  process.stdout.write("Client archive passed checksum, privacy, dependency installation, setup, configuration and both production builds.\n");
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
