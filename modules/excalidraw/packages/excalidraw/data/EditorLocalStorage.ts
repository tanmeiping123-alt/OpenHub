import type { EDITOR_LS_KEYS } from "@excalidraw/common";

import type { JSONValue } from "../types";

export class EditorLocalStorage {
  private static namespace = "";

  static setNamespace(namespace: string) {
    this.namespace = namespace;
  }

  static has(key: typeof EDITOR_LS_KEYS[keyof typeof EDITOR_LS_KEYS]) {
    try {
      return !!window.localStorage.getItem(this.namespace + key);
    } catch (error: any) {
      console.warn(`localStorage.getItem error: ${error.message}`);
      return false;
    }
  }

  static get<T extends JSONValue>(
    key: typeof EDITOR_LS_KEYS[keyof typeof EDITOR_LS_KEYS],
  ) {
    try {
      const value = window.localStorage.getItem(this.namespace + key);
      if (value) {
        return JSON.parse(value) as T;
      }
      return null;
    } catch (error: any) {
      console.warn(`localStorage.getItem error: ${error.message}`);
      return null;
    }
  }

  static set = (
    key: typeof EDITOR_LS_KEYS[keyof typeof EDITOR_LS_KEYS],
    value: JSONValue,
  ) => {
    try {
      window.localStorage.setItem(this.namespace + key, JSON.stringify(value));
      return true;
    } catch (error: any) {
      console.warn(`localStorage.setItem error: ${error.message}`);
      return false;
    }
  };

  static delete = (
    name: typeof EDITOR_LS_KEYS[keyof typeof EDITOR_LS_KEYS],
  ) => {
    try {
      window.localStorage.removeItem(this.namespace + name);
    } catch (error: any) {
      console.warn(`localStorage.removeItem error: ${error.message}`);
    }
  };
}
