import {
  authenticate,
  createSession,
  sessionCookie,
  cookieToken,
  logout,
  AccountError,
} from "@/lib/server/accounts";
import { boundedJson, withIdentity } from "@/lib/server/authenticated-route";
import { currentActor } from "@/lib/server/identity-context";
type Context = { params: Promise<{ action: string }> };
export const runtime = "nodejs";
export const GET = withIdentity(async (request: Request, context: Context) => {
  if ((await context.params).action !== "session" || new URL(request.url).search)
    throw new AccountError("NOT_FOUND", 404);
  return Response.json({ user: currentActor() });
}, false);
// Login/logout must also work with an expired session, so they use only the
// local/same-origin transport guard before issuing or revoking a new session.
import { guardLocalDemoApi } from "@/lib/server/api";
export async function POST(request: Request, context: Context) {
  const blocked = guardLocalDemoApi(request, true);
  if (blocked) return blocked;
  const headers = { "Cache-Control": "no-store" };
  if (request.headers.get("sec-fetch-site") === "cross-site")
    return Response.json({ error: "ORIGIN_REJECTED" }, { status: 403, headers });
  try {
    const { action } = await context.params;
    if (new URL(request.url).search) throw new AccountError("INVALID_INPUT");
    if (action === "logout") {
      await logout(request);
      return Response.json(
        { ok: true },
        { headers: { ...headers, "Set-Cookie": sessionCookie(request, "") } },
      );
    }
    if (!["login", "register"].includes(action)) throw new AccountError("NOT_FOUND", 404);
    let previous: string | undefined;
    try {
      const candidate = cookieToken(request);
      if (candidate && /^[a-f0-9]{64}$/.test(candidate)) previous = candidate;
    } catch {
      // Duplicate/invalid old cookies must not prevent recovery through valid credentials.
    }
    const user = await authenticate(await boundedJson(request), action === "register");
    const token = await createSession(user, previous);
    return Response.json(
      { user },
      {
        status: action === "register" ? 201 : 200,
        headers: { ...headers, "Set-Cookie": sessionCookie(request, token) },
      },
    );
  } catch (error) {
    return Response.json(
      { error: error instanceof AccountError ? error.code : "ACCOUNT_SERVICE_UNAVAILABLE" },
      { status: error instanceof AccountError ? error.status : 503, headers },
    );
  }
}
