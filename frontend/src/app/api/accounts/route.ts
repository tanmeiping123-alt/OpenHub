import { withIdentity } from "@/lib/server/authenticated-route";
import { AccountError } from "@/lib/server/accounts";
import { withTransaction } from "@/lib/server/db";
import { requireActor } from "@/lib/server/skills/skill-library";
export const runtime = "nodejs";
export const GET = withIdentity(async (request: Request) => {
  if (requireActor().role !== "ADMIN") throw new AccountError("ADMIN_REQUIRED", 403);
  if (new URL(request.url).search) throw new AccountError("INVALID_INPUT");
  return Response.json(
    await withTransaction(async (c) => ({
      administrators: (
        await c.query(
          'SELECT user_id AS id,email,disabled,created_at AS "createdAt" FROM administrator_users ORDER BY created_at LIMIT 200',
        )
      ).rows,
      users: (
        await c.query(
          'SELECT user_id AS id,email,disabled,created_at AS "createdAt" FROM regular_users ORDER BY created_at LIMIT 200',
        )
      ).rows,
    })),
  );
}, true);
