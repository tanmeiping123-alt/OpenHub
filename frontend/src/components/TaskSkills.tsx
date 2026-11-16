"use client";
import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import type { Locale, TaskType, Mode } from "@/lib/types";
import type { ModelSelection } from "@/lib/model-catalog";
import type { PromptDescriptor } from "@/lib/prompt-description";
import type { SkillSelection, TaskAnalysis } from "@/lib/skill-workflow";
import type { LiveGenerationResponse, LiveSourceResponse } from "@/lib/api-client";
import { skillErrorMessage } from "@/lib/skill-errors";
import { EvidenceDisclosure } from "./EvidenceDisclosure";
import { SkillWorkflowPanel } from "./SkillWorkflowPanel";

type Preference = "AUTO" | "MANUAL" | "NONE";
type Plan = { id: string; analysis: TaskAnalysis; selections: SkillSelection[] };
export type TaskResult = LiveGenerationResponse | LiveSourceResponse;
type Source = { promptId: string; versionId: string; taskType: TaskType };
type RunBody = ModelSelection & {
  action: "run";
  planId: string;
  purpose: "PROMPT_GENERATION" | "OPTIMIZATION";
  promptId?: string;
  versionId?: string;
};
type Draft = {
  descriptorOverride?: PromptDescriptor | null;
  goal: string;
  preference: Preference;
  selected: string[];
  delivery: "AUTO" | "SINGLE_PROMPT" | "PROMPT_PACKAGE";
  plan?: Plan;
  planInput?: string;
  needsReview: boolean;
  pending?: { key: string; body: RunBody };
  result?: TaskResult;
  resultSelections?: SkillSelection[];
  modelSelection?: ModelSelection;
  failedExecutionId?: string;
  responsibilities: Record<string, string>;
};
type Candidate = { versionId: string; name: string; description: string; personal: boolean };
type Input = ModelSelection & {
  evaluationHandoff?: import("@/lib/evaluation-handoff").EvaluationHandoff;
  goal: string;
  taskType: TaskType;
  locale: Locale;
  descriptor?: PromptDescriptor;
  source?: Source;
};

function initialDraft(storageKey: string): Draft {
  const empty: Draft = {
    goal: "",
    preference: "AUTO",
    selected: [],
    delivery: "AUTO",
    needsReview: false,
    responsibilities: {},
  };
  try {
    const saved = JSON.parse(sessionStorage.getItem(storageKey) ?? "null");
    if (
      saved &&
      typeof saved.goal === "string" &&
      ["AUTO", "MANUAL", "NONE"].includes(saved.preference) &&
      Array.isArray(saved.selected)
    )
      return { ...empty, ...saved };
  } catch {}
  return empty;
}
function isPlan(value: unknown): value is Plan {
  if (!value || typeof value !== "object") return false;
  const p = value as Plan;
  return (
    typeof p.id === "string" &&
    ["SINGLE_PROMPT", "PROMPT_PACKAGE"].includes(p.analysis?.delivery) &&
    Array.isArray(p.analysis.stages) &&
    Array.isArray(p.selections) &&
    p.selections.every((s) => typeof s.versionId === "string" && typeof s.name === "string")
  );
}
function isResult(value: unknown): value is TaskResult {
  if (!value || typeof value !== "object") return false;
  const r = value as TaskResult;
  return (
    r.executionMode === "LIVE" &&
    typeof r.executionId === "string" &&
    typeof r.promptId === "string" &&
    typeof r.versionId === "string" &&
    typeof r.content === "string" &&
    ["deepseek", "siliconflow"].includes(r.provider) &&
    typeof r.resolvedModel === "string" &&
    typeof r.productVersion === "string" &&
    typeof r.usage?.totalTokens === "number"
  );
}
async function request(path: string, body?: unknown, key?: string): Promise<unknown> {
  const response = await fetch(
    path,
    body
      ? {
          method: "POST",
          cache: "no-store",
          headers: {
            "Content-Type": "application/json",
            ...(key ? { "Idempotency-Key": key } : {}),
          },
          body: JSON.stringify(body),
        }
      : { cache: "no-store" },
  );
  const data = await response.json();
  if (!response.ok) throw Error(typeof data.error === "string" ? data.error : "UNAVAILABLE");
  return data;
}

// One task state and one frozen dispatch identity; planning never calls a model.
export function useTaskSkills(userId: string | null, scope: string) {
  const storageKey = `pm-task-skills:${userId}:${scope}`;
  const [intent] = useState(() => {
    try {
      const value = new URLSearchParams(window.location.search).get("skillVersion");
      return value && /^skv_[a-f0-9-]{36}$/.test(value) ? value : null;
    } catch {
      return null;
    }
  });
  const [draft, setDraft] = useState<Draft>(() => {
    const saved = initialDraft(storageKey);
    return intent && !saved.pending
      ? {
          ...saved,
          preference: "MANUAL",
          selected: [intent],
          plan: undefined,
          planInput: undefined,
          needsReview: false,
        }
      : saved;
  });
  useEffect(() => {
    if (!intent || !userId || draft.pending || !draft.selected.includes(intent)) return;
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(draft));
    } catch {
      return;
    }
    const url = new URL(window.location.href);
    url.searchParams.delete("skillVersion");
    window.history.replaceState(
      window.history.state,
      "",
      `${url.pathname}${url.search}${url.hash}`,
    );
  }, [intent, userId, storageKey, draft]);
  const current = useRef(draft),
    lock = useRef(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [notFound, setNotFound] = useState(false);
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [candidateBusy, setCandidateBusy] = useState(false),
    [candidateError, setCandidateError] = useState("");
  function save(next: Draft, required = false, storageError = "REQUEST_STORAGE_UNAVAILABLE") {
    try {
      if (!userId) throw Error("AUTH_REQUIRED");
      sessionStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      if (required) throw Error(storageError);
    }
    current.current = next;
    setDraft(next);
  }
  function change(
    patch: Partial<
      Pick<
        Draft,
        "goal" | "preference" | "selected" | "delivery" | "responsibilities" | "descriptorOverride"
      >
    >,
  ) {
    if (lock.current || current.current.pending) return;
    save({
      ...current.current,
      ...patch,
      plan: undefined,
      planInput: undefined,
      needsReview: false,
    });
    setError("");
  }
  async function receive(data: unknown): Promise<TaskResult | undefined> {
    if (!data || typeof data !== "object") throw Error("INVALID_MODEL_RESPONSE");
    const value = data as { status?: string; result?: unknown; error_code?: string };
    if (value.status === "SUCCEEDED" && isResult(value.result)) {
      const d = current.current;
      const result = { ...value.result };
      // Reconciled generation receipts carry purpose; normal generation does not.
      if ((result as { purpose?: string }).purpose === "PROMPT_GENERATION")
        delete (result as { purpose?: string }).purpose;
      save(
        {
          ...d,
          pending: undefined,
          result,
          resultSelections: d.plan?.selections ?? [],
          needsReview: false,
          failedExecutionId: undefined,
        },
        true,
        "RESULT_STORAGE_UNAVAILABLE",
      );
      setNotFound(false);
      return result;
    }
    if (value.status === "FAILED") {
      const result = value.result as { executionId?: string } | undefined;
      save(
        {
          ...current.current,
          pending: undefined,
          needsReview: false,
          failedExecutionId: result?.executionId,
        },
        true,
        "RESULT_STORAGE_UNAVAILABLE",
      );
      setError(value.error_code ?? "WORKFLOW_FAILED");
      return;
    }
    if (value.status !== "RUNNING") throw Error("INVALID_MODEL_RESPONSE");
  }
  async function perform(work: () => Promise<TaskResult | undefined>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      return await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : "UNAVAILABLE");
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function run(input: Input) {
    if (current.current.pending || !input.goal.trim()) return;
    return perform(async () => {
      if (!userId) throw Error("AUTH_REQUIRED");
      const d = current.current,
        manual = d.preference !== "AUTO";
      const planBody = {
        action: "plan",
        ...(input.evaluationHandoff ? { evaluationHandoff: input.evaluationHandoff } : {}),
        ...(input.source
          ? { source: { promptId: input.source.promptId, versionId: input.source.versionId } }
          : { goal: input.goal.trim() }),
        taskType: input.taskType,
        locale: input.locale,
        matchingMode: manual ? "MANUAL" : "AUTO",
        selectedVersionIds: d.preference === "MANUAL" ? d.selected : [],
        manualOverride: manual,
        deliveryPreference: d.delivery,
        ...(d.preference === "MANUAL"
          ? {
              responsibilities: Object.fromEntries(
                Object.entries(d.responsibilities).filter(([v]) => d.selected.includes(v)),
              ),
            }
          : {}),
        ...(input.descriptor ? { descriptor: input.descriptor } : {}),
      };
      const planInput = JSON.stringify({ ...planBody, source: input.source });
      const reviewing = d.needsReview && d.planInput === planInput && d.plan;
      const plan = reviewing ? d.plan! : await request("/api/skills/workflow", planBody);
      if (!isPlan(plan)) throw Error("INVALID_PLAN_RESPONSE");
      const next: Draft = {
        ...d,
        plan,
        planInput,
        needsReview: false,
        modelSelection: {
          modelKey: input.modelKey,
          strength: input.strength,
          maxOutputTokens: input.maxOutputTokens,
        },
      };
      if (!reviewing && plan.analysis.delivery === "PROMPT_PACKAGE") {
        save({ ...next, needsReview: true });
        return;
      }
      const pending = {
        key: crypto.randomUUID(),
        body: {
          action: "run" as const,
          planId: plan.id,
          purpose: input.source ? ("OPTIMIZATION" as const) : ("PROMPT_GENERATION" as const),
          ...(input.source
            ? { promptId: input.source.promptId, versionId: input.source.versionId }
            : {}),
          ...next.modelSelection,
        },
      };
      // Failed recovery storage means no model dispatch.
      save({ ...next, pending }, true);
      return receive(await request("/api/skills/workflow", pending.body, pending.key));
    });
  }
  async function reconcile(retrySame = false) {
    const p = current.current.pending;
    if (!p) return;
    return perform(async () => {
      const value = await request(
        retrySame
          ? "/api/skills/workflow"
          : `/api/skills/workflow?requestKey=${encodeURIComponent(p.key)}`,
        retrySame ? p.body : undefined,
        retrySame ? p.key : undefined,
      );
      if (
        value === null ||
        (value && typeof value === "object" && "status" in value && value.status === "NOT_FOUND")
      ) {
        setNotFound(true);
        return;
      }
      return receive(value);
    });
  }
  async function loadCandidates() {
    if (candidateBusy) return;
    setCandidateBusy(true);
    setCandidateError("");
    try {
      const found = new Map<string, Candidate>();
      for (let page = 1; page <= 40; page++) {
        const data = (await request(`/api/skills/library?page=${page}`)) as {
          library: Candidate[];
          personal: Candidate[];
          user: { role: string };
          totals?: { library: number; personal: number };
          pageSize?: number;
        };
        if (!Array.isArray(data.library) || !Array.isArray(data.personal) || !data.user)
          throw Error("INVALID_LIBRARY_RESPONSE");
        for (const s of data.library) found.set(s.versionId, { ...s, personal: false });
        for (const s of data.personal)
          if (!found.has(s.versionId) && data.user.role === "USER")
            found.set(s.versionId, { ...s, personal: true });
        const total = Math.max(
          data.totals?.library ?? data.library.length,
          data.totals?.personal ?? data.personal.length,
        );
        if (page * (data.pageSize ?? 25) >= total) {
          setCandidates([...found.values()]);
          return;
        }
      }
      throw Error("CANDIDATE_LIMIT_REFINE_REQUIRED");
    } catch (e) {
      setCandidateError(e instanceof Error ? e.message : "UNAVAILABLE");
    } finally {
      setCandidateBusy(false);
    }
  }
  return {
    ...draft,
    busy,
    locked: busy || !!draft.pending,
    error,
    notFound,
    candidates,
    candidateBusy,
    candidateError,
    change,
    run,
    reconcile,
    loadCandidates,
  };
}
export type TaskSkillsControl = ReturnType<typeof useTaskSkills>;

export function TaskSkills({
  control: c,
  locale,
  disabled = false,
  onResult,
  taskReturn,
}: {
  control: TaskSkillsControl;
  locale: Locale;
  disabled?: boolean;
  onResult: (result: TaskResult) => Promise<void>;
  taskReturn?: string;
}) {
  const id = useId(),
    t = (en: string, zh: string) => (locale === "zh-CN" ? zh : en);
  const [open, setOpen] = useState(false),
    locked = c.locked || disabled;
  const names = c.plan?.selections.map((s) => s.name) ?? [];
  const status = c.plan
    ? names.length
      ? t(`This task references: ${names.join(", ")}`, `本次参考：${names.join("、")}`)
      : t("No Skill used for this task", "本次未使用 Skill")
    : c.preference === "NONE"
      ? t("Skills excluded for this task", "本次不使用 Skills")
      : c.preference === "MANUAL"
        ? t(
            `${c.selected.length} Skills selected for this task`,
            `已为本次任务选择 ${c.selected.length} 个 Skills`,
          )
        : t("Skills · select automatically when relevant", "Skills · 按需自动选择");
  return (
    <section className="task-skills" aria-label={t("Skills for this task", "本次任务的 Skills")}>
      <div className="task-skills-status">
        <p role="status">{status}</p>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          aria-expanded={open}
          aria-controls={`${id}-settings`}
          disabled={locked}
          onClick={() => {
            setOpen(!open);
            if (!open && c.preference === "MANUAL" && !c.candidates) void c.loadCandidates();
          }}
        >
          {t("Adjust", "调整")}
        </button>
      </div>
      {open && (
        <div id={`${id}-settings`} className="stack task-skills-settings">
          <fieldset className="task-skills-options">
            <legend className="sr-only">{t("Reference methods", "参考方法")}</legend>
            {(
              [
                ["AUTO", "Select automatically", "自动选择"],
                ["MANUAL", "Select manually", "手动选择"],
                ["NONE", "Do not use Skills", "不使用 Skills"],
              ] as const
            ).map(([value, en, zh]) => (
              <label key={value}>
                <input
                  type="radio"
                  name={`${id}-preference`}
                  value={value}
                  checked={c.preference === value}
                  disabled={locked}
                  onChange={() => {
                    c.change({
                      preference: value,
                      ...(value === "MANUAL" && c.preference === "AUTO" && c.plan
                        ? { selected: c.plan.selections.map((s) => s.versionId) }
                        : {}),
                    });
                    if (value === "MANUAL" && !c.candidates) void c.loadCandidates();
                  }}
                />
                {t(en, zh)}
              </label>
            ))}
          </fieldset>
          {c.preference === "AUTO" && (
            <p className="subtle">
              {t(
                "Recommends potentially useful published Skills. Personal imports are available through manual selection.",
                "推荐可能适用的共享 Skills；私人导入可在手动选择中采用。",
              )}
            </p>
          )}
          {c.preference === "MANUAL" && (
            <>
              {c.candidateBusy && (
                <p role="status">{t("Loading available Skills…", "正在加载可用 Skills……")}</p>
              )}
              {c.candidateError && (
                <div role="alert">
                  <p>{t("Available Skills could not be loaded.", "暂时无法加载可用 Skills。")}</p>
                  <button
                    className="btn btn-sm"
                    disabled={c.candidateBusy}
                    onClick={() => void c.loadCandidates()}
                  >
                    {t("Retry loading", "重新加载")}
                  </button>
                </div>
              )}
              {c.candidates?.map((s) => (
                <label className="task-skill-choice" key={s.versionId}>
                  <input
                    type="checkbox"
                    checked={c.selected.includes(s.versionId)}
                    disabled={
                      locked || (!c.selected.includes(s.versionId) && c.selected.length >= 4)
                    }
                    onChange={(e) =>
                      c.change({
                        selected: e.target.checked
                          ? [...c.selected, s.versionId]
                          : c.selected.filter((v) => v !== s.versionId),
                      })
                    }
                  />
                  <span>
                    <strong>{s.name}</strong>
                    <span>{s.description}</span>
                    <span className="subtle">
                      {s.personal ? t("Only you", "仅你可用") : t("Shared library", "共享库")}
                    </span>
                  </span>
                </label>
              ))}
              {c.candidates?.length === 0 && (
                <p>
                  {t(
                    "No available Skills. You can continue without them.",
                    "暂无可用 Skill，可以直接继续。",
                  )}
                </p>
              )}
              {c.selected
                .filter((v) => c.candidates && !c.candidates.some((s) => s.versionId === v))
                .map((v) => (
                  <label className="task-skill-choice" key={v}>
                    <input
                      type="checkbox"
                      checked
                      disabled={locked}
                      onChange={() => c.change({ selected: c.selected.filter((s) => s !== v) })}
                    />
                    <span>
                      {t(
                        "Selected version unavailable; remove it or refresh the library.",
                        "所选版本暂不可用，请移除或刷新库。",
                      )}
                    </span>
                  </label>
                ))}

              {!!c.selected.length && (
                <details>
                  <summary>{t("Expected contributions · optional", "预期贡献 · 可选")}</summary>
                  <div className="stack">
                    {c.selected.map((v) => (
                      <div className="field" key={v}>
                        <label htmlFor={`${id}-contribution-${v}`}>
                          {c.candidates?.find((s) => s.versionId === v)?.name ??
                            t("Selected Skill", "所选 Skill")}
                        </label>
                        <input
                          id={`${id}-contribution-${v}`}
                          className="input"
                          maxLength={500}
                          disabled={locked}
                          value={c.responsibilities[v] ?? ""}
                          placeholder={t(
                            "Relevant methods and checks only",
                            "仅采用相关方法与检查",
                          )}
                          onChange={(e) =>
                            c.change({
                              responsibilities: { ...c.responsibilities, [v]: e.target.value },
                            })
                          }
                        />
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </>
          )}
          <details>
            <summary>{t("Delivery preference", "交付方式")}</summary>
            <label htmlFor={`${id}-delivery`} className="sr-only">
              {t("Delivery preference", "交付方式")}
            </label>
            <select
              id={`${id}-delivery`}
              className="select"
              value={c.delivery}
              disabled={locked}
              onChange={(e) => c.change({ delivery: e.target.value as Draft["delivery"] })}
            >
              <option value="AUTO">
                {t("Follow actual task dependencies", "依据实际任务依赖")}
              </option>
              <option value="SINGLE_PROMPT">{t("One Prompt", "一份 Prompt")}</option>
              <option value="PROMPT_PACKAGE">{t("Stage package", "阶段包")}</option>
            </select>
          </details>
          <Link
            href={`/${locale}/app/skills${taskReturn ? `?taskReturn=${encodeURIComponent(taskReturn)}` : ""}`}
            className="text-link"
          >
            {t("Browse or add Skills", "浏览或添加 Skill")}
          </Link>
        </div>
      )}
      {c.needsReview && c.plan && (
        <div
          className="task-stage-plan stack"
          role="region"
          aria-label={t("Review stage plan", "检查阶段计划")}
        >
          <h3>{t("Review stage plan", "检查阶段计划")}</h3>
          <p>
            {t(
              "This task has dependent deliverables. Confirm the stages, then generate. No model call has occurred.",
              "本任务包含相互依赖的交付物，请检查阶段后继续生成。尚未调用模型。",
            )}
          </p>
          <ol>
            {c.plan.analysis.stages.map((s, i) => (
              <li key={i}>
                <strong>{s.name}</strong>
                <p>{s.input}</p>
                <p className="subtle">{s.acceptance}</p>
              </li>
            ))}
          </ol>
        </div>
      )}
      {c.pending && (
        <div className="stack task-pending" role="status">
          <p>
            {c.notFound
              ? t(
                  "No run record found. Continue only with the saved request.",
                  "未发现运行记录，可使用已保存的同一次请求继续。",
                )
              : t(
                  "Result awaiting reconciliation. The task and model settings are locked to prevent duplicate calls.",
                  "结果待核对，任务和模型设置已锁定，避免重复调用。",
                )}
          </p>
          <button
            className="btn"
            disabled={c.busy}
            onClick={() => void c.reconcile().then((r) => r && onResult(r))}
          >
            {t("Reconcile this request", "核对本次请求")}
          </button>
          {c.notFound && (
            <button
              className="btn"
              disabled={c.busy}
              onClick={() => void c.reconcile(true).then((r) => r && onResult(r))}
            >
              {t("Continue with the same request", "使用同一次请求继续")}
            </button>
          )}
        </div>
      )}
      {c.error && (
        <div role="alert" className="task-skills-error">
          <p>
            {c.error === "REQUEST_STORAGE_UNAVAILABLE"
              ? t(
                  "Request recovery could not be saved. No new model call was sent. Allow browser session storage and retry.",
                  "无法保存请求核对信息，未发起新的模型调用。请允许浏览器会话存储后重试。",
                )
              : c.error === "RESULT_STORAGE_UNAVAILABLE"
                ? t(
                    "The service returned a result, but its local receipt could not be saved. Reconcile the original request after restoring browser storage; a model call may already have been charged.",
                    "服务端已返回结果，但本地回执未能保存。请恢复浏览器存储后核对原请求；模型可能已产生费用。",
                  )
                : skillErrorMessage(c.error, locale)}
          </p>
          <details>
            <summary>{t("Technical details", "技术详情")}</summary>
            <code>{c.error}</code>
            {c.failedExecutionId && <p>{c.failedExecutionId}</p>}
          </details>
          {c.failedExecutionId && (
            <Link href={`/${locale}/app/settings`}>
              {t(
                "Check quota and pending costs before a new run",
                "再次运行前查看额度和待核对费用",
              )}
            </Link>
          )}
        </div>
      )}
    </section>
  );
}

export function TaskSkillEvidence({
  control: c,
  locale,
}: {
  control: TaskSkillsControl;
  locale: Locale;
}) {
  const selections = c.resultSelections,
    t = (en: string, zh: string) => (locale === "zh-CN" ? zh : en);
  if (!c.result || !selections) return null;
  return (
    <EvidenceDisclosure locale={locale} label={t("Skill references", "本次 Skills 依据")}>
      {selections.length ? (
        selections.map((s) => (
          <div key={s.versionId}>
            <strong>{s.name}</strong>
            <p>{s.responsibility}</p>
            <details>
              <summary>{t("Referenced version", "采用版本")}</summary>
              <p>{s.versionId}</p>
              {s.notes?.map((n, i) => (
                <p key={i}>{n}</p>
              ))}
            </details>
          </div>
        ))
      ) : (
        <p>{t("No Skill context was used.", "未使用 Skill 上下文。")}</p>
      )}
      {!!selections.length && (
        <p className="subtle">
          {t(
            "These versions were supplied as method references for the stated contribution. This does not prove the model followed every instruction.",
            "上述版本作为对应职责的方法参考提供；上下文记录不代表模型遵循了每条要求。",
          )}
        </p>
      )}
    </EvidenceDisclosure>
  );
}

export function LegacySkillRecovery({
  userId,
  locale,
  mode,
  source,
}: {
  userId: string | null;
  locale: Locale;
  mode: Mode;
  source?: Source;
}) {
  const [hasDraft] = useState(() => {
    try {
      const d = JSON.parse(
        sessionStorage.getItem(`pm-skill-workflow:${userId}:${source?.promptId ?? "generate"}`) ??
          "null",
      );
      return !!(d && (d.goal?.trim() || d.pending || d.result || d.plan));
    } catch {
      return false;
    }
  });
  if (!userId || !hasDraft) return null;
  return (
    <details className="workflow-option legacy-skill-recovery">
      <summary>
        {locale === "zh-CN" ? "恢复旧 Skills 任务" : "Recover an earlier Skills task"}
      </summary>
      <SkillWorkflowPanel userId={userId} locale={locale} mode={mode} source={source} />
    </details>
  );
}
