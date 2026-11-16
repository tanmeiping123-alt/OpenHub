"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { Locale } from "@/lib/types";
import { MODEL_CATALOG, type ModelSelection, type ModelStrength } from "@/lib/model-catalog";
import {
  PELICAN_PROMPT,
  type PelicanAdminBatch,
  type PelicanAdminData,
  type PelicanCreateInput,
  type PelicanSample,
} from "@/lib/pelican-types";
import { strengthLabel } from "../ModelControls";
import { ModelRail, PelicanPagination, PelicanState, SampleCard, StatusBadge } from "./PelicanPage";
import { PelicanPreview } from "./PelicanPreview";
import { batchState, dateLabel, PelicanError, post, request, text } from "./client";
import { PelicanEvidence } from "./PelicanEvidence";

function readReceipt<T>(key: string): T | null {
  try {
    const value = sessionStorage.getItem(key);
    return value ? (JSON.parse(value) as T) : null;
  } catch {
    return null;
  }
}
type PendingAction = {
  batchId: string;
  action: "run" | "rerun";
  requestKey?: string;
  sampleId?: string;
};
function definitivelyRejected(error: unknown) {
  return (
    error instanceof PelicanError &&
    ([400, 401, 403, 404, 422, 429].includes(error.status) ||
      [
        "MODEL_DISABLED",
        "MODEL_NOT_CONFIGURED",
        "MODEL_CONFIG_INVALID",
        "PRICING_UNAVAILABLE",
        "PELICAN_INVALID_SELECTION",
        "PELICAN_INVALID_INPUT",
        "PELICAN_REQUEST_DELETED",
      ].includes(error.code ?? ""))
  );
}
export function PelicanAdmin({ locale, accountScope }: { locale: Locale; accountScope: string }) {
  const createKey = `pelican:create:${accountScope}`,
    actionKey = `pelican:action:${accountScope}`;
  const [receipt, setReceipt] = useState(() => readReceipt<PelicanCreateInput>(createKey));
  const [creationAbsent, setCreationAbsent] = useState(false);
  const [rerunAbsent, setRerunAbsent] = useState(false);
  const [retryQuote, setRetryQuote] = useState<PelicanAdminBatch | null>(null);
  const [retryConsent, setRetryConsent] = useState<string | null>(null);
  const [pending, setPending] = useState(() => readReceipt<PendingAction>(actionKey));
  const [data, setData] = useState<PelicanAdminData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [message, setMessage] = useState("");
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [modelKey, setModelKey] = useState("");
  const [status, setStatus] = useState("all");
  const [focusedBatchId, setFocusedBatchId] = useState<string | null>(null);
  const [focusedBatch, setFocusedBatch] = useState<PelicanAdminBatch | null>(null);
  const [detailError, setDetailError] = useState(false);
  const [focusedSampleId, setFocusedSampleId] = useState<string | null>(null);
  const [pollError, setPollError] = useState(false);
  const params = new URLSearchParams({ page: String(page), query, modelKey, status });
  const listUrl = `/api/pelican/admin?${params}`;
  const [title, setTitle] = useState(receipt?.title ?? "");
  const [selections, setSelections] = useState<ModelSelection[]>(receipt?.selections ?? []);
  const [selected, setSelected] = useState<PelicanSample | null>(null);
  const lock = useRef(false);
  const mutationVersion = useRef(0);
  useEffect(() => {
    let active = true;
    void request<PelicanAdminData>(listUrl)
      .then((value) => {
        if (active) {
          setData(value);
          setLoading(false);
          setError(false);
        }
      })
      .catch(() => {
        if (active) {
          setData(null);
          setLoading(false);
          setError(true);
        }
      });
    return () => {
      active = false;
    };
  }, [listUrl]);
  useEffect(() => {
    if (!focusedBatchId) return;
    let active = true;
    const controller = new AbortController();
    void request<{ batch: PelicanAdminBatch }>(
      `/api/pelican/admin/${encodeURIComponent(focusedBatchId)}`,
      { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]) },
    )
      .then((result) => {
        if (active) setFocusedBatch(result.batch);
      })
      .catch(() => {
        if (active) setDetailError(true);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [focusedBatchId]);
  async function refresh() {
    if (lock.current) return;
    setError(false);
    try {
      const value = await request<PelicanAdminData>(listUrl);
      setData(value);
      if (focusedBatchId) {
        const detail = await request<{ batch: PelicanAdminBatch }>(
          `/api/pelican/admin/${encodeURIComponent(focusedBatchId)}`,
        );
        setFocusedBatch(detail.batch);
        setDetailError(false);
      }
      if (pending) {
        const { batch } = await request<{ batch: PelicanAdminBatch }>(
          `/api/pelican/admin/${encodeURIComponent(pending.batchId)}`,
        );
        const exactRerun =
          pending.action === "rerun" && pending.requestKey
            ? await request<PelicanAdminData>(
                `/api/pelican/admin?rerunRequestKey=${encodeURIComponent(pending.requestKey)}&page=1`,
              )
            : null;
        const resolved =
          pending.action === "run"
            ? batch && !batch.canRun
            : exactRerun?.batches.some((b) => b.id === pending.batchId);
        setRerunAbsent(
          pending.action === "rerun" && exactRerun !== null && exactRerun.batches.length === 0,
        );
        if (
          pending.action === "run" &&
          batch?.canRun &&
          batch.samples.length > 0 &&
          batch.samples.every((s) => s.callStatus === "QUEUED")
        ) {
          setRetryQuote(batch);
          setRetryConsent(null);
        } else setRetryQuote(null);
        if (resolved) {
          sessionStorage.removeItem(actionKey);
          setPending(null);
          setMessage(
            text(
              locale,
              "Recorded state loaded. No new model call was made.",
              "已读取已记录状态，未发起新的模型调用。",
            ),
          );
        }
      }
    } catch {
      setError(true);
    }
  }
  async function retryPendingRerun() {
    if (
      lock.current ||
      !rerunAbsent ||
      pending?.action !== "rerun" ||
      !pending.requestKey ||
      !pending.sampleId
    )
      return;
    const original = pending;
    lock.current = true;
    mutationVersion.current++;
    setBusy(true);
    setRerunAbsent(false);
    try {
      const result = await post<{ batch: PelicanAdminBatch }>(
        `/api/pelican/admin/${encodeURIComponent(original.batchId)}`,
        {
          action: "rerun",
          sampleId: original.sampleId,
          confirmed: true,
          requestKey: original.requestKey,
        },
      );
      setFocusedBatch((current) => (current?.id === result.batch.id ? result.batch : current));
      setData((d) =>
        d
          ? {
              ...d,
              batches: d.batches.some((b) => b.id === original.batchId)
                ? d.batches.map((b) => (b.id === original.batchId ? result.batch : b))
                : [result.batch, ...d.batches],
            }
          : null,
      );
      sessionStorage.removeItem(actionKey);
      setPending(null);
      setMessage(
        text(
          locale,
          "Rerun sample prepared. Review its new budget and confirm execution separately.",
          "重跑样本已准备，请另行核对新预算并确认执行。",
        ),
      );
    } catch (e) {
      if (definitivelyRejected(e)) {
        sessionStorage.removeItem(actionKey);
        setPending(null);
        setMessage(
          text(
            locale,
            "The rerun preparation was rejected. Refresh the recorded batch state.",
            "重跑准备请求未获接受，请刷新已记录批次状态。",
          ),
        );
      } else
        setMessage(
          text(
            locale,
            "Rerun preparation is unconfirmed. Reconcile the same request before recovery; no model run was authorized.",
            "重跑准备结果待核对，请刷新核对同一请求；尚未授权模型派发。",
          ),
        );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function reconcileCreate() {
    if (!receipt || lock.current) return;
    lock.current = true;
    mutationVersion.current++;
    setBusy(true);
    try {
      const found = await request<PelicanAdminData>(
        `/api/pelican/admin?requestKey=${encodeURIComponent(receipt.requestKey)}&page=1`,
      );
      if (found.batches.length) {
        sessionStorage.removeItem(createKey);
        setReceipt(null);
        setData(found);
        setMessage(
          text(
            locale,
            "Batch recovered. Review its budget before running.",
            "已找回批次，请核对预算后再发起测试。",
          ),
        );
      } else {
        setCreationAbsent(true);
        setMessage(
          text(
            locale,
            "No batch was found for the original request. You may explicitly submit its saved content again without running a model.",
            "未找到原请求对应的批次。可以手动重新提交已保存的同一创建请求，不会调用模型。",
          ),
        );
      }
    } catch {
      setMessage(
        text(
          locale,
          "Could not reconcile creation. The saved request identity is retained.",
          "暂时无法核对创建结果，已保留请求身份。",
        ),
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function create(retry = false) {
    if (
      lock.current ||
      (!retry && receipt) ||
      (retry && (!receipt || !creationAbsent)) ||
      !title.trim() ||
      !selections.length
    )
      return;
    lock.current = true;
    mutationVersion.current++;
    setBusy(true);
    setMessage("");
    const input: PelicanCreateInput =
      retry && receipt
        ? receipt
        : {
            requestKey: crypto.randomUUID(),
            title: title.trim(),
            selections,
          };
    setCreationAbsent(false);
    try {
      sessionStorage.setItem(createKey, JSON.stringify(input));
      setReceipt(input);
    } catch {
      setMessage(
        text(
          locale,
          "Enable session storage before creating a batch.",
          "请允许浏览器会话存储后再创建批次。",
        ),
      );
      lock.current = false;
      setBusy(false);
      return;
    }
    try {
      const result = await post<{ batch: PelicanAdminBatch }>("/api/pelican/admin", input);
      sessionStorage.removeItem(createKey);
      setReceipt(null);
      setData((d) => (d ? { ...d, batches: [result.batch, ...d.batches] } : null));
      setTitle("");
      setFocusedBatchId(result.batch.id);
      setFocusedSampleId(null);
      setMessage(
        text(
          locale,
          "Batch created. Confirm the estimate before starting a paid test.",
          "批次已创建，请确认预计预算后再发起真实测试。",
        ),
      );
    } catch (e) {
      if (definitivelyRejected(e)) {
        sessionStorage.removeItem(createKey);
        setReceipt(null);
        setMessage(
          text(
            locale,
            "Creation was rejected. Check the selected models, limits and configuration before creating a batch again.",
            "创建请求未获接受，请检查所选模型、输出上限与配置后重新创建。",
          ),
        );
      } else
        setMessage(
          text(
            locale,
            "Creation result unknown. Reconcile this request before creating another batch.",
            "创建结果待核对，请先核对此请求，再创建其他批次。",
          ),
        );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function action(batch: PelicanAdminBatch, body: Record<string, unknown>, retry = false) {
    if (
      lock.current ||
      (pending && !retry && body.action !== "stop") ||
      (retry &&
        (pending?.action !== "run" ||
          pending.batchId !== batch.id ||
          retryQuote?.budgetFingerprint !== batch.budgetFingerprint ||
          retryConsent !== batch.budgetFingerprint))
    )
      return;
    lock.current = true;
    mutationVersion.current++;
    setBusy(true);
    setMessage("");
    setRetryQuote(null);
    setRetryConsent(null);
    const charged = body.action === "run" || body.action === "rerun";
    const intent: PendingAction = {
      batchId: batch.id,
      action: body.action as "run" | "rerun",
      ...(body.action === "rerun"
        ? { requestKey: crypto.randomUUID(), sampleId: String(body.sampleId) }
        : {}),
    };
    if (charged) {
      try {
        sessionStorage.setItem(actionKey, JSON.stringify(intent));
        setPending(intent);
      } catch {
        setMessage(
          text(
            locale,
            "Enable session storage before starting a paid action.",
            "请允许浏览器会话存储后再发起收费操作。",
          ),
        );
        lock.current = false;
        setBusy(false);
        return;
      }
    }
    try {
      const result = await post<{ batch: PelicanAdminBatch }>(
        `/api/pelican/admin/${encodeURIComponent(batch.id)}`,
        { ...body, ...(intent.requestKey ? { requestKey: intent.requestKey } : {}) },
      );
      if (body.action === "delete-batch") {
        setData((d) => (d ? { ...d, batches: d.batches.filter((b) => b.id !== batch.id) } : null));
        setFocusedBatchId(null);
        setFocusedBatch(null);
        setMessage(
          text(
            locale,
            "Test record removed from the management list. Execution, billing and audit evidence are retained.",
            "测试记录已从管理列表移除；执行、费用与审计证据仍保留。",
          ),
        );
      } else {
        setFocusedBatch((current) => (current?.id === result.batch.id ? result.batch : current));
        if (query || modelKey || status !== "all") {
          void request<PelicanAdminData>(listUrl)
            .then(setData)
            .catch(() => setPollError(true));
        } else {
          setData((d) =>
            d
              ? { ...d, batches: d.batches.map((b) => (b.id === batch.id ? result.batch : b)) }
              : null,
          );
        }
        if (charged) {
          sessionStorage.removeItem(actionKey);
          setPending(null);
        }
        setMessage(
          text(
            locale,
            body.action === "run"
              ? "Test started. Status updates automatically."
              : "Action recorded. Review every sample and its status.",
            body.action === "run"
              ? "测试已开始，状态会自动更新。"
              : "操作已记录，请查看全部样本及真实状态。",
          ),
        );
      }
    } catch (e) {
      if (body.action === "delete-batch" && e instanceof PelicanError) {
        setMessage(
          text(
            locale,
            "This record cannot be deleted yet. Stop any active run, refresh the batch, then try again; audit and billing evidence remain intact.",
            "该记录暂时无法删除。请先停止仍在进行的执行并刷新批次后重试；审计与费用证据仍保留。",
          ),
        );
      } else if (body.action === "rerun" && definitivelyRejected(e)) {
        sessionStorage.removeItem(actionKey);
        setPending(null);
        setMessage(
          text(
            locale,
            "The rerun request was rejected. Refresh the batch state and check its eligibility.",
            "重跑请求未获接受，请刷新批次状态并核对可执行条件。",
          ),
        );
      } else if (body.action === "rerun") {
        setMessage(
          text(
            locale,
            "Rerun preparation is unconfirmed. Reconcile the same request before recovery; no model run was authorized.",
            "重跑准备结果待核对，请刷新核对同一请求；尚未授权模型派发。",
          ),
        );
      } else
        setMessage(
          charged
            ? text(
                locale,
                "The result is unconfirmed. Fees may apply. Refresh status to reconcile; no automatic retry will occur.",
                "操作结果待核对，可能已产生费用。请刷新状态核对，不会自动重试。",
              )
            : text(
                locale,
                "The action could not be confirmed. Refresh the recorded state before continuing.",
                "暂时无法确认操作结果，请刷新已记录状态后继续。",
              ),
        );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  const isRunning =
    (focusedBatch?.id === focusedBatchId &&
      focusedBatch.samples.some((s) => s.callStatus === "PENDING")) ||
    !!data?.batches.some((b) => b.samples.some((s) => s.callStatus === "PENDING"));
  useEffect(() => {
    if (!isRunning) return;
    let active = true,
      failures = 0;
    let timer: ReturnType<typeof setTimeout>;
    let controller: AbortController | undefined;
    const poll = async () => {
      if (lock.current) {
        timer = setTimeout(poll, 2000);
        return;
      }
      const version = mutationVersion.current;
      controller = new AbortController();
      try {
        const value = await request<PelicanAdminData>(listUrl, {
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]),
        });
        if (!active) return;
        if (version !== mutationVersion.current) {
          timer = setTimeout(poll, 2000);
          return;
        }
        setData(value);
        if (focusedBatchId) {
          const detail = await request<{ batch: PelicanAdminBatch }>(
            `/api/pelican/admin/${encodeURIComponent(focusedBatchId)}`,
            { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]) },
          );
          if (!active) return;
          if (version !== mutationVersion.current) {
            timer = setTimeout(poll, 2000);
            return;
          }
          setFocusedBatch(detail.batch);
        }
        setPollError(false);
        failures = 0;
      } catch {
        if (!active) return;
        setPollError(true);
        failures++;
      }
      if (active) timer = setTimeout(poll, Math.min(2000 * 2 ** failures, 16000));
    };
    timer = setTimeout(poll, 2000);
    return () => {
      active = false;
      clearTimeout(timer);
      controller?.abort();
    };
  }, [isRunning, listUrl, focusedBatchId]);
  const modelGroups = new Map<string, { name: string; samples: PelicanSample[] }>();
  data?.batches.forEach((batch) =>
    batch.samples.forEach((sample) => {
      const group = modelGroups.get(sample.modelKey) ?? { name: sample.modelName, samples: [] };
      group.samples.push(sample);
      modelGroups.set(sample.modelKey, group);
    }),
  );
  const t = (en: string, zh: string) => text(locale, en, zh);
  return (
    <>
      <Link className="pelican-back" href={`/${locale}/pelican`}>
        {t("Return to published works", "返回公开作品")}
      </Link>
      <section className="pelican-intro">
        <div>
          <h1>{t("Manage pelican tests", "管理鹈鹕测试")}</h1>
          <p>
            {t(
              "Create a batch, review its budget, then explicitly run and publish.",
              "创建批次，核对预算，手动发起测试，查看后发布。",
            )}
          </p>
        </div>
        <button className="pelican-button" disabled={busy} onClick={() => void refresh()}>
          {t("Refresh status", "刷新状态")}
        </button>
      </section>
      <p className="pelican-management-note">
        {t(
          "Refreshing, previewing and publishing never call a model. Unknown results require reconciliation; an estimate is not a settled charge.",
          "刷新、预览与发布均不调用模型。未知结果需要核对；预计费用不等于已核对实扣。",
        )}
      </p>
      {message && !focusedBatchId && (
        <p className="pelican-feedback" role="status">
          {message}
        </p>
      )}
      {receipt && (
        <div className="pelican-recovery" role="status">
          <p>
            {t(
              "Creation result unknown. The original request identity is saved in this tab.",
              "创建结果待核对，原始请求身份已保存在此标签页。",
            )}
          </p>
          <button className="pelican-button" disabled={busy} onClick={() => void reconcileCreate()}>
            {t("Reconcile creation", "核对创建结果")}
          </button>
          {creationAbsent && (
            <button className="pelican-button" disabled={busy} onClick={() => void create(true)}>
              {t("Resubmit the same creation request", "重新提交同一创建请求")}
            </button>
          )}
        </div>
      )}
      {pending && (
        <div className="pelican-recovery" role="status">
          <p>
            {pending.action === "rerun"
              ? t(
                  "Rerun preparation is awaiting confirmation; model dispatch has not been authorized. Refresh to reconcile the original request.",
                  "重跑准备待确认，尚未授权派发。请刷新核对原请求。",
                )
              : t(
                  "A paid action is awaiting confirmation. Refresh reads recorded state before any explicit recovery.",
                  "上次收费操作待确认，请先刷新读取已记录状态，再决定是否手动恢复。",
                )}
          </p>
          {pending.action === "rerun" && rerunAbsent && (
            <button
              className="pelican-button"
              disabled={busy}
              onClick={() => void retryPendingRerun()}
            >
              {t("Resubmit the same rerun preparation request", "重新提交同一重跑准备请求")}
            </button>
          )}
          {retryQuote && (
            <>
              <p>
                {t(
                  "The server confirms that every sample is still queued. Review the current estimate before explicitly authorizing this same batch again.",
                  "服务端已确认全部样本仍待执行。请核对当前预计费用，再手动授权同一批次执行。",
                )}
              </p>
              <p>
                USD {retryQuote.estimatedCostUsd.toFixed(4)} /{" "}
                {retryQuote.estimatedTokens.toLocaleString()} tokens
              </p>
              <label className="pelican-check">
                <input
                  type="checkbox"
                  disabled={busy}
                  checked={retryConsent === retryQuote.budgetFingerprint}
                  onChange={(e) =>
                    setRetryConsent(e.target.checked ? retryQuote.budgetFingerprint : null)
                  }
                />
                {t(
                  "Confirm the current budget and reauthorize the same batch",
                  "确认当前预算，并重新授权同一批次执行",
                )}
              </label>
              <button
                className="pelican-button"
                disabled={busy || retryConsent !== retryQuote.budgetFingerprint}
                onClick={() =>
                  void action(
                    retryQuote,
                    {
                      action: "run",
                      confirmed: true,
                      budgetFingerprint: retryQuote.budgetFingerprint,
                    },
                    true,
                  )
                }
              >
                {t("Reconfirm execution after reconciliation", "核对后重新确认执行")}
              </button>
            </>
          )}
        </div>
      )}
      {loading ? (
        <PelicanState locale={locale} />
      ) : error ? (
        <PelicanState locale={locale} error retry={() => void refresh()} />
      ) : (
        data && (
          <>
            <details className="pelican-create-panel">
              <summary>{t("New test", "新建测试")}</summary>
              <form
                className="pelican-create"
                onSubmit={(e) => {
                  e.preventDefault();
                  void create();
                }}
              >
                <h2>{t("New test batch", "新建测试批次")}</h2>
                <p className="pelican-fixed-copy">{PELICAN_PROMPT}</p>
                <fieldset disabled={busy || !!receipt || !!pending}>
                  <label>
                    {t("Batch title", "批次名称")}
                    <input
                      value={title}
                      required
                      maxLength={100}
                      onChange={(e) => setTitle(e.target.value)}
                    />
                  </label>
                  <div className="pelican-model-options">
                    {MODEL_CATALOG.map((model) => {
                      const option = data.models.find((o) => o.key === model.key);
                      const available = !!option?.configured && !!option.maxOutputTokens;
                      const selection = selections.find((s) => s.modelKey === model.key);
                      return (
                        <div key={model.key} className="pelican-model-option">
                          <label className="pelican-check">
                            <input
                              type="checkbox"
                              disabled={!available}
                              checked={!!selection}
                              onChange={(e) =>
                                setSelections((old) =>
                                  e.target.checked
                                    ? [
                                        ...old,
                                        {
                                          modelKey: model.key,
                                          strength: model.defaultStrength,
                                        },
                                      ]
                                    : old.filter((s) => s.modelKey !== model.key),
                                )
                              }
                            />
                            <span>
                              {model.name}
                              <small>
                                {available
                                  ? t("Maximum model output available", "使用模型最高输出上限")
                                  : t(
                                      "Not configured or pricing unavailable",
                                      "未配置或价格依据不可用",
                                    )}
                              </small>
                            </span>
                          </label>
                          {selection && (
                            <div className="pelican-model-settings">
                              <label>
                                {t("Reasoning", "思考档位")}
                                <select
                                  aria-label={`${model.name} ${t("reasoning", "思考档位")}`}
                                  value={selection.strength}
                                  disabled={(model.strengths as readonly string[]).length === 1}
                                  onChange={(e) =>
                                    setSelections((old) =>
                                      old.map((s) =>
                                        s.modelKey === model.key
                                          ? { ...s, strength: e.target.value as ModelStrength }
                                          : s,
                                      ),
                                    )
                                  }
                                >
                                  {model.strengths.map((strength) => (
                                    <option key={strength} value={strength}>
                                      {strengthLabel(strength, locale)}
                                    </option>
                                  ))}
                                </select>
                              </label>
                              <p className="small subtle">
                                {option!.maxOutputTokens} tokens ·{" "}
                                {t("model maximum", "模型最高上限")}
                              </p>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  <p className="pelican-note">
                    {t(
                      "One initial sample per selected model. Maximum output is priced before confirmation; output limits and reasoning tiers are retained in each snapshot.",
                      "每个所选模型初次运行一个样本。确认前按最高输出上限估算费用；样本快照保留实际输出预算和思考档位。",
                    )}
                  </p>
                  <button
                    className="pelican-button pelican-primary"
                    disabled={!title.trim() || !selections.length}
                    type="submit"
                  >
                    {t("Create batch and review budget", "创建批次并查看预算")}
                  </button>
                </fieldset>
              </form>
            </details>
            <section className="pelican-toolbar" aria-label={t("Test filters", "测试筛选")}>
              <label className="pelican-inline-label">
                {t("Search tests", "搜索测试")}
                <input
                  value={query}
                  maxLength={120}
                  placeholder={t("Title or model", "批次或模型")}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setPage(1);
                  }}
                />
              </label>
              <label className="pelican-inline-label">
                {t("Model", "选择模型")}
                <select
                  value={modelKey}
                  onChange={(e) => {
                    setModelKey(e.target.value);
                    setPage(1);
                  }}
                >
                  <option value="">{t("All models", "全部模型")}</option>
                  {data.models.map((m) => (
                    <option key={m.key} value={m.key}>
                      {MODEL_CATALOG.find((model) => model.key === m.key)?.name ?? m.key}
                    </option>
                  ))}
                </select>
              </label>
              <label className="pelican-inline-label">
                {t("Execution status", "执行状态")}
                <select
                  value={status}
                  onChange={(e) => {
                    setStatus(e.target.value);
                    setPage(1);
                  }}
                >
                  {[
                    ["all", "All statuses", "全部状态"],
                    ["queued", "Queued", "待执行"],
                    ["running", "Running", "执行中"],
                    ["succeeded", "Succeeded", "已成功"],
                    ["failed", "Failed", "已失败"],
                    ["unknown", "Unknown", "待核对"],
                  ].map(([value, en, zh]) => (
                    <option key={value} value={value}>
                      {t(en, zh)}
                    </option>
                  ))}
                </select>
              </label>
              <span className="pelican-sync-note">
                {pollError
                  ? t("Connection interrupted. Retrying…", "连接中断，正在重试…")
                  : isRunning
                    ? t("Updating automatically", "状态自动更新中")
                    : t("Recorded results", "已记录结果")}
              </span>
            </section>
            <div className="pelican-admin-rails">
              {Array.from(modelGroups.entries()).map(([key, group]) => (
                <ModelRail
                  key={key}
                  name={group.name}
                  samples={group.samples}
                  locale={locale}
                  showExecution
                  onOpen={(s) => {
                    setDetailError(false);
                    setFocusedBatch(null);
                    setFocusedBatchId(s.batchId);
                    setFocusedSampleId(s.id);
                  }}
                />
              ))}
            </div>
            <nav className="pelican-batch-picker" aria-label={t("Batch actions", "批次操作")}>
              {data.batches.map((batch) => (
                <button
                  key={batch.id}
                  className="pelican-button"
                  aria-pressed={focusedBatchId === batch.id}
                  onClick={() => {
                    setDetailError(false);
                    setFocusedBatch(null);
                    setFocusedBatchId(batch.id);
                    setFocusedSampleId(null);
                  }}
                >
                  <span>
                    {t("Manage batch", "管理批次")}：{batch.title}
                  </span>
                  <StatusBadge state={batchState(batch.status, locale)} />
                </button>
              ))}
            </nav>
            {focusedBatchId && (
              <BatchDrawer locale={locale} onClose={() => setFocusedBatchId(null)}>
                {message && (
                  <p className="pelican-feedback" role="status">
                    {message}
                  </p>
                )}
                {pollError && (
                  <p className="pelican-feedback" role="status">
                    {t(
                      "Connection interrupted. Retrying recorded status…",
                      "连接中断，正在重试读取状态…",
                    )}
                  </p>
                )}
                {detailError ? (
                  <PelicanState locale={locale} error retry={() => void refresh()} />
                ) : !focusedBatch || focusedBatch.id !== focusedBatchId ? (
                  <PelicanState locale={locale} />
                ) : (
                  <AdminBatch
                    key={focusedBatch.id}
                    batch={focusedBatch}
                    focusedSampleId={focusedSampleId}
                    onClose={() => setFocusedBatchId(null)}
                    locale={locale}
                    busy={busy || !!pending || !!receipt}
                    stopBusy={busy}
                    onRefresh={() => void refresh()}
                    onAction={(body) => void action(focusedBatch, body)}
                    onOpen={setSelected}
                  />
                )}
              </BatchDrawer>
            )}
            {!data.batches.length && (
              <p className="pelican-state">
                {t(
                  "No test batches yet. Select configured models above to prepare a budget.",
                  "还没有测试批次。请在上方选择已配置模型，创建后查看预算。",
                )}
              </p>
            )}
            <PelicanPagination
              page={page}
              hasMore={data.hasMore}
              onPage={setPage}
              locale={locale}
            />
          </>
        )
      )}
      {selected && (
        <PelicanPreview
          sample={selected}
          locale={locale}
          onClose={() => setSelected(null)}
          onUnavailable={() => {
            setSelected(null);
            void refresh();
          }}
        />
      )}
    </>
  );
}
function runBlockCopy(batch: PelicanAdminBatch, locale: Locale) {
  const code = batch.blockedReason ?? batch.runBlock?.code ?? "PELICAN_RUN_NOT_AVAILABLE";
  const block = batch.runBlock;
  const number = (value?: number) => (value === undefined ? null : value.toLocaleString("en-US"));
  const usd = (value?: number) => (value === undefined ? null : `USD ${value.toFixed(4)}`);
  const title = text(locale, "This batch cannot start yet", "当前无法开始执行");
  if (code === "MODEL_QUOTA_EXCEEDED") {
    const required = [
      number(block?.requiredTokens) ? `${number(block?.requiredTokens)} tokens` : null,
      usd(block?.requiredCostUsd),
    ].filter(Boolean);
    const available = [
      number(block?.remainingTokens) ? `${number(block?.remainingTokens)} tokens` : null,
      usd(block?.remainingCostUsd),
    ].filter(Boolean);
    const detail =
      required.length || available.length
        ? text(
            locale,
            `This batch needs ${required.join(" / ") || "an unavailable amount"}; available now: ${available.join(" / ") || "not reported"}.`,
            `本批预计需要 ${required.join(" / ") || "金额未记录"}；当前可用 ${available.join(" / ") || "额度未返回"}。`,
          )
        : undefined;
    return {
      title,
      body: text(
        locale,
        "The available model budget cannot cover this batch at maximum output. Remove a model or wait for the quota to reset.",
        "当前可用模型额度不足以覆盖本批最高输出预算。可减少模型，或等待额度重置。",
      ),
      detail,
      reset: block?.resetAt
        ? text(
            locale,
            `Quota reset: ${dateLabel(block.resetAt, locale)}. Historical records and unresolved charges are retained.`,
            `额度下一次重置：${dateLabel(block.resetAt, locale)}。历史记录与待核对费用会保留。`,
          )
        : undefined,
    };
  }
  if (code === "BATCH_RESULT_PENDING")
    return {
      title,
      body: text(
        locale,
        "Another call in this batch is still running or awaiting reconciliation. Wait for it to finish, or explicitly end an interrupted execution first.",
        "批次内仍有调用在执行或结果待核对。请等待完成，或先明确结束中断执行。",
      ),
    };
  if (code === "BATCH_NOT_RUNNABLE")
    return {
      title,
      body:
        batch.status === "COMPLETE"
          ? text(
              locale,
              "This batch has finished. Prepare a separate rerun from a recorded result, or delete the record and create a new batch.",
              "本批次执行已结束。请在已记录结果上准备独立重跑，或删除本记录后新建批次。",
            )
          : text(
              locale,
              "The recorded batch or sample state does not allow another execution yet.",
              "当前批次或样本状态尚不允许再次执行。",
            ),
    };
  if (code === "BATCH_OWNER_REQUIRED")
    return {
      title,
      body: text(
        locale,
        "Only the administrator who created this batch can run it.",
        "只有创建该批次的管理员可以执行。",
      ),
    };
  if (code === "MODEL_CONFIGURATION_CHANGED")
    return {
      title,
      body: text(
        locale,
        "The frozen model configuration or pricing basis changed. Create a new batch to use the current configuration.",
        "冻结的模型配置或价格依据已变化。请新建批次以使用当前配置。",
      ),
    };
  if (code === "MODEL_PRICING_UNAVAILABLE")
    return {
      title,
      body: text(
        locale,
        "No valid pricing snapshot is available for this model, so a paid run cannot be authorized.",
        "该模型没有有效价格快照，暂不能授权真实收费执行。",
      ),
    };
  return {
    title,
    body: text(
      locale,
      "Execution is blocked by the recorded budget, configuration or execution state. Refresh the batch before continuing.",
      "当前受预算、配置或执行状态限制，暂时无法执行。请刷新批次后继续。",
    ),
    detail: text(locale, `Reason code: ${code}`, `原因代码：${code}`),
  };
}
function BatchDrawer({
  locale,
  onClose,
  children,
}: {
  locale: Locale;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const node = dialog.current;
    node?.showModal();
    return () => {
      node?.close();
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className="pelican-batch-dialog"
      aria-label={text(locale, "Selected batch details", "当前批次详情")}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onClose();
        }
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          const rect = e.currentTarget.getBoundingClientRect();
          if (
            e.clientX < rect.left ||
            e.clientX > rect.right ||
            e.clientY < rect.top ||
            e.clientY > rect.bottom
          )
            onClose();
        }
      }}
    >
      {children}
    </dialog>
  );
}
function AdminBatch({
  batch,
  focusedSampleId,
  onClose,
  locale,
  busy,
  stopBusy,
  onRefresh,
  onAction,
  onOpen,
}: {
  batch: PelicanAdminBatch;
  focusedSampleId: string | null;
  onClose: () => void;
  locale: Locale;
  busy: boolean;
  stopBusy: boolean;
  onRefresh: () => void;
  onAction: (body: Record<string, unknown>) => void;
  onOpen: (sample: PelicanSample) => void;
}) {
  const t = (en: string, zh: string) => text(locale, en, zh);
  const [confirmedFingerprint, setConfirmedFingerprint] = useState<string | null>(null);
  const confirmed = confirmedFingerprint === batch.budgetFingerprint;
  const [rerun, setRerun] = useState("");
  const [rerunConfirmed, setRerunConfirmed] = useState(false);
  const [reason, setReason] = useState("");
  const [sampleWithdraw, setSampleWithdraw] = useState<string | null>(null);
  const [sampleReason, setSampleReason] = useState("");
  const [cancelConfirmed, setCancelConfirmed] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deleteBatch, setDeleteBatch] = useState(false);
  const unknown = batch.samples.some((s) => ["UNKNOWN", "PENDING"].includes(s.callStatus));
  const blocker = batch.blockedReason ? runBlockCopy(batch, locale) : null;
  const hasQueuedSamples = batch.samples.some((s) => s.callStatus === "QUEUED");
  return (
    <section className="pelican-admin-batch" aria-label={t("Selected batch", "当前批次详情")}>
      <div className="pelican-panel-controls">
        <button className="pelican-text-button" disabled={stopBusy} onClick={onRefresh}>
          {t("Refresh this batch", "刷新此批次")}
        </button>
        <button className="pelican-text-button pelican-panel-close" onClick={onClose}>
          {t("Close details", "关闭详情")}
        </button>
      </div>
      <div className="pelican-batch-heading">
        <div>
          <h2>{batch.title}</h2>
          <p>
            {t("Created", "创建时间")}：{dateLabel(batch.createdAt, locale)} (UTC+8)
          </p>
        </div>
        <StatusBadge className="pelican-batch-status" state={batchState(batch.status, locale)} />
      </div>
      {batch.samples.some((s) => s.canStop || s.stopRequested) && (
        <div className="pelican-stop-actions">
          {batch.samples.some((s) => s.canStop) && (
            <button
              className="pelican-button"
              disabled={stopBusy}
              onClick={() => onAction({ action: "stop", confirmed: true })}
            >
              {t("Stop this batch", "停止本批次")}
            </button>
          )}
          <p className="pelican-note">
            {t(
              "Stop closes local requests. The provider may still charge for dispatched work.",
              "停止不保证供应商停止计费，已发送请求的费用仍需核对。",
            )}
          </p>
        </div>
      )}
      {hasQueuedSamples && (
        <div className="pelican-budget">
          <p>
            <span>{t("Estimated cost of queued samples", "待执行样本预计费用")}</span>{" "}
            <strong>USD {Number(batch.estimatedCostUsd).toFixed(4)}</strong>
            <span>
              {batch.estimatedTokens.toLocaleString()} tokens {t("estimated", "预估")}
            </span>
          </p>
          <p className="pelican-note">
            {t(
              "Estimate only. Usage and provider settlement may differ; timeouts do not prove that no fee was charged.",
              "仅为估算。实际用量与供应商实扣可能不同；超时不代表未计费。",
            )}
          </p>
        </div>
      )}
      {batch.samples.some((s) => s.callStatus === "UNKNOWN") && (
        <p className="pelican-recovery">
          {t(
            "Some calls are processing or unknown. Reconcile them before publication or another run.",
            "部分调用正在处理或结果未知，请先核对，暂不可发布或再次执行。",
          )}
        </p>
      )}
      {batch.status === "RUNNING" && (
        <details className="pelican-legacy-recovery">
          <summary>{t("Recover unsent requests", "处理未派发请求")}</summary>
          <div className="pelican-recovery">
            <p>
              {t(
                "End only the samples that have not been sent. Dispatched calls and unknown billed outcomes remain recorded.",
                "仅结束尚未发出的样本；已派发调用及费用待核对结果会继续保留。",
              )}
            </p>
            <label className="pelican-check">
              <input
                type="checkbox"
                disabled={busy}
                checked={cancelConfirmed}
                onChange={(e) => setCancelConfirmed(e.target.checked)}
              />
              {t(
                "Only end unsent requests; preserve dispatched and unconfirmed results",
                "只结束尚未发送的请求，已发送的待核对结果会保留",
              )}
            </label>
            <button
              className="pelican-button"
              disabled={busy || !cancelConfirmed}
              onClick={() => onAction({ action: "cancel-undispatched", confirmed: true })}
            >
              {t("End undispatched samples", "结束未派发样本")}
            </button>
          </div>
        </details>
      )}
      {hasQueuedSamples && blocker && (
        <div className="pelican-run-block" role="status" data-code={batch.blockedReason}>
          <strong>{blocker.title}</strong>
          <p>{blocker.body}</p>
          {blocker.detail && <p className="pelican-run-block-numbers">{blocker.detail}</p>}
          {blocker.reset && <p className="pelican-note">{blocker.reset}</p>}
        </div>
      )}
      {batch.canRun && (
        <div className="pelican-run-confirmation">
          <div className="pelican-run-scope">
            <strong>
              {t(
                `Execution scope: ${batch.samples.filter((s) => s.callStatus === "QUEUED").length} samples in this batch`,
                `本次执行范围：${batch.samples.filter((s) => s.callStatus === "QUEUED").length} 个样本（完整批次）`,
              )}
            </strong>
            <ul>
              {batch.samples
                .filter((s) => s.callStatus === "QUEUED")
                .map((s) => (
                  <li key={s.id}>
                    {s.modelName} / {strengthLabel(s.strength, locale)}
                  </li>
                ))}
            </ul>
          </div>
          <label className="pelican-check">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={busy}
              onChange={(e) =>
                setConfirmedFingerprint(e.target.checked ? batch.budgetFingerprint : null)
              }
            />
            {t(
              "I confirm the estimate and authorize this paid batch run",
              "确认本批预计费用，并授权此次真实收费测试",
            )}
          </label>
          <button
            className="pelican-button pelican-primary"
            disabled={busy || !confirmed || unknown}
            onClick={() =>
              onAction({
                action: "run",
                confirmed: true,
                budgetFingerprint: batch.budgetFingerprint,
              })
            }
          >
            {t("Run real test", "发起真实测试")}
          </button>
        </div>
      )}
      <div className="pelican-grid">
        {batch.samples
          .filter((s) => !focusedSampleId || s.id === focusedSampleId)
          .map((s) => (
            <div key={s.id}>
              <SampleCard sample={s} locale={locale} onOpen={onOpen} showExecution />
              {s.errorCode && (
                <p className="pelican-failure" role="alert">
                  <strong>{s.errorCode}</strong>
                  {s.errorMessage && <span>{s.errorMessage}</span>}
                  <span>
                    {t(
                      "Review the recorded result before preparing another run.",
                      "请核对本次记录后，再决定是否重跑。",
                    )}
                  </span>
                </p>
              )}
              {s.canStop && (
                <button
                  className="pelican-button"
                  disabled={stopBusy}
                  onClick={() => onAction({ action: "stop", confirmed: true, sampleId: s.id })}
                >
                  {s.stopRequested || s.interrupted
                    ? t("Finalize interrupted execution", "结束中断执行")
                    : t("Stop this sample", "停止此样本")}
                </button>
              )}
              {s.canDelete && (
                <button
                  className="pelican-text-button"
                  disabled={busy}
                  onClick={() => setDeleteId(s.id)}
                >
                  {t("Delete failed record", "删除失败记录")}
                </button>
              )}
              {deleteId === s.id && (
                <div className="pelican-recovery">
                  <p>
                    {t(
                      "Remove this failed record from your list. Billing and audit records are retained.",
                      "从你的列表移除此失败记录，账务与审计记录仍保留。",
                    )}
                  </p>
                  <button
                    className="pelican-button"
                    disabled={busy}
                    onClick={() => {
                      onAction({ action: "delete-failed", confirmed: true, sampleId: s.id });
                      setDeleteId(null);
                    }}
                  >
                    {t("Confirm deleting this failed record", "确认删除此失败记录")}
                  </button>
                  <button className="pelican-text-button" onClick={() => setDeleteId(null)}>
                    {t("Cancel", "取消")}
                  </button>
                </div>
              )}
              <details className="pelican-snapshot">
                <summary>{t("Recorded settings", "本次参数快照")}</summary>
                <dl>
                  <dt>{t("Request model", "请求模型")}</dt>
                  <dd>{s.requestedModel}</dd>
                  <dt>{t("Response model", "响应模型")}</dt>
                  <dd>{s.resolvedModel ?? t("Not returned", "未返回")}</dd>
                  <dt>{t("Provider", "调用渠道")}</dt>
                  <dd>{s.provider}</dd>
                  <dt>{t("Output token limit", "输出 token 上限")}</dt>
                  <dd>{s.maxOutputTokens}</dd>
                  <dt>{t("Reasoning reserve", "思考 token 预留")}</dt>
                  <dd>{s.reasoningTokenReserve}</dd>
                  <dt>{t("Timeout", "等待上限")}</dt>
                  <dd>
                    {s.timeoutMs === 0
                      ? t("No application deadline", "不限等待时间")
                      : `${s.timeoutMs / 1000} s`}
                  </dd>
                  <dt>{t("Finish reason", "完成原因")}</dt>
                  <dd>{s.finishReason ?? t("Unknown", "未知")}</dd>
                  {s.previewReason && (
                    <>
                      <dt>{t("Preview explanation", "预览处理说明")}</dt>
                      <dd>{s.previewReason}</dd>
                    </>
                  )}
                  {s.rerunOf && (
                    <>
                      <dt>{t("Original sample", "关联原始样本")}</dt>
                      <dd>{s.rerunOf}</dd>
                    </>
                  )}
                </dl>
              </details>
              <PelicanEvidence sampleId={s.id} locale={locale} />
              {s.callStatus === "SUCCEEDED" &&
                ["PENDING", "INVALID", "BLOCKED", "UNSUPPORTED"].includes(s.previewStatus) &&
                !["PUBLISHED", "WITHDRAWN"].includes(batch.status) && (
                  <button
                    className="pelican-text-button"
                    disabled={busy}
                    onClick={() => onAction({ action: "preview", sampleId: s.id })}
                  >
                    {t("Prepare preview of existing result", "准备已有结果预览")}
                  </button>
                )}
              {!["QUEUED", "PENDING", "UNKNOWN"].includes(s.callStatus) &&
                batch.status !== "PUBLISHED" &&
                batch.status !== "WITHDRAWN" && (
                  <button
                    className="pelican-text-button"
                    disabled={busy || unknown}
                    onClick={() => {
                      setRerun(s.id);
                      setRerunConfirmed(false);
                    }}
                  >
                    {t("Prepare a separate rerun", "准备独立重跑样本")}
                  </button>
                )}
              {batch.status === "PUBLISHED" && (
                <div className="pelican-sample-publication">
                  {s.withdrawn ? (
                    <>
                      <span className="pelican-note">{t("Withdrawn from public view", "已从公开页撤回")}</span>
                      <button
                        className="pelican-text-button"
                        disabled={busy}
                        onClick={() => onAction({ action: "restore-sample", sampleId: s.id })}
                      >
                        {t("Republish this sample", "重新发布此样本")}
                      </button>
                    </>
                  ) : sampleWithdraw === s.id ? (
                    <>
                      <label>
                        {t("Withdrawal reason", "撤回原因")}
                        <input
                          value={sampleReason}
                          maxLength={500}
                          onChange={(e) => setSampleReason(e.target.value)}
                          disabled={busy}
                        />
                      </label>
                      <button
                        className="pelican-button"
                        disabled={busy || !sampleReason.trim()}
                        onClick={() => {
                          onAction({ action: "withdraw-sample", sampleId: s.id, reason: sampleReason.trim() });
                          setSampleWithdraw(null);
                          setSampleReason("");
                        }}
                      >
                        {t("Confirm withdrawal", "确认撤回")}
                      </button>
                      <button
                        className="pelican-text-button"
                        disabled={busy}
                        onClick={() => {
                          setSampleWithdraw(null);
                          setSampleReason("");
                        }}
                      >
                        {t("Cancel", "取消")}
                      </button>
                    </>
                  ) : (
                    <button
                      className="pelican-text-button"
                      disabled={busy}
                      onClick={() => {
                        setSampleWithdraw(s.id);
                        setSampleReason("");
                      }}
                    >
                      {t("Withdraw this sample", "撤回此样本")}
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
      </div>
      {rerun && (
        <div className="pelican-recovery">
          <p>
            {t(
              "A rerun preserves the original and creates a new queued sample. Running it requires a new budget confirmation and may incur another fee.",
              "重跑会保留原样本，并新增关联的待执行样本。执行需要重新确认预算，可能另行收费。",
            )}
          </p>
          <label className="pelican-check">
            <input
              type="checkbox"
              checked={rerunConfirmed}
              disabled={busy}
              onChange={(e) => setRerunConfirmed(e.target.checked)}
            />
            {t("I confirm this is a new paid intent", "确认这是新的独立收费意图")}
          </label>
          <button
            className="pelican-button"
            disabled={busy || !rerunConfirmed}
            onClick={() => {
              onAction({ action: "rerun", sampleId: rerun, confirmed: true });
              setRerun("");
            }}
          >
            {t("Create rerun sample", "创建重跑样本")}
          </button>
          <button className="pelican-text-button" disabled={busy} onClick={() => setRerun("")}>
            {t("Cancel", "取消")}
          </button>
        </div>
      )}
      <div className="pelican-publication-actions">
        {batch.canPublish && (
          <button
            className="pelican-button pelican-primary"
            disabled={busy || unknown}
            onClick={() => onAction({ action: "publish" })}
          >
            {batch.status === "WITHDRAWN"
              ? t("Republish batch", "重新发布批次")
              : t("Publish complete batch", "发布完整批次")}
          </button>
        )}
        {batch.status === "PUBLISHED" && (
          <>
            <label>
              {t("Withdrawal reason", "撤回原因")}
              <input
                value={reason}
                maxLength={500}
                onChange={(e) => setReason(e.target.value)}
                disabled={busy}
              />
            </label>
            <button
              className="pelican-button"
              disabled={busy || !reason.trim()}
              onClick={() => onAction({ action: "withdraw", reason: reason.trim() })}
            >
              {t("Withdraw batch", "撤回批次")}
            </button>
          </>
        )}
      </div>
      {batch.canDelete && (
        <div className="pelican-record-delete">
          {deleteBatch ? (
            <div
              className="pelican-recovery"
              role="group"
              aria-label={t("Confirm record deletion", "确认删除记录")}
            >
              <p>
                {t(
                  "This removes the test record from the management list only. Execution, billing, publication and audit evidence are retained; any unresolved charge remains recorded.",
                  "仅从管理列表移除此测试记录；执行、费用、发布与审计证据仍保留，待核对费用不会消失。",
                )}
              </p>
              <button
                className="pelican-button"
                disabled={busy}
                onClick={() => onAction({ action: "delete-batch", confirmed: true })}
              >
                {t("Confirm deleting this test record", "确认删除此测试记录")}
              </button>
              <button
                className="pelican-text-button"
                disabled={busy}
                onClick={() => setDeleteBatch(false)}
              >
                {t("Cancel", "取消")}
              </button>
            </div>
          ) : (
            <button
              className="pelican-text-button pelican-danger-text"
              disabled={busy}
              onClick={() => setDeleteBatch(true)}
            >
              {t("Delete test record", "删除测试记录")}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
