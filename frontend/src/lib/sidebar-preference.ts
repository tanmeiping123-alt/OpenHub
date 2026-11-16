"use client";

import { useSyncExternalStore } from "react";

const key = "promptmaster-sidebar-collapsed";
const event = "promptmaster-sidebar-change";
let memory: boolean | undefined;
function snapshot() {
  if (memory !== undefined) return memory;
  try {
    return localStorage.getItem(key) === "true";
  } catch {
    return false;
  }
}
function subscribe(listener: () => void) {
  const storage = (e: StorageEvent) => {
    if (e.key === key || e.key === null) {
      memory = undefined;
      listener();
    }
  };
  window.addEventListener("storage", storage);
  window.addEventListener(event, listener);
  return () => {
    window.removeEventListener("storage", storage);
    window.removeEventListener(event, listener);
  };
}
const serverSnapshot = () => false;
export function useSidebarPreference() {
  const collapsed = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  const toggle = () => {
    memory = !snapshot();
    try {
      localStorage.setItem(key, String(memory));
      memory = undefined;
    } catch {
      /* Keep the control usable when storage is blocked. */
    }
    window.dispatchEvent(new Event(event));
  };
  return { collapsed, toggle };
}
