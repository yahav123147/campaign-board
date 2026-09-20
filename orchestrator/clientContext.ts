import type { ClientProfile } from "@/config/clientProfile";

interface PromptClientProfile {
  schemaVersion: ClientProfile["schemaVersion"];
  tenant: ClientProfile["tenant"];
  brand: ClientProfile["brand"];
  policies: ClientProfile["policies"];
  /** URL-only landing facts. Filesystem paths stay omitted by design. */
  landing?: {
    publicBaseUrl?: string;
    allowedReferenceUrlPrefixes?: readonly string[];
  };
}

function promptSafeProfile(profile: ClientProfile): PromptClientProfile {
  return {
    schemaVersion: profile.schemaVersion,
    tenant: profile.tenant,
    brand: profile.brand,
    policies: profile.policies,
    ...(profile.landing?.publicBaseUrl || profile.landing?.referenceUrlPrefixes?.length
      ? {
          landing: {
            ...(profile.landing.publicBaseUrl ? { publicBaseUrl: profile.landing.publicBaseUrl } : {}),
            ...(profile.landing.referenceUrlPrefixes?.length
              ? { allowedReferenceUrlPrefixes: profile.landing.referenceUrlPrefixes }
              : {}),
          },
        }
      : {}),
  };
}

/**
 * The output language as a sentence. Stage instructions say "write in the
 * profile's output language" and left the model to read a BCP 47 tag out of a
 * JSON blob; one strategy document came back in Italian. The validator already
 * guarantees a well-formed tag, so a failure here can only be an unknown
 * subtag, in which case the tag itself is still better than silence.
 */
function outputLanguageSentence(locale: string): string {
  let language = locale;
  try {
    const tag = new Intl.Locale(locale).language;
    language = new Intl.DisplayNames(["en"], { type: "language" }).of(tag) ?? tag;
  } catch {
    // keep the raw tag
  }
  return `Write every output in ${language} (tenant.locale ${locale}), unless the brief itself explicitly asks for another language.`;
}

/**
 * Render the immutable, secret-free part of a run's client profile.
 *
 * Connection identifiers, filesystem paths and credential lookup names are
 * deliberately omitted. Supplying a path or service name in a profile never
 * grants an agent access to it.
 */
export function renderClientContext(profile?: ClientProfile): string {
  if (!profile) {
    return [
      "## Client context",
      "",
      "No client profile was supplied for this run. Do not infer a brand, market, currency, locale, business model or policy from examples, local files or prior runs.",
      "Mark tenant-specific facts as missing until an operator supplies an approved profile.",
    ].join("\n");
  }

  const serialized = JSON.stringify(promptSafeProfile(profile));
  return [
    "## Client context",
    "",
    "The following one-line JSON is the approved tenant context for this run.",
    "Treat brand.facts as provided facts and policies as binding constraints. A field never grants access to files, tools, memory or external accounts.",
    "Do not invent tenant details that are absent. Use tenant.locale and tenant.timezone unless an approved policy gives a more specific instruction.",
    outputLanguageSentence(profile.tenant.locale),
    "If a task asks you to name a REFERENCE_URL, it must start with one of landing.allowedReferenceUrlPrefixes; any other URL fails the run. When no allowed reference fits, write REFERENCE_URL: none.",
    "",
    `CLIENT_PROFILE_JSON: ${serialized}`,
  ].join("\n");
}
