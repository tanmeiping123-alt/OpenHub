import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { Client } from "pg";

const database = new URL(process.env.DATABASE_URL ?? "invalid:");
if (
  !["localhost", "127.0.0.1", "[::1]"].includes(database.hostname) ||
  database.pathname !== "/promptmaster_dev"
)
  throw new Error("Pelican tests require local promptmaster_dev control database.");
const name = `pm_pelican_test_${randomBytes(8).toString("hex")}`;
if (!/^pm_pelican_test_[a-f0-9]{16}$/.test(name)) throw new Error("INVALID_TEST_DATABASE_NAME");
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
      ...(process.argv.slice(2).length
        ? process.argv.slice(2)
        : [
            "src/lib/server/pelican/data.integration.test.ts",
            "src/lib/server/pelican/execution.integration.test.ts",
          ]),
    ],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        DATABASE_URL: target.toString(),
        PROMPTMASTER_PELICAN_DB_TEST: "true",
        PROMPTMASTER_MODEL_MODE: "live",
        PROMPTMASTER_MODEL_PROVIDER: "deepseek",
        DEEPSEEK_API_KEY: "unused-no-network",
        DEEPSEEK_BASE_URL: "https://api.deepseek.com",
        DEEPSEEK_MODEL: "deepseek-flash",
        DEEPSEEK_PRODUCT_VERSION: "DeepSeek-V4.1-Flash-1017",
        SILICONFLOW_API_KEY: "unused-no-network",
        PROMPTMASTER_MODEL_MAX_OUTPUT_TOKENS: "1200",
        PROMPTMASTER_MODEL_DAILY_COST_LIMIT_USD: "1",
        PROMPTMASTER_MODEL_DAILY_TOKEN_LIMIT: "200000",
        PROMPTMASTER_MODEL_PRICING_WINDOW: "PEAK",
      },
    },
  );
  process.exitCode = result.status ?? 1;
} finally {
  await control.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await control.end();
}
