import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";
import { sessionActor } from "@/lib/server/accounts";
vi.mock("@/lib/server/db", () => ({
  withTransaction: vi.fn(async (work) =>
    work({
      query: vi.fn(async () => ({
        rows: [
          {
            provider: "siliconflow",
            requested_model: "zai-org/GLM-5.3",
            native_currency: "CNY",
            native_input_per_million: 8,
            native_output_per_million: 28,
            native_cache_hit_per_million: 2,
            budget_usd_per_native_unit: 0.2,
            source_url: "https://siliconflow.cn/pricing",
            valid_until: "2026-12-06",
          },
        ],
      })),
    }),
  ),
}));
vi.mock("@/lib/server/accounts", async (original) => ({
  ...(await original<typeof import("@/lib/server/accounts")>()),
  sessionActor: vi.fn(async () => ({
    id: "fixture",
    email: "fixture@example.test",
    role: "USER" as const,
  })),
}));
function request(headers = {}) {
  return new Request("http://127.0.0.1:3000/api/models", {
    headers: { host: "127.0.0.1:3000", ...headers },
  });
}
describe("authenticated model settings catalog", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("PROMPTMASTER_DEMO_API_ENABLED", "true");
    vi.stubEnv("PROMPTMASTER_MODEL_MODE", "live");
    vi.stubEnv("SILICONFLOW_API_KEY", "synthetic-private-secret");
    vi.stubEnv("SILICONFLOW_BASE_URL", "https://api.siliconflow.cn/v1");
    vi.stubEnv("SILICONFLOW_MODEL_TIMEOUT_MS", "300000");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });
  it("returns readiness and native price evidence but no credentials or provider calls", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const response = await GET(request());
    const body = await response.json();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body.models).toHaveLength(5);
    expect(body.models.find((m: { key: string }) => m.key === "zai-org/GLM-5.3")).toMatchObject({
      configured: true,
      timeoutMs: 300000,
      pricing: { currency: "CNY", inputPerMillion: 8, budgetUsdPerUnit: 0.2 },
    });
    expect(JSON.stringify(body)).not.toMatch(/synthetic-private-secret|apiKey|Authorization/);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
  it("rejects anonymous and cross-site access", async () => {
    vi.mocked(sessionActor).mockResolvedValueOnce(null);
    expect((await GET(request())).status).toBe(401);
    expect((await GET(request({ "sec-fetch-site": "cross-site" }))).status).toBe(403);
  });
});
