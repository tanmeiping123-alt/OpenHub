import { loadEnvConfig } from "@next/env";
import { Client } from "pg";

loadEnvConfig(process.cwd());

const testOwnerSql =
  "SELECT user_id FROM regular_users WHERE email ~ '^e2e-[a-f0-9-]{36}@example[.]test$'";

async function withClient<T>(work: (client: Client) => Promise<T>): Promise<T> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString)
    throw new Error("DATABASE_URL is required for database-backed E2E cleanup.");
  const client = new Client({ connectionString, connectionTimeoutMillis: 4000 });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

export async function cleanupE2ePrompt(promptId: string, title: string) {
  if (!title.startsWith("E2E test: ")) throw new Error("Refusing to clean a non-test Prompt.");
  if (!process.env.DATABASE_URL) return;
  await withClient(async (client) => {
    await client.query("BEGIN");
    try {
      const ownedTestPrompt = await client.query(
        `SELECT id FROM prompts
         WHERE id = $1 AND owner_user_id IN (${testOwnerSql}) AND title = $2
           AND kind = 'PERSONAL_PROMPT'`,
        [promptId, title],
      );
      if (!ownedTestPrompt.rowCount) {
        await client.query("ROLLBACK");
        return;
      }
      await client.query(
        `DELETE FROM model_comparison_results
         WHERE session_id IN (SELECT id FROM playground_sessions WHERE prompt_id = $1)`,
        [promptId],
      );
      await client.query("DELETE FROM playground_sessions WHERE prompt_id = $1", [promptId]);
      await client.query("DELETE FROM optimization_records WHERE prompt_id = $1", [promptId]);
      await client.query("DELETE FROM evaluation_reports WHERE prompt_id = $1", [promptId]);
      await client.query("DELETE FROM history_records WHERE prompt_id = $1", [promptId]);
      await client.query("DELETE FROM favorites WHERE prompt_id = $1", [promptId]);
      await client.query("DELETE FROM library_items WHERE prompt_id = $1", [promptId]);
      await client.query("UPDATE prompts SET current_version_id = NULL WHERE id = $1", [promptId]);
      await client.query("DELETE FROM prompt_creation_requests WHERE prompt_id=$1", [promptId]);
      const versions = await client.query(
        "SELECT id FROM prompt_versions WHERE prompt_id = $1 ORDER BY version_number DESC",
        [promptId],
      );
      for (const version of versions.rows) {
        await client.query("DELETE FROM prompt_versions WHERE id = $1", [version.id]);
      }
      await client.query("DELETE FROM prompts WHERE id = $1", [promptId]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
}

export async function cleanupE2eCalibrationReport(reportId: string, evidenceReason: string) {
  if (!evidenceReason.startsWith("Synthetic UI test calibration ")) {
    throw new Error("Refusing to clean a report without the E2E test evidence marker.");
  }
  await withClient(async (client) => {
    await client.query(
      `DELETE FROM evaluation_reports
       WHERE id = $1 AND owner_user_id IN (${testOwnerSql}) AND source = 'LOCAL_HUMAN_CALIBRATION'
         AND calibration_snapshot->'assessments'->0->>'reason' = $2`,
      [reportId, evidenceReason],
    );
  });
}
