import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { validateClientProfile } from "@/config/clientProfile";
import {
  MAX_ASSET_COUNT,
  MAX_RECEIPT_FILE_CHARS,
  SCREEN_NAME_RE,
  isMockupRenderBase,
} from "@/lib/mockupContract";
import type { Run, RunStatus, StageNumber } from "@/types";
import { isPipeline } from "@/types";

export const RUN_STATE_SCHEMA_VERSION = 1;
export const MAX_RUN_STATE_BYTES = 8 * 1024 * 1024;

const MAX_BRIEF_BYTES = 1024 * 1024;
const MAX_MIGRATION_ENTRIES = 50_000;
const MAX_MIGRATION_BYTES = 10 * 1024 * 1024 * 1024;
const MAX_RUN_ARTIFACT_BYTES = 16 * 1024 * 1024;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const NO_FOLLOW = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const LOG_FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const ROOT_ARTIFACT_RE = /^stage-[1-9](?:-[A-Za-z0-9][A-Za-z0-9._-]{0,127})?\.md$/;
const SUBTASK_ARTIFACT_RE = /^stage-[1-9]\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.md$/;
const STORAGE_SCHEMA_KEY = "_storageSchemaVersion";

class UnsafeRunStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeRunStorageError";
  }
}

function sameFilesystemPath(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

/**
 * Storage roots are chmodded to 0700. Refuse broad or ambiguous configured
 * paths before that hardening can accidentally change a user's home,
 * workspace, temp root, or a top-level system directory.
 */
function resolveConfiguredStoragePath(value: string, variable: string): string {
  if (value.includes("\0") || !path.isAbsolute(value)) {
    throw new UnsafeRunStorageError(`${variable} must be an absolute dedicated directory`);
  }
  const resolved = path.resolve(value);
  const filesystemRoot = path.parse(resolved).root;
  const forbidden = [
    filesystemRoot,
    os.homedir(),
    process.cwd(),
    os.tmpdir(),
    ...(process.platform === "win32" ? [] : ["/tmp", "/private/tmp", "/var/tmp"]),
  ].filter(Boolean);
  if (
    path.dirname(resolved) === filesystemRoot
    || forbidden.some((candidate) => sameFilesystemPath(resolved, candidate))
  ) {
    throw new UnsafeRunStorageError(
      `${variable} must point to a dedicated subdirectory, not a broad system or workspace path`,
    );
  }
  return resolved;
}

function defaultDataDirectory(): string {
  const home = os.homedir();
  if (!home) throw new Error("Could not determine the local data directory");

  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "Campaign Council");
  }
  if (process.platform === "win32") {
    const windowsData = process.env.LOCALAPPDATA || process.env.APPDATA;
    return path.join(
      windowsData
        ? resolveConfiguredStoragePath(windowsData, windowsData === process.env.LOCALAPPDATA ? "LOCALAPPDATA" : "APPDATA")
        : home,
      "Campaign Council",
    );
  }

  const xdgData = process.env.XDG_DATA_HOME?.trim();
  return xdgData
    ? path.join(resolveConfiguredStoragePath(xdgData, "XDG_DATA_HOME"), "campaign-council")
    : path.join(home, ".local", "share", "campaign-council");
}

/**
 * `RUNS_DIR_OVERRIDE` remains an exact-root compatibility hook for tests and
 * existing installations. New installations use a private OS data directory.
 */
export function runsRoot(): string {
  const exactOverride = process.env.RUNS_DIR_OVERRIDE?.trim();
  if (exactOverride) {
    return resolveConfiguredStoragePath(exactOverride, "RUNS_DIR_OVERRIDE");
  }

  const configuredDataDirectory = process.env.CAMPAIGN_COUNCIL_DATA_DIR?.trim();
  return path.join(
    configuredDataDirectory
      ? resolveConfiguredStoragePath(
          configuredDataDirectory,
          "CAMPAIGN_COUNCIL_DATA_DIR",
        )
      : defaultDataDirectory(),
    "runs",
  );
}

function legacyRunsRoot(): string {
  const override = process.env.RUNS_LEGACY_DIR_OVERRIDE?.trim();
  return override
    ? resolveConfiguredStoragePath(override, "RUNS_LEGACY_DIR_OVERRIDE")
    : path.resolve(process.cwd(), "runs");
}

function discoveryRoots(): string[] {
  const primary = runsRoot();
  if (process.env.RUNS_DIR_OVERRIDE?.trim()) return [primary];
  const legacy = legacyRunsRoot();
  return primary === legacy ? [primary] : [primary, legacy];
}

function candidateRunDir(root: string, runId: string): string {
  const resolvedRoot = path.resolve(root);
  const candidate = path.resolve(resolvedRoot, runId);
  if (path.dirname(candidate) !== resolvedRoot) {
    throw new TypeError("Invalid run directory");
  }
  return candidate;
}

export function assertValidRunId(runId: string): void {
  if (!RUN_ID_RE.test(runId) || runId === "." || runId === "..") {
    throw new TypeError("Invalid run id");
  }
}

function assertAllowedRunDirectory(dir: string, expectedRunId?: string): string {
  const resolved = path.resolve(dir);
  const roots = discoveryRoots().map((root) => path.resolve(root));
  if (expectedRunId === undefined && roots.includes(resolved)) {
    return path.basename(resolved);
  }
  const runId = path.basename(resolved);
  assertValidRunId(runId);
  if (expectedRunId !== undefined && runId !== expectedRunId) {
    throw new TypeError("Run id does not match its directory");
  }
  const allowed = roots.some(
    (root) => candidateRunDir(root, runId) === resolved,
  );
  if (!allowed) throw new TypeError("Run directory is outside the data roots");
  return runId;
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

async function inspectDirectory(dir: string): Promise<"missing" | "directory"> {
  try {
    const stat = await fs.lstat(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new UnsafeRunStorageError("Run storage path is not a regular directory");
    }
    return "directory";
  } catch (error) {
    if (isErrno(error, "ENOENT")) return "missing";
    throw error;
  }
}

async function ensurePrivateDirectory(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  if (await inspectDirectory(dir) !== "directory") {
    throw new UnsafeRunStorageError("Could not create a safe run directory");
  }
  await fs.chmod(dir, PRIVATE_DIRECTORY_MODE);
}

async function syncDirectory(dir: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(dir, fsConstants.O_RDONLY | NO_FOLLOW);
    await handle.sync();
  } catch (error) {
    if (
      !isErrno(error, "EINVAL")
      && !isErrno(error, "ENOTSUP")
      && !isErrno(error, "EPERM")
      && !isErrno(error, "EISDIR")
    ) {
      throw error;
    }
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function ensureSafeRunDirectory(dir: string, expectedRunId?: string): Promise<void> {
  assertAllowedRunDirectory(dir, expectedRunId);
  const resolved = path.resolve(dir);
  const isStorageRoot = discoveryRoots().some((root) => path.resolve(root) === resolved);
  if (!isStorageRoot) await ensurePrivateDirectory(path.dirname(resolved));
  await ensurePrivateDirectory(dir);
}

function assertSafeLogFilename(filename: string): void {
  if (
    !LOG_FILENAME_RE.test(filename)
    || filename === "."
    || filename === ".."
    || path.basename(filename) !== filename
  ) {
    throw new TypeError("Invalid log filename");
  }
}

async function atomicWritePrivateFile(
  dir: string,
  filename: string,
  content: string | Buffer,
): Promise<void> {
  await ensureSafeRunDirectory(dir);
  await atomicWritePrivateFileInDirectory(dir, filename, content);
}

/** The caller has already validated and privately opened the parent tree. */
async function atomicWritePrivateFileInDirectory(
  dir: string,
  filename: string,
  content: string | Buffer,
): Promise<void> {
  const target = path.join(dir, filename);
  const tmp = path.join(
    dir,
    `.${filename}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(
      tmp,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NO_FOLLOW,
      PRIVATE_FILE_MODE,
    );
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(tmp, target);
    await syncDirectory(dir);
  } catch (error) {
    await handle?.close().catch(() => {});
    await fs.unlink(tmp).catch(() => {});
    throw error;
  }
}

async function readBoundedRegularFile(file: string, maxBytes: number): Promise<Buffer> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    const beforeOpen = await fs.lstat(file);
    if (beforeOpen.isSymbolicLink() || !beforeOpen.isFile()) {
      throw new UnsafeRunStorageError("Run state is not a regular file");
    }
    handle = await fs.open(file, fsConstants.O_RDONLY | NO_FOLLOW);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > maxBytes) {
      throw new UnsafeRunStorageError("Run state exceeds its allowed size");
    }

    const chunks: Buffer[] = [];
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let total = 0;
    while (true) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) {
        throw new UnsafeRunStorageError("Run state exceeds its allowed size");
      }
      chunks.push(Buffer.from(chunk.subarray(0, bytesRead)));
    }
    return Buffer.concat(chunks, total);
  } finally {
    await handle?.close().catch(() => {});
  }
}

interface MigrationBudget {
  entries: number;
  bytes: number;
}

async function copyRegularFile(
  source: string,
  target: string,
  budget: MigrationBudget,
): Promise<void> {
  let sourceHandle: Awaited<ReturnType<typeof fs.open>> | undefined;
  let targetHandle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    sourceHandle = await fs.open(source, fsConstants.O_RDONLY | NO_FOLLOW);
    const stat = await sourceHandle.stat();
    if (!stat.isFile()) throw new UnsafeRunStorageError("Legacy run contains a non-regular file");
    budget.bytes += stat.size;
    if (budget.bytes > MAX_MIGRATION_BYTES) {
      throw new UnsafeRunStorageError("Legacy run is too large to migrate safely");
    }

    targetHandle = await fs.open(
      target,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NO_FOLLOW,
      PRIVATE_FILE_MODE,
    );
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < stat.size) {
      const { bytesRead } = await sourceHandle.read(
        chunk,
        0,
        Math.min(chunk.length, stat.size - position),
        position,
      );
      if (bytesRead === 0) {
        throw new UnsafeRunStorageError("Legacy run changed while it was being migrated");
      }
      let written = 0;
      while (written < bytesRead) {
        const result = await targetHandle.write(
          chunk,
          written,
          bytesRead - written,
          null,
        );
        if (result.bytesWritten === 0) {
          throw new Error("Could not finish copying a legacy run file");
        }
        written += result.bytesWritten;
      }
      position += bytesRead;
    }
    const afterCopy = await sourceHandle.stat();
    if (afterCopy.size !== stat.size || afterCopy.mtimeMs !== stat.mtimeMs) {
      throw new UnsafeRunStorageError("Legacy run changed while it was being migrated");
    }
    await targetHandle.sync();
  } finally {
    await targetHandle?.close().catch(() => {});
    await sourceHandle?.close().catch(() => {});
  }
}

async function copyLegacyDirectory(
  source: string,
  target: string,
  budget: MigrationBudget,
): Promise<void> {
  const sourceStat = await fs.lstat(source);
  if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) {
    throw new UnsafeRunStorageError("Legacy run contains an unsafe directory");
  }
  await fs.mkdir(target, { mode: PRIVATE_DIRECTORY_MODE });

  const entries = await fs.readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    budget.entries += 1;
    if (budget.entries > MAX_MIGRATION_ENTRIES) {
      throw new UnsafeRunStorageError("Legacy run contains too many files");
    }
    const sourceChild = path.join(source, entry.name);
    const targetChild = path.join(target, entry.name);
    const stat = await fs.lstat(sourceChild);
    if (stat.isSymbolicLink()) {
      throw new UnsafeRunStorageError("Legacy run contains a symbolic link");
    }
    if (stat.isDirectory()) {
      await copyLegacyDirectory(sourceChild, targetChild, budget);
    } else if (stat.isFile()) {
      await copyRegularFile(sourceChild, targetChild, budget);
    } else {
      throw new UnsafeRunStorageError("Legacy run contains a non-regular file");
    }
  }
  await fs.chmod(target, PRIVATE_DIRECTORY_MODE);
  await syncDirectory(target);
}

async function migrateLegacyRun(source: string, target: string): Promise<void> {
  await ensurePrivateDirectory(path.dirname(target));
  if (await inspectDirectory(target) === "directory") return;

  const staging = path.join(
    path.dirname(target),
    `.migration-${path.basename(target)}-${crypto.randomUUID()}`,
  );
  try {
    await copyLegacyDirectory(source, staging, { entries: 0, bytes: 0 });
    await fs.rename(staging, target);
    await syncDirectory(path.dirname(target));
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
    if (isErrno(error, "EEXIST") || isErrno(error, "ENOTEMPTY")) {
      if (await inspectDirectory(target) === "directory") return;
    }
    throw error;
  }
}

const legacyFallbacks = new Map<string, string>();

function fallbackKey(runId: string): string {
  return `${runsRoot()}\0${runId}`;
}

async function resolveRunDirectoryForRead(runId: string): Promise<string | null> {
  assertValidRunId(runId);
  const primary = candidateRunDir(runsRoot(), runId);
  if (await inspectDirectory(primary) === "directory") return primary;
  if (process.env.RUNS_DIR_OVERRIDE?.trim()) return null;

  const legacy = candidateRunDir(legacyRunsRoot(), runId);
  if (legacy === primary || await inspectDirectory(legacy) === "missing") return null;
  try {
    await migrateLegacyRun(legacy, primary);
    legacyFallbacks.delete(fallbackKey(runId));
    return primary;
  } catch (error) {
    if (error instanceof UnsafeRunStorageError) throw error;
    // A read-only install or a temporarily full data volume must not hide an
    // old run. Keep using the untouched legacy directory for this process.
    legacyFallbacks.set(fallbackKey(runId), legacy);
    return legacy;
  }
}

/** Absolute path of a run's folder, whether or not it exists yet. */
export function runDirFor(runId: string): string {
  assertValidRunId(runId);
  return legacyFallbacks.get(fallbackKey(runId))
    ?? candidateRunDir(runsRoot(), runId);
}

export async function createRunDir(runId: string): Promise<string> {
  assertValidRunId(runId);
  const existing = await resolveRunDirectoryForRead(runId);
  const dir = existing ?? candidateRunDir(runsRoot(), runId);
  await ensureSafeRunDirectory(dir, runId);
  await ensurePrivateDirectory(path.join(dir, "logs"));
  return dir;
}

/** Create a brand-new run root without ever reusing or overwriting an id. */
export async function createNewRunDir(runId: string): Promise<string> {
  assertValidRunId(runId);
  for (const root of discoveryRoots()) {
    const candidate = candidateRunDir(root, runId);
    if (await inspectDirectory(candidate) === "directory") {
      const error = new Error(`Run ${runId} already exists`) as NodeJS.ErrnoException;
      error.code = "EEXIST";
      throw error;
    }
  }

  const root = runsRoot();
  await ensurePrivateDirectory(root);
  const dir = candidateRunDir(root, runId);
  await fs.mkdir(dir, { mode: PRIVATE_DIRECTORY_MODE });
  await fs.chmod(dir, PRIVATE_DIRECTORY_MODE);
  await fs.mkdir(path.join(dir, "logs"), { mode: PRIVATE_DIRECTORY_MODE });
  await syncDirectory(dir);
  await syncDirectory(root);
  return dir;
}

export async function saveBrief(dir: string, brief: string): Promise<void> {
  await atomicWritePrivateFile(dir, "brief.md", brief);
}

export async function saveTranscript(dir: string, content: string): Promise<void> {
  await atomicWritePrivateFile(dir, "transcript.md", content);
}

export async function saveStrategy(dir: string, content: string): Promise<void> {
  await atomicWritePrivateFile(dir, "strategy.md", content);
}

/**
 * Save a bounded human-readable stage artifact without following symlinks or
 * exposing partially-written output. Only the two repository-owned layouts
 * are accepted: `stage-N*.md` and `stage-N/subtask-id.md`.
 */
export async function saveRunArtifact(
  dir: string,
  relativePath: string,
  content: string,
): Promise<void> {
  if (!ROOT_ARTIFACT_RE.test(relativePath) && !SUBTASK_ARTIFACT_RE.test(relativePath)) {
    throw new TypeError("Invalid run artifact path");
  }
  if (Buffer.byteLength(content, "utf8") > MAX_RUN_ARTIFACT_BYTES) {
    throw new RangeError("Run artifact exceeds its allowed size");
  }
  await ensureSafeRunDirectory(dir);
  const parts = relativePath.split("/");
  let targetDir = dir;
  if (parts.length === 2) {
    targetDir = path.join(dir, parts[0]);
    try {
      await fs.mkdir(targetDir, { mode: PRIVATE_DIRECTORY_MODE });
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
    }
    if (await inspectDirectory(targetDir) !== "directory") {
      throw new UnsafeRunStorageError("Run artifact directory is unsafe");
    }
    await fs.chmod(targetDir, PRIVATE_DIRECTORY_MODE);
  }
  await atomicWritePrivateFileInDirectory(targetDir, parts.at(-1)!, content);
}

export async function appendLog(
  dir: string,
  filename: string,
  content: string,
): Promise<void> {
  assertSafeLogFilename(filename);
  await ensureSafeRunDirectory(dir);
  const logsDir = path.join(dir, "logs");
  await ensurePrivateDirectory(logsDir);
  const logPath = path.join(logsDir, filename);
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    try {
      const existing = await fs.lstat(logPath);
      if (existing.isSymbolicLink() || !existing.isFile()) {
        throw new UnsafeRunStorageError("Log path is not a regular file");
      }
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
    }
    handle = await fs.open(
      logPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND | NO_FOLLOW,
      PRIVATE_FILE_MODE,
    );
    const stat = await handle.stat();
    if (!stat.isFile()) throw new UnsafeRunStorageError("Log path is not a regular file");
    await handle.chmod(PRIVATE_FILE_MODE);
    await handle.writeFile(content);
  } finally {
    await handle?.close().catch(() => {});
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isOptionalStringArray(record: Record<string, unknown>, key: string): boolean {
  return record[key] === undefined || hasOnlyStrings(record[key]);
}

function isOptionalString(record: Record<string, unknown>, key: string): boolean {
  return record[key] === undefined || typeof record[key] === "string";
}

const SHA256_RE = /^[a-f0-9]{64}$/;
const GIT_OBJECT_ID_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const PORTABLE_ASSET_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;

function isOptionalSha256(record: Record<string, unknown>, key: string): boolean {
  return record[key] === undefined
    || (typeof record[key] === "string" && SHA256_RE.test(record[key]));
}

function isPortableSourcePath(value: string): boolean {
  if (!value || value.length > 512 || value.includes("\0") || value.includes("\\")) return false;
  if (value.startsWith("/") || /^[A-Za-z]:\//.test(value)) return false;
  const normalized = path.posix.normalize(value);
  return normalized === value
    && normalized !== "."
    && normalized !== ".."
    && !normalized.startsWith("../");
}

function isOptionalHashRecord(
  value: unknown,
  keyValidator: (key: string) => boolean,
  allowEmpty = true,
): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  const entries = Object.entries(value);
  return (allowEmpty || entries.length > 0)
    && entries.length <= 512
    && entries.every(([key, hash]) => keyValidator(key) && typeof hash === "string" && SHA256_RE.test(hash));
}

function isValidCritique(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return typeof value.agentSlug === "string"
    && typeof value.content === "string"
    && typeof value.status === "string"
    && MESSAGE_STATUSES.has(value.status)
    && isOptionalString(value, "errorMessage");
}

const RUN_STATUSES = new Set<RunStatus>([
  "pending",
  "discussing",
  "synthesizing",
  "awaiting-decision",
  "approved",
  "error",
]);
const STAGE_STATUSES = new Set(["pending", "running", "awaiting-decision", "approved", "skipped", "error"]);
const MESSAGE_STATUSES = new Set(["pending", "streaming", "done", "error"]);

function isValidMessage(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return typeof value.agentSlug === "string"
    && value.agentSlug.length > 0
    && value.agentSlug.length <= 128
    && (value.round === 1 || value.round === 2 || value.round === 3 || value.round === "synthesis")
    && typeof value.content === "string"
    && typeof value.status === "string"
    && MESSAGE_STATUSES.has(value.status)
    && typeof value.startedAt === "string"
    && isOptionalString(value, "completedAt")
    && isOptionalString(value, "errorMessage");
}

function isValidStrategyRevision(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return typeof value.strategyDoc === "string"
    && Array.isArray(value.messages)
    && value.messages.every(isValidMessage)
    && typeof value.feedback === "string"
    && typeof value.archivedAt === "string"
    && Number.isFinite(Date.parse(value.archivedAt));
}

function isValidMetaVerification(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  return value.schemaVersion === 1
    && typeof value.ready === "boolean"
    && typeof value.reportSha256 === "string"
    && /^[a-f0-9]{64}$/.test(value.reportSha256)
    && typeof value.checkedAt === "string"
    && Number.isFinite(Date.parse(value.checkedAt));
}

function isValidDesignReview(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  const names = (list: unknown): boolean =>
    Array.isArray(list) && list.length <= 12 && list.every((n) => typeof n === "string" && n.length > 0 && n.length <= 80);
  return value.schemaVersion === 1
    && typeof value.passed === "boolean"
    && names(value.failing)
    && names(value.silent)
    && typeof value.checkedAt === "string"
    && !Number.isNaN(Date.parse(value.checkedAt));
}

function isValidCriticRound(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const scoresOk = value.scores === undefined
    || (isRecord(value.scores) && Object.entries(value.scores).every(([k, v]) => k.length <= 120 && typeof v === "number" && v >= 1 && v <= 10));
  const fixesOk = value.fixes === undefined || (Array.isArray(value.fixes) && value.fixes.length <= 50
    && value.fixes.every((f) => isRecord(f) && typeof f.quote === "string" && typeof f.rule === "string" && typeof f.fix === "string"));
  return Number.isInteger(value.round) && (value.round as number) >= 1 && (value.round as number) <= 10
    && ["approve", "revise", "block", "unreadable"].includes(value.verdict as string)
    && scoresOk && fixesOk
    && (value.reason === undefined || typeof value.reason === "string")
    && typeof value.at === "string" && !Number.isNaN(Date.parse(value.at));
}

function isValidHarvest(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  return value.schemaVersion === 1 && value.sheetFile === "sheet.jpg"
    && Number.isInteger(value.imageCount) && (value.imageCount as number) >= 0 && (value.imageCount as number) <= 500
    && typeof value.harvestedAt === "string" && !Number.isNaN(Date.parse(value.harvestedAt))
    && (value.igHandle === undefined
      || (typeof value.igHandle === "string" && /^[A-Za-z0-9._]{2,30}$/.test(value.igHandle)));
}

function isValidQaVerification(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  const widths = value.widths;
  return value.schemaVersion === 1
    && value.ready === true
    && typeof value.reportSha256 === "string"
    && /^[a-f0-9]{64}$/.test(value.reportSha256)
    && typeof value.pageSourceManifestSha256 === "string"
    && /^[a-f0-9]{64}$/.test(value.pageSourceManifestSha256)
    && typeof value.assetManifestSha256 === "string"
    && /^[a-f0-9]{64}$/.test(value.assetManifestSha256)
    && Array.isArray(widths)
    && widths.length > 0
    && widths.length <= 12
    && widths.every((width) => Number.isSafeInteger(width) && width >= 320 && width <= 2_560)
    && new Set(widths).size === widths.length
    && typeof value.checkedAt === "string"
    && Number.isFinite(Date.parse(value.checkedAt));
}

function isValidImageMapCheck(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  const missing = value.missing;
  return value.schemaVersion === 1
    && typeof value.passed === "boolean"
    && Number.isSafeInteger(value.mappedCount)
    && Number(value.mappedCount) >= 0
    && Number(value.mappedCount) <= 1_000
    && Array.isArray(missing)
    && missing.length <= 1_000
    && missing.every((entry) => isRecord(entry)
      && typeof entry.file === "string"
      && PORTABLE_ASSET_NAME_RE.test(entry.file)
      && typeof entry.section === "string"
      && entry.section.length <= 80
      && typeof entry.proves === "string"
      && entry.proves.length <= 200
      && Array.isArray(entry.widths)
      && entry.widths.length > 0
      && entry.widths.length <= 2
      && entry.widths.every((width) => width === 390 || width === 1280)
      && new Set(entry.widths).size === entry.widths.length)
    && (value.failure === undefined || (typeof value.failure === "string" && value.failure.length <= 500))
    // The verdict must agree with its own evidence: passed exactly when nothing is missing and nothing failed.
    && value.passed === (missing.length === 0 && value.failure === undefined)
    && typeof value.attemptStartedAt === "string"
    && Number.isFinite(Date.parse(value.attemptStartedAt))
    && typeof value.assetManifestSha256 === "string"
    && /^[a-f0-9]{64}$/.test(value.assetManifestSha256)
    && typeof value.pageSourceManifestSha256 === "string"
    && /^[a-f0-9]{64}$/.test(value.pageSourceManifestSha256)
    && typeof value.checkedAt === "string"
    && Number.isFinite(Date.parse(value.checkedAt));
}

/**
 * The mockup render receipt stage 5.2 writes on its sub-task (Task 16). The
 * shape is checked the way every other app-owned record here is: a row that
 * claims "ok" without the sha256 of what it rendered is malformed, not a
 * mockup with a missing detail, because that pair is exactly what binds a
 * finished file to this attempt's render.
 */
function isValidMockupRenderReceipt(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  const bases = value.baseSha256;
  const rows = value.mockups;
  const notes = (list: unknown, limit: number): boolean =>
    list === undefined
    || (Array.isArray(list) && list.length <= limit
      && list.every((note) => typeof note === "string" && note.length > 0 && note.length <= 500));
  const row = (candidate: unknown): boolean => {
    if (!isRecord(candidate)) return false;
    // Any string within the cap: a rejected row carries the file name the
    // agent wrote, Hebrew and all, and a receipt that cannot be saved would
    // stop the whole run from persisting. The safe-name rule belongs to the
    // manifest, where assetQuality enforces it on files that count.
    return typeof candidate.file === "string"
      && candidate.file.length <= MAX_RECEIPT_FILE_CHARS
      && isRecord(candidate.screensSha256)
      && isOptionalHashRecord(candidate.screensSha256, (name) => SCREEN_NAME_RE.test(name))
      && (candidate.status === "ok" || candidate.status === "rejected")
      // "ok" means a file was composited, and its digest is what the manifest
      // is compared against; "rejected" carries no output at all.
      && (candidate.status === "ok"
        ? typeof candidate.outputSha256 === "string" && SHA256_RE.test(candidate.outputSha256)
        : candidate.outputSha256 === undefined)
      && (candidate.reason === undefined || (typeof candidate.reason === "string" && candidate.reason.length <= 500))
      && notes(candidate.notes, 32);
  };
  return value.schemaVersion === 1
    && typeof value.attemptId === "string"
    && value.attemptId.length > 0
    && value.attemptId.length <= 128
    && isOptionalHashRecord(bases, isMockupRenderBase)
    && bases !== undefined
    && Array.isArray(rows)
    // One row per declared mockup, so the asset plan's own ceiling.
    && rows.length <= MAX_ASSET_COUNT
    && rows.every(row)
    && typeof value.renderedAt === "string"
    && Number.isFinite(Date.parse(value.renderedAt))
    && notes(value.warnings, 32);
}

function isValidSubTask(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return typeof value.id === "string"
    && typeof value.title === "string"
    && typeof value.status === "string"
    && STAGE_STATUSES.has(value.status)
    && typeof value.output === "string"
    && isOptionalStringArray(value, "feedbackHistory")
    && isOptionalString(value, "startedAt")
    && isOptionalString(value, "completedAt")
    && isOptionalString(value, "errorMessage")
    && isOptionalString(value, "draftOutput")
    && (value.critiques === undefined
      || (Array.isArray(value.critiques) && value.critiques.every(isValidCritique)))
    && (value.currentPhase === undefined
      || value.currentPhase === "draft"
      || value.currentPhase === "critique"
      || value.currentPhase === "revise"
      || value.currentPhase === "critic-round")
    && (value.criticRounds === undefined
      || (Array.isArray(value.criticRounds) && value.criticRounds.every(isValidCriticRound)))
    && (value.criticRound === undefined || Number.isInteger(value.criticRound))
    && isOptionalSha256(value, "assetManifestSha256")
    && isOptionalSha256(value, "assetManifestDraftSha256")
    && isOptionalSha256(value, "assetContactSheetSha256")
    && (value.assetContactSheetFile === undefined
      || (typeof value.assetContactSheetFile === "string"
        && PORTABLE_ASSET_NAME_RE.test(value.assetContactSheetFile)))
    && isOptionalHashRecord(value.preparedAssetHashes, (key) => PORTABLE_ASSET_NAME_RE.test(key))
    && isOptionalHashRecord(value.pageSourceHashes, isPortableSourcePath, false)
    && (value.landingHeadSha === undefined
      || (typeof value.landingHeadSha === "string" && GIT_OBJECT_ID_RE.test(value.landingHeadSha)))
    && (value.landingCommitSha === undefined
      || (typeof value.landingCommitSha === "string" && GIT_OBJECT_ID_RE.test(value.landingCommitSha)))
    && (value.pageSlug === undefined
      || (typeof value.pageSlug === "string" && /^[a-z0-9][a-z0-9-]{0,119}$/.test(value.pageSlug)))
    && (value.landingWorktreePath === undefined
      || (typeof value.landingWorktreePath === "string"
        && value.landingWorktreePath.length > 0
        && value.landingWorktreePath.length <= 4096))
    && isValidQaVerification(value.qaVerification)
    && isValidDesignReview(value.designReview)
    && isValidMetaVerification(value.metaVerification)
    && isValidImageMapCheck(value.imageMapCheck)
    && isValidHarvest(value.harvest)
    && isValidMockupRenderReceipt(value.mockupRender);
}

function isValidStage(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return Number.isInteger(value.number)
    && Number(value.number) >= 1
    && Number(value.number) <= 9
    && typeof value.title === "string"
    && typeof value.ownerSlug === "string"
    && typeof value.status === "string"
    && STAGE_STATUSES.has(value.status)
    && typeof value.output === "string"
    && isOptionalStringArray(value, "feedbackHistory")
    && Array.isArray(value.subTasks)
    && value.subTasks.every(isValidSubTask)
    && isOptionalString(value, "startedAt")
    && isOptionalString(value, "completedAt")
    && isOptionalString(value, "errorMessage")
    && isOptionalString(value, "currentSubTaskId");
}

function isValidExecutionAttempt(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return typeof value.attemptId === "string"
    && typeof value.ownerId === "string"
    && (value.state === "running" || value.state === "error")
    && (value.retrySafety === "safe" || value.retrySafety === "review-required")
    && typeof value.startedAt === "number"
    && typeof value.heartbeatAt === "number"
    && typeof value.leaseExpiresAt === "number"
    && typeof value.deadlineAt === "number"
    && (value.endedAt === undefined || typeof value.endedAt === "number")
    && isOptionalString(value, "failureReason")
    && isOptionalString(value, "errorMessage");
}

function isCanonicalExecutionKey(key: string, expectedRunId: string): boolean {
  const parts = key.split(":");
  try {
    if (parts[0] === "run" && parts.length === 2) {
      const runId = decodeURIComponent(parts[1]);
      return runId === expectedRunId && encodeURIComponent(runId) === parts[1];
    }
    if (parts[0] !== "subtask" || parts.length !== 4) return false;
    const runId = decodeURIComponent(parts[1]);
    const stageNumber = Number(parts[2]);
    const subTaskId = decodeURIComponent(parts[3]);
    return runId === expectedRunId
      && encodeURIComponent(runId) === parts[1]
      && Number.isInteger(stageNumber)
      && stageNumber >= 1
      && stageNumber <= 9
      && String(stageNumber) === parts[2]
      && subTaskId.length > 0
      && encodeURIComponent(subTaskId) === parts[3];
  } catch {
    return false;
  }
}

function validatePersistedRun(value: unknown, expectedRunId: string): Run | null {
  if (!isRecord(value)) return null;
  const schemaVersion = value[STORAGE_SCHEMA_KEY];
  if (schemaVersion !== undefined && schemaVersion !== RUN_STATE_SCHEMA_VERSION) return null;
  if (value.id !== expectedRunId || typeof value.slug !== "string" || typeof value.brief !== "string") return null;
  if (typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))) return null;
  if (typeof value.status !== "string" || !RUN_STATUSES.has(value.status as RunStatus)) return null;
  if (!(value.currentRound === null || value.currentRound === 1 || value.currentRound === 2 || value.currentRound === 3 || value.currentRound === "synthesis")) return null;
  if (!Array.isArray(value.messages) || !value.messages.every(isValidMessage)) return null;
  if (
    value.strategyRevisions !== undefined &&
    (!Array.isArray(value.strategyRevisions) ||
      !value.strategyRevisions.every(isValidStrategyRevision))
  ) return null;
  if (value.stages !== undefined && (!Array.isArray(value.stages) || !value.stages.every(isValidStage))) return null;
  if (value.currentStage !== undefined && value.currentStage !== null && (!Number.isInteger(value.currentStage) || Number(value.currentStage) < 1 || Number(value.currentStage) > 9)) return null;
  if (!isOptionalString(value, "strategyDoc") || !isOptionalString(value, "errorMessage")) return null;
  // The page-type folder is bound to the run at creation; a relative or
  // malformed value would make the loader depend on the process directory.
  if (
    value.pageTypesDir !== undefined
    && (typeof value.pageTypesDir !== "string"
      || value.pageTypesDir.includes("\0")
      || !path.isAbsolute(value.pageTypesDir))
  ) return null;
  if (value.pipeline !== undefined && !isPipeline(value.pipeline)) return null;
  if (value.executionAttempts !== undefined) {
    if (!isRecord(value.executionAttempts)) return null;
    if (!Object.entries(value.executionAttempts).every(
      ([key, attempt]) => isCanonicalExecutionKey(key, expectedRunId) && isValidExecutionAttempt(attempt),
    )) return null;
    if (Object.values(value.executionAttempts).filter(
      (attempt) => isRecord(attempt) && attempt.state === "running",
    ).length > 1) return null;
  }

  let clientProfile: Run["clientProfile"];
  if (value.clientProfile !== undefined) {
    try {
      clientProfile = validateClientProfile(value.clientProfile);
    } catch {
      return null;
    }
  }

  const run = { ...value };
  delete run[STORAGE_SCHEMA_KEY];
  if (clientProfile) run.clientProfile = clientProfile;
  if (Array.isArray(run.stages)) {
    run.stages = run.stages.map((stage) => {
      const record = stage as Record<string, unknown>;
      const subTasks = (record.subTasks as Array<Record<string, unknown>>).map((subTask) => ({
        ...subTask,
        feedbackHistory: subTask.feedbackHistory ?? [],
      }));
      return {
        ...record,
        feedbackHistory: record.feedbackHistory ?? [],
        subTasks,
      };
    });
  }
  return run as unknown as Run;
}

/** Write the full run state to `run.json` using an atomic, durable replacement. */
export async function saveRunState(dir: string, run: Run): Promise<void> {
  assertValidRunId(run.id);
  assertAllowedRunDirectory(dir, run.id);
  const candidate = JSON.stringify(
    { ...run, [STORAGE_SCHEMA_KEY]: RUN_STATE_SCHEMA_VERSION },
    null,
    2,
  );
  if (Buffer.byteLength(candidate, "utf8") > MAX_RUN_STATE_BYTES) {
    throw new RangeError("Run state exceeds its allowed size");
  }
  const normalized = validatePersistedRun(JSON.parse(candidate), run.id);
  if (!normalized) {
    throw new TypeError("Invalid run state");
  }
  const serialized = JSON.stringify(
    { ...normalized, [STORAGE_SCHEMA_KEY]: RUN_STATE_SCHEMA_VERSION },
    null,
    2,
  );
  if (Buffer.byteLength(serialized, "utf8") > MAX_RUN_STATE_BYTES) {
    throw new RangeError("Run state exceeds its allowed size");
  }
  await atomicWritePrivateFile(dir, "run.json", serialized);
}

/**
 * A run that was mid-flight when the process died is not live any more.
 * Running work is marked interrupted when it is first read after restart.
 */
const INTERRUPTED = "הריצה נקטעה (השרת הופעל מחדש). אפשר להריץ את השלב מחדש.";

function markInterrupted(run: Run): Run {
  const interruptedAt = Date.now();
  const hasLiveLease = Object.values(run.executionAttempts ?? {}).some(
    (attempt) => attempt.state === "running" && attempt.leaseExpiresAt > interruptedAt,
  );
  // Another local server process may legitimately own the run. Its durable
  // lease is stronger evidence than this process's empty in-memory registry.
  if (hasLiveLease) return run;
  const stages = run.stages?.map((stage) => {
    const subTasks = stage.subTasks.map((st) =>
      st.status === "running" ? { ...st, status: "error" as const, errorMessage: INTERRUPTED } : st
    );
    return stage.status === "running"
      ? { ...stage, status: "error" as const, errorMessage: INTERRUPTED, subTasks }
      : { ...stage, subTasks };
  });

  const messages = run.messages.map((m) =>
    m.status === "streaming" || m.status === "pending"
      ? { ...m, status: "error" as const, errorMessage: INTERRUPTED }
      : m
  );

  const wasMidFlight =
    run.status === "pending" || run.status === "discussing" || run.status === "synthesizing";

  const executionAttempts = run.executionAttempts
    ? Object.fromEntries(
        Object.entries(run.executionAttempts).map(([key, attempt]) => [
          key,
          attempt.state === "running"
            ? {
                ...attempt,
                state: "error" as const,
                endedAt: interruptedAt,
                failureReason: "process-restarted",
                errorMessage: INTERRUPTED,
              }
            : attempt,
        ]),
      )
    : undefined;

  return {
    ...run,
    messages,
    ...(stages ? { stages } : {}),
    ...(executionAttempts ? { executionAttempts } : {}),
    ...(wasMidFlight ? { status: "error" as const, errorMessage: run.errorMessage ?? INTERRUPTED } : {}),
  };
}

/** Read a run's saved state, or null when it is missing, unsafe, or invalid. */
export async function loadRunState(
  runId: string,
  options: { markInterrupted?: boolean } = {},
): Promise<Run | null> {
  assertValidRunId(runId);
  try {
    const dir = await resolveRunDirectoryForRead(runId);
    if (!dir) return null;
    const raw = await readBoundedRegularFile(path.join(dir, "run.json"), MAX_RUN_STATE_BYTES);
    const run = validatePersistedRun(JSON.parse(raw.toString("utf8")), runId);
    return run && options.markInterrupted !== false ? markInterrupted(run) : run;
  } catch {
    return null;
  }
}

async function safeRunIdsAtRoot(root: string): Promise<string[]> {
  let entries;
  try {
    if (await inspectDirectory(root) === "missing") return [];
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const ids: string[] = [];
  for (const entry of entries) {
    if (!RUN_ID_RE.test(entry.name) || entry.name === "." || entry.name === "..") continue;
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    try {
      if (await inspectDirectory(candidateRunDir(root, entry.name)) === "directory") ids.push(entry.name);
    } catch {
      // Ignore unsafe entries in the archive instead of following them.
    }
  }
  return ids;
}

/** Every safe run folder on disk, newest first. */
export async function listRunIds(): Promise<string[]> {
  const found = new Set<string>();
  for (const root of discoveryRoots()) {
    for (const id of await safeRunIdsAtRoot(root)) found.add(id);
  }
  return Array.from(found).sort().reverse();
}

export interface RunSummary {
  id: string;
  brief: string;
  createdAt: string;
  status: RunStatus;
  currentStage: StageNumber | null;
  stagesApproved: number;
  stagesTotal: number;
  /** false for runs written before run.json existed, readable without stage state. */
  hasState: boolean;
  /** Safe diagnostic for a present but unreadable or invalid run.json. */
  stateError?: string;
}

/** One line per run for the archive list. Falls back to brief.md for legacy runs. */
export async function readRunSummary(runId: string): Promise<RunSummary> {
  assertValidRunId(runId);
  const run = await loadRunState(runId);
  if (run) {
    const stages = run.stages ?? [];
    return {
      id: run.id,
      brief: run.brief,
      createdAt: run.createdAt,
      status: run.status,
      currentStage: run.currentStage ?? null,
      stagesApproved: stages.filter((s) => s.status === "approved").length,
      stagesTotal: stages.length,
      hasState: true,
    };
  }

  let brief = "";
  let createdAt = "";
  const dir = await resolveRunDirectoryForRead(runId).catch(() => null);
  let corruptState = false;
  if (dir) {
    try {
      const state = await fs.lstat(path.join(dir, "run.json"));
      corruptState = true;
      if (state.isSymbolicLink() || !state.isFile() || state.size > MAX_RUN_STATE_BYTES) {
        // The safe generic diagnostic below intentionally avoids echoing paths
        // or parser content from an untrusted state file.
      }
    } catch (error) {
      if (!isErrno(error, "ENOENT")) corruptState = true;
    }
    try {
      brief = (await readBoundedRegularFile(path.join(dir, "brief.md"), MAX_BRIEF_BYTES)).toString("utf8");
    } catch {
      brief = "(הבריף לא נשמר)";
    }
    try {
      createdAt = (await fs.stat(dir)).mtime.toISOString();
    } catch {
      createdAt = "";
    }
  } else {
    brief = "(הבריף לא נשמר)";
  }

  return {
    id: runId,
    brief: brief.trim(),
    createdAt,
    status: corruptState ? "error" : "approved",
    currentStage: null,
    stagesApproved: 0,
    stagesTotal: 0,
    hasState: corruptState,
    ...(corruptState
      ? { stateError: "run.json קיים אך פגום, לא נתמך או אינו קובץ בטוח" }
      : {}),
  };
}

/** True only for a regular, bounded run.json file. */
export async function hasSafeRunState(runId: string): Promise<boolean> {
  assertValidRunId(runId);
  const dir = await resolveRunDirectoryForRead(runId).catch(() => null);
  if (!dir) return false;
  try {
    const raw = await readBoundedRegularFile(path.join(dir, "run.json"), MAX_RUN_STATE_BYTES);
    return validatePersistedRun(JSON.parse(raw.toString("utf8")), runId) !== null;
  } catch {
    return false;
  }
}
