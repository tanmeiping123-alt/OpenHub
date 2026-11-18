import { test } from "node:test";
import assert from "node:assert/strict";
import { validateFreeConfig, cloudDatabaseUrl, cloudSecrets, hardeningStatements } from "../scripts/free-cloud-config.mjs";
const config = { name: "openhub", vars: { PROMPTMASTER_DEPLOYMENT_MODE: "cloudflare-workers", SUPABASE_URL: "https://fixture.supabase.co", OPENHUB_PUBLIC_ORIGIN: "https://openhub.example.com" }, hyperdrive: [{ binding: "HYPERDRIVE", id: "a".repeat(32) }] };
test("deployment rejects placeholder database bindings and paid resource configurations", () => {
  assert.doesNotThrow(() => validateFreeConfig(config));
  for (const invalid of [{ ...config, hyperdrive: [{ binding: "HYPERDRIVE", id: "0".repeat(32) }] }, { ...config, containers: [{}] }, { ...config, durable_objects: { bindings: [{}] } }]) assert.throws(() => validateFreeConfig(invalid));
});
test("cloud database targets are pinned to the configured Supabase project with TLS verification", () => {
  const url = cloudDatabaseUrl("postgresql://postgres:fixture@db.fixture.supabase.co:5432/postgres", config.vars.SUPABASE_URL);
  assert.equal(new URL(url).searchParams.get("sslmode"), "verify-full");
  assert.match(new URL(url).searchParams.get("sslrootcert") ?? "", /cloudflare[\\/]supabase-ca\.crt$/);
  assert.doesNotThrow(() => cloudDatabaseUrl("postgresql://postgres.fixture:fixture@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres", config.vars.SUPABASE_URL));
  for (const value of ["postgresql://postgres:fixture@localhost/postgres", "postgresql://postgres:fixture@db.other.supabase.co/postgres", "postgresql://postgres.other:fixture@aws-0-ap-southeast-1.pooler.supabase.com/postgres"]) assert.throws(() => cloudDatabaseUrl(value, config.vars.SUPABASE_URL));
});
test("secret uploads contain only required Auth and explicitly supported AI settings", () => {
  const result = cloudSecrets({ SUPABASE_PUBLISHABLE_KEY: "fixture", DATABASE_URL: "secret-db", GITHUB_CLIENT_SECRET: "secret-oauth", DEEPSEEK_API_KEY: "fixture-ai", PATH: "system" });
  assert.deepEqual(result, { SUPABASE_PUBLISHABLE_KEY: "fixture", DEEPSEEK_API_KEY: "fixture-ai" });
  assert.throws(() => cloudSecrets({ SUPABASE_PUBLISHABLE_KEY: "" }));
});
test("hardening affects only migration-owned public relations", () => {
  const sql = hardeningStatements(['CREATE TABLE IF NOT EXISTS app_users(id text); CREATE OR REPLACE VIEW account_views AS SELECT 1; CREATE TABLE auth.users(id uuid);']);
  assert.match(sql, /ALTER TABLE public\."app_users" ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /REVOKE ALL ON public\."account_views" FROM anon, authenticated/);
  assert.doesNotMatch(sql, /auth\.users/);
});
