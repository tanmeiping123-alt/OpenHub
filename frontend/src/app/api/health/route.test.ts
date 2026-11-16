import { afterEach, expect, it, vi } from "vitest";
vi.mock("@/lib/server/db", () => ({ getPool: () => ({ query: ping }) }));
const { ping } = vi.hoisted(() => ({ ping: vi.fn(async () => ({ rows: [{ ready: 1 }] })) }));
import { GET } from "./route";
import { beginBackgroundWork } from "@/lib/server/runtime-activity";
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

it("returns an uncached readiness signal without disclosing database settings", async () => {
  const response = await GET(new Request("https://openhub.example/api/health"));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: "ok" });
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.has("x-openhub-background-active")).toBe(false);
});

it("exposes background activity only to the container controller", async () => {
  vi.stubEnv("OPENHUB_INTERNAL_TOKEN", "controller-token");
  const finish = beginBackgroundWork();
  try {
    const request = (token: string) => new Request("https://openhub.example/api/health", { headers: { "x-openhub-internal-token": token } });
    expect((await GET(request("attacker"))).headers.has("x-openhub-background-active")).toBe(false);
    expect((await GET(request("controller-token"))).headers.get("x-openhub-background-active")).toBe("1");
    finish();
    expect((await GET(request("controller-token"))).headers.get("x-openhub-background-active")).toBe("0");
  } finally { finish(); }
});

it("reports unavailable storage without exposing the underlying error", async () => {
  ping.mockRejectedValueOnce(new Error("private connection detail"));
  const response = await GET(new Request("https://openhub.example/api/health"));
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ status: "unavailable" });
});
