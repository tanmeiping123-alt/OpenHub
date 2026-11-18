import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ fetch: vi.fn<(request: Request) => Promise<Response>>(async () => new Response("app")), database: vi.fn(async (_url: string, work: () => Promise<Response>) => work()) }));
vi.mock("../../../cloudflare/api-router", () => ({ dispatchApi: mocks.fetch }));
vi.mock("./db-workers", () => ({ withWorkerDatabase: mocks.database }));
import worker from "../../../cloudflare/worker";
const env = { OPENHUB_PUBLIC_ORIGIN: "https://openhub.example", HYPERDRIVE: { connectionString: "postgresql://fixture" }, SUPABASE_URL: "https://fixture.supabase.co", SUPABASE_PUBLISHABLE_KEY: "fixture" };
const ctx = { waitUntil: vi.fn() };
afterEach(() => vi.clearAllMocks());
it("replaces caller proxy headers with the validated public origin", async () => {
  const response = await worker.fetch(new Request("https://openhub.example/api/test", { headers: { host: "attacker.example", "x-forwarded-host": "attacker.example", "x-forwarded-proto": "http", "x-openhub-internal-token": "attacker" } }), env, ctx);
  expect(await response.text()).toBe("app");
  const request = mocks.fetch.mock.calls[0][0] as Request;
  expect(request.headers.get("host")).toBe("openhub.example");
  expect(request.headers.get("x-forwarded-host")).toBe("openhub.example");
  expect(request.headers.get("x-forwarded-proto")).toBe("https");
  expect(request.headers.has("x-openhub-internal-token")).toBe(false);
  expect(mocks.database).toHaveBeenCalledWith("postgresql://fixture", expect.any(Function));
});
it("rejects an alternate host without opening database connections", async () => {
  expect((await worker.fetch(new Request("https://attacker.example/"), env, ctx)).status).toBe(404);
  expect(mocks.database).not.toHaveBeenCalled();
});
it("fails closed until all required free services are configured", async () => {
  for (const change of [{ HYPERDRIVE: undefined }, { SUPABASE_URL: "" }, { SUPABASE_PUBLISHABLE_KEY: "" }, { OPENHUB_PUBLIC_ORIGIN: "https://user:password@openhub.example" }]) {
    expect((await worker.fetch(new Request("https://openhub.example/"), { ...env, ...change }, ctx)).status).toBe(503);
  }
  expect(mocks.fetch).not.toHaveBeenCalled();
});
