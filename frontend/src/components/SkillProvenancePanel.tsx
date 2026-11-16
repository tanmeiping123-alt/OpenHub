"use client";
import { useState } from "react";
import type { Locale } from "@/lib/types";
import { skillErrorMessage } from "@/lib/skill-errors";
type Source = {
  skillVersionId: string;
  name: string;
  evidenceKind: string;
  manifestSha256: string;
  resources: { path: string; sha256: string; type: string }[];
  planId?: string;
  executionId?: string;
  withdrawnAt?: string;
};
export function SkillProvenancePanel({ locale, versionId }: { locale: Locale; versionId: string }) {
  const [result, setResult] = useState<{ versionId: string; sources: Source[] } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const t = (en: string, zh: string) => (locale === "zh-CN" ? zh : en);
  return (
    <details className="panel panel-pad" style={{ overflowWrap: "anywhere" }}>
      <summary>
        {t(
          "View evidence · Structured Skill provenance for this saved version",
          "查看依据 · 此已保存版本的结构化 Skill 来源",
        )}
      </summary>
      <div className="stack">
        <p>{versionId}</p>
        <button
          className="btn"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              const response = await fetch(
                `/api/skills/provenance?versionId=${encodeURIComponent(versionId)}`,
                { cache: "no-store" },
              );
              const value = await response.json();
              if (!response.ok) throw Error(value.error);
              setResult(value);
            } catch (e) {
              setError(skillErrorMessage(e instanceof Error ? e.message : "UNAVAILABLE", locale));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? t("Loading…", "读取中…") : t("Load saved provenance", "读取保存的来源")}
        </button>
        {error && <p role="alert">{error}</p>}
        {result?.versionId === versionId &&
          (result.sources.length ? (
            result.sources.map((source) => (
              <div key={`${source.skillVersionId}:${source.evidenceKind}`}>
                <p>
                  {source.name} · {source.evidenceKind}
                </p>
                <p>
                  {source.skillVersionId} · SHA-256 {source.manifestSha256}
                </p>
                {source.resources.map((resource) => (
                  <p className="small" key={resource.path}>
                    {resource.path} · {resource.sha256}
                  </p>
                ))}
                <p>
                  {source.planId} {source.executionId}
                </p>
                {source.withdrawnAt && (
                  <p>
                    {t(
                      "Shared version subsequently withdrawn; historical evidence is retained.",
                      "此共享版本后来已下架，历史证据仍保留。",
                    )}
                  </p>
                )}
              </div>
            ))
          ) : (
            <p>
              {t(
                "No structured Skill adoption/context is recorded for this version. Editable text alone is not source evidence.",
                "此版本没有结构化 Skill 采用或模型上下文记录。可编辑正文不作为来源证据。",
              )}
            </p>
          ))}
        <p className="small">
          {t(
            "Context evidence records supplied material, not proof of model compliance or task execution. Historical versions are not retroactively attributed.",
            "上下文证据表示提供的资料，不代表模型遵循情况或目标任务已执行。历史版本不会被追溯补造来源。",
          )}
        </p>
      </div>
    </details>
  );
}
