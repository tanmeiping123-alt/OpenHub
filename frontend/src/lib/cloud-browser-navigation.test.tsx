// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import Link, { usePathname, useRouter, useSearchParams } from "../../cloudflare/browser-navigation";

function Location() {
  const router = useRouter();
  return <><output>{usePathname()}?{useSearchParams().toString()}</output><button onClick={() => router.replace("/zh-CN/app?promptId=one", { scroll: false })}>Replace</button></>;
}
afterEach(() => window.history.replaceState(null, "", "/"));
it("navigates local links and query updates without a server render", () => {
  window.history.replaceState(null, "", "/zh-CN/login");
  render(<><Location /><Link href="/zh-CN/open-prompts?q=hello#results">Explore</Link></>);
  fireEvent.click(screen.getByText("Explore"));
  expect(screen.getByRole("status").textContent).toBe("/zh-CN/open-prompts?q=hello");
  expect(window.location.hash).toBe("#results");
  fireEvent.click(screen.getByText("Replace"));
  expect(screen.getByRole("status").textContent).toBe("/zh-CN/app?promptId=one");
});
it("preserves modifier clicks, external links and caller cancellation", () => {
  window.history.replaceState(null, "", "/en");
  render(<><Link href="/en/app" onClick={event => event.preventDefault()}>Cancel</Link><Link href="/en/help">Help</Link><Link href="https://github.com/" target="_blank">GitHub</Link></>);
  fireEvent.click(screen.getByText("Cancel"));
  fireEvent.click(screen.getByText("Help"), { ctrlKey: true });
  expect(window.location.pathname).toBe("/en");
  expect(screen.getByText("GitHub").getAttribute("href")).toBe("https://github.com/");
});
