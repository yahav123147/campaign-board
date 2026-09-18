import { TextDecoder } from "node:util";

export const DEFAULT_JSON_BODY_LIMIT = 256 * 1024;

export class HttpBodyError extends Error {
  readonly name = "HttpBodyError";

  constructor(
    message: string,
    readonly status: 400 | 413 | 415,
  ) {
    super(message);
  }
}

/** Read and parse a request without trusting Content-Length or buffering forever. */
export async function readJsonBody<T = unknown>(
  request: Request,
  maxBytes = DEFAULT_JSON_BODY_LIMIT,
): Promise<T> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new RangeError("JSON body limit must be a positive integer");
  }
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new HttpBodyError("Content-Type must be application/json", 415);
  }
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
    throw new HttpBodyError(`JSON body exceeds the ${maxBytes} byte limit`, 413);
  }
  if (!request.body) throw new HttpBodyError("JSON body is required", 400);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("body-too-large").catch(() => undefined);
        throw new HttpBodyError(`JSON body exceeds the ${maxBytes} byte limit`, 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new HttpBodyError("JSON body must use valid UTF-8", 400);
  }
  try {
    const value: unknown = JSON.parse(text);
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new HttpBodyError("JSON body must be an object", 400);
    }
    return value as T;
  } catch (error) {
    if (error instanceof HttpBodyError) throw error;
    throw new HttpBodyError("Invalid JSON body", 400);
  }
}

export function httpBodyError(error: unknown): { error: string; status: number } {
  if (error instanceof HttpBodyError) return { error: error.message, status: error.status };
  return { error: "Invalid request body", status: 400 };
}
