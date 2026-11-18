import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { unstable_getMiniflareWorkerOptions } from "wrangler";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { root } from "./free-cloud-config.mjs";

// No database connection or provider request is required for these public routes.
process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE = "postgresql://postgres:fixture@127.0.0.1:1/openhub_smoke";
const directory = resolve(root, "frontend/dist/ssr");
const browserFiles = await readdir(resolve(root, "frontend/dist/client"), { recursive: true });
assert.equal(browserFiles.some(file => /^payments(?:[\\/]|$)/.test(file)), false, "Personal payment assets must never be deployed");
const config = unstable_getMiniflareWorkerOptions(resolve(directory, "wrangler.json"));
const files = await readdir(directory, { recursive: true });
const entry = config.main;
const paths = [entry, ...files.filter(file => /\.(mjs|js)$/.test(file)).map(file => resolve(directory, file)).filter(file => file !== entry)];
const modules = await Promise.all(paths.map(async path => ({ type: "ESModule", path, contents: await readFile(path, "utf8") })));
for (const module of modules) {
  assert.doesNotMatch(module.contents, /promptmaster-local-demo/, "Worker routes must use the request-scoped Hyperdrive adapter, never the local database adapter");
  assert.doesNotMatch(module.contents, /chromium\.launch\(/, "Workers must exclude the local Chromium renderer");
}
const options = { ...config.workerOptions, modules, modulesRoot: directory, bindings: { ...config.workerOptions.bindings, SUPABASE_PUBLISHABLE_KEY: "fixture-key" } };
delete options.modulesRules;
const runtime = new Miniflare(convertV4MiniflareOptions(options));
const origin = config.workerOptions.bindings.OPENHUB_PUBLIC_ORIGIN;
try {
  const login = await runtime.dispatchFetch(`${origin}/zh-CN/login`, { redirect: "manual", headers: { "sec-fetch-mode": "navigate" } });
  assert.equal(login.status, 200, "Cloud login page must render successfully");
  const html = await login.text();
  assert.match(html, /PromptMaster AI/, "Cloud page must serve the application shell");
  assert.match(html, /\/assets\/index-/, "Cloud page must reference its static browser bundle");
  assert.doesNotMatch(html, /self\.__next_f|__VINEXT/, "Pages must not require runtime server rendering");
  const auth = await runtime.dispatchFetch(`${origin}/api/auth/github?next=/zh-CN/app`, { redirect: "manual", headers: { "sec-fetch-site": "same-origin" } });
  assert.equal(auth.status, 302);
  assert.equal(new URL(auth.headers.get("location")).pathname, "/auth/v1/authorize");
  const callback = await runtime.dispatchFetch(`${origin}/api/auth/callback?code=fixture_auth_code`, { redirect: "manual" });
  assert.equal(callback.status, 400, "A callback without its PKCE cookie must be rejected");
  const whiteboard = await runtime.dispatchFetch(`${origin}/modules/excalidraw/`, { redirect: "manual" });
  assert.equal(whiteboard.status, 200, "The integrated whiteboard must be available as a static asset");
  await whiteboard.text();
  console.log("Worker runtime smoke passed: rendered login, GitHub redirect, callback guard, Excalidraw asset.");
} finally { await runtime.dispose(); }
