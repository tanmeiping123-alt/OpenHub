import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("@/lib/server/accounts", async (original) => ({
  ...(await original<typeof import("@/lib/server/accounts")>()),
  sessionActor: vi.fn(async () => null),
}));
import { sessionActor } from "./accounts";
const routes = import.meta.glob("../../app/api/**/route.ts");
// These reads are intentionally anonymous. Pelican's preview session controls
// operate only on publication-gated resources, not on model executions.
const publicGets = new Set([
  "../../app/api/community/route.ts",
  "../../app/api/community/[id]/route.ts",
  "../../app/api/community/creators/[id]/route.ts",
  "../../app/api/community/viewer/route.ts",
  "../../app/api/pelican/route.ts",
  "../../app/api/pelican/viewer/route.ts",
  "../../app/api/pelican/samples/[id]/thumbnail/route.ts",
  "../../app/api/pelican/preview/[id]/route.ts",
]);
const publicPosts = new Set([
  "../../app/api/pelican/preview/route.ts",
  "../../app/api/pelican/preview/[id]/route.ts",
]);
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("PROMPTMASTER_DEMO_API_ENABLED", "true");
});
afterEach(() => vi.unstubAllEnvs());
for (const [path, load] of Object.entries(routes)) {
  if (path.includes("/auth/")) continue;
  it(`${path} private handlers reject anonymous access before any business work`, async () => {
    const handlers = (await load()) as Record<string, unknown>;
    let checked = 0;
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
      if (typeof handlers[method] !== "function") continue;
      if (method === "GET" && publicGets.has(path)) continue;
      if (method === "POST" && publicPosts.has(path)) continue;
      checked++;
      const request = new Request("http://localhost:3000/api/test", {
        method,
        headers: {
          host: "localhost:3000",
          origin: "http://localhost:3000",
          "content-type": "application/json",
          "x-owner-id": "usr_local_demo_01",
        },
        ...(method === "GET" ? {} : { body: "{}" }),
      });
      const handler = handlers[method] as (r: Request, c: unknown) => Promise<Response>;
      const response = await handler(request, {
        params: Promise.resolve({ promptId: "victim", jobId: "victim" }),
      });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "AUTH_REQUIRED" });
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    if (checked) expect(sessionActor).toHaveBeenCalled();
  });
}
