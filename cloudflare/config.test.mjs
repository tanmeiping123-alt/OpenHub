import { test } from "node:test";
import assert from "node:assert/strict";
import { assertAccountBootstrapTarget, validateCloudEnvironment } from "../scripts/cloud-config.mjs";

const valid = { DATABASE_URL: "postgresql://user:secret@db.example/app?sslmode=require", OPENHUB_PUBLIC_ORIGIN: "https://openhub.example", OPENHUB_INTERNAL_TOKEN: "fixture-token", PROMPTMASTER_DEPLOYMENT_MODE: "cloudflare-container", PROMPTMASTER_DEMO_API_ENABLED: "true" };
test("cloud startup rejects missing, unsafe or placeholder deployment settings", () => {
  assert.doesNotThrow(() => validateCloudEnvironment(valid));
  for (const change of [{ DATABASE_URL: "" }, { DATABASE_URL: "https://db.example/app" }, { DATABASE_URL: "postgresql://postgres:YOUR_LOCAL_POSTGRES_PASSWORD@db.example/app" }, { OPENHUB_PUBLIC_ORIGIN: "http://openhub.example" }, { OPENHUB_PUBLIC_ORIGIN: "https://user:secret@openhub.example" }, { OPENHUB_PUBLIC_ORIGIN: "https://openhub.example/path" }, { OPENHUB_INTERNAL_TOKEN: "" }, { PROMPTMASTER_DEPLOYMENT_MODE: "local" }, { PROMPTMASTER_DEMO_API_ENABLED: "false" }]) {
    assert.throws(() => validateCloudEnvironment({ ...valid, ...change }));
  }
});

test("cloud account bootstrap requires explicit cloud selection and deployment mode", () => {
  assert.doesNotThrow(() => assertAccountBootstrapTarget("postgresql://postgres:fixture@127.0.0.1:55432/promptmaster_dev", false));
  assert.throws(() => assertAccountBootstrapTarget(valid.DATABASE_URL, false));
  assert.throws(() => assertAccountBootstrapTarget(valid.DATABASE_URL, true, "local"));
  assert.doesNotThrow(() => assertAccountBootstrapTarget(valid.DATABASE_URL, true, "cloudflare-container"));
});
