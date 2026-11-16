"use client";

import { useRef, useState } from "react";
import {
  anchors,
  CALIBRATION_VERSION,
  candidateLayer2,
  layer1Rubric,
} from "@/lib/calibration-rubric";
import {
  emptyAssessments,
  validateAssessments,
  type Assessment,
  type CalibrationError,
} from "@/lib/calibration";
import { useAppStore } from "@/lib/store";
import type { EvaluationReport, Locale, Prompt, PromptVersion } from "@/lib/types";

const t = (locale: Locale, en: string, zh: string) => (locale === "zh-CN" ? zh : en);
const errorCopy = (code: CalibrationError["code"], locale: Locale) =>
  ({
    STRUCTURE: t(
      locale,
      "Invalid judgment. Choose a valid state.",
      "判断结构无效，请选择有效状态。",
    ),
    REASON: t(
      locale,
      "Explain the judgment, N/A or missing evidence.",
      "请说明判断、不适用或缺证据的原因。",
    ),
    ANCHOR: t(locale, "Choose a supported anchor.", "请选择有证据支持的锚点。"),
    EXCERPT: t(
      locale,
      "Paste an exact excerpt from the source version, without quotation marks added around it.",
      "请粘贴来源版本中的精确原文，不额外添加引号。",
    ),
    EVIDENCE_KIND: t(locale, "Choose an evidence type.", "请选择证据类型。"),
  })[code];

export function CalibrationPanel({
  locale,
  prompt,
  version,
  disabled,
}: {
  locale: Locale;
  prompt: Prompt;
  version: PromptVersion;
  disabled: boolean;
}) {
  const { dispatch } = useAppStore();
  const [assessments, setAssessments] = useState<Assessment[]>(emptyAssessments);
  const [errors, setErrors] = useState<CalibrationError[]>([]);
  const [saved, setSaved] = useState(false);
  const [savedToDatabase, setSavedToDatabase] = useState(false);
  const summary = useRef<HTMLDivElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const profile = candidateLayer2[prompt.taskType];
  const update = (id: string, patch: Partial<Assessment>) => {
    setAssessments((items) => items.map((a) => (a.indicatorId === id ? { ...a, ...patch } : a)));
    setSaved(false);
    setSavedToDatabase(false);
  };
  return (
    <section
      className="panel panel-pad"
      style={{ marginTop: 18 }}
      aria-labelledby="calibration-title"
    >
      <h2 id="calibration-title">{t(locale, "Local candidate calibration", "本地候选校准")}</h2>
      <p className="small subtle" style={{ marginTop: 8 }}>
        {CALIBRATION_VERSION} ·{" "}
        {t(
          locale,
          "Human judgments with experimental aggregation; no AI, no official grade. Unfinished judgments stay unscored. Unsaved form entries are temporary.",
          "人工判断与实验性聚合；不调用 AI、不生成正式等级。未完成判断保留无分数，未提交表单仅临时保存。",
        )}
      </p>
      <details style={{ marginTop: 14 }}>
        <summary>{t(locale, "Review exact source text", "查看精确来源原文")}</summary>
        <p className="small subtle">
          {version.id} ·{" "}
          {t(
            locale,
            "Evidence uses this stored text; switching interface language does not translate the source.",
            "证据以此存储原文为准；切换界面语言不翻译证据来源。",
          )}
        </p>
        <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontFamily: "inherit" }}>
          {version.content}
        </pre>
      </details>
      <details style={{ marginTop: 14 }}>
        <summary>
          {t(
            locale,
            "Layer 1 evidence assessment (24 indicators)",
            "Layer 1 证据判断（24 项指标）",
          )}
        </summary>
        <p className="small subtle" style={{ margin: "12px 0" }}>
          {t(
            locale,
            "Each indicator has 25% internal weight. Checkpoint guidance has no numeric weights. Score only material judgments supported by evidence; explain N/A. Do not penalize length or demand irrelevant roles, formats or background.",
            "每维 4 项指标各占内部权重 25%；检查提示不设数值权重。仅在实质证据充分时选锚点，不适用须说明；不因篇幅或无关角色、格式、背景扣分。",
          )}
        </p>
        <form
          ref={form}
          noValidate
          onSubmit={async (event) => {
            event.preventDefault();
            if (disabled) return;
            const found = validateAssessments(version.content, assessments);
            setErrors(found);
            if (found.length) {
              form.current?.querySelectorAll("details").forEach((el) => {
                if (found.some((e) => el.querySelector(`[id='${e.indicatorId}-state']`)))
                  el.open = true;
              });
              requestAnimationFrame(() => summary.current?.focus());
              return;
            }
            const persistence = await dispatch({
              type: "CALIBRATE",
              promptId: prompt.id,
              versionId: version.id,
              assessments,
            });
            setSaved(persistence !== "unavailable");
            setSavedToDatabase(persistence === "database");
          }}
        >
          {errors.length > 0 && (
            <div
              ref={summary}
              role="alert"
              tabIndex={-1}
              className="notice"
              style={{ display: "block", marginBottom: 16 }}
            >
              <h3>{t(locale, "Check the assessment", "请检查以下判断")}</h3>
              <ul>
                {errors.map((error, index) => (
                  <li key={`${error.indicatorId}-${index}`}>
                    <a href={`#${error.indicatorId}-state`}>
                      {error.indicatorId} · {errorCopy(error.code, locale)}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <fieldset disabled={disabled} style={{ border: 0, padding: 0, minWidth: 0 }}>
            {layer1Rubric.map((dimension) => (
              <details key={dimension.id} className="version-item" style={{ marginBottom: 12 }}>
                <summary>
                  <strong>{dimension.name[locale]}</strong> · {dimension.weight}%
                </summary>
                {dimension.indicators.map((indicator) => {
                  const a = assessments.find((item) => item.indicatorId === indicator.id)!;
                  const fieldErrors = errors.filter((error) => error.indicatorId === indicator.id);
                  const prefix = indicator.id;
                  return (
                    <fieldset
                      key={prefix}
                      style={{
                        border: "1px solid var(--border, #e2e8f0)",
                        borderRadius: 8,
                        padding: 14,
                        margin: "14px 0",
                        minWidth: 0,
                      }}
                    >
                      <legend>{indicator.name[locale]} · 25%</legend>
                      <p className="small subtle" style={{ marginBottom: 12 }}>
                        {indicator.checkpoint[locale]}
                      </p>
                      <div className="stack">
                        <label htmlFor={`${prefix}-state`}>
                          {t(locale, "Judgment", "判断状态")}
                        </label>
                        <select
                          className="select"
                          id={`${prefix}-state`}
                          value={a.status}
                          aria-invalid={fieldErrors.length > 0}
                          aria-describedby={fieldErrors.length ? `${prefix}-errors` : undefined}
                          onChange={(e) =>
                            update(prefix, {
                              status: e.target.value as Assessment["status"],
                              anchor: "",
                              excerpt: "",
                              nonMaterialUnknown: "",
                              criticalDefect: false,
                            })
                          }
                        >
                          <option value="INSUFFICIENT_INFORMATION">
                            {t(locale, "Insufficient Information", "信息不足")}
                          </option>
                          <option value="SCORED">
                            {t(locale, "Evidence sufficient for an anchor", "证据足以判断锚点")}
                          </option>
                          <option value="NOT_APPLICABLE">
                            {t(locale, "N/A — does not apply", "N/A — 确实不适用")}
                          </option>
                          <option value="NOT_VERIFIED">
                            {t(
                              locale,
                              "Not Verified — required verification pending",
                              "未验证 — 必要核验尚未完成",
                            )}
                          </option>
                        </select>
                        {a.status === "SCORED" && (
                          <>
                            <label htmlFor={`${prefix}-anchor`}>
                              {t(
                                locale,
                                "Behavior anchor (candidate representative value)",
                                "行为锚点（候选代表值）",
                              )}
                            </label>
                            <select
                              className="select"
                              id={`${prefix}-anchor`}
                              value={a.anchor}
                              onChange={(e) =>
                                update(prefix, { anchor: e.target.value as Assessment["anchor"] })
                              }
                            >
                              <option value="">
                                {t(locale, "Choose an anchor", "请选择锚点")}
                              </option>
                              {anchors.map((anchor) => (
                                <option value={anchor.id} key={anchor.id}>
                                  {anchor.id} · {anchor.score} · {anchor.name[locale]}
                                </option>
                              ))}
                            </select>
                            <label htmlFor={`${prefix}-kind`}>
                              {t(locale, "Evidence type", "证据类型")}
                            </label>
                            <select
                              className="select"
                              id={`${prefix}-kind`}
                              value={a.evidenceKind}
                              onChange={(e) =>
                                update(prefix, {
                                  evidenceKind: e.target.value as Assessment["evidenceKind"],
                                  excerpt: "",
                                })
                              }
                            >
                              <option value="EXCERPT">
                                {t(locale, "Exact source excerpt", "原文精确摘录")}
                              </option>
                              <option value="OBSERVED_ABSENCE">
                                {t(
                                  locale,
                                  "Observable omission after reviewing the entire version",
                                  "检查完整版本后发现可见缺失",
                                )}
                              </option>
                            </select>
                            {a.evidenceKind === "EXCERPT" ? (
                              <>
                                <label htmlFor={`${prefix}-excerpt`}>
                                  {t(locale, "Exact excerpt", "精确摘录")}
                                </label>
                                <textarea
                                  className="textarea"
                                  id={`${prefix}-excerpt`}
                                  rows={2}
                                  value={a.excerpt}
                                  onChange={(e) => update(prefix, { excerpt: e.target.value })}
                                />
                              </>
                            ) : (
                              <p className="small subtle">
                                {t(
                                  locale,
                                  "Your reason must name the necessary missing requirement and its impact. The reviewed scope is the entire stored version. Unreadable attachments do not prove omission.",
                                  "理由须说明缺少的必要要求及影响；检查范围为完整存储版本。附件不可读不能证明要求缺失。",
                                )}
                              </p>
                            )}
                            <label htmlFor={`${prefix}-unknown`}>
                              {t(
                                locale,
                                "Non-material unknowns and why they cannot change this anchor (optional)",
                                "非关键未知项及不影响锚点的理由（可选）",
                              )}
                            </label>
                            <textarea
                              className="textarea"
                              id={`${prefix}-unknown`}
                              rows={2}
                              value={a.nonMaterialUnknown}
                              onChange={(e) =>
                                update(prefix, { nonMaterialUnknown: e.target.value })
                              }
                            />
                            <label>
                              <input
                                type="checkbox"
                                checked={a.criticalDefect}
                                onChange={(e) =>
                                  update(prefix, { criticalDefect: e.target.checked })
                                }
                              />{" "}
                              {t(
                                locale,
                                "Critical defect — explain impact below; no extra deduction/cap",
                                "关键缺陷 — 下方说明影响；不额外扣分或封顶",
                              )}
                            </label>
                          </>
                        )}
                        <label htmlFor={`${prefix}-reason`}>
                          {t(
                            locale,
                            "Reason / missing evidence / applicability",
                            "判断理由／缺少证据／适用性",
                          )}
                        </label>
                        <textarea
                          className="textarea"
                          id={`${prefix}-reason`}
                          rows={2}
                          value={a.reason}
                          onChange={(e) => update(prefix, { reason: e.target.value })}
                          aria-describedby={fieldErrors.length ? `${prefix}-errors` : undefined}
                        />
                        <label>
                          <input
                            type="checkbox"
                            checked={a.verificationPending}
                            onChange={(e) =>
                              update(prefix, { verificationPending: e.target.checked })
                            }
                          />{" "}
                          {t(
                            locale,
                            "Actual outcome not verified (separate from clarity of the instruction)",
                            "实际结果尚未核验（与指令本身是否清楚分开）",
                          )}
                        </label>
                        {fieldErrors.length > 0 && (
                          <ul id={`${prefix}-errors`} className="small">
                            {fieldErrors.map((error) => (
                              <li key={error.code}>{errorCopy(error.code, locale)}</li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </fieldset>
                  );
                })}
              </details>
            ))}
            <button className="btn btn-primary" type="submit">
              {t(locale, "Save candidate calibration report", "保存候选校准报告")}
            </button>
          </fieldset>
          {disabled && (
            <p role="status">
              {t(
                locale,
                "Save your edited draft as a new version first.",
                "请先将修改后的草稿保存为新版本。",
              )}
            </p>
          )}
          {saved && (
            <p role="status">
              {t(
                locale,
                savedToDatabase
                  ? "Candidate report saved to the local demo database. Grade is pending; no official engine or model call."
                  : "Candidate report saved for this browser session. Grade is pending; no official engine or model call.",
                savedToDatabase
                  ? "候选报告已保存到本地演示数据库。等级待确认，未运行正式引擎或调用模型。"
                  : "候选报告已保存在当前浏览器会话。等级待确认，未运行正式引擎或调用模型。",
              )}
            </p>
          )}
        </form>
      </details>
      {profile && (
        <details style={{ marginTop: 14 }}>
          <summary>
            {t(locale, "Layer 2 experimental profile — no score", "Layer 2 实验性方案 — 不出分")}
          </summary>
          <p className="small subtle">
            {t(
              locale,
              "Candidate weights require real calibration. No internal 50/50 assumption is enabled as an approved rule.",
              "候选权重仍需真实校准；未将内部 50/50 假设启用为已批准规则。",
            )}
          </p>
          {profile.map((d) => (
            <div className="version-item" key={d.name.en}>
              <strong>
                {d.name[locale]} · {d.weight}% {t(locale, "candidate", "候选")}
              </strong>
              <p className="small subtle">{d.checkpoints[locale]}</p>
            </div>
          ))}
        </details>
      )}
    </section>
  );
}

export function CalibrationEvidence({
  report,
  locale,
}: {
  report: EvaluationReport;
  locale: Locale;
}) {
  if (!report.calibration) return null;
  const c = report.calibration;
  return (
    <section className="panel panel-pad" style={{ marginTop: 18 }}>
      <h2>{t(locale, "Calibration evidence snapshot", "校准证据快照")}</h2>
      <p className="small subtle">
        {report.id} · {report.versionId} · {c.rubricVersion}
      </p>
      <p>
        {t(
          locale,
          "Candidate score uses full precision internally; display rounds to two decimals. Grade remains null; Q anchors are not letter grades.",
          "候选分内部不逐级舍入，显示保留两位小数；等级保留 null，Q 锚点不等于字母等级。",
        )}
      </p>
      {c.rubric.map((d) => (
        <details className="version-item" key={d.id}>
          <summary>
            {d.name[locale]} · {d.weight}%
          </summary>
          {d.indicators.map((i) => {
            const a = c.assessments.find((item) => item.indicatorId === i.id)!;
            const state =
              a.status === "SCORED"
                ? `${a.anchor} · ${anchors.find((anchor) => anchor.id === a.anchor)?.score}`
                : a.status === "NOT_APPLICABLE"
                  ? "N/A"
                  : a.status === "NOT_VERIFIED"
                    ? t(locale, "Not Verified", "未验证")
                    : t(locale, "Insufficient Information", "信息不足");
            return (
              <div key={i.id} style={{ margin: "14px 0", overflowWrap: "anywhere" }}>
                <strong>
                  {i.name[locale]} · {state}
                </strong>
                <p style={{ whiteSpace: "pre-wrap" }}>{a.reason}</p>
                {a.status === "SCORED" &&
                  (a.evidenceKind === "EXCERPT" ? (
                    <blockquote style={{ whiteSpace: "pre-wrap" }}>
                      “{a.excerpt}”
                      <footer className="small subtle">
                        {t(locale, "Source offset (UTF-16)", "来源位置（UTF-16）")}:{" "}
                        {c.assessedText.indexOf(a.excerpt)} · {report.versionId}
                      </footer>
                    </blockquote>
                  ) : (
                    <p className="small subtle">
                      {t(
                        locale,
                        "Observed omission; inspected the entire stored version",
                        "可观察缺失；已检查完整存储版本",
                      )}{" "}
                      · {report.versionId}
                    </p>
                  ))}
                {a.nonMaterialUnknown && (
                  <p>
                    {t(locale, "Non-material unknown: ", "非关键未知：")}
                    {a.nonMaterialUnknown}
                  </p>
                )}
                {a.verificationPending && (
                  <p className="small">
                    {t(
                      locale,
                      "NOT_VERIFIED: actual outcome has not been checked.",
                      "未验证：尚未核验实际结果。",
                    )}
                  </p>
                )}
                {a.criticalDefect && (
                  <p className="notice">
                    {t(
                      locale,
                      "Critical defect — examine the evidence before relying on this result.",
                      "关键缺陷 — 使用结果前请审查证据及其影响。",
                    )}
                  </p>
                )}
              </div>
            );
          })}
        </details>
      ))}
    </section>
  );
}
