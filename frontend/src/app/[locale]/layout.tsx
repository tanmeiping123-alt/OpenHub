import { notFound } from "next/navigation";
import { Suspense } from "react";
import { AppStore } from "@/lib/store";
import { AppShell } from "@/components/AppShell";
import { GlobalNotice } from "@/components/GlobalNotice";

export function generateStaticParams() {
  return [{ locale: "en" }, { locale: "zh-CN" }];
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (locale !== "en" && locale !== "zh-CN") notFound();
  const loadingLabel = locale === "zh-CN" ? "正在加载工作区" : "Loading workspace";
  const shell = (
    <>
      <Suspense fallback={<div className="mock-banner">PromptMaster AI · {loadingLabel}</div>}>
        <AppShell locale={locale}>{children}</AppShell>
      </Suspense>
      <GlobalNotice />
    </>
  );
  return <AppStore locale={locale}>{shell}</AppStore>;
}
