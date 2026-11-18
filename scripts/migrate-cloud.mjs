import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "../frontend/node_modules/pg/lib/index.js";
import { cloudDatabaseUrl, hardeningStatements, readConfig, root, runNode } from "./free-cloud-config.mjs";
try {
  const config = await readConfig();
  const database = cloudDatabaseUrl(process.env.DATABASE_URL, config.vars.SUPABASE_URL);
  await runNode([resolve(root, "frontend/scripts/migrate.mjs")], { env: { ...process.env, DATABASE_URL: database } });
  const directory = resolve(root, "frontend/migrations");
  const files = (await readdir(directory)).filter(name => /^\d+_[a-z0-9_]+\.sql$/i.test(name)).sort();
  const statements = hardeningStatements(await Promise.all(files.map(file => readFile(resolve(directory, file), "utf8"))));
  const client = new pg.Client({ connectionString: database, connectionTimeoutMillis: 30_000 });
  try {
    await client.connect();
    await client.query("BEGIN");
    await client.query(statements);
    await client.query("COMMIT");
    console.log("Cloud migrations complete; application tables use RLS and deny Data API roles.");
  } finally { await client.end(); }
} catch { console.error("Cloud migration failed. Check the local database configuration and migration output; credentials were not printed."); process.exitCode = 1; }
