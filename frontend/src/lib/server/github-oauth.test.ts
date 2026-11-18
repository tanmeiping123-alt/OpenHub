import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
const state = vi.hoisted(() => ({ login: vi.fn(), session: vi.fn() }));
vi.mock("./accounts", async (original) => ({ ...(await original<typeof import("./accounts")>()), authenticateExternalIdentity: state.login, createSession: state.session }));
import { beginGithubLogin, finishGithubLogin } from "./github-oauth";
const origin = "https://openhub.example.com";
const subject = "3c189e1a-bb3d-41f9-b7c9-670e44755ef6";
const http = vi.fn();
function request(path: string, cookie?: string, site = "same-origin") {
  return new Request(origin + path, { headers: { host: "openhub.example.com", "x-forwarded-host": "openhub.example.com", "x-forwarded-proto": "https", "sec-fetch-site": site, ...(cookie ? { cookie } : {}) } });
}
beforeEach(() => {
  vi.stubEnv("PROMPTMASTER_DEPLOYMENT_MODE", "cloudflare-workers");
  vi.stubEnv("PROMPTMASTER_DEMO_API_ENABLED", "true");
  vi.stubEnv("OPENHUB_PUBLIC_ORIGIN", origin);
  vi.stubEnv("SUPABASE_URL", "https://fixture.supabase.co");
  vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "fixture-key");
  vi.stubGlobal("fetch", http);
  http.mockImplementation(async (url: string) => Response.json(url.endsWith("/user") ? { id: subject, email: "person@example.com", email_confirmed_at: "2026-11-17T00:00:00Z" } : { access_token: "SECRET_ACCESS", refresh_token: "SECRET_REFRESH" }));
  state.login.mockResolvedValue({ id: "usr_fixture", email: "person@example.com", role: "USER" });
  state.session.mockResolvedValue("a".repeat(64));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
it("starts PKCE with a protected short-lived cookie and the exact callback", async () => {
  const response = await beginGithubLogin(request("/api/auth/github?next=/zh-CN/app"));
  expect(response.status).toBe(302);
  const target = new URL(response.headers.get("location")!);
  expect(target.origin).toBe("https://fixture.supabase.co");
  expect(target.searchParams.get("provider")).toBe("github");
  expect(target.searchParams.get("redirect_to")).toBe(origin + "/api/auth/callback");
  const cookie = response.headers.get("set-cookie")!;
  expect(cookie).toContain("HttpOnly; Secure; SameSite=Lax; Max-Age=600");
  const pending = JSON.parse(Buffer.from(cookie.split(";")[0].split("=")[1], "base64url").toString());
  expect(target.searchParams.get("code_challenge")).toBe(createHash("sha256").update(pending.verifier).digest("base64url"));
});
it("exchanges the code server-side and preserves Strict session cookies", async () => {
  const start = await beginGithubLogin(request("/api/auth/github?next=/zh-CN/app"));
  const response = await finishGithubLogin(request("/api/auth/callback?code=fixture_auth_code", start.headers.get("set-cookie")!.split(";")[0], "cross-site"));
  expect(response.status).toBe(200);
  expect(state.login).toHaveBeenCalledWith({ subject, email: "person@example.com" });
  expect(response.headers.get("set-cookie")).toContain("SameSite=Strict");
  const html = await response.text();
  expect(html).toContain("/zh-CN/app");
  expect(html).not.toContain("SECRET_");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(JSON.parse(http.mock.calls[0][1].body)).toMatchObject({ auth_code: "fixture_auth_code" });
});
it("rejects missing, duplicate, expired cookies and duplicate codes before contacting Auth", async () => {
  const start = await beginGithubLogin(request("/api/auth/github"));
  const cookie = start.headers.get("set-cookie")!.split(";")[0];
  const expired = "__Host-openhub_oauth=" + Buffer.from(JSON.stringify({ verifier: "a".repeat(43), issuedAt: 0, next: "/en/app" })).toString("base64url");
  for (const [suffix, value] of [["?code=fixture_auth_code", undefined], ["?code=fixture_auth_code", `${cookie}; ${cookie}`], ["?code=fixture_auth_code", expired], ["?code=first_code&code=second_code", cookie]]) {
    const response = await finishGithubLogin(request("/api/auth/callback" + suffix, value));
    expect(response.status).toBe(400);
  }
  expect(http).not.toHaveBeenCalled();
  expect(state.session).not.toHaveBeenCalled();
});
it("rejects unconfirmed identities and provider failures without issuing a session", async () => {
  const start = await beginGithubLogin(request("/api/auth/github"));
  http.mockImplementation(async (url: string) => Response.json(url.endsWith("/user") ? { id: subject, email: "person@example.com" } : { access_token: "SECRET_ACCESS" }));
  const response = await finishGithubLogin(request("/api/auth/callback?code=fixture_auth_code", start.headers.get("set-cookie")!.split(";")[0]));
  expect(response.status).toBe(403);
  expect(state.session).not.toHaveBeenCalled();
  expect(await response.text()).not.toContain("SECRET_ACCESS");
});
it("blocks local mode, hostile hosts and cross-site initiation", async () => {
  expect((await beginGithubLogin(request("/api/auth/github", undefined, "cross-site"))).status).toBe(403);
  const hostile = new Request("https://evil.example/api/auth/callback?code=fixture_auth_code", { headers: { host: "evil.example" } });
  expect((await finishGithubLogin(hostile)).status).toBe(404);
  vi.stubEnv("PROMPTMASTER_DEPLOYMENT_MODE", "local");
  expect((await beginGithubLogin(request("/api/auth/github"))).status).toBe(404);
  expect(http).not.toHaveBeenCalled();
});
it("does not accept an external return destination", async () => {
  const start = await beginGithubLogin(request("/api/auth/github?next=https://evil.example"));
  const response = await finishGithubLogin(request("/api/auth/callback?code=fixture_auth_code", start.headers.get("set-cookie")!.split(";")[0]));
  expect(await response.text()).not.toContain("evil.example");
});
