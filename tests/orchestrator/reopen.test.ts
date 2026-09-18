import { describe, it, expect } from "vitest";
import { reopenSubTask } from "@/orchestrator/stageRegistry";
import type { Stage } from "@/types";

const stage5 = (): Stage => ({
  number: 5,
  title: "עיצוב",
  ownerSlug: "daniel-lp-designer",
  status: "approved",
  output: "סיכום",
  feedbackHistory: [],
  subTasks: [
    { id: "5.1", title: "בריף מותג", status: "approved", output: "פלטה", feedbackHistory: [] },
    { id: "5.2", title: "בנייה", status: "approved", output: "דף", feedbackHistory: [] },
    { id: "5.3", title: "תצוגה", status: "approved", output: "לינק", feedbackHistory: [] },
  ],
});

const stage6 = (): Stage => ({
  number: 6,
  title: "קראייטיבים",
  ownerSlug: "roni-creative",
  status: "approved",
  output: "זוויות",
  feedbackHistory: [],
  subTasks: [{ id: "6", title: "זוויות", status: "approved", output: "3 זוויות", feedbackHistory: [] }],
});

describe("reopenSubTask", () => {
  it("reopens the sub-task and everything after it in the same stage", () => {
    const [s5] = reopenSubTask([stage5()], 5, "5.2");
    expect(s5.subTasks.map((st) => st.status)).toEqual(["approved", "pending", "pending"]);
  });

  it("keeps the approved work that came before it", () => {
    const [s5] = reopenSubTask([stage5()], 5, "5.2");
    expect(s5.subTasks[0].output).toBe("פלטה");
  });

  it("clears the output of what it reopened, so nothing stale is shown as done", () => {
    const [s5] = reopenSubTask([stage5()], 5, "5.2");
    expect(s5.subTasks[1].output).toBe("");
    expect(s5.subTasks[2].output).toBe("");
  });

  it("clears stale asset seals when stage 5.2 is reopened", () => {
    const input = stage5();
    input.subTasks[1].assetManifestSha256 = "old-approved";
    input.subTasks[1].assetManifestDraftSha256 = "old-draft";
    input.subTasks[1].assetContactSheetFile = "contact-sheet-old.html";
    input.subTasks[1].assetContactSheetSha256 = "old-sheet";

    const [s5] = reopenSubTask([input], 5, "5.2");

    expect(s5.subTasks[1].assetManifestSha256).toBeUndefined();
    expect(s5.subTasks[1].assetManifestDraftSha256).toBeUndefined();
    expect(s5.subTasks[1].assetContactSheetFile).toBeUndefined();
    expect(s5.subTasks[1].assetContactSheetSha256).toBeUndefined();
  });

  it("clears page snapshots and delivery receipts when the build is reopened", () => {
    const input = stage5();
    const build = input.subTasks[2];
    build.preparedAssetHashes = { "hero.webp": "a".repeat(64) };
    build.pageSourceHashes = { "page.tsx": "b".repeat(64) };
    build.landingHeadSha = "c".repeat(40);
    build.landingCommitSha = "d".repeat(40);
    build.pageSlug = "generated-page";
    build.landingWorktreePath = "/private/tmp/generated-worktree";

    const [s5] = reopenSubTask([input], 5, "5.3");
    const reopened = s5.subTasks[2];
    expect(reopened).toMatchObject({ status: "pending", output: "" });
    expect(reopened.preparedAssetHashes).toBeUndefined();
    expect(reopened.pageSourceHashes).toBeUndefined();
    expect(reopened.landingHeadSha).toBeUndefined();
    expect(reopened.landingCommitSha).toBeUndefined();
    expect(reopened.pageSlug).toBeUndefined();
    expect(reopened.landingWorktreePath).toBeUndefined();
  });

  it("clears the mockup render receipt when stage 5.2 is reopened", () => {
    const input = stage5();
    input.subTasks[1].mockupRender = {
      schemaVersion: 1,
      attemptId: "attempt-old",
      baseSha256: { chapter: "c".repeat(64) },
      mockups: [{
        file: "module-1-mockup.webp",
        screensSha256: { "ch1-laptop": "d".repeat(64) },
        outputSha256: "e".repeat(64),
        status: "ok",
      }],
      renderedAt: "2026-09-16T10:05:00.000Z",
    };

    const [s5] = reopenSubTask([input], 5, "5.2");

    // A rerun re-renders everything it declares, so last attempt's receipt
    // must never be able to qualify a file the new attempt did not render.
    expect(s5.subTasks[1].mockupRender).toBeUndefined();
  });

  it("puts the stage itself back in play", () => {
    const [s5] = reopenSubTask([stage5()], 5, "5.2");
    expect(s5.status).toBe("pending");
    expect(s5.output).toBe("");
  });

  it("leaves other stages alone", () => {
    const [, s6] = reopenSubTask([stage5(), stage6()], 5, "5.2");
    expect(s6).toEqual(stage6());
  });

  it("is a no-op for a sub-task that does not exist", () => {
    const before = [stage5()];
    expect(reopenSubTask(before, 5, "9.9")).toEqual(before);
  });
});
