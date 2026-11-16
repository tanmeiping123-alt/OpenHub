"use client";
import { useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { promptActionHref } from "@/lib/prompt-navigation";
import { generateLiveEvaluationReport, toLiveAdvice } from "@/lib/api-client";
import {
  MODEL_EVALUATION_VERSION,
  LEGACY_MODEL_EVALUATION_VERSION,
  modelEvaluationMarkdown,
  modelEvaluationPrinciples,
  modelEvaluationRulesForReport,
  type ReviewEvidence,
  type ReviewFinding,
} from "@/lib/model-evaluation";
import { modelErrorDetail } from "@/lib/model-error-messages";
import { useAppStore } from "@/lib/store";
import type { Locale, Prompt, PromptVersion } from "@/lib/types";
import { EvidenceDisclosure } from "./EvidenceDisclosure";
import { ModelControls, ModelResultEvidence, useModelSelection } from "./ModelControls";
import { modelSelection, validModelSelection, type ModelSelection } from "@/lib/model-catalog";
import { ResultActions } from "./ResultActions";

function subscribeReceipts(notify: () => void) {
  window.addEventListener("storage", notify);
  return () => window.removeEventListener("storage", notify);
}

function decodeReceipt(raw: string | null): { key: string; selection?: ModelSelection } | null {
  if (!raw) return null;
  // Pre-upgrade receipts contain only the key and must retain their old intent.
  if (/^[A-Za-z0-9_-]{8,100}$/.test(raw)) return { key: raw };
  try {
    const saved = JSON.parse(raw);
    if (
      typeof saved.key === "string" &&
      /^[A-Za-z0-9_-]{8,100}$/.test(saved.key) &&
      saved.selection &&
      validModelSelection(saved.selection) &&
      (saved.selection.modelKey === undefined || saved.selection.modelKey === "deepseek-direct")
    )
      return { key: saved.key, selection: modelSelection(saved.selection) };
  } catch {
    /* An invalid receipt never causes an automatic supplier request. */
  }
  return null;
}

export function ModelEvaluationPanel({
  locale,
  prompt,
  version,
  disabled,
}: {
  locale: Locale;
  prompt: Prompt;
  version: PromptVersion;
  disabled: boolean;
}) {
  const { state, dispatch, accountId } = useAppStore();
  const control = useModelSelection();
  const t = (en: string, zh: string) => (locale === "zh-CN" ? zh : en);
  const storageKey = `pm-evaluation-request:${accountId}:${version.id}:${locale}`;
  const recoveredKey = useSyncExternalStore(
    subscribeReceipts,
    () => {
      try {
        return sessionStorage.getItem(storageKey);
      } catch {
        return null;
      }
    },
    () => null,
  );
  const [receipt, setReceipt] = useState<{
    scope: string;
    key: string | null;
    selection?: ModelSelection;
  } | null>(null);
  const activeReceipt = receipt?.scope === storageKey ? receipt : decodeReceipt(recoveredKey);
  const invalidReceipt = receipt?.scope !== storageKey && !!recoveredKey && !activeReceipt;
  const requestKey = activeReceipt?.key;
  const setRequestKey = (key: string | null) => setReceipt({ scope: storageKey, key });
  const canRun = control.canRun && !invalidReceipt;
  const [busy, setBusy] = useState(false);
  const gate = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const history = state.liveAdvice
    .filter(
      (r) =>
        r.kind === "EVALUATION_REPORT" &&
        r.promptId === prompt.id &&
        r.versionId === version.id &&
        [MODEL_EVALUATION_VERSION, LEGACY_MODEL_EVALUATION_VERSION].includes(
          r.evaluation?.principlesVersion ?? "",
        ),
    )
    .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt));
  const selected = history.find((r) => r.executionId === selectedId) ?? history[0];
  const report = selected?.evaluation;
  const [choices, setChoices] = useState<{ report: string; indexes: number[] }>({
    report: "",
    indexes: [],
  });
  const selectedIndexes = choices.report === selected?.executionId ? choices.indexes : [];
  const rules = report
    ? modelEvaluationRulesForReport(report, prompt.taskType, locale)
    : modelEvaluationPrinciples(prompt.taskType, locale, version.content);
  const labels = {
    PRESENT: t("Supported by text", "原文有支持"),
    NEEDS_IMPROVEMENT: t("Needs improvement", "建议改进"),
    INSUFFICIENT_INFORMATION: t("Insufficient information", "信息不足"),
    NOT_APPLICABLE: t("Not applicable", "不适用"),
  };
  const showEvidence = (e: ReviewEvidence) =>
    e.kind === "EXCERPT" ? (
      <blockquote className="small">{e.quote}</blockquote>
    ) : (
      <p className="small subtle">
        {e.kind === "OBSERVED_ABSENCE"
          ? t(
              "Model-reported necessary omission in reviewed text; verify manually.",
              "模型认为已读全文存在必要要求遗漏，请人工复核。",
            )
          : t(
              "Required material is unread or unavailable; not a proven defect.",
              "所需材料未读取或信息不足，不等于已证缺陷。",
            )}
      </p>
    );
  const finding = (f: ReviewFinding) => (
    <section className="stack model-evaluation-finding" key={f.id}>
      <h4>{[...rules.layer1, ...rules.layer2].find((d) => d.id === f.id)?.name ?? f.id}</h4>
      <p>
        <span className="badge">{labels[f.judgment]}</span>
      </p>
      <p className="small">{f.reason}</p>
      {showEvidence(f.evidence)}
    </section>
  );
  async function run() {
    if (disabled || gate.current || !canRun) return;
    gate.current = true;
    setBusy(true);
    setError(null);
    const key = requestKey ?? crypto.randomUUID();
    const selection: ModelSelection = requestKey
      ? (activeReceipt?.selection ?? {})
      : {
          ...(control.selection.strength !== "off" ? { strength: control.selection.strength } : {}),
          ...(control.selection.maxOutputTokens !== undefined
            ? { maxOutputTokens: control.selection.maxOutputTokens }
            : {}),
        };
    setReceipt({ scope: storageKey, key, selection });
    try {
      sessionStorage.setItem(storageKey, JSON.stringify({ key, selection }));
    } catch {
      /* Never create a second request automatically. */
    }
    try {
      const result = await generateLiveEvaluationReport({
        promptId: prompt.id,
        versionId: version.id,
        locale,
        requestKey: key,
        ...selection,
      });
      if (result.kind !== "ready") {
        setError(modelErrorDetail(result, locale));
        return;
      }
      await dispatch({
        type: "HYDRATE",
        saved: {
          liveAdvice: [
            toLiveAdvice(result.data),
            ...state.liveAdvice.filter((r) => r.executionId !== result.data.executionId),
          ],
        },
      });
      setSelectedId(result.data.executionId);
      setRequestKey(null);
      try {
        sessionStorage.removeItem(storageKey);
      } catch {
        /* Recovery of the same key is idempotent. */
      }
    } catch {
      setError(
        t(
          "Report recovery could not finish. Keep the request key and refresh saved records before another request.",
          "报告恢复未完成。请保留当前请求，刷新已保存记录后再处理，勿直接重复调用。",
        ),
      );
    } finally {
      gate.current = false;
      setBusy(false);
    }
  }
  return (
    <section
      className="panel panel-pad stack model-evaluation-panel"
      aria-busy={busy}
      aria-label={t("Live evaluation report", "真实模型评估报告")}
    >
      <h2>{t("Live evaluation report", "真实模型评估报告")}</h2>
      <p className="small">
        DeepSeek-V4.1-Flash-1017 · {t("Direct DeepSeek", "DeepSeek 官方直连")}
      </p>
      <details>
        <summary>{t("Review principles and boundaries", "评估原则与适用边界")}</summary>
        <div className="stack small">
          <p>
            {t(
              "Based on the existing Layer 1 working baseline and task-specific qualitative guidance. Review prompt expression, not answer correctness. Missing attachments are unknown, not automatic defects. No numeric scoring or cross-layer total is enabled.",
              "沿用既有 Layer 1 工作基线及任务专项定性原则。只评估 Prompt 的要求表达，不证明答案正确；缺少附件属于未知，不自动判为缺陷。不启用数值评分或跨层总分。",
            )}
          </p>
          {rules.layer1.map((d) => (
            <div key={d.id}>
              <strong>{d.name}</strong>
              <ul>
                {d.checks.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            </div>
          ))}
          {rules.layer2.map((d) => (
            <p key={d.id}>
              <strong>{d.name}</strong>：{d.guide}
            </p>
          ))}
        </div>
      </details>
      <p className="small subtle">
        {t(
          "Review this saved Prompt with cited findings. Output uses the model maximum; reasoning is adjustable. Uses model credits, with no automatic retries.",
          "为已保存的 Prompt 提供原文依据与修改建议。使用模型最高输出上限，思考可调；消耗模型额度，不自动重试。",
        )}
      </p>
      <ModelControls
        control={{
          ...control,
          selection: activeReceipt?.selection
            ? { modelKey: "deepseek-direct", strength: "off", ...activeReceipt.selection }
            : control.selection,
        }}
        modelKeys={["deepseek-direct"]}
        locale={locale}
        disabled={disabled || busy || !!requestKey}
      />
      {disabled && (
        <p role="status" className="small">
          {t(
            "Save your edits before evaluating; this report belongs to the saved version only.",
            "请先保存修改再评估；报告只对应当前已保存版本。",
          )}
        </p>
      )}
      {control.error && (
        <p role="alert">
          {t(
            "Model availability could not be checked. Refresh before requesting a report.",
            "无法确认直连模型配置，请刷新后再试。",
          )}
        </p>
      )}
      {control.options && !canRun && (
        <p role="status" className="small">
          {t(
            "Direct DeepSeek configuration or the selected budget is unavailable. No request has been sent.",
            "直连 DeepSeek 配置或所选预算暂不可用，当前未发送请求。",
          )}
        </p>
      )}
      <div className="result-action-row">
        <button
          className="btn btn-primary"
          disabled={disabled || busy || !canRun}
          onClick={() => void run()}
        >
          {busy
            ? t("Evaluating…", "正在评估……")
            : requestKey
              ? t("Recover evaluation request", "恢复评估请求")
              : t("Evaluate with DeepSeek · Live", "DeepSeek 真实评估并生成报告")}
        </button>
        {requestKey && (
          <button
            className="btn"
            disabled={busy || disabled}
            onClick={() => {
              if (
                !window.confirm(
                  t(
                    "The earlier request may still be processing or charged. Start a separate potentially billable report?",
                    "先前请求可能仍在处理或已经收费。确认新建另一份可能收费的评估请求？",
                  ),
                )
              )
                return;
              setRequestKey(null);
              setError(null);
              try {
                sessionStorage.removeItem(storageKey);
              } catch {
                /* Keep the in-memory choice. */
              }
            }}
          >
            {t("Start a separate request", "新建另一评估请求")}
          </button>
        )}
      </div>
      {error && (
        <div role="alert" className="small">
          <p>{error}</p>
          <p>
            {t(
              "Recover reuses the same request key; it will not repeat an existing supplier call. Check saved records and pending costs in Settings before starting another request.",
              "恢复会沿用同一请求，不重复派发已有供应商调用。请先查看已保存报告及设置中的待核对费用，再决定是否新建请求。",
            )}
          </p>
        </div>
      )}
      {!report && (
        <p className="small subtle" role="status">
          {t(
            "No real model evaluation report for this version yet. Evaluate it directly; no Playground output is required.",
            "此版本尚无真实模型评估报告。可直接评估，无需先在 Playground 执行。",
          )}
        </p>
      )}
      {report && selected && (
        <>
          <p role="status" className="small">
            {t(
              "Saved · bound to this version · verify model conclusions",
              "已保存 · 绑定此版本 · 模型结论需人工复核",
            )}
          </p>
          <label htmlFor={`live-report-history-${version.id}`}>
            {t("Model evaluation history for this version", "此版本的真实评估历史")}
          </label>
          <select
            id={`live-report-history-${version.id}`}
            className="select"
            value={selected.executionId}
            disabled={busy}
            onChange={(e) => setSelectedId(e.target.value)}
          >
            {history.map((r) => (
              <option key={r.executionId} value={r.executionId}>
                {r.productVersion} · {r.createdAt} · {r.evaluation?.principlesVersion}
              </option>
            ))}
          </select>
          <div className="evaluation-verdict">
            <span>{t("Review conclusion", "评估结论")}</span>
            <h3>
              {report.suggestions.length
                ? t(
                    `${report.suggestions.length} changes worth considering`,
                    `${report.suggestions.length} 项值得考虑的改进`,
                  )
                : t("You can keep this version", "可以保留当前版本")}
            </h3>
            <p>{report.summary}</p>
          </div>
          <h3>{t("Prioritized optimization suggestions", "优先优化建议")}</h3>
          {report.suggestions.length === 0 && (
            <p className="small">
              {t(
                "The model proposed no edits; this is not proof of correctness.",
                "模型未提出修改项，不代表内容已被证明正确。",
              )}
            </p>
          )}
          {report.suggestions.map((s, i) => (
            <section className="stack model-evaluation-finding" key={i}>
              <label className="evaluation-choice">
                <input
                  type="checkbox"
                  checked={selectedIndexes.includes(i)}
                  onChange={(e) =>
                    setChoices({
                      report: selected.executionId,
                      indexes: e.target.checked
                        ? [...selectedIndexes, i]
                        : selectedIndexes.filter((n) => n !== i),
                    })
                  }
                />
                {t("Use this suggestion in optimization", "将这条建议带入优化")}
              </label>
              <h4>
                {i + 1}.{" "}
                {t(
                  s.priority,
                  s.priority === "HIGH"
                    ? "高优先级"
                    : s.priority === "MEDIUM"
                      ? "中优先级"
                      : "低优先级",
                )}{" "}
                · {s.issue}
              </h4>
              {showEvidence(s.evidence)}
              <p className="small">{s.replacement}</p>
              <p className="small subtle">{s.rationale}</p>
            </section>
          ))}
          <details className="evaluation-evidence">
            <summary>{t("Read the full analysis and evidence", "展开完整分析与原文依据")}</summary>
            <div className="stack">
              <h3>{t("Layer 1 · General quality", "Layer 1 · 通用质量")}</h3>
              {report.layer1.map(finding)}
              <h3>{t("Layer 2 · Task-specific review", "Layer 2 · 任务专项")}</h3>
              {report.layer2Status === "NOT_AVAILABLE" ? (
                <p className="small">
                  {t(
                    "No task-specific checks identified in this report's principles; no score.",
                    "本报告原则未识别出适用的专项检查；无分数。",
                  )}
                </p>
              ) : (
                <>
                  <p className="small subtle">
                    {t(
                      "Qualitative checks only; candidate profiles are not approved numeric rubrics.",
                      "仅定性核对；候选专项规则不等于正式数值量表。",
                    )}
                  </p>
                  {report.layer2.map(finding)}
                </>
              )}
              <h3>{t("Layer 3 · Execution boundary", "Layer 3 · 执行边界")}</h3>
              <p className="small">
                {report.layer3.status === "NOT_EXECUTED"
                  ? t(
                      "No real execution evidence at review time. Not executed; no score or grade.",
                      "评估时无真实执行证据。未执行；无分数、无等级。",
                    )
                  : t(
                      "A real execution existed at review time, but this report did not review its output; ungraded.",
                      "评估时已有真实执行记录，但本报告未审查其输出；保持未评分。",
                    )}
              </p>
            </div>
          </details>
          <h3>{t("Next checks", "下一步核对")}</h3>
          <ul>
            {report.nextChecks.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
          <p className="small subtle">
            {t(
              "Suggestions have not changed your prompt. Review and save as a new version in the editor, or request a separate optimization.",
              "建议尚未修改 Prompt。请在编辑器中复核后保存为新版本，或单独发起优化。",
            )}
          </p>
          <ResultActions
            locale={locale}
            title={t("Model evaluation report", "模型评估报告")}
            content={`${modelEvaluationMarkdown(report, prompt.taskType, locale)}\n\n${selected.productVersion} · ${selected.provider} · ${selected.model} · ${selected.createdAt}\nPromptVersion: ${version.id}\nExecution: ${selected.executionId}\n${selected.usage.totalTokens} tokens\n${report.principlesVersion}`}
            editHref={promptActionHref(locale, prompt.id, version.id, "edit")}
          />
          <div className="row">
            <Link className="btn" href={promptActionHref(locale, prompt.id, version.id, "edit")}>
              {t("Keep this version", "保留原文，返回编辑")}
            </Link>
            <Link
              className="btn btn-primary"
              href={
                promptActionHref(locale, prompt.id, version.id, "optimize") +
                (selectedIndexes.length
                  ? `&reportId=${encodeURIComponent(selected.executionId)}&suggestions=${selectedIndexes.join(",")}`
                  : "")
              }
            >
              {selectedIndexes.length
                ? t(
                    `Optimize ${selectedIndexes.length} selected suggestions`,
                    `按选中的 ${selectedIndexes.length} 条建议优化`,
                  )
                : t("Continue to optimization", "继续优化")}
            </Link>
          </div>
          <EvidenceDisclosure locale={locale}>
            <p className="small">
              {report.principlesVersion} · {version.id} · {selected.executionId}
            </p>
            <ModelResultEvidence locale={locale} result={selected} />
          </EvidenceDisclosure>
        </>
      )}
    </section>
  );
}
