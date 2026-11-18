import { forwardRef, useSyncExternalStore, type AnchorHTMLAttributes } from "react";

const changed = "openhub:navigation";
function subscribe(listener: () => void) {
  window.addEventListener("popstate", listener);
  window.addEventListener(changed, listener);
  return () => { window.removeEventListener("popstate", listener); window.removeEventListener(changed, listener); };
}
function currentLocation() { return window.location.pathname + window.location.search; }
function useLocation() { return useSyncExternalStore(subscribe, currentLocation, () => "/en"); }
export function usePathname() { return useLocation().split("?")[0]; }
export function useSearchParams() { const location = useLocation(); return new URLSearchParams(location.includes("?") ? location.slice(location.indexOf("?") + 1) : ""); }
type Options = { scroll?: boolean };
function navigate(href: string, replace = false, options?: Options) {
  const url = new URL(href, window.location.href);
  if (!["http:", "https:"].includes(url.protocol)) return;
  if (url.origin !== window.location.origin) { window.location.assign(url.href); return; }
  window.history[replace ? "replaceState" : "pushState"](null, "", url.pathname + url.search + url.hash);
  window.dispatchEvent(new Event(changed));
  if (options?.scroll !== false) {
    if (url.hash) requestAnimationFrame(() => document.getElementById(decodeURIComponent(url.hash.slice(1)))?.scrollIntoView());
    else window.scrollTo(0, 0);
  }
}
const router = {
  push: (href: string, options?: Options) => navigate(href, false, options),
  replace: (href: string, options?: Options) => navigate(href, true, options),
  refresh: () => window.location.reload(), back: () => window.history.back(), forward: () => window.history.forward(),
  prefetch: (_href: string) => { void _href; },
};
export function useRouter() { return router; }
type Props = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & { href: string; prefetch?: boolean; replace?: boolean; scroll?: boolean };
const Link = forwardRef<HTMLAnchorElement, Props>(function Link({ href, prefetch, replace, scroll, onClick, ...props }, ref) {
  void prefetch;
  return <a {...props} href={href} ref={ref} onClick={event => {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || props.target || props.download !== undefined) return;
    const url = new URL(href, window.location.href);
    if (url.origin !== window.location.origin || url.pathname.startsWith("/api/") || !["http:", "https:"].includes(url.protocol)) return;
    event.preventDefault(); navigate(href, replace, { scroll });
  }} />;
});
export default Link;
