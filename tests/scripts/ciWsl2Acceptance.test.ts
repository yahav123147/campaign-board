import { describe, expect, it } from "vitest";
import {
  assessEvidence,
  criticBlockers,
  designReviewExcerpt,
  errorActions,
  failedSubTasks,
  forgetsApproval,
  isStalled,
  latestStages,
  MAX_FEEDBACK_ROUNDS,
  parseSseFrames,
  qaFeedbackFromOutput,
  reviewerActions,
  runIsComplete,
  sandboxProfileNetwork,
  STALL_LIMIT_MS,
} from "../../scripts/ci-wsl2-acceptance.mjs";

const stage = (number: number, status: string, subTasks: { id: string; status: string; errorMessage?: string; criticRounds?: unknown[] }[]) => ({ number, status, subTasks });

describe("parseSseFrames", () => {
  it("reads data frames, skips heartbeats and a frame cut mid-JSON", () => {
    const text = 'data: {"type":"stages-initialized","runId":"r","stages":[]}\n\n: heartbeat\n\ndata: {"type":"run-comp';
    expect(parseSseFrames(text)).toEqual([{ type: "stages-initialized", runId: "r", stages: [] }]);
  });
});

describe("latestStages", () => {
  it("returns the last stage tree carried by the events", () => {
    const events = [
      { type: "stages-initialized", stages: [stage(1, "running", [])] },
      { type: "subtask-token" },
      { type: "stages-initialized", stages: [stage(1, "approved", [])] },
    ];
    expect(latestStages(events)?.[0].status).toBe("approved");
    expect(latestStages([{ type: "subtask-token" }])).toBeUndefined();
  });
});

describe("reviewerActions", () => {
  const blocked = { round: 2, verdict: "block", reason: "requiredMockups ריק", fixes: [{ quote: "[]", rule: "רשימת מוקאפים", fix: "מוקאפ לכל מודול" }], at: "t" };
  it("approves human gates on sight, and leaves an express gate alone inside its grace period", () => {
    const stages = [
      stage(1, "awaiting-decision", [{ id: "1", status: "awaiting-decision" }]),
      stage(3, "awaiting-decision", [{ id: "3", status: "awaiting-decision" }]),
      stage(5, "running", [{ id: "5.2", status: "running" }, { id: "5.3", status: "pending" }]),
    ];
    const seen = new Map<string, number>();
    expect(reviewerActions(stages, seen, new Map(), 1_000, 500)).toEqual([{ stage: 1, subTaskId: "1", action: "approve" }]);
    expect(reviewerActions(stages, seen, new Map(), 1_200, 500)).toEqual([{ stage: 1, subTaskId: "1", action: "approve" }]);
  });
  it("approves an express gate the critic did not block once the grace period passes", () => {
    const stages = [stage(3, "awaiting-decision", [{ id: "3", status: "awaiting-decision", criticRounds: [{ round: 1, verdict: "approve", at: "t" }] }])];
    const seen = new Map<string, number>([["3:3", 0]]);
    expect(reviewerActions(stages, seen, new Map(), 600, 500)).toEqual([{ stage: 3, subTaskId: "3", action: "approve" }]);
  });
  it("sends the critic's blockers back as feedback instead of approving a blocked express gate", () => {
    // Run 35749912557: the design critic scored the brief 1/10 for an empty
    // requiredMockups list, express rightly refused, and the driver approved
    // it anyway; 5.2 then stopped the run. A reviewer sends it back.
    const stages = [stage(3, "awaiting-decision", [{ id: "3", status: "awaiting-decision", criticRounds: [blocked] }])];
    const seen = new Map<string, number>([["3:3", 0]]);
    const actions = reviewerActions(stages, seen, new Map(), 600, 500);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ stage: 3, subTaskId: "3", action: "feedback" });
    const feedback = (actions[0] as { feedback?: string }).feedback ?? "";
    expect(feedback).toContain("requiredMockups ריק");
    expect(feedback).toContain("רשימת מוקאפים: מוקאפ לכל מודול");
  });
  it("stops, naming the blocker, after the feedback budget is spent", () => {
    const stages = [stage(3, "awaiting-decision", [{ id: "3", status: "awaiting-decision", criticRounds: [blocked] }])];
    const seen = new Map<string, number>([["3:3", 0]]);
    const actions = reviewerActions(stages, seen, new Map([["3:3", MAX_FEEDBACK_ROUNDS]]), 600, 500);
    expect(actions[0]).toMatchObject({ stage: 3, subTaskId: "3", action: "stop" });
    expect((actions[0] as { reason?: string }).reason).toContain("requiredMockups ריק");
  });
  it("names 5.2 and 5.4 as human gates, never a running or approved task", () => {
    const stages = [stage(5, "running", [{ id: "5.2", status: "awaiting-decision" }, { id: "5.3", status: "approved" }, { id: "5.4", status: "awaiting-decision" }])];
    expect(reviewerActions(stages, new Map(), new Map(), 0)).toEqual([
      { stage: 5, subTaskId: "5.2", action: "approve" },
      { stage: 5, subTaskId: "5.4", action: "approve" },
    ]);
  });
});

describe("criticBlockers reads stage 5.3's design review", () => {
  // Run 35927734880: three design critics failed the last round, the stage
  // said a human decision was required, express refused, and this driver
  // approved because it read criticRounds only.
  const review = { schemaVersion: 1, passed: false, failing: ["רוני אבישר", "אבישי דרור", "אורי שגב"], silent: [], checkedAt: "t" };
  it("names the failing critics as blockers, and none when the review passed", () => {
    expect(criticBlockers({ designReview: review })).toContain("רוני אבישר, אבישי דרור, אורי שגב");
    expect(criticBlockers({ designReview: { ...review, passed: true, failing: [] } })).toBeNull();
    expect(criticBlockers({ designReview: { ...review, failing: [], silent: ["אורי שגב"] } })).toContain("לא הצביע");
  });
  it("sends a blocked 5.3 back as feedback with the critics' lines instead of approving it", () => {
    const output = "## סבב עיצוב 2 מתוך 2\n🔎 רוני אבישר מסתכל...\n❌ רוני אבישר: לא עובר\n⚠️ נגמרו הסבבים ועדיין יש חוסמים.\n- **פסק דין סופי:** ⚠️ נשארו חוסמים\n";
    const stages = [stage(5, "awaiting-decision", [{ id: "5.3", status: "awaiting-decision", designReview: review, output } as never])];
    const seen = new Map<string, number>([["5:5.3", 0]]);
    const actions = reviewerActions(stages, seen, new Map(), 600, 500);
    expect(actions[0]).toMatchObject({ stage: 5, subTaskId: "5.3", action: "feedback" });
    const feedback = (actions[0] as { feedback?: string }).feedback ?? "";
    expect(feedback).toContain("רוני אבישר");
    expect(feedback).toContain("❌ רוני אבישר: לא עובר");
    expect(feedback).not.toContain("מסתכל");
  });
  it("still approves a 5.3 whose design review passed", () => {
    const stages = [stage(5, "awaiting-decision", [{ id: "5.3", status: "awaiting-decision", designReview: { ...review, passed: true, failing: [] } } as never])];
    const seen = new Map<string, number>([["5:5.3", 0]]);
    expect(reviewerActions(stages, seen, new Map(), 600, 500)).toEqual([{ stage: 5, subTaskId: "5.3", action: "approve" }]);
  });
  it("excerpts only the verdict and summary lines of the last design round", () => {
    expect(designReviewExcerpt("no rounds here")).toBe("");
    const excerpt = designReviewExcerpt("## סבב עיצוב 1\n❌ א: לא עובר\n## סבב עיצוב 2\nnoise\n✅ ב: עובר\n  - סבב 2: 1/3 עברו\n");
    expect(excerpt).toBe("✅ ב: עובר\n  - סבב 2: 1/3 עברו");
    const withReasoning = designReviewExcerpt("## סבב עיצוב 2\n❌ א: לא עובר\n### 📦 סיכום\n### ⚠️ חוסמים שנשארו\n## א\nפסק דין: לא עובר\n1. [CTA] הכפתור נשבר לשתי שורות.\n");
    expect(withReasoning).toContain("❌ א: לא עובר");
    expect(withReasoning).toContain("הכפתור נשבר לשתי שורות");
    expect(withReasoning).not.toContain("### ");
  });
});

describe("criticBlockers", () => {
  it("quotes the newest round only, and nothing for an approving or absent critic", () => {
    expect(criticBlockers({ criticRounds: [] })).toBeNull();
    expect(criticBlockers({ criticRounds: [{ round: 1, verdict: "approve", at: "t" }] })).toBeNull();
    expect(criticBlockers({ criticRounds: [{ round: 1, verdict: "block", reason: "old", at: "t" }, { round: 2, verdict: "revise", reason: "new", at: "t" }] })).toBe("new");
    expect(criticBlockers({ criticRounds: [{ round: 1, verdict: "unreadable", at: "t" }] })).toContain("unreadable");
  });
});

describe("errorActions", () => {
  it("sends a failed sub-task's error back as feedback, then stops once the budget is spent", () => {
    // Run 35772211794: stage 5.3's build failed on a type error in the
    // generated page; the board's feedback route reruns an errored sub-task.
    const stages = [stage(5, "error", [{ id: "5.3", status: "error", errorMessage: "Landing build failed (exit 1): TS2322" }])];
    const first = errorActions(stages, new Map());
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ stage: 5, subTaskId: "5.3", action: "feedback" });
    expect((first[0] as { feedback?: string }).feedback).toContain("TS2322");
    const spent = errorActions(stages, new Map([["5:5.3", MAX_FEEDBACK_ROUNDS]]));
    expect(spent[0]).toMatchObject({ action: "stop" });
    expect((spent[0] as { reason?: string }).reason).toContain("TS2322");
    expect(errorActions([stage(5, "running", [{ id: "5.3", status: "running" }])], new Map())).toEqual([]);
  });
});

describe("isStalled", () => {
  it("flags a run only once nothing has changed for longer than the stall limit", () => {
    expect(isStalled(0, STALL_LIMIT_MS)).toBe(false);
    expect(isStalled(0, STALL_LIMIT_MS + 1)).toBe(true);
    expect(isStalled(1_000, 1_500, 400)).toBe(true);
    // Above the board's longest stage 5 budget (120 minutes for 5.3), so the
    // product's own agent timeout acts first.
    expect(STALL_LIMIT_MS).toBeGreaterThan(120 * 60_000);
  });
});

describe("qaFeedbackFromOutput", () => {
  it("quotes the QA report lines back as feedback, once each, and nothing without a report", () => {
    const output = [
      "🌐 פתחתי לך אותו בדפדפן.",
      "FAIL 320px overflow=28 clipped=4 orphans=0 nodims=7",
      "   clipped: DIV [-28..292] מה תקבל בשיחה",
      "FAIL 390px overflow=0 clipped=0 orphans=0 nodims=7",
      "RESULT: FAIL (6 widths)",
      "FAIL 320px overflow=28 clipped=4 orphans=0 nodims=7",
      "שער ה-QA חסם מסירה.",
    ].join("\n");
    const feedback = qaFeedbackFromOutput(output) ?? "";
    expect(feedback.startsWith("שער ה-QA נכשל.")).toBe(true);
    expect((feedback.match(/FAIL 320px/g) ?? []).length).toBe(1);
    expect(feedback).toContain("clipped: DIV");
    expect(feedback).toContain("RESULT: FAIL (6 widths)");
    expect(feedback).not.toContain("פתחתי לך");
    expect(qaFeedbackFromOutput("no report here")).toBeNull();
    expect(qaFeedbackFromOutput(undefined)).toBeNull();
  });
});

describe("forgetsApproval", () => {
  it("lets a sub-task that runs again be approved again, and keeps the record otherwise", () => {
    // Run 35912389730: 5.4's QA feedback rewound to 5.3; the rebuilt 5.3
    // waited 40 minutes because its first approval was still on record.
    expect(forgetsApproval("running")).toBe(true);
    expect(forgetsApproval("pending")).toBe(true);
    expect(forgetsApproval("awaiting-decision")).toBe(false);
    expect(forgetsApproval("approved")).toBe(false);
  });
});

describe("failedSubTasks and runIsComplete", () => {
  it("collects error sub-tasks with their message", () => {
    const stages = [stage(2, "error", [{ id: "2", status: "error", errorMessage: "claude -p exited 1" }])];
    expect(failedSubTasks(stages)).toEqual([{ stage: 2, subTaskId: "2", error: "claude -p exited 1" }]);
    expect(failedSubTasks(undefined)).toEqual([]);
  });
  it("is complete on a run-completed event or when every stage is approved, never on an empty tree", () => {
    expect(runIsComplete([], [{ type: "run-completed" }])).toBe(true);
    expect(runIsComplete([stage(1, "approved", []), stage(5, "approved", [])], [])).toBe(true);
    expect(runIsComplete([stage(1, "approved", []), stage(5, "running", [])], [])).toBe(false);
    expect(runIsComplete([], [])).toBe(false);
    expect(runIsComplete(undefined, [])).toBe(false);
  });
});

describe("sandboxProfileNetwork", () => {
  it("reads the network mode of the last profile block and tolerates a missing or broken one", () => {
    const log = 'x\n# sandbox profile\n{"network":"loopback-server"}\n# end profile\ny\n# sandbox profile\n{\n  "backend": "bubblewrap",\n  "network": "none"\n}\n# end profile\n';
    expect(sandboxProfileNetwork(log)).toBe("none");
    expect(sandboxProfileNetwork("no block")).toBeUndefined();
    expect(sandboxProfileNetwork("# sandbox profile\nnot json\n# end profile")).toBeUndefined();
  });
});

describe("assessEvidence", () => {
  const proven = {
    factsJsonExists: true,
    harvestImageCount: 7,
    buildLogHasSandboxedLine: true,
    buildProfileNetwork: "none",
    previewUp: true,
    previewUrl: "http://127.0.0.1:4322/p",
    previewHttpStatus: 200,
    previewOpenedLine: true,
    stripCount: 12,
    landingCommitSha: "abc123",
    runCompleted: true,
  };
  it("passes only when every checklist item is proven", () => {
    expect(assessEvidence(proven).ok).toBe(true);
    expect(assessEvidence({ ...proven, buildProfileNetwork: "https-egress" }).ok).toBe(false);
    expect(assessEvidence({ ...proven, stripCount: 0 }).ok).toBe(false);
    expect(assessEvidence({ ...proven, previewHttpStatus: 502 }).ok).toBe(false);
    expect(assessEvidence({ ...proven, landingCommitSha: undefined }).ok).toBe(false);
  });
  it("names the failing item so the report reads without the log", () => {
    const { items } = assessEvidence({ ...proven, buildProfileNetwork: undefined });
    const item = items.find((candidate) => candidate.id === "build-network-none");
    expect(item?.ok).toBe(false);
    expect(item?.detail).toContain("(not logged)");
  });
});
