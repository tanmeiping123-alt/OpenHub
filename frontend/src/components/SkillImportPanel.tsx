"use client";
import { useState, useRef, useEffect } from "react";
import type { Locale } from "@/lib/types";
import { skillErrorMessage } from "@/lib/skill-errors";
import { EvidenceDisclosure } from "./EvidenceDisclosure";
type Source = { repositoryOwner: string; repositoryName: string; path: string; ref: string };
type Prepared = {
  preparedSourceId: string;
  source: Source;
  preview: {
    name: string;
    description: string;
    body: string;
    warnings: string[];
    resources: { path: string; type: string; sha256: string; size: number }[];
    importState?: "SAME_VERSION" | "NEW_VERSION" | "NEW_SKILL";
    existingVersionId?: string;
    manifestSha256?: string;
  };
};
export function SkillImportPanel({
  locale,
  role,
  userId,
  onImported,
  onPending,
}: {
  locale: Locale;
  role: "ADMIN" | "USER";
  userId: string;
  onImported: () => Promise<void>;
  onPending?: () => void;
}) {
  const t = (en: string, zh: string) => (locale === "zh-CN" ? zh : en);
  const [kind, setKind] = useState<"URL" | "AUTHORED" | "UPLOAD">("URL");
  const [url, setUrl] = useState(""),
    [name, setName] = useState(""),
    [description, setDescription] = useState(""),
    [body, setBody] = useState("");
  const [files, setFiles] = useState<{ path: string; content: string }[]>([]);
  const [candidates, setCandidates] = useState<Source[]>([]),
    [prepared, setPrepared] = useState<Prepared | null>(null);
  const [risk, setRisk] = useState(false),
    [rights, setRights] = useState(false),
    [versionAccepted, setVersionAccepted] = useState(false),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(""),
    [code, setCode] = useState("");
  const storageKey = `pm-skill-import:${userId}`;
  const legacyStorageKey = `pm-skill-library-import:${userId}`;
  type Retry = { key: string; path: string; body: unknown; legacyStorageKey?: string };
  const [retry, setRetryState] = useState<Retry | null>(() => {
    try {
      const value = JSON.parse(sessionStorage.getItem(storageKey) ?? "null");
      if (
        value &&
        typeof value.key === "string" &&
        ["/api/skills/imports", "/api/skills/offline"].includes(value.path)
      )
        return value;
      const legacy = JSON.parse(sessionStorage.getItem(legacyStorageKey) ?? "null");
      if (!legacy || typeof legacy.key !== "string") return null;
      const originalSource =
        typeof legacy.source === "string" ? JSON.parse(legacy.source) : legacy.source;
      if (
        !originalSource ||
        !["repositoryOwner", "repositoryName", "path", "ref"].every(
          (field) => typeof originalSource[field] === "string",
        )
      )
        return null;
      return {
        key: legacy.key,
        path: "/api/skills/imports",
        body:
          typeof legacy.preparedSourceId === "string"
            ? { preparedSourceId: legacy.preparedSourceId }
            : originalSource,
        legacyStorageKey,
      };
    } catch {
      return null;
    }
  });
  useEffect(() => {
    if (retry) onPending?.();
  }, [retry, onPending]);
  function setRetry(value: Retry | null) {
    if (value) {
      try {
        sessionStorage.setItem(storageKey, JSON.stringify(value));
      } catch {
        throw Error("REQUEST_STORAGE_UNAVAILABLE");
      }
    } else {
      try {
        sessionStorage.removeItem(storageKey);
        if (retry?.legacyStorageKey === legacyStorageKey)
          sessionStorage.removeItem(legacyStorageKey);
      } catch {}
    }
    setRetryState(value);
  }
  const lock = useRef(false),
    errorRef = useRef<HTMLDivElement>(null);
  function changed() {
    setRisk(false);
    setRights(false);
    setVersionAccepted(false);
    setPrepared(null);
    setCandidates([]);
    setNotice("");
    setCode("");
  }
  async function json(path: string, payload: unknown, headers: Record<string, string> = {}) {
    const r = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(payload),
    });
    const v = await r.json();
    if (!r.ok) {
      if (
        r.status >= 400 &&
        r.status < 500 &&
        v.error !== "PREPARED_SOURCE_EXPIRED_OR_NOT_FOUND" &&
        v.error !== "IDEMPOTENCY_CONFLICT"
      )
        setRetry(null);
      throw Error(v.error ?? "UNAVAILABLE");
    }
    return v;
  }
  async function run(work: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setCode("");
    setNotice("");
    try {
      await work();
    } catch (e) {
      setCode(e instanceof Error ? e.message : "UNAVAILABLE");
      requestAnimationFrame(() => errorRef.current?.focus());
    } finally {
      setBusy(false);
      lock.current = false;
    }
  }
  async function prepare(source: Source) {
    setPrepared(null);
    setRisk(false);
    setRights(false);
    setVersionAccepted(false);
    const result = await json("/api/skills/sources", source, { "X-Skill-Preview": "true" });
    setPrepared(result);
  }
  async function preview(source: Source) {
    await run(async () => {
      await prepare(source);
    });
  }
  async function importCurrent() {
    await run(async () => {
      let request = retry;
      if (!request) {
        if (prepared?.preview.importState === "SAME_VERSION") return;
        if (prepared?.preview.importState === "NEW_VERSION" && !versionAccepted)
          throw Error("INVALID_INPUT");
        if (!rights || (role === "USER" && !risk)) throw Error("PERSONAL_RISK_ACCEPTANCE_REQUIRED");
        if (kind === "URL") {
          if (!prepared) throw Error("INVALID_INPUT");
          request = {
            key: crypto.randomUUID(),
            path: "/api/skills/imports",
            body: { preparedSourceId: prepared.preparedSourceId },
          };
        } else {
          const main =
            kind === "AUTHORED"
              ? `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n${body}`
              : null;
          request = {
            key: crypto.randomUUID(),
            path: "/api/skills/offline",
            body: {
              directoryName: name,
              origin: kind,
              files: main ? [{ path: "SKILL.md", content: main }, ...files] : files,
            },
          };
        }
        setRetry(request);
      }
      const result = await json(request.path, request.body, {
        "Idempotency-Key": request.key,
        ...(role === "USER" ? { "X-Personal-Risk-Acceptance": "personal-risk-v1" } : {}),
      });
      if (result.status === "REGISTERED") {
        setRetry(null);
        setRisk(false);
        setRights(false);
        setNotice(
          result.reusedVersion
            ? t(
                "This version already exists; no duplicate version was created. Check its current availability in the library.",
                "此版本已存在，未创建重复版本。请在库中查看其当前可用范围。",
              )
            : role === "ADMIN"
              ? t(
                  "Published to the shared library for all users.",
                  "已发布到共享库，所有用户可用。",
                )
              : t(
                  "Imported. Only you can use this version; sharing requires a separate recommendation.",
                  "已导入，仅你可用；共享需另行推荐。",
                ),
        );
        try {
          await onImported();
        } catch {
          setNotice(
            (current) =>
              current +
              t(
                " List refresh failed; reload to view the saved result.",
                " 列表刷新失败，请刷新查看已保存结果。",
              ),
          );
        }
      } else if (result.status === "FAILED") {
        setRetry(null);
        throw Error(result.errorCode ?? "UNAVAILABLE");
      } else
        setNotice(
          t(
            "Pending. Reconcile this same request; it will not launch another import.",
            "处理中，请核对同一次请求，不会另建导入。",
          ),
        );
    });
  }
  const locked = busy || !!retry;
  return (
    <section
      className="panel panel-pad stack"
      aria-label={t("Guided Skill import", "引导式 Skill 导入")}
    >
      <h3>{t("Add a Skill: link, upload or write", "添加 Skill：链接、上传或编写")}</h3>
      {retry && (
        <details>
          <summary>
            {t("Pending request retained for this account", "本账号待核对请求已保留")}
          </summary>
          <p>{retry.key}</p>
          <pre
            style={{
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
              maxHeight: 260,
              overflow: "auto",
            }}
          >
            {JSON.stringify(retry.body, null, 2)}
          </pre>
        </details>
      )}
      {code && (
        <div tabIndex={-1} ref={errorRef} role="alert">
          <p>{skillErrorMessage(code, locale)}</p>
          <details>
            <summary>{t("Technical details", "技术详情")}</summary>
            <code>{code}</code>
          </details>
          {code === "PREPARED_SOURCE_EXPIRED_OR_NOT_FOUND" && (
            <button
              className="btn"
              onClick={() => {
                setRetry(null);
                setPrepared(null);
                setRisk(false);
                setRights(false);
              }}
            >
              {t("Identify source again", "重新识别来源")}
            </button>
          )}
        </div>
      )}
      <label htmlFor="guided-import-kind">{t("Import method", "导入方式")}</label>
      <select
        id="guided-import-kind"
        className="input"
        disabled={locked}
        value={kind}
        onChange={(e) => {
          changed();
          setKind(e.target.value as typeof kind);
          setFiles([]);
        }}
      >
        <option value="URL">GitHub URL</option>
        <option value="AUTHORED">{t("Write a Skill", "在线编写 Skill")}</option>
        <option value="UPLOAD">{t("Upload SKILL.md", "上传 SKILL.md")}</option>
      </select>
      {kind === "URL" ? (
        <>
          <label htmlFor="guided-github-url">
            {t("GitHub repository or Skill directory URL", "GitHub 仓库或 Skill 目录链接")}
          </label>
          <input
            id="guided-github-url"
            type="url"
            className="input"
            value={url}
            disabled={locked}
            onChange={(e) => {
              changed();
              setUrl(e.target.value);
            }}
            placeholder="https://github.com/owner/repository"
          />
          <button
            className="btn"
            disabled={locked || !url.trim()}
            onClick={() =>
              void run(async () => {
                const value = await json("/api/skills/discover", { url });
                setPrepared(null);
                if (value.candidates.length === 1) {
                  setCandidates([]);
                  await prepare(value.candidates[0]);
                } else {
                  setCandidates(value.candidates);
                  setNotice(
                    value.candidates.length
                      ? t(
                          `Found ${value.candidates.length} Skills. Choose the version to preview; nothing has been imported.`,
                          `发现 ${value.candidates.length} 个 Skills。请选择要预览的版本，尚未导入。`,
                        )
                      : t(
                          "No Skill found at this source. Check the link or upload SKILL.md.",
                          "此来源未发现 Skill。请核对链接或上传 SKILL.md。",
                        ),
                  );
                }
              })
            }
          >
            {t("Preview source", "预览来源")}
          </button>
          {candidates.map((c) => (
            <button
              className="btn"
              key={c.path}
              disabled={locked}
              style={{ whiteSpace: "normal", overflowWrap: "anywhere" }}
              onClick={() => void preview(c)}
            >
              {t("Preview: ", "预览：")}
              {c.path}
            </button>
          ))}
          {prepared && (
            <div className="stack">
              <p>
                {prepared.preview.name} · {prepared.preview.description}
              </p>
              {prepared.preview.importState === "SAME_VERSION" && (
                <p>
                  {t(
                    "This exact version already exists. No duplicate import is needed; check its current availability in your library.",
                    "此具体版本已存在，无需重复导入；请在库中查看其当前可用范围。",
                  )}
                </p>
              )}
              {prepared.preview.importState === "NEW_VERSION" && (
                <>
                  <p>
                    {t(
                      "This source has changed. Save a separate version after review; previous sharing approval does not apply to the new version.",
                      "此来源已有变化。核对后另存为新版本；旧版本的共享审核不适用于新版本。",
                    )}
                  </p>
                  <label className="row">
                    <input
                      type="checkbox"
                      disabled={locked}
                      checked={versionAccepted}
                      onChange={(event) => setVersionAccepted(event.target.checked)}
                    />
                    {t(
                      "I reviewed the version change and will save a separate version.",
                      "我已核对版本变化，同意另存为新版本。",
                    )}
                  </label>
                </>
              )}
              <p>
                {t(
                  "Next: review the evidence and risk notices, then confirm import. Preview valid for one hour.",
                  "下一步：查看依据与风险提示，再确认导入。预览凭据有效期一小时。",
                )}
              </p>
              <p className="small" style={{ overflowWrap: "anywhere" }}>
                {t("Source: ", "来源：")}
                {prepared.source.repositoryOwner}/{prepared.source.repositoryName}/
                {prepared.source.path}
                <br />
                {t("Fixed version: ", "固定版本：")}
                {prepared.source.ref}
              </p>
              <EvidenceDisclosure locale={locale} label={t("Source and full text", "来源与全文")}>
                {prepared.preview.manifestSha256 && (
                  <p style={{ overflowWrap: "anywhere" }}>
                    SHA-256 {prepared.preview.manifestSha256}
                  </p>
                )}
                {prepared.preview.existingVersionId && (
                  <p>
                    {t("Existing version: ", "已有版本：")}
                    {prepared.preview.existingVersionId}
                  </p>
                )}
                <pre
                  style={{
                    whiteSpace: "pre-wrap",
                    overflowWrap: "anywhere",
                    maxHeight: 300,
                    overflow: "auto",
                  }}
                >
                  {prepared.preview.body}
                </pre>
                {prepared.preview.resources.map((r) => (
                  <p className="small" key={r.path} style={{ overflowWrap: "anywhere" }}>
                    {r.path} · {r.type} · {r.size}B · SHA-256 {r.sha256}
                  </p>
                ))}
              </EvidenceDisclosure>
              <p>{prepared.preview.warnings.join(" · ")}</p>
            </div>
          )}
        </>
      ) : (
        <>
          <label htmlFor="offline-skill-name">
            {t(
              "Skill slug (lowercase letters, digits and hyphens)",
              "Skill 标识（小写字母、数字及连字符）",
            )}
          </label>
          <input
            id="offline-skill-name"
            className="input"
            maxLength={64}
            value={name}
            disabled={locked}
            onChange={(e) => {
              changed();
              setName(e.target.value);
            }}
          />
          {kind === "AUTHORED" && (
            <>
              <label htmlFor="offline-description">
                {t("When should this Skill be used?", "何时应使用此 Skill？")}
              </label>
              <textarea
                id="offline-description"
                className="input"
                value={description}
                maxLength={1024}
                disabled={locked}
                onChange={(e) => {
                  changed();
                  setDescription(e.target.value);
                }}
              />
              <label htmlFor="offline-body">
                {t("Methods, constraints, output and verification", "方法、约束、输出及验收要求")}
              </label>
              <textarea
                id="offline-body"
                className="textarea"
                value={body}
                maxLength={60000}
                disabled={locked}
                onChange={(e) => {
                  changed();
                  setBody(e.target.value);
                }}
              />
            </>
          )}
          <label htmlFor="offline-files">
            {kind === "UPLOAD"
              ? t("SKILL.md (UTF-8)", "SKILL.md（UTF-8）")
              : t("Optional text resource files", "可选文本资源文件")}
          </label>
          <input
            id="offline-files"
            type="file"
            multiple
            disabled={locked}
            onChange={(e) => {
              const chosen = Array.from(e.target.files ?? []);
              void run(async () => {
                changed();
                if (
                  chosen.length > 64 ||
                  chosen.reduce((n, f) => n + f.size, 0) > 1048576 ||
                  chosen.some((f) => f.size > 131072)
                )
                  throw Error("BUNDLE_SIZE_LIMIT");
                const loaded = await Promise.all(
                  chosen.map(async (f) => ({
                    path: f.name,
                    content: new TextDecoder("utf-8", { fatal: true }).decode(
                      await f.arrayBuffer(),
                    ),
                  })),
                );
                setFiles(loaded);
              });
            }}
          />
          {files.map((f, i) => (
            <div className="field" key={i}>
              <label htmlFor={`offline-path-${i}`}>
                {t("Relative resource path", "资源相对路径")} {i + 1}
              </label>
              <input
                id={`offline-path-${i}`}
                className="input"
                disabled={locked}
                value={f.path}
                onChange={(e) => {
                  changed();
                  setFiles(files.map((r, n) => (n === i ? { ...r, path: e.target.value } : r)));
                }}
              />
            </div>
          ))}
          {(kind === "AUTHORED" ? !!body.trim() : files.length > 0) && (
            <details>
              <summary>{t("Review the exact content to import", "核对即将导入的完整内容")}</summary>
              <p>
                {t(
                  "Source: this account's upload / authored text. Import creates an immutable version.",
                  "来源：本账号上传／编写的文本。导入将创建不可变版本。",
                )}
              </p>
              {kind === "AUTHORED" && (
                <pre
                  className="result-body"
                  style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
                >{`---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n${body}`}</pre>
              )}
              {files.map((file, index) => (
                <div key={index}>
                  <h4>{file.path}</h4>
                  <pre
                    className="result-body"
                    style={{
                      whiteSpace: "pre-wrap",
                      overflowWrap: "anywhere",
                      maxHeight: 300,
                      overflow: "auto",
                    }}
                  >
                    {file.content}
                  </pre>
                </div>
              ))}
            </details>
          )}
          <p className="small">
            {t(
              "Matching content reuses the existing version. Changed content is saved separately and never overwrites an earlier version or its review. Review the exact content before confirming.",
              "相同内容复用已有版本；变化的内容另存新版本，不覆盖旧版本或审核记录。请核对完整内容后确认。",
            )}
          </p>
          <p className="small">
            {t(
              "No archives or filesystem paths. Up to 64 UTF-8 files, 1 MiB total. Scripts are quarantined, never executed.",
              "不接受压缩包或本机路径。最多 64 个 UTF-8 文件，总量 1 MiB。脚本隔离保存，不执行。",
            )}
          </p>
        </>
      )}
      <label className="row">
        <input
          type="checkbox"
          disabled={locked}
          checked={rights}
          onChange={(e) => setRights(e.target.checked)}
        />
        {t(
          "I have permission to retain and use this content, and to share it if publishing as administrator.",
          "我确认有权保存和使用此内容；如以管理员身份发布，也有权共享。",
        )}
      </label>
      {role === "USER" ? (
        <label className="row">
          <input
            type="checkbox"
            disabled={locked}
            checked={risk}
            onChange={(e) => setRisk(e.target.checked)}
          />
          {t(
            "I accept personal-use risks for this exact content; it is not protected by the platform.",
            "我确认承担本次内容的个人使用风险，不受平台保护。",
          )}
        </label>
      ) : (
        <p>
          {t(
            "Administrator import publishes directly to all users. Review the preview before confirming.",
            "管理员导入后直接共享给所有用户，请核对预览后确认。",
          )}
        </p>
      )}
      <button
        className="btn btn-primary"
        disabled={
          busy ||
          (!retry &&
            (!rights ||
              (role === "USER" && !risk) ||
              (kind === "URL"
                ? !prepared ||
                  prepared.preview.importState === "SAME_VERSION" ||
                  (prepared.preview.importState === "NEW_VERSION" && !versionAccepted)
                : !name.trim() ||
                  (kind === "AUTHORED"
                    ? !body.trim() || !description.trim()
                    : !files.some((f) => f.path === "SKILL.md")))))
        }
        onClick={() => void importCurrent()}
      >
        {busy
          ? t("Processing…", "处理中……")
          : retry
            ? t("Reconcile guided import", "核对引导式导入")
            : prepared?.preview.importState === "SAME_VERSION"
              ? t("Already imported", "此版本已存在")
              : role === "ADMIN"
                ? t("Import and publish to all users", "导入并发布给所有用户")
                : t("Import for personal use", "导入供本人使用")}
      </button>
      {notice && (
        <p role="status" style={{ overflowWrap: "anywhere" }}>
          {notice}
        </p>
      )}
    </section>
  );
}
