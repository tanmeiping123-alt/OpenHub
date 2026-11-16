import { withTransaction } from "../db";
import { AccountError } from "../accounts";
export async function reserveSourcePreparation(ownerId: string) {
  const n = await withTransaction(
    async (c) =>
      (
        await c.query(
          `INSERT INTO skill_source_preparation_limits(owner_user_id,attempts,window_start) VALUES($1,1,clock_timestamp())
 ON CONFLICT(owner_user_id) DO UPDATE SET attempts=CASE WHEN skill_source_preparation_limits.window_start<clock_timestamp()-interval '1 hour' THEN 1 ELSE skill_source_preparation_limits.attempts+1 END,
 window_start=CASE WHEN skill_source_preparation_limits.window_start<clock_timestamp()-interval '1 hour' THEN clock_timestamp() ELSE skill_source_preparation_limits.window_start END RETURNING attempts`,
          [ownerId],
        )
      ).rows[0].attempts,
  );
  if (n > 20) throw new AccountError("SOURCE_PREPARATION_LIMIT", 429);
}
