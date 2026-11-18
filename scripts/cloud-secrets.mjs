import { cloudSecrets, readConfig, runNode, wrangler } from "./free-cloud-config.mjs";
try {
  const config = await readConfig();
  if (config.vars?.PROMPTMASTER_DEPLOYMENT_MODE !== "cloudflare-workers") throw Error("Workers configuration required.");
  const values = cloudSecrets(process.env);
  await runNode([wrangler, "secret", "bulk", "--config", "wrangler.jsonc"], { input: JSON.stringify(values) });
  console.log(`Uploaded ${Object.keys(values).length} Auth/AI settings. Database and GitHub OAuth credentials stay separate.`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
