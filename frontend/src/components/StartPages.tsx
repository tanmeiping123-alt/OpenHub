"use client";

import Link from "next/link";
import {
  Clock3,
  ArrowRight,
  Braces,
  ArrowUpRight,
  FileText,
  Plus,
  PencilLine,
  Compass,
  Sparkles,
} from "lucide-react";
import type { Locale } from "@/lib/types";
import { useAppStore } from "@/lib/store";
import { localizedContentFor, localizedTitleFor } from "@/lib/fixtures";
import { promptPurposeLabel } from "@/lib/prompt-description";
import { FeaturedSkillsPanel } from "./FeaturedSkillsPanel";

const t = (locale: Locale, en: string, zh: string) => (locale === "zh-CN" ? zh : en);

export function Landing({ locale }: { locale: Locale }) {
  return (
    <main className="public-main landing-main">
      <section className="landing-intro">
        <div className="landing-copy">
          <h1>
            {t(locale, "Give your ideas better instructions.", "把想法，写成好用的 Prompt。")}
          </h1>
          <p>
            {t(
              locale,
              "Create, refine and share. A place for every draft, and every better version.",
              "从一句想法开始，写出、打磨、分享。让每一次好用的表达，都有迹可循。",
            )}
          </p>
          <div className="hero-actions">
            <Link className="btn btn-primary" href={`/${locale}/app/generate`}>
              <Plus size={18} aria-hidden="true" />
              {t(locale, "Create a Prompt", "开始创建")}
            </Link>
            <Link className="btn" href={`/${locale}/open-prompts`}>
              {t(locale, "Explore Open Prompt", "探索 Open Prompt")}
              <ArrowUpRight size={17} aria-hidden="true" />
            </Link>
          </div>
        </div>
        <div
          className="prompt-specimen"
          aria-label={t(locale, "An editable starting point", "一份可改写的起点")}
        >
          <div className="specimen-heading">
            <Braces size={26} aria-hidden="true" />
            <span>
              {t(locale, "A little clarity goes a long way.", "把要求写清楚，好结果更近一步。")}
            </span>
          </div>
          <div className="specimen-content">
            <p>
              {t(locale, "Help me understand", "帮我理解")}{" "}
              <span className="prompt-variable">
                {t(locale, "{{a new idea}}", "{{一个新概念}}")}
              </span>
            </p>
            <p>
              {t(locale, "Start with a familiar example.", "从一个熟悉的例子讲起。")}
              <br />
              {t(locale, "Explain the idea in plain language.", "用简单的语言，解释核心原理。")}
              <br />
              {t(locale, "Give me one way to try it.", "最后，给我一个可以动手的小练习。")}
            </p>
          </div>
          <div className="specimen-footer">
            <span>{t(locale, "Your words. Your next version.", "你的表达，你的下一版。")}</span>
            <PencilLine size={18} aria-hidden="true" />
          </div>
        </div>
      </section>
      <section className="landing-paths" aria-label={t(locale, "Ways to start", "从这里开始")}>
        {[
          {
            icon: Sparkles,
            title: t(locale, "Turn an idea into a draft", "从想法到初稿"),
            detail: t(
              locale,
              "Describe the task. Choose a model. Keep the result.",
              "说清任务，选择模型，留住结果。",
            ),
            href: `/${locale}/app/generate`,
          },
          {
            icon: PencilLine,
            title: t(locale, "Make each version better", "把每一版改好"),
            detail: t(
              locale,
              "Edit, review and compare without losing the original.",
              "编辑、评估、对比，原来的版本也在。",
            ),
            href: `/${locale}/app/editor`,
          },
          {
            icon: Compass,
            title: t(locale, "Start with something shared", "从别人分享的好点子开始"),
            detail: t(
              locale,
              "Read and copy complete Prompts in the open community.",
              "在开放社区阅读完整 Prompt，自由复制使用。",
            ),
            href: `/${locale}/open-prompts`,
          },
        ].map(({ icon: Icon, title, detail, href }) => (
          <Link className="landing-path" key={href} href={href}>
            <Icon size={22} aria-hidden="true" />
            <h2>{title}</h2>
            <p>{detail}</p>
          </Link>
        ))}
      </section>
    </main>
  );
}

export function Dashboard({ locale }: { locale: Locale }) {
  const { state } = useAppStore();
  const recent = [...state.prompts]
    .map((prompt) => ({
      prompt,
      version: state.versions.find((v) => v.id === prompt.currentVersionId),
    }))
    .sort((a, b) => (b.version?.createdAt ?? "").localeCompare(a.version?.createdAt ?? ""))
    .slice(0, 4);
  const latest = recent[0];
  return (
    <div className="start-workspace">
      <header className="studio-welcome">
        <div className="studio-welcome-copy">
          <h1>{t(locale, "A clear thought.\nA better Prompt.", "让好想法，\n有一个好开头。")}</h1>

          <div className="workspace-counts">
            <span>
              <strong>{state.prompts.length}</strong>
              {t(locale, "Prompts", "条 Prompt")}
            </span>
            <span>
              <strong>{state.versions.length}</strong>
              {t(locale, "versions", "个版本")}
            </span>
            <span>
              <strong>{state.favorites.length}</strong>
              {t(locale, "favorites", "项收藏")}
            </span>
          </div>
        </div>
        <div className="studio-resume">
          <div className="between">
            <span>
              <Clock3 size={15} aria-hidden="true" />
              {t(locale, "Continue creating", "接着上次继续")}
            </span>
            <Braces size={22} aria-hidden="true" />
          </div>
          {latest?.version ? (
            <>
              <h2>{localizedTitleFor(latest.prompt.id, locale, latest.prompt.title)}</h2>
              <p className="studio-resume-excerpt">
                {localizedContentFor(latest.version.id, locale, latest.version.content)}
              </p>
              <Link
                className="studio-resume-link"
                href={`/${locale}/app/prompts/${latest.prompt.id}/edit`}
              >
                <span>
                  {t(locale, "Continue editing", "继续编辑")}{" "}
                  <small>v{latest.version.number}</small>
                </span>
                <ArrowRight size={18} aria-hidden="true" />
              </Link>
            </>
          ) : (
            <>
              <h2>{t(locale, "Your first idea belongs here.", "第一条好想法，从这里开始。")}</h2>

              <Link className="studio-resume-link" href={`/${locale}/app/editor`}>
                {t(locale, "Open a blank page", "打开空白草稿")}
                <ArrowRight size={18} aria-hidden="true" />
              </Link>
            </>
          )}
        </div>
      </header>
      <div className="start-actions">
        <Link className="start-create" href={`/${locale}/app/generate`}>
          <span className="start-action-icon">
            <Braces size={28} aria-hidden="true" />
          </span>
          <div>
            <h2>{t(locale, "Create with AI", "让 AI 帮你写")}</h2>
            <p>
              {t(
                locale,
                "A clear Prompt, from the task you have in mind.",
                "描述任务，生成你的第一版 Prompt。",
              )}
            </p>
          </div>
          <Plus size={22} aria-hidden="true" />
        </Link>
        <Link className="start-write" href={`/${locale}/app/editor`}>
          <PencilLine size={24} aria-hidden="true" />
          <div>
            <h2>{t(locale, "Write your own", "直接写 Prompt")}</h2>
            <p>
              {t(locale, "Already have the words? Start here.", "已有内容？粘贴或直接开始编辑。")}
            </p>
          </div>
        </Link>
      </div>
      <div className="studio-lower">
        <section className="recent-work">
          <div className="between">
            <h2>{t(locale, "Pick up where you left off", "最近的 Prompt")}</h2>
            <Link className="text-link" href={`/${locale}/app/library`}>
              {t(locale, "View all", "查看全部")}
              <ArrowUpRight size={16} aria-hidden="true" />
            </Link>
          </div>
          {recent.length ? (
            <div className="recent-list">
              {recent.map(({ prompt, version }) => {
                return (
                  <Link
                    key={prompt.id}
                    className="recent-prompt"
                    href={`/${locale}/app/prompts/${prompt.id}/edit`}
                  >
                    <span className="document-icon">
                      <FileText size={21} aria-hidden="true" />
                    </span>
                    <div className="recent-title">
                      <strong>{localizedTitleFor(prompt.id, locale, prompt.title)}</strong>
                      <span>{promptPurposeLabel(prompt, locale)}</span>
                    </div>
                    <span className="recent-version">v{version?.number ?? 1}</span>
                    <span className="recent-date">{version?.createdAt.slice(0, 10)}</span>
                    <ArrowUpRight size={17} aria-hidden="true" />
                  </Link>
                );
              })}
            </div>
          ) : (
            <div className="workspace-empty">
              <Braces size={32} aria-hidden="true" />
              <h3>{t(locale, "Your first Prompt starts here.", "从第一条 Prompt 开始。")}</h3>
              <p>
                {t(
                  locale,
                  "Create a draft above, or save something useful from Open Prompt.",
                  "在上方开始创建，或到 Open Prompt 收藏一个好点子。",
                )}
              </p>
            </div>
          )}
        </section>
        <aside className="studio-discover">
          <Compass size={28} aria-hidden="true" />

          <h2>
            {t(locale, "A good Prompt can go further.", "好用的 Prompt，\n值得被更多人看见。")}
          </h2>

          <Link className="btn" href={`/${locale}/open-prompts`}>
            {t(locale, "Explore Open Prompt", "探索 Open Prompt")}
            <ArrowUpRight size={16} aria-hidden="true" />
          </Link>
          <Link className="studio-secondary-link" href={`/${locale}/pelican`}>
            {t(locale, "See models in action", "看看模型的真实作品")}
            <ArrowUpRight size={14} aria-hidden="true" />
          </Link>
        </aside>
      </div>
      <details className="workspace-discover">
        <summary>{t(locale, "Explore Skills", "探索 Skills")}</summary>
        <FeaturedSkillsPanel locale={locale} />
        <Link className="text-link" href={`/${locale}/app/skills`}>
          {t(locale, "Manage my Skills", "管理我的 Skills")}
        </Link>
      </details>
    </div>
  );
}
