import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { Client } from "pg";

const database = new URL(process.env.DATABASE_URL ?? "invalid:");
if (
  !["localhost", "127.0.0.1", "[::1]"].includes(database.hostname) ||
  database.pathname !== "/promptmaster_dev"
)
  throw new Error("Core-first tests require local promptmaster_dev control database.");
const name = `pm_core_first_test_${randomBytes(8).toString("hex")}`;
if (!/^pm_core_first_test_[a-f0-9]{16}$/.test(name)) throw new Error("INVALID_TEST_DATABASE_NAME");
const control = new Client({ connectionString: database.toString() });
await control.connect();
try {
  await control.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
  const target = new URL(database);
  target.pathname = `/${name}`;
  const result = spawnSync(
    process.execPath,
    [
      "node_modules/vitest/vitest.mjs",
      "run",
      "--maxWorkers=1",
      "src/lib/server/accounts-library.integration.test.ts",
    ],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        DATABASE_URL: target.toString(),
        PROMPTMASTER_ACCOUNT_DB_TEST: "true",
        PROMPTMASTER_MODEL_MODE: "disabled",
        DEEPSEEK_API_KEY: "unused-no-network",
      },
    },
  );
  process.exitCode = result.status ?? 1;
} finally {
  await control.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await control.end();
}
