"use client";
import Link from "next/link";
import { GitBranch } from "lucide-react";
import type { Locale } from "@/lib/types";
import type { CommunityCopySource } from "@/lib/community-types";
import { text, useCommunityResource } from "./client";
export function CopySource({ promptId, locale }: { promptId: string; locale: Locale }) {
  if (!/^prm_[a-f0-9-]{36}$/.test(promptId)) return null;
  return <ValidCopySource key={promptId} promptId={promptId} locale={locale} />;
}
function ValidCopySource({ promptId, locale }: { promptId: string; locale: Locale }) {
  const source = useCommunityResource<CommunityCopySource | null>(
    `/api/community/copy-source?promptId=${encodeURIComponent(promptId)}`,
  );
  if (!source.data) return null;
  return (
    <div className="community-copy-source">
      <GitBranch size={16} aria-hidden="true" />
      <span>
        {text(locale, "Independent copy from Open Prompt", "来自 Open Prompt 的独立副本")} ·{" "}
        {source.data.available ? (
          <Link
            href={`/${locale}/open-prompts/${source.data.publicId}?version=${source.data.versionNumber}`}
          >
            {source.data.title} · v{source.data.versionNumber}
          </Link>
        ) : (
          text(locale, "Original publication withdrawn", "原作已撤回或下架")
        )}{" "}
        · CC0 1.0
      </span>
    </div>
  );
}
