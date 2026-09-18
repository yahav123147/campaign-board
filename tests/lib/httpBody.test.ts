import { describe, expect, it } from "vitest";
import { HttpBodyError, readJsonBody } from "@/lib/httpBody";
import { trimmedString } from "@/lib/inputLimits";

function jsonRequest(body: BodyInit, headers: HeadersInit = {}): Request {
  return new Request("http://127.0.0.1/api", {
    method: "POST",
    body,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("readJsonBody", () => {
  it("trims strings without trusting declared JSON field types", () => {
    expect(trimmedString("  value  ")).toBe("value");
    expect(trimmedString(123)).toBeUndefined();
    expect(trimmedString({ trim: () => "unsafe" })).toBeUndefined();
  });
  it("parses a bounded JSON stream", async () => {
    await expect(readJsonBody<{ value: string }>(jsonRequest('{"value":"ok"}'), 100))
      .resolves.toEqual({ value: "ok" });
  });

  it("does not trust an absent Content-Length header", async () => {
    const encoder = new TextEncoder();
    const request = new Request("http://127.0.0.1/api", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(`{"value":"${"x".repeat(100)}"}`));
          controller.close();
        },
      }),
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    await expect(readJsonBody(request, 32)).rejects.toMatchObject({ status: 413 });
  });

  it.each([
    [new Request("http://127.0.0.1/api", { method: "POST", body: "{}" }), 415],
    [jsonRequest("not json"), 400],
    [jsonRequest("null"), 400],
    [jsonRequest('"string"'), 400],
    [jsonRequest("[]"), 400],
    [jsonRequest("{}", { "content-length": "999" }), 413],
  ])("rejects invalid request bodies", async (request, status) => {
    await expect(readJsonBody(request, 32)).rejects.toSatisfy(
      (error: unknown) => error instanceof HttpBodyError && error.status === status,
    );
  });
});
