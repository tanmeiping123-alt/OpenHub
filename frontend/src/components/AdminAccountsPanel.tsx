"use client";
import { useEffect, useState } from "react";
import type { Locale } from "@/lib/types";

type AccountRow = { id: string; email: string; disabled: boolean };
type Accounts = { administrators: AccountRow[]; users: AccountRow[] };

export function AdminAccountsPanel({ locale }: { locale: Locale }) {
  const t = (en: string, zh: string) => (locale === "zh-CN" ? zh : en);
  const [admin, setAdmin] = useState(false);
  const [accounts, setAccounts] = useState<Accounts | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/auth/session", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) return;
        const session = await response.json();
        if (!controller.signal.aborted) setAdmin(session.user?.role === "ADMIN");
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);

  async function loadAccounts() {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      const response = await fetch("/api/accounts", { cache: "no-store" });
      if (response.status === 401 || response.status === 403) {
        setAccounts(null);
        setAdmin(false);
        return;
      }
      if (!response.ok) throw Error("ACCOUNTS_UNAVAILABLE");
      setAccounts(await response.json());
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  if (!admin) return null;
  return (
    <section
      className="panel panel-pad"
      aria-label={t("Administrator accounts", "管理员账号管理")}
      style={{ gridColumn: "1 / -1" }}
    >
      <details>
        <summary style={{ minHeight: 44, cursor: "pointer" }}>
          {t("Account management", "账号管理")}
        </summary>
        <button className="btn" disabled={busy} onClick={() => void loadAccounts()}>
          {busy ? t("Loading…", "正在加载……") : t("Load account tables", "查看账号表")}
        </button>
        {failed && (
          <p role="alert">
            {t("Account tables unavailable. Please retry.", "账号表暂不可用，请重试。")}
          </p>
        )}
        {accounts &&
          (
            [
              ["administrators", t("Administrators / reviewers", "管理员 / 审核人")],
              ["users", t("Regular users", "普通用户")],
            ] as const
          ).map(([key, label]) => (
            <div key={key}>
              <h3>{label}</h3>
              <table style={{ width: "100%", tableLayout: "fixed" }}>
                <thead>
                  <tr>
                    <th>{t("Email", "邮箱")}</th>
                    <th style={{ width: "25%" }}>{t("Status", "状态")}</th>
                  </tr>
                </thead>
                <tbody>
                  {accounts[key].map((account) => (
                    <tr key={account.id}>
                      <td style={{ overflowWrap: "anywhere" }}>{account.email}</td>
                      <td>{account.disabled ? t("Disabled", "已停用") : t("Active", "正常")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
      </details>
    </section>
  );
}
