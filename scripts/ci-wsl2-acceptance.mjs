#!/usr/bin/env node
// Drives one direct-pipeline run end to end against a running board
// (`npm run dev`) the way a reviewer would from the browser: creates the
// run, watches its sub-tasks through the SSE stream, approves each gate that
// reaches "awaiting-decision", and, once the run completes, collects the
// evidence the platform acceptance checklist asks for. Exit 0 only when every
// required item is proven; the evidence directory is written either way so a
// failed run still explains itself.
//
// No dependencies beyond Node 20+. Every value it prints is safe for a CI log:
// it never reads or prints a secret.

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

export const DEFAULT_TIMEOUT_MINUTES = 150;
const POLL_INTERVAL_MS = 10_000;
const SNAPSHOT_READ_MS = 8_000;
/** Express gets this long to approve 3 and 5.3 before the driver acts as the human. */
const EXPRESS_GRACE_MS = 45_000;
const REQUIRED_HUMAN_LINE = "פתחתי לך אותו בדפדפן";
/** A board request that has not answered in this long is treated as failed, never awaited forever. */
const REQUEST_TIMEOUT_MS = 90_000;
/**
 * No sub-task changed state for this long: the run is stalled and the driver
 * stops with the evidence it has. Above the board's own execution budgets
 * (90 minutes for a stage 5 sub-task, 120 for the build), so a silent agent
 * is ended by the product's timeout and rerun with feedback, not cut by the
 * driver: a tool-heavy agent emits no text for long stretches while alive
 * (run 35969539079 was stopped at 40 minutes inside a live 5.2).
 */
export const STALL_LIMIT_MS = 130 * 60_000;

/** Parses the `data: {...}` frames of one SSE body chunk. Heartbeats and partial frames are ignored. */
export function parseSseFrames(text) {
  const events = [];
  for (const frame of text.split("\n\n")) {
    for (const line of frame.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      try {
        events.push(JSON.parse(line.slice(6)));
      } catch {
        // A frame cut mid-JSON by the read window; the next snapshot carries the whole thing.
      }
    }
  }
  return events;
}

/** The latest full stage tree carried by a list of events, or undefined. */
export function latestStages(events) {
  let stages;
  for (const event of events) if (event.type === "stages-initialized" && Array.isArray(event.stages)) stages = event.stages;
  return stages;
}

export const HUMAN_GATES = new Set(["1", "2", "5.2", "5.4"]);
/** How many times the driver sends a blocked gate back before giving up on it. */
export const MAX_FEEDBACK_ROUNDS = 2;

/**
 * The blockers a reviewer would quote back, from either place the board
 * records a verdict: the copy/design-brief critic loop (`criticRounds`,
 * newest round) or stage 5.3's design review (`designReview`, the same field
 * express reads; three failing critics there were invisible to this driver
 * in run 35927734880 and 5.3 was approved on sight).
 */
export function criticBlockers(task) {
  const review = task?.designReview;
  if (review && !review.passed) {
    if (review.failing?.length) return `ביקורת העיצוב: נשארו חוסמים אצל ${review.failing.join(", ")}`;
    if (review.silent?.length) return `ביקורת העיצוב: ${review.silent.join(", ")} לא הצביע`;
    return "ביקורת העיצוב לא עברה";
  }
  const rounds = task?.criticRounds ?? [];
  const last = rounds[rounds.length - 1];
  if (!last || last.verdict === "approve") return null;
  const fixes = (last.fixes ?? []).map((fix) => `${fix.rule}: ${fix.fix}`).filter(Boolean);
  const reason = last.reason ? [last.reason] : [];
  const text = [...reason, ...fixes].join("\n").trim();
  return text || `הביקורת האחרונה החזירה ${last.verdict}`;
}

/**
 * The last design-round lines of a 5.3 output (critic verdicts and the
 * summary), so the feedback carries what the critics said, not only who.
 */
export function designReviewExcerpt(output) {
  const text = output ?? "";
  const start = text.lastIndexOf("## סבב עיצוב");
  if (start < 0) return "";
  const round = text.slice(start);
  // The critics' reasoning follows the summary under "חוסמים שנשארו".
  const blockersAt = round.indexOf("חוסמים שנשארו");
  const head = blockersAt >= 0 ? round.slice(0, blockersAt) : round;
  const verdicts = head.split("\n").filter((line) => !line.startsWith("#") && /❌|✅|⚠️|^- \*\*|^  - סבב/.test(line)).join("\n");
  const reasoning = blockersAt >= 0 ? round.slice(blockersAt).replace(/^#+ ?/gm, "").trim() : "";
  return [verdicts, reasoning].filter(Boolean).join("\n").slice(0, 3_000);
}

/**
 * What the driver does with each sub-task awaiting a decision, the way a
 * careful reviewer would. A gate whose newest critic round did not block it
 * is approved: a human gate (1, 2, 5.2, 5.4) at once, an express gate (3,
 * 5.3) only after express had its grace period and still left it waiting.
 * A gate the critic blocked is never approved blindly: the blockers go back
 * as feedback and the stage reruns, at most MAX_FEEDBACK_ROUNDS times; after
 * that the driver stops and says a human is needed.
 */
export function reviewerActions(stages, firstSeenAwaiting, feedbackSent, now, graceMs = EXPRESS_GRACE_MS) {
  const actions = [];
  for (const stage of stages ?? []) {
    for (const task of stage.subTasks ?? []) {
      if (task.status !== "awaiting-decision") continue;
      const key = `${stage.number}:${task.id}`;
      const gate = { stage: stage.number, subTaskId: task.id };
      if (!HUMAN_GATES.has(task.id)) {
        const since = firstSeenAwaiting.get(key);
        if (since === undefined) {
          firstSeenAwaiting.set(key, now);
          continue;
        }
        if (now - since < graceMs) continue;
      }
      const blockers = criticBlockers(task);
      if (!blockers) {
        actions.push({ ...gate, action: "approve" });
        continue;
      }
      const sent = feedbackSent.get(key) ?? 0;
      if (sent >= MAX_FEEDBACK_ROUNDS) {
        // A design review (5.3) the critics still block after the feedback
        // budget is, by the board's own design, handed to the human ("מעביר
        // אליך כמו שזה"). The reviewer here decides to see the page: the
        // approval is recorded with its blockers in the evidence, so the
        // downstream platform items (preview, browser, QA, delivery) are
        // exercised without the design verdict ever reading "passed".
        if (task.designReview) {
          actions.push({ ...gate, action: "approve-with-blockers", blockers: blockers.slice(0, 600) });
          continue;
        }
        actions.push({ ...gate, action: "stop", reason: `${key} still blocked by the critic after ${sent} feedback rounds: ${blockers.slice(0, 300)}` });
        continue;
      }
      const excerpt = task.designReview ? designReviewExcerpt(task.output) : "";
      actions.push({ ...gate, action: "feedback", feedback: `תקן לפי החוסמים של הביקורת האחרונה:\n${blockers}${excerpt ? `\n${excerpt}` : ""}`.slice(0, 4_000) });
    }
  }
  return actions;
}

/**
 * Feedback for a gate the board refused to approve with "Send feedback and
 * rerun the gate": stage 5.4's QA gate found defects, and its output carries
 * the QA report. A reviewer sends that report back; feedback on 5.4 rewinds
 * to the build. Null when the output holds no QA lines to quote.
 */
export function qaFeedbackFromOutput(output) {
  const lines = (output ?? "").split("\n").filter((line) => /^(FAIL|PASS) \d+px|^\s+(clipped|overflow|orphan|offcenter|nodims|touch|smalltext):|^RESULT:/.test(line));
  if (!lines.length) return null;
  const unique = [...new Set(lines)];
  return `שער ה-QA נכשל. תקן את הכשלים הבאים בדף (כל תמונה עם width ו-height, בלי גלישה ב-320px, יעדי מגע של 44px לפחות) והרץ שוב:\n${unique.join("\n")}`.slice(0, 4_000);
}

/** Which gate bookkeeping a status change resets: a sub-task that runs again may be approved again. */
export function forgetsApproval(status) {
  return status === "running" || status === "pending";
}

export function failedSubTasks(stages) {
  const failed = [];
  for (const stage of stages ?? []) {
    for (const task of stage.subTasks ?? []) {
      if (task.status === "error") failed.push({ stage: stage.number, subTaskId: task.id, error: task.errorMessage ?? "" });
    }
  }
  return failed;
}

/**
 * What a reviewer does with an errored sub-task: the board's feedback route
 * accepts an "error" sub-task and reruns it with the note, so the failure
 * text (a compiler error in generated code, for one) goes back, at most
 * MAX_FEEDBACK_ROUNDS times per sub-task; then the driver stops.
 */
export function errorActions(stages, feedbackSent) {
  return failedSubTasks(stages).map((failed) => {
    const key = `${failed.stage}:${failed.subTaskId}`;
    const sent = feedbackSent.get(key) ?? 0;
    if (sent >= MAX_FEEDBACK_ROUNDS) {
      return { stage: failed.stage, subTaskId: failed.subTaskId, action: "stop", reason: `${key} still failing after ${sent} feedback rounds: ${failed.error.slice(0, 300)}` };
    }
    return { stage: failed.stage, subTaskId: failed.subTaskId, action: "feedback", feedback: `הריצה נכשלה. תקן את הכשל הבא והרץ שוב:\n${failed.error}`.slice(0, 4_000) };
  });
}

export const MAX_FEEDBACK_LOCK_RETRIES = 6;

/**
 * A 409 on an errored sub-task's feedback means the board is holding that
 * sub-task's execution lock. Usually the next poll finds it released; a lock
 * left by a dead attempt never is, and since nothing changes the stall clock
 * only fires after 130 minutes on a runner billed at 2x. Counted separately
 * from the feedback rounds, because no feedback was accepted.
 */
export function feedbackLockFailure(key, retries, limit = MAX_FEEDBACK_LOCK_RETRIES) {
  if (retries < limit) return undefined;
  return `feedback on failed ${key} was refused with 409 ${retries} times in a row; its execution lock is held and the sub-task is not moving`;
}

/**
 * True when nothing has changed for longer than the stall limit. Run
 * 35883190668 sat inside its agent step for the job's whole five hours: the
 * driver's own clock check lived behind an un-timed request and never ran.
 */
export function isStalled(lastChangeAt, now, limitMs = STALL_LIMIT_MS) {
  return now - lastChangeAt > limitMs;
}

export function runIsComplete(stages, events) {
  if (events.some((event) => event.type === "run-completed")) return true;
  return Boolean(stages?.length) && stages.every((stage) => stage.status === "approved");
}

/**
 * How stage 5.3's design review ended: "passed", "approved-with-blockers"
 * (the reviewer's recorded decision after the feedback budget), or
 * "blocked". Informational: it is reported beside the platform items and
 * never counted as a platform proof.
 */
export function designReviewOutcome(stages, decision) {
  const build = stages?.find((stage) => stage.number === 5)?.subTasks?.find((task) => task.id === "5.3");
  const review = build?.designReview;
  if (decision) return { status: "approved-with-blockers", detail: `after ${decision.rounds} feedback rounds: ${decision.blockers}` };
  if (!review) return { status: "unknown", detail: "no design review recorded" };
  if (review.passed) return { status: "passed", detail: "every design critic passed" };
  return { status: "blocked", detail: `blocked by ${[...(review.failing ?? []), ...(review.silent ?? [])].join(", ")}` };
}

/**
 * Assesses the collected facts against the checklist. Pure: the caller
 * gathers the facts from disk and the API; this decides what they prove.
 * The design-review line is informational (a human decision, not a platform
 * proof) and does not enter the overall verdict.
 */
export function assessEvidence(facts) {
  const informational = facts.designReview
    ? [{ id: "design-review", ok: facts.designReview.status === "passed", detail: `${facts.designReview.status}: ${facts.designReview.detail}`, informational: true }]
    : [];
  const items = [
    { id: "harvest-facts", ok: facts.factsJsonExists, detail: "harvest/facts.json exists" },
    { id: "harvest-images", ok: facts.harvestImageCount > 0, detail: `${facts.harvestImageCount} harvested images` },
    { id: "build-sandboxed", ok: facts.buildLogHasSandboxedLine, detail: "build log carries the sandboxed-build line" },
    { id: "build-network-none", ok: facts.buildProfileNetwork === "none", detail: `build sandbox profile network: ${facts.buildProfileNetwork ?? "(not logged)"}` },
    { id: "preview-up", ok: facts.previewUp && facts.previewHttpStatus === 200, detail: `preview ${facts.previewUrl ?? "?"} up=${facts.previewUp} http=${facts.previewHttpStatus}` },
    // The board's own line is not proof on its own: it was printed for a
    // launcher that was not on PATH (run 35749912557). When the Windows-side
    // tasklist capture is available it has to agree. The workflow writes that
    // capture after this driver exits, so an absent file stays neutral here
    // and the flow step enforces it (see .github/workflows/wsl2-acceptance.yml).
    {
      id: "preview-opened-in-windows",
      ok: Boolean(facts.previewOpenedLine) && (facts.windowsBrowserProcesses === undefined || facts.windowsBrowserProcesses > 0),
      detail: `stage 5.4 line: ${facts.previewOpenedLine ? "yes" : "NO"}; Windows browser processes: ${facts.windowsBrowserProcesses ?? "(captured after this driver exits)"}`,
    },
    { id: "critic-shots", ok: facts.stripCount > 0, detail: `${facts.stripCount} critic strips under shots/strips` },
    { id: "delivered-to-branch", ok: Boolean(facts.landingCommitSha), detail: `landing commit ${facts.landingCommitSha ?? "(none)"}` },
    { id: "run-completed", ok: facts.runCompleted, detail: "every stage approved" },
  ];
  return { ok: items.every((item) => item.ok), items: [...items, ...informational] };
}

/**
 * How many browser processes a `tasklist.exe /FI "IMAGENAME eq msedge.exe"`
 * capture lists. Zero means Start-Process opened nothing, whatever the board
 * printed. Pure, so the same rule reads a capture taken at any time.
 */
export function browserProcessesSeen(text) {
  return text.split("\n").filter((line) => line.includes("msedge.exe")).length;
}

/** The "network" value in the last "# sandbox profile" block of a log, or undefined. */
export function sandboxProfileNetwork(logText) {
  const blocks = [...logText.matchAll(/# sandbox profile\n([\s\S]*?)\n# end profile/g)];
  if (!blocks.length) return undefined;
  try {
    return JSON.parse(blocks[blocks.length - 1][1]).network;
  } catch {
    return undefined;
  }
}

async function readSnapshot(base, runId) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SNAPSHOT_READ_MS);
  let text = "";
  try {
    const response = await fetch(`${base}/api/runs/${encodeURIComponent(runId)}/stream`, { signal: controller.signal });
    if (!response.ok || !response.body) throw new Error(`stream responded ${response.status}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      // The snapshot ends with the stage tree; a live event may follow, and the
      // read window bounds how long we listen for it.
      if (text.includes('"type":"run-completed"')) break;
    }
  } catch (error) {
    if (!(error instanceof Error && error.name === "AbortError")) throw error;
  } finally {
    clearTimeout(timer);
  }
  return parseSseFrames(text);
}

async function decide(base, runId, gate, route, payload, log) {
  const url = `${base}/api/runs/${encodeURIComponent(runId)}/stages/${gate.stage}/subtasks/${encodeURIComponent(gate.subTaskId)}/${route}`;
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: new URL(base).origin, "X-Campaign-Council-Request": "1" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    log(`${route} ${gate.stage}/${gate.subTaskId} -> no answer (${error instanceof Error ? error.name : String(error)})`);
    return 0;
  }
  const body = await response.text();
  log(`${route} ${gate.stage}/${gate.subTaskId} -> ${response.status} ${body.slice(0, 300).replace(/\s+/g, " ")}`);
  lastResponseBody = body;
  return response.status;
}
let lastResponseBody = "";

async function waitForServer(base, log, timeoutMs = 5 * 60_000) {
  const started = Date.now();
  for (;;) {
    try {
      const response = await fetch(`${base}/api/config`);
      if (response.ok) return await response.json();
      log(`server answered ${response.status}; waiting`);
    } catch {
      // not up yet
    }
    if (Date.now() - started > timeoutMs) throw new Error("the board did not come up in time");
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
}

async function countFiles(directory, pattern) {
  try {
    return (await fs.readdir(directory)).filter((name) => pattern.test(name)).length;
  } catch {
    return 0;
  }
}

async function gatherFacts({ base, runId, runsDir, evidenceDir, stages, events }) {
  const runDir = path.join(runsDir, runId);
  const logsDir = path.join(runDir, "logs");
  const buildLog = await fs.readFile(path.join(logsDir, "stage-5-3-daniel-lp-designer.log"), "utf8").catch(() => "");
  const stage5 = stages?.find((stage) => stage.number === 5);
  const preview = stage5?.subTasks?.find((task) => task.id === "5.4");
  const build = stage5?.subTasks?.find((task) => task.id === "5.3");
  let previewUp = false;
  let previewUrl;
  let previewHttpStatus = 0;
  try {
    const response = await fetch(`${base}/api/runs/${encodeURIComponent(runId)}/preview`);
    if (response.ok) {
      const body = await response.json();
      previewUp = body.up === true;
      previewUrl = body.url;
      if (previewUrl) previewHttpStatus = (await fetch(previewUrl).catch(() => ({ status: 0 }))).status;
    }
  } catch {
    // reported below as not up
  }
  // The workflow captures the Windows process list next to the run's evidence
  // directory. On the current ordering it does not exist yet when this runs;
  // a rerun or a future ordering that writes it first makes the item stricter.
  const browserCapture = evidenceDir
    ? await fs.readFile(path.join(path.dirname(evidenceDir), "windows-browser-processes.txt"), "utf8").catch(() => undefined)
    : undefined;
  return {
    runDir,
    windowsBrowserProcesses: browserCapture === undefined ? undefined : browserProcessesSeen(browserCapture),
    factsJsonExists: await fs.access(path.join(runDir, "harvest", "facts.json")).then(() => true, () => false),
    harvestImageCount: await countFiles(path.join(runDir, "harvest", "raw"), /\.(jpe?g|png|webp|gif)$/i),
    buildLogHasSandboxedLine: buildLog.includes("מריץ build מבוקר"),
    buildProfileNetwork: sandboxProfileNetwork(buildLog),
    previewUp,
    previewUrl,
    previewHttpStatus,
    previewOpenedLine: (preview?.output ?? "").includes(REQUIRED_HUMAN_LINE) || (await fs.readFile(path.join(logsDir, "stage-5-4-preview.log"), "utf8").catch(() => "")).includes(REQUIRED_HUMAN_LINE),
    stripCount: await countFiles(path.join(runDir, "shots", "strips"), /\.(png|jpe?g|webp)$/i),
    landingCommitSha: build?.landingCommitSha,
    runCompleted: runIsComplete(stages, events),
  };
}

async function copyEvidence(facts, outDir) {
  await fs.mkdir(outDir, { recursive: true });
  const copies = [
    ["harvest/facts.json", "facts.json"],
    ["harvest/sheet.jpg", "harvest-sheet.jpg"],
    ["logs", "logs"],
    ["shots", "shots"],
  ];
  for (const [from, to] of copies) {
    await fs.cp(path.join(facts.runDir, from), path.join(outDir, to), { recursive: true }).catch(() => {});
  }
}

export async function main(env = process.env) {
  const base = env.COUNCIL_BASE_URL ?? "http://127.0.0.1:3000";
  const siteUrl = env.COUNCIL_ACCEPTANCE_SITE_URL;
  const runsDir = env.COUNCIL_ACCEPTANCE_RUNS_DIR;
  const outDir = env.COUNCIL_ACCEPTANCE_EVIDENCE_DIR;
  const timeoutMs = Number(env.COUNCIL_ACCEPTANCE_TIMEOUT_MINUTES ?? DEFAULT_TIMEOUT_MINUTES) * 60_000;
  if (!siteUrl || !/^https?:\/\//.test(siteUrl)) throw new Error("COUNCIL_ACCEPTANCE_SITE_URL must be an http(s) URL");
  if (!runsDir || !outDir) throw new Error("COUNCIL_ACCEPTANCE_RUNS_DIR and COUNCIL_ACCEPTANCE_EVIDENCE_DIR are required");
  const timeline = [];
  const log = (line) => {
    const stamped = `${new Date().toISOString()} ${line}`;
    timeline.push(stamped);
    console.log(stamped);
  };

  const config = await waitForServer(base, log);
  log(`board up; pipeline default ${config.pipelineDefault}`);
  // A brief a client would write, not a bare URL: the copy critic blocks a
  // call to action with no concrete destination or outcome (run 35763397155
  // stalled at stage 2 on exactly that), and a reviewer answers by deciding.
  const brief = [
    `דף נחיתה לעסק שבאתר ${siteUrl}.`,
    "המטרה: השארת פרטים לשיחת התאמה ללא עלות.",
    "קריאה לפעולה: טופס השארת פרטים בדף עצמו. אחרי השליחה חוזרים לפונה בטלפון תוך יום עסקים אחד.",
    "אין לציין מחיר בדף.",
  ].join(" ");
  const created = await fetch(`${base}/api/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: new URL(base).origin, "X-Campaign-Council-Request": "1" },
    // A lead-form page is a squeeze page. A sales page demands device mockups
    // of a program's modules; with none to show, the design critic approves an
    // empty list and stage 5.2 refuses the run (run 35769045085).
    body: JSON.stringify({ brief, assetType: "squeeze-page", pipeline: "direct" }),
  });
  const createdBody = await created.json().catch(() => ({}));
  if (created.status !== 202 || !createdBody.id) throw new Error(`run creation failed: ${created.status} ${JSON.stringify(createdBody).slice(0, 300)}`);
  const runId = createdBody.id;
  log(`run ${runId} created (slug ${createdBody.slug})`);

  const firstSeenAwaiting = new Map();
  const feedbackSent = new Map();
  // 409s on an errored sub-task's feedback, counted apart from the rounds
  // above: a 409 means no feedback was accepted at all.
  const lockRetries = new Map();
  const approvedOnce = new Set();
  const seenStatus = new Map();
  const started = Date.now();
  let lastChangeAt = started;
  /** Set when the reviewer approved a blocked design review after the feedback budget. */
  let designReviewDecision;
  let stages;
  let events = [];
  let failure;
  for (;;) {
    events = await readSnapshot(base, runId);
    stages = latestStages(events) ?? stages;
    for (const stage of stages ?? []) {
      for (const task of stage.subTasks ?? []) {
        const key = `${stage.number}:${task.id}`;
        if (seenStatus.get(key) !== task.status) {
          seenStatus.set(key, task.status);
          lastChangeAt = Date.now();
          log(`sub-task ${key}: ${task.status}`);
          // A rewind (5.4 feedback reruns 5.3) brings an approved sub-task
          // back; its earlier approval must not silence the next one. Run
          // 35912389730 sat 40 minutes on a rebuilt 5.3 for exactly that.
          if (forgetsApproval(task.status)) {
            approvedOnce.delete(key);
            firstSeenAwaiting.delete(key);
          }
        }
      }
    }
    let stopped = false;
    for (const gate of errorActions(stages, feedbackSent)) {
      const key = `${gate.stage}:${gate.subTaskId}`;
      if (gate.action === "stop") {
        failure = gate.reason;
        stopped = true;
        break;
      }
      const status = await decide(base, runId, gate, "feedback", { feedback: gate.feedback }, log);
      if (status === 200 || status === 202) {
        feedbackSent.set(key, (feedbackSent.get(key) ?? 0) + 1);
        lockRetries.delete(key);
      } else if (status === 409) {
        const retries = (lockRetries.get(key) ?? 0) + 1;
        lockRetries.set(key, retries);
        const reason = feedbackLockFailure(key, retries);
        if (reason) {
          failure = reason;
          stopped = true;
          break;
        }
      } else {
        failure = `feedback on failed ${key} returned ${status}`;
        stopped = true;
        break;
      }
    }
    if (stopped) break;
    if (runIsComplete(stages, events)) {
      log("run completed");
      break;
    }
    for (const gate of reviewerActions(stages, firstSeenAwaiting, feedbackSent, Date.now())) {
      const key = `${gate.stage}:${gate.subTaskId}`;
      if (gate.action === "stop") {
        failure = gate.reason;
        break;
      }
      if (gate.action === "approve-with-blockers") {
        if (approvedOnce.has(key)) continue;
        log(`reviewer decision: approving ${key} with recorded design blockers after ${MAX_FEEDBACK_ROUNDS} feedback rounds`);
        designReviewDecision = { key, blockers: gate.blockers, rounds: feedbackSent.get(key) ?? 0 };
        const status = await decide(base, runId, gate, "decide", { action: "approve" }, log);
        if (status === 200 || status === 202) approvedOnce.add(key);
        else if (status !== 409) failure = `approval of ${key} failed with ${status}`;
        continue;
      }
      if (gate.action === "feedback") {
        const status = await decide(base, runId, gate, "feedback", { feedback: gate.feedback }, log);
        if (status === 200 || status === 202) {
          feedbackSent.set(key, (feedbackSent.get(key) ?? 0) + 1);
          firstSeenAwaiting.delete(key);
        } else if (status !== 409) failure = `feedback on ${key} failed with ${status}`;
        continue;
      }
      if (approvedOnce.has(key)) continue;
      const status = await decide(base, runId, gate, "decide", { action: "approve" }, log);
      if (status === 200 || status === 202) approvedOnce.add(key);
      else if (status === 409 && /Send feedback/i.test(lastResponseBody)) {
        // The gate refuses approval and asks for feedback (5.4 with a failed
        // QA receipt). Run 35883190668 retried the approval for two hours;
        // a reviewer sends the QA report back instead.
        const task = stages?.find((stage) => stage.number === gate.stage)?.subTasks?.find((candidate) => candidate.id === gate.subTaskId);
        const feedback = qaFeedbackFromOutput(task?.output) ?? `הלוח סירב לאשר: ${lastResponseBody.slice(0, 500)}. תקן והרץ שוב.`;
        const sent = feedbackSent.get(key) ?? 0;
        if (sent >= MAX_FEEDBACK_ROUNDS) {
          failure = `${key} refused approval after ${sent} feedback rounds: ${lastResponseBody.slice(0, 300)}`;
          break;
        }
        const fbStatus = await decide(base, runId, gate, "feedback", { feedback }, log);
        if (fbStatus === 200 || fbStatus === 202) {
          feedbackSent.set(key, sent + 1);
          firstSeenAwaiting.delete(key);
        } else if (fbStatus !== 409) failure = `feedback on ${key} failed with ${fbStatus}`;
      } else if (status === 409) {
        // Express beat us to it, or the gate is momentarily busy; the next snapshot shows which.
        firstSeenAwaiting.delete(key);
      } else failure = `approval of ${key} failed with ${status}`;
    }
    if (failure) break;
    if (Date.now() - started > timeoutMs) {
      failure = `timed out after ${Math.round((Date.now() - started) / 60_000)} minutes`;
      break;
    }
    if (isStalled(lastChangeAt, Date.now())) {
      failure = `stalled: no sub-task changed state for ${Math.round((Date.now() - lastChangeAt) / 60_000)} minutes`;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  const facts = await gatherFacts({ base, runId, runsDir, evidenceDir: outDir, stages, events });
  facts.designReview = designReviewOutcome(stages, designReviewDecision);
  const assessment = assessEvidence(facts);
  await copyEvidence(facts, outDir);
  const report = { runId, siteUrl, failure, facts: { ...facts, runDir: undefined }, assessment, timeline };
  await fs.writeFile(path.join(outDir, "evidence.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const lines = [
    `# Acceptance run ${runId}`,
    "",
    failure ? `**Driver failure:** ${failure}` : "**Driver:** run completed",
    "",
    "| item | ok | detail |",
    "|---|---|---|",
    ...assessment.items.map((item) => `| ${item.id} | ${item.informational ? (item.ok ? "yes (informational)" : "no (informational)") : (item.ok ? "yes" : "NO")} | ${item.detail} |`),
    "",
  ];
  await fs.writeFile(path.join(outDir, "evidence.md"), lines.join("\n"), "utf8");
  console.log(lines.join("\n"));
  if (failure || !assessment.ok) {
    console.error(`ACCEPTANCE: NOT PROVEN${failure ? ` (${failure})` : ""}`);
    return 1;
  }
  const review = facts.designReview?.status;
  console.log(review && review !== "passed"
    ? `ACCEPTANCE: every platform item proven; design review ${review} (a reviewer decision, recorded above)`
    : "ACCEPTANCE: every checklist item proven");
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  main().then((code) => process.exit(code), (error) => {
    console.error(`ACCEPTANCE: driver error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
