import "server-only";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient } from "pg";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../");
const migrationDirectory = path.join(projectRoot, "migrations");
const demoUserId = "usr_local_demo_01";

type DbGlobals = typeof globalThis & {
  __promptMasterPool?: Pool;
  __promptMasterReady?: Promise<void>;
};

function pool(): Pool {
  const globals = globalThis as DbGlobals;
  if (globals.__promptMasterPool) return globals.__promptMasterPool;

  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not configured.");
  }

  globals.__promptMasterPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 5,
    connectionTimeoutMillis: 30000,
    idleTimeoutMillis: 30000,
    application_name: "promptmaster-local-demo",
  });
  return globals.__promptMasterPool;
}

async function migrate(client: PoolClient) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      migration_name text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await client.query("SELECT pg_advisory_lock(hashtext($1))", ["promptmaster-schema-migrations"]);
  try {
    const files = (await readdir(migrationDirectory))
      .filter((file) => /^\d+_[a-z0-9_]+\.sql$/i.test(file))
      .sort((left, right) => left.localeCompare(right));

    for (const file of files) {
      const sql = await readFile(path.join(migrationDirectory, file), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const applied = await client.query(
        "SELECT checksum FROM schema_migrations WHERE migration_name = $1",
        [file],
      );
      if (applied.rowCount) {
        if (applied.rows[0].checksum !== checksum) {
          throw new Error(`${file} was changed after application; add a new migration instead.`);
        }
        continue;
      }

      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (migration_name, checksum) VALUES ($1, $2)",
          [file, checksum],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext($1))", [
      "promptmaster-schema-migrations",
    ]);
  }
}

export async function ensureDatabaseReady() {
  const globals = globalThis as DbGlobals;
  if (!globals.__promptMasterReady) {
    globals.__promptMasterReady = (async () => {
      const client = await pool().connect();
      try {
        await migrate(client);
      } finally {
        client.release();
      }
    })().catch((error) => {
      globals.__promptMasterReady = undefined;
      throw error;
    });
  }
  await globals.__promptMasterReady;
}

export function getPool() {
  return pool();
}

export async function withTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  await ensureDatabaseReady();
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = '10s'");
    const value = await work(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export { demoUserId };
