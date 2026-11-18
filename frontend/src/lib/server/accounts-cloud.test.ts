import { afterEach, beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  query: vi.fn(),
  hash: vi.fn(async () => "local-hash"),
  verify: vi.fn(async () => true),
  linked: null as null | { id: string; email: string; role: string; disabled: boolean },
  existing: false,
}));
vi.mock("./db", () => ({ withTransaction: async (work: (c: unknown) => unknown) => work({ query: state.query }) }));
vi.mock("./password", () => ({ hashPassword: state.hash, verifyPassword: state.verify }));
import { authenticate } from "./accounts";

const subject = "3c189e1a-bb3d-41f9-b7c9-670e44755ef6";
const credentials = { email: "person@example.com", password: "fixture-password" };
const user = { id: subject, email: credentials.email, email_confirmed_at: "2026-11-16T00:00:00Z" };
const http = vi.fn();
beforeEach(() => {
  vi.stubEnv("PROMPTMASTER_DEPLOYMENT_MODE", "cloudflare-workers");
  vi.stubEnv("SUPABASE_URL", "https://fixture.supabase.co");
  vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "fixture-publishable-key");
  vi.stubGlobal("fetch", http);
  state.linked = { id: "usr_linked", email: credentials.email, role: "USER", disabled: false };
  state.existing = false;
  state.query.mockImplementation(async (sql: string) => {
    if (sql.includes("RETURNING attempts")) return { rows: [{ attempts: 1 }], rowCount: 1 };
    if (sql.includes("account_external_identities") && sql.includes("SELECT"))
      return { rows: state.linked ? [state.linked] : [], rowCount: state.linked ? 1 : 0 };
    if (sql.includes("SELECT * FROM (SELECT user_id"))
      return { rows: [{ user_id: "usr_linked", email: credentials.email, role: "USER", password_hash: "local" }] };
    if (sql.includes("SELECT id FROM app_users")) return { rows: state.existing ? [{ id: "usr_existing" }] : [], rowCount: state.existing ? 1 : 0 };
    return { rows: [], rowCount: 0 };
  });
  http.mockImplementation(async (url: string) => Response.json(url.endsWith("/user") ? user : { access_token: "fixture-access-token", user }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

it("uses verified Supabase identity without doing local password work on Workers", async () => {
  await expect(authenticate(credentials)).resolves.toEqual({ id: "usr_linked", email: credentials.email, role: "USER" });
  expect(state.verify).not.toHaveBeenCalled();
  expect(state.hash).not.toHaveBeenCalled();
  expect(http.mock.calls[0][0]).toBe("https://fixture.supabase.co/auth/v1/token?grant_type=password");
  expect(http.mock.calls[1][1].headers.Authorization).toBe("Bearer fixture-access-token");
  expect(http.mock.calls.every(([, options]) => options.redirect === "manual")).toBe(true);
});
it("never falls back to a local password when Supabase rejects credentials", async () => {
  http.mockResolvedValue(Response.json({ error: "invalid_grant" }, { status: 400 }));
  await expect(authenticate(credentials)).rejects.toMatchObject({ code: "INVALID_CREDENTIALS", status: 401 });
  expect(state.verify).not.toHaveBeenCalled();
});
it("rejects Auth redirects without following or creating a session", async () => {
  http.mockResolvedValue(new Response(null, { status: 302, headers: { location: "https://untrusted.example" } }));
  await expect(authenticate(credentials)).rejects.toMatchObject({ code: "ACCOUNT_SERVICE_UNAVAILABLE" });
  expect(http).toHaveBeenCalledTimes(1);
  expect(state.query.mock.calls.some(([sql]) => sql.includes("INSERT INTO app_users"))).toBe(false);
});
it("requires confirmed email and never provisions an unverified identity", async () => {
  http.mockImplementation(async (url: string) => Response.json(url.endsWith("/user") ? { ...user, email_confirmed_at: null } : { access_token: "fixture-access-token" }));
  await expect(authenticate(credentials)).rejects.toMatchObject({ code: "EMAIL_CONFIRMATION_REQUIRED" });
  expect(state.query.mock.calls.some(([sql]) => sql.includes("INSERT INTO app_users"))).toBe(false);
});
it("reports email confirmation after signup without creating a local password", async () => {
  http.mockResolvedValue(Response.json({ user }));
  await expect(authenticate(credentials, true)).rejects.toMatchObject({ code: "EMAIL_CONFIRMATION_REQUIRED" });
  expect(state.hash).not.toHaveBeenCalled();
});
it("refuses to claim an existing local account merely by matching email", async () => {
  state.linked = null;
  state.existing = true;
  await expect(authenticate(credentials)).rejects.toMatchObject({ code: "ACCOUNT_LINK_REQUIRED", status: 403 });
});
it("rejects disabled linked accounts regardless of the external login result", async () => {
  state.linked!.disabled = true;
  await expect(authenticate(credentials)).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
});
it("rejects malformed or substituted external identities", async () => {
  for (const replacement of [{ ...user, id: "bad" }, { ...user, email: "attacker@example.com" }]) {
    http.mockImplementation(async (url: string) => Response.json(url.endsWith("/user") ? replacement : { access_token: "fixture-access-token" }));
    await expect(authenticate(credentials)).rejects.toMatchObject({ code: "ACCOUNT_SERVICE_UNAVAILABLE" });
  }
});
it("fails closed when external authentication is not configured", async () => {
  vi.stubEnv("SUPABASE_URL", "http://untrusted.example");
  await expect(authenticate(credentials)).rejects.toMatchObject({ code: "ACCOUNT_SERVICE_UNAVAILABLE" });
  expect(http).not.toHaveBeenCalled();
});
