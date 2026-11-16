import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool } = pg;
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationDirectory = path.join(projectRoot, "migrations");
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error(
    "DATABASE_URL is missing. Copy .env.example to .env.local and configure PostgreSQL locally.",
  );
  process.exitCode = 1;
} else {
  const pool = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 30000 });
  const lockClient = await pool.connect();
  try {
    await lockClient.query("SELECT pg_advisory_lock(hashtext($1))", [
      "promptmaster-schema-migrations",
    ]);
    await lockClient.query("SELECT 1");
    await lockClient.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        migration_name text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const files = (await readdir(migrationDirectory))
      .filter((file) => /^\d+_[a-z0-9_]+\.sql$/i.test(file))
      .sort((left, right) => left.localeCompare(right));

    for (const file of files) {
      const sql = await readFile(path.join(migrationDirectory, file), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const existing = await lockClient.query(
        "SELECT checksum FROM schema_migrations WHERE migration_name = $1",
        [file],
      );

      if (existing.rowCount) {
        if (existing.rows[0].checksum !== checksum) {
          throw new Error(
            `${file} checksum changed after application; create a new migration instead.`,
          );
        }
        console.log(`Already applied: ${file}`);
        continue;
      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (migration_name, checksum) VALUES ($1, $2)",
          [file, checksum],
        );
        await client.query("COMMIT");
        console.log(`Applied: ${file}`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
    console.log("Database migrations are up to date.");
  } catch (error) {
    console.error("Database migration failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    await lockClient.query("SELECT pg_advisory_unlock(hashtext($1))", [
      "promptmaster-schema-migrations",
    ]);
    lockClient.release();
    await pool.end();
  }
}
