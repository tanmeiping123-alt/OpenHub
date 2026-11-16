"use client";
import { parseEvaluationHandoff } from "@/lib/evaluation-handoff";
import { PromptContextBar } from "./PromptContextBar";
import { hasUnsavedDraft, promptActionHref, resolvePromptContext } from "@/lib/prompt-navigation";
import { AccountAuth } from "./AccountAuth";
import { CopySource } from "./community/CopySource";
import { AccountHelp } from "./AccountHelp";
import { EvidenceDisclosure } from "./EvidenceDisclosure";
import { ResultActions } from "./ResultActions";
import { PromptDescriptorFields } from "./PromptDescriptorFields";
import { PromptMetadata } from "./PromptMetadata";
import { PromptDiff } from "./PromptDiff";
import { Playground } from "./Playground";
import {
  descriptorForPrompt,
  promptDiscoveryTerms,
  promptPurposeLabel,
  purposes,
  suggestPromptDescriptor,
  type PromptDescriptor,
} from "@/lib/prompt-description";
import { DraftEditor } from "./DraftEditor";
import { ModelControls, ModelResultEvidence, useModelSelection } from "./ModelControls";
import { PromptDiagnostics } from "./PromptDiagnostics";
import { ModelEvaluationPanel } from "./ModelEvaluationPanel";
import { adviceHistoryForVersion, adviceMatchesSelection } from "@/lib/prompt-diagnostics";
import { liveSource } from "@/lib/model-catalog";
import { modelErrorDetail } from "@/lib/model-error-messages";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import {
  Activity,
  ArrowRight,
  BookOpen,
  CircleAlert,
  Clock3,
  FileText,
  Heart,
  Layers3,
  Lightbulb,
  Plus,
  RotateCcw,
  Save,
  Search,
  Sparkles,
  WandSparkles,
} from "lucide-react";
import {
  localizedContentFor,
  localizedDimensionName,
  localizedMode,
  localizedPromptKind,
  localizedReason,
  localizedSource,
  localizedTitleFor,
  suggestions,
} from "@/lib/fixtures";
import {
  fetchRemoteSnapshot,
  generateLiveEvaluationAdvice,
  toLiveAdvice,
  type LiveGenerationResponse,
  type LiveSourceResponse,
} from "@/lib/api-client";
import { useAppStore } from "@/lib/store";
import type { EvaluationReport, Locale, Prompt, PromptVersion, TaskType } from "@/lib/types";
import { CalibrationEvidence, CalibrationPanel } from "./CalibrationPanel";
import { candidateLayer2 } from "@/lib/calibration-rubric";
import { executionEvidenceFor, localizeFixtureOutput } from "@/lib/execution-evidence";
import { ModelQuotaPanel } from "./ModelQuotaPanel";
import { SkillLibraryPanel as SkillsRegistryPanel } from "./SkillLibraryPanel";
import { Dashboard, Landing } from "./StartPages";
import {
  LegacySkillRecovery,
  TaskSkills,
  TaskSkillEvidence,
  useTaskSkills,
  type TaskResult,
} from "./TaskSkills";
import { AdminAccountsPanel } from "./AdminAccountsPanel";
import { SkillProvenancePanel } from "./SkillProvenancePanel";
import { BillingPanel } from "./BillingPanel";
import { FREE_PLAN, PRO_PLAN } from "@/lib/billing-policy";

type Page =
  | "home"
  | "login"
  | "register"
  | "help"
  | "skills"
  | "dashboard"
  | "generate"
  | "editor"
  | "draft-editor"
  | "evaluator"
  | "optimizer"
  | "library"
  | "detail"
  | "history"
  | "playground"
  | "execution"
  | "pricing"
  | "checkout"
  | "account"
  | "settings";
const tx = (locale: Locale, en: string, zh: string) => (locale === "zh-CN" ? zh : en);
const route = (locale: string, rest = "") => `/${locale}${rest ? `/${rest}` : ""}`;
const libraryItemIdFor = (promptId: string) =>
  promptId === "prm_writing_course_01"
    ? "lib_writing_study_plan_01"
    : `lib_${promptId.replace("prm_", "")}`;
const localizedDescription = (id: string) =>
  ({
    prm_coding_csv_01: "验证 CSV 输入并返回类型明确的记录。",
    prm_ui_checkout_01: "检查移动端结账体验。",
    prm_writing_course_01: "为初学者设计 Prompt Engineering 学习计划。",
    prm_data_sales_01: "明确处理数据质量后分析区域销售。",
    prm_business_launch_01: "为小型在线课程制定可衡量的发布计划。",
    prm_research_claim_01: "区分证据、不确定项和后续研究。",
    prm_agent_triage_01: "提供清晰升级路径与安全边界。",
    prm_general_notes_01: "生成简洁且可追溯的会议摘要。",
  })[id] ?? "";
const localizedModelName = (name: string, locale: Locale) =>
  locale === "zh-CN" ? name.replace("Demo Model", "演示模型") : name;
const localizedModelOutput = localizeFixtureOutput;
const localizedRubric = (value: string, locale: Locale) => {
  if (locale !== "zh-CN") return value;
  return value
    .replace("Layer 1 confirmed dimensions", "Layer 1 已确认维度")
    .replace("illustrative static fixture", "静态演示 Fixture")
    .replace("Coding mock example", "Coding 模拟示例")
    .replace("Data Analysis rubric pending category review", "Data Analysis Rubric 待逐类审核")
    .replace("General fallback", "通用兜底分类")
    .replace(
      "Illustrative qualitative fixture; no formal formula",
      "定性演示 Fixture；未使用正式公式",
    )
    .replace("rubric pending category review", "Rubric 待逐类审核")
    .replace("no formal formula", "未使用正式公式");
};
const localizedEvaluationStatus = (value: string, locale: Locale) => {
  if (locale !== "zh-CN") return value;
  return (
    {
      NOT_EXECUTED: "未执行",
      NOT_AVAILABLE: "不提供",
      "PENDING REVIEW": "待审核",
      INSUFFICIENT_INFORMATION: "信息不足",
      NOT_VERIFIED: "未核验",
      "MOCK / SIMULATED": "模拟演示",
      "QUALITATIVE MOCK": "定性模拟",
      "ASSESSED · MOCK": "已评估 · 模拟",
      CANDIDATE_SCORED: "已计算候选分（非正式）",
      NOT_APPLICABLE: "不适用",
      "EXECUTED · UNGRADED": "已执行 · 未评分",
    }[value] ?? value
  );
};

function Heading({
  title,
  description,
  actions,
}: {
  eyebrow: string;
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <h1>{title}</h1>
        {description && <p className="subtle">{description}</p>}
      </div>
      {actions && (
        <div className="row" style={{ flexWrap: "wrap" }}>
          {actions}
        </div>
      )}
    </div>
  );
}
function Panel({
  title,
  note,
  children,
  action,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <section className="panel panel-pad">
      <div className="panel-head">
        <div>
          <h2>{title}</h2>
          {note && <p style={{ marginTop: 4 }}>{note}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
function StateBadge({ children, tone = "blue" }: { children: React.ReactNode; tone?: string }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
function Empty({
  title,
  detail,
  action,
}: {
  title: string;
  detail: string;
  action?: React.ReactNode;
}) {
  return (
    <div style={{ padding: "32px 18px", textAlign: "center" }}>
      <div
        style={{
          width: 42,
          height: 42,
          display: "grid",
          placeItems: "center",
          margin: "0 auto 12px",
          borderRadius: 12,
          color: "#475569",
          background: "#f1f5f9",
        }}
      >
        <FileText size={20} />
      </div>
      <h3>{title}</h3>
      <p className="subtle small" style={{ margin: "6px auto 14px", maxWidth: 420 }}>
        {detail}
      </p>
      {action}
    </div>
  );
}

function ArchitectureNote({
  locale,
  title,
  children,
}: {
  locale: Locale;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <EvidenceDisclosure locale={locale} label={title}>
      <StateBadge tone="amber">{tx(locale, "Architecture preview", "架构预览")}</StateBadge>
      <div className="small">{children}</div>
    </EvidenceDisclosure>
  );
}

export function Workspace({
  page,
  promptId,
  sourceVersionId,
}: {
  page: Page;
  promptId?: string;
  sourceVersionId?: string;
}) {
  const { state, dispatch, accountId } = useAppStore();
  const pathname = usePathname();
  const locale = state.locale;
  const { prompt: current, version: currentVersion } = resolvePromptContext(
    state,
    promptId,
    sourceVersionId,
  );
  const report = state.reports.find((item) => item.versionId === currentVersion?.id);
  const [editorSaving, setEditorSaving] = useState(false);
  const needsEditorLoad =
    page === "editor" &&
    !editorSaving &&
    current &&
    currentVersion &&
    (state.draft.promptId !== current.id || state.draft.parentVersionId !== currentVersion.id);
  const dirtyDraft = hasUnsavedDraft(state, locale);
  const loadTarget = () => {
    if (!current || !currentVersion) return;
    void dispatch({
      type: "SET_DRAFT",
      patch: {
        promptId: current.id,
        parentVersionId: currentVersion.id,
        title: localizedTitleFor(current.id, locale, currentVersion.title),
        content: localizedContentFor(currentVersion.id, locale, currentVersion.content),
        taskType: current.taskType,
        descriptor: current.descriptor,
        creationRequest: undefined,
        savedCreation: undefined,
        adoptedUseEventIds: undefined,
      },
    });
  };
  useEffect(() => {
    document.documentElement.lang = locale;
    if (needsEditorLoad && !dirtyDraft && current && currentVersion) {
      void dispatch({
        type: "SET_DRAFT",
        patch: {
          promptId: current.id,
          parentVersionId: currentVersion.id,
          title: localizedTitleFor(current.id, locale, currentVersion.title),
          content: localizedContentFor(currentVersion.id, locale, currentVersion.content),
          taskType: current.taskType,
          descriptor: current.descriptor,
          creationRequest: undefined,
          savedCreation: undefined,
          adoptedUseEventIds: undefined,
        },
      });
    }
  }, [
    locale,
    page,
    state.draft.promptId,
    state.draft.parentVersionId,
    needsEditorLoad,
    dirtyDraft,
    current,
    currentVersion,
    dispatch,
  ]);
  if (needsEditorLoad && dirtyDraft)
    return (
      <section className="panel panel-pad stack">
        <h1>{tx(locale, "Keep your current draft?", "当前草稿还未保存")}</h1>
        <p>
          {tx(
            locale,
            "Save your draft before opening another Prompt or version.",
            "切换到另一条 Prompt 或版本前，请先处理当前草稿。",
          )}
        </p>
        <div className="row">
          <Link
            className="btn btn-primary"
            href={
              state.draft.promptId
                ? route(locale, `app/prompts/${state.draft.promptId}/edit`)
                : route(locale, "app/editor")
            }
          >
            {tx(locale, "Return to draft", "返回当前草稿")}
          </Link>
          {!state.draft.creationRequest && (
            <button className="btn" onClick={loadTarget}>
              {tx(locale, "Discard draft and open", "放弃草稿并打开")}
            </button>
          )}
        </div>
      </section>
    );
  if (needsEditorLoad)
    return <p role="status">{tx(locale, "Loading source version…", "正在加载来源版本…")}</p>;
  if (page === "home") return <Landing locale={locale} />;
  if (page === "help") return <AccountHelp locale={locale} />;
  if (page === "skills")
    return (
      <>
        <Heading eyebrow="SKILLS" title={tx(locale, "Skills management", "Skills 导入与管理")} />
        <SkillsRegistryPanel locale={locale} mode={state.mode} />
      </>
    );
  if (page === "login" || page === "register") return <Auth locale={locale} page={page} />;
  if (page === "pricing") return <Pricing locale={locale} />;
  if (page === "dashboard") return <Dashboard locale={locale} />;
  if (page === "generate") return <Generator key={accountId} locale={locale} />;
  if (page === "draft-editor") return <DraftEditor locale={locale} />;
  if (
    ["editor", "evaluator", "optimizer", "playground", "execution"].includes(page) &&
    (!current || !currentVersion)
  )
    return (
      <Empty
        title={tx(
          locale,
          promptId ? "Prompt or version unavailable" : "No saved Prompt yet",
          promptId ? "找不到这条 Prompt 或版本" : "尚无已保存的 Prompt",
        )}
        detail={tx(
          locale,
          "Create a Prompt or adopt a Skill into a new draft first.",
          "请先创建 Prompt，或从 Skills 库加入新草稿。",
        )}
        action={
          <Link className="btn btn-primary" href={route(locale, "app/editor")}>
            {tx(locale, "Open new draft", "打开新草稿")}
          </Link>
        }
      />
    );
  if (page === "editor")
    return (
      <Editor
        key={`${accountId}:${current!.id}:${currentVersion!.id}`}
        onSaving={setEditorSaving}
        locale={locale}
        prompt={current!}
        version={currentVersion!}
      />
    );
  if (page === "evaluator")
    return (
      <Evaluator locale={locale} prompt={current!} version={currentVersion!} report={report} />
    );
  if (page === "optimizer")
    return (
      <Optimizer
        key={`${accountId}:${currentVersion!.id}`}
        locale={locale}
        prompt={current!}
        version={currentVersion!}
      />
    );
  if (page === "library") return <LibraryPage locale={locale} />;
  if (page === "detail") return <Detail locale={locale} itemId={pathname.split("/").pop() ?? ""} />;
  if (page === "history") return <HistoryPage locale={locale} />;
  if (page === "playground")
    return (
      <Playground
        key={`${accountId}:${sourceVersionId ?? "default"}`}
        locale={locale}
        version={currentVersion!}
        explicitTarget={!!sourceVersionId}
      />
    );
  if (page === "execution")
    return (
      <ExecutionReport
        locale={locale}
        prompt={current!}
        version={currentVersion!}
        report={report}
      />
    );
  if (page === "account") return <Account locale={locale} />;
  if (page === "checkout") return <BillingPanel locale={locale} checkoutPage />;
  if (page === "settings") return <Settings locale={locale} />;
  return null;
}

function Auth({ locale, page }: { locale: Locale; page: "login" | "register" }) {
  return <AccountAuth locale={locale} page={page} />;
}
function Generator({ locale }: { locale: Locale }) {
  const { state, dispatch, accountId } = useAppStore();
  const skills = useTaskSkills(accountId, "generate");
  const modelControl = useModelSelection(skills.modelSelection);
  const goal = skills.goal;
  const descriptorOverride = skills.descriptorOverride;
  const setDescriptorOverride = (value: PromptDescriptor | null) =>
    skills.change({ descriptorOverride: value });
  const descriptor = descriptorOverride ?? suggestPromptDescriptor(goal, locale);
  const type: TaskType = "General";
  const [busy, setBusy] = useState(false);
  const [liveBusy, setLiveBusy] = useState(false);
  const [liveResult, setLiveResult] = useState<LiveGenerationResponse | null>(null);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [savingStatus, setSavingStatus] = useState("");
  const draftVersion = state.versions.find((v) => v.id === state.draft.parentVersionId);
  const liveDraft = /DEEPSEEK|SILICONFLOW|SKILL_LIVE/.test(draftVersion?.source ?? "");
  const generate = async () => {
    if (!goal.trim()) return;
    setBusy(true);
    setSavingStatus(tx(locale, "Saving…", "正在保存……"));
    try {
      const title = goal.trim().slice(0, 56);
      const persistence = await dispatch({
        type: "GENERATE",
        title,
        taskType: type,
        descriptor,
        content: goal.trim(),
      });
      setSavingStatus(
        persistence === "unavailable"
          ? tx(
              locale,
              "Save not confirmed. Check the notice before retrying.",
              "保存尚未确认，请查看提示后再核对。",
            )
          : persistence === "session"
            ? tx(locale, "Kept in this browser session only", "仅保留在浏览器会话")
            : tx(locale, "Saved", "已保存"),
      );
    } finally {
      setBusy(false);
    }
  };
  const receiveGeneration = async (data: TaskResult) => {
    if ("purpose" in data) return;
    setLiveResult(data);
    const snapshotResult = await fetchRemoteSnapshot();
    if (snapshotResult.kind !== "ready") {
      const detail = tx(
        locale,
        "The live Prompt was saved, but the workspace refresh failed. Reload to reconcile it.",
        "真实 Prompt 已保存，但工作区刷新失败。请重新加载以同步。",
      );
      setLiveError(detail);
      setSavingStatus(
        tx(
          locale,
          "Saved; workspace refresh pending. Reload to reconcile.",
          "已保存，工作区同步待完成，请重新加载核对。",
        ),
      );
      await dispatch({ type: "NOTICE", message: detail });
      setLiveBusy(false);
      return;
    }

    const snapshot = snapshotResult.snapshot;
    const prompt = snapshot.prompts.find((item) => item.id === data.promptId);
    const version = snapshot.versions.find(
      (item) => item.id === data.versionId && item.promptId === data.promptId,
    );
    if (!prompt || !version) {
      const detail = tx(
        locale,
        "The saved live Prompt was not found in the refreshed workspace.",
        "刷新工作区后未找到已保存的真实 Prompt。",
      );
      setLiveError(detail);
      setSavingStatus(
        tx(
          locale,
          "Saved response received; workspace reconciliation required.",
          "已收到保存响应，仍需核对工作区记录。",
        ),
      );
      await dispatch({ type: "NOTICE", message: detail });
      setLiveBusy(false);
      return;
    }

    await dispatch({
      type: "HYDRATE",
      saved: {
        prompts: snapshot.prompts,
        versions: snapshot.versions,
        reports: snapshot.reports,
        history: snapshot.history,
        libraryPromptIds: snapshot.libraryPromptIds,
        favorites: snapshot.favorites,
        playgroundRuns: snapshot.playgroundRuns,
        profileName: snapshot.profileName,
        draft: {
          promptId: prompt.id,
          title: prompt.title,
          taskType: prompt.taskType,
          content: version.content,
          descriptor: prompt.descriptor,
          parentVersionId: version.id,
        },
      },
    });
    setLiveResult(data);
    setSavingStatus(tx(locale, "Saved", "已保存"));
    await dispatch({
      type: "NOTICE",
      message: `LIVE · ${data.resolvedModel} · ${data.usage.totalTokens} tokens`,
    });
    setLiveBusy(false);
  };
  const generateLive = async () => {
    if (!goal.trim() || liveBusy || skills.locked || !modelControl.canRun) return;
    setLiveBusy(true);
    setLiveError(null);
    setSavingStatus("");
    try {
      const result = await skills.run({
        goal,
        taskType: type,
        descriptor,
        locale,
        ...modelControl.selection,
      });
      if (result) await receiveGeneration(result);
    } finally {
      setLiveBusy(false);
    }
  };
  return (
    <>
      <Heading eyebrow="PG-05 · P0" title={tx(locale, "Prompt Generator", "Prompt 生成器")} />
      <div className="split generator-layout">
        <section className="panel panel-pad stack writing-form">
          <div className="field">
            <label htmlFor="goal">
              {tx(locale, "What do you want the AI to do?", "你希望 AI 完成什么？")}
            </label>
            <textarea
              id="goal"
              className="textarea"
              value={goal}
              disabled={skills.locked || liveBusy || busy}
              maxLength={10000}
              onChange={(event) => skills.change({ goal: event.target.value })}
              placeholder={tx(
                locale,
                "Example: Create a beginner-friendly three-day study plan…",
                "示例：为初学者制定三天学习计划……",
              )}
            />
          </div>
          {!goal.trim() && !skills.locked && (
            <div
              className="goal-starters"
              aria-label={tx(locale, "Starting ideas", "试试这些任务")}
            >
              {[
                [
                  "Make complex ideas simple",
                  "把复杂概念讲明白",
                  "Help me explain a complex concept with one familiar example.",
                  "帮我用一个熟悉的例子，把复杂概念讲明白。",
                ],
                [
                  "Review my writing",
                  "帮我把文章改好",
                  "Help me improve my writing while preserving my meaning and voice.",
                  "帮我改进文章表达，保留原意和我的语气。",
                ],
                [
                  "Find issues in code",
                  "检查代码中的问题",
                  "Review my code, identify real issues and explain necessary changes.",
                  "检查我的代码，找出真实问题，并说明必要的修改。",
                ],
              ].map(([en, zh, goalEn, goalZh]) => (
                <button
                  key={en}
                  type="button"
                  className="starter-chip"
                  onClick={() => {
                    skills.change({ goal: tx(locale, goalEn, goalZh) });
                    document.getElementById("goal")?.focus();
                  }}
                >
                  {tx(locale, en, zh)}
                </button>
              ))}
            </div>
          )}
          <TaskSkills
            control={skills}
            locale={locale}
            disabled={liveBusy || busy}
            onResult={receiveGeneration}
          />
          <div className="stack" aria-busy={liveBusy}>
            <ModelControls
              control={modelControl}
              locale={locale}
              disabled={busy || liveBusy || skills.locked}
            />
            <div className="between live-model-action">
              <button
                className="btn btn-primary"
                onClick={() => void generateLive()}
                disabled={!goal.trim() || busy || liveBusy || skills.locked || !modelControl.canRun}
              >
                <WandSparkles size={16} />
                {liveBusy
                  ? tx(locale, "Calling model…", "正在调用模型……")
                  : skills.needsReview
                    ? tx(locale, "Confirm stages and generate", "确认阶段计划并生成")
                    : modelControl.model.provider === "deepseek"
                      ? tx(locale, "Generate with DeepSeek · Live", "使用 DeepSeek 真实生成")
                      : tx(
                          locale,
                          `Generate with ${modelControl.model.name} · Live`,
                          `使用 ${modelControl.model.name} 真实生成`,
                        )}
              </button>
            </div>
            {liveError && (
              <p role="alert" className="subtle small" style={{ color: "var(--danger)" }}>
                {liveError}
              </p>
            )}
          </div>
          <details>
            <summary>{tx(locale, "Purposes and tags · optional", "用途与标签 · 可选")}</summary>
            <div className="stack">
              <PromptDescriptorFields
                locale={locale}
                value={descriptor}
                onChange={setDescriptorOverride}
                disabled={busy || liveBusy || skills.locked}
              />
              <button
                className="btn btn-sm"
                disabled={busy || liveBusy || skills.locked}
                onClick={() => setDescriptorOverride(null)}
              >
                {tx(locale, "Suggest from task", "根据需求重新建议")}
              </button>
            </div>
          </details>
          <details>
            <summary>{tx(locale, "Simulation · no model call", "模拟演示 · 不调用模型")}</summary>
            <p className="small subtle">
              {tx(
                locale,
                "Creates a local template draft, not a DeepSeek result. It will not be labeled LIVE.",
                "仅创建本地模板草稿，不是 DeepSeek 生成结果，也不会标记为真实模型输出。",
              )}
            </p>
            <button
              className="btn"
              onClick={generate}
              disabled={!goal.trim() || busy || liveBusy || skills.locked}
            >
              {busy
                ? tx(locale, "Generating…", "正在生成…")
                : tx(locale, "Generate simulated draft", "生成模拟草稿")}
            </button>
          </details>
        </section>
        <Panel
          title={tx(locale, "Draft preview", "草稿预览")}
          note={
            !state.draft.promptId
              ? undefined
              : liveDraft || liveResult?.promptId === state.draft.promptId
                ? draftVersion?.source.startsWith("SILICONFLOW") ||
                  liveResult?.provider === "siliconflow"
                  ? "LIVE · SiliconFlow"
                  : "LIVE · DeepSeek"
                : tx(locale, "Mock / Simulated", "模拟演示")
          }
        >
          <div className="stack">
            {!state.draft.promptId && (
              <div className="draft-placeholder">
                <FileText size={32} aria-hidden="true" />
                <h3>{tx(locale, "Your next starting point", "下一份好用的起点")}</h3>
                <p>
                  {tx(
                    locale,
                    "Describe a task on the left. Your generated Prompt will appear here.",
                    "填写任务后，你的 Prompt 会出现在这里。",
                  )}
                </p>
              </div>
            )}
            {savingStatus && <p role="status">{savingStatus}</p>}
            {skills.result && skills.result.promptId !== state.draft.promptId && (
              <button
                className="btn"
                disabled={skills.locked || liveBusy}
                onClick={() => void receiveGeneration(skills.result!)}
              >
                {tx(locale, "Restore saved task result", "恢复本次已保存结果")}
              </button>
            )}
            {!savingStatus && state.draft.promptId && (
              <p className="small subtle">{tx(locale, "Previous draft", "上次的草稿")}</p>
            )}
            {state.draft.promptId && (
              <>
                <div className="list-row">
                  <div className="list-main">
                    <strong>{state.draft.title}</strong>
                    <PromptMetadata
                      prompt={
                        state.prompts.find((p) => p.id === state.draft.promptId) ?? state.draft
                      }
                      locale={locale}
                    />
                  </div>
                </div>
                <EvidenceDisclosure locale={locale}>
                  {draftVersion?.modelEvidence && (
                    <ModelResultEvidence result={draftVersion.modelEvidence} locale={locale} />
                  )}
                  <p>
                    {state.draft.promptId} · {draftVersion?.id} · {draftVersion?.source}
                  </p>
                  {liveResult?.promptId === state.draft.promptId && (
                    <>
                      {!draftVersion?.modelEvidence && (
                        <ModelResultEvidence result={liveResult} locale={locale} />
                      )}
                      <span className="subtle small">
                        {liveResult.productVersion} · {liveResult.resolvedModel}
                      </span>
                      <span className="subtle small">{liveResult.latencyMs} ms</span>
                      <p>
                        {state.draft.promptId} · {liveResult.versionId}
                      </p>
                    </>
                  )}
                </EvidenceDisclosure>
                {skills.result?.versionId === state.draft.parentVersionId && (
                  <TaskSkillEvidence control={skills} locale={locale} />
                )}
                <ResultActions
                  locale={locale}
                  title={state.draft.title}
                  content={state.draft.content}
                  editHref={route(locale, `app/prompts/${state.draft.promptId}/edit`)}
                />
                <p className="result-body">{state.draft.content}</p>
              </>
            )}
          </div>
        </Panel>
      </div>
      <LegacySkillRecovery userId={accountId} locale={locale} mode={state.mode} />
    </>
  );
}

function Editor({
  locale,
  prompt,
  version,
  onSaving,
}: {
  locale: Locale;
  prompt: Prompt;
  version: PromptVersion;
  onSaving: (saving: boolean) => void;
}) {
  const { state, dispatch } = useAppStore();
  const draftMatches =
    state.draft.promptId === prompt.id && state.draft.parentVersionId === version.id;
  const [title, setTitle] = useState(draftMatches ? state.draft.title : version.title);
  const [content, setContent] = useState(draftMatches ? state.draft.content : version.content);
  const [descriptor, setDescriptor] = useState(() =>
    state.draft.promptId === prompt.id && state.draft.descriptor !== undefined
      ? state.draft.descriptor
      : descriptorForPrompt(prompt),
  );
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveStatus, setSaveStatus] = useState("");
  const savedContent = localizedContentFor(version.id, locale, version.content);
  const changed =
    content !== savedContent ||
    title !== localizedTitleFor(prompt.id, locale, prompt.title) ||
    JSON.stringify(descriptor) !== JSON.stringify(descriptorForPrompt(prompt));
  const editorRouter = useRouter();
  const update = (next: string) => {
    setContent(next);
    setSaveStatus("");
    dispatch({
      type: "SET_DRAFT",
      patch: {
        promptId: prompt.id,
        title,
        taskType: prompt.taskType,
        content: next,
        parentVersionId: version.id,
      },
    });
  };
  return (
    <>
      <Heading eyebrow="PG-06 · P0" title={tx(locale, "Prompt Editor", "Prompt 编辑器")} />
      <PromptContextBar
        locale={locale}
        prompt={prompt}
        version={version}
        active="edit"
        unsaved={changed}
      />
      <CopySource key={prompt.id} promptId={prompt.id} locale={locale} />
      <div className="split editor-layout">
        <div className="panel panel-pad stack">
          <div className="field">
            <label htmlFor="prompt-title">{tx(locale, "Prompt title", "Prompt 标题")}</label>
            <input
              id="prompt-title"
              className="input"
              disabled={saveBusy}
              value={title}
              onChange={(event) => {
                setTitle(event.target.value);
                setSaveStatus("");
                dispatch({ type: "SET_DRAFT", patch: { title: event.target.value } });
              }}
            />
          </div>
          {state.mode === "professional" && (
            <div className="grid two">
              <div className="field">
                <label htmlFor="prompt-role">{tx(locale, "Role", "角色")}</label>
                <input
                  id="prompt-role"
                  className="input"
                  value={tx(
                    locale,
                    prompt.taskType === "Writing" ? "Learning coach" : "Task specialist",
                    prompt.taskType === "Writing" ? "学习辅导" : "任务专家",
                  )}
                  readOnly
                />
              </div>
              <div className="field">
                <label htmlFor="prompt-output-format">
                  {tx(locale, "Output format", "输出格式")}
                </label>
                <input
                  id="prompt-output-format"
                  className="input"
                  value={tx(locale, "Structured sections", "分节结构")}
                  readOnly
                />
              </div>
            </div>
          )}
          <div className="field">
            <label htmlFor="prompt-content">{tx(locale, "Prompt content", "Prompt 内容")}</label>
            <textarea
              id="prompt-content"
              className="textarea editor"
              disabled={saveBusy}
              value={content}
              onChange={(event) => update(event.target.value)}
            />
          </div>
          <div className="between">
            <span className="subtle small" role="status">
              {saveStatus ||
                (changed
                  ? tx(locale, "Unsaved changes", "有未保存更改")
                  : tx(locale, "Saved", "已保存"))}
            </span>
            <button
              className="btn btn-primary"
              disabled={saveBusy}
              onClick={async () => {
                setSaveBusy(true);
                onSaving(true);
                setSaveStatus(tx(locale, "Saving…", "正在保存……"));
                try {
                  const persistence = await dispatch({
                    type: "SAVE_VERSION",
                    promptId: prompt.id,
                    source: "MANUAL_EDIT",
                    title,
                    baseVersionId: prompt.currentVersionId,
                    parentVersionId: version.id,
                    content,
                    descriptor,
                  });
                  if (persistence === "database")
                    editorRouter.replace(route(locale, `app/prompts/${prompt.id}/edit`));
                  else onSaving(false);
                  setSaveStatus(
                    persistence === "unavailable"
                      ? tx(
                          locale,
                          "Save failed or unconfirmed. Draft retained; check the notice.",
                          "保存失败或尚未确认，草稿已保留，请查看提示。",
                        )
                      : persistence === "database-refresh-pending"
                        ? tx(
                            locale,
                            "Save sent; reload to confirm the saved version.",
                            "保存请求已发送，请刷新核对新版本。",
                          )
                        : persistence === "session"
                          ? tx(locale, "Kept in this browser session only", "仅保留在浏览器会话")
                          : tx(locale, "Saved as a new version", "已保存为新版本"),
                  );
                } finally {
                  setSaveBusy(false);
                }
              }}
            >
              <Save size={15} />
              {tx(locale, "Save new version", "保存为新版本")}
            </button>
            <button
              className="btn"
              onClick={() => dispatch({ type: "SAVE_TO_LIBRARY", promptId: prompt.id })}
            >
              <BookOpen size={15} />
              {tx(locale, "Save to Library", "保存到 Prompt 库")}
            </button>
          </div>
          <ResultActions locale={locale} content={content} title={title} />
          <details>
            <summary>{tx(locale, "Purposes and tags · optional", "用途与标签 · 可选")}</summary>
            <div className="stack">
              <PromptDescriptorFields
                locale={locale}
                value={descriptor}
                disabled={saveBusy}
                onChange={(next) => {
                  setDescriptor(next);
                  setSaveStatus("");
                  void dispatch({ type: "SET_DRAFT", patch: { descriptor: next } });
                }}
              />
              <button
                type="button"
                className="btn btn-sm"
                disabled={saveBusy}
                onClick={() => {
                  const next = suggestPromptDescriptor(content, locale);
                  setDescriptor(next);
                  setSaveStatus("");
                  void dispatch({ type: "SET_DRAFT", patch: { descriptor: next } });
                }}
              >
                {tx(locale, "Suggest from content", "根据正文重新建议")}
              </button>
            </div>
          </details>
        </div>
        <div className="stack">
          <details className="editor-context" open={state.mode === "professional"}>
            <summary>
              {tx(locale, "Version history", "版本历史")}{" "}
              <span className="badge">v{version.number}</span>
            </summary>
            <VersionList promptId={prompt.id} locale={locale} limit={8} />
            <Link className="text-link" href={route(locale, "app/history")}>
              {tx(locale, "Compare versions", "比较版本")}
            </Link>
          </details>
          <SkillProvenancePanel key={version.id} locale={locale} versionId={version.id} />
        </div>
      </div>
    </>
  );
}

function Evaluator({
  locale,
  prompt,
  version,
  report,
}: {
  locale: Locale;
  prompt: Prompt;
  version: PromptVersion;
  report?: EvaluationReport;
}) {
  const { state, dispatch } = useAppStore();
  const [selectedReportId, setSelectedReportId] = useState("");
  const [selectedAdvice, setSelectedAdvice] = useState<{
    modelKey?: string;
    strength?: string;
    id: string;
  } | null>(null);
  const modelControl = useModelSelection();
  const [adviceBusy, setAdviceBusy] = useState(false);
  const [adviceError, setAdviceError] = useState<string | null>(null);
  const versionReports = state.reports.filter(
    (item) => item.versionId === version.id && item.promptId === prompt.id,
  );
  const stale =
    state.draft.parentVersionId === version.id && state.draft.content !== version.content;
  const currentReport = stale
    ? undefined
    : (versionReports.find((item) => item.id === selectedReportId) ?? report);
  const humanCalibration = currentReport?.source === "LOCAL_HUMAN_CALIBRATION";
  const adviceHistory = adviceHistoryForVersion(state.liveAdvice, prompt.id, version.id);
  const explicitlySelected =
    selectedAdvice?.modelKey === modelControl.selection.modelKey &&
    selectedAdvice?.strength === modelControl.selection.strength
      ? adviceHistory.find((item) => item.executionId === selectedAdvice?.id)
      : undefined;
  const advice = stale
    ? undefined
    : (explicitlySelected ??
      adviceHistory.find((item) => adviceMatchesSelection(item, modelControl.selection)));
  const execution = executionEvidenceFor(state.playgroundRuns, version.id);
  const runLiveAdvice = async () => {
    if (stale || adviceBusy || !modelControl.canRun) return;
    setAdviceBusy(true);
    setAdviceError(null);
    const result = await generateLiveEvaluationAdvice({
      ...modelControl.selection,
      promptId: prompt.id,
      versionId: version.id,
      locale,
    });
    if (result.kind === "unavailable") {
      const detail = modelErrorDetail(result, locale);
      setAdviceError(detail);
      await dispatch({ type: "NOTICE", message: detail });
      setAdviceBusy(false);
      return;
    }
    await dispatch({
      type: "HYDRATE",
      saved: {
        liveAdvice: [
          toLiveAdvice(result.data),
          ...state.liveAdvice.filter((item) => item.executionId !== result.data.executionId),
        ],
      },
    });
    setSelectedAdvice({ ...modelControl.selection, id: result.data.executionId });
    await dispatch({
      type: "NOTICE",
      message: `LIVE evaluation advice ready · ${result.data.usage.totalTokens} tokens · no scores changed`,
    });
    setAdviceBusy(false);
  };
  return (
    <>
      <Heading
        eyebrow="PG-07 · P0"
        title={tx(locale, "Prompt Evaluator", "Prompt 评估器")}
        description={`${localizedTitleFor(prompt.id, locale, prompt.title)} · ${promptPurposeLabel(prompt, locale)} · v${version.number}`}
        actions={
          <>
            <Link className="btn" href={route(locale, `app/prompts/${prompt.id}/optimize`)}>
              <WandSparkles size={15} />
              {tx(locale, "Optimize", "优化")}
            </Link>
          </>
        }
      />
      <PromptContextBar locale={locale} prompt={prompt} version={version} active="evaluate" />
      <ModelEvaluationPanel
        key={`${version.id}:${locale}`}
        locale={locale}
        prompt={prompt}
        version={version}
        disabled={stale}
      />
      <details className="workflow-option advice-option">
        <summary>{tx(locale, "Additional model advice", "补充模型建议")}</summary>
        <ArchitectureNote
          locale={locale}
          title={tx(locale, "Skill Advisory is separate", "Skill 建议与正式评估分离")}
        >
          <div className="between">
            <span>
              {tx(
                locale,
                "No related Skill advice is configured. Models can provide separate qualitative advice, but it never changes Layer 1, Layer 2, or Layer 3 scores and evidence.",
                "当前没有关联 Skill 建议。模型可提供独立的定性建议，但绝不修改 Layer 1、Layer 2、Layer 3 的分数和证据。",
              )}
            </span>
          </div>
        </ArchitectureNote>
        <div className="panel panel-pad stack" aria-busy={adviceBusy}>
          <p>
            {tx(
              locale,
              "Request evidence-based strengths, risks, prioritized edits and acceptance checks for this saved version. This is qualitative advice, not a formal score; live requests may incur fees.",
              "针对当前已保存版本获取有原文依据的优点、风险、优先修改项与验收建议。仅提供定性分析，不生成正式分数；真实调用可能收费。",
            )}
          </p>
          <ModelControls control={modelControl} locale={locale} disabled={adviceBusy} />
          <button
            className="btn"
            disabled={stale || adviceBusy || !modelControl.canRun}
            onClick={() => void runLiveAdvice()}
          >
            <Sparkles size={14} aria-hidden="true" />
            {adviceBusy
              ? tx(locale, "Calling model…", "正在调用模型……")
              : modelControl.model.provider === "deepseek"
                ? tx(locale, "Get DeepSeek advice · Live", "获取 DeepSeek 真实建议")
                : tx(
                    locale,
                    `Get ${modelControl.model.name} advice · Live`,
                    `获取 ${modelControl.model.name} 真实建议`,
                  )}
          </button>
        </div>
        {adviceError && (
          <p role="alert" className="small" style={{ color: "var(--danger)", marginBottom: 18 }}>
            {adviceError}
          </p>
        )}
        {adviceHistory.length > 0 && (
          <div className="panel panel-pad stack">
            <label htmlFor="evaluation-advice-history">
              {tx(locale, "Advice history for this version", "此版本的模型建议历史")}
            </label>
            <select
              id="evaluation-advice-history"
              className="select"
              disabled={stale || adviceBusy}
              value={explicitlySelected?.executionId ?? ""}
              onChange={(event) =>
                setSelectedAdvice({ ...modelControl.selection, id: event.target.value })
              }
            >
              <option value="">
                {tx(
                  locale,
                  "Latest advice for selected model and strength",
                  "所选模型与强度的最新建议",
                )}
              </option>
              {adviceHistory.map((item) => (
                <option key={item.executionId} value={item.executionId}>
                  {item.provider} · {item.productVersion} ·{" "}
                  {item.strength ?? tx(locale, "strength not recorded", "强度未记录")} ·{" "}
                  {item.createdAt}
                </option>
              ))}
            </select>
            <p className="small subtle">
              {tx(
                locale,
                "Switching models does not issue a request or relabel historical advice. History remains tied to the original provider, strength and saved version.",
                "切换模型不会发起请求，也不会改变历史建议的来源。历史记录始终绑定原供应商、强度和已保存版本。",
              )}
            </p>
          </div>
        )}
        {!stale && !advice && (
          <p className="small subtle" role="status">
            {tx(
              locale,
              "No advice for the selected model and strength on this version. Request it explicitly or choose a historical result.",
              "此版本暂无所选模型与强度的建议，请主动获取或选择历史结果。",
            )}
          </p>
        )}
        {advice && (
          <Panel
            title={tx(locale, "Live model advice", "真实模型建议")}
            note={`LIVE · ${advice.productVersion} · ${advice.usage.totalTokens} tokens`}
          >
            {!adviceMatchesSelection(advice, modelControl.selection) && (
              <p className="small subtle">
                {tx(
                  locale,
                  "Historical result: its model or strength differs from the current request settings.",
                  "正在查看历史结果，其模型或强度与当前请求设置不同。",
                )}
              </p>
            )}
            <EvidenceDisclosure locale={locale}>
              <ModelResultEvidence result={advice} locale={locale} />
            </EvidenceDisclosure>
            <p className="small" style={{ whiteSpace: "pre-wrap" }}>
              {advice.content}
            </p>
            <ResultActions
              locale={locale}
              title={tx(locale, "Evaluation advice", "评估建议")}
              content={advice.content}
            />
            <p className="small subtle" style={{ marginTop: 10 }}>
              {tx(
                locale,
                "Qualitative advisory only. No Layer score, grade, rubric result, or formal report was modified.",
                "仅为定性建议；未修改任何评估层分数、等级、Rubric 结果或正式报告。",
              )}
            </p>
          </Panel>
        )}
      </details>
      <details className="workflow-option calibration-option">
        <summary>
          {tx(locale, "Local diagnostics and sample evaluation", "本地检查与示例评估")}
        </summary>
        <PromptDiagnostics version={version} locale={locale} />
        {stale && (
          <p className="small subtle">
            {tx(
              locale,
              "Diagnostics above describe the saved version, not your unsaved draft.",
              "上方诊断针对已保存版本，不代表尚未保存的草稿。",
            )}
          </p>
        )}
        <button
          className="btn"
          disabled={stale}
          onClick={() => dispatch({ type: "EVALUATE", promptId: prompt.id, versionId: version.id })}
        >
          <Activity size={15} aria-hidden="true" />
          {tx(locale, "Run mock evaluation", "运行模拟评估")}
        </button>
        {currentReport && (
          <div className="notice">
            <Sparkles size={17} />
            <div>
              <strong>
                {humanCalibration
                  ? tx(locale, "Local human calibration · candidate", "本地人工校准 · 候选")
                  : tx(locale, "Mock / Simulated evaluation", "模拟评估结果")}
              </strong>
              <p className="small">
                {localizedRubric(currentReport.rubricVersion, locale)}.{" "}
                {humanCalibration
                  ? tx(
                      locale,
                      "Human judgments; experimental aggregation. Grade mapping is pending; no AI call.",
                      "人工判断与实验性聚合。等级映射待确认；未调用 AI。",
                    )
                  : tx(
                      locale,
                      "No formal evaluation engine is running.",
                      "当前未运行正式评估引擎。",
                    )}
              </p>
            </div>
          </div>
        )}
        {versionReports.length > 0 && (
          <div className="panel panel-pad" style={{ marginBottom: 18 }}>
            <label htmlFor="evaluation-report-history">
              {tx(locale, "Report history for this version", "此版本的报告历史")}
            </label>
            <select
              className="select"
              id="evaluation-report-history"
              value={currentReport?.id ?? ""}
              disabled={stale}
              onChange={(e) => setSelectedReportId(e.target.value)}
            >
              {versionReports.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.source === "LOCAL_HUMAN_CALIBRATION"
                    ? tx(locale, "Human candidate", "人工候选")
                    : tx(locale, "Mock", "模拟")}{" "}
                  · {item.createdAt} · {item.id}
                </option>
              ))}
            </select>
            <p className="small subtle">
              {tx(
                locale,
                "Reports are immutable snapshots. Rerunning creates a new report and does not recalculate history.",
                "报告为独立快照，重新评估创建新报告，不重算或覆盖历史。",
              )}
            </p>
          </div>
        )}
        {stale && (
          <div className="notice">
            <CircleAlert size={17} />
            <p className="small">
              {tx(
                locale,
                "Unsaved draft differs from the evaluated version. Save it as a new version before evaluating.",
                "未保存草稿与已评估版本不同。请先另存为新版本后再评估。",
              )}
            </p>
          </div>
        )}
        <div className="grid three">
          <LayerCard
            layer="Layer 1"
            name={tx(locale, "General Prompt Quality", "通用 Prompt 质量")}
            data={currentReport?.layer1}
            defaultState="INSUFFICIENT_INFORMATION"
            locale={locale}
          />
          <LayerCard
            layer="Layer 2"
            name={tx(locale, "Task-Specific Quality", "任务专项质量")}
            data={currentReport?.layer2}
            defaultState={
              prompt.taskType === "General"
                ? "NOT_AVAILABLE"
                : ["Data Analysis", "Business", "Research", "AI Agent"].includes(prompt.taskType)
                  ? "PENDING REVIEW"
                  : "NOT_VERIFIED"
            }
            locale={locale}
          />
          <LayerCard
            layer="Layer 3"
            name={tx(locale, "Current execution evidence", "当前执行证据")}
            data={
              stale
                ? undefined
                : {
                    status:
                      execution.status === "EXECUTED_UNGRADED"
                        ? "EXECUTED · UNGRADED"
                        : "NOT_EXECUTED",
                    score: null,
                    grade: null,
                    dimensions: [],
                  }
            }
            defaultState="NOT_EXECUTED"
            locale={locale}
          />
        </div>
        {!stale && execution.run && (
          <p className="small subtle">
            {tx(
              locale,
              "Real execution exists for this exact version; Layer 3 remains ungraded. Historical report snapshots are unchanged.",
              "当前精确版本已有真实执行证据，Layer 3 仍未评分；历史报告快照不变。",
            )}{" "}
            <Link href={route(locale, "app/execution-evaluation")}>
              {tx(locale, "Open execution report", "查看执行报告")}
            </Link>
          </p>
        )}
        <div className="grid two" style={{ marginTop: 18 }}>
          <Panel
            title={tx(locale, "Dimensions and evidence", "维度与证据")}
            note={tx(
              locale,
              "Evidence is tied to this exact Prompt version.",
              "证据绑定当前 Prompt 版本。",
            )}
          >
            {currentReport ? (
              <div>
                <div className="version-item" style={{ marginBottom: 14 }}>
                  <div className="between">
                    <strong>{tx(locale, "Source excerpt", "来源摘录")}</strong>
                    <StateBadge>
                      {humanCalibration
                        ? tx(locale, "Human candidate", "人工候选")
                        : tx(locale, "Mock / Simulated", "模拟演示")}
                    </StateBadge>
                  </div>
                  <p className="small subtle" style={{ marginTop: 6 }}>
                    {tx(
                      locale,
                      `Exact text from ${version.id}; the report is bound to this version.`,
                      `摘录自 ${version.id} 的原文；本报告绑定此版本。`,
                    )}
                  </p>
                  <blockquote style={{ margin: "10px 0 0", whiteSpace: "pre-wrap" }}>
                    “
                    {(humanCalibration
                      ? version.content
                      : localizedContentFor(version.id, locale, version.content)
                    ).slice(0, 240)}
                    {(humanCalibration
                      ? version.content
                      : localizedContentFor(version.id, locale, version.content)
                    ).length > 240
                      ? "…"
                      : ""}
                    ”
                  </blockquote>
                </div>
                {[...currentReport.layer1.dimensions, ...currentReport.layer2.dimensions].map(
                  (dimension, index) => (
                    <div className="score-row" key={`${dimension.name}-${index}`}>
                      <span>
                        {candidateLayer2[prompt.taskType]?.find((d) => d.name.en === dimension.name)
                          ?.name[locale] ?? localizedDimensionName(dimension.name, locale)}
                        <small className="subtle" style={{ display: "block" }}>
                          {localizedEvaluationStatus(dimension.state, locale)}
                        </small>
                        <small className="subtle" style={{ display: "block", marginTop: 4 }}>
                          {humanCalibration
                            ? tx(
                                locale,
                                "Candidate result; inspect the indicator evidence snapshot below. Layer 2 remains unscored.",
                                "候选结果，请查看下方指标证据快照；Layer 2 仍不出分。",
                              )
                            : localizedReason(dimension.reason, locale)}
                        </small>
                      </span>
                      {dimension.score === null ? (
                        <span className="subtle small">{tx(locale, "No score", "无分数")}</span>
                      ) : (
                        <div className="meter">
                          <span style={{ width: `${dimension.score}%` }} />
                        </div>
                      )}
                      <strong>
                        {dimension.score === null
                          ? "—"
                          : humanCalibration
                            ? dimension.score.toFixed(2)
                            : dimension.score}
                      </strong>
                    </div>
                  ),
                )}
              </div>
            ) : (
              <Empty
                title={tx(locale, "No report for this version", "此版本暂无报告")}
                detail={tx(
                  locale,
                  "Run a mock evaluation to create a report bound to this version.",
                  "运行模拟评估，创建绑定此版本的报告。",
                )}
              />
            )}
          </Panel>
          <Panel title={tx(locale, "Scoring boundaries", "评分边界")}>
            <ul className="stack small subtle" style={{ paddingLeft: 18 }}>
              <li>
                {tx(
                  locale,
                  "Layers are independent; there is no combined score.",
                  "评估层相互独立，不生成综合分数。",
                )}
              </li>
              <li>
                {tx(
                  locale,
                  "General Layer 2 is NOT_AVAILABLE with null score and no dimensions.",
                  "通用分类的 Layer 2 状态为“不提供”（NOT_AVAILABLE），分数为空且无维度。",
                )}
              </li>
              <li>
                {tx(
                  locale,
                  "Layer 3 is NOT_EXECUTED without real model output.",
                  "没有真实模型输出时，Layer 3 状态为“未执行”（NOT_EXECUTED）。",
                )}
              </li>
              <li>
                {tx(
                  locale,
                  "Data Analysis, Business, Research, and AI Agent rules remain pending review.",
                  "数据分析、商业、研究和 AI Agent 规则仍待审核。",
                )}
              </li>
            </ul>
            <div className="stack" style={{ marginTop: 16 }}>
              {[
                [
                  "N/A",
                  tx(
                    locale,
                    "Applicable only when the criterion truly does not apply.",
                    "仅在该指标确实不适用时使用。",
                  ),
                ],
                [
                  "INSUFFICIENT_INFORMATION",
                  tx(
                    locale,
                    "The criterion applies, but evidence is missing.",
                    "指标适用，但缺少判断所需证据。",
                  ),
                ],
                [
                  "NOT_VERIFIED",
                  tx(
                    locale,
                    "A claim or outcome has not been checked.",
                    "某项主张或结果尚未核验。",
                  ),
                ],
                [
                  "NOT_AVAILABLE",
                  tx(
                    locale,
                    "No Layer 2 exists for the General fallback.",
                    "通用兜底分类没有 Layer 2 专项评分。",
                  ),
                ],
                [
                  "NOT_EXECUTED",
                  tx(
                    locale,
                    "No real model output is available for Layer 3.",
                    "没有真实模型输出可供 Layer 3 评估。",
                  ),
                ],
                [
                  "PERMISSION_LIMITED",
                  tx(
                    locale,
                    "A demo-only access view; commercial rules remain TBD.",
                    "仅为演示访问状态，商业规则仍待确认。",
                  ),
                ],
                [
                  "MOCK / SIMULATED",
                  tx(
                    locale,
                    "Pre-authored prototype data; never real execution evidence.",
                    "预制原型数据，绝非真实执行证据。",
                  ),
                ],
              ].map(([status, explanation]) => (
                <div className="between version-item evaluation-state-row" key={status}>
                  <StateBadge tone={status === "MOCK / SIMULATED" ? "blue" : "amber"}>
                    {localizedEvaluationStatus(String(status), locale)}
                  </StateBadge>
                  <span className="small subtle">{explanation}</span>
                </div>
              ))}
            </div>
          </Panel>
        </div>
        {currentReport && <CalibrationEvidence report={currentReport} locale={locale} />}
        <CalibrationPanel
          key={`${prompt.id}:${version.id}`}
          locale={locale}
          prompt={prompt}
          version={version}
          disabled={stale}
        />
      </details>
    </>
  );
}

function LayerCard({
  layer,
  name,
  data,
  defaultState,
  locale,
}: {
  layer: string;
  name: string;
  data?: EvaluationReport["layer1"];
  defaultState: string;
  locale: Locale;
}) {
  const value = data?.status ?? defaultState;
  const score = data?.score ?? null;
  const tone =
    value === "NOT_EXECUTED" || value === "NOT_AVAILABLE"
      ? "amber"
      : value.includes("MOCK")
        ? "blue"
        : "";
  return (
    <section className="panel panel-pad">
      <div className="between">
        <div>
          <div className="eyebrow">{layer}</div>
          <h2 style={{ marginTop: 5 }}>{name}</h2>
        </div>
        <Layers3 size={18} color="#64748b" />
      </div>
      <div style={{ margin: "18px 0 12px" }}>
        <StateBadge tone={tone}>{localizedEvaluationStatus(value, locale)}</StateBadge>
      </div>
      <div className="stat-value" style={{ fontSize: 28 }}>
        {score === null ? "—" : score.toFixed(2)}
      </div>
      <p className="small subtle" style={{ marginTop: 8 }}>
        {value === "EXECUTED · UNGRADED"
          ? tx(
              locale,
              "Real execution evidence exists; no approved Layer 3 rubric. score = null · grade = null.",
              "已有真实执行证据；Layer 3 Rubric 尚未批准。score = null · grade = null。",
            )
          : value === "NOT_EXECUTED"
            ? tx(locale, "No real model output is available.", "没有真实模型输出。")
            : value === "NOT_AVAILABLE"
              ? tx(
                  locale,
                  "General is the fallback category; no Layer 2 score runs.",
                  "General 为兜底分类，不运行 Layer 2 专项评分。",
                )
              : value === "PENDING REVIEW"
                ? tx(
                    locale,
                    "Candidate rubric is not an approved scoring configuration.",
                    "候选 Rubric 尚未获批为评分配置。",
                  )
                : value === "CANDIDATE_SCORED"
                  ? tx(
                      locale,
                      "Candidate arithmetic only; grade = null. Not a validated production score.",
                      "仅候选算术结果；grade = null。不是已验证生产分数。",
                    )
                  : value === "INSUFFICIENT_INFORMATION"
                    ? tx(
                        locale,
                        "Applicable evidence is missing; known dimensions remain visible. No partial total is issued.",
                        "缺少适用证据；保留可靠维度，不生成部分总分。",
                      )
                    : value === "NOT_VERIFIED"
                      ? tx(
                          locale,
                          "Required verification is pending; no score is inferred.",
                          "必要核验待完成；不推断分数。",
                        )
                      : value === "NOT_APPLICABLE"
                        ? tx(
                            locale,
                            "No applicable responsibilities; no numeric score.",
                            "没有适用职责；不提供数值分。",
                          )
                        : tx(
                            locale,
                            "Scores shown in a fixture are illustrative only.",
                            "Fixture 中的分数仅用于演示。",
                          )}
      </p>
    </section>
  );
}

function Optimizer({
  locale,
  prompt,
  version,
}: {
  locale: Locale;
  prompt: Prompt;
  version: PromptVersion;
}) {
  const { state, dispatch, accountId } = useAppStore();
  const search = useSearchParams();
  const reportId = search.get("reportId");
  let evaluationHandoff: import("@/lib/evaluation-handoff").EvaluationHandoff | undefined;
  try {
    if (reportId)
      evaluationHandoff = parseEvaluationHandoff({
        reportId,
        indexes: (search.get("suggestions") ?? "").split(",").filter(Boolean).map(Number),
      });
  } catch {
    /* Invalid identities never become trusted review text. */
  }
  const sourceReport = state.liveAdvice.find(
    (r) =>
      r.executionId === evaluationHandoff?.reportId &&
      r.promptId === prompt.id &&
      r.versionId === version.id &&
      r.kind === "EVALUATION_REPORT",
  );
  const validHandoff =
    !!sourceReport?.evaluation &&
    !!evaluationHandoff &&
    evaluationHandoff.indexes.every((i) => sourceReport.evaluation!.suggestions[i]);
  const skills = useTaskSkills(accountId, `optimize:${version.id}`);
  const [selected, setSelected] = useState<string[]>([]);
  const modelControl = useModelSelection(skills.modelSelection);
  const [liveBusy, setLiveBusy] = useState(false);
  const [liveResult, setLiveResult] = useState<LiveSourceResponse | null>(() =>
    skills.result && "purpose" in skills.result ? skills.result : null,
  );
  const [liveError, setLiveError] = useState<string | null>(null);
  const content = version.content;
  const optimized = selected.length
    ? `${content}\n\nAdditional clarity\n${suggestions
        .filter((item) => selected.includes(item.id))
        .map((item) => item.after)
        .join(". ")}.`
    : content;
  const receiveOptimization = async (data: TaskResult) => {
    if (!("purpose" in data) || data.purpose !== "OPTIMIZATION") return;
    setLiveResult(data);
    await dispatch({
      type: "NOTICE",
      message: `LIVE optimization ready · ${data.usage.totalTokens} tokens · source version unchanged`,
    });
    setLiveBusy(false);
  };
  const runLiveOptimization = async () => {
    if (liveBusy || skills.locked || !modelControl.canRun || (reportId && !validHandoff)) return;
    setLiveBusy(true);
    setLiveError(null);
    try {
      const result = await skills.run({
        goal: version.content,
        ...(validHandoff ? { evaluationHandoff } : {}),
        taskType: prompt.taskType,
        locale,
        source: { promptId: prompt.id, versionId: version.id, taskType: prompt.taskType },
        ...modelControl.selection,
      });
      if (result) await receiveOptimization(result);
    } finally {
      setLiveBusy(false);
    }
  };
  return (
    <>
      <Heading eyebrow="PG-08 · P0" title={tx(locale, "Prompt Optimizer", "Prompt 优化器")} />
      <PromptContextBar locale={locale} prompt={prompt} version={version} active="optimize" />
      {reportId && (
        <div className="evaluation-handoff panel panel-pad" role="status">
          <h2>{tx(locale, "Selected review suggestions", "本次采用的评估建议")}</h2>
          {validHandoff ? (
            <ul>
              {evaluationHandoff!.indexes.map((i) => (
                <li key={i}>{sourceReport!.evaluation!.suggestions[i].issue}</li>
              ))}
            </ul>
          ) : (
            <p>
              {tx(
                locale,
                "This report does not match the saved version. Return to the report to select suggestions again.",
                "这份报告与当前版本不匹配，请返回报告重新选择建议。",
              )}
            </p>
          )}
        </div>
      )}
      <div className="panel panel-pad" style={{ marginBottom: 18 }}>
        <TaskSkills
          control={skills}
          locale={locale}
          disabled={liveBusy}
          onResult={receiveOptimization}
          taskReturn={`/${locale}/app/prompts/${prompt.id}/optimize`}
        />
        <ModelControls
          control={modelControl}
          locale={locale}
          disabled={liveBusy || skills.locked}
        />
        <div className="between live-model-action">
          <button
            className="btn btn-primary"
            onClick={() => void runLiveOptimization()}
            disabled={
              liveBusy || skills.locked || !modelControl.canRun || (!!reportId && !validHandoff)
            }
          >
            <WandSparkles size={15} />
            {liveBusy
              ? tx(locale, "Calling model…", "正在调用模型……")
              : skills.needsReview
                ? tx(locale, "Confirm stages and optimize", "确认阶段计划并优化")
                : modelControl.model.provider === "deepseek"
                  ? tx(locale, "Optimize with DeepSeek · Live", "使用 DeepSeek 真实优化")
                  : tx(
                      locale,
                      `Optimize with ${modelControl.model.name} · Live`,
                      `使用 ${modelControl.model.name} 真实优化`,
                    )}
          </button>
        </div>
        {liveError && (
          <p className="small" role="alert" style={{ color: "var(--danger)", marginTop: 10 }}>
            {liveError}
          </p>
        )}
        {liveResult && (
          <div className="stack" style={{ marginTop: 14 }}>
            <p role="status">
              {liveResult.content === version.content
                ? tx(
                    locale,
                    "The current expression is already clear. No new version is needed; model usage is recorded.",
                    "当前表达已足够清楚，无需创建新版本；本次模型用量已记录。",
                  )
                : tx(
                    locale,
                    "Proposal ready. Copy it or save a new version to continue editing; the source is unchanged.",
                    "提案已就绪。可以复制使用，或另存新版本后继续编辑；来源版本未改变。",
                  )}
            </p>
            {liveResult.content !== version.content && (
              <details>
                <summary>{tx(locale, "Review body changes", "查看正文改动")}</summary>
                <PromptDiff before={version.content} after={liveResult.content} locale={locale} />
              </details>
            )}
            <EvidenceDisclosure locale={locale}>
              <ModelResultEvidence result={liveResult} locale={locale} />
              <span className="small subtle">
                {liveResult.resolvedModel} · {liveResult.usage.totalTokens} tokens ·{" "}
                {liveResult.latencyMs} ms
              </span>
            </EvidenceDisclosure>
            <TaskSkillEvidence control={skills} locale={locale} />
            <p className="small" style={{ whiteSpace: "pre-wrap" }}>
              {liveResult.content}
            </p>
            <ResultActions locale={locale} title={prompt.title} content={liveResult.content} />
            <button
              className="btn btn-primary"
              disabled={liveResult.content === version.content}
              onClick={() =>
                void dispatch({
                  type: "SAVE_VERSION",
                  promptId: prompt.id,
                  source: liveSource(liveResult.provider, "OPTIMIZATION"),
                  optimizationId: liveResult.optimizationId,
                  title: version.title,
                  baseVersionId: version.id,
                  parentVersionId: version.id,
                  content: liveResult.content,
                })
              }
            >
              <Save size={15} />
              {tx(locale, "Save live proposal as new version", "将真实优化结果另存为新版本")}
            </button>
          </div>
        )}
      </div>
      <LegacySkillRecovery
        userId={accountId}
        locale={locale}
        mode={state.mode}
        source={{ promptId: prompt.id, versionId: version.id, taskType: prompt.taskType }}
      />
      <details className="workflow-option simulation-option">
        <summary>
          {tx(locale, "Try sample suggestions · no model call", "体验示例建议 · 不调用模型")}
        </summary>
        <p className="subtle">
          {tx(
            locale,
            "Preset examples; save selected edits as a new version.",
            "预置演示示例，选中的修改将另存为新版本。",
          )}
        </p>
        <div className="split">
          <div className="stack">
            {suggestions.map((item) => {
              const suggestionCopy =
                locale === "zh-CN"
                  ? item.id === "opt_writing_course_01"
                    ? {
                        title: "补充完整示例",
                        rationale: "具体示例有助于初学者将课程内容迁移到实际练习中。",
                        before: "引导式练习",
                        after: "完整示例，随后安排引导式练习",
                      }
                    : {
                        title: "明确输出顺序",
                        rationale: "固定的输出顺序有助于检查和复用结果。",
                        before: "提供课程和练习",
                        after: "依次提供课程、完整示例、练习和反思",
                      }
                  : item;
              return (
                <label
                  className="panel panel-pad"
                  key={item.id}
                  style={{ display: "flex", gap: 12, cursor: "pointer" }}
                >
                  <input
                    type="checkbox"
                    checked={selected.includes(item.id)}
                    onChange={(event) =>
                      setSelected(
                        event.target.checked
                          ? [...selected, item.id]
                          : selected.filter((id) => id !== item.id),
                      )
                    }
                  />
                  <div>
                    <div className="row">
                      <Lightbulb size={16} color="#b45309" />
                      <strong>{suggestionCopy.title}</strong>
                    </div>
                    <p className="subtle small" style={{ marginTop: 6 }}>
                      {suggestionCopy.rationale}
                    </p>
                    <p className="small" style={{ marginTop: 8 }}>
                      <span className="subtle">{suggestionCopy.before}</span>{" "}
                      <ArrowRight size={12} /> {suggestionCopy.after}
                    </p>
                  </div>
                </label>
              );
            })}
            <button
              className="btn btn-primary"
              disabled={!selected.length}
              onClick={async () => {
                const optimizedCopy = optimized;
                const source = locale === "zh-CN" ? "已优化 · 模拟演示" : "Optimized · simulated";
                const persistence = await dispatch({
                  type: "OPTIMIZE",
                  promptId: prompt.id,
                  content: optimizedCopy,
                });
                if (persistence === "unavailable") return;
                await dispatch({
                  type: "SAVE_VERSION",
                  promptId: prompt.id,
                  source,
                  title: version.title,
                  baseVersionId: prompt.currentVersionId,
                  parentVersionId: version.id,
                  content: optimizedCopy,
                });
              }}
            >
              {tx(locale, "Apply and save as new version", "应用并保存为新版本")}{" "}
              <ArrowRight size={15} />
            </button>
          </div>
          <Panel
            title={tx(locale, "Preview", "预览")}
            note={`${localizedTitleFor(prompt.id, locale, prompt.title)} · v${version.number} → ${tx(locale, "next version", "新版本")}`}
          >
            <div className="stack">
              <div>
                <div className="eyebrow">{tx(locale, "CURRENT", "当前版本")}</div>
                <p className="small" style={{ whiteSpace: "pre-wrap", marginTop: 7 }}>
                  {content}
                </p>
              </div>
              <div>
                <div className="eyebrow">{tx(locale, "PROPOSED · MOCK", "建议内容 · 模拟")}</div>
                <p className="small" style={{ whiteSpace: "pre-wrap", marginTop: 7 }}>
                  {optimized}
                </p>
                <ResultActions
                  locale={locale}
                  title={prompt.title}
                  content={optimized}
                  editHref={promptActionHref(locale, prompt.id, version.id, "edit")}
                  onEdit={() => {
                    void dispatch({
                      type: "SET_DRAFT",
                      patch: {
                        promptId: prompt.id,
                        title: prompt.title,
                        taskType: prompt.taskType,
                        parentVersionId: version.id,
                        content: optimized,
                        descriptor: prompt.descriptor,
                      },
                    });
                  }}
                />
              </div>
            </div>
          </Panel>
        </div>
      </details>
    </>
  );
}

function LibraryPage({ locale }: { locale: Locale }) {
  const { state } = useAppStore();
  const [query, setQuery] = useState("");
  const [type, setType] = useState("All");
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const listed = state.prompts
    .filter((item) => state.libraryPromptIds.includes(item.id))
    .filter(
      (item) =>
        item.title.toLowerCase().includes(query.toLowerCase()) ||
        item.description.toLowerCase().includes(query.toLowerCase()) ||
        promptDiscoveryTerms(item).some((term) => term.toLowerCase().includes(query.toLowerCase())),
    )
    .filter(
      (item) =>
        type === "All" ||
        (type === "uncategorized"
          ? descriptorForPrompt(item).purposes.length === 0
          : descriptorForPrompt(item).purposes.includes(
              type as import("@/lib/prompt-description").PurposeId,
            )),
    )
    .filter((item) => !favoritesOnly || state.favorites.includes(item.id));
  return (
    <>
      <Heading
        eyebrow="PG-09 · P0"
        title={tx(locale, "Prompt Library", "Prompt 库")}

        actions={
          <Link className="btn btn-primary" href={route(locale, "app/generate")}>
            <Plus size={15} />
            {tx(locale, "Create prompt", "创建 Prompt")}
          </Link>
        }
      />
      <div className="panel panel-pad">
        <div className="grid three library-filter-grid">
          <div className="field">
            <label htmlFor="library-search">{tx(locale, "Search prompts", "搜索 Prompt")}</label>
            <div className="topbar-search library-search" style={{ maxWidth: "none" }}>
              <Search size={15} aria-hidden="true" />
              <input
                id="library-search"
                aria-label={tx(locale, "Search prompts", "搜索 Prompt")}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={tx(
                  locale,
                  "Search title, description or tags",
                  "搜索标题、说明或标签",
                )}
                style={{ border: 0, outline: 0, background: "transparent", width: "100%" }}
              />
            </div>
          </div>
          <div className="field">
            <label htmlFor="library-task-filter">{tx(locale, "Purpose", "用途")}</label>
            <select
              id="library-task-filter"
              className="select"
              value={type}
              onChange={(event) => setType(event.target.value)}
              aria-label={tx(locale, "Filter by purpose", "按用途筛选")}
            >
              <option value="All">{tx(locale, "All purposes", "全部用途")}</option>
              {purposes.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name[locale]}
                </option>
              ))}
              <option value="uncategorized">{tx(locale, "Uncategorized", "未分类")}</option>
            </select>
          </div>
          <fieldset className="prompt-filters">
            <legend>{tx(locale, "Prompt filter", "Prompt 筛选")}</legend>
            <div className="result-action-row">
              <label className={`filter-option ${!favoritesOnly ? "is-selected" : ""}`}>
                <input
                  type="radio"
                  name="prompt-filter"
                  checked={!favoritesOnly}
                  onChange={() => setFavoritesOnly(false)}
                />
                {tx(locale, "All prompts", "全部 Prompt")}
              </label>
              <label className={`filter-option ${favoritesOnly ? "is-selected" : ""}`}>
                <input
                  type="radio"
                  name="prompt-filter"
                  checked={favoritesOnly}
                  onChange={() => setFavoritesOnly(true)}
                />
                {tx(locale, "Favorites", "收藏")}
              </label>
            </div>
          </fieldset>
        </div>
        <p className="small subtle" role="status">
          {tx(
            locale,
            `${listed.length} prompts · ${favoritesOnly ? "Favorites" : "All prompts"}`,
            `${listed.length} 条 Prompt · ${favoritesOnly ? "收藏" : "全部 Prompt"}`,
          )}
        </p>
        <div className="grid two" style={{ marginTop: 18 }}>
          {listed.map((prompt) => (
            <PromptCard key={prompt.id} prompt={prompt} locale={locale} />
          ))}
        </div>
        {!listed.length && (
          <Empty
            title={tx(locale, "No prompts found", "没有找到 Prompt")}
            detail={tx(
              locale,
              "Try another search or clear the active filters.",
              "请尝试其他关键词或清除筛选条件。",
            )}
            action={
              <button
                className="btn btn-sm"
                onClick={() => {
                  setQuery("");
                  setType("All");
                  setFavoritesOnly(false);
                }}
              >
                {tx(locale, "Clear filters", "清除筛选")}
              </button>
            }
          />
        )}
      </div>
    </>
  );
}
function PromptCard({ prompt, locale }: { prompt: Prompt; locale: Locale }) {
  const { state, dispatch } = useAppStore();
  const version = state.versions.find((item) => item.id === prompt.currentVersionId)!;
  const itemId = libraryItemIdFor(prompt.id);
  return (
    <article className="panel panel-pad">
      <div className="between">
        <PromptMetadata prompt={prompt} locale={locale} />
        <button
          className={`icon-btn ${state.favorites.includes(prompt.id) ? "" : ""}`}
          onClick={() => dispatch({ type: "TOGGLE_FAVORITE", promptId: prompt.id })}
          aria-label={tx(locale, "Toggle favorite", "切换收藏")}
        >
          <Heart
            size={16}
            fill={state.favorites.includes(prompt.id) ? "#4f46e5" : "none"}
            color={state.favorites.includes(prompt.id) ? "#4f46e5" : "currentColor"}
          />
        </button>
      </div>
      <h3 style={{ marginTop: 12 }}>{localizedTitleFor(prompt.id, locale, prompt.title)}</h3>
      <p className="subtle small" style={{ minHeight: 38, marginTop: 5 }}>
        {locale === "zh-CN" ? localizedDescription(prompt.id) : prompt.description}
      </p>
      {!!prompt.descriptor?.tags.length && (
        <p className="small subtle">{prompt.descriptor.tags.join(" · ")}</p>
      )}
      <div className="between" style={{ marginTop: 15 }}>
        <span className="small subtle">
          {localizedPromptKind(prompt.kind, locale)} · v{version.number}
        </span>
        <div className="row">
          <button
            className="btn btn-sm btn-quiet"
            onClick={() => dispatch({ type: "REMOVE_FROM_LIBRARY", promptId: prompt.id })}
          >
            {tx(locale, "Remove", "移除")}
          </button>
          <Link className="btn btn-sm" href={route(locale, `app/library/${itemId}`)}>
            {tx(locale, "View details", "查看详情")} <ArrowRight size={14} />
          </Link>
        </div>
      </div>
    </article>
  );
}

function Detail({ locale, itemId }: { locale: Locale; itemId: string }) {
  const { state, dispatch } = useAppStore();
  const promptId = state.prompts.find((item) => libraryItemIdFor(item.id) === itemId)?.id ?? itemId;
  const prompt = state.prompts.find((item) => item.id === promptId);
  const version = prompt && state.versions.find((item) => item.id === prompt.currentVersionId);
  if (!prompt || !version)
    return (
      <>
        <Heading eyebrow="PG-10 · P0" title={tx(locale, "Prompt detail", "Prompt 详情")} />
        <Empty
          title={tx(locale, "Demo item not found", "演示条目不存在")}
          detail={tx(
            locale,
            "The Library item ID could not be resolved.",
            "无法识别此 Prompt 库条目 ID。",
          )}
          action={
            <Link className="btn" href={route(locale, "app/library")}>
              {tx(locale, "Back to Library", "返回 Prompt 库")}
            </Link>
          }
        />
      </>
    );
  return (
    <>
      <Heading
        eyebrow="PG-10 · P0"
        title={localizedTitleFor(prompt.id, locale, prompt.title)}
        description={`${localizedPromptKind(prompt.kind, locale)} · ${promptPurposeLabel(prompt, locale)} · v${version.number}`}
        actions={
          <>
            <button className="btn" onClick={() => dispatch({ type: "TOGGLE_FAVORITE", promptId })}>
              <Heart size={15} fill={state.favorites.includes(promptId) ? "#4f46e5" : "none"} />
              {tx(locale, "Favorite", "收藏")}
            </button>
            {prompt.kind === "TEMPLATE" ? (
              <button
                className="btn btn-primary"
                onClick={() => {
                  dispatch({
                    type: "GENERATE",
                    title: `${localizedTitleFor(prompt.id, locale, prompt.title)}${locale === "zh-CN" ? "（副本）" : " (Copy)"}`,
                    taskType: prompt.taskType,
                    content: localizedContentFor(version.id, locale, version.content),
                    descriptor: prompt.descriptor,
                  });
                  dispatch({
                    type: "NOTICE",
                    message: tx(
                      locale,
                      "Personal copy created; template is unchanged.",
                      "已创建个人副本，模板保持不变。",
                    ),
                  });
                }}
              >
                {tx(locale, "Use template", "使用模板")}
              </button>
            ) : (
              <Link
                className="btn btn-primary"
                href={route(locale, `app/prompts/${prompt.id}/edit`)}
              >
                {tx(locale, "Edit prompt", "编辑 Prompt")}
              </Link>
            )}
          </>
        }
      />
      <div className="grid two">
        <Panel
          title={tx(locale, "Prompt content", "Prompt 内容")}
          note={`${tx(locale, "Version", "版本")} ${version.number}`}
        >
          <p style={{ whiteSpace: "pre-wrap", lineHeight: 1.8 }}>
            {localizedContentFor(version.id, locale, version.content)}
          </p>
        </Panel>
        <div className="stack">
          <Panel title={tx(locale, "About this prompt", "Prompt 信息")}>
            <div className="stack small">
              <div className="between">
                <span className="subtle">{tx(locale, "Purposes", "用途")}</span>
                <PromptMetadata prompt={prompt} locale={locale} tags />
              </div>
              <div className="between">
                <span className="subtle">{tx(locale, "Object type", "对象类型")}</span>
                <strong>{localizedPromptKind(prompt.kind, locale)}</strong>
              </div>
              <div className="between">
                <span className="subtle">{tx(locale, "Source version", "来源版本")}</span>
                <strong>{version.id}</strong>
              </div>
              <div className="between">
                <span className="subtle">{tx(locale, "Skill provenance", "Skill 来源记录")}</span>
                <span>{tx(locale, "See saved evidence below", "在下方查看已保存依据")}</span>
              </div>
              <p className="subtle">
                {locale === "zh-CN" ? localizedDescription(prompt.id) : prompt.description}
              </p>
            </div>
          </Panel>
          <SkillProvenancePanel key={version.id} locale={locale} versionId={version.id} />
          <Panel title={tx(locale, "Related actions", "相关操作")}>
            <div className="stack">
              <Link className="btn" href={route(locale, `app/prompts/${prompt.id}/evaluate`)}>
                {tx(locale, "Evaluate this version", "评估此版本")}
              </Link>
              <Link className="btn" href={route(locale, "app/history")}>
                {tx(locale, "View version history", "查看版本历史")}
              </Link>
            </div>
          </Panel>
        </div>
      </div>
    </>
  );
}

function HistoryPage({ locale }: { locale: Locale }) {
  const { state, dispatch } = useAppStore();
  const [left, setLeft] = useState("");
  const [right, setRight] = useState("");
  const grouped = [...state.history].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const selected = state.versions.filter((version) => version.id === left || version.id === right);
  return (
    <>
      <Heading eyebrow="PG-11 · P0" title={tx(locale, "Prompt History", "Prompt 历史")} />
      <ArchitectureNote locale={locale} title={tx(locale, "Version provenance", "版本来源追溯")}>
        {tx(
          locale,
          "Each saved version retains its source. Model and Skill evidence is available when recorded.",
          "每次保存都保留版本与来源；已记录的模型和 Skill 依据可按版本查看。",
        )}
      </ArchitectureNote>
      <div className="grid two">
        <Panel
          title={tx(locale, "Timeline", "版本时间线")}
          note={`${grouped.length} ${tx(locale, "version records", "条版本记录")}`}
        >
          <div>
            {grouped.map((item) => {
              const version = state.versions.find((v) => v.id === item.versionId);
              const prompt = state.prompts.find((p) => p.id === item.promptId);
              if (!version || !prompt) return null;
              return (
                <div className="list-row" key={item.id}>
                  <Clock3 size={16} />
                  <div className="list-main">
                    <div className="between">
                      <strong>
                        {localizedTitleFor(prompt.id, locale, prompt.title)} · v{version.number}
                      </strong>
                      <StateBadge>{localizedSource(item.source, locale)}</StateBadge>
                    </div>
                    <p>
                      {item.createdAt} · {version.id}
                    </p>
                  </div>
                  <div className="row">
                    <button
                      className="btn btn-sm"
                      disabled={
                        !state.versions.some((v) => v.promptId === prompt.id && v.id !== version.id)
                      }
                      onClick={() => {
                        const peers = state.versions.filter(
                          (v) => v.promptId === prompt.id && v.id !== version.id,
                        );
                        const other =
                          peers
                            .filter((v) => v.number < version.number)
                            .toSorted((a, b) => b.number - a.number)[0] ??
                          peers.toSorted((a, b) => a.number - b.number)[0];
                        if (!other) return;
                        setLeft(other.number < version.number ? other.id : version.id);
                        setRight(other.number < version.number ? version.id : other.id);
                      }}
                    >
                      {tx(locale, "Compare", "比较")}
                    </button>
                    <button
                      className="btn btn-sm"
                      onClick={() =>
                        dispatch({
                          type: "RESTORE_VERSION",
                          promptId: prompt.id,
                          versionId: version.id,
                        })
                      }
                    >
                      <RotateCcw size={14} />
                      {tx(locale, "Restore", "恢复")}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </Panel>
        <Panel
          title={tx(locale, "Version comparison", "版本比较")}
          note={tx(
            locale,
            "Read-only; restoration creates a new version.",
            "仅供查看；恢复会创建新版本。",
          )}
        >
          {selected.length < 2 ? (
            <Empty
              title={tx(locale, "Choose versions to compare", "选择版本进行比较")}
              detail={tx(
                locale,
                "Use Compare on any timeline entry.",
                "点击时间线条目上的“比较”。",
              )}
            />
          ) : (
            <div className="stack">
              <p className="small subtle">
                {tx(locale, "Compare", "比较")} v{state.versions.find((v) => v.id === left)!.number}
                {" → "}v{state.versions.find((v) => v.id === right)!.number}
              </p>
              <PromptDiff
                before={state.versions.find((v) => v.id === left)!.content}
                after={state.versions.find((v) => v.id === right)!.content}
                locale={locale}
              />
              <details>
                <summary>{tx(locale, "Read full versions", "查看完整版本")}</summary>
                <div className="grid two">
                  {selected.map((version) => (
                    <div className="version-item" key={version.id}>
                      <div className="between">
                        <strong>v{version.number}</strong>
                        <span className="small subtle">{version.createdAt}</span>
                      </div>
                      <p className="small" style={{ whiteSpace: "pre-wrap", marginTop: 10 }}>
                        {version.content}
                      </p>
                    </div>
                  ))}
                </div>
              </details>
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}

function VersionList({
  promptId,
  locale,
  limit,
}: {
  promptId: string;
  locale: Locale;
  limit?: number;
}) {
  const { state } = useAppStore();
  const items = state.versions
    .filter((version) => version.promptId === promptId)
    .sort((a, b) => b.number - a.number)
    .slice(0, limit);
  return (
    <div className="stack">
      {items.map((version) => {
        const isCurrent =
          state.prompts.find((prompt) => prompt.id === promptId)?.currentVersionId === version.id;
        return (
          <div className={`version-item ${isCurrent ? "current" : ""}`} key={version.id}>
            <div className="between">
              <strong>v{version.number}</strong>
              {isCurrent && <StateBadge tone="blue">{tx(locale, "Current", "当前")}</StateBadge>}
            </div>
            <p className="small subtle" style={{ marginTop: 4 }}>
              {localizedSource(version.source, locale)} · {version.createdAt}
            </p>
          </div>
        );
      })}
    </div>
  );
}

function ExecutionReport({
  locale,
  prompt,
  version,
  report,
}: {
  locale: Locale;
  prompt: Prompt;
  version: PromptVersion;
  report?: EvaluationReport;
}) {
  const { state } = useAppStore();
  const stale =
    state.draft.parentVersionId === version.id && state.draft.content !== version.content;
  const evidence = executionEvidenceFor(state.playgroundRuns, version.id);
  const hasLiveEvidence = evidence.status === "EXECUTED_UNGRADED";
  const run = evidence.run ?? state.playgroundRuns.find((item) => item.versionId === version.id);
  const statusLabel = hasLiveEvidence
    ? tx(locale, "EXECUTED · UNGRADED", "已执行 · 未评分")
    : tx(locale, "NOT_EXECUTED", "未执行");
  const checks = [
    ["Task Completion", "任务完成度"],
    ["Content Accuracy", "内容准确性"],
    ["Instruction Adherence", "指令遵循度"],
    ["Output Completeness", "输出完整性"],
    ["Result Usability", "结果可用性"],
  ];
  return (
    <>
      <Heading
        eyebrow="PG-13 · P1"
        title={tx(locale, "Evaluation report", "评估报告")}
        description={`${localizedTitleFor(version.promptId, locale, version.title)} · v${version.number}`}
        actions={
          <Link className="btn" href={route(locale, `app/prompts/${prompt.id}/edit`)}>
            {tx(locale, "Edit saved Prompt", "编辑已保存 Prompt")}
          </Link>
        }
      />
      <PromptContextBar locale={locale} prompt={prompt} version={version} active="evaluate" />
      <ModelEvaluationPanel
        key={`${version.id}:${locale}`}
        locale={locale}
        prompt={prompt}
        version={version}
        disabled={stale}
      />
      <details className="workflow-option execution-details" style={{ marginTop: 18 }}>
        <summary>
          {tx(locale, "Execution records", "执行记录")} · {statusLabel}
        </summary>
        <section
          className="stack"
          aria-label={tx(locale, "Execution quality evidence", "执行质量依据")}
        >
          <div className="notice">
            <CircleAlert size={16} aria-hidden="true" />
            <p className="small">
              {tx(
                locale,
                hasLiveEvidence
                  ? "A real Playground output is saved for this version. Execution scoring rules are not enabled, so no execution score or grade is assigned. This does not prevent a qualitative Prompt review above."
                  : "This saved version has no real Playground execution output yet. That is not a Prompt review failure: you can request the qualitative DeepSeek report above. Generating or reviewing a Prompt is not executing it.",
                hasLiveEvidence
                  ? "此版本已有真实 Playground 执行输出。执行评分规则尚未启用，因此不生成执行分数或等级；不影响上方 Prompt 定性评估。"
                  : "此已保存版本尚无真实 Playground 执行输出。这不是 Prompt 评估失败，仍可在上方请求 DeepSeek 定性报告；生成或评估 Prompt 不等于执行它。",
              )}
            </p>
          </div>
          <div className="grid two">
            <Panel
              title={tx(locale, "Layer 3 · Execution Quality", "第 3 层 · 执行质量")}
              note={statusLabel}
            >
              <div className="stat-value">—</div>
              <p className="subtle small" style={{ marginTop: 8 }}>
                {tx(
                  locale,
                  "Execution score and grade are not enabled.",
                  "执行分数与等级尚未启用。",
                )}
              </p>
              <div className="stack" style={{ marginTop: 16 }}>
                {checks.map((check) => (
                  <div className="between version-item" key={check[0]}>
                    <span>{locale === "zh-CN" ? check[1] : check[0]}</span>
                    <span className="subtle small">{tx(locale, "Not evaluated", "未评估")}</span>
                  </div>
                ))}
              </div>
            </Panel>
            <Panel
              title={
                hasLiveEvidence
                  ? tx(locale, "Real execution output", "真实执行输出")
                  : run
                    ? tx(locale, "Simulated outputs", "模拟输出")
                    : tx(locale, "No real execution output", "暂无真实执行输出")
              }
              note={
                hasLiveEvidence
                  ? "LIVE"
                  : run
                    ? tx(locale, "MOCK / SIMULATED · not evidence", "模拟演示 · 不作为评估证据")
                    : undefined
              }
            >
              {run && (
                <p className="small subtle">
                  {tx(
                    locale,
                    hasLiveEvidence
                      ? "The saved model output is execution evidence, not verified accuracy or a formal quality score."
                      : "Preset output is shown as a comparison artifact only. It is not a real execution result and is not scored.",
                    hasLiveEvidence
                      ? "已保存的模型输出是执行证据，不等于准确性已核验或正式质量评分。"
                      : "预制输出仅用于对比展示，不是真实执行结果，也不会参与评分。",
                  )}
                </p>
              )}
              {run ? (
                run.outputs.map((output) => (
                  <div className="version-item" key={output.name} style={{ marginTop: 12 }}>
                    <strong>{localizedModelName(output.name, locale)}</strong>
                    <p style={{ marginTop: 7, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                      {localizedModelOutput(output.name, output.text, locale)}
                    </p>
                  </div>
                ))
              ) : (
                <Empty
                  title={tx(locale, "No real execution for this version", "此版本尚未真实执行")}
                  detail={tx(
                    locale,
                    "Open Playground and explicitly run this saved version to retain real output. A live execution may incur fees; opening the page does not call a model.",
                    "前往 Playground，明确运行此已保存版本后可保留真实输出。真实执行可能收费；仅打开页面不会调用模型。",
                  )}
                />
              )}
            </Panel>
          </div>
          {!hasLiveEvidence && (
            <div>
              <Link
                className="btn"
                href={promptActionHref(locale, prompt.id, version.id, "playground")}
              >
                {tx(locale, "Open Playground for execution", "前往 Playground 执行")}
              </Link>
            </div>
          )}
          <EvidenceDisclosure locale={locale}>
            <p className="small subtle">score = null · grade = null</p>
            <p className="small subtle" style={{ marginTop: 14 }}>
              {tx(locale, "Prompt version", "Prompt 版本")}: {version.id} ·{" "}
              {tx(locale, "Prompt quality report", "Prompt 质量报告")}:{" "}
              {report?.id ?? tx(locale, "none for this version", "此版本暂无")}
            </p>
            <p>{evidence.run?.executionId}</p>
          </EvidenceDisclosure>
        </section>
      </details>
    </>
  );
}

function Pricing({ locale }: { locale: Locale }) {
  return (
    <main className="public-main">
      <Heading
        eyebrow="PG-14 · P1"
        title={tx(locale, "Plans for different workflows", "适配不同工作流的方案")}
        description={tx(
          locale,
          "Choose Free or the 30-day Pro trial, open to all accounts. No automatic renewal.",
          "Free 免费使用；Pro 为面向所有账号的 30 天测试套餐，均不自动续费。",
        )}
      />
      <div className="grid two">
        {[FREE_PLAN, PRO_PLAN].map((plan, index) => (
          <section className="panel panel-pad" key={plan.tier}>
            <div className="between">
              <h2>{plan.tier}</h2>
              <StateBadge tone={index ? "blue" : ""}>
                {index ? tx(locale, "OPEN TRIAL", "开放订阅") : tx(locale, "FREE", "免费")}
              </StateBadge>
            </div>
            <div style={{ fontSize: 30, fontWeight: 700, margin: "18px 0" }}>
              {index ? "¥0.01 / 30 days" : "¥0"}
            </div>
            <div className="stack small subtle">
              <div>
                {tx(locale, "Tokens per UTC day / 30 days", "每 UTC 日 / 30 天 tokens")}:{" "}
                {plan.dailyTokens.toLocaleString()} / {plan.periodTokens.toLocaleString()}
              </div>
              <div>
                {tx(locale, "Saved Prompts / private Skills", "保存 Prompt / 私人 Skills")}:{" "}
                {plan.prompts} / {plan.privateSkills}
              </div>
              <div>
                {tx(
                  locale,
                  "Trial local estimated USD budget per day / period",
                  "试运营本地估算 USD 日 / 周期预算",
                )}
                : ${plan.dailyUsd.toFixed(2)} / ${plan.periodUsd.toFixed(2)}
              </div>
              <div>
                {tx(
                  locale,
                  "Both operating modes and shared Skills are available under existing role rules.",
                  "简易 / 专家模式与共享 Skills 均按原有角色规则开放。",
                )}
              </div>
              {index === 1 && (
                <div>
                  {tx(
                    locale,
                    "One-time payment test price; model costs are subsidized. Activation after manual verification. Refunds are handled by the administrator using the contact on the order.",
                    "一次支付闭环测试价，模型成本由运营者补贴；人工核账后开通。退款由管理员办理，联系方式在订单内提供。",
                  )}
                </div>
              )}
            </div>
            <Link
              className={index ? "btn btn-primary pricing-subscribe" : "btn pricing-subscribe"}
              href={index ? `/${locale}/app/checkout?subscribe=pro` : `/${locale}/app/generate`}
            >
              {index
                ? tx(locale, "Subscribe now", "立即订阅")
                : tx(locale, "Start for free", "免费开始")}
            </Link>
          </section>
        ))}
      </div>
      <BillingPanel locale={locale} />
    </main>
  );
}

function Account({ locale }: { locale: Locale }) {
  const { state, dispatch } = useAppStore();
  const [name, setName] = useState(state.profileName);
  const [email, setEmail] = useState<string | null>(null);
  const [admin, setAdmin] = useState(false);
  useEffect(() => {
    void fetch("/api/auth/session", { cache: "no-store" })
      .then((r) => r.json())
      .then((v) => {
        setEmail(v.user?.email ?? null);
        setAdmin(v.user?.role === "ADMIN");
      })
      .catch(() => {});
  }, []);
  const profile = (
    <div className="grid two">
      <Panel title={tx(locale, "Profile details", "资料信息")}>
        <div className="stack">
          <div className="field">
            <label htmlFor="display-name">{tx(locale, "Display name", "显示名称")}</label>
            <input
              className="input"
              id="display-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="field">
            <label>{tx(locale, "Email", "邮箱")}</label>
            <input
              className="input"
              readOnly
              value={email ?? tx(locale, "Loading account…", "正在加载账号…")}
            />
          </div>
          <button
            className="btn btn-primary"
            onClick={() => dispatch({ type: "SET_PROFILE", name })}
          >
            <Save size={15} />
            {tx(locale, "Save profile", "保存资料")}
          </button>
          <Link className="btn" href={route(locale, "help#recovery")}>
            {tx(locale, "Account help and recovery status", "账号帮助与恢复说明")}
          </Link>
          <Link className="btn" href={route(locale, "app/settings")}>
            {tx(locale, "Workspace preferences", "工作区偏好")}
          </Link>
        </div>
      </Panel>
    </div>
  );
  return (
    <>
      {!admin && <Heading eyebrow="PG-15 · P0" title={tx(locale, "Account profile", "账户资料")} />}
      {admin && <BillingPanel locale={locale} />}
      {admin ? (
        <details className="billing-admin-profile">
          <summary>{tx(locale, "Profile details", "资料信息")}</summary>
          {profile}
        </details>
      ) : (
        profile
      )}
      {!admin && <BillingPanel locale={locale} />}
    </>
  );
}

function Settings({ locale }: { locale: Locale }) {
  const { state, dispatch } = useAppStore();
  const router = useRouter();
  useEffect(() => {
    if (location.hash === "#skills-library") router.replace(route(locale, "app/skills"));
  }, [locale, router]);
  const switchLocale = (next: Locale) => {
    dispatch({ type: "SET_LOCALE", locale: next });
    document.documentElement.lang = next;
    router.push(location.pathname.replace(/^\/(en|zh-CN)/, `/${next}`));
  };
  return (
    <>
      <Heading eyebrow="PG-16 · P0" title={tx(locale, "Settings", "设置")} />
      <div className="grid two">
        <Panel title={tx(locale, "Workspace preferences", "工作区偏好")}>
          <div className="stack">
            <div className="field">
              <label>{tx(locale, "Operating mode", "操作模式")}</label>
              <div className="row">
                <button
                  className={`btn ${state.mode === "simple" ? "btn-primary" : ""}`}
                  aria-pressed={state.mode === "simple"}
                  onClick={() => dispatch({ type: "SET_MODE", mode: "simple" })}
                >
                  {localizedMode("simple", locale)}
                </button>
                <button
                  className={`btn ${state.mode === "professional" ? "btn-primary" : ""}`}
                  aria-pressed={state.mode === "professional"}
                  onClick={() => dispatch({ type: "SET_MODE", mode: "professional" })}
                >
                  {localizedMode("professional", locale)}
                </button>
              </div>
            </div>
            <div className="field">
              <label>{tx(locale, "Interface language", "界面语言")}</label>
              <div className="row">
                <button
                  className={`btn ${locale === "en" ? "btn-primary" : ""}`}
                  onClick={() => switchLocale("en")}
                >
                  English
                </button>
                <button
                  className={`btn ${locale === "zh-CN" ? "btn-primary" : ""}`}
                  onClick={() => switchLocale("zh-CN")}
                >
                  简体中文
                </button>
              </div>
            </div>
            <Link className="btn" href={route(locale, "app/account")}>
              {tx(locale, "Manage plan and orders", "管理套餐与订单")}
            </Link>
          </div>
        </Panel>
        <Panel title={tx(locale, "Account access", "账号访问规则")}>
          <p className="subtle">
            {tx(
              locale,
              "Prompts are private to your account. Signing out keeps saved work.",
              "Prompt 按账号隔离，退出登录不会删除已保存内容。",
            )}
          </p>
          <Link className="btn" href={route(locale, "help#recovery")}>
            {tx(locale, "Account help and recovery status", "账号帮助与恢复说明")}
          </Link>
        </Panel>
        <Panel title={tx(locale, "Skills management", "Skills 导入与管理")}>
          <Link className="btn" href={route(locale, "app/skills")}>
            {tx(locale, "Open Skills management", "打开 Skills 管理")}
          </Link>
        </Panel>
        <ModelQuotaPanel locale={locale} />
        <AdminAccountsPanel locale={locale} />
      </div>
    </>
  );
}
