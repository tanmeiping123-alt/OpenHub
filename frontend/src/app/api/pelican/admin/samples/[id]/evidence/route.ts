import { getPool } from "@/lib/server/db";
import { AccountError } from "@/lib/server/account-errors";
import { requireActivePelicanAdmin } from "@/lib/server/pelican/data";
import { pelicanRoute, type PelicanIdContext } from "@/lib/server/pelican/http";
export const runtime = "nodejs";
export const GET = pelicanRoute(async (_request, ctx: PelicanIdContext) => {
  await requireActivePelicanAdmin();
  const row = (
    await getPool().query(
      `SELECT b.prompt_text,s.request_payload,s.response_model,s.response_finish_reason,e.id,e.status,e.prompt_tokens,e.completion_tokens,e.total_tokens,e.provider_request_id,e.completed_at,e.latency_ms,e.error_code,e.quota_reservation_status,e.reconciliation_status FROM pelican_samples s JOIN pelican_batches b ON b.id=s.batch_id LEFT JOIN model_executions e ON e.id=s.execution_id WHERE s.id=$1`,
      [(await ctx.params).id],
    )
  ).rows[0];
  if (!row) throw new AccountError("PELICAN_SAMPLE_NOT_FOUND", 404);
  return Response.json({
    evidence: {
      prompt: row.prompt_text,
      requestPayload: row.request_payload,
      executionId: row.id ?? null,
      status: row.status ?? "QUEUED",
      usage: {
        promptTokens: row.prompt_tokens ?? null,
        completionTokens: row.completion_tokens ?? null,
        totalTokens: row.total_tokens ?? null,
      },
      providerRequestId: row.provider_request_id ?? null,
      model: row.response_model ?? null,
      finishReason: row.response_finish_reason ?? null,
      generatedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
      latencyMs: row.latency_ms ?? null,
      errorCode: row.error_code ?? null,
      quotaStatus: row.quota_reservation_status ?? null,
      reconciliationStatus: row.reconciliation_status ?? null,
    },
  });
});
