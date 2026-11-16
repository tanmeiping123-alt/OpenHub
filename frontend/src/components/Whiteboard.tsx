"use client";

import { useEffect, useRef, useState } from "react";
import { RotateCcw } from "lucide-react";
import type { Locale } from "@/lib/types";
import { useAppStore } from "@/lib/store";

export function Whiteboard({ locale }: { locale: Locale }) {
  const zh = locale === "zh-CN";
  const title = zh ? "Excalidraw 白板" : "Excalidraw whiteboard";
  const { accountId } = useAppStore();
  const source = `/modules/excalidraw/index.html?lng=${locale}&embed=true&owner=${encodeURIComponent(accountId ?? "")}`;
  const frame = useRef<HTMLIFrameElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    if (status !== "loading") return;
    const ownerWindow = frame.current?.ownerDocument.defaultView;
    if (!ownerWindow) return;
    const timer = ownerWindow.setTimeout(() => setStatus("error"), 20000);
    return () => ownerWindow.clearTimeout(timer);
  }, [status, attempt]);

  return (
    <section className="whiteboard-workspace" aria-label={title}>
      <div className="whiteboard-canvas" aria-busy={status === "loading"}>
        <iframe
          ref={frame}
          key={attempt}
          title={title}
          src={source}
          referrerPolicy="same-origin"
          allow="clipboard-read; clipboard-write; fullscreen"
          allowFullScreen
          onLoad={(event) => {
            const root = event.currentTarget.contentDocument?.getElementById("root");
            setStatus(root ? "ready" : "error");
          }}
          onError={() => setStatus("error")}
        />
        {status !== "ready" && (
          <div className="whiteboard-status" role="status">
            <p>
              {status === "loading"
                ? zh
                  ? "正在加载白板…"
                  : "Loading whiteboard…"
                : zh
                  ? "白板暂时无法加载，请重试。"
                  : "The whiteboard could not load. Please retry."}
            </p>
            {status === "error" && (
              <button
                className="btn"
                onClick={() => {
                  setStatus("loading");
                  setAttempt((value) => value + 1);
                }}
              >
                <RotateCcw size={15} aria-hidden="true" />
                {zh ? "重新加载" : "Reload"}
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
