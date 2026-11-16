"use client";
import { useState } from "react";
import type { Locale } from "@/lib/types";
import { dateLabel, request, text } from "./client";
type Evidence = {
  prompt: string;
  requestPayload: unknown;
  executionId: string | null;
  status: string;
  usage: {
    promptTokens: number | null;
    completionTokens: number | null;
    totalTokens: number | null;
  } | null;
  providerRequestId: string | null;
  model: string | null;
  finishReason: string | null;
  generatedAt: string | null;
  latencyMs: number | null;
  errorCode: string | null;
};
export function PelicanEvidence({ sampleId, locale }: { sampleId: string; locale: Locale }) {
  const [evidence, setEvidence] = useState<Evidence | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const t = (en: string, zh: string) => text(locale, en, zh),
    unknown = t("Unknown", "未知");
  async function load() {
    if (evidence || loading) return;
    setLoading(true);
    setError(false);
    try {
      const response = await request<{ evidence: Evidence }>(
        `/api/pelican/admin/samples/${encodeURIComponent(sampleId)}/evidence`,
      );
      setEvidence(response.evidence);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }
  return (
    <details
      className="pelican-snapshot pelican-evidence"
      onToggle={(e) => {
        if (e.currentTarget.open) void load();
      }}
    >
      <summary onClick={() => void load()}>{t("Call and usage records", "调用与用量记录")}</summary>
      {loading && <p role="status">{t("Loading records…", "正在读取记录…")}</p>}
      {error && (
        <p role="alert">
          {t(
            "Records unavailable. Close and reopen to retry.",
            "调用记录暂不可用，请收起后重新打开。",
          )}
        </p>
      )}
      {evidence && (
        <>
          <dl>
            <dt>{t("Execution", "执行编号")}</dt>
            <dd>{evidence.executionId ?? unknown}</dd>
            <dt>{t("Recorded call state", "调用记录状态")}</dt>
            <dd>{evidence.status}</dd>
            <dt>{t("Provider request", "供应商请求编号")}</dt>
            <dd>{evidence.providerRequestId ?? unknown}</dd>
            <dt>{t("Response model", "响应模型")}</dt>
            <dd>{evidence.model ?? unknown}</dd>
            <dt>{t("Input tokens", "输入 tokens")}</dt>
            <dd>{evidence.usage?.promptTokens ?? unknown}</dd>
            <dt>{t("Output tokens", "输出 tokens")}</dt>
            <dd>{evidence.usage?.completionTokens ?? unknown}</dd>
            <dt>{t("Total tokens", "合计 tokens")}</dt>
            <dd>{evidence.usage?.totalTokens ?? unknown}</dd>
            <dt>{t("Generated (UTC+8)", "生成时间 UTC+8")}</dt>
            <dd>{dateLabel(evidence.generatedAt, locale)}</dd>
            <dt>{t("Duration", "耗时")}</dt>
            <dd>{evidence.latencyMs === null ? unknown : `${evidence.latencyMs / 1000} s`}</dd>
            <dt>{t("Finish reason", "完成原因")}</dt>
            <dd>{evidence.finishReason ?? unknown}</dd>
            <dt>{t("Error", "错误状态")}</dt>
            <dd>
              {evidence.errorCode
                ? t("A call error was recorded", "已记录调用错误")
                : t("No recorded error", "无已记录错误")}
            </dd>
          </dl>
          <p>{t("Recorded prompt", "实际题面")}</p>
          <p className="pelican-evidence-prompt">{evidence.prompt}</p>
          <details>
            <summary>{t("Actual request parameters", "实际发送参数")}</summary>
            <pre>{JSON.stringify(evidence.requestPayload, null, 2)}</pre>
          </details>
        </>
      )}
    </details>
  );
}
