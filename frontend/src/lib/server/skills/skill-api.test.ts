import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../accounts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../accounts")>()),
  sessionActor: vi.fn(async () => ({
    id: "test-actor",
    email: "test@example.test",
    role: "ADMIN",
  })),
}));
vi.mock("./skill-registry", () => ({ getSkillRegistrySummary: vi.fn() }));
vi.mock("./github-source-policy", () => ({ APPROVED_GITHUB_IMPORT_SOURCES: [] }));
import { getSkillRegistrySummary } from "./skill-registry";
import { GET } from "@/app/api/skills/route";
import { POST } from "@/app/api/skills/imports/route";

function request(method = "GET", headers: Record<string, string> = {}) {
  return new Request("http://localhost:3000/api/skills", {
    method,
    headers: { host: "localhost:3000", ...headers },
  });
}
describe("Skills API boundary", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("PROMPTMASTER_DEMO_API_ENABLED", "true");
    vi.mocked(getSkillRegistrySummary).mockReset();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  it("guards both handlers in production, when disabled, and off-loopback", async () => {
    vi.stubEnv("NODE_ENV", "production");
    expect((await GET(request())).status).toBe(404);
    expect((await POST(request("POST"))).status).toBe(404);
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("PROMPTMASTER_DEMO_API_ENABLED", "false");
    expect((await GET(request())).status).toBe(404);
    expect((await POST(request("POST"))).status).toBe(404);
    vi.stubEnv("PROMPTMASTER_DEMO_API_ENABLED", "true");
    expect((await GET(request("GET", { host: "public.example" }))).status).toBe(404);
    expect(getSkillRegistrySummary).not.toHaveBeenCalled();
  });
  it("rejects cross-origin reads and requires Origin on reserved writes", async () => {
    expect((await GET(request("GET", { origin: "http://evil.test" }))).status).toBe(403);
    expect((await GET(request("GET", { "sec-fetch-site": "cross-site" }))).status).toBe(403);
    expect((await POST(request("POST"))).status).toBe(403);
    expect((await POST(request("POST", { origin: "http://evil.test" }))).status).toBe(403);
    expect(
      (
        await POST(
          request("POST", { origin: "http://localhost:3000", "sec-fetch-site": "cross-site" }),
        )
      ).status,
    ).toBe(403);
    expect(getSkillRegistrySummary).not.toHaveBeenCalled();
  });
  it("returns no-store summary without any resource content", async () => {
    const summary = {
      stage: "13B-1",
      registry: "OFFLINE_ONLY",
      installed: 0,
      versions: 0,
      pendingReview: 0,
      available: 0,
      githubImport: "NOT_IMPLEMENTED",
      execution: "DISABLED",
    };
    vi.mocked(getSkillRegistrySummary).mockResolvedValue(summary);
    const r = await GET(request());
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(await r.json()).toEqual(summary);
  });
  it("sanitizes database exceptions", async () => {
    vi.mocked(getSkillRegistrySummary).mockRejectedValue(new Error("PRIVATE_SQL_SENTINEL"));
    const r = await GET(request());
    expect(r.status).toBe(503);
    expect(await r.text()).not.toContain("PRIVATE_SQL_SENTINEL");
  });
  it("rejects a malformed import without fetching when the static source list is empty", async () => {
    const req = request("POST", { origin: "http://localhost:3000" });
    const body = vi.spyOn(req, "json");
    const fetch = vi.spyOn(globalThis, "fetch");
    try {
      const r = await POST(req);
      expect(r.status).toBe(400);
      expect(await r.json()).toEqual({ error: "INVALID_IMPORT_REQUEST" });
      expect(body).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      expect(getSkillRegistrySummary).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });
});
