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
