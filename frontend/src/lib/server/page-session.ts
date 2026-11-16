import "server-only";
import { cookies } from "next/headers";
import { AccountError, SESSION_COOKIE, sessionActor } from "./accounts";

export async function pageSession() {
  const jar = await cookies();
  const sessions = jar.getAll(SESSION_COOKIE);
  if (!sessions.length) return { actor: null, reason: "required" };
  try {
    const actor = await sessionActor(
      new Request("http://localhost/", {
        headers: { cookie: sessions.map((c) => `${SESSION_COOKIE}=${c.value}`).join("; ") },
      }),
    );
    return { actor, reason: actor ? "" : "expired" };
  } catch (error) {
    return {
      actor: null,
      reason: error instanceof AccountError && error.status === 401 ? "expired" : "unavailable",
    };
  }
}
