import http from "node:http";
import zlib from "node:zlib";
import type { AddressInfo } from "node:net";

function crc32(buffer: Buffer): number {
  let crc = ~0;
  for (const byte of buffer) {
    crc ^= byte;
    for (let k = 0; k < 8; k += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A valid solid-colour PNG, so the browser decodes it and naturalWidth > 0. */
export function solidPng(width = 64, height = 64): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x7f)]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * Serves `/<page>` as HTML and `/<page>/<file>.png` as a PNG when the file is
 * listed. Anything else is 404, which is how a broken image is simulated.
 */
export async function startProbeFixtureServer(
  pages: Record<string, { html: string; images: string[] }>,
): Promise<{ origin: string; close: () => Promise<void> }> {
  const png = solidPng();
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://fixture").pathname;
    const pageMatch = /^\/([a-z0-9-]+)$/.exec(pathname);
    if (pageMatch && pages[pageMatch[1]]) {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(pages[pageMatch[1]].html);
      return;
    }
    const assetMatch = /^\/([a-z0-9-]+)\/([a-z0-9-]+\.png)$/.exec(pathname);
    if (assetMatch && pages[assetMatch[1]]?.images.includes(assetMatch[2])) {
      response.writeHead(200, { "content-type": "image/png" });
      response.end(png);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export function htmlPage(body: string, head = ""): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${head}<style>body{margin:0}</style></head><body>${body}</body></html>`;
}
