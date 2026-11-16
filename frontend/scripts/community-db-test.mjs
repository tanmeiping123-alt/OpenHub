import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { Client } from "pg";
const database = new URL(process.env.DATABASE_URL ?? "invalid:");
if (
  !["localhost", "127.0.0.1", "[::1]"].includes(database.hostname) ||
  database.pathname !== "/promptmaster_dev"
)
  throw Error("Community tests require the local promptmaster_dev database.");
const testName = `pm_community_test_${randomBytes(8).toString("hex")}`;
if (!/^pm_community_test_[a-f0-9]{16}$/.test(testName)) throw Error("INVALID_TEST_DATABASE_NAME");
const control = new Client({ connectionString: database.toString() });
await control.connect();
try {
  await control.query(`CREATE DATABASE "${testName}" TEMPLATE template0`);
  const target = new URL(database);
  target.pathname = `/${testName}`;
  const result = spawnSync(
    process.execPath,
    [
      "node_modules/vitest/vitest.mjs",
      "run",
      "src/lib/server/community/community.integration.test.ts",
    ],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        DATABASE_URL: target.toString(),
        PROMPTMASTER_COMMUNITY_DB_TEST: "true",
        PROMPTMASTER_MODEL_MODE: "disabled",
        DEEPSEEK_API_KEY: "unused-no-network",
      },
    },
  );
  process.exitCode = result.status ?? 1;
} finally {
  await control.query(`DROP DATABASE IF EXISTS "${testName}" WITH (FORCE)`);
  await control.end();
}
