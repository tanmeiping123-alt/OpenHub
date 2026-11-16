import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import pg from "pg";

const source = new URL(process.env.DATABASE_URL ?? "invalid:");
assert.ok(["localhost", "127.0.0.1"].includes(source.hostname));
assert.equal(source.pathname, "/promptmaster_dev");
const name = `promptmaster_sf_test_${randomBytes(6).toString("hex")}`;
assert.match(name, /^promptmaster_sf_test_[a-f0-9]{12}$/);
const admin = new pg.Client({ connectionString: source.toString() });
await admin.connect();
try {
  await admin.query(`CREATE DATABASE "${name}"`);
  const target = new URL(source);
  target.pathname = `/${name}`;
  const env = {
    ...process.env,
    DATABASE_URL: target.toString(),
    PROMPTMASTER_SILICONFLOW_DB_TEST: "true",
    PROMPTMASTER_MODEL_MODE: "live",
    PROMPTMASTER_MODEL_PROVIDER: "deepseek",
    DEEPSEEK_BASE_URL: "https://api.deepseek.com",
    DEEPSEEK_API_KEY: "synthetic-no-network",
    DEEPSEEK_MODEL: "deepseek-flash",
    DEEPSEEK_PRODUCT_VERSION: "DeepSeek-V4.1-Flash-1017",
    PROMPTMASTER_MODEL_MAX_RETRIES: "0",
    PROMPTMASTER_MODEL_DAILY_TOKEN_LIMIT: "4500000",
    PROMPTMASTER_MODEL_DAILY_COST_LIMIT_USD: "6",
    SILICONFLOW_API_KEY: "synthetic-no-network",
    SILICONFLOW_BASE_URL: "https://api.siliconflow.cn/v1",
    PROMPTMASTER_MODEL_MAX_OUTPUT_TOKENS: "1200",
  };
  const migrated = spawnSync(process.execPath, ["scripts/migrate.mjs"], { env, stdio: "inherit" });
  if (migrated.status !== 0) throw Error("Temporary database migration failed");
  const result = spawnSync(
    process.execPath,
    [
      "node_modules/vitest/vitest.mjs",
      "run",
      "--pool=threads",
      "--maxWorkers=1",
      "--testTimeout=60000",
      "--hookTimeout=60000",
      "src/lib/server/model/siliconflow.integration.test.ts",
      "src/lib/server/model/model-daily-cost-allowance.integration.test.ts",
      "src/lib/server/model/model-workflows.integration.test.ts",
    ],
    { env, stdio: "inherit" },
  );
  process.exitCode = result.status ?? 1;
} finally {
  // Only this exact, randomly created synthetic database is removed. No workspace/user DB writes.
  await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await admin.end();
  console.log("Disposable SiliconFlow test database removed; promptmaster_dev data untouched.");
}
