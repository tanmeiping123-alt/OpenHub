// Local automated tests only. No production route imports this module.
import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash, scryptSync } from "node:crypto";
import { Client } from "pg";

export async function testDatabase(work) {
  const url = new URL(process.env.DATABASE_URL || "");
  assert.ok(["localhost", "127.0.0.1"].includes(url.hostname), "Tests require a local database.");
  assert.equal(
    url.pathname,
    "/promptmaster_dev",
    "Refusing to modify a non-test development database.",
  );
  const client = new Client({ connectionString: url.toString(), connectionTimeoutMillis: 30000 });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

export async function createTestAccount() {
  const tag = randomUUID();
  const account = {
    id: `usr_e2e_${tag}`,
    email: `e2e-${tag}@example.test`,
    password: randomBytes(24).toString("hex"),
    token: randomBytes(32).toString("hex"),
  };
  const salt = randomBytes(16).toString("hex");
  const hash = `scrypt$32768$8$3$${salt}$${scryptSync(account.password, salt, 64, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }).toString("hex")}`;
  await testDatabase(async (c) => {
    await c.query("BEGIN");
    try {
      await c.query("INSERT INTO app_users(id,identity_key,account_kind) VALUES($1,$2,'USER')", [
        account.id,
        `email:${account.email}`,
      ]);
      await c.query("INSERT INTO regular_users(user_id,email,password_hash) VALUES($1,$2,$3)", [
        account.id,
        account.email,
        hash,
      ]);
      await c.query(
        "INSERT INTO user_profiles(user_id,display_name) VALUES($1,'Synthetic E2E user')",
        [account.id],
      );
      await c.query(
        "INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '2 hours')",
        [createHash("sha256").update(account.token).digest("hex"), account.id],
      );
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    }
  });
  return account;
}

export async function cleanupTestAccount(account) {
  assert.match(account.email, /^e2e-[a-f0-9-]{36}@example\.test$/);
  await testDatabase(async (c) => {
    await c.query("BEGIN");
    try {
      const owner = (
        await c.query("SELECT user_id FROM regular_users WHERE email=$1", [account.email])
      ).rows[0]?.user_id;
      if (!owner) {
        await c.query("ROLLBACK");
        return;
      }
      if (account.id) assert.equal(owner, account.id);
      assert.equal(
        (
          await c.query(
            "SELECT 1 FROM app_users WHERE id=$1 AND identity_key=$2 AND account_kind='USER'",
            [owner, `email:${account.email}`],
          )
        ).rowCount,
        1,
      );
      // Immutable Skill/model evidence is never deleted. Unexpected writes fail cleanup safely.
      await c.query(
        "DELETE FROM model_comparison_results WHERE session_id IN (SELECT id FROM playground_sessions WHERE owner_user_id=$1)",
        [owner],
      );
      for (const table of [
        "playground_sessions",
        "optimization_records",
        "evaluation_reports",
        "history_records",
        "favorites",
        "library_items",
        "prompt_creation_requests",
      ])
        await c.query(`DELETE FROM ${table} WHERE owner_user_id=$1`, [owner]);
      await c.query("UPDATE prompts SET current_version_id=NULL WHERE owner_user_id=$1", [owner]);
      const versions = await c.query(
        "SELECT id FROM prompt_versions WHERE owner_user_id=$1 ORDER BY version_number DESC",
        [owner],
      );
      for (const v of versions.rows)
        await c.query("DELETE FROM prompt_versions WHERE id=$1 AND owner_user_id=$2", [
          v.id,
          owner,
        ]);
      await c.query("DELETE FROM prompts WHERE owner_user_id=$1", [owner]);
      await c.query("DELETE FROM model_quota_policies WHERE owner_user_id=$1", [owner]);
      await c.query("DELETE FROM billing_request_limits WHERE owner_user_id=$1", [owner]);
      await c.query("DELETE FROM account_sessions WHERE user_id=$1", [owner]);
      await c.query("DELETE FROM user_profiles WHERE user_id=$1", [owner]);
      await c.query("DELETE FROM regular_users WHERE user_id=$1 AND email=$2", [
        owner,
        account.email,
      ]);
      await c.query("DELETE FROM app_users WHERE id=$1 AND identity_key=$2", [
        owner,
        `email:${account.email}`,
      ]);
      await c.query("DELETE FROM account_login_limits WHERE bucket=$1", [
        createHash("sha256").update(account.email).digest("hex"),
      ]);
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    }
  });
}
