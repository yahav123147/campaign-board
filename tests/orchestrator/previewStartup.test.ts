import { describe, expect, it, vi } from "vitest";
import {
  coordinatePreviewStart,
  type PreviewStartCoordinator,
} from "@/orchestrator/previewServer";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function ownership() {
  let owner: string | undefined;
  return {
    setOwner(workspace: string) {
      owner = workspace;
    },
    isOwnedAndOpen: vi.fn(async (workspace?: string) => (
      workspace ? owner === workspace : owner !== undefined
    )),
  };
}

describe("preview startup coordination", () => {
  it("launches only once for concurrent requests to the same workspace", async () => {
    const coordinator: PreviewStartCoordinator = {};
    const gate = deferred();
    const preview = ownership();
    let launches = 0;
    const startOnce = async () => {
      launches += 1;
      await gate.promise;
      preview.setOwner("/tmp/workspace-a");
    };

    const first = coordinatePreviewStart(
      coordinator,
      "/tmp/workspace-a",
      preview.isOwnedAndOpen,
      startOnce,
    );
    const second = coordinatePreviewStart(
      coordinator,
      "/tmp/workspace-a",
      preview.isOwnedAndOpen,
      startOnce,
    );

    await vi.waitFor(() => expect(launches).toBe(1));
    gate.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    expect(launches).toBe(1);
    expect(coordinator.inFlight).toBeUndefined();
  });

  it("rejects a different workspace queued behind an active launch", async () => {
    const coordinator: PreviewStartCoordinator = {};
    const gate = deferred();
    const preview = ownership();
    let launches = 0;
    const startFirst = async () => {
      launches += 1;
      await gate.promise;
      preview.setOwner("/tmp/workspace-a");
    };

    const first = coordinatePreviewStart(
      coordinator,
      "/tmp/workspace-a",
      preview.isOwnedAndOpen,
      startFirst,
    );
    const second = coordinatePreviewStart(
      coordinator,
      "/tmp/workspace-b",
      preview.isOwnedAndOpen,
      async () => {
        launches += 1;
        preview.setOwner("/tmp/workspace-b");
      },
    );

    await vi.waitFor(() => expect(launches).toBe(1));
    gate.resolve();
    await expect(first).resolves.toBeUndefined();
    await expect(second).rejects.toThrow("different Campaign Council run");
    expect(launches).toBe(1);
    expect(coordinator.inFlight).toBeUndefined();
  });
});
