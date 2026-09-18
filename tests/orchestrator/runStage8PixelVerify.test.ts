import { describe, expect, it, vi } from "vitest";
import type { ClientProfile } from "@/config/clientProfile";
import {
  assessStage8Evidence,
  buildStage8Report,
  collectStage8Evidence,
  getGraphJson,
  graphApiBase,
  type MetaReadResult,
  type Stage8Evidence,
} from "@/orchestrator/runStage8PixelVerify";

const NOW = new Date("2026-08-27T12:00:00.000Z");

const PROFILE: ClientProfile = {
  schemaVersion: 1,
  tenant: {
    id: "acme",
    displayName: "Acme Ltd",
    locale: "he-IL",
    timezone: "Asia/Jerusalem",
  },
  brand: { publicName: "Acme", facts: ["Verified fact"] },
  policies: {
    contentRules: [],
    advertisingRules: [],
    operationalRules: [],
    capabilities: {
      landingPageBuild: false,
      metaPixelRead: true,
      metaCampaignCreatePaused: true,
    },
  },
  landing: { publicBaseUrl: "https://offers.example.test" },
  meta: {
    accountId: "act_123456789",
    pixelId: "123456789",
    customConversionId: "423456789",
    pageId: "223456789",
    instagramActorId: "323456789",
    domain: "offers.example.test",
    tokenKeychainService: "acme-meta",
  },
};

function ok(data: unknown): MetaReadResult {
  return { ok: true, data };
}

function evidence(overrides: Partial<Stage8Evidence> = {}): Stage8Evidence {
  return {
    checkedAt: NOW.toISOString(),
    windowStart: "2026-08-20T12:00:00.000Z",
    windowEnd: NOW.toISOString(),
    accountId: "act_123456789",
    pixelId: "123456789",
    customConversionId: "423456789",
    domain: "offers.example.test",
    pixelInfo: ok({
      id: "123456789",
      name: "Acme Pixel",
      is_unavailable: false,
      last_fired_time: "2026-08-27T10:00:00.000Z",
    }),
    pixelAccounts: ok({ data: [{ id: "act_123456789", name: "Acme" }] }),
    eventStats: ok({ data: [] }),
    piiStats: ok({ data: [] }),
    eventSourceStats: ok({ data: [] }),
    hostStats: ok({
      data: [{ aggregation: "host", data: [{ value: "offers.example.test", count: 5 }] }],
    }),
    customConversions: ok({
      data: [{
        id: "423456789",
        event_source_id: "123456789",
        custom_event_type: "PURCHASE",
        is_archived: false,
        is_unavailable: false,
      }],
    }),
    accountInfo: ok({ id: "act_123456789", name: "Acme", account_status: 1 }),
    ...overrides,
  };
}

describe("typed Stage 8 evidence gate", () => {
  it("does not infer Purchase or PII from a healthy generic stats response", () => {
    const input = evidence({
      eventStats: ok({
        data: [{ aggregation: "event", data: [{ value: "PageView", count: 900 }] }],
      }),
      piiStats: ok({ data: [{ status: "ok", total: 900 }] }),
    });

    const assessment = assessStage8Evidence(input);

    expect(assessment.ready).toBe(false);
    expect(assessment.purchaseCount).toBe(0);
    expect(assessment.purchaseWithPiiCount).toBeNull();
    expect(assessment.blockers.join(" ")).toContain("had_pii");
    expect(buildStage8Report(PROFILE, input, assessment)).toContain("RESULT: FAIL");
  });

  it("passes only with explicit Purchase, had_pii, server source, pixel, and account evidence", () => {
    const input = evidence({
      eventStats: ok({
        data: [{ aggregation: "event", data: [{ value: "Purchase", count: 5 }] }],
      }),
      piiStats: ok({
        data: [
          {
            aggregation: "had_pii",
            data: [
              { value: true, count: 4 },
              { value: false, count: 1 },
            ],
          },
        ],
      }),
      eventSourceStats: ok({
        data: [
          {
            aggregation: "event_source",
            data: [
              { value: "server", count: 3 },
              { value: "browser", count: 2 },
            ],
          },
        ],
      }),
    });

    const assessment = assessStage8Evidence(input);

    expect(assessment).toMatchObject({
      ready: true,
      purchaseCount: 5,
      purchaseWithPiiCount: 4,
      purchaseWithoutPiiCount: 1,
      serverPurchaseCount: 3,
      browserPurchaseCount: 2,
    });
    const report = buildStage8Report(PROFILE, input, assessment);
    expect(report).toContain("RESULT: PASS");
    expect(report).toContain("בקשות GET בלבד");
    expect(report).toContain("לא בוצעו POST, PATCH או DELETE");
  });

  it("uses the documented had_pii and event_source aggregations through GET-only dependencies", async () => {
    const calls: Array<{ path: string; query: Readonly<Record<string, string>>; token: string }> = [];
    const readToken = vi.fn(async () => "secret-token");
    const getJson = vi.fn(async (
      resourcePath: string,
      query: Readonly<Record<string, string>>,
      token: string,
    ) => {
      calls.push({ path: resourcePath, query, token });
      return ok({ data: [] });
    });

    const result = await collectStage8Evidence(PROFILE, {
      now: NOW,
      dependencies: { readToken, getJson },
    });

    expect(readToken).toHaveBeenCalledWith("acme-meta", undefined);
    expect(calls).toHaveLength(8);
    expect(calls).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: "123456789/stats",
        query: expect.objectContaining({ aggregation: "had_pii", event: "Purchase" }),
      }),
      expect.objectContaining({
        path: "123456789/stats",
        query: expect.objectContaining({ aggregation: "event_source", event: "Purchase" }),
      }),
      expect.objectContaining({
        path: "123456789/stats",
        query: expect.objectContaining({ aggregation: "host", event: "Purchase" }),
      }),
      expect.objectContaining({ path: "123456789/adaccounts" }),
    ]));
    expect(JSON.stringify(result)).not.toContain("secret-token");
  });

  it.each([
    ["wrong account", { pixelAccounts: ok({ data: [{ id: "act_999999999" }] }) }],
    ["wrong domain", { hostStats: ok({ data: [{ aggregation: "host", data: [{ value: "other.test", count: 9 }] }] }) }],
    ["wrong conversion pixel", { customConversions: ok({ data: [{ id: "423456789", event_source_id: "999999999", custom_event_type: "PURCHASE" }] }) }],
    ["archived conversion", { customConversions: ok({ data: [{ id: "423456789", event_source_id: "123456789", custom_event_type: "PURCHASE", is_archived: true }] }) }],
  ])("fails closed for a %s relationship", (_name, override) => {
    const input = evidence({
      eventStats: ok({ data: [{ aggregation: "event", data: [{ value: "Purchase", count: 5 }] }] }),
      piiStats: ok({ data: [{ aggregation: "had_pii", data: [{ value: true, count: 5 }] }] }),
      eventSourceStats: ok({ data: [{ aggregation: "event_source", data: [{ value: "server", count: 5 }] }] }),
      ...override,
    });

    expect(assessStage8Evidence(input).ready).toBe(false);
  });

  it("sends the credential only in an authorization header on bounded GET requests", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      void input;
      void init;
      return new Response(JSON.stringify({ id: "123456789" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      getGraphJson("123456789", { fields: "id,name" }, "secret-token"),
    ).resolves.toEqual({ ok: true, data: { id: "123456789" } });

    const [rawUrl, init] = fetchMock.mock.calls[0];
    const url = new URL(String(rawUrl));
    expect(url.origin).toBe("https://graph.facebook.com");
    expect(url.pathname).toBe("/v26.0/123456789");
    expect(url.searchParams.get("fields")).toBe("id,name");
    expect(url.href).not.toContain("secret-token");
    expect(init).toMatchObject({
      method: "GET",
      redirect: "error",
      headers: { Authorization: "Bearer secret-token" },
    });

    vi.unstubAllGlobals();
  });

  it("allows only a version segment, never an alternate Meta API host", () => {
    expect(graphApiBase({ META_GRAPH_API_VERSION: "v27.0" }).href)
      .toBe("https://graph.facebook.com/v27.0/");
    expect(() => graphApiBase({ META_GRAPH_API_VERSION: "https://evil.example/" }))
      .toThrow("must look like v26.0");
    expect(() => graphApiBase({ META_GRAPH_API_VERSION: "v26.1" }))
      .toThrow("must look like v26.0");
  });
});
