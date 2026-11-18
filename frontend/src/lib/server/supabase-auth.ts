import "server-only";
import { AccountError } from "./account-errors";

export type ExternalIdentity = { subject: string; email: string };

const unavailable = () => new AccountError("ACCOUNT_SERVICE_UNAVAILABLE", 503);
export function supabaseAuthOrigin() {
  const origin = process.env.SUPABASE_URL ?? "";
  try {
    const url = new URL(origin);
    if (url.origin !== origin || url.protocol !== "https:" || !/^[a-z0-9-]+\.supabase\.co$/.test(url.hostname) || !process.env.SUPABASE_PUBLISHABLE_KEY)
      throw unavailable();
  } catch { throw unavailable(); }
  return origin;
}
async function call(path: string, init: RequestInit = {}, register = false) {
  const origin = supabaseAuthOrigin();
  let response: Response;
  try {
    response = await fetch(`${origin}/auth/v1/${path}`, {
      ...init, redirect: "manual",
      headers: { apikey: process.env.SUPABASE_PUBLISHABLE_KEY!, "Content-Type": "application/json", ...init.headers },
      signal: AbortSignal.timeout(10_000),
    });
  } catch { throw unavailable(); }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw unavailable();
  }
  if (response.status === 429) throw new AccountError("TOO_MANY_ATTEMPTS", 429);
  if (!response.ok) {
    if (response.status >= 500) throw unavailable();
    throw new AccountError(register ? "ACCOUNT_UNAVAILABLE" : "INVALID_CREDENTIALS", register ? 409 : 401);
  }
  try { return await response.json(); } catch { throw unavailable(); }
}
async function verifiedIdentity(result: { access_token?: unknown; user?: unknown }, expectedEmail?: string): Promise<ExternalIdentity> {
  if (!result || typeof result.access_token !== "string" || !result.access_token) throw unavailable();
  const user = await call("user", { headers: { Authorization: `Bearer ${result.access_token}` } });
  const email = typeof user?.email === "string" ? user.email.trim().toLowerCase() : "";
  if (!user || typeof user.id !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(user.id) ||
      email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || (expectedEmail !== undefined && email !== expectedEmail)) throw unavailable();
  if (typeof user.email_confirmed_at !== "string" || !Number.isFinite(Date.parse(user.email_confirmed_at)))
    throw new AccountError("EMAIL_CONFIRMATION_REQUIRED", 403);
  return { subject: user.id, email };
}
export async function exchangeSupabaseCode(code: string, verifier: string) {
  return verifiedIdentity(await call("token?grant_type=pkce", {
    method: "POST", body: JSON.stringify({ auth_code: code, code_verifier: verifier }),
  }));
}

// Only the server talks to Auth; provider access/refresh tokens never reach the browser.
export async function authenticateWithSupabase(
  email: string,
  password: string,
  register: boolean,
): Promise<ExternalIdentity> {
  const result = await call(register ? "signup" : "token?grant_type=password", {
    method: "POST", body: JSON.stringify({ email, password }),
  }, register);
  if (!result || typeof result.access_token !== "string" || !result.access_token) {
    if (register && result?.user) throw new AccountError("EMAIL_CONFIRMATION_REQUIRED", 403);
    throw unavailable();
  }
  return verifiedIdentity(result, email);
}
