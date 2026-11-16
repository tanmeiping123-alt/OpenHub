import "server-only";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { withTransaction } from "./db";
import { hashPassword, verifyPassword } from "./password";
import { type Actor } from "./identity-context";
import { AccountError } from "./account-errors";
export { AccountError } from "./account-errors";
export const SESSION_COOKIE = "pm_session";
const digest = (v: string) => createHash("sha256").update(v).digest("hex");
const accountsSql = `SELECT user_id,email,password_hash,disabled,'ADMIN' AS role FROM administrator_users UNION ALL SELECT user_id,email,password_hash,disabled,'USER' AS role FROM regular_users`;
export function credentials(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new AccountError("INVALID_CREDENTIALS", 400);
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).sort().join(",") !== "email,password" ||
    typeof v.email !== "string" ||
    typeof v.password !== "string" ||
    v.password.length < 8 ||
    v.password.length > 128 ||
    v.email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email.trim())
  )
    throw new AccountError("INVALID_CREDENTIALS", 400);
  return { email: v.email.trim().toLowerCase(), password: v.password };
}
export async function createAccountInTransaction(
  c: PoolClient,
  email: string,
  passwordHash: string,
  role: Actor["role"],
) {
  const id = `usr_${randomUUID()}`;
  await c.query("INSERT INTO app_users(id,identity_key,account_kind) VALUES($1,$2,$3)", [
    id,
    `email:${email}`,
    role,
  ]);
  const table = role === "ADMIN" ? "administrator_users" : "regular_users";
  await c.query(`INSERT INTO ${table}(user_id,email,password_hash) VALUES($1,$2,$3)`, [
    id,
    email,
    passwordHash,
  ]);
  await c.query("INSERT INTO user_profiles(user_id,display_name) VALUES($1,$2)", [
    id,
    email.split("@")[0],
  ]);
  return { id, email, role };
}
export function cookieToken(request: Request) {
  const matches = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.startsWith(`${SESSION_COOKIE}=`));
  if (matches.length > 1) throw new AccountError("AUTH_REQUIRED", 401);
  return matches[0]?.slice(SESSION_COOKIE.length + 1);
}
export async function sessionActor(request: Request): Promise<Actor | null> {
  const token = cookieToken(request);
  if (token === undefined) return null;
  if (!/^[a-f0-9]{64}$/.test(token)) throw new AccountError("AUTH_REQUIRED", 401);
  return withTransaction(async (c) => {
    const r = await c.query(
      `SELECT a.user_id AS id,a.email,a.role FROM account_sessions s JOIN (${accountsSql}) a ON a.user_id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>clock_timestamp() AND s.revoked_at IS NULL AND NOT a.disabled`,
      [digest(token)],
    );
    if (!r.rowCount) throw new AccountError("AUTH_REQUIRED", 401);
    return r.rows[0];
  });
}
async function reserveLoginAttempt(email: string) {
  // Global local-service and per-account windows limit password work and enumeration.
  const allowed = await withTransaction(async (c) => {
    for (const [bucket, max] of [
      ["global", 120],
      [digest(email), 8],
    ] as const) {
      const r = await c.query(
        `INSERT INTO account_login_limits(bucket,attempts,window_start) VALUES($1,1,clock_timestamp()) ON CONFLICT(bucket) DO UPDATE SET attempts=CASE WHEN account_login_limits.window_start<clock_timestamp()-interval '15 minutes' THEN 1 ELSE account_login_limits.attempts+1 END,window_start=CASE WHEN account_login_limits.window_start<clock_timestamp()-interval '15 minutes' THEN clock_timestamp() ELSE account_login_limits.window_start END RETURNING attempts`,
        [bucket],
      );
      if (r.rows[0].attempts > max) return false;
    }
    return true;
  });
  if (!allowed) throw new AccountError("TOO_MANY_ATTEMPTS", 429);
}
export async function authenticate(value: unknown, register = false) {
  const { email, password } = credentials(value);
  await reserveLoginAttempt(email);
  if (register) {
    const encoded = await hashPassword(password);
    try {
      return await withTransaction((c) => createAccountInTransaction(c, email, encoded, "USER"));
    } catch (e) {
      if ((e as { code?: string }).code === "23505")
        throw new AccountError("ACCOUNT_UNAVAILABLE", 409);
      throw e;
    }
  }
  const account = await withTransaction(
    async (c) =>
      (await c.query(`SELECT * FROM (${accountsSql}) a WHERE email=$1`, [email])).rows[0],
  );
  if (!(await verifyPassword(password, account?.password_hash)) || account?.disabled)
    throw new AccountError("INVALID_CREDENTIALS", 401);
  await withTransaction((c) =>
    c.query("DELETE FROM account_login_limits WHERE bucket=$1", [digest(email)]),
  );
  return { id: account.user_id, email: account.email, role: account.role } as Actor;
}
export async function createSession(actor: Actor, previous?: string) {
  const token = randomBytes(32).toString("hex");
  await withTransaction(async (c) => {
    if (previous)
      await c.query(
        "UPDATE account_sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1",
        [digest(previous)],
      );
    await c.query(
      "INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES($1,$2,clock_timestamp()+interval '8 hours')",
      [digest(token), actor.id],
    );
  });
  return token;
}
export async function logout(request: Request) {
  const tokens = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((v) => v.trim())
    .filter((v) => v.startsWith(`${SESSION_COOKIE}=`))
    .map((v) => v.slice(SESSION_COOKIE.length + 1))
    .filter((v) => /^[a-f0-9]{64}$/.test(v));
  if (tokens.length)
    await withTransaction((c) =>
      c.query(
        "UPDATE account_sessions SET revoked_at=clock_timestamp() WHERE token_hash=ANY($1::text[])",
        [[...new Set(tokens)].map(digest)],
      ),
    );
}
export function sessionCookie(request: Request, token: string) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${token ? 28800 : 0}${new URL(request.url).protocol === "https:" ? "; Secure" : ""}`;
}
