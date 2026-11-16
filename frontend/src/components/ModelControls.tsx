"use client";
import { ModelAvailability } from "./ModelAvailability";
import { useEffect, useId, useState } from "react";
import {
  MODEL_CATALOG,
  catalogModel,
  initialModelSelection,
  modelOutputLimit,
  type ModelSelection,
  type ModelStrength,
  type PublicModelOption,
} from "@/lib/model-catalog";
import type { Locale, ModelUsage } from "@/lib/types";

export function useModelSelection(initial?: ModelSelection) {
  const [selection, setSelection] = useState<ModelSelection>(() => initialModelSelection(initial));
  const [options, setOptions] = useState<PublicModelOption[] | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    void fetch("/api/models", { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) throw Error("MODEL_CATALOG_UNAVAILABLE");
        const data = await r.json();
        if (
          !Array.isArray(data.models) ||
          !data.models.length ||
          !data.models.every(
            (m: PublicModelOption) => catalogModel(m.key) && typeof m.configured === "boolean",
          )
        )
          throw Error("INVALID_MODEL_CATALOG");
        if (active) {
          setOptions(data.models);
          setSelection((s) => {
            const current = data.models.find((m: PublicModelOption) => m.key === s.modelKey);
            return current?.maxOutputTokens && s.maxOutputTokens !== undefined
              ? {
                  ...s,
                  maxOutputTokens: Math.min(s.maxOutputTokens, current.maxOutputTokens),
                }
              : s;
          });
        }
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, []);
  const model = catalogModel(selection.modelKey)!;
  const option = options?.find((item) => item.key === model.key);
  return {
    selection,
    setSelection,
    options,
    error,
    model,
    option,
    canRun:
      !!option?.configured &&
      !!option.maxOutputTokens &&
      (selection.maxOutputTokens === undefined ||
        selection.maxOutputTokens <= option.maxOutputTokens),
  };
}
type Control = Omit<ReturnType<typeof useModelSelection>, "setSelection"> & {
  setSelection: (value: ModelSelection) => void;
};
export function strengthLabel(strength: ModelStrength | undefined, locale: Locale) {
  const zh = locale === "zh-CN";
  if (strength === undefined) return zh ? "强度未记录" : "Strength not recorded";
  if (strength === "low") return "Think Low";
  return strength === "off"
    ? zh
      ? "不思考 · Non-think"
      : "Non-think"
    : strength === "high"
      ? "Think High"
      : strength === "max"
        ? "Think Max"
        : zh
          ? "供应商默认"
          : "Provider default";
}
export function ModelControls({
  control,
  locale,
  disabled = false,
  modelKeys,
}: {
  control: Control;
  locale: Locale;
  disabled?: boolean;
  modelKeys?: readonly string[];
}) {
  const id = useId(),
    t = (en: string, zh: string) => (locale === "zh-CN" ? zh : en);
  const { selection, setSelection, options, model, option, error } = control;
  const ceiling = option?.maxOutputTokens ?? modelOutputLimit(model.key);
  const strength = selection.strength ?? model.defaultStrength;
  const onlyProviderDefault = (model.strengths as readonly string[]).length === 1;
  const outputLimit = disabled ? (selection.maxOutputTokens ?? ceiling) : ceiling;
  const timeoutMs =
    model.provider === "deepseek"
      ? strength !== "off"
        ? (option?.thinkingTimeoutMs ?? Math.max(option?.timeoutMs ?? 0, 300000))
        : ceiling > 8192
          ? Math.max(option?.timeoutMs ?? 0, 120000)
          : option?.timeoutMs
      : option?.timeoutMs;
  const configurationMessage = error
    ? t(
        "Model configuration unavailable. Reload before running.",
        "模型配置暂不可用，请重新加载后再运行。",
      )
    : !options
      ? t("Loading model configuration…", "正在读取模型配置……")
      : !option?.configured
        ? t(
            "This model is not configured or its pricing has expired.",
            "该模型未配置或价格依据已过期。",
          )
        : null;
  return (
    <fieldset
      className="stack model-controls"
      disabled={disabled}
      aria-describedby={configurationMessage ? `${id}-help` : undefined}
    >
      <legend>{t("Live model settings", "真实模型设置")}</legend>
      {modelKeys?.length !== 1 && (
        <div className="field">
          <label htmlFor={`${id}-model`}>{t("Model", "模型")}</label>
          <select
            id={`${id}-model`}
            className="select"
            value={model.key}
            onChange={(e) => {
              const next = catalogModel(e.target.value)!;
              setSelection({ modelKey: next.key, strength: next.defaultStrength });
            }}
          >
            {MODEL_CATALOG.filter((m) => !modelKeys || modelKeys.includes(m.key)).map((m) => (
              <option
                key={m.key}
                value={m.key}
                disabled={options !== null && !options.some((o) => o.key === m.key && o.configured)}
              >
                {m.provider === "siliconflow" ? "SiliconFlow" : t("Direct", "直连")} · {m.name}
                {options !== null && !options.some((o) => o.key === m.key && o.configured)
                  ? t(" · unavailable", " · 未就绪")
                  : ""}
              </option>
            ))}
          </select>
        </div>
      )}
      {configurationMessage && (
        <p id={`${id}-help`} className="small subtle" role="status">
          {configurationMessage}
        </p>
      )}
      {!disabled && option?.configured && (
        <ModelAvailability selection={selection} locale={locale} />
      )}
      <details>
        <summary>
          {t("Advanced settings", "高级设置")} · {strengthLabel(strength, locale)} ·{" "}
          {`${outputLimit} tokens · ${disabled && selection.maxOutputTokens !== undefined ? t("frozen request", "原请求上限") : t("model maximum", "模型最高上限")}`}
        </summary>
        <div className="stack">
          {option?.configured && option.timeoutMs && (
            <p>
              {t("Request limit", "等待上限")}: {Math.ceil((timeoutMs ?? option.timeoutMs) / 1000)}s
              · {t("fees may apply", "可能产生费用")}
            </p>
          )}
          <div className="field">
            <label htmlFor={`${id}-strength`}>{t("Reasoning strength", "推理强度")}</label>
            <select
              id={`${id}-strength`}
              className="select"
              value={strength}
              disabled={disabled || onlyProviderDefault}
              onChange={(e) =>
                setSelection({ modelKey: model.key, strength: e.target.value as ModelStrength })
              }
            >
              {model.strengths.map((s) => (
                <option key={s} value={s}>
                  {strengthLabel(s, locale)}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor={`${id}-output`}>
              {model.provider === "deepseek" || model.key === "tencent/Hy4-preview"
                ? t("Output token budget (includes reasoning)", "输出 token 预算（含思考）")
                : t("Answer token limit (excludes reasoning)", "正文输出上限（不含思考 tokens）")}
            </label>
            <output id={`${id}-output`} className="small">
              {outputLimit} tokens
            </output>
          </div>
          {onlyProviderDefault && model.defaultStrength === "default" && (
            <p className="small subtle">
              {t(
                "No model-specific strength tiers are verified; provider default is the only option.",
                "尚未核实该模型专属强度档位，仅提供供应商默认。",
              )}
            </p>
          )}
          {option?.configured && option.timeoutMs && (
            <p className="small subtle">
              {t(
                "Reasoning or provider queues may take longer. A timeout does not confirm that the provider stopped or that the request was free; check pending costs before retrying.",
                "思考或供应商排队可能更久。超时不代表供应商已停止或未计费，重试前请先核对待确认费用。",
              )}
            </p>
          )}
          {model.provider === "siliconflow" && (
            <details>
              <summary>{t("Cost and capability notes", "费用与能力说明")}</summary>
              <div className="stack small subtle">
                <p>
                  {t(
                    "Listed in the provider model API on 2026-11-06; paid generation has not been tested. No automatic retries.",
                    "2026-11-06 已在供应商模型列表确认；尚未收费实测生成。关闭自动重试。",
                  )}
                </p>
                <p>
                  {t(
                    "Thinking modes reserve an additional 32,768 tokens. Thinking budgets are soft bounds, not hard billing caps. Existing shared plan limits still apply.",
                    "思考模式额外预留 32,768 tokens。思考预算是软约束，不是实扣硬上限；仍受现有共享套餐额度限制。",
                  )}
                </p>
                {option?.pricing && (
                  <>
                    <p>
                      CNY / 1M tokens ·{" "}
                      {t(
                        "input / output (including reasoning) / cached input",
                        "输入 / 输出（含推理）/ 缓存命中",
                      )}
                      : {option.pricing.inputPerMillion} / {option.pricing.outputPerMillion} /{" "}
                      {option.pricing.cacheHitPerMillion}
                    </p>
                    <p>
                      {t(
                        "Local USD budgeting uses a fixed conservative coefficient, not an exchange rate or provider charge",
                        "本地 USD 预算采用固定保守系数，非汇率、非供应商实扣",
                      )}
                      : 1 CNY → {option.pricing.budgetUsdPerUnit} USD ·{" "}
                      {t("price valid until", "价格有效期至")}{" "}
                      {option.pricing.validUntil.slice(0, 10)}
                    </p>
                  </>
                )}
              </div>
            </details>
          )}
        </div>
      </details>
    </fieldset>
  );
}
export function ModelResultEvidence({
  result,
  locale,
}: {
  result: {
    provider?: string;
    resolvedModel?: string;
    model?: string;
    strength?: ModelStrength;
    usage: Partial<ModelUsage>;
  };
  locale: Locale;
}) {
  return (
    <p className="small subtle model-result-evidence">
      {result.provider} · {result.resolvedModel ?? result.model} ·{" "}
      {strengthLabel(result.strength, locale)} · {result.usage.promptTokens ?? "?"} input +{" "}
      {result.usage.completionTokens ?? "?"} output = {result.usage.totalTokens} tokens
      {result.usage.reasoningTokens !== undefined
        ? ` · ${locale === "zh-CN" ? "其中推理" : "includes reasoning"} ${result.usage.reasoningTokens}`
        : ""}
    </p>
  );
}
