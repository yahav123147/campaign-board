const HTTP_PROTOCOLS = new Set(["http:", "https:"]);

export function parseHttpNavigationUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("URL must be valid");
  }
  if (!HTTP_PROTOCOLS.has(parsed.protocol)) throw new Error("URL must use http or https");
  if (parsed.username || parsed.password) throw new Error("URL credentials are not allowed");
  return parsed;
}

function sameRoutePath(left, right) {
  const normalize = (value) => value.length > 1 ? value.replace(/\/+$/, "") : value;
  return normalize(left) === normalize(right);
}

/**
 * Decide whether a browser request is safe to send. Browser automation is
 * allowed to talk only to the exact origin the operator selected. Generated
 * previews are restricted further to their route and Next's static runtime.
 */
export function classifyBrowserRequest(rawUrl, rootUrl, options = {}) {
  let target;
  try {
    target = new URL(rawUrl);
  } catch {
    return { allowed: false, reason: "malformed-url" };
  }

  const method = (options.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    return { allowed: false, reason: `method-${method.toLowerCase()}` };
  }
  if (!HTTP_PROTOCOLS.has(target.protocol)) {
    return { allowed: false, reason: `protocol-${target.protocol.replace(/:$/, "") || "unknown"}` };
  }
  if (target.username || target.password) {
    return { allowed: false, reason: "credentials" };
  }
  if (target.origin !== rootUrl.origin) {
    return { allowed: false, reason: "cross-origin" };
  }

  if (options.restrictToRoute) {
    const rootPath = rootUrl.pathname;
    const routePrefix = `${rootPath.replace(/\/+$/, "")}/`;
    const allowedPath =
      sameRoutePath(target.pathname, rootPath) ||
      (rootPath !== "/" && target.pathname.startsWith(routePrefix)) ||
      target.pathname.startsWith("/_next/");
    if (!allowedPath) return { allowed: false, reason: "outside-preview-route" };
  }

  return { allowed: true };
}

export function violationSentinel(scope, reason) {
  const safeScope = String(scope).replace(/[^a-z0-9-]/gi, "-").toLowerCase();
  const safeReason = String(reason).replace(/[^a-z0-9-]/gi, "-").toLowerCase();
  return `invalid:${safeScope}-${safeReason}`;
}

/**
 * A blocked request fails the gate only when it could change what the gate
 * judges: a page asset (image, font, media, css) or a same-origin escape.
 * Third-party analytics beacons that the client app shell injects (PostHog,
 * gtag) are aborted anyway; recording them as violations would fail every
 * page for code the builder never wrote.
 */
export function blockedRequestIsViolation(resourceType, reason) {
  if (reason === "cross-origin" || (typeof reason === "string" && reason.startsWith("method-"))) {
    return ["image", "media", "font", "stylesheet"].includes(resourceType);
  }
  return true;
}
