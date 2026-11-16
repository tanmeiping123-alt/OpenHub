"use client";
import { useId, useState } from "react";
import { normalizeTags, purposes, type PromptDescriptor } from "@/lib/prompt-description";
import type { Locale } from "@/lib/types";

export function PromptDescriptorFields({
  locale,
  value,
  onChange,
  disabled = false,
}: {
  locale: Locale;
  value: PromptDescriptor;
  onChange: (value: PromptDescriptor) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const [tag, setTag] = useState("");
  const [error, setError] = useState("");
  const t = (en: string, zh: string) => (locale === "zh-CN" ? zh : en);
  function addTag() {
    if (!tag.trim()) return;
    try {
      onChange({
        ...value,
        tags: normalizeTags([
          ...value.tags,
          ...tag
            .split(/[,，]/)
            .map((v) => v.trim())
            .filter(Boolean),
        ]),
      });
      setTag("");
      setError("");
    } catch {
      setError(
        t(
          "Use up to 12 short tags, at most 40 characters each, without links.",
          "最多添加 12 个标签，每个不超过 40 字，不含链接。",
        ),
      );
    }
  }
  return (
    <div className="stack descriptor-fields">
      <fieldset disabled={disabled}>
        <legend>{t("Purposes", "用途")}</legend>
        <div className="descriptor-purposes">
          {purposes.map((p) => (
            <label key={p.id}>
              <input
                type="checkbox"
                checked={value.purposes.includes(p.id)}
                onChange={(e) =>
                  onChange({
                    ...value,
                    purposes: e.target.checked
                      ? [...value.purposes, p.id]
                      : value.purposes.filter((v) => v !== p.id),
                  })
                }
              />
              {p.name[locale]}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="row descriptor-tags">
        {value.tags.map((name) => (
          <button
            type="button"
            className="btn btn-sm"
            disabled={disabled}
            key={name}
            aria-label={t(`Remove tag: ${name}`, `移除标签：${name}`)}
            onClick={() => onChange({ ...value, tags: value.tags.filter((v) => v !== name) })}
          >
            {name}
            <span aria-hidden="true"> ×</span>
          </button>
        ))}
      </div>
      <div className="field">
        <label htmlFor={id}>{t("Add a tag", "添加标签")}</label>
        <div className="row">
          <input
            id={id}
            className="input"
            value={tag}
            disabled={disabled}
            maxLength={200}
            onChange={(e) => setTag(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addTag();
              }
            }}
          />
          <button type="button" className="btn" disabled={disabled || !tag.trim()} onClick={addTag}>
            {t("Add", "添加")}
          </button>
        </div>
      </div>
      {error && <p role="alert">{error}</p>}
      <button
        type="button"
        className="btn btn-sm"
        disabled={disabled}
        onClick={() => {
          onChange({ purposes: [], tags: [] });
          setError("");
          setTag("");
        }}
      >
        {t("Clear purposes and tags", "清空用途和标签")}
      </button>
    </div>
  );
}
