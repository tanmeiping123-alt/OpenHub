import { withIdentity } from "@/lib/server/authenticated-route";
import { validModelSelection } from "@/lib/model-catalog";
import type { ModelSelection } from "@/lib/model-catalog";
import { readModelConfig } from "@/lib/server/model/model-config";
import { getModelQuotaSummary } from "@/lib/server/model/model-quota-repository";
import { withTransaction } from "@/lib/server/db";
import { resolvePricingWindow } from "@/lib/server/model/model-pricing";
import { modelAvailability } from "@/lib/model-availability";
import { toPublicModelError } from "@/lib/server/model/model-errors";

export const runtime = "nodejs";
export const GET = withIdentity(async (request) => {
  const query = new URL(request.url).searchParams;
  const selection = {
    modelKey: query.get("modelKey") ?? undefined,
    strength: query.get("strength") ?? undefined,
  };
  if (!validModelSelection(selection))
    return Response.json({ error: "INVALID_MODEL_SELECTION" }, { status: 400 });
  try {
    const config = readModelConfig(process.env, selection as ModelSelection);
    if (config.mode !== "LIVE") return Response.json({ status: "unconfigured" });
    const quota = await getModelQuotaSummary(config, true);
    const price = await withTransaction(
      async (c) =>
        (
          await c.query(
            `SELECT output_usd_per_million FROM model_pricing_snapshots WHERE provider=$1 AND requested_model=$2 AND product_version=$3 AND pricing_window=$4 AND effective_at<=now() AND valid_until>now() ORDER BY effective_at DESC,captured_at DESC,id DESC LIMIT 1`,
            [
              config.provider,
              config.model,
              config.productVersion,
              resolvePricingWindow(config.pricingWindow),
            ],
          )
        ).rows[0],
    );
    if (!price) return Response.json({ status: "unconfigured" });
    const minimumTokens =
      (config.maxOutputTokens + (config.reasoningTokenReserve ?? 0)) * (config.maxRetries + 1);
    const minimumUsd =
      Math.ceil(((minimumTokens * Number(price.output_usd_per_million)) / 1000000) * 1e8) / 1e8;
    return Response.json({
      status: modelAvailability(quota, minimumTokens, minimumUsd),
      minimumTokens,
      minimumUsd,
      remainingTokens: quota.remainingTokens,
      remainingUsd: quota.remainingCostUsd,
      unlimited: quota.unlimited,
      periodEnd: quota.periodEnd,
    });
  } catch (error) {
    const detail = toPublicModelError(error);
    return Response.json({ error: detail.code }, { status: detail.status });
  }
});
