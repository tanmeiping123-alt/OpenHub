"use client";
/* eslint-disable @next/next/no-img-element -- Published thumbnails must preserve authorization checks and avoid optimization caches. */
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  Bike,
  Braces,
  ChevronLeft,
  ChevronRight,
  Globe2,
  LoaderCircle,
  Settings2,
} from "lucide-react";
import type { Locale } from "@/lib/types";
import { PELICAN_PROMPT, type PelicanListing, type PelicanSample } from "@/lib/pelican-types";
import { strengthLabel } from "../ModelControls";
import {
  dateLabel,
  executionState,
  previewState,
  sampleStatus,
  text,
  useResource,
  type PelicanBadgeState,
} from "./client";
import { PelicanPreview } from "./PelicanPreview";
import { PelicanAdmin } from "./PelicanAdmin";

export function PelicanShell({
  locale,
  children,
  manage = false,
}: {
  locale: Locale;
  children: ReactNode;
  manage?: boolean;
}) {
  const other = locale === "en" ? "zh-CN" : "en";
  return (
    <div className="pelican-shell">
      <a className="pelican-skip" href="#pelican-main">
        {text(locale, "Skip to content", "跳到主要内容")}
      </a>
      <header className="pelican-header">
        <Link className="pelican-brand" href={`/${locale}/pelican`}>
          <span className="pelican-brand-mark">
            <Braces aria-hidden="true" size={23} />
          </span>
          <span>
            PromptMaster AI<small>{text(locale, "Pelican study", "鹈鹕测智")}</small>
          </span>
        </Link>
        <nav aria-label={text(locale, "Public navigation", "公开导航")}>
          <Link className="pelican-public-return" href={`/${locale}/open-prompts`}>
            {text(locale, "Open Prompt", "开放社区")}
          </Link>
          <Link href={`/${locale}/app`}>{text(locale, "Workspace", "创作工作台")}</Link>
          <Link
            className="pelican-language"
            href={`/${other}/pelican${manage ? "/manage" : ""}`}
            aria-label={text(locale, "Switch to Chinese", "切换到英文")}
          >
            <Globe2 size={17} aria-hidden="true" />
            {locale === "en" ? "中文" : "EN"}
          </Link>
        </nav>
      </header>
      <main id="pelican-main" className="pelican-main" tabIndex={-1}>
        {children}
      </main>
      <footer className="pelican-footer">
        <span>PromptMaster AI</span>
        <span>
          {text(
            locale,
            "One task. Real results. No overall score.",
            "一道题，真实作品，不设综合评分。",
          )}
        </span>
      </footer>
    </div>
  );
}
export function PelicanPage({ locale, manage = false }: { locale: Locale; manage?: boolean }) {
  const viewer = useResource<{ role: "ADMIN" | "USER" | null; accountScope?: string }>(
    "/api/pelican/viewer",
  );
  const reloadViewer = viewer.reload;
  useEffect(() => {
    window.addEventListener("focus", reloadViewer);
    return () => window.removeEventListener("focus", reloadViewer);
  }, [reloadViewer]);
  return (
    <PelicanShell locale={locale} manage={manage}>
      {manage ? (
        viewer.loading ? (
          <PelicanState locale={locale} />
        ) : viewer.data?.role === "ADMIN" && viewer.data.accountScope ? (
          <PelicanAdmin
            key={viewer.data.accountScope}
            locale={locale}
            accountScope={viewer.data.accountScope}
          />
        ) : (
          <div className="pelican-state">
            <h1>{text(locale, "Administrator access required", "需要管理员权限")}</h1>
            <p>
              {text(
                locale,
                "Sign in with an administrator account to manage tests.",
                "请使用管理员账号登录后管理测试。",
              )}
            </p>
            <Link
              className="pelican-button"
              href={`/${locale}/login?next=${encodeURIComponent(`/${locale}/pelican/manage`)}`}
            >
              {text(locale, "Log in", "登录")}
            </Link>
            <Link href={`/${locale}/pelican`}>
              {text(locale, "View published works", "浏览已发布作品")}
            </Link>
          </div>
        )
      ) : (
        <Gallery locale={locale} admin={viewer.data?.role === "ADMIN"} />
      )}
    </PelicanShell>
  );
}
export function PelicanState({
  locale,
  error = false,
  retry,
}: {
  locale: Locale;
  error?: boolean;
  retry?: () => void;
}) {
  return (
    <div className="pelican-state" role={error ? "alert" : "status"}>
      <p>
        {error
          ? text(
              locale,
              "Could not load these works. Please try again.",
              "作品暂时无法加载，请稍后重试。",
            )
          : text(locale, "Loading works…", "正在读取作品…")}
      </p>
      {error && retry && (
        <button className="pelican-button" onClick={retry}>
          {text(locale, "Reload", "重新加载")}
        </button>
      )}
    </div>
  );
}
export function SampleMeta({ sample, locale }: { sample: PelicanSample; locale: Locale }) {
  return (
    <dl className="pelican-meta">
      <div>
        <dt>{text(locale, "Generated", "生成时间")}</dt>
        <dd>{dateLabel(sample.generatedAt, locale)}</dd>
      </div>
      <div>
        <dt>{text(locale, "Reasoning", "思考档位")}</dt>
        <dd>{strengthLabel(sample.strength, locale)}</dd>
      </div>
      <div>
        <dt>{text(locale, "Duration", "耗时")}</dt>
        <dd>
          {sample.latencyMs === null
            ? text(locale, "Unknown", "未知")
            : `${(sample.latencyMs / 1000).toFixed(1)} s`}
        </dd>
      </div>
    </dl>
  );
}
export function StatusBadge({
  state,
  className = "",
  children,
}: {
  state: PelicanBadgeState;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <span
      className={`pelican-status-badge pelican-status-${state.status}${className ? ` ${className}` : ""}`}
      data-status={state.status}
      data-tone={state.tone}
      data-busy={state.busy ? "true" : undefined}
    >
      {state.busy && <LoaderCircle className="pelican-spinner" size={14} aria-hidden="true" />}
      {state.label}
      {children}
    </span>
  );
}
export function SampleCard({
  sample,
  locale,
  onOpen,
  showExecution = false,
}: {
  sample: PelicanSample;
  locale: Locale;
  onOpen: (sample: PelicanSample) => void;
  showExecution?: boolean;
}) {
  const recordedAt = sample.generatedAt ?? sample.startedAt ?? null;
  return (
    <article className="pelican-card">
      <button
        className="pelican-work"
        onClick={() => onOpen(sample)}
        aria-label={`${text(locale, "Open work", "打开作品")}：${sample.modelName} ${dateLabel(recordedAt, locale)}`}
      >
        <span className="pelican-image">
          {sample.hasThumbnail ? (
            <img
              src={`/api/pelican/samples/${encodeURIComponent(sample.id)}/thumbnail`}
              alt={text(
                locale,
                `${sample.modelName} work thumbnail`,
                `${sample.modelName} 作品缩略图`,
              )}
              loading="lazy"
            />
          ) : (
            <span className="pelican-no-image">
              <Bike aria-hidden="true" size={32} />
              <span>{sampleStatus(sample, locale)}</span>
            </span>
          )}
        </span>
        <span className="pelican-card-title">
          <strong>{sample.modelName}</strong>
          <span className="pelican-strength" title={strengthLabel(sample.strength, locale)}>
            {sample.strength === "off"
              ? text(locale, "Off", "不思考")
              : sample.strength === "default"
                ? text(locale, "Default", "默认思考")
                : strengthLabel(sample.strength, locale)}
          </span>
        </span>
      </button>
      <div className="pelican-card-caption">
        <time dateTime={recordedAt ?? undefined}>
          {recordedAt
            ? dateLabel(recordedAt, locale)
            : text(locale, "Awaiting dispatch", "等待派发")}
        </time>
        {sample.callStatus !== "PENDING" && (
          <span>
            {sample.latencyMs === null
              ? text(locale, "Not timed", "耗时未记录")
              : `${(sample.latencyMs / 1000).toFixed(1)} s`}
          </span>
        )}
      </div>
      <div className="pelican-card-statuses">
        {(showExecution || sample.callStatus !== "SUCCEEDED") && (
          <StatusBadge state={executionState(sample, locale)}>
            {sample.callStatus === "PENDING" && sample.startedAt && (
              <ElapsedTime since={sample.startedAt} locale={locale} />
            )}
          </StatusBadge>
        )}
        {sample.callStatus === "SUCCEEDED" && <StatusBadge state={previewState(sample, locale)} />}
      </div>
      {sample.rerunOf && (
        <p className="pelican-note">
          {text(locale, "Additional run; original sample retained", "重跑样本；原始记录已保留")}
        </p>
      )}
    </article>
  );
}
function ElapsedTime({ since, locale }: { since: string; locale: Locale }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((now - new Date(since).getTime()) / 1000));
  if (!Number.isFinite(seconds)) return null;
  return (
    <span className="pelican-elapsed">
      {text(locale, "Elapsed", "已等待")} {Math.floor(seconds / 60)}:
      {String(seconds % 60).padStart(2, "0")}
    </span>
  );
}
export function ModelRail({
  name,
  samples,
  locale,
  onOpen,
  showExecution = false,
}: {
  name: string;
  samples: PelicanSample[];
  locale: Locale;
  onOpen: (sample: PelicanSample) => void;
  showExecution?: boolean;
}) {
  const rail = useRef<HTMLDivElement>(null);
  const move = (direction: number) =>
    rail.current?.scrollBy({
      left: direction * rail.current.clientWidth * 0.8,
      behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
        ? "instant"
        : "smooth",
    });
  return (
    <section className="pelican-model-group">
      <div className="pelican-rail-heading">
        <div className="pelican-model-emblem">
          <Braces size={20} aria-hidden="true" />
        </div>
        <div>
          <h2>{name}</h2>
          <p>
            {samples.length} {text(locale, "works", "个记录")} ·{" "}
            {text(locale, "Beijing time", "北京时间")}
          </p>
        </div>
        <div className="pelican-rail-arrows">
          <button
            className="pelican-button pelican-icon-button"
            aria-label={`${name} ${text(locale, "previous works", "向前浏览")}`}
            onClick={() => move(-1)}
          >
            <ChevronLeft size={18} />
          </button>
          <button
            className="pelican-button pelican-icon-button"
            aria-label={`${name} ${text(locale, "next works", "向后浏览")}`}
            onClick={() => move(1)}
          >
            <ChevronRight size={18} />
          </button>
        </div>
      </div>
      <div
        className="pelican-rail"
        ref={rail}
        tabIndex={0}
        aria-label={`${name} ${text(locale, "works", "作品列表")}`}
      >
        {samples.map((s) => (
          <SampleCard
            key={s.id}
            sample={s}
            locale={locale}
            onOpen={onOpen}
            showExecution={showExecution}
          />
        ))}
      </div>
    </section>
  );
}
function Gallery({ locale, admin }: { locale: Locale; admin: boolean }) {
  const [view, setView] = useState<"current" | "history">("history");
  const [modelKey, setModelKey] = useState("");
  const [batchId, setBatchId] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<PelicanSample | null>(null);
  const params = new URLSearchParams({ view, modelKey, page: String(page) });
  const listing = useResource<PelicanListing>(`/api/pelican?${params}`);
  const reload = listing.reload;
  const revalidate = useCallback(() => {
    setSelected(null);
    reload();
  }, [reload]);
  useEffect(() => {
    const handler = () => reload();
    window.addEventListener("focus", handler);
    return () => window.removeEventListener("focus", handler);
  }, [reload]);
  if (
    selected &&
    (listing.error ||
      (listing.data &&
        !listing.data.batches.some((b) => b.samples.some((s) => s.id === selected.id))))
  )
    setSelected(null);
  const batches = listing.data?.batches ?? [];
  const current = batches.find((b) => b.id === batchId) ?? batches[0];
  const visible = view === "current" ? (current ? [current] : []) : batches;
  const samples = visible
    .flatMap((b) => b.samples)
    .filter((s) => !modelKey || s.modelKey === modelKey);
  const groups = new Map<string, { name: string; samples: PelicanSample[] }>();
  samples.forEach((s) => {
    const group = groups.get(s.modelKey) ?? { name: s.modelName, samples: [] };
    group.samples.push(s);
    groups.set(s.modelKey, group);
  });
  return (
    <>
      <section className="pelican-intro">
        <div>
          <h1>
            {text(locale, "A pelican. A bicycle. Every model’s take.", "一只鹈鹕，一辆自行车。")}
          </h1>
          <p>
            {text(
              locale,
              "Same prompt. Results reflect this task alone.",
              "同题对比，结果仅代表本次任务。",
            )}
          </p>
        </div>
        {admin && (
          <Link className="pelican-button pelican-manage" href={`/${locale}/pelican/manage`}>
            <Settings2 size={16} aria-hidden="true" />
            {text(locale, "Manage tests", "管理测试")}
          </Link>
        )}
      </section>
      <section className="pelican-prompt" aria-label={text(locale, "Fixed prompt", "固定题目")}>
        <Bike aria-hidden="true" size={28} />
        <div>
          <span>{text(locale, "The prompt, unchanged", "固定题目，原文直测")}</span>
          <p lang="zh-CN">{PELICAN_PROMPT}</p>
        </div>
      </section>
      <section className="pelican-toolbar" aria-label={text(locale, "Browse works", "浏览作品")}>
        <div className="pelican-tabs" role="group" aria-label={text(locale, "View", "浏览方式")}>
          <button
            aria-pressed={view === "current"}
            onClick={() => {
              setView("current");
              setModelKey("");
              setBatchId("");
              setPage(1);
            }}
          >
            {text(locale, "Current comparison", "本期对比")}
          </button>
          <button
            aria-pressed={view === "history"}
            onClick={() => {
              setView("history");
              setBatchId("");
              setPage(1);
            }}
          >
            {text(locale, "Model history", "模型历史")}
          </button>
        </div>
        {view === "history" ? (
          <label className="pelican-inline-label">
            {text(locale, "Model", "选择模型")}
            <select
              value={modelKey}
              onChange={(e) => {
                setModelKey(e.target.value);
                setPage(1);
              }}
            >
              <option value="">{text(locale, "All models", "全部模型")}</option>
              {listing.data?.models.map((m) => (
                <option key={m.key} value={m.key}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          batches.length > 1 && (
            <label className="pelican-inline-label">
              {text(locale, "Batch", "选择批次")}
              <select
                value={current?.id ?? ""}
                onChange={(e) => {
                  setBatchId(e.target.value);
                }}
              >
                {batches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.title}
                  </option>
                ))}
              </select>
            </label>
          )
        )}
      </section>
      <div className="pelican-gallery-note">
        <p>
          {view === "current"
            ? current?.title
            : text(
                locale,
                "Different dates and settings remain labeled; these are not identical conditions.",
                "不同时间和参数保留真实标签，不视为严格同条件比较。",
              )}
        </p>
        <span>{text(locale, "Times: Beijing (UTC+8)", "时间：北京时间 UTC+8")}</span>
      </div>
      {listing.error ? (
        <PelicanState locale={locale} error retry={listing.reload} />
      ) : listing.loading ? (
        <PelicanState locale={locale} />
      ) : !samples.length ? (
        <div className="pelican-state pelican-empty">
          <Bike size={42} aria-hidden="true" />
          <h2>{text(locale, "No published works yet", "还没有已发布作品")}</h2>
          <p>
            {text(
              locale,
              "Published test results will appear here, including their recorded status.",
              "管理员发布测试后，作品和真实状态会出现在这里。",
            )}
          </p>
        </div>
      ) : view === "history" ? (
        Array.from(groups.entries()).map(([key, group]) => (
          <ModelRail
            key={key}
            name={group.name}
            samples={group.samples}
            locale={locale}
            onOpen={setSelected}
          />
        ))
      ) : (
        <ModelRail
          name={current?.title ?? ""}
          samples={samples}
          locale={locale}
          onOpen={setSelected}
        />
      )}
      {listing.data && (
        <PelicanPagination
          page={page}
          hasMore={listing.data.hasMore}
          onPage={setPage}
          locale={locale}
        />
      )}
      {view === "current" && current?.publishedAt && (
        <p className="pelican-publication-note">
          {text(locale, "Published", "发布时间")}：{dateLabel(current.publishedAt, locale)} (UTC+8)
        </p>
      )}
      {selected && (
        <PelicanPreview
          sample={selected}
          locale={locale}
          onClose={() => setSelected(null)}
          onUnavailable={revalidate}
        />
      )}
    </>
  );
}
export function PelicanPagination({
  page,
  hasMore,
  onPage,
  locale,
}: {
  page: number;
  hasMore: boolean;
  onPage: (page: number) => void;
  locale: Locale;
}) {
  if (page === 1 && !hasMore) return null;
  return (
    <nav className="pelican-pagination" aria-label={text(locale, "Pagination", "分页")}>
      <button className="pelican-button" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        {text(locale, "Previous", "上一页")}
      </button>
      <span>{page}</span>
      <button className="pelican-button" disabled={!hasMore} onClick={() => onPage(page + 1)}>
        {text(locale, "Next", "下一页")}
      </button>
    </nav>
  );
}
