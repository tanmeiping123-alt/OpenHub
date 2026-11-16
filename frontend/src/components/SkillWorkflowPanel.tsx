"use client";
import { useState, useRef, useEffect } from "react";
import Link from "next/link";
import type { Locale, Mode, TaskType } from "@/lib/types";
import { MODE_POLICIES } from "@/lib/mode-policy";
import { skillErrorMessage } from "@/lib/skill-errors";
import type { SkillSelection, TaskAnalysis, MatchingMode } from "@/lib/skill-workflow";
import { useAppStore } from "@/lib/store";
import { fetchRemoteSnapshot } from "@/lib/api-client";
import { EvidenceDisclosure } from "./EvidenceDisclosure";
import { ResultActions } from "./ResultActions";
import { PromptDiff } from "./PromptDiff";
import { ModelControls, ModelResultEvidence, useModelSelection } from "./ModelControls";
import type { ModelSelection, ModelProvider, ModelStrength } from "@/lib/model-catalog";
type Candidate = { versionId: string; name: string; description: string };
type Plan = {
  id: string;
  analysis: TaskAnalysis & {
    matching: { gaps: string[]; candidates: (Candidate & { reason: string })[] };
  };
  selections: SkillSelection[];
};
type Result = {
  promptId: string;
  versionId: string;
  content: string;
  executionId: string;
  provider?: ModelProvider;
  resolvedModel?: string;
  strength?: ModelStrength;
  optimizationId?: string;
  usage: Partial<import("@/lib/types").ModelUsage> & { totalTokens: number };
};
type WorkflowDraft = {
  goal: string;
  taskType: TaskType;
  matchingMode: MatchingMode;
  selected: string[];
  manualOverride?: boolean;
  deliveryPreference?: "AUTO" | "SINGLE_PROMPT" | "PROMPT_PACKAGE";
  responsibilities: Record<string, string>;
  plan: Plan | null;
  modelSelection?: ModelSelection;
  pending?: ModelSelection & {
    key: string;
    planId: string;
    purpose: "PROMPT_GENERATION" | "OPTIMIZATION";
    promptId?: string;
    versionId?: string;
  };
  result?: Result;
  appliedVersionId?: string;
  runStatus?: string;
  errorCode?: string;
  failedExecutionId?: string;
};
export function SkillWorkflowPanel({
  locale,
  mode,
  userId,
  source,
}: {
  locale: Locale;
  mode: Mode;
  userId: string;
  source?: { promptId: string; versionId: string; taskType: TaskType };
}) {
  const { state, dispatch } = useAppStore();
  const storageKey = `pm-skill-workflow:${userId}:${source?.promptId ?? "generate"}`;
  const [draft, setDraft] = useState<WorkflowDraft>(() => {
    try {
      const saved = sessionStorage.getItem(storageKey);
      if (saved) return JSON.parse(saved);
    } catch {}
    return {
      goal: "",
      taskType: source?.taskType ?? "General",
      matchingMode: MODE_POLICIES[mode].defaultMatchingMode,
      selected: [],
      responsibilities: {},
      plan: null,
    };
  });
  const modelControl = useModelSelection(draft.pending ?? draft.modelSelection);
  const controls = {
    ...modelControl,
    setSelection: (next: ModelSelection) => {
      modelControl.setSelection(next);
      setDraft((d) => ({ ...d, modelSelection: next }));
    },
  };
  const [candidates, setCandidates] = useState<Candidate[]>([]),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(""),
    [error, setError] = useState("");
  const [provenance, setProvenance] = useState<unknown>(null);
  const lock = useRef(false);
  const t = (en: string, zh: string) => (locale === "zh-CN" ? zh : en);
  useEffect(() => {
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(draft));
    } catch {}
  }, [storageKey, draft]);
  async function run(work: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : "UNAVAILABLE");
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function json(path: string, body?: unknown, key?: string) {
    const r = await fetch(
      path,
      body
        ? {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(key ? { "Idempotency-Key": key } : {}),
            },
            body: JSON.stringify(body),
          }
        : { cache: "no-store" },
    );
    const value = await r.json();
    if (!r.ok) throw Error(value.error ?? "UNAVAILABLE");
    return value;
  }
  function change(patch: Partial<WorkflowDraft>) {
    setProvenance(null);
    setDraft((d) => ({
      ...d,
      ...patch,
      plan: null,
      result: undefined,
      appliedVersionId: undefined,
      runStatus: undefined,
      errorCode: undefined,
    }));
  }
  async function receive(value: { status: string; result?: Result; error_code?: string }) {
    if (value.status === "SUCCEEDED" && value.result) {
      setDraft((d) => ({
        ...d,
        result: value.result,
        pending: undefined,
        runStatus: value.status,
        errorCode: undefined,
      }));
      setNotice(
        t(
          "LIVE result saved. The target task has not been executed or scored.",
          "真实结果已保存。目标任务尚未执行，也未评分。",
        ),
      );
      const snapshot = await fetchRemoteSnapshot();
      if (snapshot.kind === "ready") await dispatch({ type: "HYDRATE", saved: snapshot.snapshot });
      else
        setNotice(
          t(
            "Result saved; workspace refresh pending. Use the saved-result link.",
            "结果已保存，工作区刷新待完成，请使用结果链接。",
          ),
        );
    } else if (value.status === "FAILED") {
      setDraft((d) => ({
        ...d,
        pending: undefined,
        runStatus: value.status,
        errorCode: value.error_code,
        failedExecutionId: value.result?.executionId,
      }));
      setError(value.error_code ?? "WORKFLOW_FAILED");
    } else
      setNotice(
        t(
          "Result unresolved. Reconcile this key; no second model call will be dispatched. Do not create a replacement request while reconciliation is pending.",
          "结果尚待核对。请核对此凭据，不会再次发模型请求；核对完成前请勿另建替代请求。",
        ),
      );
  }
  const locked = busy || !!draft.pending;
  return (
    <section
      className="panel panel-pad stack"
      style={{ overflowWrap: "anywhere" }}
      aria-label={t("Skills-assisted prompt workflow", "Skills 辅助提示词流程")}
    >
      <h3>{t("Skills-assisted generation / optimization", "Skills 辅助生成 / 优化")}</h3>
      <p>
        {t(
          "Describe the task, review a plan, then generate or optimize. Planning does not call a model; live generation may incur charges.",
          "描述任务、检查计划，再生成或优化。分析计划不调用模型，真实生成可能产生费用。",
        )}
      </p>
      <EvidenceDisclosure locale={locale} label={t("Workflow rules", "流程规则")}>
        <p>
          {t(
            "Shared planning service · local deterministic recommendations · no target-task or script execution. Both modes use zero to four Skills by task need; this is an engineering bound, not a paid tier.",
            "共用计划服务 · 本地确定性推荐 · 不执行目标任务或脚本。两种模式均按任务需要使用 0–4 个 Skills，这是工程保护上限，不是付费权益。",
          )}
        </p>
      </EvidenceDisclosure>
      <p>
        {t(
          "Generate saves a new Prompt; Optimize creates a proposal, and only Apply creates a new version. Live calls use the existing token/cost quota and may incur provider charges.",
          "生成会保存新 Prompt；优化先产生提案，仅点击应用后创建新版本。真实调用沿用现有 token/费用额度，可能产生供应商费用。",
        )}
      </p>
      {error && (
        <div role="alert">
          <p>{skillErrorMessage(error, locale)}</p>
          <details>
            <summary>{t("Technical details", "技术详情")}</summary>
            <code>{error}</code>
          </details>
        </div>
      )}
      <label htmlFor={`workflow-goal-${source?.promptId ?? "new"}`}>
        {t("Task goal and explicit constraints", "任务目标及明确约束")}
      </label>
      <textarea
        id={`workflow-goal-${source?.promptId ?? "new"}`}
        className="textarea"
        value={draft.goal}
        disabled={locked}
        maxLength={10000}
        onChange={(e) => change({ goal: e.target.value })}
      />
      <details open={mode === "professional" ? true : undefined}>
        <summary>{t("Matching controls and responsibilities", "匹配控制与职责")}</summary>
        <div className="stack">
          <label htmlFor="workflow-delivery">{t("Delivery", "交付方式")}</label>
          <select
            id="workflow-delivery"
            className="select"
            disabled={locked}
            value={draft.deliveryPreference ?? "AUTO"}
            onChange={(e) =>
              change({ deliveryPreference: e.target.value as WorkflowDraft["deliveryPreference"] })
            }
          >
            <option value="AUTO">{t("Choose from actual dependencies", "依据实际依赖判断")}</option>
            <option value="SINGLE_PROMPT">{t("One Prompt", "一份 Prompt")}</option>
            <option value="PROMPT_PACKAGE">{t("Stage package", "阶段包")}</option>
          </select>
          <label htmlFor="workflow-matching">
            {t(
              "Matching mode (changing the display mode preserves this selection)",
              "匹配方式（切换显示模式保留当前选择）",
            )}
          </label>
          <select
            id="workflow-matching"
            className="input"
            disabled={locked}
            value={draft.matchingMode}
            onChange={(e) => change({ matchingMode: e.target.value as MatchingMode })}
          >
            {["AUTO", "HYBRID", "MANUAL"].map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
          <button
            className="btn"
            disabled={locked}
            onClick={() =>
              change({
                matchingMode: draft.matchingMode === "AUTO" ? "MANUAL" : draft.matchingMode,
                selected: [],
                manualOverride: true,
              })
            }
          >
            {t("Use no Skills explicitly", "明确不使用 Skills")}
          </button>
          <button
            className="btn"
            disabled={locked}
            onClick={() => change({ selected: [], manualOverride: false })}
          >
            {t("Reset manual overrides", "重置手动覆盖")}
          </button>
          <button
            className="btn"
            disabled={locked}
            onClick={() =>
              void run(async () => {
                const all: Candidate[] = [];
                let page = 1;
                while (true) {
                  const overview = await json(`/api/skills/library?page=${page}`);
                  const combined = [
                    ...overview.library,
                    ...overview.personal.filter(
                      (s: { publicationKind: string; withdrawnAt?: string }) =>
                        overview.user.role === "USER" || (s.publicationKind && !s.withdrawnAt),
                    ),
                  ];
                  for (const c of combined)
                    if (!all.some((s) => s.versionId === c.versionId)) all.push(c);
                  const max = Math.max(
                    overview.totals?.library ?? 0,
                    overview.totals?.personal ?? 0,
                  );
                  if (page * 25 >= max) break;
                  if (page >= 40) throw Error("CANDIDATE_LIMIT_REFINE_REQUIRED");
                  page++;
                }
                setCandidates(all);
              })
            }
          >
            {t("Load available Skills", "加载可用 Skills")}
          </button>
          {candidates.map((c) => (
            <div key={c.versionId} className="field">
              <label className="row">
                <input
                  type="checkbox"
                  disabled={
                    locked ||
                    draft.matchingMode === "AUTO" ||
                    (!draft.selected.includes(c.versionId) && draft.selected.length >= 4)
                  }
                  checked={draft.selected.includes(c.versionId)}
                  onChange={(e) =>
                    change({
                      manualOverride: true,
                      selected: e.target.checked
                        ? [...draft.selected, c.versionId]
                        : draft.selected.filter((v) => v !== c.versionId),
                    })
                  }
                />
                {c.name} · {c.description}
              </label>
              {draft.selected.includes(c.versionId) && (
                <>
                  <label htmlFor={`duty-${c.versionId}`}>
                    {t("Responsibility and expected contribution", "职责与预期贡献")}
                  </label>
                  <input
                    id={`duty-${c.versionId}`}
                    className="input"
                    disabled={locked}
                    maxLength={500}
                    value={draft.responsibilities[c.versionId] ?? ""}
                    onChange={(e) =>
                      change({
                        responsibilities: {
                          ...draft.responsibilities,
                          [c.versionId]: e.target.value,
                        },
                      })
                    }
                  />
                </>
              )}
            </div>
          ))}
        </div>
      </details>
      <button
        className="btn"
        disabled={locked || !draft.goal.trim()}
        onClick={() =>
          void run(async () => {
            const plan = await json("/api/skills/workflow", {
              action: "plan",
              goal: draft.goal,
              taskType: draft.taskType,
              locale,
              matchingMode: draft.matchingMode,
              selectedVersionIds: draft.selected,
              manualOverride: draft.manualOverride ?? false,
              deliveryPreference: draft.deliveryPreference ?? "AUTO",
              responsibilities: Object.fromEntries(
                Object.entries(draft.responsibilities).filter(([k]) => draft.selected.includes(k)),
              ),
            });
            setDraft((d) => ({
              ...d,
              plan,
              result: undefined,
              runStatus: undefined,
              appliedVersionId: undefined,
            }));
            setNotice(t("Plan saved. No model call occurred.", "计划已保存，未调用模型。"));
          })
        }
      >
        {t("Analyze and preview plan · no model charge", "分析并预览计划 · 不调用模型")}
      </button>
      {draft.plan && (
        <div className="stack">
          <p>
            {draft.plan.analysis.delivery === "SINGLE_PROMPT"
              ? t("Single prompt plan", "单提示词计划")
              : t("Multi-step prompt plan", "多步骤提示词计划")}{" "}
            · {draft.plan.selections.length} Skills
          </p>
          <p role="status">
            {t(
              "Plan saved. Next: review the plan, then explicitly start the live model if needed.",
              "计划已保存。下一步：检查计划，按需明确启动真实模型。",
            )}
          </p>
          {draft.plan.analysis.stages.map((s, i) => (
            <p key={i}>
              {i + 1}. {s.name} · {s.input} · {s.acceptance}
            </p>
          ))}
          {draft.plan.selections.map((s) => (
            <details key={s.versionId}>
              <summary style={{ overflowWrap: "anywhere" }}>{s.name}</summary>
              <p>{s.responsibility}</p>
              <p>{s.notes.join(" · ")}</p>
              <p>{s.versionId}</p>
              {s.resources.map((r) => (
                <p key={r.path} className="small" style={{ overflowWrap: "anywhere" }}>
                  {r.path} · {r.sha256}
                </p>
              ))}
            </details>
          ))}
          <p>{draft.plan.analysis.matching.gaps.join(" · ")}</p>
          <details>
            <summary>
              {t(
                "View evidence · Candidate reasons and unresolved conditions",
                "查看依据 · 候选理由与未解决条件",
              )}
            </summary>
            <p>{draft.plan.id}</p>
            <pre
              style={{
                whiteSpace: "pre-wrap",
                overflowWrap: "anywhere",
                maxHeight: 300,
                overflow: "auto",
              }}
            >
              {JSON.stringify(draft.plan.analysis, null, 2)}
            </pre>
          </details>
          {!draft.result && (
            <ModelControls control={controls} locale={locale} disabled={busy || !!draft.pending} />
          )}
          {!draft.result && (
            <button
              className="btn btn-primary"
              disabled={busy || (!draft.pending && !modelControl.canRun)}
              onClick={() =>
                void run(async () => {
                  const pending = draft.pending ?? {
                    key: crypto.randomUUID(),
                    planId: draft.plan!.id,
                    purpose: source ? ("OPTIMIZATION" as const) : ("PROMPT_GENERATION" as const),
                    ...(source ? { promptId: source.promptId, versionId: source.versionId } : {}),
                    ...modelControl.selection,
                  };
                  const next = { ...draft, pending };
                  setDraft(next);
                  try {
                    sessionStorage.setItem(storageKey, JSON.stringify(next));
                  } catch {
                    throw Error("REQUEST_STORAGE_UNAVAILABLE");
                  }
                  await receive(
                    await json(
                      "/api/skills/workflow",
                      {
                        action: "run",
                        planId: pending.planId,
                        purpose: pending.purpose,
                        ...(pending.modelKey ? { modelKey: pending.modelKey } : {}),
                        ...(pending.strength ? { strength: pending.strength } : {}),
                        ...(pending.maxOutputTokens
                          ? { maxOutputTokens: pending.maxOutputTokens }
                          : {}),
                        ...(pending.promptId
                          ? { promptId: pending.promptId, versionId: pending.versionId }
                          : {}),
                      },
                      pending.key,
                    ),
                  );
                })
              }
            >
              {draft.pending
                ? t("Reconcile live workflow", "核对真实流程")
                : source
                  ? t("Create live Skill optimization proposal", "生成真实 Skill 优化提案")
                  : t("Generate and save with live model", "真实模型生成并保存")}
            </button>
          )}
        </div>
      )}
      {draft.result && (
        <div className="stack">
          <p>
            {source &&
            state.versions.find((v) => v.id === draft.result!.versionId)?.content ===
              draft.result.content
              ? t(
                  "The current expression is already clear. Usage is recorded; no new version is needed.",
                  "当前表达已足够清楚。用量已记录，无需创建新版本。",
                )
              : source && !draft.appliedVersionId
                ? t(
                    "LIVE proposal ready · not applied to a Prompt version",
                    "真实提案已就绪 · 尚未应用为 Prompt 版本",
                  )
                : t(
                    "LIVE result saved · next: continue editing or export",
                    "真实结果已保存 · 下一步：继续编辑或导出",
                  )}
          </p>
          {source && (
            <details>
              <summary>{t("Review body changes", "查看正文改动")}</summary>
              <PromptDiff
                locale={locale}
                before={state.versions.find((v) => v.id === draft.result!.versionId)?.content ?? ""}
                after={draft.result.content}
              />
            </details>
          )}
          <pre
            style={{
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
              maxHeight: 400,
              overflow: "auto",
            }}
          >
            {draft.result.content}
          </pre>
          <ResultActions
            locale={locale}
            title={draft.goal || t("Skill result", "Skill 结果")}
            content={draft.result.content}
            editHref={`/${locale}/app/prompts/${draft.result.promptId}/edit`}
            onEdit={() => {
              const prompt = state.prompts.find((p) => p.id === draft.result!.promptId);
              void dispatch({
                type: "SET_DRAFT",
                patch: {
                  promptId: draft.result!.promptId,
                  title: prompt?.title ?? draft.goal,
                  taskType: source?.taskType ?? draft.taskType,
                  descriptor: prompt?.descriptor,
                  parentVersionId: draft.appliedVersionId ?? draft.result!.versionId,
                  content: draft.result!.content,
                },
              });
            }}
          />
          {source && !draft.appliedVersionId ? (
            <button
              className="btn"
              disabled={
                busy ||
                state.versions.find((v) => v.id === draft.result!.versionId)?.content ===
                  draft.result.content
              }
              onClick={() =>
                void run(async () => {
                  const result = await json(
                    `/api/prompts/${encodeURIComponent(draft.result!.promptId)}/versions`,
                    {
                      content: draft.result!.content,
                      baseVersionId: draft.result!.versionId,
                      parentVersionId: draft.result!.versionId,
                      source: "SKILL_LIVE_OPTIMIZATION",
                      optimizationId: draft.result!.optimizationId,
                    },
                  );
                  setDraft((d) => ({ ...d, appliedVersionId: result.versionId }));
                  setNotice(
                    result.unchanged
                      ? t(
                          "The source is already clear; kept the existing version. Model usage is recorded.",
                          "原表达已足够清楚，保留已有版本。模型用量已记录。",
                        )
                      : t(
                          "Applied as a new version. Previous content and reports are unchanged.",
                          "已应用为新版本，旧内容及报告未改变。",
                        ),
                  );
                  const snapshot = await fetchRemoteSnapshot();
                  if (snapshot.kind === "ready")
                    await dispatch({ type: "HYDRATE", saved: snapshot.snapshot });
                  else
                    setNotice(
                      t(
                        "Applied and saved; workspace refresh is pending. Reload to view the new version.",
                        "应用已保存，工作区刷新待完成，请重新加载查看新版本。",
                      ),
                    );
                })
              }
            >
              {t("Apply proposal as new version", "应用提案为新版本")}
            </button>
          ) : (
            <Link
              className="btn"
              href={`/${locale}/app/prompts/${draft.result.promptId}/edit`}
              onClick={() =>
                void dispatch({ type: "LOAD_PROMPT", promptId: draft.result!.promptId })
              }
            >
              {t("Open saved result", "打开已保存结果")}
            </Link>
          )}
          <EvidenceDisclosure locale={locale}>
            <ModelResultEvidence result={draft.result} locale={locale} />
            <p>
              LIVE · {draft.result.usage.totalTokens} tokens · {draft.result.executionId}
            </p>
            <p>{draft.appliedVersionId ?? draft.result.versionId}</p>
            <button
              className="btn"
              disabled={busy || (!!source && !draft.appliedVersionId)}
              onClick={() =>
                void run(async () => {
                  const p = await json(
                    `/api/skills/provenance?versionId=${encodeURIComponent(draft.appliedVersionId ?? draft.result!.versionId)}`,
                  );
                  setProvenance(p);
                })
              }
            >
              {t("Inspect structured provenance", "查看结构化来源")}
            </button>
            {provenance !== null && (
              <pre className="result-body">{JSON.stringify(provenance, null, 2)}</pre>
            )}
          </EvidenceDisclosure>
        </div>
      )}
      {notice && (
        <p role="status" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
          {notice}
        </p>
      )}
      {draft.errorCode && (
        <p>
          {t(
            "The failed run is retained. A new explicit run uses a new key; check its recorded execution and any unknown costs first.",
            "失败记录已保留。再次明确运行将创建新凭据，请先检查执行记录及未知费用。",
          )}
          {draft.failedExecutionId && <code> {draft.failedExecutionId}</code>}
          <Link href={`/${locale}/app/settings`}>
            {t(" Inspect quota and pending costs", " 查看额度及待核对费用")}
          </Link>
        </p>
      )}
      <p className="small">
        {t(
          "Mode switching never calls the model or resets this plan. Loaded material is recorded as context, not proof that the model followed every instruction.",
          "切换模式不会调用模型或重置计划。加载资料记录为上下文证据，不代表模型遵循了其中每条要求。",
        )}
      </p>
    </section>
  );
}

export function SkillWorkflowEntry(props: {
  locale: Locale;
  mode: Mode;
  source?: { promptId: string; versionId: string; taskType: TaskType };
}) {
  const [userId, setUserId] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/auth/session", { cache: "no-store", signal: controller.signal })
      .then((r) => r.json())
      .then((v) => {
        if (!controller.signal.aborted) setUserId(v.user?.id ?? null);
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);
  return userId ? (
    <SkillWorkflowPanel
      key={`${userId}:${props.source?.promptId ?? "generate"}`}
      {...props}
      userId={userId}
    />
  ) : (
    <p>
      <Link className="btn" href={`/${props.locale}/app/settings`}>
        {props.locale === "zh-CN" ? "登录 / 管理 Skills" : "Sign in / manage Skills"}
      </Link>
    </p>
  );
}
