#!/usr/bin/env node

import crypto from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createGzip, constants as zlibConstants } from "node:zlib";

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(scriptPath);
const defaultRoot = path.resolve(scriptDir, "..");
const gitExecutable = process.platform === "win32" ? "git" : "/usr/bin/git";
const tarExecutable = process.platform === "win32" ? "tar" : "/usr/bin/tar";

const ARCHIVE_PREFIX = "campaign-council/";
const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;
const REQUIRED_ARCHIVE_FILES = Object.freeze([
  "README.md",
  "package.json",
  "package-lock.json",
  ".env.example",
  "config/client-profile.example.json",
  "config/standards/copy-standard.default.md",
  "config/standards/ads-standard.default.md",
  "config/standards/creative-standard.default.md",
  "config/standards/critics/copy-critic.default.md",
  "config/standards/critics/design-brief-critic.default.md",
  "config/standards/critics/design-strategy-standard.default.md",
  "config/standards/page-types/premium-lead-page.default.md",
  "config/standards/page-types/webinar-page.default.md",
  "config/standards/page-types/squeeze-page.default.md",
  "config/standards/page-types/upsell-page.default.md",
  "setup.sh",
  "scripts/configure-client.mjs",
  "scripts/linux-process-sandbox.py",
  "templates/landing/.gitignore",
  "templates/landing/next.config.ts",
  "templates/landing/package-lock.json",
  "templates/landing/package.json",
  "templates/landing/postcss.config.mjs",
  "templates/landing/public/robots.txt",
  "templates/landing/src/app/globals.css",
  "templates/landing/src/app/layout.tsx",
  "templates/landing/src/app/page.tsx",
  "templates/landing/tsconfig.json",
  "scripts/compose-ad.py",
  "scripts/openai-image.mjs",
  "scripts/sanitize-photo.py",
  "assets/fonts/Heebo.ttf",
  "vendor/landing-skill/SKILL.md",
  "vendor/landing-skill/INSTALL.md",
  "vendor/landing-skill/scripts/landing-qa.mjs",
  "vendor/landing-skill/scripts/orphanLines.mjs",
  "vendor/landing-skill/scripts/visibleBox.mjs",
  "vendor/landing-skill/scripts/harvest_brand.py",
  "vendor/landing-skill/scripts/ig_shot.mjs",
  "vendor/landing-skill/scripts/igOverlay.mjs",
  "vendor/course-mockups/render_screens.mjs",
  "vendor/course-mockups/renderPolicy.mjs",
  "vendor/course-mockups/detect_screens.py",
  "vendor/course-mockups/composite.py",
  "config/standards/mockups/base-devices.default.png",
  "config/standards/mockups/base-chapter.default.png",
  "config/clientProfile.ts",
  "app/page.tsx",
  "orchestrator/stageRegistry.ts",
  "scripts/doctor.mjs",
  "scripts/cutout.py",
  "scripts/check-visible-images.mjs",
  "scripts/measure-text-deserts.mjs",
  // Stage 5.3 spawns both of these by absolute path at run time: shoot.mjs
  // captures the page for the design critics, slice-shot.py cuts each capture
  // into strips they can actually read.
  "scripts/shoot.mjs",
  "scripts/slice-shot.py",
  "requirements-image-core.txt",
  "next.config.ts",
  "tsconfig.json",
]);
const SAFE_VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/;
const SECRET_FILE_EXTENSIONS = new Set([".key", ".p12", ".pem", ".pfx"]);
const SECRET_FILE_NAMES = new Set([
  ".netrc",
  ".npmrc",
  ".pnpmrc",
  ".pypirc",
  ".yarnrc",
  ".yarnrc.yml",
  "credentials.json",
  "id_ed25519",
  "id_rsa",
]);
const CLIENT_TEXT_EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".example",
  ".html",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".mts",
  ".cts",
  ".py",
  ".sh",
  ".svg",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
]);
const MAX_CLIENT_TEXT_BYTES = 8 * 1024 * 1024;
// קבצים שאינם טקסט חייבים להיות סוג בינארי מוכר; כל סיומת אחרת מפילה את
// האריזה במקום לדלג על סריקת הפרטיות בשקט (F101).
const CLIENT_BINARY_EXTENSIONS = new Set([".ttf", ".ico", ".png", ".woff", ".woff2"]);

function privatePattern(label, pieces, flags = "iu") {
  return Object.freeze({ label, expression: new RegExp(pieces.join(""), flags) });
}

export const CLIENT_PRIVATE_CONTENT_PATTERNS = Object.freeze([
  privatePattern("legacy brand name in Hebrew", ["נקסט", "\\s+", "לבל"], "u"),
  privatePattern("legacy brand name in English", ["(?:the", "\\s+)?", "next", "[ -]", "level"]),
  privatePattern("developer home path", ["/", "Users", "/"], "u"),
  privatePattern("developer landing workspace shorthand", ["~", "/landing", "-pages"], "u"),
  privatePattern("legacy currency-specific rule", ["\\u20aa"], "u"),
  privatePattern("legacy payment claim", ["18", "\\s+", "תשלומים"], "u"),
  privatePattern("legacy revenue claim", ["150", "\\s*", "M"]),
  privatePattern("legacy personalized product phrase", ["Claude", "\\s+Code\\s+", "שלך"]),
  privatePattern("legacy exposure phrase", ["חשוף", "\\s+", "לכל"], "u"),
  privatePattern("legacy tool-context phrase", ["memory", "\\s*,\\s*", "MCPs"]),
  privatePattern("developer desktop shorthand", ["~", "/Desktop", "/projects"], "u"),
  privatePattern("legacy competitor references", [
    "Hor", "mozi|Brun", "son|myadvisor", "lab|Toby", "\\s+Mathis|זוהר", "\\s+אדלר",
  ]),
]);

// Names of people, reference clients and private products, and account
// identifiers, are matched by the SHA-256 of normalized words. This file ships
// to clients, so it never spells them out, not even in pieces. To add a term:
//   node -e 'console.log(require("crypto").createHash("sha256").update(process.argv[1].normalize("NFC").toLowerCase()).digest("hex"))' "<term>"
// A two-word term is hashed with one space between the words.
const PRIVATE_TERM_HASHES = new Map([
  // private owner name
  ["86787fbe38a3e1b582a6ddd3992ca2039f5fbff129c8b3d189e0c042801497e0", "private owner name"],
  ["ba978cf0887bf2be4ae46ee0e95fd48071983d9739732656b6ae68aae2e357a0", "private owner name"],
  ["0e524140aa5d36bfe0f6da8f80f004a2ff643e6fb5921746f82b118ff8a617bf", "private owner name"],
  ["afb7b743bac663a4eba76cee6b0d1f47960cf2a29fa8f489ae196edfa314eb0b", "private owner name"],
  ["22017ce6abd53271acd9af4f660a9f144aa9d771806e2ef4d49343b5fefb772d", "private owner name"],
  ["311e7dda35439777c0e88f2e9e9553c362ff22887ad707ede0bf2e95771b5791", "private owner name"],
  // private team member name
  ["4ea7ea4917057a1fcbb3bffdb673602d9b961ff14b239cc7a8d96933b8a18b51", "private team member name"],
  ["db79be7e808fc9dc3752620673bdbfb02fd60145924447dcb5c4781e9b808fef", "private team member name"],
  ["37b17fd6194c8b24e3b3d50723c19752dcbb7b12e227f19be825d09484b40c85", "private team member name"],
  ["cd879f74c6ffe6e4ae973145798ca26489fa2a61f7b29ac5fd816c0ad959511f", "private team member name"],
  ["5c073e066704cdeafb74dcfdafe5884401ded75ee50a19d8c6868584e00be856", "private team member name"],
  ["2cb5ec820cbc3127a38f7d7bf930ca3183833977098c45fe4aae5113046926db", "private team member name"],
  ["66ca2a82dab2bac92a02285de245a8b3442bc9acdd18768fce866656521a385d", "private team member name"],
  ["7775b9ae29f457629be5468558eb9dd29dc204be6da973fb82e9c5687bb711a9", "private team member name"],
  ["f85ada9aac48190f78c86cffac3b6be22bda126dee4bd0feac0ab80f9bdbab43", "private team member name"],
  ["34ba4804bb86c2fe6946151f8f3e02f24fe6dc08fdde7f0924e89628a79f709b", "private team member name"],
  ["9e61db19e1b8733589ba36f9902a6b2f6c9f804c0c2ad97a73b1858d350a68ad", "private team member name"],
  // private client name
  ["cc967443070ab409a57a455dc8c2405a10b6ba96ca75f87bcf18ca368bb090a8", "private client name"],
  ["4eb7ee85015b4723713c63edacb8601eac1ab82ce935a4cc19d4a9b9349d1f46", "private client name"],
  ["04e3dadc8c55119c4bf0486032c6e28614acf00e3b2117ccadf9ef1b540a49dc", "private client name"],
  ["179c745f85c7799d6d7522d38d15bd4b42afea05beb172fcca1b1ada11158cce", "private client name"],
  ["7a7d480bab34d1dbe959f6c8d3639af5a2368bc47a4873fc518dbbfca62067af", "private client name"],
  // private product name
  ["5ff2ee9a8ad1d95dac24c39a63962285affc9c9c28666c092bcd7752b9874272", "private product name"],
  ["20b45f6a7a08b6f2c4b1dcfe4d74d4f77725c9492f47b6cd5d861f6c2d456c0d", "private product name"],
  // private account identifier
  ["ba64f346bbed4c51deb4ba97f8de5c91b04a26cb4947222defedd227be3b1699", "private account identifier"],
  ["3478ff69dd3beb39519476b1e3ffed45df20fe8097a901d55d4cd790d3365c92", "private account identifier"],
  ["8b678276032fd8d431634038a821b6e21b49441aea800a72e6d66fc9c24993e1", "private account identifier"],
  ["a5c0b1632ea836a20482d46e330b1539a43c73f8bceb56530110985742f2258d", "private account identifier"],
  ["0ff9f1398b175ea505dde2b14b7c5e8b67f6a02db6839e021b719941bfd672fc", "private account identifier"],
  ["857c50bceab0e6a7b2ebadc89acb42ea8581475992394afa156cf8d13f728373", "private account identifier"],
  ["f9569eecb2fd30d06f507ed7672edf053a6e28b971f88fe8f56783ff50537764", "private account identifier"],
  ["88ead9b9af0fdd896b3438836f3d8cdf2f590a1d54cef1f93085ae39515b7d3d", "private account identifier"],
  ["69e1a1b4bca07c2904d83cc81932a4ca54c09c888b02cd7e3c89ee22fdfb799d", "private account identifier"],
  ["47d5695ef0902f24b9c37a494d60102f7905653fe54d552d9a49a8505c31ef20", "private account identifier"],
  ["f9f29b2beffd1fca73948575ff97536c7443de427ca5e05f2bb7de8708407646", "private account identifier"],
]);

const HEBREW_PREFIX_LETTERS = new Set(["ו", "ה", "ב", "כ", "ל", "מ", "ש"]);
const HEBREW_WORD_RE = /^\p{Script=Hebrew}+$/u;

export function privateTermViolation(source, termHashes = PRIVATE_TERM_HASHES) {
  const words = source.normalize("NFC").toLowerCase().match(/\p{L}+|\p{N}+/gu) ?? [];
  const hashes = new Map();
  const labelFor = (term) => {
    let hash = hashes.get(term);
    if (hash === undefined) {
      hash = crypto.createHash("sha256").update(term).digest("hex");
      hashes.set(term, hash);
    }
    return termHashes.get(hash);
  };
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    const candidates = [word];
    if (word.length > 3 && HEBREW_PREFIX_LETTERS.has(word[0]) && HEBREW_WORD_RE.test(word)) {
      candidates.push(word.slice(1));
    }
    if (index + 1 < words.length) candidates.push(`${word} ${words[index + 1]}`);
    for (const candidate of candidates) {
      const label = labelFor(candidate);
      if (label) return label;
    }
  }
  return undefined;
}

export function clientContentViolation(source) {
  for (const pattern of CLIENT_PRIVATE_CONTENT_PATTERNS) {
    if (pattern.expression.test(source)) return pattern.label;
  }
  return privateTermViolation(source);
}

function safePackageVersion(value) {
  if (typeof value !== "string" || !SAFE_VERSION_RE.test(value) || value === "." || value === "..") {
    throw new Error("package.json version is not safe for a client archive filename.");
  }
  return value;
}

function relativeArchivePath(entry) {
  if (entry === ARCHIVE_PREFIX) return "";
  if (!entry.startsWith(ARCHIVE_PREFIX)) return null;
  return entry.slice(ARCHIVE_PREFIX.length).replace(/\/$/, "");
}

/**
 * Return a fail-closed reason for an unsafe archive entry. Root-only checks are
 * deliberate: app/api/runs is application source, while root runs/ is private
 * execution data.
 */
export function archiveEntryViolation(entry) {
  const relative = relativeArchivePath(entry);
  if (relative === null) return "entry is outside the archive root";
  if (relative === "") return undefined;
  if (relative.includes("\\") || /[\0-\x1f\x7f]/.test(relative)) {
    return "entry contains a non-portable path character";
  }

  const segments = relative.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    return "entry contains an unsafe path segment";
  }
  if (segments.includes(".git")) return "Git metadata is private";
  if (segments[0] === "runs") return "run data is private";
  if (segments[0] === "docs") return "internal planning documents are private";
  if (relative === "AGENTS.md" || relative === "CLAUDE.md") {
    return "local agent instructions are private";
  }
  const contentReason = clientContentViolation(relative);
  if (contentReason) return `entry name contains ${contentReason}`;

  const basename = segments.at(-1);
  const lowerBasename = basename.toLowerCase();
  if (lowerBasename.startsWith(".env") && relative !== ".env.example") {
    return "dotenv files other than the inert root example are private";
  }
  if (relative !== "config/client-profile.example.json"
      && /^config\/client-profile(?:\.[^/]+)?\.json$/i.test(relative)) {
    return "a real client profile must never be archived";
  }
  if (SECRET_FILE_NAMES.has(lowerBasename)
      || SECRET_FILE_EXTENSIONS.has(path.posix.extname(lowerBasename))) {
    return "entry has a credential or private-key filename";
  }
  return undefined;
}

export function validateArchiveEntries(entries) {
  const unique = new Set();
  const violations = [];
  for (const entry of entries) {
    if (unique.has(entry)) violations.push(`${entry}: duplicate archive entry`);
    unique.add(entry);
    const reason = archiveEntryViolation(entry);
    if (reason) violations.push(`${entry}: ${reason}`);
  }
  if (violations.length) {
    throw new Error(`Client archive contains unsafe paths:\n${violations.join("\n")}`);
  }
  for (const required of REQUIRED_ARCHIVE_FILES) {
    if (!unique.has(`${ARCHIVE_PREFIX}${required}`)) {
      throw new Error(`Client archive is missing required file: ${required}`);
    }
  }
}

export function validateGitTree(rawTree) {
  for (const record of rawTree.split("\0")) {
    if (!record) continue;
    const match = record.match(/^([0-9]{6}) ([a-z]+) ([0-9a-f]+)\t([\s\S]+)$/);
    if (!match) throw new Error("Could not safely parse the Git tree used for packaging.");
    const [, mode, type, , filename] = match;
    if (type !== "blob" || (mode !== "100644" && mode !== "100755")) {
      throw new Error(`Client packaging does not allow symlinks or submodules: ${filename}`);
    }
    if (filename.includes("\\") || /[\0-\x1f\x7f]/.test(filename)) {
      throw new Error(`Client packaging does not allow non-portable filenames: ${filename}`);
    }
  }
}

function clientTextFile(filename) {
  const basename = path.basename(filename);
  return basename === ".env.example"
    || basename === ".gitattributes"
    || basename === ".gitignore"
    || CLIENT_TEXT_EXTENSIONS.has(path.extname(basename).toLowerCase());
}

export async function validateClientArchiveContents(root) {
  async function inspect(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Client archive contains a symbolic link: ${path.relative(root, target)}`);
      }
      if (entry.isDirectory()) {
        await inspect(target);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!clientTextFile(entry.name)) {
        if (CLIENT_BINARY_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
        throw new Error(
          `Client archive contains a file type the privacy scanner does not inspect: ${path.relative(root, target)}`,
        );
      }
      const stat = await fs.stat(target);
      if (stat.size > MAX_CLIENT_TEXT_BYTES) {
        throw new Error(`Client archive text file is too large to inspect: ${path.relative(root, target)}`);
      }
      const source = await fs.readFile(target, "utf8");
      const reason = clientContentViolation(source);
      if (reason) {
        throw new Error(`Client archive contains ${reason}: ${path.relative(root, target)}`);
      }
    }
  }
  await inspect(root);
}

function validatePackageMetadata(packageJson, packageLock) {
  const version = safePackageVersion(packageJson.version);
  if (packageJson.private !== true) {
    throw new Error("package.json must keep private=true before client packaging.");
  }
  if (packageLock?.version !== version || packageLock?.packages?.[""]?.version !== version) {
    throw new Error("package.json and package-lock.json versions must match before packaging.");
  }
  if (packageLock?.name !== packageJson.name || packageLock?.packages?.[""]?.name !== packageJson.name) {
    throw new Error("package.json and package-lock.json names must match before packaging.");
  }
  for (const script of ["build", "dev", "doctor", "start", "test"]) {
    if (typeof packageJson.scripts?.[script] !== "string" || !packageJson.scripts[script].trim()) {
      throw new Error(`package.json is missing the required ${script} script.`);
    }
  }
  return version;
}

function validateInertExamples(exampleEnv, exampleProfile) {
  const assignments = new Map();
  for (const originalLine of exampleEnv.split(/\r?\n/)) {
    const line = originalLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) throw new Error(".env.example contains an unsupported assignment.");
    assignments.set(match[1], match[2]);
  }
  for (const key of [
    "CAMPAIGN_COUNCIL_CLIENT_PROFILE",
    "CAMPAIGN_COUNCIL_DATA_DIR",
    "LANDING_PAGES_DIR",
  ]) {
    if (assignments.get(key) !== "") {
      throw new Error(`.env.example must leave ${key} empty.`);
    }
  }
  if (assignments.get("CAMPAIGN_COUNCIL_USE_DEVELOPMENT_PROFILE") !== "0") {
    throw new Error(".env.example must keep the development profile disabled.");
  }
  if ([...assignments.keys()].some((key) => /(?:API_KEY|ACCESS_TOKEN|PASSWORD|SECRET)/i.test(key))) {
    throw new Error(".env.example must not define credential variables.");
  }

  const capabilities = exampleProfile?.policies?.capabilities;
  if (!capabilities || Object.values(capabilities).some((value) => value !== false)) {
    throw new Error("The example client profile must leave every optional capability disabled.");
  }
  const meta = exampleProfile?.meta;
  if (!meta || Object.values(meta).some((value) => value !== null)) {
    throw new Error("The example client profile must not contain Meta identifiers or credentials.");
  }
}

async function sha256(file) {
  const hash = crypto.createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

async function ensureRealDirectory(directory) {
  try {
    const stat = await fs.lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("dist must be a real directory, not a file or symbolic link.");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await fs.mkdir(directory, { recursive: false, mode: 0o700 });
  }
}

async function assertSafeReplaceTarget(target) {
  try {
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`Refusing to replace a non-regular package output: ${target}`);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function git(root, args) {
  return execFileAsync(gitExecutable, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
  });
}

export async function packageClient(options = {}) {
  const root = path.resolve(options.root ?? defaultRoot);
  const { stdout: topLevelOutput } = await git(root, ["rev-parse", "--show-toplevel"]);
  const [topLevel, realRoot] = await Promise.all([
    fs.realpath(topLevelOutput.trim()),
    fs.realpath(root),
  ]);
  if (topLevel !== realRoot) {
    throw new Error("Client packaging must run from the Campaign Council Git repository root.");
  }

  const { stdout: status } = await git(root, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  if (status.trim()) {
    throw new Error("Client packaging requires a clean Git worktree so no approved change is omitted.");
  }

  const [packageJson, packageLock, exampleEnv, exampleProfile, headResult, treeResult] = await Promise.all([
    fs.readFile(path.join(root, "package.json"), "utf8").then(JSON.parse),
    fs.readFile(path.join(root, "package-lock.json"), "utf8").then(JSON.parse),
    fs.readFile(path.join(root, ".env.example"), "utf8"),
    fs.readFile(path.join(root, "config", "client-profile.example.json"), "utf8").then(JSON.parse),
    git(root, ["rev-parse", "--verify", "HEAD"]),
    git(root, ["ls-tree", "-r", "-z", "HEAD"]),
  ]);
  const version = validatePackageMetadata(packageJson, packageLock);
  validateInertExamples(exampleEnv, exampleProfile);
  validateGitTree(treeResult.stdout);

  const commit = headResult.stdout.trim();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)) {
    throw new Error("Could not resolve a valid Git commit for client packaging.");
  }

  const outputDir = path.join(root, "dist");
  await ensureRealDirectory(outputDir);
  const temporaryDir = await fs.mkdtemp(path.join(outputDir, ".package-"));
  await fs.chmod(temporaryDir, 0o700);

  const basename = `campaign-council-client-${version}-${commit.slice(0, 12)}`;
  const finalArchive = path.join(outputDir, `${basename}.tar.gz`);
  const finalChecksum = path.join(outputDir, `${basename}.sha256`);
  const temporaryArchive = path.join(temporaryDir, `${basename}.tar.gz`);
  const temporaryTar = path.join(temporaryDir, `${basename}.tar`);
  const temporaryChecksum = path.join(temporaryDir, `${basename}.sha256`);

  try {
    await execFileAsync(
      gitExecutable,
      [
        "archive",
        "--format=tar",
        `--prefix=${ARCHIVE_PREFIX}`,
        `--output=${temporaryTar}`,
        "HEAD",
      ],
      { cwd: root, encoding: "utf8", maxBuffer: MAX_GIT_OUTPUT_BYTES },
    );
    await fs.chmod(temporaryTar, 0o600);
    await pipeline(
      createReadStream(temporaryTar),
      createGzip({ level: zlibConstants.Z_BEST_COMPRESSION }),
      createWriteStream(temporaryArchive, { flags: "wx", mode: 0o600 }),
    );
    await fs.unlink(temporaryTar);

    const { stdout: listing } = await execFileAsync(
      tarExecutable,
      ["-tzf", temporaryArchive],
      { cwd: root, encoding: "utf8", maxBuffer: MAX_GIT_OUTPUT_BYTES },
    );
    const entries = listing.split(/\r?\n/).filter(Boolean);
    validateArchiveEntries(entries);

    const extractedDirectory = path.join(temporaryDir, "contents");
    await fs.mkdir(extractedDirectory, { mode: 0o700 });
    await execFileAsync(
      tarExecutable,
      ["-xzf", temporaryArchive, "-C", extractedDirectory],
      { cwd: root, encoding: "utf8", maxBuffer: MAX_GIT_OUTPUT_BYTES },
    );
    await validateClientArchiveContents(path.join(extractedDirectory, "campaign-council"));

    const digest = await sha256(temporaryArchive);
    await fs.writeFile(
      temporaryChecksum,
      `${digest}  ${path.basename(finalArchive)}\n`,
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
    await Promise.all([
      assertSafeReplaceTarget(finalArchive),
      assertSafeReplaceTarget(finalChecksum),
    ]);
    await fs.rename(temporaryArchive, finalArchive);
    await fs.rename(temporaryChecksum, finalChecksum);
    return Object.freeze({ archive: finalArchive, checksum: finalChecksum, commit });
  } finally {
    await fs.rm(temporaryDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try {
    const result = await packageClient();
    process.stdout.write(`${result.archive}\n${result.checksum}\n`);
  } catch (error) {
    process.stderr.write(`Client packaging failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
