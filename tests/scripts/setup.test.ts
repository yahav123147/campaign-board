import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..", "..");

describe("clean client setup", () => {
  it("connects installed standards in a new private profile and preserves existing settings on rerun", async () => {
    const temporaryRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "council-setup-test-")));
    const fixture = path.join(temporaryRoot, "application");
    await fs.mkdir(fixture);
    try {
      const commands = path.join(fixture, "commands");
      const clientHome = path.join(temporaryRoot, "client-files");
      await fs.mkdir(commands);
      await fs.mkdir(path.join(fixture, "config"));
      await fs.copyFile("config/client-profile.example.json", path.join(fixture, "config", "client-profile.example.json"));
      await fs.cp("config/standards", path.join(fixture, "config", "standards"), { recursive: true });
      await fs.copyFile(".env.example", path.join(fixture, ".env.example"));
      for (const item of ["scripts/configure-client.mjs", "lib/platformAcceptance.mjs", "config/platform-acceptance.json", "templates", "vendor/landing-skill", "assets/fonts/Heebo.ttf"]) {
        await fs.cp(item, path.join(fixture, item), { recursive: true });
      }
      const clientDirectory = path.join(clientHome, "client-install");
      // Keep the real HOME untouched. Only the copied script's destination is
      // redirected; every installer/network command is replaced by a stub.
      const source = (await fs.readFile("setup.sh", "utf8")).replaceAll("$HOME", "$COUNCIL_SETUP_TEST_HOME");
      const script = path.join(fixture, "setup-isolated.sh");
      await fs.writeFile(script, source);
      const stubs = {
        npm: '#!/bin/bash\nif [[ "$1 $2" == "run doctor" ]]; then exit 1; fi\n',
        npx: '#!/bin/bash\nprintf "%s\\n" "$*" >> "$COUNCIL_SETUP_COMMAND_LOG"\n',
        uname: '#!/bin/bash\nprintf "Linux\\n"\n',
        claude: "#!/bin/bash\nexit 99\n",
        // Not under test here (see the "setup.sh on Linux" describe below);
        // stubbed present so the bubblewrap-install branch is skipped.
        bwrap: "#!/bin/bash\nexit 0\n",
        // direct-chain's setup.sh parses `python3 --version` output to gate on
        // 3.10+ (a Mac's stock python3 is 3.9.6): the stub must answer that
        // call with a real version string, not just the venv invocation.
        python3: '#!/bin/bash\nif [[ "$1 $2" == "-m venv" ]]; then mkdir -p "$3/bin"; touch "$3/bin/activate"; fi\nif [[ "$1" == "--version" ]]; then echo "Python 3.12.4"; fi\n',
      };
      for (const [name, body] of Object.entries(stubs)) {
        await fs.writeFile(path.join(commands, name), body, { mode: 0o755 });
      }
      const run = () => execFileSync("/bin/bash", [script, "--name", "Example Client", "--id", "example-client", "--fact", "Offers local consulting.", "--directory", clientDirectory], {
        cwd: fixture,
        encoding: "utf8",
        timeout: 10_000,
        env: { ...process.env, PATH: `${commands}:${process.env.PATH}`, COUNCIL_SETUP_TEST_HOME: clientHome, COUNCIL_SETUP_COMMAND_LOG: path.join(temporaryRoot, "commands.log") },
      });
      expect(run()).toContain("המערכת עדיין אינה מוכנה לריצה");
      expect(await fs.readFile(path.join(temporaryRoot, "commands.log"), "utf8")).toContain("playwright install --with-deps chromium");
      const configDir = path.join(clientDirectory, "standards");
      const profileFile = path.join(clientDirectory, "profile.json");
      const profile = JSON.parse(await fs.readFile(profileFile, "utf8"));
      expect(profile.copy).toMatchObject({
        standardPath: path.join(configDir, "copy-standard.md"),
        adsStandardPath: path.join(configDir, "ads-standard.md"),
        pageTypesDir: path.join(configDir, "page-types"),
      });
      expect(profile.creative.standardPath).toBe(path.join(configDir, "creative-standard.md"));
      expect(profile.policies.capabilities.landingPageBuild).toBe(false);
      expect((await fs.stat(profileFile)).mode & 0o777).toBe(0o600);
      expect((await fs.stat(configDir)).mode & 0o777).toBe(0o700);
      expect((await fs.stat(path.join(fixture, ".env.local"))).mode & 0o777).toBe(0o600);
      await fs.access(path.join(profile.copy.pageTypesDir, "webinar-page.md"));

      profile.copy.standardPath = "/client/custom-standard.md";
      const preserved = JSON.stringify(profile);
      await fs.writeFile(profileFile, preserved);
      await fs.writeFile(path.join(configDir, "copy-standard.md"), "custom rules");
      await fs.writeFile(path.join(fixture, ".env.local"), "CUSTOM_SETTING=keep\n");
      run();
      expect(await fs.readFile(profileFile, "utf8")).toBe(preserved);
      expect(await fs.readFile(path.join(configDir, "copy-standard.md"), "utf8")).toBe("custom rules");
      expect(await fs.readFile(path.join(fixture, ".env.local"), "utf8")).toBe("CUSTOM_SETTING=keep\n");
    } finally {
      await fs.rm(temporaryRoot, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("setup.sh on Linux", () => {
  /**
   * The brief's original case ("no bwrap and no sudo") is not hermetic: this
   * file's stub directory is prepended to the REAL PATH (see the PATH env
   * above), so on a Linux host with real sudo/apt-get, the script would
   * shell out to the actual package manager from inside a unit test. This
   * case instead stubs sudo and apt-get to only log their argv and exit 0,
   * so the install command is never really run, and proves the install
   * line fires and setup proceeds past the block (reaches the npm stub).
   *
   * Whether that install line fires at all depends on the host: the
   * ubuntu-24.04 CI runner installs bubblewrap before the suite runs (for
   * the sandbox tests), so there `command -v bwrap` already succeeds and
   * setup.sh skips the install branch entirely. tests/orchestrator/processSandbox.test.ts
   * faces the same fact and branches on bwrap's presence rather than
   * assuming either host; this test follows that idiom via a PATH lookup
   * (this test's own stub directory never defines bwrap, so the lookup
   * reflects the real host exactly as setup.sh's own `command -v bwrap`
   * would see it) probed with the exact same PATH the script below runs
   * under, so the probe and the script can never disagree about what
   * `command -v bwrap` resolves to.
   */
  it("proves the bubblewrap step on either kind of host: installs when absent, skips when already present, and always reaches npm ci", async () => {
    const bin = await fs.mkdtemp(path.join(os.tmpdir(), "council-setup-linux-bin-"));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "council-setup-linux-home-"));
    const commandLog = path.join(home, "commands.log");
    await fs.writeFile(commandLog, "");
    try {
      const scriptPath = `${bin}:${process.env.PATH}`;
      const hasBwrap = spawnSync("bash", ["-c", "command -v bwrap"], { env: { PATH: scriptPath, NODE_ENV: "test" } }).status === 0;
      const stub = async (name: string, body: string) => {
        await fs.writeFile(path.join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
      };
      // Every command setup.sh probes before the Linux block just needs to
      // exist; sudo and apt-get only log what they were asked to run; npm
      // exits with a distinctive code the moment it is reached, so the test
      // never needs to simulate anything past the Linux block.
      await stub("uname", "printf 'Linux\\n'");
      await stub("node", "exit 0");
      await stub("git", "exit 0");
      await stub("claude", "exit 0");
      await stub("python3", "[[ \"$1\" == \"--version\" ]] && echo 'Python 3.12.4'\nexit 0");
      await stub("sudo", 'printf "sudo %s\\n" "$*" >> "$COUNCIL_SETUP_COMMAND_LOG"');
      await stub("apt-get", 'printf "apt-get %s\\n" "$*" >> "$COUNCIL_SETUP_COMMAND_LOG"');
      await stub("npm", 'printf "npm %s\\n" "$*" >> "$COUNCIL_SETUP_COMMAND_LOG"\nexit 77');
      let status: number | null | undefined;
      try {
        execFileSync("/bin/bash", [path.join(ROOT, "setup.sh")], {
          cwd: ROOT,
          encoding: "utf8",
          timeout: 10_000,
          env: { PATH: scriptPath, HOME: home, LANG: "en_US.UTF-8", NODE_ENV: "test", COUNCIL_SETUP_COMMAND_LOG: commandLog },
        });
      } catch (error) {
        status = (error as { status?: number | null }).status;
      }
      expect(status).toBe(77);
      const log = await fs.readFile(commandLog, "utf8");
      if (hasBwrap) {
        // Already present on this host (e.g. the ubuntu-24.04 CI runner,
        // which installs it ahead of the sandbox tests): the install branch
        // must not fire.
        expect(log).not.toContain("apt-get install -y bubblewrap");
      } else {
        // Absent on this host (e.g. macOS, or a bare Linux runner): setup.sh
        // must install it via sudo apt-get.
        expect(log).toContain("apt-get install -y bubblewrap");
      }
      expect(log).toContain("npm ci");
    } finally {
      await fs.rm(bin, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
    }
  }, 15_000);
});
