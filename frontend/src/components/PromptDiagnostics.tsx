"use client";
import type { Locale, PromptVersion } from "@/lib/types";
import { diagnosePrompt } from "@/lib/prompt-diagnostics";
import { ResultActions } from "./ResultActions";
import { EvidenceDisclosure } from "./EvidenceDisclosure";

export function PromptDiagnostics({ version, locale }: { version: PromptVersion; locale: Locale }) {
  const t = (en: string, zh: string) => (locale === "zh-CN" ? zh : en);
  const checks = diagnosePrompt(version.content, locale);
  const marker = (found: boolean) =>
    found
      ? t("Text marker found · review meaning", "发现文字线索 · 含义待核对")
      : t("Not detected · review manually", "未检测到 · 请人工核对");
  const disclaimer = t(
    "Local text-marker scan of the saved version; no model call or fee. Markers do not prove quality, and missing markers do not prove a defect. This is not a scored evaluation or a Layer 3 execution test.",
    "仅扫描已保存版本的文字线索，不调用模型、不收费。命中不代表质量合格，未命中不代表存在缺陷；这不是评分评估，也不是 Layer 3 执行测试。",
  );
  const text = [
    `# ${t("Prompt text diagnostics", "Prompt 文本诊断")}`,
    `v${version.number} · ${version.id}`,
    disclaimer,
    ...checks.map(
      (c) =>
        `## ${c.label}\n${marker(!!c.evidence)}${c.evidence ? `\n${t("Source excerpt", "来源摘录")}: ${c.evidence.quote}` : ""}`,
    ),
  ].join("\n\n");
  return (
    <section
      className="panel panel-pad stack"
      aria-label={t("Prompt text diagnostics", "Prompt 文本诊断")}
    >
      <h3>{t("Saved-version text diagnostics · no charge", "已保存版本文本诊断 · 不收费")}</h3>
      <p>{t("Text clues only · not a quality score", "仅检查文字线索，不作质量评分")}</p>
      <p className="small">
        {t("Source", "检查对象")}: v{version.number} · {t("saved text only", "仅已保存文本")}
      </p>
      <ul className="stack small" style={{ paddingLeft: 20 }}>
        {checks.map((check) => (
          <li key={check.id}>
            <strong>{check.label}</strong> · {marker(!!check.evidence)}
            {check.evidence && (
              <details>
                <summary>{t("View exact excerpt", "查看原文线索")}</summary>
                <blockquote
                  style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", margin: "8px 0" }}
                >
                  {check.evidence.quote}
                </blockquote>
              </details>
            )}
          </li>
        ))}
      </ul>

      <EvidenceDisclosure locale={locale}>
        <p>{disclaimer}</p>
        <p className="small">
          TEXT_MARKERS_V1 · {version.id} · {t("No scores or reports changed", "未修改评分与报告")}
        </p>
      </EvidenceDisclosure>
      <ResultActions
        locale={locale}
        title={t("Prompt text diagnostics", "Prompt 文本诊断")}
        content={text}
      />
    </section>
  );
}
