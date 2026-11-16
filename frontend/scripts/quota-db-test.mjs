import { spawnSync } from "node:child_process";

const database = new URL(process.env.DATABASE_URL ?? "invalid:");
if (
  !["localhost", "127.0.0.1", "[::1]"].includes(database.hostname) ||
  database.pathname !== "/promptmaster_dev"
) {
  throw new Error("Quota DB tests are restricted to the local promptmaster_dev database.");
}

// Explicit opt-in, isolated synthetic owners, and no network/provider calls.
const result = spawnSync(
  process.execPath,
  ["node_modules/vitest/vitest.mjs", "run", "src/lib/server/model/model-quota.integration.test.ts"],
  { stdio: "inherit", env: { ...process.env, PROMPTMASTER_QUOTA_DB_TEST: "true" } },
);
process.exitCode = result.status ?? 1;
