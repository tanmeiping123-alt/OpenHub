"use client";

import { useEffect } from "react";
import { Check, X } from "lucide-react";
import { useAppStore } from "@/lib/store";
import { localizedNotice } from "@/lib/fixtures";

export function GlobalNotice() {
  const { state, dispatch } = useAppStore();
  useEffect(() => {
    if (!state.notice) return;
    const timer = window.setTimeout(() => dispatch({ type: "NOTICE", message: null }), 4200);
    return () => window.clearTimeout(timer);
  }, [state.notice, dispatch]);
  if (!state.notice) return null;
  return (
    <div className="toast" role="status">
      <span className="row">
        <Check size={16} />
        {localizedNotice(state.notice, state.locale)}
        <button
          className="icon-btn"
          style={{ width: 26, height: 26, marginLeft: "auto" }}
          aria-label={state.locale === "zh-CN" ? "关闭通知" : "Dismiss notification"}
          onClick={() => dispatch({ type: "NOTICE", message: null })}
        >
          <X size={14} />
        </button>
      </span>
    </div>
  );
}
