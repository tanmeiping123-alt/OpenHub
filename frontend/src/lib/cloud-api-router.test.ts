import { expect, it } from "vitest";
import { dispatchApi } from "../../cloudflare/api-router";
it("prioritizes explicit auth routes over dynamic actions and passes decoded params", async () => {
  const routes = {
    "../src/app/api/auth/[action]/route.ts": async () => ({ GET: async (_r: Request, ctx: { params: Promise<Record<string, string>> }) => Response.json(await ctx.params) }),
    "../src/app/api/auth/github/route.ts": async () => ({ GET: async () => new Response(null, { status: 302, headers: { Location: "https://auth.example/" } }) }),
  };
  expect((await dispatchApi(new Request("https://openhub.example/api/auth/github"), routes)).status).toBe(302);
  expect(await (await dispatchApi(new Request("https://openhub.example/api/auth/session"), routes)).json()).toEqual({ action: "session" });
});
it("rejects unknown routes, encoded path separators and unsupported methods", async () => {
  const routes = { "../src/app/api/health/route.ts": async () => ({ GET: async () => Response.json({ status: "ok" }) }) };
  expect((await dispatchApi(new Request("https://openhub.example/api/nope"), routes)).status).toBe(404);
  expect((await dispatchApi(new Request("https://openhub.example/api/%2fhealth"), routes)).status).toBe(404);
  const unsupported = await dispatchApi(new Request("https://openhub.example/api/health", { method: "POST" }), routes);
  expect(unsupported.status).toBe(405);
  expect(unsupported.headers.get("allow")).toBe("GET, HEAD, OPTIONS");
});
