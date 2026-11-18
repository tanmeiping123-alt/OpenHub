// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));
import { AccountAuth } from "./AccountAuth";
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it("provides GitHub as the public cloud registration entry without a password signup form", () => {
  vi.stubEnv("NEXT_PUBLIC_OPENHUB_CLOUD_AUTH", "true");
  render(<AccountAuth locale="zh-CN" page="register" />);
  expect(screen.getByRole("link", { name: /GitHub/ }).getAttribute("href")).toContain("/api/auth/github");
  expect(screen.queryByLabelText("邮箱")).toBeNull();
});
it("explains email confirmation instead of telling a registered user their password is wrong", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "EMAIL_CONFIRMATION_REQUIRED" }, { status: 403 })));
  render(<AccountAuth locale="zh-CN" page="login" />);
  fireEvent.change(screen.getByLabelText("邮箱"), { target: { value: "fixture@example.com" } });
  fireEvent.change(screen.getByLabelText("密码"), { target: { value: "fixture-password" } });
  fireEvent.click(screen.getByRole("button", { name: "登录" }));
  expect((await screen.findByRole("alert")).textContent).toContain("验证邮件");
});
