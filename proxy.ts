import { NextRequest, NextResponse } from "next/server";

const MAX_API_BODY_BYTES = 1024 * 1024;
// העלאת תמונת פרזנטור היא ה-multipart היחיד המותר. התקרה מיושרת לגוף שה-proxy
// של Next מעביר בפועל (experimental.proxyClientMaxBodySize, ברירת מחדל 10MB);
// תקרה גבוהה יותר כאן הייתה עוברת ונחתכת בשקט בהמשך (F101).
const MAX_PHOTO_BODY_BYTES = 10 * 1024 * 1024;
const PHOTO_UPLOAD_PATH_RE = /^\/api\/runs\/[^/]+\/stages\/7\/subtasks\/7\.5\/creative-photo$/;
const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

function parsedAuthority(value: string | null): URL | undefined {
  if (!value || /[\r\n]/.test(value)) return undefined;
  try {
    const authority = new URL(`http://${value}`);
    // A Host header is only host[:port]. URL's parser also accepts userinfo,
    // paths, queries and fragments, so reject those forms explicitly instead
    // of normalizing a malformed authority into an apparently local host.
    if (
      authority.username
      || authority.password
      || authority.pathname !== "/"
      || authority.search
      || authority.hash
    ) {
      return undefined;
    }
    return authority;
  } catch {
    return undefined;
  }
}

function isLoopbackAuthority(authority: URL | undefined): authority is URL {
  return Boolean(authority && LOOPBACK_HOSTS.has(authority.hostname.toLowerCase()));
}

function secure(response: NextResponse): NextResponse {
  response.headers.set("Cache-Control", "no-store, max-age=0");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}

function reject(status: number, error: string): NextResponse {
  return secure(NextResponse.json({ error }, { status }));
}

export function proxy(request: NextRequest): NextResponse {
  const authority = parsedAuthority(request.headers.get("host"));
  if (!isLoopbackAuthority(authority)) return reject(403, "Local access only");

  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite === "cross-site") return reject(403, "Cross-site requests are not allowed");

  if (request.method === "OPTIONS") return reject(405, "CORS is not supported");
  if (!MUTATION_METHODS.has(request.method)) return secure(NextResponse.next());

  const originValue = request.headers.get("origin");
  let origin: URL;
  try {
    origin = new URL(originValue ?? "");
  } catch {
    return reject(403, "A same-origin request is required");
  }
  if (
    origin.protocol !== "http:"
    || !LOOPBACK_HOSTS.has(origin.hostname.toLowerCase())
    || origin.host.toLowerCase() !== authority.host.toLowerCase()
  ) {
    return reject(403, "A same-origin request is required");
  }
  if (request.headers.get("x-campaign-council-request") !== "1") {
    return reject(403, "Missing local request guard");
  }

  const isPhotoUpload = PHOTO_UPLOAD_PATH_RE.test(request.nextUrl.pathname);
  const rawLength = request.headers.get("content-length");
  if (rawLength) {
    const length = Number(rawLength);
    if (!Number.isSafeInteger(length) || length < 0) return reject(400, "Invalid Content-Length");
    if (length > (isPhotoUpload ? MAX_PHOTO_BODY_BYTES : MAX_API_BODY_BYTES)) {
      return reject(413, "Request body is too large");
    }
    const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
    if (length > 0 && isPhotoUpload && !contentType.startsWith("multipart/form-data")) {
      return reject(415, "Content-Type must be multipart/form-data");
    }
    if (length > 0 && !isPhotoUpload && !contentType.startsWith("application/json")) {
      return reject(415, "Content-Type must be application/json");
    }
  }

  return secure(NextResponse.next());
}

export const config = {
  matcher: "/api/:path*",
};
