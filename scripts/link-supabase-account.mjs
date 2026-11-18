import { randomUUID } from "node:crypto";
import pg from "../frontend/node_modules/pg/lib/index.js";
import { cloudDatabaseUrl, readConfig } from "./free-cloud-config.mjs";
// Operator JSON on stdin: {"subject":"Supabase user UUID","role":"ADMIN"|"USER"}.
// The verified email is read from auth.users, never asserted by the operator or user metadata.
let client;
try {
  let input = "";
  for await (const chunk of process.stdin) { input += chunk; if (input.length > 4096) throw Error(); }
  const value = JSON.parse(input);
  if (!value || Object.keys(value).sort().join(",") !== "role,subject" || !["ADMIN", "USER"].includes(value.role) || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value.subject)) throw Error();
  const config = await readConfig();
  client = new pg.Client({ connectionString: cloudDatabaseUrl(process.env.DATABASE_URL, config.vars.SUPABASE_URL), connectionTimeoutMillis: 30_000 });
  await client.connect();
  await client.query("BEGIN");
  const external = (await client.query("SELECT email,email_confirmed_at FROM auth.users WHERE id=$1 AND deleted_at IS NULL", [value.subject])).rows[0];
  const email = external?.email?.trim().toLowerCase();
  if (!external?.email_confirmed_at || !email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw Error();
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`external-account:${email}`]);
  let account = (await client.query("SELECT id,account_kind FROM app_users WHERE identity_key=$1 FOR UPDATE", [`email:${email}`])).rows[0];
  if (account && account.account_kind !== value.role) throw Error("Existing account role differs. Promotion requires a separate reviewed action.");
  if (!account) {
    account = { id: `usr_${randomUUID()}`, account_kind: value.role };
    await client.query("INSERT INTO app_users(id,identity_key,account_kind) VALUES($1,$2,$3)", [account.id, `email:${email}`, value.role]);
    const table = value.role === "ADMIN" ? "administrator_users" : "regular_users";
    await client.query(`INSERT INTO ${table}(user_id,email,password_hash) VALUES($1,$2,$3)`, [account.id, email, "scrypt$external-auth-only"]);
    await client.query("INSERT INTO user_profiles(user_id,display_name) VALUES($1,$2)", [account.id, email.split("@")[0]]);
  }
  const existing = (await client.query("SELECT subject,user_id FROM account_external_identities WHERE provider='supabase' AND (subject=$1 OR user_id=$2)", [value.subject, account.id])).rows;
  if (existing.some(row => row.subject !== value.subject || row.user_id !== account.id)) throw Error("A different external identity is already linked.");
  if (!existing.length) await client.query("INSERT INTO account_external_identities(provider,subject,user_id) VALUES('supabase',$1,$2)", [value.subject, account.id]);
  await client.query("COMMIT");
  console.log("Verified Supabase identity linked with the explicitly selected account role.");
} catch { if (client) await client.query("ROLLBACK").catch(() => {}); console.error("Account linking failed. Supply a confirmed Supabase subject and matching explicit role; no account was promoted."); process.exitCode = 1; }
finally { await client?.end(); }
