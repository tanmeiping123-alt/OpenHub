"use client";
/* eslint-disable @next/next/no-img-element -- Isolated, authorized live frames are blob URLs and must never enter the image optimization cache. */
import { useEffect, useRef, useState } from "react";
import { Pause, Play, X } from "lucide-react";
import type { Locale } from "@/lib/types";
import type { PelicanPreviewSession, PelicanSample } from "@/lib/pelican-types";
import { SampleMeta } from "./PelicanPage";
import { PelicanError, post, sampleStatus, text } from "./client";

export function PelicanPreview({
  sample,
  locale,
  onClose,
  onUnavailable,
}: {
  sample: PelicanSample;
  locale: Locale;
  onClose: () => void;
  onUnavailable: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const session = useRef<PelicanPreviewSession | null>(null);
  const [ready, setReady] = useState(false);
  const [paused, setPaused] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [frame, setFrame] = useState<string | null>(null);
  const active = useRef(true);
  const lock = useRef(false);
  const playable = sample.callStatus === "SUCCEEDED" && sample.previewStatus === "READY";
  const unavailable = useRef(onUnavailable);
  useEffect(() => {
    unavailable.current = onUnavailable;
  }, [onUnavailable]);
  useEffect(() => {
    let disposed = false;
    const origin = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const element = dialog.current;
    active.current = true;
    element?.showModal();
    if (playable)
      void post<PelicanPreviewSession>("/api/pelican/preview", { sampleId: sample.id })
        .then((value) => {
          if (disposed) {
            void post(`/api/pelican/preview/${encodeURIComponent(value.sessionId)}`, {
              action: "close",
            }).catch(() => {});
            return;
          }
          session.current = value;
          setPaused(value.paused);
          setReady(true);
        })
        .catch((e) => {
          if (disposed) return;
          if (e instanceof PelicanError && [403, 404, 410].includes(e.status))
            unavailable.current();
          else setError(true);
        });
    return () => {
      disposed = true;
      active.current = false;
      element?.close();
      origin?.focus();
      if (session.current) {
        const id = session.current.sessionId;
        session.current = null;
        void post(`/api/pelican/preview/${encodeURIComponent(id)}`, { action: "close" }).catch(
          () => {},
        );
      }
    };
  }, [playable, sample.id]);
  useEffect(() => {
    if (!ready || paused || error || !session.current) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let objectUrl: string | null = null;
    const controller = new AbortController();
    const sessionId = session.current.sessionId;
    async function next() {
      try {
        const response = await fetch(`/api/pelican/preview/${encodeURIComponent(sessionId)}`, {
          cache: "no-store",
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]),
        });
        if (!response.ok) throw new PelicanError(response.status);
        const blob = await response.blob();
        if (stopped) return;
        const nextUrl = URL.createObjectURL(blob);
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        objectUrl = nextUrl;
        setFrame((previous) => {
          if (previous && previous !== objectUrl) URL.revokeObjectURL(previous);
          return nextUrl;
        });
        timer = setTimeout(() => {
          void next();
        }, 250);
      } catch (e) {
        if (stopped) return;
        if (e instanceof PelicanError && [403, 404, 410].includes(e.status)) unavailable.current();
        else setError(true);
      }
    }
    void next();
    return () => {
      stopped = true;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [ready, paused, error]);
  useEffect(
    () => () => {
      if (frame) URL.revokeObjectURL(frame);
    },
    [frame],
  );
  async function toggle() {
    if (!session.current || lock.current || error) return;
    lock.current = true;
    setBusy(true);
    try {
      await post(`/api/pelican/preview/${encodeURIComponent(session.current.sessionId)}`, {
        action: paused ? "resume" : "pause",
      });
      if (active.current) setPaused(!paused);
    } catch (e) {
      if (active.current) {
        if (e instanceof PelicanError && [403, 404, 410].includes(e.status)) unavailable.current();
        else setError(true);
      }
    } finally {
      lock.current = false;
      if (active.current) setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="pelican-dialog"
      aria-labelledby="pelican-preview-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onClose();
        }
      }}
    >
      <header className="pelican-dialog-header">
        <div>
          <h2 id="pelican-preview-title">{sample.modelName}</h2>
          <p>
            {sample.requestedModel}
            {sample.resolvedModel && sample.resolvedModel !== sample.requestedModel
              ? ` / ${sample.resolvedModel}`
              : ""}
          </p>
        </div>
        <button
          className="pelican-button pelican-icon-button"
          onClick={onClose}
          aria-label={text(locale, "Close preview", "关闭预览")}
        >
          <X size={22} aria-hidden="true" />
        </button>
      </header>
      <div className="pelican-dialog-meta">
        <SampleMeta sample={sample} locale={locale} />
        <span>{text(locale, "Beijing time (UTC+8)", "北京时间 UTC+8")}</span>
      </div>
      <div className="pelican-stage">
        {playable && frame ? (
          <img src={frame} alt={text(locale, "Actual animation frame", "作品真实动画画面")} />
        ) : sample.hasThumbnail && !playable ? (
          <img
            src={`/api/pelican/samples/${encodeURIComponent(sample.id)}/thumbnail`}
            alt={text(locale, "Work preview", "作品预览画面")}
            onError={onUnavailable}
          />
        ) : (
          <p role="status">
            {playable && !error
              ? text(locale, "Opening the animation…", "正在打开动画…")
              : sampleStatus(sample, locale)}
          </p>
        )}
      </div>
      <div className="pelican-player-controls">
        {error ? (
          <p role="alert">
            {text(
              locale,
              "Preview stopped responding. Close and reopen to check availability. Playback state is unconfirmed.",
              "预览连接中断，播放状态待确认。请关闭后重新打开以核对可用状态。",
            )}
          </p>
        ) : playable ? (
          <>
            <button
              className="pelican-button pelican-primary"
              disabled={!ready || busy}
              onClick={() => void toggle()}
            >
              {paused ? (
                <Play size={17} aria-hidden="true" />
              ) : (
                <Pause size={17} aria-hidden="true" />
              )}
              {paused
                ? text(locale, "Continue cycling", "继续骑行")
                : text(locale, "Pause cycling", "暂停骑行")}
            </button>
            <span role="status">
              {!ready
                ? text(locale, "Connecting", "正在连接")
                : paused
                  ? text(locale, "Paused at the current frame", "已暂停在当前画面")
                  : text(locale, "Playing original animation", "正在播放原作动画")}
            </span>
          </>
        ) : (
          <p>
            {sample.previewStatus === "STATIC"
              ? text(
                  locale,
                  "No visual change was observed during the preview check.",
                  "预览观察时段内，未观察到画面变化。",
                )
              : text(
                  locale,
                  "This result cannot be played with the current preview controls.",
                  "此结果无法使用当前预览控制播放。",
                )}
          </p>
        )}
      </div>
      <details className="pelican-snapshot pelican-preview-details">
        <summary>
          {text(locale, "Test conditions and preview details", "本次条件与预览说明")}
        </summary>
        <dl>
          <dt>{text(locale, "Provider", "调用渠道")}</dt>
          <dd>{sample.provider}</dd>
          <dt>{text(locale, "Output token limit", "输出 token 上限")}</dt>
          <dd>{sample.maxOutputTokens}</dd>
          <dt>{text(locale, "Reasoning token reserve", "思考 token 预留")}</dt>
          <dd>{sample.reasoningTokenReserve}</dd>
          <dt>{text(locale, "Timeout", "等待上限")}</dt>
          <dd>
            {sample.timeoutMs === 0
              ? text(locale, "No application deadline", "不限等待时间")
              : `${sample.timeoutMs / 1000} s`}
          </dd>
          <dt>{text(locale, "Finish reason", "完成原因")}</dt>
          <dd>{sample.finishReason ?? text(locale, "Not recorded", "未记录")}</dd>
          {sample.previewReason && (
            <>
              <dt>{text(locale, "Preview explanation", "预览处理说明")}</dt>
              <dd>{sample.previewReason}</dd>
            </>
          )}
        </dl>
      </details>
      <p className="pelican-preview-note">
        {text(
          locale,
          "An isolated environment sends image frames only. Preview controls do not call a model.",
          "画面来自隔离运行环境。预览、暂停和继续均不调用模型。",
        )}
      </p>
    </dialog>
  );
}
