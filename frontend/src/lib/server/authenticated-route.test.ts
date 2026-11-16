import { beforeEach, afterEach, expect, it, vi } from "vitest";
vi.mock("./accounts", async (original) => ({
  ...(await original<typeof import("./accounts")>()),
  sessionActor: vi.fn(),
}));
import { sessionActor, AccountError } from "./accounts";
import { withIdentity, boundedJson } from "./authenticated-route";
import { workspaceOwnerId } from "./identity-context";
beforeEach(() => {
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("PROMPTMASTER_DEMO_API_ENABLED", "true");
  vi.mocked(sessionActor).mockReset();
});
afterEach(() => vi.unstubAllEnvs());
function req(headers: Record<string, string> = {}) {
  return new Request("http://localhost:3000/api/skills/library", {
    headers: { host: "localhost:3000", ...headers },
  });
}
it("requires a session before calling protected work and adds no-store", async () => {
  vi.mocked(sessionActor).mockResolvedValue(null);
  const handler = vi.fn();
  const response = await withIdentity(handler)(req());
  expect(response.status).toBe(401);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(handler).not.toHaveBeenCalled();
});
it("invalid sessions never become anonymous legacy owners", async () => {
  vi.mocked(sessionActor).mockRejectedValue(new AccountError("AUTH_REQUIRED", 401));
  const handler = vi.fn();
  expect((await withIdentity(handler)(req())).status).toBe(401);
  expect(handler).not.toHaveBeenCalled();
});
it("binds authenticated owner, restores context and never accepts owner headers", async () => {
  vi.mocked(sessionActor).mockResolvedValue({
    id: "real-user",
    email: "test@example.test",
    role: "USER",
  });
  const r = await withIdentity(
    async () => Response.json({ owner: workspaceOwnerId() }),
    true,
  )(req({ "x-owner-id": "victim" }));
  expect(await r.json()).toEqual({ owner: "real-user" });
  expect(() => workspaceOwnerId()).toThrow("AUTH_REQUIRED");
});
it("rejects cross-site and remote requests before session lookup", async () => {
  const handler = vi.fn();
  expect((await withIdentity(handler, true)(req({ "sec-fetch-site": "cross-site" }))).status).toBe(
    403,
  );
  expect((await withIdentity(handler, true)(req({ host: "evil.test" }))).status).toBe(404);
  expect(sessionActor).not.toHaveBeenCalled();
  expect(handler).not.toHaveBeenCalled();
});
it("sanitizes exceptions without leaking credentials or database details", async () => {
  vi.mocked(sessionActor).mockRejectedValue(new Error("PRIVATE_DATABASE_DETAILS"));
  const r = await withIdentity(vi.fn(), true)(req());
  expect(r.status).toBe(503);
  expect(await r.text()).not.toContain("PRIVATE_DATABASE_DETAILS");
});
it("bounds JSON bytes and rejects malformed utf8", async () => {
  for (const body of [" ".repeat(4097), new Uint8Array([0xff])]) {
    await expect(
      boundedJson(
        new Request("http://localhost/", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        }),
      ),
    ).rejects.toBeInstanceOf(AccountError);
  }
});
