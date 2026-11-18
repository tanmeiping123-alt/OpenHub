import { resolve } from "node:path";
import { root, readConfig, validateFreeConfig, runNode, wrangler } from "./free-cloud-config.mjs";

try {
  const config = await readConfig();
  validateFreeConfig(config);
  if (process.argv.includes("--check")) {
    console.log("Free deployment configuration is ready.");
  } else {
    await runNode([wrangler, "hyperdrive", "get", config.hyperdrive[0].id]);
    const output = await runNode([wrangler, "secret", "list", "--config", "wrangler.jsonc"], { capture: true });
    const secrets = JSON.parse(output.slice(output.indexOf("[")));
    if (!secrets.some(value => value.name === "SUPABASE_PUBLISHABLE_KEY")) throw Error("Run npm run cloud:secrets before deploying.");
    await runNode([resolve(root, "scripts/build-whiteboard.mjs")]);
    await runNode([resolve(root, "frontend/node_modules/vite/bin/vite.js"), "build", "--config", "vite.workers.config.mts"], { cwd: resolve(root, "frontend") });
    await runNode([resolve(root, "frontend/node_modules/vite/bin/vite.js"), "build", "--config", "vite.browser.config.mts"], { cwd: resolve(root, "frontend") });
    await runNode([resolve(root, "frontend/node_modules/next/dist/bin/next"), "typegen"], { cwd: resolve(root, "frontend") });
    await runNode([resolve(root, "scripts/smoke-free.mjs")]);
    await runNode([wrangler, "deploy", "--config", "frontend/dist/ssr/wrangler.json"]);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
