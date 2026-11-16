// One-time local bootstrap: read credentials from stdin, never source files/logs.
// Existing accounts are preserved; this command never resets a password or role.
import pg from "pg";
import { randomBytes, randomUUID, scrypt } from "node:crypto";
import { promisify } from "node:util";
const url = new URL(process.env.DATABASE_URL ?? "invalid:");
if (
  !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
  url.pathname !== "/promptmaster_dev"
)
  throw Error("LOCAL_DATABASE_REQUIRED");
let input = "";
for await (const chunk of process.stdin) {
  input += chunk;
  if (input.length > 4096) throw Error("INPUT_TOO_LARGE");
}
const accounts = JSON.parse(input);
input = "";
if (!Array.isArray(accounts) || accounts.length > 10) throw Error("INVALID_ACCOUNTS");
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
try {
  await c.query("BEGIN");
  await c.query("SELECT pg_advisory_xact_lock(hashtext('account-bootstrap'))");
  for (const a of accounts) {
    if (
      !["ADMIN", "USER"].includes(a.role) ||
      typeof a.email !== "string" ||
      typeof a.password !== "string" ||
      a.password.length < 8 ||
      a.password.length > 128
    )
      throw Error("INVALID_ACCOUNT");
    const email = a.email.trim().toLowerCase();
    const exists = await c.query("SELECT account_kind FROM app_users WHERE identity_key=$1", [
      `email:${email}`,
    ]);
    if (exists.rowCount) {
      if (exists.rows[0].account_kind !== a.role) throw Error("EXISTING_ROLE_MISMATCH");
      console.log(JSON.stringify({ email, role: a.role, result: "PRESERVED_EXISTING" }));
      continue;
    }
    const salt = randomBytes(16).toString("hex");
    const hash = await promisify(scrypt)(a.password, salt, 64, {
      N: 32768,
      r: 8,
      p: 3,
      maxmem: 64 * 1024 * 1024,
    });
    a.password = "";
    const encoded = `scrypt$32768$8$3$${salt}$${hash.toString("hex")}`;
    const id = `usr_${randomUUID()}`;
    await c.query("INSERT INTO app_users(id,identity_key,account_kind) VALUES($1,$2,$3)", [
      id,
      `email:${email}`,
      a.role,
    ]);
    await c.query(
      `INSERT INTO ${a.role === "ADMIN" ? "administrator_users" : "regular_users"}(user_id,email,password_hash) VALUES($1,$2,$3)`,
      [id, email, encoded],
    );
    await c.query("INSERT INTO user_profiles(user_id,display_name) VALUES($1,$2)", [
      id,
      email.split("@")[0],
    ]);
    console.log(JSON.stringify({ email, role: a.role, result: "CREATED" }));
  }
  await c.query("COMMIT");
} catch (error) {
  await c.query("ROLLBACK");
  console.error(error.code ?? "INITIALIZATION_FAILED");
  process.exitCode = 1;
} finally {
  await c.end();
}
