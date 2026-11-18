import { afterEach, describe, expect, it, vi } from "vitest";
import { apiError, evaluationPayloadError, guardLocalDemoApi, validLayer } from "./api";

afterEach(() => {
  vi.unstubAllEnvs();
});

function request(host: string, origin?: string) {
  return new Request("http://localhost/api/demo/snapshot", {
    headers: { host, ...(origin ? { origin } : {}) },
  });
}

describe("local demo API boundary", () => {
  it("accepts the canonical Workers origin while rejecting forged forwarding headers", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PROMPTMASTER_DEMO_API_ENABLED", "true");
    vi.stubEnv("PROMPTMASTER_DEPLOYMENT_MODE", "cloudflare-workers");
    vi.stubEnv("OPENHUB_PUBLIC_ORIGIN", "https://openhub.example");
    const headers = { host: "openhub.example", "x-forwarded-host": "openhub.example", "x-forwarded-proto": "https", origin: "https://openhub.example" };
    expect(guardLocalDemoApi(new Request("https://openhub.example/api/test", { headers }), true)).toBeNull();
    expect(guardLocalDemoApi(new Request("https://openhub.example/api/test", { headers: { ...headers, origin: "https://evil.example" } }), true)?.status).toBe(403);
  });
  it("is disabled unless explicitly enabled outside production", () => {
    vi.stubEnv("PROMPTMASTER_DEMO_API_ENABLED", "false");
    vi.stubEnv("NODE_ENV", "development");
    expect(guardLocalDemoApi(request("localhost:3000"))?.status).toBe(404);
    vi.stubEnv("PROMPTMASTER_DEMO_API_ENABLED", "true");
    vi.stubEnv("NODE_ENV", "production");
    expect(guardLocalDemoApi(request("localhost:3000"))?.status).toBe(404);
  });

  it("rejects non-loopback hosts and cross-origin writes", () => {
    vi.stubEnv("PROMPTMASTER_DEMO_API_ENABLED", "true");
    vi.stubEnv("NODE_ENV", "development");
    expect(guardLocalDemoApi(request("192.168.1.20:3000"))?.status).toBe(404);
    expect(guardLocalDemoApi(request("localhost:3000", "http://evil.test"), true)?.status).toBe(
      403,
    );
    expect(guardLocalDemoApi(request("localhost:3000", "http://localhost:3000"), true)).toBeNull();
  });

  it("allows production API access only for the explicitly configured HTTPS origin", () => {
    vi.stubEnv("PROMPTMASTER_DEMO_API_ENABLED", "true");
    vi.stubEnv("PROMPTMASTER_DEPLOYMENT_MODE", "cloudflare-container");
    vi.stubEnv("OPENHUB_PUBLIC_ORIGIN", "https://openhub.example");
    vi.stubEnv("NODE_ENV", "production");
    const cloudRequest = new Request("https://openhub.example/api/prompts", {
      headers: {
        host: "openhub.example",
        "x-forwarded-host": "openhub.example",
        "x-forwarded-proto": "https",
        origin: "https://openhub.example",
      },
    });
    expect(guardLocalDemoApi(cloudRequest, true)).toBeNull();
  });

  it("accepts Next's internal listener URL only with canonical proxy headers", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PROMPTMASTER_DEMO_API_ENABLED", "true");
    vi.stubEnv("PROMPTMASTER_DEPLOYMENT_MODE", "cloudflare-container");
    vi.stubEnv("OPENHUB_PUBLIC_ORIGIN", "https://openhub.example");
    const headers = { host: "openhub.example", "x-forwarded-host": "openhub.example", "x-forwarded-proto": "https", origin: "https://openhub.example" };
    expect(guardLocalDemoApi(new Request("https://0.0.0.0:3000/api/test", { headers }), true)).toBeNull();
    for (const overrides of [
      { "x-forwarded-host": "" },
      { "x-forwarded-proto": "" },
      { "x-forwarded-host": "evil.example" },
      { "x-forwarded-host": "openhub.example, evil.example" },
      { "x-forwarded-proto": "http" },
      { "x-forwarded-proto": "https,http" },
    ]) {
      expect(guardLocalDemoApi(new Request("https://0.0.0.0:3000/api/test", { headers: { ...headers, ...overrides } }), true)?.status).toBe(404);
    }
  });

  it("fails closed when cloud configuration or the incoming host is invalid", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PROMPTMASTER_DEMO_API_ENABLED", "true");
    vi.stubEnv("PROMPTMASTER_DEPLOYMENT_MODE", "cloudflare-container");
    const cloud = (url = "https://openhub.example/api/test", host = "openhub.example") =>
      new Request(url, { headers: { host, "x-forwarded-host": "openhub.example", "x-forwarded-proto": "https", origin: "https://openhub.example" } });
    for (const origin of ["", "http://openhub.example", "https://user:pass@openhub.example", "https://openhub.example/path", "https://openhub.example?x=1", "bad"]) {
      vi.stubEnv("OPENHUB_PUBLIC_ORIGIN", origin);
      expect(guardLocalDemoApi(cloud(), true)?.status).toBe(404);
    }
    vi.stubEnv("OPENHUB_PUBLIC_ORIGIN", "https://openhub.example");
    expect(guardLocalDemoApi(cloud(undefined, "evil.example"), true)?.status).toBe(404);
    vi.stubEnv("PROMPTMASTER_DEMO_API_ENABLED", "false");
    expect(guardLocalDemoApi(cloud(), true)?.status).toBe(404);
  });

  it("retains same-origin write checks and rejects cross-site cloud requests", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PROMPTMASTER_DEMO_API_ENABLED", "true");
    vi.stubEnv("PROMPTMASTER_DEPLOYMENT_MODE", "cloudflare-container");
    vi.stubEnv("OPENHUB_PUBLIC_ORIGIN", "https://openhub.example");
    for (const origin of ["", "https://evil.example", "http://openhub.example", "null"]) {
      const r = new Request("https://openhub.example/api/test", { headers: { host: "openhub.example", "x-forwarded-host": "openhub.example", "x-forwarded-proto": "https", origin } });
      expect(guardLocalDemoApi(r, true)?.status).toBe(403);
    }
    const crossSite = new Request("https://openhub.example/api/test", { headers: { host: "openhub.example", "x-forwarded-host": "openhub.example", "x-forwarded-proto": "https", "sec-fetch-site": "cross-site" } });
    expect(guardLocalDemoApi(crossSite)?.status).toBe(403);
  });

  it("does not trust spoofed proxy headers in local mode", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("PROMPTMASTER_DEMO_API_ENABLED", "true");
    const r = new Request("http://evil.example/api/test", { headers: { host: "evil.example", "x-forwarded-host": "localhost:3000", "x-forwarded-proto": "http", origin: "http://localhost:3000" } });
    expect(guardLocalDemoApi(r, true)?.status).toBe(404);
  });

  it("requires a bounded score shape and allows null scores", () => {
    expect(validLayer({ status: "NOT_EXECUTED", score: null, grade: null, dimensions: [] })).toBe(
      true,
    );
    expect(validLayer({ status: "OK", score: 101, grade: null, dimensions: [] })).toBe(false);
    expect(validLayer({ status: "OK", score: null, grade: null, dimensions: "bad" })).toBe(false);
  });

  it("preserves General and unapproved task rubric boundaries", () => {
    const base = {
      versionId: "ver_demo_01",
      rubricVersion: "mock-v1",
      layer1: { status: "MOCK / SIMULATED", score: 80, grade: null, dimensions: [] },
    };
    expect(
      evaluationPayloadError("General", {
        ...base,
        layer2: { status: "NOT_AVAILABLE", score: null, grade: null, dimensions: [] },
      }),
    ).toBeNull();
    expect(
      evaluationPayloadError("General", {
        ...base,
        layer2: { status: "MOCK / SIMULATED", score: 0, grade: null, dimensions: [] },
      }),
    ).toBe("GENERAL_LAYER2_CONTRACT_VIOLATION");
    expect(
      evaluationPayloadError("Data Analysis", {
        ...base,
        layer2: { status: "MOCK / SIMULATED", score: 75, grade: null, dimensions: [] },
      }),
    ).toBe("TASK_RUBRIC_PENDING");
    expect(
      evaluationPayloadError("Writing", {
        ...base,
        totalScore: 77,
        layer2: { status: "MOCK / SIMULATED", score: null, grade: null, dimensions: [] },
      }),
    ).toBe("INVALID_EVALUATION_INPUT");
  });

  it("maps service validation failures to a client input error", async () => {
    const response = apiError(Object.assign(new Error("invalid"), { code: "INVALID_INPUT" }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "INVALID_INPUT" });
  });
});
