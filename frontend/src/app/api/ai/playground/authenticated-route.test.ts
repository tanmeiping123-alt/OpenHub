import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { actor, lookup } = vi.hoisted(() => ({ actor: vi.fn(), lookup: vi.fn() }));
vi.mock("@/lib/server/accounts", async (original) => ({
  ...(await original<typeof import("@/lib/server/accounts")>()),
  sessionActor: actor,
}));
vi.mock("@/lib/server/model/model-repository", () => ({ getPlaygroundRequestStatus: lookup }));
vi.mock("@/lib/server/model/model-service", () => ({ generateLiveSourceModel: vi.fn() }));
import { GET } from "./route";
import { workspaceOwnerId } from "@/lib/server/identity-context";
describe("authenticated Playground recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("PROMPTMASTER_DEMO_API_ENABLED", "true");
    actor.mockResolvedValue({ id: "owner-account", role: "USER", email: "owner@example.test" });
    lookup.mockImplementation(async () => {
      expect(workspaceOwnerId()).toBe("owner-account");
      return { status: "NOT_FOUND" };
    });
  });
  afterEach(() => vi.unstubAllEnvs());
  const request = (headers: Record<string, string> = {}) =>
    new Request("http://127.0.0.1:3000/api/ai/playground?requestKey=request-123", {
      headers: { host: "127.0.0.1:3000", ...headers },
    });
  it("requires authentication without reading receipts", async () => {
    actor.mockResolvedValueOnce(null);
    const response = await GET(request());
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "AUTH_REQUIRED" });
    expect(lookup).not.toHaveBeenCalled();
  });
  it("binds lookup to the authenticated owner and prevents caching", async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(lookup).toHaveBeenCalledWith("request-123");
  });
  it.each<Record<string, string>>([
    { "sec-fetch-site": "cross-site" },
    { origin: "https://evil.test" },
    { host: "public.test" },
  ])("rejects unsafe origin %j", async (headers) => {
    expect([403, 404]).toContain((await GET(request(headers))).status);
    expect(lookup).not.toHaveBeenCalled();
  });
});
