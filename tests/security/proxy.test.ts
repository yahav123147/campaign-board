import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";

function request(method: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://127.0.0.1:3000/api/runs", {
    method,
    headers: { host: "127.0.0.1:3000", ...headers },
  });
}

describe("local API proxy", () => {
  it("accepts guarded same-origin JSON mutations", () => {
    const response = proxy(request("POST", {
      origin: "http://127.0.0.1:3000",
      "x-campaign-council-request": "1",
      "content-type": "application/json",
      "content-length": "20",
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it.each([
    ["foreign host", { host: "attacker.test" }],
    ["host with userinfo", { host: "attacker.test@localhost:3000" }],
    ["host with a path", { host: "localhost:3000/api/runs" }],
    ["host with a query", { host: "localhost:3000?target=attacker.test" }],
    ["foreign origin", { origin: "https://evil.test", "x-campaign-council-request": "1" }],
    ["missing guard", { origin: "http://127.0.0.1:3000" }],
    ["cross-site", { "sec-fetch-site": "cross-site" }],
  ])("rejects %s", (_label, headers) => {
    expect(proxy(request("POST", headers)).status).toBe(403);
  });

  it("rejects non-JSON and oversized bodies before a route runs", () => {
    const base = { origin: "http://127.0.0.1:3000", "x-campaign-council-request": "1" };
    expect(proxy(request("POST", { ...base, "content-type": "text/plain", "content-length": "4" })).status).toBe(415);
    expect(proxy(request("POST", { ...base, "content-type": "application/json", "content-length": String(1024 * 1024 + 1) })).status).toBe(413);
  });

  it("allows same-origin API reads and rejects cross-site reads", () => {
    expect(proxy(request("GET", { "sec-fetch-site": "same-origin" })).status).toBe(200);
    expect(proxy(request("GET", { "sec-fetch-site": "cross-site" })).status).toBe(403);
  });
});
