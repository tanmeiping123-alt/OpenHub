import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const readConfig = async () => JSON.parse(await readFile(resolve(root, "wrangler.jsonc"), "utf8"));
export function validateFreeConfig(config) {
  if (config.name !== "openhub" || config.vars?.PROMPTMASTER_DEPLOYMENT_MODE !== "cloudflare-workers") throw Error("Free deployment requires the openhub Workers configuration.");
  for (const key of ["containers", "durable_objects", "r2_buckets", "queues"]) if (config[key]) throw Error(`Free deployment refuses ${key}.`);
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(config.vars.SUPABASE_URL ?? "")) throw Error("Configure the Supabase project origin.");
  const origin = new URL(config.vars.OPENHUB_PUBLIC_ORIGIN);
  if (origin.protocol !== "https:" || origin.origin !== config.vars.OPENHUB_PUBLIC_ORIGIN) throw Error("Configure the canonical HTTPS origin.");
  const bindings = config.hyperdrive ?? [];
  if (bindings.length !== 1 || bindings[0].binding !== "HYPERDRIVE" || !/^[a-f0-9]{32}$/i.test(bindings[0].id ?? "") || /^0+$/.test(bindings[0].id)) throw Error("Create Hyperdrive, then replace the placeholder HYPERDRIVE id in wrangler.jsonc.");
}
export function cloudDatabaseUrl(value, supabaseOrigin) {
  const project = new URL(supabaseOrigin).hostname.split(".")[0];
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(supabaseOrigin)) throw Error("Invalid Supabase project origin.");
  let url;
  try { url = new URL(value ?? ""); } catch { throw Error("Set DATABASE_URL in the ignored .env.cloud.local file."); }
  const direct = url.hostname === `db.${project}.supabase.co` && decodeURIComponent(url.username) === "postgres";
  const pooler = /^[a-z0-9-]+\.pooler\.supabase\.com$/.test(url.hostname) && decodeURIComponent(url.username) === `postgres.${project}`;
  if (!["postgres:", "postgresql:"].includes(url.protocol) || (!direct && !pooler) || url.pathname !== "/postgres" || !url.password || /YOUR_|REPLACE_/.test(url.password)) throw Error("DATABASE_URL must target this Supabase project's postgres database.");
  for (const key of ["sslmode", "sslcert", "sslkey", "sslrootcert", "uselibpqcompat"]) url.searchParams.delete(key);
  url.searchParams.set("sslmode", "verify-full");
  url.searchParams.set("sslrootcert", resolve(root, "cloudflare/supabase-ca.crt"));
  return url.href;
}
const secretNames = ["SUPABASE_PUBLISHABLE_KEY", "DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL", "DEEPSEEK_MODEL", "DEEPSEEK_PRODUCT_VERSION", "SILICONFLOW_API_KEY", "SILICONFLOW_BASE_URL", "SILICONFLOW_MODEL_TIMEOUT_MS", "PROMPTMASTER_MODEL_MODE", "PROMPTMASTER_MODEL_PROVIDER", "PROMPTMASTER_MODEL_TIMEOUT_MS", "PROMPTMASTER_DEEPSEEK_THINKING_TIMEOUT_MS", "PROMPTMASTER_MODEL_MAX_RETRIES", "PROMPTMASTER_MODEL_DAILY_TOKEN_LIMIT", "PROMPTMASTER_MODEL_DAILY_COST_LIMIT_USD", "PROMPTMASTER_MODEL_PRICING_WINDOW", "PROMPTMASTER_COMMUNITY_PUBLISH_DAILY_LIMIT"];
export function cloudSecrets(env) {
  if (!env.SUPABASE_PUBLISHABLE_KEY || /YOUR_|REPLACE_/.test(env.SUPABASE_PUBLISHABLE_KEY)) throw Error("Set SUPABASE_PUBLISHABLE_KEY in .env.cloud.local.");
  return Object.fromEntries(secretNames.filter(key => env[key] && !/YOUR_|REPLACE_/.test(env[key])).map(key => [key, env[key]]));
}
export function hardeningStatements(migrations) {
  const tables = new Set(["schema_migrations"]), views = new Set();
  for (const sql of migrations) {
    for (const match of sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?([a-z_][a-z0-9_]*)\s*\(/gi)) tables.add(match[1]);
    for (const match of sql.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+(?:public\.)?([a-z_][a-z0-9_]*)\s+AS\b/gi)) views.add(match[1]);
  }
  return [
    ...[...tables].map(name => `ALTER TABLE public."${name}" ENABLE ROW LEVEL SECURITY;`),
    ...[...tables, ...views].map(name => `REVOKE ALL ON public."${name}" FROM anon, authenticated;`),
  ].join("\n");
}
export function runNode(args, { cwd = root, env = process.env, input, capture = false } = {}) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, args, { cwd, env, windowsHide: true, stdio: [input === undefined ? "ignore" : "pipe", capture ? "pipe" : "inherit", "inherit"] });
    let output = "";
    child.stdout?.on("data", data => { output += data; });
    if (input !== undefined) child.stdin.end(input);
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolveResult(output) : reject(Error(`Command failed with exit code ${code}.`)));
  });
}
export const wrangler = resolve(root, "node_modules/wrangler/bin/wrangler.js");
