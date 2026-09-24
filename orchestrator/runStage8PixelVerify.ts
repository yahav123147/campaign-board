import { readSecret } from "./secretStore";
import type { ClientProfile } from "@/config/clientProfile";
import { appendLog, saveRunArtifact } from "@/lib/runStore";
import type { ExecutionControl } from "./executionService";
import { eventBus } from "./eventBus";
import { getRun, updateRun } from "./runRegistry";
import { assertClientFeatureReady, stage8ReportSha256 } from "./stage89Safety";
import { getStageDef } from "./stageRegistry";

export { stage8ReportSha256 } from "./stage89Safety";

const DEFAULT_GRAPH_API_VERSION = "v26.0";
const GRAPH_TIMEOUT_MS = 20_000;
const MAX_GRAPH_RESPONSE_BYTES = 512 * 1024;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1_000;

type JsonRecord = Record<string, unknown>;

export function graphApiBase(
  env: Readonly<Record<string, string | undefined>> = process.env,
): URL {
  const version = env.META_GRAPH_API_VERSION?.trim() || DEFAULT_GRAPH_API_VERSION;
  if (!/^v[1-9][0-9]?\.0$/.test(version)) {
    throw new Error("META_GRAPH_API_VERSION must look like v26.0");
  }
  return new URL(`https://graph.facebook.com/${version}/`);
}

export interface MetaReadResult {
  readonly ok: boolean;
  readonly data?: unknown;
  readonly error?: string;
}

export interface Stage8Evidence {
  readonly checkedAt: string;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly accountId: string;
  readonly pixelId: string;
  readonly customConversionId: string;
  readonly domain: string;
  readonly pixelInfo: MetaReadResult;
  readonly pixelAccounts: MetaReadResult;
  readonly eventStats: MetaReadResult;
  readonly piiStats: MetaReadResult;
  readonly eventSourceStats: MetaReadResult;
  readonly hostStats: MetaReadResult;
  readonly customConversions: MetaReadResult;
  readonly accountInfo: MetaReadResult;
}

export interface Stage8Assessment {
  readonly ready: boolean;
  readonly pixelRecentlyFired: boolean;
  readonly accountActive: boolean;
  readonly pixelIdentityMatches: boolean;
  readonly accountIdentityMatches: boolean;
  readonly pixelAssignedToAccount: boolean;
  readonly domainHasPurchases: boolean;
  readonly customConversionReady: boolean;
  readonly purchaseCount: number | null;
  readonly purchaseWithPiiCount: number | null;
  readonly purchaseWithoutPiiCount: number | null;
  readonly serverPurchaseCount: number | null;
  readonly browserPurchaseCount: number | null;
  readonly blockers: readonly string[];
  readonly warnings: readonly string[];
}

export interface Stage8ReadDependencies {
  readonly readToken: (service: string, signal?: AbortSignal) => Promise<string>;
  readonly getJson: (
    resourcePath: string,
    query: Readonly<Record<string, string>>,
    token: string,
    signal?: AbortSignal,
  ) => Promise<MetaReadResult>;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringField(value: unknown, field: string): string | null {
  return isRecord(value) && typeof value[field] === "string" ? value[field] : null;
}

function numberField(value: unknown, fields: readonly string[]): number | null {
  if (!isRecord(value)) return null;
  for (const field of fields) {
    const candidate = value[field];
    if (typeof candidate !== "number" && typeof candidate !== "string") continue;
    if (typeof candidate === "string" && candidate.trim() === "") continue;
    const parsed = typeof candidate === "number" ? candidate : Number(candidate);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return null;
}

function explicitBreakdown(
  result: MetaReadResult,
  aggregation: string,
): Array<{ label: string | boolean | number; count: number }> | null {
  if (!result.ok || !isRecord(result.data)) return null;
  const outer = Array.isArray(result.data.data) ? result.data.data : [];
  const matching = outer.filter(
    (row): row is JsonRecord => isRecord(row) && row.aggregation === aggregation,
  );
  if (matching.length === 0) return null;

  const metrics: Array<{ label: string | boolean | number; count: number }> = [];
  for (const row of matching) {
    if (!Array.isArray(row.data)) return null;
    for (const metric of row.data) {
      if (!isRecord(metric)) return null;
      const label = metric.value ?? metric.event ?? metric.event_name ?? metric.source;
      if (!["string", "boolean", "number"].includes(typeof label)) return null;
      const count = numberField(metric, ["count", "event_count", "total_count"]);
      if (count === null) return null;
      metrics.push({ label: label as string | boolean | number, count });
    }
  }
  return metrics;
}

function countLabels(
  metrics: ReturnType<typeof explicitBreakdown>,
  predicate: (label: string) => boolean,
): number | null {
  if (!metrics) return null;
  return metrics.reduce(
    (sum, metric) => sum + (predicate(String(metric.label).trim().toLowerCase()) ? metric.count : 0),
    0,
  );
}

function pixelInfo(evidence: Stage8Evidence): JsonRecord | null {
  return evidence.pixelInfo.ok && isRecord(evidence.pixelInfo.data)
    ? evidence.pixelInfo.data
    : null;
}

function accountInfo(evidence: Stage8Evidence): JsonRecord | null {
  return evidence.accountInfo.ok && isRecord(evidence.accountInfo.data)
    ? evidence.accountInfo.data
    : null;
}

function dataRows(result: MetaReadResult): JsonRecord[] | null {
  if (!result.ok || !isRecord(result.data) || !Array.isArray(result.data.data)) return null;
  return result.data.data.filter(isRecord);
}

function normalizedMetaId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/^act_/, "");
  return /^\d+$/.test(normalized) ? normalized : null;
}

function normalizedHost(value: string): string | null {
  const raw = value.trim().toLowerCase();
  if (!raw) return null;
  try {
    const parsed = new URL(raw.includes("://") ? raw : `https://${raw}`);
    return parsed.hostname.replace(/\.$/, "");
  } catch {
    return null;
  }
}

function customConversionMatches(evidence: Stage8Evidence): boolean {
  const conversion = dataRows(evidence.customConversions)?.find(
    (row) => normalizedMetaId(row.id) === normalizedMetaId(evidence.customConversionId),
  );
  if (!conversion || conversion.is_archived === true || conversion.is_unavailable === true) return false;
  const sourceId = normalizedMetaId(conversion.event_source_id);
  const pixelId = isRecord(conversion.pixel) ? normalizedMetaId(conversion.pixel.id) : null;
  const sources = Array.isArray(conversion.data_sources)
    ? conversion.data_sources.filter(isRecord).map((source) => normalizedMetaId(source.id))
    : [];
  const configuredPixel = normalizedMetaId(evidence.pixelId);
  const sourceMatches = [sourceId, pixelId, ...sources].some((id) => id === configuredPixel);
  const eventType = stringField(conversion, "custom_event_type")?.toUpperCase();
  return sourceMatches && eventType === "PURCHASE";
}

/**
 * Interpret only the documented, explicit aggregation shape. Unknown or
 * partial response shapes are inconclusive rather than silently healthy.
 */
export function assessStage8Evidence(
  evidence: Stage8Evidence,
  nowMs = new Date(evidence.checkedAt).getTime(),
): Stage8Assessment {
  const events = explicitBreakdown(evidence.eventStats, "event");
  const pii = explicitBreakdown(evidence.piiStats, "had_pii");
  const sources = explicitBreakdown(evidence.eventSourceStats, "event_source");
  const hosts = explicitBreakdown(evidence.hostStats, "host");

  const purchaseCount = countLabels(events, (label) => label === "purchase");
  const purchaseWithPiiCount = countLabels(
    pii,
    (label) => label === "1" || label === "true" || label === "yes",
  );
  const purchaseWithoutPiiCount = countLabels(
    pii,
    (label) => label === "0" || label === "false" || label === "no",
  );
  const serverPurchaseCount = countLabels(
    sources,
    (label) => label === "server" || label === "server_side" || label === "server-side",
  );
  const browserPurchaseCount = countLabels(
    sources,
    (label) => label === "browser" || label === "website",
  );

  const pixel = pixelInfo(evidence);
  const unavailable = pixel?.is_unavailable;
  const lastFiredRaw = typeof pixel?.last_fired_time === "string" ? pixel.last_fired_time : null;
  const lastFiredMs = lastFiredRaw ? new Date(lastFiredRaw).getTime() : Number.NaN;
  const pixelRecentlyFired =
    unavailable === false &&
    Number.isFinite(lastFiredMs) &&
    lastFiredMs <= nowMs &&
    lastFiredMs >= nowMs - SEVEN_DAYS_MS;

  const account = accountInfo(evidence);
  const accountStatus = numberField(account, ["account_status"]);
  const accountActive = accountStatus === 1;
  const pixelIdentityMatches = normalizedMetaId(pixel?.id) === normalizedMetaId(evidence.pixelId);
  const accountIdentityMatches = normalizedMetaId(account?.id) === normalizedMetaId(evidence.accountId);
  const pixelAssignedToAccount = dataRows(evidence.pixelAccounts)?.some(
    (row) => normalizedMetaId(row.id) === normalizedMetaId(evidence.accountId),
  ) === true;
  const configuredDomain = normalizedHost(evidence.domain);
  const domainPurchaseCount = countLabels(hosts, (label) => {
    const host = normalizedHost(label);
    return Boolean(
      host && configuredDomain &&
      (host === configuredDomain || host.endsWith(`.${configuredDomain}`)),
    );
  });
  const domainHasPurchases = domainPurchaseCount !== null && domainPurchaseCount > 0;
  const customConversionReady = customConversionMatches(evidence);

  const blockers: string[] = [];
  const warnings: string[] = [];
  if (!pixelRecentlyFired) blockers.push("לא הוכחה ירי תקין של הפיקסל ב-7 הימים האחרונים.");
  if (!accountActive) blockers.push("לא הוכח שחשבון המודעות פעיל (account_status=1).");
  if (!pixelIdentityMatches) blockers.push("מזהה הפיקסל שחזר מ-Meta אינו תואם לפרופיל הלקוח.");
  if (!accountIdentityMatches) blockers.push("מזהה חשבון המודעות שחזר מ-Meta אינו תואם לפרופיל הלקוח.");
  if (!pixelAssignedToAccount) blockers.push("לא הוכח שהפיקסל המוגדר משויך לחשבון המודעות המוגדר.");
  if (!domainHasPurchases) blockers.push("לא נמצאו אירועי Purchase מהדומיין המוגדר או מתת-דומיין שלו.");
  if (!customConversionReady) {
    blockers.push("ה-Custom Conversion המוגדר לא נמצא כ-Purchase פעיל שמקושר לפיקסל המוגדר.");
  }
  if (purchaseCount === null) {
    blockers.push("מבנה נתוני Purchase לא זוהה, ולכן מספר הרכישות לא אומת.");
  } else if (purchaseCount <= 0) {
    blockers.push("לא נמצאו אירועי Purchase אמיתיים בחלון הבדיקה.");
  }
  if (purchaseWithPiiCount === null) {
    blockers.push("לא התקבלה אגרגציית had_pii מפורשת ל-Purchase.");
  } else if (purchaseWithPiiCount <= 0) {
    blockers.push("לא נמצא אף Purchase עם had_pii חיובי.");
  }
  if (serverPurchaseCount === null) {
    blockers.push("לא התקבלה אגרגציית event_source מפורשת ל-Purchase.");
  } else if (serverPurchaseCount <= 0) {
    blockers.push("לא נמצא אף Purchase שהגיע ממקור server, ולכן CAPI לא אומת.");
  }
  if (purchaseWithoutPiiCount !== null && purchaseWithoutPiiCount > 0) {
    warnings.push(`${purchaseWithoutPiiCount} אירועי Purchase דווחו ללא PII תואם.`);
  }
  return {
    ready: blockers.length === 0,
    pixelRecentlyFired,
    accountActive,
    pixelIdentityMatches,
    accountIdentityMatches,
    pixelAssignedToAccount,
    domainHasPurchases,
    customConversionReady,
    purchaseCount,
    purchaseWithPiiCount,
    purchaseWithoutPiiCount,
    serverPurchaseCount,
    browserPurchaseCount,
    blockers,
    warnings,
  };
}

function renderMetric(value: number | null): string {
  return value === null ? "לא ניתן לאמת" : String(value);
}

function oneLine(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/—/g, "-").trim().slice(0, 400);
}

function renderReadStatus(label: string, result: MetaReadResult): string {
  return `- ${label}: ${result.ok ? "נקרא בהצלחה" : `נכשל (${oneLine(result.error ?? "שגיאה לא ידועה")})`}`;
}

function customConversionSummary(result: MetaReadResult): string[] {
  if (!result.ok || !isRecord(result.data) || !Array.isArray(result.data.data)) {
    return ["- לא ניתן לאמת את רשימת ה-Custom Conversions."];
  }
  const rows = result.data.data.filter(isRecord).slice(0, 25);
  if (rows.length === 0) return ["- לא נמצאו Custom Conversions בתשובת ה-API."];
  return rows.map((row) => {
    const id = typeof row.id === "string" ? row.id : "ללא ID";
    const name = typeof row.name === "string" ? row.name : "ללא שם";
    const type = typeof row.custom_event_type === "string" ? row.custom_event_type : "סוג לא ידוע";
    return `- ${name} (${id}), ${type}`;
  });
}

export function buildStage8Report(
  profile: ClientProfile,
  evidence: Stage8Evidence,
  assessment = assessStage8Evidence(evidence),
  feedback?: string,
): string {
  const pixel = pixelInfo(evidence);
  const account = accountInfo(evidence);
  const conclusion = assessment.ready
    ? "PASS: קיימת ראיה מפורשת ל-Purchase עם had_pii חיובי ולמקור server."
    : "FAIL: אין כרגע מספיק ראיות מפורשות כדי לאשר שה-setup מוכן להשקה.";
  const feedbackBlock = feedback
    ? `\n\n## הערה לבדיקה החוזרת\n\n${feedback.trim()}`
    : "";

  return `# אימות Meta לקריאה בלבד

> RESULT: ${assessment.ready ? "PASS" : "FAIL"}
>
> הבדיקה ביצעה בקשות GET בלבד. לא בוצעו POST, PATCH או DELETE, ולא שונה דבר בחשבון.

## חשבון והיקף

- לקוח: ${profile.tenant.displayName}
- מותג: ${profile.brand.publicName}
- Account ID: ${evidence.accountId}
- Pixel ID: ${evidence.pixelId}
- Custom Conversion ID: ${evidence.customConversionId}
- Domain: ${evidence.domain}
- חלון בדיקה: ${evidence.windowStart} עד ${evidence.windowEnd}
- שם חשבון: ${stringField(account, "name") ?? "לא ניתן לאמת"}
- סטטוס חשבון: ${assessment.accountActive ? "פעיל" : "לא אומת כפעיל"}
- התאמת החשבון לפיקסל: ${assessment.pixelAssignedToAccount ? "אומתה" : "לא אומתה"}

## חיי הפיקסל

- שם: ${stringField(pixel, "name") ?? "לא ניתן לאמת"}
- last_fired_time: ${stringField(pixel, "last_fired_time") ?? "לא ניתן לאמת"}
- ירי ב-7 הימים האחרונים: ${assessment.pixelRecentlyFired ? "כן" : "לא הוכח"}
- Purchase מהדומיין המוגדר: ${assessment.domainHasPurchases ? "אומת" : "לא אומת"}

## Purchase ו-had_pii

- Purchase בחלון: ${renderMetric(assessment.purchaseCount)}
- Purchase עם had_pii חיובי: ${renderMetric(assessment.purchaseWithPiiCount)}
- Purchase ללא PII תואם: ${renderMetric(assessment.purchaseWithoutPiiCount)}
- מסקנה: ${assessment.purchaseWithPiiCount !== null && assessment.purchaseWithPiiCount > 0 ? "קיימת ראיה מפורשת ל-PII תואם" : "PII תואם לא אומת"}

## CAPI ומקור האירועים

- Purchase ממקור server: ${renderMetric(assessment.serverPurchaseCount)}
- Purchase ממקור browser: ${renderMetric(assessment.browserPurchaseCount)}
- CAPI: ${assessment.serverPurchaseCount !== null && assessment.serverPurchaseCount > 0 ? "אומת על Purchase אמיתי" : "לא אומת"}

## Custom Conversions

${customConversionSummary(evidence.customConversions).join("\n")}

- ה-Custom Conversion הצפוי פעיל, מסוג Purchase ומשויך לפיקסל: ${assessment.customConversionReady ? "כן" : "לא אומת"}

## סטטוס קריאות ה-API

${[
  renderReadStatus("פרטי פיקסל", evidence.pixelInfo),
  renderReadStatus("שיוך הפיקסל לחשבונות", evidence.pixelAccounts),
  renderReadStatus("event stats", evidence.eventStats),
  renderReadStatus("had_pii stats", evidence.piiStats),
  renderReadStatus("event_source stats", evidence.eventSourceStats),
  renderReadStatus("host stats", evidence.hostStats),
  renderReadStatus("Custom Conversions", evidence.customConversions),
  renderReadStatus("פרטי חשבון", evidence.accountInfo),
].join("\n")}

## חוסמים

${assessment.blockers.length ? assessment.blockers.map((item) => `- ${item}`).join("\n") : "- אין חוסמים בבדיקות האוטומטיות."}

## אזהרות

${assessment.warnings.length ? assessment.warnings.map((item) => `- ${item}`).join("\n") : "- אין אזהרות נוספות."}

## מסקנה

${conclusion}

אישור המסמך מאשר רק שקראת את תוצאת הבדיקה. הוא אינו מפעיל קמפיין ואינו מבצע שינוי חיצוני.${feedbackBlock}`;
}

async function readBoundedBody(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_GRAPH_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`Meta response exceeded ${MAX_GRAPH_RESPONSE_BYTES} bytes`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total).toString("utf-8");
}

function apiError(payload: unknown, status: number): string {
  if (isRecord(payload) && isRecord(payload.error)) {
    const message = typeof payload.error.message === "string" ? payload.error.message : "Meta API error";
    const code = numberField(payload.error, ["code"]);
    return `${message.slice(0, 300)}${code === null ? "" : ` (code ${code})`}`;
  }
  return `Meta API returned HTTP ${status}`;
}

export async function getGraphJson(
  resourcePath: string,
  query: Readonly<Record<string, string>>,
  token: string,
  signal?: AbortSignal,
): Promise<MetaReadResult> {
  signal?.throwIfAborted();
  const url = new URL(resourcePath.replace(/^\/+/, ""), graphApiBase());
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("Meta GET timed out")), GRAPH_TIMEOUT_MS);
  timeout.unref();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
    });
    const body = await readBoundedBody(response);
    let payload: unknown;
    try {
      payload = body ? JSON.parse(body) : null;
    } catch {
      return { ok: false, error: `Meta API returned invalid JSON (HTTP ${response.status})` };
    }
    if (!response.ok) return { ok: false, error: apiError(payload, response.status) };
    return { ok: true, data: payload };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

const DEFAULT_DEPENDENCIES: Stage8ReadDependencies = {
  readToken: readSecret,
  getJson: getGraphJson,
};

export async function collectStage8Evidence(
  profile: ClientProfile,
  options: {
    readonly signal?: AbortSignal;
    readonly now?: Date;
    readonly dependencies?: Stage8ReadDependencies;
  } = {},
): Promise<Stage8Evidence> {
  const meta = profile.meta;
  if (
    !meta?.accountId ||
    !meta.pixelId ||
    !meta.customConversionId ||
    !meta.domain ||
    !meta.tokenKeychainService
  ) {
    throw new Error("Stage 8 reached the reader without complete Meta profile fields.");
  }
  const dependencies = options.dependencies ?? DEFAULT_DEPENDENCIES;
  const now = options.now ?? new Date();
  const start = new Date(now.getTime() - SEVEN_DAYS_MS);
  const timeQuery = {
    start_time: String(Math.floor(start.getTime() / 1_000)),
    end_time: String(Math.floor(now.getTime() / 1_000)),
  };
  const token = await dependencies.readToken(meta.tokenKeychainService, options.signal);
  options.signal?.throwIfAborted();

  const [pixel, pixelAccounts, events, pii, sources, hosts, conversions, account] = await Promise.all([
    dependencies.getJson(
      meta.pixelId,
      { fields: "id,name,last_fired_time,is_unavailable" },
      token,
      options.signal,
    ),
    dependencies.getJson(
      `${meta.pixelId}/adaccounts`,
      { fields: "id,name", limit: "100" },
      token,
      options.signal,
    ),
    dependencies.getJson(
      `${meta.pixelId}/stats`,
      { aggregation: "event", ...timeQuery },
      token,
      options.signal,
    ),
    dependencies.getJson(
      `${meta.pixelId}/stats`,
      { aggregation: "had_pii", event: "Purchase", ...timeQuery },
      token,
      options.signal,
    ),
    dependencies.getJson(
      `${meta.pixelId}/stats`,
      { aggregation: "event_source", event: "Purchase", ...timeQuery },
      token,
      options.signal,
    ),
    dependencies.getJson(
      `${meta.pixelId}/stats`,
      { aggregation: "host", event: "Purchase", ...timeQuery },
      token,
      options.signal,
    ),
    dependencies.getJson(
      `${meta.accountId}/customconversions`,
      {
        fields: "id,name,event_source_id,pixel,data_sources,custom_event_type,is_archived,is_unavailable,last_fired_time,rule",
        limit: "100",
      },
      token,
      options.signal,
    ),
    dependencies.getJson(
      meta.accountId,
      { fields: "id,name,account_status,currency,disable_reason,timezone_name" },
      token,
      options.signal,
    ),
  ]);
  options.signal?.throwIfAborted();

  return {
    checkedAt: now.toISOString(),
    windowStart: start.toISOString(),
    windowEnd: now.toISOString(),
    accountId: meta.accountId,
    pixelId: meta.pixelId,
    customConversionId: meta.customConversionId,
    domain: meta.domain,
    pixelInfo: pixel,
    pixelAccounts,
    eventStats: events,
    piiStats: pii,
    eventSourceStats: sources,
    hostStats: hosts,
    customConversions: conversions,
    accountInfo: account,
  };
}

function appendFeedbackOnce(history: string[], feedback?: string): string[] {
  if (!feedback || history.at(-1) === feedback) return history;
  return [...history, feedback];
}

export async function runStage8PixelVerify(
  runId: string,
  runDir: string,
  feedback?: string,
  control?: ExecutionControl,
): Promise<void> {
  control?.throwIfAborted();
  const run = getRun(runId);
  if (!run?.stages) throw new Error(`Run ${runId} or stages not found`);
  const subTaskId = "8";
  const startedAt = new Date().toISOString();
  const runningStages = run.stages.map((stage) =>
    stage.number === 8
      ? {
          ...stage,
          status: "running" as const,
          startedAt,
          currentSubTaskId: subTaskId,
          feedbackHistory: appendFeedbackOnce(stage.feedbackHistory, feedback),
          subTasks: stage.subTasks.map((subTask) =>
            subTask.id === subTaskId
              ? {
                  ...subTask,
                  status: "running" as const,
                  output: "",
                  errorMessage: undefined,
                  startedAt,
                  metaVerification: undefined,
                  feedbackHistory: appendFeedbackOnce(subTask.feedbackHistory, feedback),
                }
              : subTask,
          ),
        }
      : stage,
  );
  updateRun(runId, { stages: runningStages, currentStage: 8 });
  eventBus.emit(runId, { type: "stage-started", runId, stageNumber: 8 });
  eventBus.emit(runId, { type: "subtask-started", runId, stageNumber: 8, subTaskId });

  const logName = `stage-8-${getStageDef(8).ownerSlug}.log`;
  try {
    if (!run.clientProfile) {
      throw new Error(
        "Stage 8 is blocked because this legacy run has no client-profile snapshot. Start a new run with a configured client profile.",
      );
    }
    const profile = assertClientFeatureReady(run.clientProfile, "stage8");
    control?.throwIfAborted();
    const evidence = await collectStage8Evidence(profile, { signal: control?.signal });
    control?.throwIfAborted();
    const assessment = assessStage8Evidence(evidence);
    const report = buildStage8Report(profile, evidence, assessment, feedback);
    await saveRunArtifact(runDir, "stage-8.md", report);
    await appendLog(runDir, logName, `${report}\n`);
    control?.throwIfAborted();

    const finalStages = (getRun(runId)?.stages ?? []).map((stage) =>
      stage.number === 8
        ? {
            ...stage,
            subTasks: stage.subTasks.map((subTask) =>
              subTask.id === subTaskId
                ? {
                    ...subTask,
                    status: "awaiting-decision" as const,
                    output: report,
                    completedAt: new Date().toISOString(),
                    metaVerification: {
                      schemaVersion: 1 as const,
                      ready: assessment.ready,
                      reportSha256: stage8ReportSha256(report),
                      checkedAt: evidence.checkedAt,
                    },
                  }
                : subTask,
            ),
          }
        : stage,
    );
    updateRun(runId, { stages: finalStages });
    eventBus.emit(runId, {
      type: "subtask-completed",
      runId,
      stageNumber: 8,
      subTaskId,
      content: report,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const failedStages = (getRun(runId)?.stages ?? []).map((stage) =>
      stage.number === 8
        ? {
            ...stage,
            status: "error" as const,
            errorMessage,
            subTasks: stage.subTasks.map((subTask) =>
              subTask.id === subTaskId
                ? { ...subTask, status: "error" as const, errorMessage }
                : subTask,
            ),
          }
        : stage,
    );
    updateRun(runId, { stages: failedStages });
    if (!control?.signal.aborted) {
      eventBus.emit(runId, {
        type: "subtask-error",
        runId,
        stageNumber: 8,
        subTaskId,
        errorMessage,
      });
      eventBus.emit(runId, { type: "stage-error", runId, stageNumber: 8, errorMessage });
    }
    await appendLog(runDir, logName, `# ERROR\n\n${errorMessage}\n`).catch(() => undefined);
    throw error;
  }
}
