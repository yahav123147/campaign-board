import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  signalTrackedChildProcess,
  supervisedProcessTreeLaunch,
  trackChildProcess,
} from "./childProcessRegistry";
import { assertOnlyAllowedGitPaths } from "./pagePostflight";

export const LANDING_BASE_REF_ENV = "CAMPAIGN_COUNCIL_LANDING_BASE_REF";
export const LANDING_WORKTREE_DIRNAME = "landing-worktree";

interface GitResult {
  code: number;
  stdout: string;
  stdoutBytes: Buffer;
  stderr: string;
}

interface InternalGitOptions {
  signal?: AbortSignal;
  input?: Buffer | string;
  env?: Readonly<Record<string, string>>;
  outputLimit?: number;
  supervised?: boolean;
}

const GIT_OBJECT_ID_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const NO_FOLLOW = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;

export interface PreparedLandingWorktree {
  readonly baseRepository: string;
  readonly worktreePath: string;
  readonly branchName: string;
  readonly initialHead: string;
  readonly reused: boolean;
}

export interface LandingDelivery {
  readonly commitSha: string;
  readonly reused: boolean;
}

function validateBranchName(branchName: string): void {
  if (!/^campaign-council-[a-z0-9][a-z0-9-]{0,159}$/.test(branchName)) {
    throw new Error("Landing worktree branch name is not safe or portable");
  }
}

function configuredBaseRef(): string {
  const value = process.env[LANDING_BASE_REF_ENV]?.trim() || "main";
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(value) ||
    value.includes("..") ||
    value.includes("//") ||
    value.includes("@{")
  ) {
    throw new Error(`${LANDING_BASE_REF_ENV} is not a safe Git ref name`);
  }
  return value;
}

export function landingWorktreePath(runDir: string): string {
  return path.join(path.resolve(runDir), LANDING_WORKTREE_DIRNAME);
}

function runLandingGitCommand(
  repository: string,
  args: readonly string[],
  options: InternalGitOptions = {},
): Promise<GitResult> {
  const { signal } = options;
  if (signal?.aborted) return Promise.reject(new Error("Landing Git operation was aborted"));
  return new Promise((resolve, reject) => {
    const gitArgs = [
      "-c", "core.hooksPath=/dev/null",
      "-c", "core.fsmonitor=false",
      "-c", "commit.gpgSign=false",
      ...args,
    ];
    const launch = options.supervised
      ? supervisedProcessTreeLaunch("git", gitArgs)
      : { command: "git", args: gitArgs };
    const proc = spawn(launch.command, [...launch.args], {
      cwd: repository,
      stdio: options.supervised
        ? [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe", "ipc"]
        : [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      shell: false,
      detached: false,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        LANG: process.env.LANG,
        LC_ALL: process.env.LC_ALL,
        NODE_ENV: "production",
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
        GIT_ATTR_NOSYSTEM: "1",
        ...options.env,
      },
    });
    trackChildProcess(proc, "landing-git", { supervisedProcessTree: options.supervised === true });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    let closed = false;
    let forceKill: NodeJS.Timeout | undefined;
    let terminationError: Error | undefined;
    const outputLimit = options.outputLimit ?? 1024 * 1024;

    const killTree = (name: NodeJS.Signals) => {
      signalTrackedChildProcess(proc, name);
    };
    const finish = (error?: Error, result?: GitResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (closed && forceKill) clearTimeout(forceKill);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(result!);
    };
    const terminate = (error: Error) => {
      if (terminationError) return;
      terminationError = error;
      killTree("SIGTERM");
      forceKill = setTimeout(() => killTree("SIGKILL"), 2_000);
      forceKill.unref();
    };
    const timeout = setTimeout(
      () => terminate(new Error("Landing Git operation timed out after 60 seconds")),
      60_000,
    );
    timeout.unref();
    const onAbort = () => terminate(new Error("Landing Git operation was aborted"));
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();

    const capture = (target: "stdout" | "stderr", chunk: Buffer | string) => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const current = target === "stdout" ? stdout : stderr;
      if (current.length + value.length > outputLimit) {
        terminate(new Error(`Landing Git output exceeded the ${outputLimit} byte safety limit`));
        return;
      }
      if (target === "stdout") stdout = Buffer.concat([stdout, value]);
      else stderr = Buffer.concat([stderr, value]);
    };
    proc.stdout!.on("data", (chunk) => capture("stdout", chunk));
    proc.stderr!.on("data", (chunk) => capture("stderr", chunk));
    if (options.input !== undefined && proc.stdin) {
      proc.stdin.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code !== "EPIPE") terminate(error);
      });
      proc.stdin.end(options.input);
    }
    proc.on("error", (error) => finish(error));
    proc.on("close", (code) => {
      closed = true;
      if (forceKill) clearTimeout(forceKill);
      if (terminationError) return finish(terminationError);
      finish(undefined, {
        code: code ?? -1,
        stdout: stdout.toString("utf8"),
        stdoutBytes: stdout,
        stderr: stderr.toString("utf8"),
      });
    });
  });
}

export function runLandingGit(
  repository: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<GitResult> {
  return runLandingGitCommand(repository, args, { signal });
}

async function regularDirectoryRealpath(value: string, label: string): Promise<string> {
  const resolved = path.resolve(value);
  const stat = await fs.lstat(resolved).catch(() => undefined);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be an existing non-symlink directory: ${resolved}`);
  }
  return fs.realpath(resolved);
}

async function assertRepositoryRoot(repository: string, signal?: AbortSignal): Promise<void> {
  const result = await runLandingGit(repository, ["rev-parse", "--show-toplevel"], signal);
  if (result.code !== 0) throw new Error(`Landing workspace is not a Git repository: ${result.stderr.trim()}`);
  const reported = await fs.realpath(result.stdout.trim()).catch(() => "");
  if (reported !== repository) throw new Error("Landing workspace must point to the Git repository root");
}

async function gitCommonDirectory(repository: string, signal?: AbortSignal): Promise<string> {
  const result = await runLandingGit(
    repository,
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    signal,
  );
  if (result.code !== 0 || !result.stdout.trim()) {
    throw new Error("Could not identify the landing repository Git directory");
  }
  const reported = path.isAbsolute(result.stdout.trim())
    ? result.stdout.trim()
    : path.resolve(repository, result.stdout.trim());
  return fs.realpath(reported);
}

export async function assertSameGitRepository(
  baseRepository: string,
  worktreeRepository: string,
  signal?: AbortSignal,
): Promise<void> {
  const base = await regularDirectoryRealpath(baseRepository, "Landing workspace");
  const worktree = await regularDirectoryRealpath(worktreeRepository, "Landing worktree");
  await Promise.all([
    assertRepositoryRoot(base, signal),
    assertRepositoryRoot(worktree, signal),
  ]);
  const [baseCommon, worktreeCommon] = await Promise.all([
    gitCommonDirectory(base, signal),
    gitCommonDirectory(worktree, signal),
  ]);
  if (baseCommon !== worktreeCommon) {
    throw new Error("Existing landing worktree belongs to a different Git repository");
  }
}

/**
 * Create or recover this run's dedicated Git worktree without ever switching
 * the user's main landing-page checkout. Nothing is deleted automatically.
 */
export async function prepareLandingWorktree(options: {
  baseRepository: string;
  runDir: string;
  branchName: string;
  signal?: AbortSignal;
}): Promise<PreparedLandingWorktree> {
  validateBranchName(options.branchName);
  const baseRepository = await regularDirectoryRealpath(options.baseRepository, "Landing workspace");
  await assertRepositoryRoot(baseRepository, options.signal);

  const runDirectory = await regularDirectoryRealpath(options.runDir, "Run directory");
  const worktreePath = landingWorktreePath(runDirectory);
  const existing = await fs.lstat(worktreePath).catch(() => undefined);
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink()) {
      throw new Error(`Landing worktree path is not a safe directory: ${worktreePath}`);
    }
    const realWorktree = await fs.realpath(worktreePath);
    const relative = path.relative(runDirectory, realWorktree);
    if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
      throw new Error("Landing worktree escaped the run directory");
    }
    await assertRepositoryRoot(realWorktree, options.signal);
    await assertSameGitRepository(baseRepository, realWorktree, options.signal);
    const branch = await runLandingGit(realWorktree, ["branch", "--show-current"], options.signal);
    if (branch.code !== 0 || branch.stdout.trim() !== options.branchName) {
      throw new Error(
        `Existing run worktree is on ${branch.stdout.trim() || "detached HEAD"}, expected ${options.branchName}`,
      );
    }
    const head = await runLandingGit(realWorktree, ["rev-parse", "HEAD"], options.signal);
    if (head.code !== 0 || !head.stdout.trim()) throw new Error("Could not read landing worktree HEAD");
    await mirrorWorkspaceRuntimeFiles(baseRepository, realWorktree, options.signal);
    return {
      baseRepository,
      worktreePath: realWorktree,
      branchName: options.branchName,
      initialHead: head.stdout.trim(),
      reused: true,
    };
  }

  const branchExists = await runLandingGit(
    baseRepository,
    ["show-ref", "--verify", "--quiet", `refs/heads/${options.branchName}`],
    options.signal,
  );
  if (branchExists.code !== 0 && branchExists.code !== 1) {
    throw new Error(`Could not inspect landing branch: ${branchExists.stderr.trim()}`);
  }

  const addArgs = branchExists.code === 0
    ? ["worktree", "add", worktreePath, options.branchName]
    : ["worktree", "add", "-b", options.branchName, worktreePath, configuredBaseRef()];
  // `worktree add` performs a checkout and is the only operation here that can
  // legitimately start repository-configured filter descendants. Keep it
  // behind the trusted supervisor; pure plumbing/query commands use the
  // tracked direct child so hundreds of sealed blobs do not pay a grace delay.
  const added = await runLandingGitCommand(baseRepository, addArgs, {
    signal: options.signal,
    supervised: true,
  });
  if (added.code !== 0) {
    throw new Error(
      `Could not create the isolated landing worktree. No checkout was switched. ${added.stderr.trim()}`,
    );
  }

  const realWorktree = await regularDirectoryRealpath(worktreePath, "Landing worktree");
  await assertRepositoryRoot(realWorktree, options.signal);
  await assertSameGitRepository(baseRepository, realWorktree, options.signal);
  const head = await runLandingGit(realWorktree, ["rev-parse", "HEAD"], options.signal);
  if (head.code !== 0 || !head.stdout.trim()) throw new Error("Could not record landing worktree HEAD");
  await mirrorWorkspaceRuntimeFiles(baseRepository, realWorktree, options.signal);
  return {
    baseRepository,
    worktreePath: realWorktree,
    branchName: options.branchName,
    initialHead: head.stdout.trim(),
    reused: false,
  };
}

/**
 * A worktree checkout carries only tracked files. The workspace build also
 * relies on gitignored runtime files: `node_modules` and the `.env*` files that
 * its API routes read at module load. Without them `next build` fails while
 * collecting page data for routes the campaign page never touches (found on
 * the 30.08.2026 end-to-end run: sharp, then "supabaseUrl is required"). Mirror
 * exactly those files, and only when git confirms they are ignored, so the
 * branch delivery stays clean.
 */
export async function mirrorWorkspaceRuntimeFiles(
  baseRepository: string,
  worktreePath: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const mirrored: string[] = [];
  const baseNodeModules = path.join(baseRepository, "node_modules");
  const worktreeNodeModules = path.join(worktreePath, "node_modules");
  const baseStat = await fs.stat(baseNodeModules).catch(() => undefined);
  const existing = await fs.lstat(worktreeNodeModules).catch(() => undefined);
  if (baseStat?.isDirectory() && !existing) {
    const ignored = await runLandingGit(baseRepository, ["check-ignore", "-q", "node_modules"], signal);
    if (ignored.code === 0) {
      await fs.symlink(await fs.realpath(baseNodeModules), worktreeNodeModules, "dir");
      // The base ignores its node_modules *directory*; the worktree holds a
      // symlink, and a directory-only pattern ("node_modules/") does not
      // match a symlink. Git in the worktree is the judge: an unignored link
      // would surface later as "unrelated uncommitted changes" at the stage 5
      // preflight (seen on the WSL2 acceptance run with the shipped template),
      // so fail here, with the cause, and leave nothing behind.
      const linkIgnored = await runLandingGit(worktreePath, ["check-ignore", "-q", "node_modules"], signal);
      if (linkIgnored.code !== 0) {
        await fs.unlink(worktreeNodeModules).catch(() => {});
        // Exit 1 is git's answer "not ignored"; anything else means git could
        // not answer at all (not a repository, a locked index, an unreadable
        // config), and sending the operator to fix a trailing slash that is
        // not there would waste the diagnosis.
        if (linkIgnored.code !== 1) {
          throw new Error(
            `git check-ignore failed in the run worktree (exit ${linkIgnored.code}): `
            + `${linkIgnored.stderr.trim() || "no error output"}. Whether node_modules is ignored there is unknown.`,
          );
        }
        // Quote the pattern that is actually present, instead of asserting
        // which mistake it is.
        const patterns = (await fs.readFile(path.join(worktreePath, ".gitignore"), "utf8").catch(() => ""))
          .split("\n").map((line) => line.trim())
          .filter((line) => line && !line.startsWith("#") && line.includes("node_modules"));
        throw new Error(
          "The run worktree's .gitignore does not ignore the node_modules symlink this run creates. "
          + (patterns.length
            ? `It currently has ${patterns.map((pattern) => `\`${pattern}\``).join(", ")}; a directory-only pattern (a trailing slash) does not match a symlink.`
            : "It has no node_modules pattern at all.")
          + " The pattern must be `node_modules`, without a trailing slash.",
        );
      }
      mirrored.push("node_modules");
    }
  }
  const entries = await fs.readdir(baseRepository, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !/^\.env(\..+)?$/.test(entry.name)) continue;
    const target = path.join(worktreePath, entry.name);
    if (await fs.lstat(target).catch(() => undefined)) continue;
    const ignored = await runLandingGit(baseRepository, ["check-ignore", "-q", entry.name], signal);
    if (ignored.code !== 0) continue;
    await fs.copyFile(path.join(baseRepository, entry.name), target);
    await fs.chmod(target, 0o600);
    mirrored.push(entry.name);
  }
  return mirrored;
}

function nulSeparatedPaths(stdout: string): string[] {
  return stdout.split("\0").filter(Boolean);
}

async function changedPathsForDelivery(
  workspacePath: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const results = await Promise.all([
    runLandingGit(workspacePath, ["diff", "--name-only", "-z"], signal),
    runLandingGit(workspacePath, ["diff", "--cached", "--name-only", "-z"], signal),
    runLandingGit(workspacePath, ["ls-files", "--others", "--exclude-standard", "-z"], signal),
  ]);
  const failed = results.find((result) => result.code !== 0);
  if (failed) {
    throw new Error(`Could not inspect landing delivery: ${failed.stderr.trim()}`);
  }
  return [...new Set(results.flatMap((result) => nulSeparatedPaths(result.stdout)))].sort();
}

function expectedDeliveryEntries(
  expectedFiles: Readonly<Record<string, string>>,
  allowedPaths: readonly string[],
): Array<readonly [string, string]> {
  const entries = Object.entries(expectedFiles).sort(([left], [right]) => left.localeCompare(right, "en"));
  if (
    entries.length === 0
    || entries.length > 768
    || entries.some(([file, hash]) => !SHA256_RE.test(hash) || file.includes("\\"))
  ) {
    throw new Error("Landing delivery file manifest is empty or invalid");
  }
  const normalized = assertOnlyAllowedGitPaths(entries.map(([file]) => file), allowedPaths);
  if (normalized.some((file, index) => file !== entries[index][0])) {
    throw new Error("Landing delivery file manifest contains a non-canonical path");
  }
  return entries;
}

async function readExactRegularFile(filePath: string, maxBytes = 32 * 1024 * 1024): Promise<Buffer> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(filePath, fsConstants.O_RDONLY | NO_FOLLOW | (fsConstants.O_NONBLOCK ?? 0));
    const before = await handle.stat();
    if (!before.isFile() || before.size > maxBytes) throw new Error("not a bounded regular file");
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const chunkLength = Math.min(64 * 1024, bytes.length - offset);
      const result = await handle.read(bytes, offset, chunkLength, null);
      if (result.bytesRead === 0) throw new Error("file changed while being read");
      offset += result.bytesRead;
    }
    const probe = Buffer.alloc(1);
    const extra = await handle.read(probe, 0, 1, null);
    const after = await handle.stat();
    if (
      extra.bytesRead !== 0
      || after.size !== before.size
      || after.dev !== before.dev
      || after.ino !== before.ino
    ) {
      throw new Error("file changed while being read");
    }
    return bytes;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function listWorktreeFiles(root: string, relativeRoot: string): Promise<string[]> {
  const absoluteRoot = path.join(root, ...relativeRoot.split("/"));
  const rootStat = await fs.lstat(absoluteRoot).catch(() => undefined);
  if (!rootStat) return [];
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`Landing delivery root is not a regular directory: ${relativeRoot}`);
  }
  const files: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const stat = await fs.lstat(absolute);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (stat.isDirectory() && !stat.isSymbolicLink()) await walk(absolute);
      else if (stat.isFile() && !stat.isSymbolicLink()) files.push(relative);
      else throw new Error(`Landing delivery contains a non-regular entry: ${relative}`);
    }
  };
  await walk(absoluteRoot);
  return files;
}

async function snapshotExpectedWorktree(
  workspacePath: string,
  allowedRoots: readonly string[],
  entries: ReadonlyArray<readonly [string, string]>,
): Promise<Map<string, Buffer>> {
  const actualPaths = (
    await Promise.all(allowedRoots.map((root) => listWorktreeFiles(workspacePath, root)))
  ).flat().sort((left, right) => left.localeCompare(right, "en"));
  const expectedPaths = entries.map(([file]) => file);
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    throw new Error("Landing worktree files differ from the sealed delivery manifest");
  }

  const snapshots = new Map<string, Buffer>();
  let totalBytes = 0;
  for (const [file, expectedHash] of entries) {
    const absolute = path.join(workspacePath, ...file.split("/"));
    const bytes = await readExactRegularFile(absolute);
    totalBytes += bytes.length;
    if (totalBytes > 100 * 1024 * 1024) throw new Error("Landing delivery exceeds the 100MB limit");
    const actualHash = createHash("sha256").update(bytes).digest("hex");
    if (actualHash !== expectedHash) throw new Error(`Landing delivery seal mismatch: ${file}`);
    snapshots.set(file, bytes);
  }
  return snapshots;
}

interface GitTreeEntry {
  mode: string;
  type: string;
  objectId: string;
  path: string;
}

function parseGitTreeEntries(stdout: string): GitTreeEntry[] {
  return nulSeparatedPaths(stdout).map((record) => {
    const tab = record.indexOf("\t");
    const metadata = tab === -1 ? [] : record.slice(0, tab).split(" ");
    const file = tab === -1 ? "" : record.slice(tab + 1);
    if (metadata.length !== 3 || !file || !GIT_OBJECT_ID_RE.test(metadata[2])) {
      throw new Error("Landing Git tree returned an invalid entry");
    }
    return { mode: metadata[0], type: metadata[1], objectId: metadata[2], path: file };
  });
}

async function verifyDeliveryCommit(options: {
  workspacePath: string;
  initialHead: string;
  commitSha: string;
  allowedPaths: readonly string[];
  allowedRoots: readonly string[];
  expectedEntries: ReadonlyArray<readonly [string, string]>;
  runId: string;
  signal?: AbortSignal;
}): Promise<void> {
  const parents = await runLandingGit(
    options.workspacePath,
    ["rev-list", "--parents", "-n", "1", options.commitSha],
    options.signal,
  );
  const parentParts = parents.stdout.trim().split(/\s+/);
  if (
    parents.code !== 0
    || parentParts.length !== 2
    || parentParts[0] !== options.commitSha
    || parentParts[1] !== options.initialHead
  ) {
    throw new Error("Landing delivery commit is not the expected direct child");
  }
  const message = await runLandingGit(
    options.workspacePath,
    ["log", "-1", "--format=%B", options.commitSha],
    options.signal,
  );
  if (
    message.code !== 0
    || !message.stdout.split(/\r?\n/).includes(`Campaign-Council-Run: ${options.runId}`)
  ) {
    throw new Error("Existing landing commit was not created for this run");
  }
  const changed = await runLandingGit(
    options.workspacePath,
    ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", options.initialHead, options.commitSha, "--"],
    options.signal,
  );
  if (changed.code !== 0) throw new Error("Could not inspect landing delivery commit scope");
  const changedPaths = nulSeparatedPaths(changed.stdout);
  if (changedPaths.length === 0) throw new Error("Landing delivery commit is empty");
  assertOnlyAllowedGitPaths(changedPaths, options.allowedPaths);

  const tree = await runLandingGit(
    options.workspacePath,
    ["ls-tree", "-r", "--full-tree", "-z", options.commitSha, "--", ...options.allowedRoots],
    options.signal,
  );
  if (tree.code !== 0) throw new Error("Could not inspect landing delivery tree");
  const treeEntries = parseGitTreeEntries(tree.stdout)
    .sort((left, right) => left.path.localeCompare(right.path, "en"));
  const expectedPaths = options.expectedEntries.map(([file]) => file);
  if (JSON.stringify(treeEntries.map((entry) => entry.path)) !== JSON.stringify(expectedPaths)) {
    throw new Error("Landing delivery commit tree differs from the sealed file list");
  }

  for (let index = 0; index < treeEntries.length; index++) {
    const entry = treeEntries[index];
    const [file, expectedHash] = options.expectedEntries[index];
    if (entry.path !== file || entry.mode !== "100644" || entry.type !== "blob") {
      throw new Error(`Landing delivery commit contains an unsafe entry: ${entry.path}`);
    }
    const blob = await runLandingGitCommand(
      options.workspacePath,
      ["cat-file", "blob", entry.objectId],
      { signal: options.signal, outputLimit: 32 * 1024 * 1024 },
    );
    if (blob.code !== 0 || createHash("sha256").update(blob.stdoutBytes).digest("hex") !== expectedHash) {
      throw new Error(`Landing delivery commit blob differs from its seal: ${file}`);
    }
  }
}

async function createSealedCommit(options: {
  workspacePath: string;
  initialHead: string;
  branchName: string;
  allowedRoots: readonly string[];
  snapshots: ReadonlyMap<string, Buffer>;
  runId: string;
  signal?: AbortSignal;
}): Promise<string> {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "campaign-council-git-index-"));
  await fs.chmod(temporary, 0o700);
  const indexFile = path.join(temporary, "index");
  const privateOptions = { signal: options.signal, env: { GIT_INDEX_FILE: indexFile } } as const;
  try {
    const readTree = await runLandingGitCommand(
      options.workspacePath,
      ["read-tree", options.initialHead],
      privateOptions,
    );
    if (readTree.code !== 0) throw new Error(`Could not initialize private delivery index: ${readTree.stderr.trim()}`);
    const removed = await runLandingGitCommand(
      options.workspacePath,
      ["rm", "-r", "--cached", "-f", "--ignore-unmatch", "--", ...options.allowedRoots],
      privateOptions,
    );
    if (removed.code !== 0) throw new Error(`Could not clear prior landing paths: ${removed.stderr.trim()}`);

    for (const [file, bytes] of options.snapshots) {
      const blob = await runLandingGitCommand(
        options.workspacePath,
        ["hash-object", "-w", "--no-filters", "--stdin"],
        { ...privateOptions, input: bytes },
      );
      const objectId = blob.stdout.trim();
      if (blob.code !== 0 || !GIT_OBJECT_ID_RE.test(objectId)) {
        throw new Error(`Could not store sealed landing blob: ${file}`);
      }
      const indexed = await runLandingGitCommand(
        options.workspacePath,
        ["update-index", "--add", "--cacheinfo", `100644,${objectId},${file}`],
        privateOptions,
      );
      if (indexed.code !== 0) throw new Error(`Could not index sealed landing file: ${file}`);
    }

    const written = await runLandingGitCommand(options.workspacePath, ["write-tree"], privateOptions);
    const treeId = written.stdout.trim();
    if (written.code !== 0 || !GIT_OBJECT_ID_RE.test(treeId)) {
      throw new Error("Could not write sealed landing tree");
    }
    const initialTree = await runLandingGit(
      options.workspacePath,
      ["rev-parse", `${options.initialHead}^{tree}`],
      options.signal,
    );
    if (initialTree.code !== 0 || !GIT_OBJECT_ID_RE.test(initialTree.stdout.trim())) {
      throw new Error("Could not inspect the initial landing tree");
    }
    if (initialTree.stdout.trim() === treeId) {
      throw new Error("Landing delivery has no sealed tree changes to commit");
    }
    const message = `Campaign Council: deliver ${options.runId}\n\nCampaign-Council-Run: ${options.runId}\n`;
    const commit = await runLandingGitCommand(
      options.workspacePath,
      ["commit-tree", treeId, "-p", options.initialHead],
      {
        signal: options.signal,
        input: message,
        env: {
          GIT_AUTHOR_NAME: "Campaign Council",
          GIT_AUTHOR_EMAIL: "campaign-council@localhost",
          GIT_COMMITTER_NAME: "Campaign Council",
          GIT_COMMITTER_EMAIL: "campaign-council@localhost",
        },
      },
    );
    const commitSha = commit.stdout.trim();
    if (commit.code !== 0 || !GIT_OBJECT_ID_RE.test(commitSha)) {
      throw new Error(`Could not create sealed landing commit: ${commit.stderr.trim()}`);
    }
    const installed = await runLandingGit(
      options.workspacePath,
      ["update-ref", `refs/heads/${options.branchName}`, commitSha, options.initialHead],
      options.signal,
    );
    if (installed.code !== 0) {
      throw new Error("Landing branch changed concurrently before sealed delivery");
    }
    return commitSha;
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

/**
 * Commit exactly the reviewed route and approved assets. A private index keeps
 * unrelated staging and ignore rules out of the commit; raw Git blobs keep
 * clean filters/LFS from changing reviewed bytes; update-ref provides the CAS.
 */
export async function commitLandingDelivery(options: {
  workspacePath: string;
  branchName: string;
  initialHead: string;
  allowedPaths: readonly string[];
  expectedFiles: Readonly<Record<string, string>>;
  runId: string;
  signal?: AbortSignal;
}): Promise<LandingDelivery> {
  validateBranchName(options.branchName);
  if (
    options.branchName !== `campaign-council-${options.runId}`
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(options.runId)
    || !GIT_OBJECT_ID_RE.test(options.initialHead)
  ) {
    throw new Error("Landing delivery identity is invalid");
  }
  assertOnlyAllowedGitPaths([], options.allowedPaths);
  const allowedRoots = options.allowedPaths.map((value) => value.replace(/\/$/, ""));
  const expectedEntries = expectedDeliveryEntries(options.expectedFiles, options.allowedPaths);
  const workspacePath = await regularDirectoryRealpath(options.workspacePath, "Landing worktree");
  await assertRepositoryRoot(workspacePath, options.signal);

  const branch = await runLandingGit(workspacePath, ["branch", "--show-current"], options.signal);
  if (branch.code !== 0 || branch.stdout.trim() !== options.branchName) {
    throw new Error("Landing delivery branch does not match the sealed run");
  }
  const headResult = await runLandingGit(workspacePath, ["rev-parse", "HEAD"], options.signal);
  if (headResult.code !== 0) throw new Error("Could not read landing delivery HEAD");
  const currentHead = headResult.stdout.trim();

  const changedBefore = await changedPathsForDelivery(workspacePath, options.signal);
  assertOnlyAllowedGitPaths(changedBefore, options.allowedPaths);
  const snapshots = await snapshotExpectedWorktree(workspacePath, allowedRoots, expectedEntries);

  if (currentHead !== options.initialHead) {
    await verifyDeliveryCommit({
      workspacePath,
      initialHead: options.initialHead,
      commitSha: currentHead,
      allowedPaths: options.allowedPaths,
      allowedRoots,
      expectedEntries,
      runId: options.runId,
      signal: options.signal,
    });
    const synchronized = await runLandingGit(workspacePath, ["read-tree", "--reset", currentHead], options.signal);
    if (synchronized.code !== 0) throw new Error("Could not synchronize the recovered landing index");
    await snapshotExpectedWorktree(workspacePath, allowedRoots, expectedEntries);
    return { commitSha: currentHead, reused: true };
  }

  const commitSha = await createSealedCommit({
    workspacePath,
    initialHead: options.initialHead,
    branchName: options.branchName,
    allowedRoots,
    snapshots,
    runId: options.runId,
    signal: options.signal,
  });
  await verifyDeliveryCommit({
    workspacePath,
    initialHead: options.initialHead,
    commitSha,
    allowedPaths: options.allowedPaths,
    allowedRoots,
    expectedEntries,
    runId: options.runId,
    signal: options.signal,
  });
  const headAfter = await runLandingGit(workspacePath, ["rev-parse", "HEAD"], options.signal);
  if (headAfter.code !== 0 || headAfter.stdout.trim() !== commitSha) {
    throw new Error("Landing branch changed after sealed delivery");
  }
  const synchronized = await runLandingGit(workspacePath, ["read-tree", "--reset", commitSha], options.signal);
  if (synchronized.code !== 0) throw new Error("Could not synchronize the landing worktree index");
  await snapshotExpectedWorktree(workspacePath, allowedRoots, expectedEntries);
  const changedAfter = await changedPathsForDelivery(workspacePath, options.signal);
  assertOnlyAllowedGitPaths(changedAfter, options.allowedPaths);
  return { commitSha, reused: false };
}
