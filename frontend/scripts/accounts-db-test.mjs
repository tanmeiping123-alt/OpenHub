import { spawnSync } from "node:child_process";
const url = new URL(process.env.DATABASE_URL ?? "invalid:");
if (
  !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
  url.pathname !== "/promptmaster_dev"
)
  throw Error("LOCAL_DATABASE_REQUIRED");
const r = spawnSync(
  process.execPath,
  ["node_modules/vitest/vitest.mjs", "run", "src/lib/server/accounts-library.integration.test.ts"],
  { stdio: "inherit", env: { ...process.env, PROMPTMASTER_ACCOUNT_DB_TEST: "true" } },
);
process.exitCode = r.status ?? 1;
