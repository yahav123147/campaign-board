import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";
import type { Pipeline } from "@/types";
import { isPipeline } from "@/types";

export const CLIENT_PROFILE_SCHEMA_VERSION = 1 as const;
export const CLIENT_PROFILE_PATH_ENV = "CAMPAIGN_COUNCIL_CLIENT_PROFILE";
export const DEVELOPMENT_PROFILE_ENV = "CAMPAIGN_COUNCIL_USE_DEVELOPMENT_PROFILE";
export const MAX_CLIENT_PROFILE_BYTES = 64 * 1024;

const MAX_SHORT_TEXT = 160;
const MAX_RULE_TEXT = 1_000;
const MAX_RULES = 100;

export interface ClientProfile {
  readonly schemaVersion: typeof CLIENT_PROFILE_SCHEMA_VERSION;
  readonly tenant: {
    readonly id: string;
    readonly displayName: string;
    readonly locale: string;
    readonly timezone: string;
  };
  readonly brand: {
    readonly publicName: string;
    readonly legalName?: string;
    readonly facts: readonly string[];
  };
  readonly policies: {
    readonly contentRules: readonly string[];
    readonly advertisingRules: readonly string[];
    readonly operationalRules: readonly string[];
    readonly capabilities: {
      readonly landingPageBuild: boolean;
      readonly metaPixelRead: boolean;
      readonly metaCampaignCreatePaused: boolean;
      readonly creativeImageGen?: boolean;
      /** Stage 5.2 of a direct run may take a live Instagram screenshot through the operator's Chrome session. Off for clients. */
      readonly liveProof?: boolean;
    };
  };
  /**
   * The craft standard the stage 4 copy critics judge against. Without it they
   * only have their own taste, and a headline passes or fails on opinion.
   */
  readonly copy?: {
    readonly standardPath?: string;
    /** Ads craft standard for stage 7. Falls back to standardPath when unset. */
    readonly adsStandardPath?: string;
    /**
     * Directory of per asset type blueprint files, one markdown file per
     * AssetType. Falls back to a "page-types" directory next to the loaded
     * profile file when unset.
     */
    readonly pageTypesDir?: string;
    /**
     * Live overrides for the critic loop (Task 6): a directory of per-critic
     * rubric files and the design-strategy standard path. Unset falls back to
     * the packaged defaults in config/standards/critics.
     */
    readonly critics?: {
      readonly rubricsDir?: string;
      readonly designStrategyStandardPath?: string;
    };
    /**
     * Whose first person the page is written in. The copy standard a tenant
     * configures dictates the profile owner's own voice, which is wrong for a
     * page that belongs to a client's presenter. "presenter" = the presenter
     * named in the brief and the facts pool. Absent, or "brand-owner", keeps
     * the standard's own rule, which is today's behaviour.
     */
    readonly voice?: {
      readonly firstPerson?: "presenter" | "brand-owner";
    };
  };
  /**
   * Gate policy. "express" auto-approves routine gates so a human decides only
   * where a decision is real: the finished copy, the asset contact sheet, the
   * QA'd page and the ads. "full" (the default) keeps every gate human.
   */
  readonly gates?: {
    readonly policy?: "full" | "express";
  };
  /**
   * Strategy discussion depth. 2 (the default) = opening positions + a
   * confrontation round; the synthesis does the convergence. 1 suits a
   * complete, detailed brief; 3 restores the original full debate.
   */
  readonly discussion?: {
    readonly rounds?: 1 | 2 | 3;
  };
  /**
   * What this installation calls the board, shown in the browser tab and in
   * the header. It lives here and not in the UI source because it is tenant
   * material: the packaging scanner refuses any packaged text file carrying a
   * brand name, and this file is itself packaged. Unset shows the neutral
   * default from lib/boardName.ts.
   */
  readonly ui?: {
    readonly boardName?: string;
  };
  /**
   * Direct pipeline defaults. `default` preselects the pipeline in the brief
   * form; `criticMaxRounds` caps the draft/critic loop of stages 2 and 3
   * (1 to 5, default 3 for copy and 2 for the design brief when unset).
   */
  readonly pipeline?: {
    readonly default?: Pipeline;
    readonly criticMaxRounds?: number;
  };
  /**
   * Stage 7.5 creative production. Disabled unless the capability flag is on
   * AND a Keychain service holding the client's OpenAI API key is named.
   * Presenter faces are never generated: real photos only, from the directory.
   */
  readonly creative?: {
    readonly openaiKeychainService?: string;
    readonly presenterPhotosDir?: string;
    /** The creative craft standard the stage 7.5 planner is bound by. */
    readonly standardPath?: string;
  };
  readonly landing?: {
    readonly workspacePath?: string;
    readonly publicBaseUrl?: string;
    readonly referenceUrlPrefixes?: readonly string[];
    readonly referenceRoots?: readonly string[];
    readonly designStandardPath?: string;
    readonly qaScriptPath?: string;
    /**
     * Where the device mockup base frames are installed. Unset means the ones
     * packaged with the Board (config/standards/mockups).
     */
    readonly mockupBasesDir?: string;
  };
  readonly meta?: {
    readonly accountId?: string;
    readonly pixelId?: string;
    readonly customConversionId?: string;
    readonly pageId?: string;
    readonly instagramActorId?: string;
    readonly domain?: string;
    readonly tokenKeychainService?: string;
  };
}

export type ClientFeature = "stage5" | "stage8" | "stage9";

export interface FeatureReadiness {
  readonly enabled: boolean;
  readonly missingFields: readonly string[];
  readonly policyBlocks: readonly string[];
}

export type ClientFeatureReadiness = Readonly<Record<ClientFeature, FeatureReadiness>>;

export type ClientProfileErrorCode =
  | "missing-profile"
  | "invalid-profile"
  | "profile-too-large"
  | "unsafe-profile-file"
  | "profile-read-failed";

export class ClientProfileError extends Error {
  readonly code: ClientProfileErrorCode;
  readonly profilePath?: string;

  constructor(code: ClientProfileErrorCode, message: string, profilePath?: string, cause?: unknown) {
    super(message, { cause });
    this.name = "ClientProfileError";
    this.code = code;
    this.profilePath = profilePath;
  }
}

type JsonObject = Record<string, unknown>;

function fail(field: string, message: string): never {
  throw new ClientProfileError("invalid-profile", `Invalid client profile: ${field} ${message}`);
}

function objectAt(value: unknown, field: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(field, "must be an object.");
  }
  return value as JsonObject;
}

function rejectUnknownFields(value: JsonObject, field: string, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedSet.has(key));
  if (unknown) fail(`${field}.${unknown}`, "is not a supported field.");
}

function requiredString(
  value: unknown,
  field: string,
  maxLength = MAX_SHORT_TEXT,
): string {
  if (typeof value !== "string") fail(field, "must be a string.");
  const normalized = value.trim();
  if (!normalized) fail(field, "must not be empty.");
  if (normalized.length > maxLength) fail(field, `must be at most ${maxLength} characters.`);
  if (/\0/.test(normalized)) fail(field, "must not contain a null byte.");
  return normalized;
}

function optionalString(
  value: unknown,
  field: string,
  maxLength = MAX_SHORT_TEXT,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requiredString(value, field, maxLength);
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") fail(field, "must be true or false.");
  return value;
}

function stringList(value: unknown, field: string, requireEntry: boolean): readonly string[] {
  if (!Array.isArray(value)) fail(field, "must be an array of strings.");
  if (value.length > MAX_RULES) fail(field, `must contain at most ${MAX_RULES} entries.`);
  if (requireEntry && value.length === 0) fail(field, "must contain at least one entry.");

  const result = value.map((entry, index) => requiredString(entry, `${field}[${index}]`, MAX_RULE_TEXT));
  if (new Set(result).size !== result.length) fail(field, "must not contain duplicate entries.");
  return result;
}

function optionalStringList(value: unknown, field: string): readonly string[] {
  if (value === undefined || value === null) return [];
  return stringList(value, field, false);
}

function validateLocale(value: unknown): string {
  const locale = requiredString(value, "profile.tenant.locale", 35);
  try {
    return new Intl.Locale(locale).toString();
  } catch {
    fail("profile.tenant.locale", "must be a valid BCP 47 locale, for example en-US.");
  }
}

function validateTimezone(value: unknown): string {
  const timezone = requiredString(value, "profile.tenant.timezone", 100);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    return timezone;
  } catch {
    fail("profile.tenant.timezone", "must be a valid IANA timezone, for example Europe/London.");
  }
}

function validateTenantId(value: unknown): string {
  const id = requiredString(value, "profile.tenant.id", 63);
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(id)) {
    fail(
      "profile.tenant.id",
      "must use lowercase letters, digits, and internal hyphens only.",
    );
  }
  return id;
}

/** An absolute path to a single file the orchestrator may read at run time. */
function validateAbsoluteFilePath(value: unknown, field: string): string | undefined {
  const filePath = optionalString(value, field, 4_096);
  if (!filePath) return undefined;
  if (!path.isAbsolute(filePath) && !path.win32.isAbsolute(filePath)) {
    fail(field, "must be an absolute path.");
  }
  return path.normalize(filePath);
}

function validateWorkspacePath(value: unknown): string | undefined {
  const workspacePath = optionalString(value, "profile.landing.workspacePath", 4_096);
  if (!workspacePath) return undefined;
  if (!path.isAbsolute(workspacePath) && !path.win32.isAbsolute(workspacePath)) {
    fail("profile.landing.workspacePath", "must be an absolute path.");
  }
  return path.normalize(workspacePath);
}

function validateWorkspaceRelativeFile(value: unknown, field: string): string | undefined {
  const raw = optionalString(value, field, 512);
  if (!raw) return undefined;
  if (raw.includes("\\") || /[\r\n]/.test(raw) || path.posix.isAbsolute(raw)) {
    fail(field, "must be a forward-slash relative file path inside the landing workspace.");
  }
  const segments = raw.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    fail(field, "must not contain empty, current-directory, or parent-directory segments.");
  }
  return segments.join("/");
}

function validateReferenceRoots(value: unknown): readonly string[] {
  const roots = optionalStringList(value, "profile.landing.referenceRoots");
  const normalized = roots.map((root, index) => {
    if (!path.isAbsolute(root) && !path.win32.isAbsolute(root)) {
      fail(`profile.landing.referenceRoots[${index}]`, "must be an absolute path.");
    }
    return path.normalize(root);
  });
  if (new Set(normalized).size !== normalized.length) {
    fail("profile.landing.referenceRoots", "must not contain duplicate paths.");
  }
  return normalized;
}

function validateReferenceUrlPrefixes(value: unknown): readonly string[] {
  const prefixes = optionalStringList(value, "profile.landing.referenceUrlPrefixes");
  const normalized = prefixes.map((raw, index) => {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      fail(`profile.landing.referenceUrlPrefixes[${index}]`, "must be a valid URL.");
    }
    const loopback = parsed.hostname === "localhost"
      || parsed.hostname === "127.0.0.1"
      || parsed.hostname === "[::1]";
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
      fail(
        `profile.landing.referenceUrlPrefixes[${index}]`,
        "must use https, except for an explicit loopback URL.",
      );
    }
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
      fail(
        `profile.landing.referenceUrlPrefixes[${index}]`,
        "must not contain credentials, a query string, or a fragment.",
      );
    }
    return parsed.href;
  });
  if (new Set(normalized).size !== normalized.length) {
    fail("profile.landing.referenceUrlPrefixes", "must not contain duplicate URLs.");
  }
  return normalized;
}

function validateHttpUrl(value: unknown): string | undefined {
  const raw = optionalString(value, "profile.landing.publicBaseUrl", 2_048);
  if (!raw) return undefined;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    fail("profile.landing.publicBaseUrl", "must be a valid http or https URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    fail("profile.landing.publicBaseUrl", "must use http or https.");
  }
  if (parsed.username || parsed.password) {
    fail("profile.landing.publicBaseUrl", "must not contain credentials.");
  }
  if (parsed.search || parsed.hash) {
    fail("profile.landing.publicBaseUrl", "must not contain a query string or fragment.");
  }
  return parsed.href.replace(/\/$/, "");
}

function validateMetaId(
  value: unknown,
  field: string,
  prefix = "",
): string | undefined {
  const result = optionalString(value, field, 40);
  if (!result) return undefined;
  const expression = prefix ? new RegExp(`^${prefix}[0-9]{5,32}$`) : /^[0-9]{5,32}$/;
  if (!expression.test(result)) {
    fail(field, prefix ? `must match ${prefix}<digits>.` : "must contain 5 to 32 digits.");
  }
  return result;
}

function validateDomain(value: unknown): string | undefined {
  const domain = optionalString(value, "profile.meta.domain", 253)?.toLowerCase();
  if (!domain) return undefined;
  if (domain.includes(":")) fail("profile.meta.domain", "must not include a scheme or port.");

  let parsed: URL;
  try {
    parsed = new URL(`https://${domain}`);
  } catch {
    fail("profile.meta.domain", "must be a valid hostname without a scheme or path.");
  }
  if (
    parsed.hostname !== domain ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    parsed.username ||
    parsed.password
  ) {
    fail("profile.meta.domain", "must be a valid hostname without a scheme or path.");
  }
  const labels = domain.split(".");
  if (
    labels.some(
      (label) =>
        label.length === 0 ||
        label.length > 63 ||
        !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
    )
  ) {
    fail("profile.meta.domain", "must contain valid DNS hostname labels.");
  }
  return domain;
}

function optionalSection(value: unknown, field: string): JsonObject | undefined {
  if (value === undefined || value === null) return undefined;
  return objectAt(value, field);
}

/** Parse and strictly validate an untrusted profile object. Unknown fields are rejected. */
export function validateClientProfile(value: unknown): ClientProfile {
  const profile = objectAt(value, "profile");
  rejectUnknownFields(profile, "profile", [
    "schemaVersion",
    "tenant",
    "brand",
    "policies",
    "copy",
    "gates",
    "discussion",
    "ui",
    "pipeline",
    "creative",
    "landing",
    "meta",
  ]);
  if (profile.schemaVersion !== CLIENT_PROFILE_SCHEMA_VERSION) {
    fail(
      "profile.schemaVersion",
      `must be ${CLIENT_PROFILE_SCHEMA_VERSION}; unsupported profile versions are not loaded.`,
    );
  }

  const tenant = objectAt(profile.tenant, "profile.tenant");
  rejectUnknownFields(tenant, "profile.tenant", ["id", "displayName", "locale", "timezone"]);

  const brand = objectAt(profile.brand, "profile.brand");
  rejectUnknownFields(brand, "profile.brand", ["publicName", "legalName", "facts"]);

  const policies = objectAt(profile.policies, "profile.policies");
  rejectUnknownFields(policies, "profile.policies", [
    "contentRules",
    "advertisingRules",
    "operationalRules",
    "capabilities",
  ]);
  const capabilities = objectAt(policies.capabilities, "profile.policies.capabilities");
  rejectUnknownFields(capabilities, "profile.policies.capabilities", [
    "landingPageBuild",
    "metaPixelRead",
    "metaCampaignCreatePaused",
    "creativeImageGen",
    "liveProof",
  ]);

  const copy = optionalSection(profile.copy, "profile.copy");
  if (copy) rejectUnknownFields(copy, "profile.copy", ["standardPath", "adsStandardPath", "pageTypesDir", "critics", "voice"]);
  const critics = optionalSection(copy?.critics, "profile.copy.critics");
  if (critics) rejectUnknownFields(critics, "profile.copy.critics", ["rubricsDir", "designStrategyStandardPath"]);
  const voice = optionalSection(copy?.voice, "profile.copy.voice");
  if (voice) {
    rejectUnknownFields(voice, "profile.copy.voice", ["firstPerson"]);
    if (voice.firstPerson !== undefined && voice.firstPerson !== "presenter" && voice.firstPerson !== "brand-owner") {
      fail("profile.copy.voice.firstPerson", 'must be "presenter" or "brand-owner"');
    }
  }

  const gates = optionalSection(profile.gates, "profile.gates");
  if (gates) {
    rejectUnknownFields(gates, "profile.gates", ["policy"]);
    if (gates.policy !== undefined && gates.policy !== "full" && gates.policy !== "express") {
      fail("profile.gates.policy", 'must be "full" or "express"');
    }
  }

  const creativeSection = optionalSection(profile.creative, "profile.creative");
  if (creativeSection) {
    rejectUnknownFields(creativeSection, "profile.creative", [
      "openaiKeychainService",
      "presenterPhotosDir",
      "standardPath",
    ]);
    if (
      creativeSection.presenterPhotosDir !== undefined &&
      creativeSection.presenterPhotosDir !== null &&
      (typeof creativeSection.presenterPhotosDir !== "string" ||
        !creativeSection.presenterPhotosDir.startsWith("/"))
    ) {
      fail("profile.creative.presenterPhotosDir", "must be an absolute directory path");
    }
  }

  const discussion = optionalSection(profile.discussion, "profile.discussion");
  if (discussion) {
    rejectUnknownFields(discussion, "profile.discussion", ["rounds"]);
    if (discussion.rounds !== undefined && ![1, 2, 3].includes(discussion.rounds as number)) {
      fail("profile.discussion.rounds", "must be 1, 2 or 3");
    }
  }

  const ui = optionalSection(profile.ui, "profile.ui");
  if (ui) rejectUnknownFields(ui, "profile.ui", ["boardName"]);
  const uiBoardName = ui ? optionalString(ui.boardName, "profile.ui.boardName", 200) : undefined;

  const pipeline = optionalSection(profile.pipeline, "profile.pipeline");
  if (pipeline) {
    rejectUnknownFields(pipeline, "profile.pipeline", ["default", "criticMaxRounds"]);
    if (pipeline.default !== undefined && !isPipeline(pipeline.default)) {
      fail("profile.pipeline.default", 'must be "council" or "direct"');
    }
    if (pipeline.criticMaxRounds !== undefined
      && (!Number.isInteger(pipeline.criticMaxRounds) || (pipeline.criticMaxRounds as number) < 1 || (pipeline.criticMaxRounds as number) > 5)) {
      fail("profile.pipeline.criticMaxRounds", "must be an integer from 1 to 5");
    }
  }

  const landing = optionalSection(profile.landing, "profile.landing");
  if (landing) rejectUnknownFields(landing, "profile.landing", [
    "workspacePath",
    "publicBaseUrl",
    "referenceUrlPrefixes",
    "referenceRoots",
    "designStandardPath",
    "qaScriptPath",
    "mockupBasesDir",
  ]);

  const meta = optionalSection(profile.meta, "profile.meta");
  if (meta) {
    rejectUnknownFields(meta, "profile.meta", [
      "accountId",
      "pixelId",
      "customConversionId",
      "pageId",
      "instagramActorId",
      "domain",
      "tokenKeychainService",
    ]);
  }

  const copyStandardPath = validateAbsoluteFilePath(
    copy?.standardPath,
    "profile.copy.standardPath",
  );
  const adsStandardPath = validateAbsoluteFilePath(
    copy?.adsStandardPath,
    "profile.copy.adsStandardPath",
  );
  const pageTypesDir = validateAbsoluteFilePath(
    copy?.pageTypesDir,
    "profile.copy.pageTypesDir",
  );
  const criticsRubricsDir = validateAbsoluteFilePath(
    critics?.rubricsDir,
    "profile.copy.critics.rubricsDir",
  );
  const criticsDesignStrategyStandardPath = validateAbsoluteFilePath(
    critics?.designStrategyStandardPath,
    "profile.copy.critics.designStrategyStandardPath",
  );
  const normalizedCritics: NonNullable<ClientProfile["copy"]>["critics"] =
    criticsRubricsDir || criticsDesignStrategyStandardPath
      ? {
          ...(criticsRubricsDir ? { rubricsDir: criticsRubricsDir } : {}),
          ...(criticsDesignStrategyStandardPath ? { designStrategyStandardPath: criticsDesignStrategyStandardPath } : {}),
        }
      : undefined;
  const firstPerson = voice?.firstPerson as "presenter" | "brand-owner" | undefined;
  const normalizedCopy: ClientProfile["copy"] = copy
    ? {
        standardPath: copyStandardPath,
        ...(adsStandardPath ? { adsStandardPath } : {}),
        ...(pageTypesDir ? { pageTypesDir } : {}),
        ...(normalizedCritics ? { critics: normalizedCritics } : {}),
        ...(firstPerson ? { voice: { firstPerson } } : {}),
      }
    : undefined;

  const workspacePath = validateWorkspacePath(landing?.workspacePath);
  const publicBaseUrl = validateHttpUrl(landing?.publicBaseUrl);
  const normalizedLanding: ClientProfile["landing"] = landing
    ? {
        workspacePath,
        publicBaseUrl,
        referenceUrlPrefixes: validateReferenceUrlPrefixes(landing.referenceUrlPrefixes),
        referenceRoots: validateReferenceRoots(landing.referenceRoots),
        designStandardPath: validateWorkspaceRelativeFile(
          landing.designStandardPath,
          "profile.landing.designStandardPath",
        ),
        qaScriptPath: validateWorkspaceRelativeFile(
          landing.qaScriptPath,
          "profile.landing.qaScriptPath",
        ),
        mockupBasesDir: validateAbsoluteFilePath(
          landing.mockupBasesDir,
          "profile.landing.mockupBasesDir",
        ),
      }
    : undefined;
  const normalizedMeta: ClientProfile["meta"] = meta
    ? {
        accountId: validateMetaId(meta.accountId, "profile.meta.accountId", "act_"),
        pixelId: validateMetaId(meta.pixelId, "profile.meta.pixelId"),
        customConversionId: validateMetaId(
          meta.customConversionId,
          "profile.meta.customConversionId",
        ),
        pageId: validateMetaId(meta.pageId, "profile.meta.pageId"),
        instagramActorId: validateMetaId(
          meta.instagramActorId,
          "profile.meta.instagramActorId",
        ),
        domain: validateDomain(meta.domain),
        tokenKeychainService: optionalString(
          meta.tokenKeychainService,
          "profile.meta.tokenKeychainService",
          128,
        ),
      }
    : undefined;

  return {
    schemaVersion: CLIENT_PROFILE_SCHEMA_VERSION,
    tenant: {
      id: validateTenantId(tenant.id),
      displayName: requiredString(tenant.displayName, "profile.tenant.displayName"),
      locale: validateLocale(tenant.locale),
      timezone: validateTimezone(tenant.timezone),
    },
    brand: {
      publicName: requiredString(brand.publicName, "profile.brand.publicName"),
      legalName: optionalString(brand.legalName, "profile.brand.legalName"),
      facts: stringList(brand.facts, "profile.brand.facts", true),
    },
    policies: {
      contentRules: stringList(policies.contentRules, "profile.policies.contentRules", false),
      advertisingRules: stringList(
        policies.advertisingRules,
        "profile.policies.advertisingRules",
        false,
      ),
      operationalRules: stringList(
        policies.operationalRules,
        "profile.policies.operationalRules",
        false,
      ),
      capabilities: {
        landingPageBuild: requiredBoolean(
          capabilities.landingPageBuild,
          "profile.policies.capabilities.landingPageBuild",
        ),
        metaPixelRead: requiredBoolean(
          capabilities.metaPixelRead,
          "profile.policies.capabilities.metaPixelRead",
        ),
        metaCampaignCreatePaused: requiredBoolean(
          capabilities.metaCampaignCreatePaused,
          "profile.policies.capabilities.metaCampaignCreatePaused",
        ),
        creativeImageGen:
          capabilities.creativeImageGen === undefined
            ? false
            : requiredBoolean(
                capabilities.creativeImageGen,
                "profile.policies.capabilities.creativeImageGen",
              ),
        liveProof:
          capabilities.liveProof === undefined
            ? false
            : requiredBoolean(
                capabilities.liveProof,
                "profile.policies.capabilities.liveProof",
              ),
      },
    },
    ...(normalizedCopy ? { copy: normalizedCopy } : {}),
    ...(gates ? { gates: { policy: gates.policy === "express" ? ("express" as const) : ("full" as const) } } : {}),
    ...(creativeSection
      ? {
          creative: {
            openaiKeychainService: optionalString(
              creativeSection.openaiKeychainService,
              "profile.creative.openaiKeychainService",
              128,
            ),
            presenterPhotosDir:
              typeof creativeSection.presenterPhotosDir === "string"
                ? creativeSection.presenterPhotosDir
                : undefined,
            standardPath: validateAbsoluteFilePath(
              creativeSection.standardPath,
              "profile.creative.standardPath",
            ),
          },
        }
      : {}),
    ...(discussion?.rounds !== undefined
      ? { discussion: { rounds: discussion.rounds as 1 | 2 | 3 } }
      : {}),
    ...(uiBoardName !== undefined ? { ui: { boardName: uiBoardName } } : {}),
    ...(pipeline
      ? { pipeline: {
          ...(pipeline.default !== undefined ? { default: pipeline.default as Pipeline } : {}),
          ...(pipeline.criticMaxRounds !== undefined ? { criticMaxRounds: pipeline.criticMaxRounds as number } : {}),
        } }
      : {}),
    ...(normalizedLanding ? { landing: normalizedLanding } : {}),
    ...(normalizedMeta ? { meta: normalizedMeta } : {}),
  };
}

function readiness(missingFields: string[], policyBlocks: string[]): FeatureReadiness {
  return Object.freeze({
    enabled: missingFields.length === 0 && policyBlocks.length === 0,
    missingFields: Object.freeze(missingFields),
    policyBlocks: Object.freeze(policyBlocks),
  });
}

/**
 * Feature gates are fail closed. Supplying connection details is not enough:
 * the corresponding tenant policy must explicitly authorize the operation.
 */
export function getClientFeatureReadiness(profile: ClientProfile): ClientFeatureReadiness {
  const stage5Requirements: Array<[string, string | undefined]> = [
    ["landing.workspacePath", profile.landing?.workspacePath],
    ["landing.designStandardPath", profile.landing?.designStandardPath],
    ["landing.qaScriptPath", profile.landing?.qaScriptPath],
  ];
  const stage5Missing = stage5Requirements
    .filter(([, value]) => !value)
    .map(([field]) => field);
  const stage5Policy = profile.policies.capabilities.landingPageBuild
    ? []
    : ["policies.capabilities.landingPageBuild"];

  const stage8Requirements: Array<[string, string | undefined]> = [
    ["meta.accountId", profile.meta?.accountId],
    ["meta.pixelId", profile.meta?.pixelId],
    ["meta.customConversionId", profile.meta?.customConversionId],
    ["meta.domain", profile.meta?.domain],
    ["meta.tokenKeychainService", profile.meta?.tokenKeychainService],
  ];
  const stage8Missing = stage8Requirements.filter(([, value]) => !value).map(([field]) => field);
  const stage8Policy = profile.policies.capabilities.metaPixelRead
    ? []
    : ["policies.capabilities.metaPixelRead"];

  const stage9Requirements: Array<[string, string | undefined]> = [
    ...stage8Requirements,
    ["meta.pageId", profile.meta?.pageId],
    ["meta.instagramActorId", profile.meta?.instagramActorId],
    ["landing.publicBaseUrl", profile.landing?.publicBaseUrl],
  ];
  const stage9Missing = stage9Requirements.filter(([, value]) => !value).map(([field]) => field);
  const stage9Policy = [
    ...(profile.policies.capabilities.metaPixelRead
      ? []
      : ["policies.capabilities.metaPixelRead"]),
    ...(profile.policies.capabilities.metaCampaignCreatePaused
      ? []
      : ["policies.capabilities.metaCampaignCreatePaused"]),
  ];

  return Object.freeze({
    stage5: readiness(stage5Missing, stage5Policy),
    stage8: readiness(stage8Missing, stage8Policy),
    stage9: readiness(stage9Missing, stage9Policy),
  });
}

const DEVELOPMENT_PROFILE_INPUT = {
  schemaVersion: CLIENT_PROFILE_SCHEMA_VERSION,
  tenant: {
    id: "development",
    displayName: "Local Development",
    locale: "en-US",
    timezone: "UTC",
  },
  brand: {
    publicName: "Development Brand",
    facts: ["This built-in profile contains fictional, non-production data only."],
  },
  policies: {
    contentRules: ["Do not present development output as real client material."],
    advertisingRules: ["Do not access or modify advertising accounts."],
    operationalRules: ["Do not perform external writes."],
    capabilities: {
      landingPageBuild: false,
      metaPixelRead: false,
      metaCampaignCreatePaused: false,
    },
  },
} satisfies ClientProfile;

function developmentProfile(): ClientProfile {
  return validateClientProfile(structuredClone(DEVELOPMENT_PROFILE_INPUT));
}

async function readBoundedRegularFile(profilePath: string): Promise<Buffer> {
  let linkStat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    linkStat = await fs.lstat(profilePath, { bigint: true });
  } catch (error) {
    throw new ClientProfileError(
      "profile-read-failed",
      `Could not read client profile at ${profilePath}. Check that the file exists and is readable.`,
      profilePath,
      error,
    );
  }

  if (linkStat.isSymbolicLink()) {
    throw new ClientProfileError(
      "unsafe-profile-file",
      `Refusing client profile at ${profilePath}: symbolic links are not allowed.`,
      profilePath,
    );
  }
  if (!linkStat.isFile()) {
    throw new ClientProfileError(
      "unsafe-profile-file",
      `Refusing client profile at ${profilePath}: the path must be a regular file.`,
      profilePath,
    );
  }
  if (linkStat.size > BigInt(MAX_CLIENT_PROFILE_BYTES)) {
    throw new ClientProfileError(
      "profile-too-large",
      `Client profile at ${profilePath} is too large. The limit is ${MAX_CLIENT_PROFILE_BYTES} bytes.`,
      profilePath,
    );
  }

  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    const noFollow = fsConstants.O_NOFOLLOW ?? 0;
    handle = await fs.open(profilePath, fsConstants.O_RDONLY | noFollow);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) {
      throw new ClientProfileError(
        "unsafe-profile-file",
        `Refusing client profile at ${profilePath}: the opened path is not a regular file.`,
        profilePath,
      );
    }
    if (before.dev !== linkStat.dev || before.ino !== linkStat.ino) {
      throw new ClientProfileError(
        "unsafe-profile-file",
        `Refusing client profile at ${profilePath}: the file changed while it was being opened.`,
        profilePath,
      );
    }
    if (before.size > BigInt(MAX_CLIENT_PROFILE_BYTES)) {
      throw new ClientProfileError(
        "profile-too-large",
        `Client profile at ${profilePath} is too large. The limit is ${MAX_CLIENT_PROFILE_BYTES} bytes.`,
        profilePath,
      );
    }

    const buffer = Buffer.alloc(MAX_CLIENT_PROFILE_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_CLIENT_PROFILE_BYTES) {
      throw new ClientProfileError(
        "profile-too-large",
        `Client profile at ${profilePath} grew beyond the ${MAX_CLIENT_PROFILE_BYTES} byte limit while being read.`,
        profilePath,
      );
    }

    const after = await handle.stat({ bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    ) {
      throw new ClientProfileError(
        "unsafe-profile-file",
        `Refusing client profile at ${profilePath}: the file changed while it was being read.`,
        profilePath,
      );
    }
    return buffer.subarray(0, offset);
  } catch (error) {
    if (error instanceof ClientProfileError) throw error;
    throw new ClientProfileError(
      "profile-read-failed",
      `Could not safely read client profile at ${profilePath}.`,
      profilePath,
      error,
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export interface LoadClientProfileOptions {
  /** Defaults to process.env. Passing an environment object makes tests deterministic. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Defaults to process.cwd(). Relative configured paths resolve from this directory. */
  readonly cwd?: string;
}

/**
 * Load the configured tenant profile. There is deliberately no production
 * default. The generic built-in profile is available only through an explicit
 * environment opt-in and leaves every side-effecting feature disabled.
 */
export async function loadClientProfile(
  options: LoadClientProfileOptions = {},
): Promise<ClientProfile> {
  const env = options.env ?? process.env;
  const configured = env[CLIENT_PROFILE_PATH_ENV]?.trim();

  if (!configured) {
    if (env[DEVELOPMENT_PROFILE_ENV] === "1") return developmentProfile();
    throw new ClientProfileError(
      "missing-profile",
      `No client profile is configured. Set ${CLIENT_PROFILE_PATH_ENV} to a JSON file. For isolated local development only, set ${DEVELOPMENT_PROFILE_ENV}=1.`,
    );
  }
  if (configured.includes("\0")) {
    throw new ClientProfileError(
      "unsafe-profile-file",
      `The ${CLIENT_PROFILE_PATH_ENV} value contains a null byte.`,
    );
  }

  const profilePath = path.resolve(options.cwd ?? process.cwd(), configured);
  const bytes = await readBoundedRegularFile(profilePath);
  let json: string;
  try {
    json = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new ClientProfileError(
      "invalid-profile",
      `Client profile at ${profilePath} must use valid UTF-8 text.`,
      profilePath,
      error,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new ClientProfileError(
      "invalid-profile",
      `Client profile at ${profilePath} is not valid JSON.`,
      profilePath,
      error,
    );
  }

  try {
    return validateClientProfile(parsed);
  } catch (error) {
    if (error instanceof ClientProfileError) {
      throw new ClientProfileError(error.code, `${error.message} Source: ${profilePath}`, profilePath, error);
    }
    throw error;
  }
}
