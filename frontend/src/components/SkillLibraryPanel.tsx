"use client";
import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Locale, Mode } from "@/lib/types";
import { useAppStore } from "@/lib/store";
import { SkillImportPanel } from "./SkillImportPanel";
import { EvidenceDisclosure } from "./EvidenceDisclosure";
import { skillErrorMessage } from "@/lib/skill-errors";
type Source = { repositoryOwner: string; repositoryName: string; path: string; ref: string };
type User = { id: string; email: string; role: "ADMIN" | "USER" };
type Skill = {
  versionId: string;
  name: string;
  description: string;
  source: Source;
  manifestSha256: string;
  warnings: string[];
  publicationKind: string | null;
  submissionId: string | null;
  submissionStatus: string | null;
  reviewNote: string | null;
  withdrawnAt?: string | null;
  withdrawalReason?: string | null;
};
type Overview = {
  user: User;
  library: Skill[];
  personal: Skill[];
  pending: Skill[];
  history?: Skill[];
  totals?: Record<string, number>;
  available?: number;
  page?: number;
  pageSize?: number;
};
type Detail = Skill & {
  body: string;
  resources: {
    path: string;
    content: string;
    type: string;
    sha256: string;
    quarantined: boolean;
  }[];
  accessKind: string;
};
export function SkillLibraryPanel({ locale }: { locale: Locale; mode: Mode }) {
  const router = useRouter();
  const { state, dispatch } = useAppStore();
  const [data, setData] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [authRequired, setAuthRequired] = useState(false);
  const [tab, setTab] = useState<"library" | "personal" | "review" | "history">("library");
  const [page, setPage] = useState(1),
    [query, setQuery] = useState(""),
    [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [share, setShare] = useState(false);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [reviewNote, setReviewNote] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const showPendingImport = useCallback(() => setImportOpen(true), []);
  const t = (en: string, zh: string) => (locale === "zh-CN" ? zh : en);
  const refresh = useCallback(async () => {
    const r = await fetch(
      page === 1 && !query
        ? "/api/skills/library"
        : `/api/skills/library?page=${page}&q=${encodeURIComponent(query)}`,
      { cache: "no-store" },
    );
    if (r.status === 401) {
      setAuthRequired(true);
      setData(null);
      return;
    }
    if (!r.ok) throw Error("UNAVAILABLE");
    setData(await r.json());
    setAuthRequired(false);
  }, [page, query]);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    void fetch(
      page === 1 && !query
        ? "/api/skills/library"
        : `/api/skills/library?page=${page}&q=${encodeURIComponent(query)}`,
      { cache: "no-store", signal: controller.signal },
    )
      .then(async (r) => {
        if (!active) return;
        if (r.status === 401) {
          setAuthRequired(true);
          return;
        }
        if (!r.ok) throw Error("UNAVAILABLE");
        const value = await r.json();
        if (active) setData(value);
      })
      .catch(() => {})
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [refresh, page, query]);
  async function post(body: unknown) {
    const r = await fetch("/api/skills/library", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const value = await r.json();
    if (!r.ok) throw Error(value.error ?? "UNAVAILABLE");
    return value;
  }
  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setNotice("");
    try {
      await action();
    } catch (e) {
      setNotice(
        t("Operation failed: ", "操作失败：") +
          skillErrorMessage(e instanceof Error ? e.message : "UNAVAILABLE", locale) +
          ` (${e instanceof Error ? e.message : "UNAVAILABLE"})`,
      );
    } finally {
      setBusy(false);
    }
  }
  async function refreshAfterSuccess() {
    try {
      await refresh();
    } catch {
      setNotice(
        (current) =>
          current +
          t(
            " List refresh failed; reload to see the saved result.",
            " 列表刷新失败，请刷新页面查看已保存的结果。",
          ),
      );
    }
  }
  async function inspect(skill: Skill) {
    await run(async () => {
      const r = await fetch(
        `/api/skills/library?versionId=${encodeURIComponent(skill.versionId)}`,
        { cache: "no-store" },
      );
      const value = await r.json();
      if (!r.ok) throw Error(value.error);
      setDetail(value);
      setReviewNote("");
      setShare(false);
    });
  }
  function selectForTask(skill: Skill) {
    const taskReturn = new URL(window.location.href).searchParams.get("taskReturn");
    const target =
      taskReturn &&
      /^\/(en|zh-CN)\/app\/prompts\/[A-Za-z0-9_-]+\/optimize$/.test(taskReturn) &&
      taskReturn.startsWith(`/${locale}/app/`)
        ? taskReturn
        : `/${locale}/app/generate`;
    router.push(`${target}?skillVersion=${encodeURIComponent(skill.versionId)}`);
  }
  async function insertSkillText(skill: Skill) {
    await run(async () => {
      if (state.draft.creationRequest) throw Error("IDEMPOTENCY_CONFLICT");
      if ((state.draft.adoptedUseEventIds?.length ?? 0) >= 4) throw Error("TOO_MANY_SKILLS");
      const value = await post({ action: "use", versionId: skill.versionId });
      await dispatch({
        type: "SET_DRAFT",
        patch: {
          promptId: null,
          parentVersionId: undefined,
          savedCreation: undefined,
          creationRequest: undefined,
          adoptedUseEventIds: [
            ...(state.draft.adoptedUseEventIds ?? []),
            ...(value.useEventId ? [value.useEventId] : []),
          ],
          title: state.draft.title || skill.name,
          taskType: state.draft.taskType,
          content: [
            state.draft.content,
            `## Skill: ${skill.name}\nSource version: ${skill.versionId}\n\n${value.adoptionText ?? value.body}`,
          ]
            .filter(Boolean)
            .join("\n\n"),
        },
      });
      router.push(`/${locale}/app/editor`);
    });
  }
  const list = data
    ? tab === "library"
      ? data.library
      : tab === "personal"
        ? data.personal
        : tab === "history"
          ? (data.history ?? [])
          : data.pending
    : [];
  const available =
    data?.available ??
    (data
      ? new Set(
          [
            ...data.library,
            ...data.personal.filter((s) => s.publicationKind || data.user.role === "USER"),
          ].map((s) => s.versionId),
        ).size
      : 0);
  return (
    <section
      id="skills-library"
      className="panel panel-pad"
      style={{ gridColumn: "1 / -1", overflowWrap: "anywhere" }}
      aria-label={t("Skills library", "Skills 库")}
    >
      <div className="panel-head">
        <div>
          <h2>{t("Skills library", "Skills 库")}</h2>
          <p>
            {t(
              "Personal Skills · shared library · administrator review",
              "个人 Skills · 共享库 · 管理员审核",
            )}
          </p>
        </div>
        <button
          className="btn btn-primary"
          aria-expanded={importOpen}
          aria-controls="skill-import"
          onClick={() => setImportOpen(!importOpen)}
        >
          {t("Add Skill", "添加 Skill")}
        </button>
      </div>
      <p>
        {t(
          "Skills are optional reference methods for your current task. Choose one here or continue directly to Generate or Optimize.",
          "Skills 是当前任务的可选参考方法。可在此选择，也可直接进入生成或优化。",
        )}
      </p>
      <EvidenceDisclosure locale={locale} label={t("Matching policy", "匹配规则")}>
        <p>
          {t(
            "Local matching recommends Skills that may suit your task. Automatic selection considers available shared versions; personal versions require your explicit selection for this task. It may use no Skill or several when each adds a useful contribution.",
            "本地匹配推荐可能适合当前任务的 Skills。自动选择只考虑可用的共享版本；私人版本需由本人为当前任务明确选择。无充分匹配时可不使用，每个额外 Skill 都应有可说明的贡献。",
          )}
        </p>
      </EvidenceDisclosure>
      {loading ? (
        <p role="status">{t("Loading…", "正在加载……")}</p>
      ) : authRequired ? (
        <p>
          <Link className="btn btn-primary" href={`/${locale}/login`}>
            {t("Log in to manage Skills", "登录并管理 Skills")}
          </Link>
        </p>
      ) : !data ? (
        <p role="alert">
          {t("Skills library unavailable. Please retry.", "Skills 库暂不可用，请重试。")}
        </p>
      ) : (
        <div className="stack">
          <div className="between">
            <p style={{ overflowWrap: "anywhere" }}>
              {data.user.email} ·{" "}
              {data.user.role === "ADMIN"
                ? t("Administrator / reviewer", "管理员 / 审核人")
                : t("Regular user", "普通用户")}
            </p>
          </div>
          <p>{t(`Available Skills: ${available}`, `可用 Skills：${available}`)}</p>
          <details>
            <summary>{t("How Skills are used", "Skills 使用方式")}</summary>
            <p>
              {t(
                "Shared Skills may be recommended automatically. Personal imports are private and require your selection for each task; personal-use risks remain yours.",
                "共享库中的 Skills 可用于自动推荐。私人导入仅本人可主动选择，不会因导入而自动参与后续任务；个人使用风险由本人承担。",
              )}
            </p>
          </details>
          <div
            className="skill-library-tabs"
            role="group"
            aria-label={t("Skill collections", "Skills 分组")}
          >
            {(
              [
                [
                  "library",
                  t("Shared library", "共享库"),
                  data.totals?.library ?? data.library.length,
                ],
                [
                  "personal",
                  t("My imports", "我的导入"),
                  data.totals?.personal ?? data.personal.length,
                ],
                ...(data.user.role === "ADMIN"
                  ? [
                      [
                        "review",
                        t("Review queue", "待审核推荐"),
                        data.totals?.pending ?? data.pending.length,
                      ],
                      [
                        "history",
                        t("Review / withdrawal history", "审核 / 下架历史"),
                        data.totals?.history ?? data.history?.length ?? 0,
                      ],
                    ]
                  : []),
              ] as [typeof tab, string, number][]
            ).map(([key, label, count]) => (
              <button
                className={`btn ${tab === key ? "btn-primary" : ""}`}
                aria-pressed={tab === key}
                key={key}
                onClick={() => {
                  setTab(key);
                  setDetail(null);
                }}
              >
                {label} ({count})
              </button>
            ))}
          </div>
          <form
            className="row"
            style={{ flexWrap: "wrap" }}
            onSubmit={(e) => {
              e.preventDefault();
              setPage(1);
              setQuery(search);
            }}
          >
            <label htmlFor="skill-search">
              {t("Search name or description", "搜索名称或描述")}
            </label>
            <input
              id="skill-search"
              className="input"
              value={search}
              maxLength={120}
              onChange={(e) => setSearch(e.target.value)}
            />
            <button className="btn">{t("Search", "搜索")}</button>
          </form>
          {list.length === 0 ? (
            <p>{t("No Skills in this section yet.", "此处暂无 Skills。")}</p>
          ) : (
            <ul className="stack" style={{ listStyle: "none", padding: 0 }}>
              {list.map((skill) => (
                <li key={skill.versionId} className="panel panel-pad">
                  <h3 style={{ overflowWrap: "anywhere" }}>{skill.name}</h3>
                  <p>{skill.description}</p>
                  <p>
                    {skill.publicationKind && !skill.withdrawnAt
                      ? t("Available to all users", "所有用户可用")
                      : tab === "review" || tab === "history"
                        ? t("Personal version submitted for review", "已推荐供审核的个人版本")
                        : t("Only you can use this version", "此版本仅本人可用")}
                  </p>
                  {skill.withdrawnAt && (
                    <p>
                      {t(
                        "Withdrawn from shared use; original personal access is retained",
                        "已从共享库下架；原个人授权保留",
                      )}
                    </p>
                  )}
                  {skill.submissionStatus && (
                    <p>
                      {
                        (
                          {
                            PENDING: t("Recommendation pending review", "推荐待审核"),
                            APPROVED: t("This exact version was approved", "此具体版本已通过审核"),
                            REJECTED: t(
                              "Recommendation rejected; personal use remains available",
                              "推荐被拒绝，仍可个人使用",
                            ),
                          } as Record<string, string>
                        )[skill.submissionStatus]
                      }
                    </p>
                  )}
                  {skill.reviewNote && (
                    <p>
                      {t("Review note: ", "审核意见：")}
                      {skill.reviewNote}
                    </p>
                  )}
                  <div className="row" style={{ flexWrap: "wrap" }}>
                    {tab !== "review" &&
                      tab !== "history" &&
                      (!skill.withdrawnAt || data.user.role === "USER") && (
                        <button
                          className="btn btn-primary"
                          disabled={busy}
                          onClick={() => selectForTask(skill)}
                        >
                          {t("Use for this generation / optimization", "用于本次生成／优化")}
                        </button>
                      )}
                    <button className="btn" disabled={busy} onClick={() => void inspect(skill)}>
                      {t("View content and source", "查看内容与来源")}
                    </button>
                  </div>
                  {skill.withdrawalReason && (
                    <p>
                      {t("Withdrawal reason: ", "下架原因：")}
                      {skill.withdrawalReason}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
          <div className="row">
            <button className="btn" disabled={busy || page === 1} onClick={() => setPage(page - 1)}>
              {t("Previous page", "上一页")}
            </button>
            <span>{t(`Page ${page} · 25 per page`, `第 ${page} 页 · 每页 25 条`)}</span>
            <button
              className="btn"
              disabled={
                busy ||
                page * 25 >= (data.totals?.[tab === "review" ? "pending" : tab] ?? list.length)
              }
              onClick={() => setPage(page + 1)}
            >
              {t("Next page", "下一页")}
            </button>
          </div>
          {detail && (
            <section
              className="panel panel-pad stack"
              aria-label={t("Skill details", "Skill 详情")}
            >
              <div className="between">
                <h3>{detail.name}</h3>
                <button className="btn" onClick={() => setDetail(null)}>
                  {t("Close", "关闭")}
                </button>
              </div>
              <EvidenceDisclosure
                key={detail.versionId}
                locale={locale}
                label={t("Source and full text", "来源与全文")}
              >
                <p style={{ overflowWrap: "anywhere" }}>
                  {detail.source.repositoryOwner
                    ? `${detail.source.repositoryOwner}/${detail.source.repositoryName} · ${detail.source.path} · ${detail.source.ref}`
                    : t("Offline authored / uploaded content", "离线自编 / 上传内容")}
                </p>
                <p style={{ overflowWrap: "anywhere" }}>
                  {t("Version: ", "版本：")}
                  {detail.versionId}
                  <br />
                  SHA-256 {detail.manifestSha256}
                </p>
                <pre
                  style={{
                    whiteSpace: "pre-wrap",
                    overflowWrap: "anywhere",
                    maxHeight: 360,
                    overflow: "auto",
                  }}
                >
                  {detail.body}
                </pre>
                {detail.resources.map((r) => (
                  <details key={r.path}>
                    <summary>
                      {r.path} · {r.quarantined ? t("Quarantined script", "已隔离脚本") : r.type}
                    </summary>
                    <pre className="result-body">{r.content}</pre>
                  </details>
                ))}
              </EvidenceDisclosure>
              <EvidenceDisclosure locale={locale} label={t("Source warnings", "来源提示")}>
                <p>{detail.warnings.join(" · ") || t("No additional warnings", "无额外提示")}</p>
              </EvidenceDisclosure>
              {detail.accessKind !== "REVIEW_ONLY" && (
                <details>
                  <summary>{t("Insert original text into a draft", "插入原文到草稿")}</summary>
                  <p>
                    {t(
                      "This inserts the authorized Skill text and resources into your editor draft. It does not select a reference method for generation.",
                      "这会把有权使用的 Skill 正文与资源插入编辑器草稿。生成时的方法参考需在当前任务中选择。",
                    )}
                  </p>
                  <button
                    className="btn"
                    disabled={busy}
                    onClick={() => void insertSkillText(detail)}
                  >
                    {t("Insert original text into draft", "确认插入原文到草稿")}
                  </button>
                </details>
              )}
              {data.user.role === "USER" &&
                detail.accessKind === "PERSONAL" &&
                !detail.submissionStatus && (
                  <>
                    <label className="row">
                      <input
                        type="checkbox"
                        checked={share}
                        onChange={(e) => setShare(e.target.checked)}
                      />
                      {t(
                        "I recommend this exact version for administrator review and sharing with all users.",
                        "我推荐此版本供管理员审核，并同意审核通过后向所有用户开放。",
                      )}
                    </label>
                    <button
                      className="btn"
                      disabled={busy || !share}
                      onClick={() =>
                        void run(async () => {
                          await post({
                            action: "recommend",
                            versionId: detail.versionId,
                            shareAccepted: true,
                          });
                          setDetail(null);
                          setNotice(
                            t(
                              "Recommended. Waiting for review; this version is still available for your personal use.",
                              "已推荐，等待审核；此版本仍可由本人使用。",
                            ),
                          );
                          await refreshAfterSuccess();
                        })
                      }
                    >
                      {t("Recommend to shared library", "推荐到共享库")}
                    </button>
                  </>
                )}
              {data.user.role === "ADMIN" && detail.submissionStatus === "PENDING" && (
                <>
                  <label htmlFor="review-note">{t("Review note", "审核意见")}</label>
                  <textarea
                    id="review-note"
                    className="input"
                    value={reviewNote}
                    maxLength={2000}
                    onChange={(e) => setReviewNote(e.target.value)}
                  />
                  <div className="row">
                    {(
                      [
                        ["APPROVED", t("Approve and publish", "通过并发布")],
                        ["REJECTED", t("Reject recommendation", "拒绝推荐")],
                      ] as const
                    ).map(([decision, label]) => (
                      <button
                        key={decision}
                        className="btn"
                        disabled={busy || !reviewNote.trim()}
                        onClick={() =>
                          void run(async () => {
                            await post({
                              action: "review",
                              submissionId: detail.submissionId,
                              decision,
                              note: reviewNote,
                            });
                            setDetail(null);
                            setNotice(t("Review saved.", "审核结果已保存。"));
                            await refreshAfterSuccess();
                          })
                        }
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </>
              )}
              {data.user.role === "ADMIN" && detail.publicationKind && !detail.withdrawnAt && (
                <>
                  <label htmlFor="withdraw-note">
                    {t("Reason for withdrawing this exact shared version", "下架此共享版本的原因")}
                  </label>
                  <textarea
                    id="withdraw-note"
                    className="input"
                    maxLength={2000}
                    value={reviewNote}
                    onChange={(e) => setReviewNote(e.target.value)}
                  />
                  <p>
                    {t(
                      "This blocks new shared use. Saved/copied outputs cannot be recalled. Original private access and immutable review history remain.",
                      "下架会阻止新的共享使用，不能撤回已经保存或复制的内容。原个人授权及不可变审核历史保留。",
                    )}
                  </p>
                  <button
                    className="btn"
                    disabled={busy || !reviewNote.trim()}
                    onClick={() =>
                      void run(async () => {
                        await post({
                          action: "withdraw",
                          versionId: detail.versionId,
                          reason: reviewNote,
                        });
                        setDetail(null);
                        setNotice(
                          t(
                            "Shared version withdrawn. History retained.",
                            "共享版本已下架，历史保留。",
                          ),
                        );
                        await refreshAfterSuccess();
                      })
                    }
                  >
                    {t("Confirm withdrawal", "确认下架")}
                  </button>
                </>
              )}
            </section>
          )}
          <div id="skill-import" className="skill-import-section" hidden={!importOpen}>
            <SkillImportPanel
              locale={locale}
              role={data.user.role}
              userId={data.user.id}
              onImported={refresh}
              onPending={showPendingImport}
            />
          </div>
        </div>
      )}
      {notice && (
        <p role="status" style={{ overflowWrap: "anywhere" }}>
          {notice}
        </p>
      )}
    </section>
  );
}
