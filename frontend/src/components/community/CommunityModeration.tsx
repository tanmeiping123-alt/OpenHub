"use client";
import Link from "next/link";
import { useRef, useState } from "react";
import type { CommunityModeration as Moderation } from "@/lib/community-types";
import {
  communityMutation,
  dateLabel,
  errorText,
  readReceipt,
  text,
  useCommunityResource,
} from "./client";
import { useCommunity } from "./CommunityShell";
import { CommunityFailure, CommunityLoading, Pagination } from "./Common";

type DecisionTarget = { action: string; publicId?: string; reportId?: string; starId?: string };
function pendingDecision(actor?: string): (DecisionTarget & { reason: string }) | null {
  if (!actor) return null;
  const receipt = readReceipt(actor, "moderate");
  try {
    const value = receipt ? JSON.parse(receipt.body) : null;
    return value && typeof value.reason === "string" && typeof value.action === "string"
      ? value
      : null;
  } catch {
    return null;
  }
}

export function CommunityModeration() {
  const { locale, viewer } = useCommunity();
  const [entry, setEntry] = useState("");
  const [query, setQuery] = useState("");
  const [pages, setPages] = useState({ reports: 1, stars: 1, events: 1 });
  const params = new URLSearchParams({
    reportsPage: String(pages.reports),
    starsPage: String(pages.stars),
    eventsPage: String(pages.events),
  });
  if (query) params.set("id", query);
  const resource = useCommunityResource<Moderation>(
    viewer?.user?.role === "ADMIN" ? `/api/community/moderation?${params}` : null,
  );
  const [recovered] = useState(() => pendingDecision(viewer?.user?.id));
  const [target, setTarget] = useState<DecisionTarget | null>(() => {
    if (!recovered) return null;
    const selected: DecisionTarget & { reason?: string } = { ...recovered };
    delete selected.reason;
    return selected;
  });
  const [reason, setReason] = useState(recovered?.reason ?? "");
  const [pending, setPending] = useState(!!recovered);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [error, setError] = useState<unknown>(null);
  const [success, setSuccess] = useState("");
  function selectTarget(next: DecisionTarget) {
    if (busy || pending) return;
    setTarget(next);
    setReason("");
    setError(null);
    setSuccess("");
  }
  function pagination(kind: keyof typeof pages) {
    const paging = resource.data?.paging[kind];
    return paging ? (
      <Pagination
        {...paging}
        locale={locale}
        onPage={(page) => setPages((current) => ({ ...current, [kind]: page }))}
      />
    ) : null;
  }
  const labels: Record<string, string> = {
    remove: text(locale, "Remove publication", "下架作品"),
    restore: text(locale, "Restore publication", "恢复作品"),
    dismiss: text(locale, "Close report", "关闭举报"),
    excludeStar: text(locale, "Exclude suspicious Star", "排除异常 Star"),
    restoreStar: text(locale, "Restore Star eligibility", "恢复 Star 计数资格"),
  };
  if (viewer?.user?.role !== "ADMIN")
    return (
      <section className="op-state">
        <h1>{text(locale, "Administrator access required", "需要管理员权限")}</h1>
        <Link className="op-button" href={`/${locale}/open-prompts`}>
          {text(locale, "Return to community", "返回社区")}
        </Link>
      </section>
    );
  async function apply() {
    if (!target || !viewer?.user || lock.current || reason.trim().length < 5) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      await communityMutation(viewer.user.id, "moderate", "/api/community/moderation", "POST", {
        ...target,
        reason: reason.trim(),
      });
      setSuccess(text(locale, "Decision recorded.", "处理决定已记录。"));
      setTarget(null);
      setPending(false);
      setReason("");
      resource.reload();
    } catch (e) {
      setPending(!!readReceipt(viewer.user.id, "moderate"));
      setError(e);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <>
      <header className="op-page-intro">
        <p className="op-overline">COMMUNITY CARE</p>
        <h1>{text(locale, "Keep the community useful.", "让社区值得信赖。")}</h1>
        <p>
          {text(
            locale,
            "Review reports and record reasons for every decision. No private Prompt access or manual popularity counts.",
            "核查举报，为每一次处理留下原因。治理界面不读取私人 Prompt，也不允许手动编造人气。",
          )}
        </p>
      </header>
      <p role="status" className="op-feedback">
        {success}
      </p>
      {target && (
        <section className="op-moderation-confirm">
          <h2>{labels[target.action]}</h2>
          {pending && (
            <p className="op-notice">
              {text(
                locale,
                "The previous decision is unconfirmed. Its original reason is retained; reconcile it before submitting another decision.",
                "上次处理结果待确认，已恢复原始理由。请先核对此次处理，再提交其他决定。",
              )}
            </p>
          )}
          <p>
            {text(
              locale,
              "Confirm a factual reason. Publication removal affects every public version; existing saved copies remain.",
              "请填写事实依据。下架将影响所有公开版本，已经保存的副本会保留。",
            )}
          </p>
          <label className="op-field">
            {text(locale, "Decision reason", "处理原因")}
            <textarea
              className="op-input"
              rows={3}
              minLength={5}
              maxLength={2000}
              value={reason}
              readOnly={pending || busy}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          {!!error && (
            <p className="op-error" role="alert">
              {errorText(error, locale)}
            </p>
          )}
          <div className="op-actions">
            <button
              className="op-button"
              disabled={busy || pending}
              onClick={() => {
                setTarget(null);
                setReason("");
              }}
            >
              {text(locale, "Cancel", "取消")}
            </button>
            <button
              className="op-button op-primary"
              disabled={busy || reason.trim().length < 5}
              onClick={() => void apply()}
            >
              {busy
                ? text(locale, "Recording…", "正在记录…")
                : pending
                  ? text(locale, "Reconcile decision", "核对此次处理")
                  : text(locale, "Confirm decision", "确认处理")}
            </button>
          </div>
        </section>
      )}
      {resource.loading ? (
        <CommunityLoading locale={locale} />
      ) : resource.error ? (
        <CommunityFailure error={resource.error} locale={locale} retry={resource.reload} />
      ) : (
        <>
          <section className="op-note-section">
            <h2>{text(locale, "Reports", "举报记录")}</h2>
            {!resource.data?.reports.length && (
              <p className="op-muted">{text(locale, "No reports to show.", "暂无举报记录。")}</p>
            )}
            <div className="op-moderation-list">
              {resource.data?.reports.map((report) => (
                <article className="op-moderation-card" key={report.id}>
                  <div className="op-list-heading">
                    <h3>
                      <Link href={`/${locale}/open-prompts/${report.publicId}`}>
                        {report.title}
                      </Link>
                    </h3>
                    <span className="op-status">{report.status}</span>
                  </div>
                  <p className="op-caption">
                    {report.category} · {dateLabel(report.createdAt, locale)}
                  </p>
                  <p>{report.detail}</p>
                  <div className="op-actions">
                    <button
                      className="op-button"
                      onClick={() => {
                        selectTarget({ action: "dismiss", reportId: report.id });
                      }}
                    >
                      {text(locale, "Close report", "关闭举报")}
                    </button>
                    <button
                      className="op-button op-danger"
                      onClick={() => {
                        selectTarget({ action: "remove", publicId: report.publicId });
                      }}
                    >
                      {text(locale, "Remove publication", "下架作品")}
                    </button>
                  </div>
                </article>
              ))}
            </div>
            {pagination("reports")}
          </section>
          <section className="op-note-section">
            <h2>{text(locale, "Publication & Star review", "作品与 Star 核查")}</h2>
            <form
              className="op-search"
              onSubmit={(e) => {
                e.preventDefault();
                setQuery(entry.trim());
                setPages({ reports: 1, stars: 1, events: 1 });
              }}
            >
              <input
                aria-label={text(locale, "Public Prompt ID", "公开 Prompt ID")}
                value={entry}
                onChange={(e) => setEntry(e.target.value)}
                placeholder={text(locale, "Enter a public Prompt ID", "输入作品的公开 ID")}
              />
              <button className="op-button" type="submit">
                {text(locale, "Look up", "核查")}
              </button>
            </form>
            {query && (
              <div className="op-actions">
                <Link className="op-button" href={`/${locale}/open-prompts/${query}`}>
                  {text(locale, "View publication", "查看作品")}
                </Link>
                <button
                  className="op-button"
                  onClick={() => {
                    selectTarget({ action: "restore", publicId: query });
                  }}
                >
                  {text(locale, "Restore publication", "恢复作品")}
                </button>
                <button
                  className="op-button op-danger"
                  onClick={() => {
                    selectTarget({ action: "remove", publicId: query });
                  }}
                >
                  {text(locale, "Remove publication", "下架作品")}
                </button>
              </div>
            )}
            {resource.data?.stars.map((star) => (
              <div key={star.id} className="op-star-review">
                <code>{star.id}</code>
                <span>
                  {dateLabel(star.firstStarredAt, locale)} ·{" "}
                  {star.active
                    ? text(locale, "Active", "有效")
                    : text(locale, "Unstarred", "已取消")}{" "}
                  ·{" "}
                  {star.excluded
                    ? text(locale, "Excluded", "已排除")
                    : text(locale, "Eligible", "可计数")}
                </span>
                <button
                  className="op-button"
                  onClick={() => {
                    selectTarget({
                      action: star.excluded ? "restoreStar" : "excludeStar",
                      starId: star.id,
                    });
                  }}
                >
                  {star.excluded
                    ? text(locale, "Restore", "恢复计数")
                    : text(locale, "Exclude", "排除异常")}
                </button>
              </div>
            ))}
            {pagination("stars")}
          </section>
          <section className="op-note-section">
            <h2>{text(locale, "Decision history", "处理历史")}</h2>
            {!resource.data?.events.length && (
              <p className="op-muted">{text(locale, "No decisions yet.", "暂无处理记录。")}</p>
            )}
            {resource.data?.events.map((event) => (
              <article className="op-audit-event" key={event.id}>
                <strong>{labels[event.action] ?? event.action}</strong>
                <time>{dateLabel(event.createdAt, locale)}</time>
                <p>{event.reason}</p>
              </article>
            ))}
            {pagination("events")}
          </section>
        </>
      )}
    </>
  );
}
