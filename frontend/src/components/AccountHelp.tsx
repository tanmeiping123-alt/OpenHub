import Link from "next/link";
import type { Locale } from "@/lib/types";

export function AccountHelp({ locale }: { locale: Locale }) {
  const t = (en: string, zh: string) => (locale === "zh-CN" ? zh : en);
  return (
    <main className="public-main help-page">
      <section className="panel panel-pad stack" aria-labelledby="help-title">
        <h1 id="help-title">{t("Account help", "账号帮助")}</h1>
        <section id="recovery" className="stack">
          <h2>{t("Forgot password / account recovery", "忘记密码 / 账号恢复")}</h2>
          <p className="notice">
            {t(
              "Account recovery is not implemented. Email reset links, verification codes and self-service password resets are not available.",
              "账号恢复尚未实现。目前不支持邮件重置链接、验证码找回或自助重置密码。",
            )}
          </p>
          <p>
            {t(
              "First check the registered email, keyboard layout and your password manager. You can reveal the password on the login form to check your input.",
              "请先检查注册邮箱、键盘大小写及密码管理器记录；登录页可显示密码以核对输入。",
            )}
          </p>
          <p>
            {t(
              "If you still cannot sign in, contact the platform operator through your existing trusted channel to report the issue. There is no published recovery contact or guaranteed administrator reset process. Do not share passwords, API keys or payment credentials.",
              "仍无法登录时，请通过你已有的可信渠道向平台运营者反馈。目前未公布专用恢复联系方式，也没有已上线的管理员重置流程。请勿提供密码、API key 或付款敏感凭据。",
            )}
          </p>
          <p>
            {t(
              "A new account does not restore the original account's prompts, private Skills or subscription. Do not pay again to try to recover access.",
              "注册新账号不会恢复原账号的 Prompt、私人 Skills 或订阅，请勿通过重复付款尝试恢复访问。",
            )}
          </p>
        </section>
        <section className="stack">
          <h2>{t("Sign-in help", "登录使用说明")}</h2>
          <p>
            {t(
              "No account yet? Register before using the workspace. An expired session requires signing in again; signing out does not delete saved work. Registration creates a regular user, not an administrator.",
              "没有账号需先注册才能使用工作区。会话失效后需重新登录，退出登录不会删除已保存内容。注册仅创建普通用户，不能自行获取管理员权限。",
            )}
          </p>
        </section>
        <div className="result-action-row">
          <Link className="btn btn-primary" href={`/${locale}/login`}>
            {t("Back to login", "返回登录")}
          </Link>
          <Link className="btn" href={`/${locale}/register`}>
            {t("Create account", "注册账号")}
          </Link>
        </div>
      </section>
    </main>
  );
}
