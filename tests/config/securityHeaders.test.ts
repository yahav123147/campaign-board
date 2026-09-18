import { afterEach, describe, expect, it } from "vitest";
import config, { previewOrigin } from "../../next.config";

const originalPreviewPort = process.env.PREVIEW_PORT;

afterEach(() => {
  if (originalPreviewPort === undefined) delete process.env.PREVIEW_PORT;
  else process.env.PREVIEW_PORT = originalPreviewPort;
});

it("keeps 127.0.0.1 in allowedDevOrigins so a manual dev launch without -H still hydrates", () => {
  expect(config.allowedDevOrigins).toContain("127.0.0.1");
});

async function contentSecurityPolicy(): Promise<string> {
  const rules = await config.headers!();
  const header = rules[0]?.headers.find((candidate) => candidate.key === "Content-Security-Policy");
  if (!header) throw new Error("Content-Security-Policy header is missing");
  return header.value;
}

describe("local security headers", () => {
  it("allows frames only from the configured preview origin", async () => {
    process.env.PREVIEW_PORT = "5432";
    const policy = await contentSecurityPolicy();

    expect(policy).toContain("connect-src 'self'");
    expect(policy).toContain("frame-src http://127.0.0.1:5432");
    expect(policy).not.toContain("localhost:*");
    expect(policy).not.toContain("127.0.0.1:*");
  });

  it.each(["abc", "0", "1023", "65536", "4322/path"])(
    "fails closed for invalid PREVIEW_PORT %s",
    (value) => {
      process.env.PREVIEW_PORT = value;
      expect(() => previewOrigin()).toThrow(
        "PREVIEW_PORT must be an integer between 1024 and 65535",
      );
    },
  );
});
