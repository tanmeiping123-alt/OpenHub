import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getLiveModelQuota } from "@/lib/server/model/model-service";
import { ModelServiceError } from "@/lib/server/model/model-errors";
import { GET } from "./route";
vi.mock("@/lib/server/model/model-service", () => ({ getLiveModelQuota: vi.fn() }));
function request(headers: Record<string, string> = {}) {
  return new Request("http://127.0.0.1:3000/api/ai/quota", {
    headers: { host: "127.0.0.1:3000", ...headers },
  });
}
describe("read-only user quota endpoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("PROMPTMASTER_DEMO_API_ENABLED", "true");
    vi.mocked(getLiveModelQuota).mockResolvedValue({ scope: "USER" } as Awaited<
      ReturnType<typeof getLiveModelQuota>
    >);
  });
  afterEach(() => vi.unstubAllEnvs());
  it("accepts same-origin browser GET without Origin and disables caching", async () => {
    const response = await GET(request({ "sec-fetch-site": "same-origin" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("rejects cross-origin, cross-site and public-host reads", async () => {
    const cases: Record<string, string>[] = [
      { origin: "https://evil.test" },
      { "sec-fetch-site": "cross-site" },
      { host: "public.test" },
    ];
    for (const headers of cases) {
      const response = await GET(request(headers));
      expect([403, 404]).toContain(response.status);
    }
    expect(getLiveModelQuota).not.toHaveBeenCalled();
  });
  it("stays unavailable in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    expect((await GET(request())).status).toBe(404);
    expect(getLiveModelQuota).not.toHaveBeenCalled();
  });
  it("returns explicit pricing/service errors and hides unknown internal details", async () => {
    vi.mocked(getLiveModelQuota).mockRejectedValueOnce(
      new ModelServiceError("MODEL_PRICING_UNAVAILABLE", "Price missing", 503),
    );
    expect(await (await GET(request())).json()).toMatchObject({
      error: "MODEL_PRICING_UNAVAILABLE",
    });
    vi.mocked(getLiveModelQuota).mockRejectedValueOnce(new Error("private connection detail"));
    expect(JSON.stringify(await (await GET(request())).json())).not.toContain(
      "private connection detail",
    );
  });
});
vi.mock("@/lib/server/accounts", async (original) => ({
  ...(await original<typeof import("@/lib/server/accounts")>()),
  sessionActor: vi.fn(async () => ({
    id: "usr_unit_fixture",
    email: "fixture@example.test",
    role: "USER",
  })),
}));
