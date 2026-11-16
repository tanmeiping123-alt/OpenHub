// Local launcher only: no migrations, model calls, credential/body logging or writes.
import path from "node:path";
import pg from "pg";

const normalize = (value) => path.resolve(value).toLowerCase();
let client;
try {
  if (!process.env.LOCALAPPDATA) throw Error("LOCAL_STATE_DIRECTORY_REQUIRED");
  const action = process.argv[2];
  if (!["config", "database", "database-existing"].includes(action))
    throw Error("INVALID_HEALTH_ACTION");
  const url = new URL(process.env.DATABASE_URL ?? "invalid:");
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.port !== "55432" ||
    url.pathname !== "/promptmaster_dev" ||
    url.search ||
    url.hash
  )
    throw Error("EXPECTED_LOCAL_PROJECT_DATABASE_REQUIRED");
  if (action === "database" || action === "database-existing") {
    client = new pg.Client({
      connectionString: url.toString(),
      connectionTimeoutMillis: 4000,
      query_timeout: 4000,
      statement_timeout: 4000,
      application_name: "promptmaster-launcher-readiness",
    });
    await client.connect();
    const { rows } = await client.query(`SELECT current_database() AS database,
      current_setting('data_directory') AS directory, current_setting('port') AS port`);
    if (rows[0].database !== "promptmaster_dev" || rows[0].port !== "55432")
      throw Error("PROJECT_DATABASE_IDENTITY_MISMATCH");
    if (action === "database") {
      const expected = path.join(process.env.LOCALAPPDATA, "PromptMasterAI", "postgres-data");
      if (normalize(rows[0].directory) !== normalize(expected))
        throw Error("PROJECT_DATABASE_IDENTITY_MISMATCH");
    } else {
      const schema = await client.query(`SELECT
        to_regclass('public.schema_migrations') IS NOT NULL AS migrations,
        to_regclass('public.pelican_batches') IS NOT NULL AS pelican`);
      if (!schema.rows[0].migrations || !schema.rows[0].pelican)
        throw Error("PROJECT_DATABASE_IDENTITY_MISMATCH");
    }
  }
  console.log(
    action === "config"
      ? "LOCAL_CONFIG_OK"
      : action === "database"
        ? "PROJECT_DATABASE_READY"
        : "PROJECT_DATABASE_EXTERNAL_READY",
  );
} catch (error) {
  const code = /^[A-Z][A-Z0-9_]{1,80}$/.test(error.code ?? "")
    ? error.code
    : /^[A-Z][A-Z0-9_]{1,80}$/.test(error.message ?? "")
      ? error.message
      : "LOCAL_SERVICE_CHECK_FAILED";
  console.error(code);
  process.exitCode = 1;
} finally {
  await client?.end().catch(() => {});
}
