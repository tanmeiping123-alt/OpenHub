import { test } from "node:test";
import assert from "node:assert/strict";
import { containerEnvironment, forwardedRequest, publicOrigin } from "./runtime.mjs";

test("accepts only an HTTPS public origin and rejects a mismatched configured domain", () => {
  assert.equal(publicOrigin("https://openhub.example/path", "https://openhub.example"), "https://openhub.example");
  assert.equal(publicOrigin("https://openhub.example/path"), "https://openhub.example");
  for (const origin of ["http://openhub.example", "https://user:pass@openhub.example", "https://openhub.example/path", "https://evil.example", "https://openhub.example?x=1"]) {
    assert.throws(() => publicOrigin("https://openhub.example/path", origin));
  }
  assert.throws(() => publicOrigin("http://openhub.example/path"));
});

test("forwards runtime secrets without exposing arbitrary bindings or overriding cloud invariants", () => {
  const env = containerEnvironment({ DATABASE_URL: "postgresql://user:secret@db.example/app?sslmode=require", SILICONFLOW_API_KEY: "fixture", PROMPTMASTER_MODEL_MODE: "live", UNRELATED_SECRET: "hidden", NODE_OPTIONS: "unsafe", PORT: "9000", PROMPTMASTER_DEPLOYMENT_MODE: "local" }, "https://openhub.example", "internal-token");
  assert.equal(env.DATABASE_URL, "postgresql://user:secret@db.example/app?sslmode=require");
  assert.equal(env.SILICONFLOW_API_KEY, "fixture");
  assert.equal(env.PROMPTMASTER_MODEL_MODE, "live");
  assert.equal(env.OPENHUB_PUBLIC_ORIGIN, "https://openhub.example");
  assert.equal(env.OPENHUB_INTERNAL_TOKEN, "internal-token");
  assert.equal(env.PROMPTMASTER_DEPLOYMENT_MODE, "cloudflare-container");
  assert.equal(env.PORT, "3000");
  assert.equal(env.UNRELATED_SECRET, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.throws(() => containerEnvironment({}, "https://openhub.example", "internal-token"));
});

test("replaces client-supplied proxy and internal headers while preserving request body and public URL", async () => {
  const incoming = new Request("https://openhub.example/api/prompts?q=1", { method: "POST", body: "payload", headers: { host: "spoofed.example", "x-forwarded-host": "spoofed.example", "x-forwarded-proto": "http", forwarded: "for=attacker", "x-openhub-internal-token": "spoofed", cookie: "session=fixture", origin: "https://openhub.example" } });
  const forwarded = forwardedRequest(incoming);
  assert.equal(forwarded.url, "https://openhub.example/api/prompts?q=1");
  assert.equal(forwarded.headers.get("host"), "openhub.example");
  assert.equal(forwarded.headers.get("x-forwarded-host"), "openhub.example");
  assert.equal(forwarded.headers.get("x-forwarded-proto"), "https");
  assert.equal(forwarded.headers.get("forwarded"), null);
  assert.equal(forwarded.headers.get("x-openhub-internal-token"), null);
  assert.equal(forwarded.headers.get("cookie"), "session=fixture");
  assert.equal(await forwarded.text(), "payload");
});
