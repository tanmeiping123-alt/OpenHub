"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { Locale } from "@/lib/types";
import {
  candidateSourceUrl,
  formatRepositoryStars,
  isFeaturedPublication,
  type FeaturedCandidate,
  type FeaturedPublication,
  type FeaturedRepository,
} from "@/lib/featured-skills";

function SourceLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">
      {children}
    </a>
  );
}

function CandidateDetails({
  candidate: c,
  repository: r,
  locale,
}: {
  candidate: FeaturedCandidate;
  repository: FeaturedRepository;
  locale: Locale;
}) {
  const t = (en: string, zh: string) => (locale === "zh-CN" ? zh : en);
  return (
    <div className="featured-details stack small">
      <p>{c.summary[locale]}</p>
      <p>
        <strong>{t("Scope: ", "适用方向：")}</strong>
        {c.direction[locale]}
      </p>
      <p>
        <strong>{t("Dependencies: ", "依赖：")}</strong>
        {c.dependencies[locale]}
      </p>
      <p>
        <strong>{t("Limitations: ", "限制：")}</strong>
        {c.limitations[locale]}
      </p>
      <p>
        <strong>{t("License review: ", "许可核查：")}</strong>
        {c.licenseSummary[locale]}
      </p>
      <p>
        {t("Metadata checked: ", "元数据核查：")}
        <time dateTime={c.checkedAt}>{c.checkedAt} (UTC)</time>
      </p>
      <p>
        {t("Pinned commit: ", "固定 commit：")}
        <code>{c.sourceCommit}</code>
      </p>
      <p>
        {t("Main file SHA-256: ", "主文件 SHA-256：")}
        <code>{c.mainFileSha256}</code>
      </p>
      <div className="featured-links">
        <SourceLink href={candidateSourceUrl(c, r)}>
          {t(`View source · ${c.name}`, `查看来源 · ${c.name}`)}
        </SourceLink>
        {c.licensePath && (
          <SourceLink
            href={`https://github.com/${r.fullName}/blob/${c.sourceCommit}/${c.licensePath}`}
          >
            {t("License source", "许可来源")}
          </SourceLink>
        )}
      </div>
    </div>
  );
}

export function FeaturedSkillsPanel({ locale }: { locale: Locale }) {
  const [publication, setPublication] = useState<FeaturedPublication | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [reload, setReload] = useState(0);
  const t = (en: string, zh: string) => (locale === "zh-CN" ? zh : en);
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        if (process.env.NEXT_PUBLIC_PROMPTMASTER_DEMO_API_ENABLED !== "true")
          throw new Error("UNAVAILABLE");
        const response = await fetch("/api/skills/featured", {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("UNAVAILABLE");
        const data: unknown = await response.json();
        if (!isFeaturedPublication(data)) throw new Error("INVALID_PUBLICATION");
        if (!controller.signal.aborted) {
          setPublication(data);
          setError(false);
        }
      } catch {
        if (!controller.signal.aborted) setError(true);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [reload]);

  function renderEntries(ids: string[], offset = 0) {
    return ids.map((id, index) => {
      const i = index + offset;
      if (!publication) return null;
      const c = publication.candidates.find((c) => c.id === id)!;
      const r = publication.repositories.find((r) => r.id === c.repositoryId)!;
      const o = publication.observations.find((o) => o.repositoryId === r.id)!;
      const related = publication.candidates.filter(
        (item) =>
          item.repositoryId === r.id && item.id !== c.id && item.displayAdmission === "ADMITTED",
      );
      return (
        <li key={id} className="featured-item">
          <div className="featured-row">
            <span className="featured-rank" aria-label={t(`Rank ${i + 1}`, `第 ${i + 1} 名`)}>
              {i + 1}
            </span>
            <div className="featured-main">
              <h3>{c.name}</h3>
              <p className="small">
                {c.direction[locale]} · {r.fullName}
              </p>
            </div>
            <div className="featured-stars">
              <span className="small">{t("Source repository Stars", "来源仓库 Stars")}</span>
              <strong>{formatRepositoryStars(o.stars, locale)}</strong>
            </div>
          </div>
          <details>
            <summary>{t(`View details · ${c.name}`, `查看详情 · ${c.name}`)}</summary>
            <p className="small">
              {t("Raw snapshot: ", "原始快照值：")}
              {o.stars}
            </p>
            <p className="small subtle">
              {t("Observed: ", "采集日期：")}
              <time dateTime={o.observedAt!}>{o.observedAt} (UTC)</time>
              {o.lastAttempt.result === "FAILED" && (
                <>
                  {" "}
                  · {t(
                    "Update failed; historical observation retained",
                    "更新失败，保留历史观测",
                  )}{" "}
                  ({o.lastAttempt.at}, {o.lastAttempt.errorCode})
                </>
              )}
            </p>
            <p className="small">
              {t(
                "Source candidate · Personal installation/review status not queried · Effectiveness not verified",
                "来源候选 · 个人安装/审核状态未查询 · 效果未验证",
              )}
            </p>
            <CandidateDetails candidate={c} repository={r} locale={locale} />
            <p className="small">
              <SourceLink href={o.sourceUrl}>
                {t("Stars observation source · GitHub API", "Stars 观测来源 · GitHub API")}
              </SourceLink>
            </p>
            {related.length > 0 && (
              <div className="featured-related">
                <h4>
                  {t(
                    "Related candidates · not additional ranked entries",
                    "同仓库关联候选 · 不额外排名",
                  )}
                </h4>
                {related.map((item) => (
                  <details key={item.id}>
                    <summary>{item.name}</summary>
                    <CandidateDetails candidate={item} repository={r} locale={locale} />
                  </details>
                ))}
              </div>
            )}
          </details>
        </li>
      );
    });
  }

  return (
    <section
      className="panel panel-pad featured-skills"
      aria-label={t("Featured Skills", "精选 Skills")}
      aria-busy={loading}
    >
      <div className="panel-head featured-heading">
        <div>
          <h2>{t("Featured Skills", "精选 Skills")}</h2>
        </div>
        <button
          type="button"
          className="btn btn-sm"
          disabled={loading}
          onClick={() => {
            setLoading(true);
            setReload((n) => n + 1);
          }}
        >
          {t("Reload saved list", "重读已发布榜单")}
        </button>
      </div>
      {loading && <p role="status">{t("Loading saved publication…", "正在读取已发布快照……")}</p>}
      {error && (
        <p role="alert">
          {publication
            ? t(
                "Reload failed. Keeping the previously loaded publication and original observation dates.",
                "重读失败，保留先前读取的发布快照与原采集日期。",
              )
            : t(
                "Featured catalog unavailable. This does not mean there are no candidates.",
                "精选目录暂不可用，不代表候选为空。",
              )}
        </p>
      )}
      {publication && (
        <>
          <p className="small" role="status">
            {t(
              `Currently showing ${Math.min(publication.orderedEntryIds.length, 3)} entries · Updated ${new Date(publication.publishedAt).toLocaleDateString(locale)}`,
              `当前展示 ${Math.min(publication.orderedEntryIds.length, 3)} 项 · 更新时间 ${new Date(publication.publishedAt).toLocaleDateString(locale)}`,
            )}{" "}
          </p>
          {publication.orderedEntryIds.length === 0 && (
            <p>
              {t(
                "No candidates with observed stars are available for this ranking. Missing data is not zero.",
                "暂无具备有效 Stars 观测的榜单条目；缺失数据不视为 0。",
              )}
            </p>
          )}
          <ol className="featured-list">
            {renderEntries(publication.orderedEntryIds.slice(0, 3))}
          </ol>
          {publication.orderedEntryIds.length > 3 && (
            <details>
              <summary>
                {t(
                  `View all ${publication.orderedEntryIds.length} Skills`,
                  `查看全部 ${publication.orderedEntryIds.length} 项`,
                )}
              </summary>
              <ol className="featured-list" start={4}>
                {renderEntries(publication.orderedEntryIds.slice(3), 3)}
              </ol>
            </details>
          )}
          <details>
            <summary>{t("About this list", "榜单说明")}</summary>
            <div className="stack small subtle">
              <p>
                {t(
                  "Saved snapshot, not a global or live ranking. Browsing never imports, enables or runs Skills. Stars are repository totals, not Skill scores; + denotes a snapshot lower bound, not growth. Popularity does not imply suitability for your task.",
                  "精选范围的保存快照，非全网或实时排行。浏览不会导入、启用或运行 Skills。Stars 为仓库总数，并非 Skill 评分；+ 表示快照下界，不代表增长。人气不代表对当前任务的适用性。",
                )}
              </p>
              <p>
                {t("Publication", "发布批次")}: {publication.id} ·{" "}
                <time dateTime={publication.publishedAt}>{publication.publishedAt} (UTC)</time>
              </p>
              <Link href={`/${locale}/app/skills`}>{t("Open your Skills", "管理我的 Skills")}</Link>
            </div>
          </details>
          {publication.observations.some((o) => o.stars === null) && (
            <p className="small">
              {t(
                "Some repositories lack observed stars and are not ranked. Their candidate metadata remains in the catalog.",
                "部分仓库暂无 Stars 观测，不参与排名；候选元数据仍保留在目录。",
              )}
            </p>
          )}
        </>
      )}
    </section>
  );
}
