import { afterEach, describe, it, expect, vi } from "vitest";

// הטסטים כאן מזניקים תהליך node אמיתי. תחת עומס של ריצת חבילה מלאה במקביל
// עליית תהליך יכולה לחצות 2 שניות, ואז טסט התנהגות נופל על timeout של הסוכן
// במקום על מה שהוא בודק. טסטי ה-timeout המפורשים (30ms) נשארים כמו שהם.
vi.setConfig({ testTimeout: 30_000 });
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sanitizeEnv, spawnAgent } from "@/orchestrator/spawnAgent";

const temporaryDirectories: string[] = [];

async function fakeClaude(source: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "fake-claude-"));
  temporaryDirectories.push(directory);
  const command = path.join(directory, "claude");
  await fs.writeFile(command, `#!/usr/bin/env node\n${source}\n`, { mode: 0o700 });
  return command;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {}),
    ),
  );
});

describe("sanitizeEnv", () => {
  it("removes ANTHROPIC_API_KEY from env", () => {
    const input = { ANTHROPIC_API_KEY: "sk-...", PATH: "/usr/bin", HOME: "/home/tester" } as unknown as NodeJS.ProcessEnv;
    const out = sanitizeEnv(input);
    expect(out.ANTHROPIC_API_KEY).toBeUndefined();
    expect(out.PATH).toBe("/usr/bin");
    expect(out.HOME).toBe("/home/tester");
  });

  it("removes ANTHROPIC_API_URL and other anthropic vars", () => {
    const input = {
      ANTHROPIC_API_KEY: "x",
      ANTHROPIC_API_URL: "y",
      ANTHROPIC_BASE_URL: "z",
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_CODE_USE_VERTEX: "1",
      CLAUDE_CODE_USE_FOUNDRY: "1",
      AWS_SECRET_ACCESS_KEY: "secret",
      GITHUB_TOKEN: "secret",
      NODE_OPTIONS: "--require=/tmp/evil.js",
      PATH: "/usr/bin",
      CLAUDE_CODE_OAUTH_TOKEN: "subscription-oauth-token",
    } as unknown as NodeJS.ProcessEnv;
    const out = sanitizeEnv(input);
    expect(out.ANTHROPIC_API_KEY).toBeUndefined();
    expect(out.ANTHROPIC_API_URL).toBeUndefined();
    expect(out.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(out.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
    expect(out.CLAUDE_CODE_USE_VERTEX).toBeUndefined();
    expect(out.CLAUDE_CODE_USE_FOUNDRY).toBeUndefined();
    expect(out.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(out.GITHUB_TOKEN).toBeUndefined();
    expect(out.NODE_OPTIONS).toBeUndefined();
    expect(out.PATH).toBe("/usr/bin");
    expect(out.CLAUDE_CODE_OAUTH_TOKEN).toBe("subscription-oauth-token");
    expect(out.DISABLE_AUTOUPDATER).toBe("1");
    expect(out.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1");
  });
});

describe("spawnAgent process lifecycle", () => {
  it("sends the prompt over stdin instead of exposing it in argv", async () => {
    const command = await fakeClaude(`
let input = "";
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), input })));
`);
    const prompt = "private prompt with spaces";
    const result = await spawnAgent({ prompt, onToken: () => {}, command, timeoutMs: 20_000 });
    const received = JSON.parse(result.fullText);
    expect(received.input).toBe(prompt);
    expect(received.argv).not.toContain(prompt);
  });

  it("can create a text-only process isolated from inherited tools and settings", async () => {
    const command = await fakeClaude(`
process.stdin.resume();
process.stdin.on("end", () => process.stdout.write(JSON.stringify(process.argv.slice(2))));
`);
    const result = await spawnAgent({
      prompt: "plan only",
      onToken: () => {},
      command,
      timeoutMs: 20_000,
      tools: [],
      strictMcpConfig: true,
      settingSources: [],
      disableSlashCommands: true,
    });
    const argv = JSON.parse(result.fullText) as string[];
    expect(argv).toEqual(expect.arrayContaining([
      "--tools",
      "",
      "--strict-mcp-config",
      "--setting-sources",
      "",
      "--disable-slash-commands",
    ]));
  });

  it("passes bounded native sandbox settings without weakening the tool allowlist", async () => {
    const command = await fakeClaude(`
process.stdin.resume();
process.stdin.on("end", () => process.stdout.write(JSON.stringify(process.argv.slice(2))));
`);
    const settings = {
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        allowUnsandboxedCommands: false,
      },
    };
    const result = await spawnAgent({
      prompt: "assets",
      onToken: () => {},
      command,
      timeoutMs: 20_000,
      tools: ["Bash"],
      allowedTools: ["Bash"],
      disallowedTools: ["Task"],
      settings,
    });
    const argv = JSON.parse(result.fullText) as string[];
    expect(argv).toEqual(expect.arrayContaining([
      "--tools",
      "Bash",
      "--allowedTools",
      "Bash",
      "--disallowedTools",
      "Task",
      "--settings",
      JSON.stringify(settings),
    ]));
  });

  it("rejects oversized inline settings before starting Claude", async () => {
    await expect(spawnAgent({
      prompt: "no",
      onToken: () => {},
      command: "/does/not/matter",
      settings: { value: "x".repeat(70 * 1024) },
    })).rejects.toThrow(/64KB/);
  });

  it("rejects empty and oversized prompts before starting Claude", async () => {
    await expect(spawnAgent({
      prompt: " ",
      onToken: () => {},
      command: "/does/not/matter",
    })).rejects.toThrow(/must not be empty/);
    await expect(spawnAgent({
      prompt: "x".repeat(2 * 1024 * 1024 + 1),
      onToken: () => {},
      command: "/does/not/matter",
    })).rejects.toThrow(/2MB/);
  });

  it("decodes UTF-8 correctly when a character is split across stdout chunks", async () => {
    const command = await fakeClaude(`
process.stdin.resume();
process.stdin.on("end", () => {
  const bytes = Buffer.from("שלום", "utf8");
  process.stdout.write(bytes.subarray(0, 1));
  setTimeout(() => process.stdout.end(bytes.subarray(1)), 5);
});
`);
    const tokens: string[] = [];
    const result = await spawnAgent({
      prompt: "utf8",
      onToken: (token) => tokens.push(token),
      command,
      timeoutMs: 20_000,
    });
    expect(result.fullText).toBe("שלום");
    expect(tokens.join("")).toBe("שלום");
  });

  it("terminates and rejects a timed-out process", async () => {
    const command = await fakeClaude(`setInterval(() => {}, 1000);`);
    await expect(
      spawnAgent({ prompt: "hang", onToken: () => {}, command, timeoutMs: 30 }),
    ).rejects.toThrow(/timed out/i);
  });

  it("terminates descendants in the same process group on timeout", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-tree-"));
    temporaryDirectories.push(directory);
    const canary = path.join(directory, "grandchild-was-alive");
    const command = await fakeClaude(`
const { spawn } = require("node:child_process");
spawn(process.execPath, ["-e", ${JSON.stringify(
      `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(canary)}, "alive"), 250); setInterval(() => {}, 1000);`,
    )}], { stdio: "ignore" });
setInterval(() => {}, 1000);
`);
    await expect(
      spawnAgent({ prompt: "hang tree", onToken: () => {}, command, timeoutMs: 30 }),
    ).rejects.toThrow(/timed out/i);
    await new Promise((resolve) => setTimeout(resolve, 350));
    await expect(fs.access(canary)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
