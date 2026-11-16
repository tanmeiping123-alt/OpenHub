import { spawnSync } from "node:child_process";

const database = new URL(process.env.DATABASE_URL ?? "invalid:");
if (
  !["localhost", "127.0.0.1", "[::1]"].includes(database.hostname) ||
  database.pathname !== "/promptmaster_dev"
) {
  throw new Error("Skill DB tests are restricted to local promptmaster_dev.");
}
// All fixture rows are inside rollback-only transactions. Immutable history needs no bypass.
const result = spawnSync(
  process.execPath,
  [
    "node_modules/vitest/vitest.mjs",
    "run",
    "src/lib/server/skills/skill-registry.integration.test.ts",
  ],
  { stdio: "inherit", env: { ...process.env, PROMPTMASTER_SKILL_DB_TEST: "true" } },
);
process.exitCode = result.status ?? 1;
