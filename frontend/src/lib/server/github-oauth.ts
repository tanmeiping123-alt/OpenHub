import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { AccountError, authenticateExternalIdentity, cookieToken, createSession, sessionCookie } from "./accounts";
import { exchangeSupabaseCode, supabaseAuthOrigin } from "./supabase-auth";
import { safeWorkspaceNext } from "../auth-navigation";

const pendingName = "__Host-openhub_oauth";
const pendingCookie = (value: string) => `${pendingName}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${value ? 600 : 0}`;
function canonicalOrigin(request: Request) {
  const origin = process.env.OPENHUB_PUBLIC_ORIGIN ?? "";
  try {
    const configured = new URL(origin);
    if (process.env.PROMPTMASTER_DEPLOYMENT_MODE !== "cloudflare-workers" || process.env.PROMPTMASTER_DEMO_API_ENABLED !== "true" ||
        configured.protocol !== "https:" || configured.origin !== origin || new URL(request.url).origin !== origin ||
        request.headers.get("host") !== configured.host || request.headers.get("x-forwarded-host") !== configured.host || request.headers.get("x-forwarded-proto") !== "https") throw new Error();
  } catch { throw new AccountError("NOT_FOUND", 404); }
  return origin;
}
function safeNext(value: unknown) {
  return safeWorkspaceNext(value, typeof value === "string" && value.startsWith("/zh-CN/") ? "zh-CN" : "en");
}
function failure(error: unknown) {
  return Response.json({ error: error instanceof AccountError ? error.code : "ACCOUNT_SERVICE_UNAVAILABLE" }, {
    status: error instanceof AccountError ? error.status : 503,
    headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "Set-Cookie": pendingCookie("") },
  });
}
export async function beginGithubLogin(request: Request) {
  try {
    const origin = canonicalOrigin(request);
    if (request.headers.get("sec-fetch-site") === "cross-site") throw new AccountError("ORIGIN_REJECTED", 403);
    const verifier = randomBytes(32).toString("base64url");
    const next = safeNext(new URL(request.url).searchParams.get("next"));
    const pending = Buffer.from(JSON.stringify({ verifier, next, issuedAt: Date.now() })).toString("base64url");
    const target = new URL(`${supabaseAuthOrigin()}/auth/v1/authorize`);
    target.search = new URLSearchParams({ provider: "github", redirect_to: `${origin}/api/auth/callback`, code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "s256" }).toString();
    return new Response(null, { status: 302, headers: { Location: target.href, "Set-Cookie": pendingCookie(pending), "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
  } catch (error) { return failure(error); }
}
export async function finishGithubLogin(request: Request) {
  try {
    canonicalOrigin(request);
    const params = new URL(request.url).searchParams;
    const code = params.get("code") ?? "";
    const cookies = (request.headers.get("cookie") ?? "").split(";").map(v => v.trim()).filter(v => v.startsWith(`${pendingName}=`));
    if (cookies.length !== 1 || cookies[0].length > 4096 || params.getAll("code").length !== 1 || !/^[a-z0-9._~-]{8,1024}$/i.test(code) || params.has("error")) throw new AccountError("INVALID_OAUTH_CALLBACK", 400);
    let pending;
    try { pending = JSON.parse(Buffer.from(cookies[0].slice(pendingName.length + 1), "base64url").toString("utf8")); } catch { throw new AccountError("INVALID_OAUTH_CALLBACK", 400); }
    if (!pending || typeof pending.verifier !== "string" || !/^[a-z0-9_-]{43}$/i.test(pending.verifier) || !Number.isSafeInteger(pending.issuedAt) || Date.now() - pending.issuedAt > 600_000 || pending.issuedAt > Date.now()) throw new AccountError("INVALID_OAUTH_CALLBACK", 400);
    const identity = await exchangeSupabaseCode(code, pending.verifier);
    const actor = await authenticateExternalIdentity(identity);
    let previous;
    try { const token = cookieToken(request); if (token && /^[a-f0-9]{64}$/.test(token)) previous = token; } catch { /* Recover from stale cookies. */ }
    const token = await createSession(actor, previous);
    const next = safeNext(pending.next);
    // A document ends the cross-site redirect chain before navigating with the Strict session.
    const nonce = randomBytes(16).toString("base64url");
    const destination = JSON.stringify(next).replaceAll("<", "\\u003c").replaceAll("&", "\\u0026");
    const href = next.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>OpenHub</title></head><body><p>登录成功 / Signed in. <a href="${href}">继续 / Continue</a></p><script nonce="${nonce}">try{sessionStorage.removeItem("promptmaster-demo-v1");localStorage.setItem("pm-account-changed",crypto.randomUUID())}catch{}location.replace(${destination});</script></body></html>`;
    const headers = new Headers({ "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'` });
    headers.append("Set-Cookie", pendingCookie(""));
    headers.append("Set-Cookie", sessionCookie(request, token));
    return new Response(html, { headers });
  } catch (error) { return failure(error); }
}
