// Explicit read-only tests; no real database/supplier call, .env read or mutations.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const file = fileURLToPath(new URL("service-health.mjs", import.meta.url));
const marker = "DO_NOT_PRINT_THIS_CREDENTIAL";
function check(url, action = "config") {
  const result = spawnSync(process.execPath, [file, action], {
    env: {
      ...process.env,
      LOCALAPPDATA: process.env.LOCALAPPDATA || "/local-test",
      DATABASE_URL: url,
    },
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(result.error, undefined);
  assert.ok(!(result.stdout + result.stderr).includes(marker));
  return result;
}
test("accepts only the fixed local project configuration", () => {
  for (const host of ["127.0.0.1", "localhost", "[::1]"]) {
    const result = check(`postgresql://user:${marker}@${host}:55432/promptmaster_dev`);
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), "LOCAL_CONFIG_OK");
  }
});
test("rejects remote/wrong cluster configuration without printing credentials", () => {
  for (const url of [
    `postgresql://user:${marker}@example.com:55432/promptmaster_dev`,
    `postgresql://user:${marker}@127.0.0.1:5432/promptmaster_dev`,
    `postgresql://user:${marker}@127.0.0.1:55432/postgres`,
    `postgresql://user:${marker}@127.0.0.1:55432/promptmaster_dev?host=example.com`,
    `postgresql://user:${marker}@127.0.0.1:55432/promptmaster_dev#secret`,
    `https://user:${marker}@127.0.0.1:55432/promptmaster_dev`,
    `invalid-${marker}`,
    "",
  ]) {
    const result = check(url);
    assert.equal(result.status, 1);
    assert.match(result.stderr.trim(), /^[A-Z_]+$/);
  }
});
test("unknown operation fails before connecting", () => {
  const result = check(`postgresql://user:${marker}@127.0.0.1:55432/promptmaster_dev`, "run");
  assert.equal(result.status, 1);
  assert.equal(result.stderr.trim(), "INVALID_HEALTH_ACTION");
});
