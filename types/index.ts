export type AgentSlug =
  | "yoni-strategist"
  | "roni-creative"
  | "omer-ad-copywriter"
  | "maya-lp-copywriter"
  | "daniel-lp-designer"
  | "avishai-campaigner"
  | "rafael-researcher"
  | "uri-art-director"
  | "synthesizer";

export interface AgentMeta {
  slug: AgentSlug;
  name: string;
  role: string;
  color: string;
  order: number;
  active: boolean;
}

export interface Agent extends AgentMeta {
  systemPrompt: string;
  avatarPath: string;
}

export type RoundNumber = 1 | 2 | 3;

export interface Message {
  agentSlug: AgentSlug;
  round: RoundNumber | "synthesis";
  content: string;
  status: "pending" | "streaming" | "done" | "error";
  startedAt: string;
  completedAt?: string;
  errorMessage?: string;
}

export interface StrategyRevision {
  strategyDoc: string;
  messages: Message[];
  feedback: string;
  archivedAt: string;
}

export type RunStatus =
  | "pending"
  | "discussing"
  | "synthesizing"
  | "awaiting-decision"
  | "approved"
  | "error";

export type StageNumber = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

/**
 * Which page the run is building. Stage 4 writes a different set of sections
 * for each: a paid page needs a stack, a price and a guarantee, while a page
 * that gives something away free has none of those to write about.
 */
export type AssetType =
  | "sales-page"
  | "premium-lead-page"
  | "webinar-page"
  | "squeeze-page"
  | "upsell-page";

export const ASSET_TYPES: readonly AssetType[] = [
  "sales-page", "premium-lead-page", "webinar-page", "squeeze-page", "upsell-page",
];

export function isAssetType(value: unknown): value is AssetType {
  return typeof value === "string" && (ASSET_TYPES as readonly string[]).includes(value);
}

/**
 * How the run works. "council" is the eight-agent discussion with a strategy
 * gate and nine stages. "direct" is the sales-page chain: one agent plus one
 * scoring critic per stage, four stages, no strategy discussion (spec 2026-09-15).
 * Runs saved before this field existed are council runs.
 */
export type Pipeline = "council" | "direct";
export const PIPELINES: readonly Pipeline[] = ["council", "direct"];
export function isPipeline(value: unknown): value is Pipeline {
  return typeof value === "string" && (PIPELINES as readonly string[]).includes(value);
}

export interface PersistedExecutionAttempt {
  attemptId: string;
  ownerId: string;
  state: "running" | "error";
  retrySafety: "safe" | "review-required";
  startedAt: number;
  heartbeatAt: number;
  leaseExpiresAt: number;
  deadlineAt: number;
  endedAt?: number;
  failureReason?: string;
  errorMessage?: string;
}

export type StageStatus =
  | "pending"
  | "running"
  | "awaiting-decision"
  | "approved"
  | "skipped"
  | "error";

export interface Critique {
  agentSlug: AgentSlug;
  content: string;
  status: "pending" | "streaming" | "done" | "error";
  errorMessage?: string;
}

export type ImageMapWidth = 390 | 1280;

/** Stage 5.3: which mapped images the rendered page really shows, bound to the attempt and its inputs. */
export interface ImageMapCheck {
  schemaVersion: 1;
  passed: boolean;
  mappedCount: number;
  missing: { file: string; section: string; proves: string; widths: ImageMapWidth[] }[];
  /** Set when the check itself could not complete or was invalidated. Always with passed: false. */
  failure?: string;
  attemptStartedAt: string;
  assetManifestSha256: string;
  pageSourceManifestSha256: string;
  checkedAt: string;
}

/** What a mockup render receipt says about one mockup entry of an attempt. */
export interface MockupRenderReceiptEntry {
  file: string;
  /** screen name -> sha256 of the HTML the orchestrator rendered. */
  screensSha256: Record<string, string>;
  outputSha256?: string;
  status: "ok" | "rejected";
  reason?: string;
  /**
   * What the render script reported about this mockup's screens without
   * failing them: a font wait that did not settle, and anything else that
   * would otherwise make a flawed mockup look perfect.
   */
  notes?: string[];
}

/**
 * Stage 5.2: the app-owned record of what an attempt actually rendered. It is
 * bound to the attempt like the asset manifest, so a mockup file from an
 * earlier attempt can never re-qualify without being rendered again. The
 * renderer that writes it lives in orchestrator/mockupRenderer.ts, which
 * re-exports these two interfaces; they live here because types/ may not
 * import from orchestrator/.
 */
export interface MockupRenderReceipt {
  schemaVersion: 1;
  attemptId: string;
  /**
   * base name -> sha256 of the base frame this attempt composited onto. Only
   * the frames the run actually loaded appear: a run with chapter mockups
   * alone carries no "devices" key, so a reader must never assume both.
   */
  baseSha256: Record<string, string>;
  mockups: MockupRenderReceiptEntry[];
  renderedAt: string;
  /**
   * Operational leftovers, never a mockup's problem: a scratch directory that
   * could not be removed does not undo a run whose outputs are already in the
   * assets folder.
   */
  warnings?: string[];
}

export type SubTaskPhase = "draft" | "critique" | "revise" | "critic-round";

export interface CriticRound {
  round: number;
  verdict: "approve" | "revise" | "block" | "unreadable";
  scores?: Record<string, number>;
  avg?: number;
  min?: number;
  fixes?: { quote: string; rule: string; fix: string }[];
  reason?: string;
  /** The critic was asked again in this round because a reversal pointed at no earlier item. */
  reversalReask?: boolean;
  at: string;
}

export interface SubTask {
  id: string;
  title: string;
  status: StageStatus;
  output: string;
  feedbackHistory: string[];
  startedAt?: string;
  completedAt?: string;
  errorMessage?: string;
  // Mini-discussion only (undefined for plain sub-tasks):
  draftOutput?: string;
  critiques?: Critique[];
  currentPhase?: SubTaskPhase;
  /** runCriticLoop only: one entry per critic round, newest last. */
  criticRounds?: CriticRound[];
  /** runCriticLoop only: the round in progress while status is running. */
  criticRound?: number;
  /** Stage 7.5 only: the client's chosen production mode, set from the gate UI. */
  creativeMode?: CreativeMode;
  assetManifestSha256?: string;
  assetManifestDraftSha256?: string;
  assetContactSheetFile?: string;
  assetContactSheetSha256?: string;
  preparedAssetHashes?: Record<string, string>;
  pageSourceHashes?: Record<string, string>;
  landingHeadSha?: string;
  landingCommitSha?: string;
  pageSlug?: string;
  landingWorktreePath?: string;
  /** A passing Stage 5.4 QA result bound to the exact approved build inputs. */
  qaVerification?: {
    schemaVersion: 1;
    ready: true;
    reportSha256: string;
    pageSourceManifestSha256: string;
    assetManifestSha256: string;
    widths: number[];
    checkedAt: string;
  };
  /**
   * Stage 5.3 only: how the last design round ended. `passed` is true only
   * when every critic returned an explicit "עובר". `silent` names critics
   * that returned no readable verdict even after a re-ask. The express gate
   * refuses to auto-approve 5.3 unless `passed` is true.
   */
  designReview?: {
    schemaVersion: 1;
    passed: boolean;
    failing: string[];
    silent: string[];
    checkedAt: string;
  };
  /** Sealed result of Stage 8's typed, read-only Meta verification. */
  metaVerification?: {
    schemaVersion: 1;
    ready: boolean;
    reportSha256: string;
    checkedAt: string;
  };
  /** Stage 5.3 only. Express approval requires passed and a current binding. */
  imageMapCheck?: ImageMapCheck;
  /** Stage 5.2 only: what this attempt's orchestrator-side mockup render produced. */
  mockupRender?: MockupRenderReceipt;
  /** Stage 1 of a direct run: what the harvest script produced, for the card that shows the sheet. */
  harvest?: {
    schemaVersion: 1;
    sheetFile: "sheet.jpg";
    imageCount: number;
    harvestedAt: string;
    /** The Instagram handle resolved for this harvest (feedback override, else the brief's). Used for stage 5.2's live proof. */
    igHandle?: string;
  };
}

export interface Stage {
  number: StageNumber;
  title: string;
  ownerSlug: AgentSlug;
  status: StageStatus;
  output: string;
  feedbackHistory: string[];
  startedAt?: string;
  completedAt?: string;
  errorMessage?: string;
  subTasks: SubTask[];
  currentSubTaskId?: string;
}

export interface Run {
  id: string;
  slug: string;
  brief: string;
  createdAt: string;
  status: RunStatus;
  currentRound: RoundNumber | "synthesis" | null;
  messages: Message[];
  strategyDoc?: string;
  /** Earlier strategy and discussion snapshots preserved before feedback reruns. */
  strategyRevisions?: StrategyRevision[];
  errorMessage?: string;
  /**
   * A write of this run that did not reach the disk, in the operator's words.
   *
   * Process-local and never persisted: it is stripped at the write boundary,
   * because it is a fact ABOUT saving this run, not part of it, and a run
   * loaded from disk has by definition been saved. It travels beside
   * `errorMessage` rather than over it, so the failure the operator is
   * actually working on stays where it was, and it is cleared the moment a
   * save of this run succeeds.
   */
  persistenceError?: string;
  stages?: Stage[];
  currentStage?: StageNumber | null;
  executionAttempts?: Record<string, PersistedExecutionAttempt>;
  /** Immutable, secret-free tenant configuration captured when the run starts. */
  clientProfile?: ClientProfile;
  /** Chosen when the run is created. Runs saved before this default to a sales page. */
  assetType?: AssetType;
  /** Chosen when the run is created. Absent on runs saved before it existed = council. */
  pipeline?: Pipeline;
  /**
   * Absolute page-type template folder, resolved once from the profile the run
   * was created with. Runs saved before this field existed read no template.
   */
  pageTypesDir?: string;
}

export interface SSEEvent {
  type:
    | "round-started"
    | "agent-started"
    | "agent-token"
    | "agent-completed"
    | "synthesis-started"
    | "synthesis-token"
    | "synthesis-completed"
    | "run-completed"
    | "stages-initialized"
    | "stage-started"
    | "stage-token"
    | "stage-completed"
    | "stage-error"
    | "stage-skipped"
    | "subtask-started"
    | "subtask-token"
    | "subtask-phase-changed"
    | "subtask-completed"
    | "subtask-error"
    | "critique-started"
    | "critique-token"
    | "critique-completed"
    | "critic-round-started"
    | "critic-round-completed"
    | "error";
  runId: string;
  agentSlug?: AgentSlug;
  round?: RoundNumber | "synthesis";
  token?: string;
  content?: string;
  errorMessage?: string;
  stageNumber?: StageNumber;
  stages?: Stage[];
  /** On "stages-initialized": which pipeline the run is, so the live view can shed the discussion sections. */
  pipeline?: Pipeline;
  subTaskId?: string;
  phase?: SubTaskPhase;
  criticSlug?: AgentSlug;
  harvest?: SubTask["harvest"];
  criticRoundNumber?: number;
  criticRound?: CriticRound;
}
import type { CreativeMode } from "@/lib/creativeMode";
import type { ClientProfile } from "@/config/clientProfile";
