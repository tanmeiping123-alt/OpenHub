import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("default cloud deployment never provisions paid container infrastructure", async () => {
  const config = JSON.parse(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
  assert.equal(config.vars?.PROMPTMASTER_DEPLOYMENT_MODE, "cloudflare-workers");
  for (const binding of ["containers", "durable_objects", "r2_buckets", "queues"]) assert.equal(config[binding], undefined);
  assert.equal(config.hyperdrive[0].binding, "HYPERDRIVE");
  assert.equal(config.assets.not_found_handling, "single-page-application");
  assert.deepEqual(config.assets.run_worker_first, ["/api/*"]);
  assert.equal(config.preview_urls, false);
});
