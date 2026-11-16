import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("./featured-catalog", () => ({ getFeaturedPublication: vi.fn() }));
import { getFeaturedPublication } from "./featured-catalog";
import { GET } from "@/app/api/skills/featured/route";
import release from "./catalog/featured-20261105-01.json";
import type { FeaturedPublication } from "../../featured-skills";
function req(headers: Record<string, string> = {}, query = "") {
  return new Request(`http://localhost:3000/api/skills/featured${query}`, {
    headers: { host: "localhost:3000", ...headers },
  });
}
beforeEach(() => {
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("PROMPTMASTER_DEMO_API_ENABLED", "true");
  vi.mocked(getFeaturedPublication)
    .mockReset()
    .mockReturnValue(structuredClone(release) as FeaturedPublication);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
it("guards production, disabled, loopback and cross-site boundaries before reading", async () => {
  vi.stubEnv("NODE_ENV", "production");
  expect((await GET(req())).status).toBe(404);
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("PROMPTMASTER_DEMO_API_ENABLED", "false");
  expect((await GET(req())).status).toBe(404);
  vi.stubEnv("PROMPTMASTER_DEMO_API_ENABLED", "true");
  expect((await GET(req({ host: "public.example" }))).status).toBe(404);
  expect((await GET(req({ origin: "http://evil.test" }))).status).toBe(403);
  expect((await GET(req({ "sec-fetch-site": "cross-site" }))).status).toBe(403);
  expect(getFeaturedPublication).not.toHaveBeenCalled();
});
it("rejects arbitrary client URLs and owner queries; no network or personalized reads", async () => {
  const network = vi.spyOn(globalThis, "fetch");
  const response = await GET(req({}, "?url=https://evil.test&ownerId=other"));
  expect(response.status).toBe(400);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(getFeaturedPublication).not.toHaveBeenCalled();
  expect(network).not.toHaveBeenCalled();
});
it("returns only a whole saved publication with no-store, without network", async () => {
  const network = vi.spyOn(globalThis, "fetch");
  const response = await GET(req());
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual(release);
  expect(network).not.toHaveBeenCalled();
});
it("sanitizes failure and marks failed and blocked responses no-store", async () => {
  vi.mocked(getFeaturedPublication).mockImplementation(() => {
    throw new Error("PRIVATE_SENTINEL");
  });
  const response = await GET(req());
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: "FEATURED_CATALOG_UNAVAILABLE" });
  expect(response.headers.get("cache-control")).toBe("no-store");
  vi.stubEnv("NODE_ENV", "production");
  expect((await GET(req())).headers.get("cache-control")).toBe("no-store");
});
vi.mock("@/lib/server/accounts", async (original) => ({
  ...(await original<typeof import("@/lib/server/accounts")>()),
  sessionActor: vi.fn(async () => ({
    id: "usr_unit_fixture",
    email: "fixture@example.test",
    role: "USER",
  })),
}));
