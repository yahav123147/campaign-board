import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The acceptance checklist reads "network: none" from the run's own build
// log. The build runs inside a private, non-exported function, so this test
// holds the source to the contract the same way imageMapScenario.test.ts
// does: every build call hands the stage log to the function, and the
// function writes the launch profile in the block the preview server already
// uses, so one grep finds both.
describe("landing build sandbox profile logging", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "orchestrator", "runStage5LpBuild.ts"), "utf8");

  it("passes the stage 5.3 log to every build call", () => {
    // Each call is on one line; the log argument itself carries a nested ")".
    const calls = [...source.matchAll(/await runLandingBuild\((.*)\);/g)].map((match) => match[1]);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const args of calls) expect(args).toContain('path.join(runDir, "logs", logName)');
  });

  it("writes the profile in the shared '# sandbox profile' block before the build starts", () => {
    const body = source.slice(source.indexOf("async function runLandingBuild("));
    // The write itself, not the doc comment that names the block.
    const profileWrite = body.indexOf("# sandbox profile\\n${launch.profile}\\n# end profile");
    const spawnCall = body.indexOf("supervisedProcessTreeLaunch(launch.command, launch.args)");
    expect(profileWrite).toBeGreaterThan(-1);
    expect(spawnCall).toBeGreaterThan(-1);
    expect(profileWrite).toBeLessThan(spawnCall);
    expect(body.slice(profileWrite - 120, profileWrite)).toContain("fs.appendFile(profileLogFile");
  });
});
