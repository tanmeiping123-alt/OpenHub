import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/server/accounts", async (original) => ({
  ...(await original<typeof import("@/lib/server/accounts")>()),
  sessionActor: vi.fn(async () => ({ id: "owner", email: "unit@example.test", role: "USER" })),
}));
vi.mock("@/lib/server/model/model-config", () => ({ readModelConfig: vi.fn() }));
vi.mock("@/lib/server/model/model-quota-repository", () => ({ getModelQuotaSummary: vi.fn() }));
vi.mock("@/lib/server/db", () => ({ withTransaction: vi.fn() }));
import { sessionActor } from "@/lib/server/accounts";
import { readModelConfig } from "@/lib/server/model/model-config";
import { getModelQuotaSummary } from "@/lib/server/model/model-quota-repository";
import { withTransaction } from "@/lib/server/db";
import { GET } from "./route";

const request = (query = "?modelKey=deepseek-direct&strength=off", headers = {}) =>
  new Request(`http://127.0.0.1:3000/api/models/availability${query}`, {
    headers: { host: "127.0.0.1:3000", ...headers },
  });
describe("authenticated read-only budget availability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("PROMPTMASTER_DEMO_API_ENABLED", "true");
    vi.mocked(readModelConfig).mockReturnValue({
      mode: "LIVE",
      maxOutputTokens: 393216,
      maxRetries: 2,
      reasoningTokenReserve: 0,
    } as ReturnType<typeof readModelConfig>);
    vi.mocked(getModelQuotaSummary).mockResolvedValue({
      enabled: true,
      frozen: false,
      unlimited: false,
      remainingTokens: 1500000,
      remainingCostUsd: 2,
      periodRemainingTokens: 6000000,
      periodRemainingCostUsd: 5,
      platform: { dailyLimitUsd: 2, dailyUsedUsd: 0, periodLimitUsd: 15, periodUsedUsd: 0 },
    } as Awaited<ReturnType<typeof getModelQuotaSummary>>);
    vi.mocked(withTransaction).mockResolvedValue({ output_usd_per_million: 1.2 });
  });
  afterEach(() => vi.unstubAllEnvs());
  it("uses read-only quota lookup, returns only a lower bound and prevents caching", async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      status: "ready",
      minimumTokens: 1179648,
      minimumUsd: 1.4155776,
    });
    expect(getModelQuotaSummary).toHaveBeenCalledWith(expect.anything(), true);
  });
  it("rejects invalid model settings before reading quota", async () => {
    expect((await GET(request("?modelKey=unknown"))).status).toBe(400);
    expect(getModelQuotaSummary).not.toHaveBeenCalled();
  });
  it("rejects unauthenticated and cross-site requests before reading quota", async () => {
    vi.mocked(sessionActor).mockResolvedValueOnce(null);
    expect((await GET(request())).status).toBe(401);
    expect((await GET(request(undefined, { "sec-fetch-site": "cross-site" }))).status).toBe(403);
    expect(getModelQuotaSummary).not.toHaveBeenCalled();
  });
});
