// Read-only local audit. No credentials, content bodies or environment values are printed.
import { Client } from "pg";
const connectionString = process.env.DATABASE_URL;
const url = new URL(connectionString ?? "invalid:");
if (
  !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
  url.pathname !== "/promptmaster_dev"
)
  throw Error("LOCAL_DATABASE_REQUIRED");
const c = new Client({ connectionString, connectionTimeoutMillis: 5000 });
await c.connect();
try {
  await c.query("BEGIN READ ONLY");
  const tables = [
    "schema_migrations",
    "administrator_users",
    "regular_users",
    "prompts",
    "prompt_versions",
    "evaluation_reports",
    "history_records",
    "model_executions",
    "skills",
    "skill_versions",
    "skill_resources",
    "skill_import_jobs",
    "skill_registry_events",
    "skill_personal_access",
    "skill_library_entries",
    "skill_library_submissions",
    "skill_library_withdrawals",
    "skill_use_events",
    "skill_prepared_sources",
    "prompt_creation_requests",
    "skill_workflow_plans",
    "skill_workflow_runs",
    "skill_model_contexts",
    "prompt_skill_sources",
    "skill_optimization_applications",
  ];
  const counts = {};
  for (const table of tables)
    counts[table] = Number((await c.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n);
  const usage = (
    await c.query(
      "SELECT COALESCE(sum(settled_tokens),0)::integer AS tokens,COALESCE(sum(settled_cost_usd),0)::text AS local_estimated_usd,COALESCE(sum(reserved_tokens),0)::integer AS reserved_tokens FROM model_quota_usage_daily",
    )
  ).rows[0];
  console.log(JSON.stringify({ readOnly: true, counts, usage }, null, 2));
  await c.query("ROLLBACK");
} finally {
  await c.end();
}
