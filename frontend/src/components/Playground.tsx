"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { ArrowRight, Play, Sparkles } from "lucide-react";
import {
  fetchPlaygroundRequest,
  fetchRemoteSnapshot,
  runLivePlayground,
  type LiveSourceResponse,
  type PlaygroundRunInput,
} from "@/lib/api-client";
import {
  catalogModel,
  initialModelSelection,
  liveSource,
  validModelSelection,
} from "@/lib/model-catalog";
import {
  executionEvidenceFor,
  isLiveExecutionEvidence,
  localizeFixtureOutput,
} from "@/lib/execution-evidence";
import { localizedTitleFor } from "@/lib/fixtures";
import { modelErrorDetail } from "@/lib/model-error-messages";
import { playgroundSystemInstruction } from "@/lib/playground-policy";
import { useAppStore } from "@/lib/store";
import type { AppState, Locale, PromptVersion } from "@/lib/types";
import { EvidenceDisclosure } from "./EvidenceDisclosure";
import {
  ModelControls,
  ModelResultEvidence,
  strengthLabel,
  useModelSelection,
} from "./ModelControls";
import { PromptContextBar } from "./PromptContextBar";
import { ResultActions } from "./ResultActions";

type Run = AppState["playgroundRuns"][number];
type Receipt = {
  pending?: PlaygroundRunInput;
  promptId?: string;
  versionId?: string;
  runId?: string;
};

function readReceipt(key: string): Receipt & { corrupt?: boolean } {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return {};
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object") return { corrupt: true };
    if (value.pending) {
      const p = value.pending;
      if (
        typeof p.promptId !== "string" ||
        typeof p.versionId !== "string" ||
        !/^[A-Za-z0-9_-]{8,100}$/.test(p.requestKey) ||
        !["en", "zh-CN"].includes(p.locale) ||
        !validModelSelection(p)
      )
        return { corrupt: true };
    }
    return value;
  } catch {
    return { corrupt: true };
  }
}

function asRun(result: LiveSourceResponse): Run {
  const source = liveSource(result.provider, "PLAYGROUND");
  return {
    id: result.sessionId ?? `pls_${result.executionId}`,
    versionId: result.versionId,
    createdAt: result.createdAt,
    executionId: result.executionId,
    source,
    modelEvidence: result,
    outputs: [
      { name: `${result.provider} · ${result.resolvedModel}`, text: result.content, source },
    ],
  };
}

export function Playground({
  locale,
  version: initialVersion,
  explicitTarget = false,
}: {
  locale: Locale;
  version: PromptVersion;
  explicitTarget?: boolean;
}) {
  const { state, dispatch, accountId } = useAppStore();
  const t = (en: string, zh: string) => (locale === "zh-CN" ? zh : en);
  const storageKey = `pm-playground:${accountId}`;
  const [receipt, setReceipt] = useState<Receipt & { corrupt?: boolean }>(() => {
    const saved = readReceipt(storageKey);
    return explicitTarget &&
      !saved.pending &&
      !saved.corrupt &&
      (saved.promptId !== initialVersion.promptId || saved.versionId !== initialVersion.id)
      ? { promptId: initialVersion.promptId, versionId: initialVersion.id }
      : saved;
  });
  const receiptRef = useRef(receipt);
  const lock = useRef(false);
  const alive = useRef(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [requestState, setRequestState] = useState<"UNKNOWN" | "NOT_FOUND" | "PENDING" | "FAILED">(
    "UNKNOWN",
  );
  const [acknowledged, setAcknowledged] = useState(false);
  const control = useModelSelection(
    receipt.pending ? initialModelSelection(receipt.pending) : undefined,
  );
  const formId = useId();
  const versions = state.versions
    .filter(
      (v) =>
        v.promptId === (receipt.pending?.promptId ?? receipt.promptId ?? initialVersion.promptId),
    )
    .toSorted((a, b) => b.number - a.number);
  const version =
    versions.find((v) => v.id === (receipt.pending?.versionId ?? receipt.versionId)) ??
    versions.find((v) => v.id === initialVersion.id) ??
    versions[0];
  const prompt = state.prompts.find((p) => p.id === version?.promptId);
  const runs = state.playgroundRuns.filter(
    (r) => version && isLiveExecutionEvidence(r, version.id),
  );
  const selected = runs.find((r) => r.id === receipt.runId) ?? runs[0];
  const simulation = state.playgroundRuns.find(
    (r) =>
      r.versionId === version?.id &&
      !["DEEPSEEK_LIVE_PLAYGROUND", "SILICONFLOW_LIVE_PLAYGROUND"].includes(r.source ?? ""),
  );
  const evidence = version ? executionEvidenceFor(state.playgroundRuns, version.id) : undefined;
  const unsaved =
    version &&
    state.draft.promptId === version.promptId &&
    state.draft.parentVersionId === version.id &&
    state.draft.content !== version.content;
  const pending = receipt.pending;
  const locked = busy || !!pending || !!receipt.corrupt;

  function save(next: Receipt, required = false) {
    try {
      const serialized = JSON.stringify(next);
      sessionStorage.setItem(storageKey, serialized);
      if (sessionStorage.getItem(storageKey) !== serialized) throw Error("STORAGE_UNAVAILABLE");
    } catch {
      if (required) throw Error("STORAGE_UNAVAILABLE");
    }
    receiptRef.current = next;
    setReceipt(next);
  }

  async function showResult(result: LiveSourceResponse, checking: boolean) {
    const original = receiptRef.current.pending;
    if (
      !original ||
      result.purpose !== "PLAYGROUND" ||
      result.promptId !== original.promptId ||
      result.versionId !== original.versionId
    ) {
      throw Error("RESULT_SOURCE_MISMATCH");
    }
    const run = asRun(result);
    // A completed response is durable business evidence even when snapshot refresh fails.
    await dispatch({
      type: "HYDRATE",
      saved: {
        playgroundRuns: [
          run,
          ...state.playgroundRuns.filter((r) => r.executionId !== result.executionId),
        ],
      },
    });
    if (!alive.current) return;
    const next = {
      ...receiptRef.current,
      promptId: result.promptId,
      versionId: result.versionId,
      runId: run.id,
    };
    save(next);
    setStatus(t("Saved to your account.", "结果已保存到账户。"));
    const snapshot = await fetchRemoteSnapshot();
    if (!alive.current) return;
    if (snapshot.kind !== "ready") {
      setStatus(
        t(
          "The result is saved; workspace refresh failed. Check the original request to restore it.",
          "结果已保存，工作区刷新失败。可核对原请求恢复结果。",
        ),
      );
      // Retain the original key until a read-only status check confirms recovery.
      if (checking) save({ ...next, pending: undefined }, true);
      return;
    }
    const savedRuns = snapshot.snapshot.playgroundRuns;
    await dispatch({
      type: "HYDRATE",
      saved: {
        playgroundRuns: savedRuns.some((r) => r.executionId === result.executionId)
          ? savedRuns
          : [run, ...savedRuns],
      },
    });
    if (alive.current) save({ ...next, pending: undefined }, true);
  }

  async function check() {
    const original = receiptRef.current.pending;
    if (!original || lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    setStatus(null);
    setRequestState("UNKNOWN");
    setAcknowledged(false);
    try {
      const response = await fetchPlaygroundRequest(original.requestKey);
      if (!alive.current) return;
      if (response.kind !== "ready") {
        setError(modelErrorDetail(response, locale));
        return;
      }
      const data = response.data;
      if (data.status === "SUCCEEDED") await showResult(data.result, true);
      else {
        setRequestState(data.status);
        setStatus(
          data.status === "NOT_FOUND"
            ? t(
                "No saved request was found. You may explicitly submit the same fixed request.",
                "未找到已保存请求，可明确继续提交原请求。",
              )
            : data.status === "PENDING"
              ? t(
                  "The original request is still pending. Checking does not call a model.",
                  "原请求仍在处理中。核对不会再次调用模型。",
                )
              : t(
                  "The original request failed. Check usage and pending costs before a new run.",
                  "原请求已失败。请先核对用量和待确认费用，再决定新建试跑。",
                ),
        );
        if (data.status === "FAILED") setError(data.errorCode ?? t("Execution failed", "执行失败"));
      }
    } catch {
      if (alive.current)
        setError(
          t(
            "Recovery could not finish. Keep the original request and check again; no new model call was sent.",
            "恢复未完成。请保留原请求并再次核对，本次未发送新模型请求。",
          ),
        );
    } finally {
      lock.current = false;
      if (alive.current) setBusy(false);
    }
  }

  // Mount/re-entry recovers by GET only. It must never re-submit a paid request.
  const checkRef = useRef(check);
  useEffect(() => {
    checkRef.current = check;
  });
  useEffect(() => {
    alive.current = true;
    if (receiptRef.current.pending) void checkRef.current();
    return () => {
      alive.current = false;
    };
  }, []);

  async function run(continueOriginal = false) {
    if (
      !version ||
      !accountId ||
      lock.current ||
      receipt.corrupt ||
      (!continueOriginal && (pending || !control.canRun))
    )
      return;
    if (continueOriginal && (!pending || requestState !== "NOT_FOUND")) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const input: PlaygroundRunInput = continueOriginal
        ? receiptRef.current.pending!
        : {
            ...control.selection,
            promptId: version.promptId,
            versionId: version.id,
            locale,
            requestKey: crypto.randomUUID(),
          };
      save(
        {
          ...receiptRef.current,
          promptId: input.promptId,
          versionId: input.versionId,
          pending: input,
        },
        true,
      );
      setRequestState("UNKNOWN");
      const result = await runLivePlayground(input);
      if (!alive.current) return;
      if (result.kind !== "ready") {
        setError(modelErrorDetail(result, locale));
        return;
      }
      await showResult(result.data, false);
    } catch (failure) {
      if (alive.current)
        setError(
          failure instanceof Error && failure.message === "STORAGE_UNAVAILABLE"
            ? t(
                "Request recovery could not be saved. No new request is sent without browser session storage. If a result is visible, it is already saved; check the original request.",
                "无法保存请求恢复信息。浏览器会话存储不可用时不会发送新请求；若已显示结果，结果已保存，请核对原请求。",
              )
            : t(
                "The result could not be reconciled. Keep the original request and check its saved status before another run.",
                "结果尚未核对完成。请保留原请求并核对保存状态，再开始新试跑。",
              ),
        );
    } finally {
      lock.current = false;
      if (alive.current) setBusy(false);
    }
  }

  if (!version || !prompt)
    return <p role="status">{t("Select a saved Prompt first.", "请先选择已保存的 Prompt。")}</p>;
  return (
    <div className="stack playground-workspace" aria-busy={busy}>
      <div className="page-heading">
        <div>
          <h1>{t("Model Playground", "模型试跑")}</h1>
        </div>
        <button
          className="btn btn-primary"
          onClick={() => void run()}
          disabled={locked || !control.canRun}
        >
          <Sparkles size={15} aria-hidden="true" />
          {busy
            ? t("Calling model…", "正在调用模型……")
            : control.model.provider === "deepseek"
              ? t("Run DeepSeek · Live", "运行 DeepSeek 真实执行")
              : t(`Run ${control.model.name} · Live`, `运行 ${control.model.name} 真实执行`)}
        </button>
      </div>
      <PromptContextBar
        locale={locale}
        prompt={prompt}
        version={version}
        active="playground"
        unsaved={!!unsaved}
      />
      <section className="panel panel-pad stack" aria-label={t("Run input", "试跑输入")}>
        <h2>{t("Choose saved input", "选择已保存的输入")}</h2>
        <div className="grid two">
          <div className="field">
            <label htmlFor={`${formId}-prompt`}>{t("Saved Prompt", "已保存的 Prompt")}</label>
            <select
              className="select"
              id={`${formId}-prompt`}
              value={version.promptId}
              disabled={locked}
              onChange={(e) => {
                const next = state.prompts.find((p) => p.id === e.target.value)!;
                save({ promptId: next.id, versionId: next.currentVersionId });
                setError(null);
                setStatus(null);
              }}
            >
              {state.prompts.map((p) => (
                <option key={p.id} value={p.id}>
                  {localizedTitleFor(p.id, locale, p.title)}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor={`${formId}-version`}>{t("Saved version", "已保存版本")}</label>
            <select
              className="select"
              id={`${formId}-version`}
              value={version.id}
              disabled={locked}
              onChange={(e) => {
                save({ promptId: version.promptId, versionId: e.target.value });
                setError(null);
                setStatus(null);
              }}
            >
              {versions.map((v) => (
                <option key={v.id} value={v.id}>
                  v{v.number}
                  {v.id === prompt.currentVersionId ? t(" · current", " · 当前") : ""}
                </option>
              ))}
            </select>
          </div>
        </div>
        <ModelControls control={control} locale={locale} disabled={locked} />

        {unsaved && (
          <p className="notice" role="status">
            {t(
              "You have unsaved edits. This run uses the saved snapshot below; save in the editor to test your changes.",
              "你有未保存修改。本次仅运行下方已保存快照；如需测试修改，请先到编辑器保存。",
            )}
          </p>
        )}
      </section>
      {error && (
        <p role="alert" className="notice">
          {error}
        </p>
      )}
      {status && (
        <p role="status" className="notice">
          {status}
        </p>
      )}
      {receipt.corrupt && (
        <p role="alert">
          {t(
            "Saved recovery information is unreadable. New model requests are blocked. Restore browser storage and check saved runs before continuing.",
            "请求恢复信息无法读取，已阻止新模型请求。请恢复浏览器存储并核对已保存记录。",
          )}
        </p>
      )}
      {pending && (
        <section
          className="panel panel-pad stack"
          aria-label={t("Original request recovery", "原请求恢复")}
        >
          <h2>{t("Reconcile the original run", "核对原试跑")}</h2>
          <p className="small">
            {t(
              "The fixed request remains saved. A refresh or network error does not confirm that the provider stopped or did not charge.",
              "固定请求已保留。刷新或网络异常不代表供应商已停止或未计费。",
            )}
          </p>
          <p className="small subtle">
            {catalogModel(pending.modelKey)?.name} · {strengthLabel(pending.strength, locale)} ·{" "}
            {pending.maxOutputTokens !== undefined
              ? `${pending.maxOutputTokens} tokens`
              : t("Original server output policy", "原请求服务端输出策略")}
          </p>
          <div className="result-action-row">
            <button className="btn" disabled={busy} onClick={() => void check()}>
              {t("Check original request", "核对原请求")}
            </button>
            {requestState === "NOT_FOUND" && (
              <button className="btn" disabled={busy} onClick={() => void run(true)}>
                {t("Continue original request · may charge", "继续原请求 · 可能收费")}
              </button>
            )}
            {requestState === "FAILED" && (
              <>
                <Link className="btn" href={`/${locale}/app/settings`}>
                  {t("Check usage and costs", "查看用量与费用")}
                </Link>
                <label className="row">
                  <input
                    type="checkbox"
                    checked={acknowledged}
                    onChange={(e) => setAcknowledged(e.target.checked)}
                  />
                  {t("I have checked usage and pending costs", "我已核对用量与待确认费用")}
                </label>
                <button
                  className="btn"
                  disabled={busy || !acknowledged}
                  onClick={() => {
                    try {
                      save({ ...receiptRef.current, pending: undefined }, true);
                      setStatus(null);
                      setError(null);
                      setAcknowledged(false);
                    } catch {
                      setError(
                        t(
                          "Could not save recovery confirmation. No new call was sent.",
                          "无法保存核对确认，本次未发送新请求。",
                        ),
                      );
                    }
                  }}
                >
                  {t("Allow a new run", "允许新建试跑")}
                </button>
              </>
            )}
          </div>
          <EvidenceDisclosure locale={locale}>
            <p>{pending.requestKey}</p>
            <p>{pending.versionId}</p>
          </EvidenceDisclosure>
        </section>
      )}
      <section className="panel panel-pad stack">
        <h2>{t("Prompt snapshot", "Prompt 快照")}</h2>
        <p className="small subtle">
          {localizedTitleFor(version.promptId, locale, version.title)} · v{version.number}
        </p>
        <p className="result-body">{version.content}</p>
        <EvidenceDisclosure locale={locale}>
          <p>{version.id}</p>
          <p className="small">
            {t("Platform system instruction", "平台试跑指令")}:{" "}
            {playgroundSystemInstruction(locale)}
          </p>
        </EvidenceDisclosure>
      </section>
      <section className="panel panel-pad stack" aria-label={t("Real run results", "真实试跑结果")}>
        <div className="between">
          <h2>{t("Run result", "试跑结果")}</h2>
          <span className={`badge ${evidence?.status === "EXECUTED_UNGRADED" ? "green" : "amber"}`}>
            {evidence?.status === "EXECUTED_UNGRADED"
              ? t("EXECUTED · UNGRADED", "已执行 · 未评分")
              : t("NOT_EXECUTED", "未执行")}
          </span>
        </div>
        {runs.length > 0 && (
          <div className="field">
            <label htmlFor={`${formId}-history`}>
              {t("Run history for this version", "此版本试跑历史")}
            </label>
            <select
              className="select"
              id={`${formId}-history`}
              value={selected?.id ?? ""}
              onChange={(e) =>
                save({
                  ...receiptRef.current,
                  promptId: version.promptId,
                  versionId: version.id,
                  runId: e.target.value,
                })
              }
            >
              {runs.map((r, i) => (
                <option key={r.id} value={r.id}>
                  {i === 0 ? t("Latest", "最新") : `#${runs.length - i}`} · {r.outputs[0]?.name} ·{" "}
                  {r.createdAt ??
                    r.modelEvidence?.createdAt ??
                    t("Time not recorded", "未记录时间")}
                </option>
              ))}
            </select>
          </div>
        )}
        {selected ? (
          <>
            <p className="small subtle">
              {t("Saved result", "已保存结果")} · v{version.number} · {selected.outputs[0]?.name}
            </p>
            {selected.modelEvidence && (
              <p className="small">
                {selected.modelEvidence.usage.totalTokens} tokens
                {selected.modelEvidence.latencyMs !== undefined
                  ? ` · ${selected.modelEvidence.latencyMs} ms`
                  : ""}
              </p>
            )}
            {selected.modelEvidence?.finishReason === "length" && (
              <p className="notice" role="status">
                {t(
                  "The output reached its token limit and may be incomplete. Review it before use; no automatic retry was sent.",
                  "输出已达到 token 上限，内容可能不完整。使用前请检查；未自动重试。",
                )}
              </p>
            )}
            {selected.outputs.map((o, i) => (
              <div key={`${selected.id}:${i}`} className="stack">
                <p className="result-body">{o.text}</p>
                <ResultActions locale={locale} title={o.name} content={o.text} />
              </div>
            ))}
            <EvidenceDisclosure locale={locale}>
              <p>{selected.executionId}</p>
              <p>{selected.source}</p>
              <p>{selected.versionId}</p>
              {selected.modelEvidence && (
                <>
                  <ModelResultEvidence result={selected.modelEvidence} locale={locale} />
                  <p>
                    {t("Finish reason", "完成原因")}:{" "}
                    {selected.modelEvidence.finishReason ?? t("Not recorded", "未记录")}
                  </p>
                </>
              )}
            </EvidenceDisclosure>
          </>
        ) : (
          <div className="empty-state">
            <h3>{t("No real run for this version", "此版本暂无真实试跑")}</h3>
            <p className="subtle">
              {t(
                "Choose your model and click Run to save an actual answer here.",
                "选择模型并点击运行，真实回答将保存在这里。",
              )}
            </p>
          </div>
        )}
        <EvidenceDisclosure locale={locale}>
          <p>{t("Execution scores are not enabled.", "执行评分尚未启用。")}</p>
          <p>score = null · grade = null</p>
        </EvidenceDisclosure>
      </section>
      <details className="workflow-option simulation-option">
        <summary>{t("Simulation · no model call", "模拟体验 · 不调用模型")}</summary>
        <p className="small subtle">
          {t(
            "Preset samples stay separate from real execution evidence.",
            "预置示例与真实执行依据分开展示。",
          )}
        </p>
        <button
          className="btn"
          disabled={busy}
          onClick={() => void dispatch({ type: "PLAYGROUND", versionId: version.id })}
        >
          <Play size={15} aria-hidden="true" />
          {t("Run simulated comparison", "运行模拟对比")}
        </button>
        {simulation?.outputs.map((o, i) => (
          <section className="panel panel-pad stack" key={i}>
            <h3>{o.name.replace("Demo Model", t("Demo Model", "演示模型"))}</h3>
            <span className="badge">{t("MOCK / SIMULATED", "模拟演示")}</span>
            <p className="result-body">{localizeFixtureOutput(o.name, o.text, locale)}</p>
            <ResultActions
              locale={locale}
              title={o.name}
              content={localizeFixtureOutput(o.name, o.text, locale)}
            />
          </section>
        ))}
      </details>
      <Link
        className="btn"
        href={`/${locale}/app/execution-evaluation?promptId=${encodeURIComponent(version.promptId)}&versionId=${encodeURIComponent(version.id)}`}
      >
        {t("Open execution report", "查看执行报告")}
        <ArrowRight size={14} aria-hidden="true" />
      </Link>
    </div>
  );
}
