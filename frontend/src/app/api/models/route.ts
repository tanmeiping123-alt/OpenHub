import { withIdentity } from "@/lib/server/authenticated-route";
import { MODEL_CATALOG } from "@/lib/model-catalog";
import { readModelConfig, readModelOutputCeiling } from "@/lib/server/model/model-config";
import { withTransaction } from "@/lib/server/db";

export const runtime = "nodejs";

// Server configuration only. Never calls a provider or returns credentials.
export const GET = withIdentity(async () => {
  const prices = await withTransaction(
    async (client) =>
      (
        await client.query(
          `SELECT DISTINCT ON (provider, requested_model) provider, requested_model,
       native_currency, native_input_per_million, native_output_per_million,
       native_cache_hit_per_million, budget_usd_per_native_unit, source_url, valid_until
     FROM model_pricing_snapshots WHERE effective_at <= now() AND valid_until > now()
     ORDER BY provider, requested_model, effective_at DESC, captured_at DESC, id DESC`,
        )
      ).rows,
  );
  return Response.json({
    models: MODEL_CATALOG.map((item) => {
      try {
        const config = readModelConfig(process.env, { modelKey: item.key });
        if (config.mode === "DISABLED") return { key: item.key, configured: false };
        const price = prices.find(
          (p) => p.provider === config.provider && p.requested_model === config.model,
        );
        const thinking =
          item.provider === "deepseek"
            ? readModelConfig(process.env, { modelKey: item.key, strength: "low" })
            : null;
        return {
          key: item.key,
          configured: !!price,
          maxOutputTokens: readModelOutputCeiling(process.env, item.key),
          timeoutMs: config.timeoutMs,
          ...(thinking?.mode === "LIVE" ? { thinkingTimeoutMs: thinking.timeoutMs } : {}),
          ...(price?.native_currency
            ? {
                pricing: {
                  currency: price.native_currency,
                  inputPerMillion: Number(price.native_input_per_million),
                  outputPerMillion: Number(price.native_output_per_million),
                  cacheHitPerMillion: Number(price.native_cache_hit_per_million),
                  budgetUsdPerUnit: Number(price.budget_usd_per_native_unit),
                  sourceUrl: price.source_url,
                  validUntil: new Date(price.valid_until).toISOString(),
                },
              }
            : {}),
        };
      } catch {
        return { key: item.key, configured: false };
      }
    }),
  });
});
