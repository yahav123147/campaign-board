import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: spawnMock };
});

import { collectRenderedAssetUrls } from "@/orchestrator/previewServer";

type FakeProcess = EventEmitter & {
  stdout: PassThrough;
  stderr: PassThrough;
  connected: boolean;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  killed: boolean;
  kill: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
};

function fakeProcess(stdout: string, code = 0, stderr = ""): FakeProcess {
  const proc = new EventEmitter() as FakeProcess;
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.connected = true;
  proc.exitCode = null;
  proc.signalCode = null;
  proc.killed = false;
  proc.send = vi.fn(() => true);
  proc.kill = vi.fn(() => {
    proc.killed = true;
    return true;
  });
  setImmediate(() => {
    if (stdout) proc.stdout.write(stdout);
    if (stderr) proc.stderr.write(stderr);
    proc.exitCode = code;
    proc.connected = false;
    proc.emit("close", code, null);
  });
  return proc;
}

describe("collectRenderedAssetUrls", () => {
  beforeEach(() => spawnMock.mockReset());

  it("runs without a shell, deduplicates URLs, and keeps violations visible", async () => {
    const oversizedDataUrl = `data:image/png;base64,${"A".repeat(8_200)}`;
    spawnMock.mockReturnValue(
      fakeProcess(
        JSON.stringify([
          "https://example.test/a.png",
          "https://example.test/a.png",
          "data:image/png;base64,AA==",
          "javascript:alert(1)",
          oversizedDataUrl,
        ]),
      ),
    );

    await expect(collectRenderedAssetUrls("https://example.test/page?q=1")).resolves.toEqual([
      "https://example.test/a.png",
      "data:image/png;base64,AA==",
      "invalid:asset-collector-unsupported-output?protocol=javascript%3A",
      `invalid:asset-collector-oversized-output?protocol=data&length=${oversizedDataUrl.length}`,
    ]);

    expect(spawnMock).toHaveBeenCalledOnce();
    const [command, args, options] = spawnMock.mock.calls[0];
    expect(command).toBe(process.execPath);
    expect(args.at(-1)).toBe("https://example.test/page?q=1");
    expect(options).toMatchObject({
      shell: false,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
  });

  it("surfaces navigation or browser failures", async () => {
    spawnMock.mockReturnValue(fakeProcess("", 1, '{"error":"navigation returned HTTP 500"}\n'));

    await expect(collectRenderedAssetUrls("http://localhost:4322/test")).rejects.toThrow(
      /navigation returned HTTP 500/,
    );
  });

  it("rejects unsafe page URLs before spawning", async () => {
    await expect(collectRenderedAssetUrls("file:///etc/passwd")).rejects.toThrow(/http or https/);
    await expect(collectRenderedAssetUrls("https://user:secret@example.test/")).rejects.toThrow(
      /credentials/,
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
