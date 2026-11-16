import { randomUUID } from "node:crypto";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Page,
  type JSHandle,
} from "playwright";
import type { PelicanPreviewStatus } from "../../pelican-types";

/** Remote pixels only. No model HTML is sent to a visitor's browser. */
export const PELICAN_ADAPTER_VERSION = "remote-clock-v4";
const DOCUMENT_URL = "https://pelican.invalid/document";
const MAX_SESSIONS = 4;
const TTL_MS = 90_000;
const OPERATION_MS = 5_000;
// Cold Windows process starts can take ~20s. Keep script/frame deadlines short.
const BROWSER_START_MS = 30_000;
const FRAME_STEPS = 12;
const STEP_MS = 16;
const MAX_HTML_BYTES = 1_000_000;
const MAX_CAPTURE_WIDTH = 2400;
const MAX_CAPTURE_HEIGHT = 1800;
const CSP = [
  "sandbox allow-scripts",
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data:",
  "font-src 'none'",
  "connect-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "media-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

type Session = {
  id: string;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  cdp: CDPSession;
  paused: boolean;
  closed: boolean;
  blocked: boolean;
  runtimeError: boolean;
  expires: number;
  timer: ReturnType<typeof setTimeout>;
  queue: Promise<unknown>;
  svgClocks: JSHandle<WeakMap<SVGSVGElement, boolean>>;
};
type State = { sessions: Map<string, Session>; opening: number };
const stateKey = Symbol.for("promptmaster.pelican.renderer.v1");
const globals = globalThis as typeof globalThis & { [stateKey]?: State };
const state: State = (globals[stateKey] ??= { sessions: new Map(), opening: 0 });

class PreviewFailure extends Error {
  constructor(public status: "BLOCKED" | "INVALID") {
    super(status === "BLOCKED" ? "Preview sandbox blocked this work" : "Preview script failed");
  }
}

function assertHealthy(session: Session): void {
  if (session.blocked) throw new PreviewFailure("BLOCKED");
}

function deadline<T>(work: Promise<T>, ms = OPERATION_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Preview operation timed out")), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function dispose(session: Session): Promise<void> {
  if (session.closed) return;
  session.closed = true;
  clearTimeout(session.timer);
  state.sessions.delete(session.id);
  // Browser.close terminates the dedicated process, including a stuck page script.
  await deadline(session.browser.close(), 2_000).catch(() => undefined);
}

function sessionFor(id: string): Session {
  const session = state.sessions.get(id);
  if (!session || session.closed || session.expires <= Date.now()) {
    if (session) void dispose(session);
    throw new Error("Preview session expired or unavailable");
  }
  return session;
}

function serial<T>(id: string, operation: (session: Session) => Promise<T>): Promise<T> {
  const session = sessionFor(id);
  const result = session.queue.then(async () => {
    if (session.closed || session.expires <= Date.now())
      throw new Error("Preview session expired or unavailable");
    try {
      return await deadline(operation(session));
    } catch (error) {
      await dispose(session);
      throw error;
    }
  });
  session.queue = result.catch(() => undefined);
  return result;
}

/** Freeze native SVG clocks. CSS/WebAnimations have already been frozen globally via CDP. */
async function freezeSvg(page: Page, clocks: Session["svgClocks"]): Promise<void> {
  await page.evaluate((paused) => {
    for (const svg of document.querySelectorAll("svg")) {
      if (svg.ownerSVGElement) continue;
      if (!paused.has(svg)) paused.set(svg, svg.animationsPaused());
      svg.pauseAnimations();
    }
  }, clocks);
}

/** Advance original timelines together; no generated animation or source rewriting. */
async function advance(session: Session): Promise<void> {
  for (let i = 0; i < FRAME_STEPS; i++) {
    // A generated animation loop may reference a missing DOM element and throw.
    // Skip that frame instead of aborting the whole work; CSS/SMIL animations and
    // healthy JavaScript frames still advance.
    try {
      await session.page.clock.runFor(STEP_MS);
    } catch {
      /* One page timer failed; keep the remaining clocks advancing. */
    }
    try {
      await session.page.evaluate(
        ({ step, paused }) => {
          for (const animation of document.getAnimations()) {
            if (animation.playState === "running" && typeof animation.currentTime === "number") {
              animation.currentTime += step * animation.playbackRate;
            }
          }
          for (const svg of document.querySelectorAll("svg")) {
            if (svg.ownerSVGElement) continue;
            if (!paused.has(svg)) paused.set(svg, svg.animationsPaused());
            svg.pauseAnimations();
            if (!paused.get(svg)) svg.setCurrentTime(svg.getCurrentTime() + step / 1000);
          }
        },
        { step: STEP_MS, paused: session.svgClocks },
      );
    } catch {
      /* Keep advancing so a later frame can still be captured. */
    }
  }
  try {
    await freezeSvg(session.page, session.svgClocks);
  } catch {
    /* Capture below still reports a real failure if the page is unusable. */
  }
}

async function screenshot(session: Session): Promise<Buffer> {
  const extent = await session.page.evaluate(() => {
    const root = document.documentElement;
    const body = document.body;
    let width = Math.max(root.scrollWidth, root.clientWidth, body?.scrollWidth ?? 0);
    let height = Math.max(root.scrollHeight, root.clientHeight, body?.scrollHeight ?? 0);
    for (const work of document.querySelectorAll("svg,canvas")) {
      if (work instanceof SVGSVGElement && work.ownerSVGElement) continue;
      const rect = work.getBoundingClientRect();
      width = Math.max(width, rect.right + scrollX);
      height = Math.max(height, rect.bottom + scrollY);
    }
    return { width: Math.ceil(width), height: Math.ceil(height) };
  });
  if (extent.width > MAX_CAPTURE_WIDTH || extent.height > MAX_CAPTURE_HEIGHT) {
    throw new Error("Preview work exceeds bounded capture dimensions");
  }
  const frame = await session.page.screenshot({
    type: "png",
    fullPage: true,
    timeout: OPERATION_MS,
    animations: "allow",
    caret: "hide",
  });
  // Overflow rules can hide work from the browser's full-page capture extent.
  // Never silently serve a partial SVG/canvas as a complete work.
  if (frame.readUInt32BE(16) < extent.width || frame.readUInt32BE(20) < extent.height) {
    throw new Error("Preview document clips its work outside the capture area");
  }
  return frame;
}

export async function openPelicanPreview(
  html: string,
): Promise<{ sessionId: string; expiresAt: string; paused: boolean }> {
  if (Buffer.byteLength(html, "utf8") > MAX_HTML_BYTES)
    throw new Error("Preview document too large");
  if (state.sessions.size + state.opening >= MAX_SESSIONS)
    throw new Error("Preview capacity reached");
  state.opening++;
  let browser: Browser | undefined;
  let session: Session | undefined;
  try {
    browser = await chromium.launch({
      headless: true,
      chromiumSandbox: true,
      timeout: BROWSER_START_MS,
      args: [
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-sync",
        "--host-resolver-rules=MAP * ~NOTFOUND",
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
      ],
      proxy: { server: "http://127.0.0.1:9" },
    });
    const context = await browser.newContext({
      viewport: { width: 960, height: 640 },
      deviceScaleFactor: 1,
      serviceWorkers: "block",
      acceptDownloads: false,
      permissions: [],
      javaScriptEnabled: true,
      locale: "en-US",
      colorScheme: "light",
    });
    // CSP frame-src does not cover inline srcdoc documents. This runs before
    // any document script in every frame, replacing child parsers with empty
    // documents. No generated child document is allowed to execute.
    await context.addInitScript(() => {
      if (window !== window.top) {
        window.stop();
        document.open();
        document.close();
        console.error("Child document blocked by preview sandbox");
      }
    });
    let blocked = false;
    let served = false;
    await context.route("**/*", async (route) => {
      const request = route.request();
      if (
        !served &&
        request.url() === DOCUMENT_URL &&
        request.isNavigationRequest() &&
        request.frame() === page.mainFrame()
      ) {
        served = true;
        await route.fulfill({
          status: 200,
          contentType: "text/html; charset=utf-8",
          body: html,
          headers: {
            "Content-Security-Policy": CSP,
            "Referrer-Policy": "no-referrer",
            "X-Content-Type-Options": "nosniff",
            "Permissions-Policy":
              "camera=(), microphone=(), geolocation=(), display-capture=(), usb=(), serial=(), payment=()",
            "Cache-Control": "no-store",
          },
        });
      } else {
        blocked = true;
        if (session) session.blocked = true;
        await route.abort("blockedbyclient");
      }
    });
    await context.routeWebSocket(/.*/, (socket) => {
      blocked = true;
      if (session) session.blocked = true;
      socket.close({ code: 1008, reason: "Network disabled" });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(OPERATION_MS);
    page.setDefaultNavigationTimeout(OPERATION_MS);
    const cdp = await context.newCDPSession(page);
    await cdp.send("Animation.enable");
    await cdp.send("Animation.setPlaybackRate", { playbackRate: 0 });
    // Installed before any model code, including cached Date/rAF/timer references.
    const clockStart = new Date();
    // Install behind the pause point so IPC latency cannot make pauseAt move
    // backwards. No work code exists yet, so this initial fast-forward is inert.
    await page.clock.install({ time: new Date(clockStart.getTime() - 60_000) });
    await page.clock.pauseAt(clockStart);
    let runtimeError = false;
    page.on("pageerror", () => {
      runtimeError = true;
      if (session) session.runtimeError = true;
    });
    page.on("console", (message) => {
      if (
        message.type() === "error" &&
        /content security policy|violates.*directive|blocked.*sandbox/i.test(message.text())
      ) {
        blocked = true;
        if (session) session.blocked = true;
      }
    });
    page.on("dialog", (dialog) => {
      void dialog.dismiss().catch(() => undefined);
    });
    context.on("page", (popup) => {
      if (popup !== page) {
        blocked = true;
        if (session) session.blocked = true;
        void popup.close().catch(() => undefined);
      }
    });
    await page.goto(DOCUMENT_URL, { waitUntil: "domcontentloaded", timeout: OPERATION_MS });
    const svgClocks = await page.evaluateHandle(() => new WeakMap<SVGSVGElement, boolean>());
    await deadline(freezeSvg(page, svgClocks));
    const id = randomUUID();
    const expires = Date.now() + TTL_MS;
    session = {
      id,
      browser,
      context,
      page,
      cdp,
      paused: false,
      closed: false,
      blocked,
      runtimeError,
      expires,
      svgClocks,
      queue: Promise.resolve(),
      timer: setTimeout(() => {
        if (session) void dispose(session);
      }, TTL_MS),
    };
    session.timer.unref?.();
    state.sessions.set(id, session);
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame() && frame.url() !== DOCUMENT_URL && session) {
        session.blocked = true;
        void dispose(session);
      }
    });
    page.on("crash", () => {
      if (session) void dispose(session);
    });
    page.on("close", () => {
      if (session) void dispose(session);
    });
    return { sessionId: id, expiresAt: new Date(expires).toISOString(), paused: false };
  } catch (error) {
    if (session) await dispose(session);
    else if (browser) await deadline(browser.close(), 2_000).catch(() => undefined);
    throw error;
  } finally {
    state.opening--;
  }
}

export async function pelicanFrame(sessionId: string): Promise<Buffer> {
  return serial(sessionId, async (session) => {
    assertHealthy(session);
    if (!session.paused) await advance(session);
    const frame = await screenshot(session);
    assertHealthy(session);
    return frame;
  });
}

export async function controlPelicanPreview(
  sessionId: string,
  action: "pause" | "resume" | "close",
): Promise<void> {
  if (action === "close") {
    // Immediate cancellation prevents a stalled queued operation keeping a renderer alive.
    const session = state.sessions.get(sessionId);
    if (session) await dispose(session);
    return;
  }
  return serial(sessionId, async (session) => {
    session.paused = action === "pause";
  });
}

/** One unambiguous document may appear inside a fenced block, possibly surrounded by prose. */
function isCompleteDocument(source: string): boolean {
  return (
    /^(?:\s*<!doctype\s+html[^>]*>)?\s*<html\b[\s\S]*<\/html>\s*$/i.test(source) ||
    /^\s*<svg\b[\s\S]*<\/svg>\s*$/i.test(source)
  );
}

/**
 * Extracts a fenced ```html / ```svg / untagged block whose body is a complete document.
 * Tolerates leading or trailing prose (usage notes, bullet lists, backticks) around the
 * fence, but still rejects a wrapper whose prose contains executable markup (`<`/`>`)
 * and refuses ambiguous input with more than one complete document.
 */
function extractDocumentSource(trimmed: string): string | null {
  const blocks = [...trimmed.matchAll(/^```[^\n]*\r?\n([\s\S]*?)\r?\n```[ \t]*(?:\r?$|\r?\n)/gim)];
  const complete = blocks.filter((block) => isCompleteDocument(block[1]));
  if (complete.length !== 1) return null;
  const block = complete[0];
  const outside = trimmed.slice(0, block.index) + trimmed.slice(block.index! + block[0].length);
  if (/[<>]/.test(outside)) return null;
  return block[1];
}

/**
 * Produces a preview-only copy with just the parts that cannot render under the sandbox
 * removed (external stylesheets/scripts/media, network `url(...)`, `@import`, iframes).
 * The original `raw_output` is never modified; this only affects what gets rendered.
 */
function sanitizePreviewHtml(html: string): string {
  return html
    .replace(/<link\b[^>]*>/gi, "")
    .replace(/<script\b[^>]*\bsrc\s*=\s*["'][^"']*["'][^>]*>\s*<\/script>/gi, "")
    .replace(/<script\b[^>]*\bsrc\s*=\s*["'][^"']*["'][^>]*\/?>/gi, "")
    .replace(
      /<(?:img|audio|video|source|track|embed|object)\b[^>]*\bsrc\s*=\s*["']https?:\/\/[^"']*["'][^>]*>/gi,
      "",
    )
    .replace(/<iframe\b[^>]*>/gi, "")
    .replace(/@import\b[^;]*;?/gi, "")
    .replace(/url\(\s*["']?https?:\/\/[^)"']*["']?\s*\)/gi, "none");
}

/** Extract one unambiguous document; retain its bytes and immutable original response. */
export async function preparePelicanPreview(
  raw: string,
  finishReason?: string,
): Promise<{
  html: string | null;
  status: PelicanPreviewStatus;
  reason: string | null;
  thumbnail: Buffer | null;
  adapterVersion: string;
}> {
  const result = (
    status: PelicanPreviewStatus,
    reason: string | null,
    html: string | null = null,
    thumbnail: Buffer | null = null,
  ) => ({
    html,
    status,
    reason,
    thumbnail,
    adapterVersion: PELICAN_ADAPTER_VERSION,
  });
  if (/length|max[_-]?tokens|token[_-]?limit/i.test(finishReason ?? ""))
    return result("TRUNCATED", "供应商报告输出被截断，未执行预览。");
  const trimmed = raw.trim();
  const extracted = extractDocumentSource(trimmed) ?? trimmed;
  if (
    !extracted ||
    Buffer.byteLength(extracted, "utf8") > MAX_HTML_BYTES ||
    !/^\s*<(?:!doctype\s+html|html|svg|style|body|head|div|main|section|script)(?:\s|>)/i.test(
      extracted,
    ) ||
    extracted.includes("```")
  ) {
    return result("INVALID", "未收到可执行的完整 HTML 或 SVG 文档，或文档超过预览大小限制。");
  }
  // Preview-only copy: strip the bits the sandbox forbids (external resources) and let
  // audio / timeline APIs fall through to the runtime freeze-and-resume pixel check.
  const html = sanitizePreviewHtml(extracted);
  let id: string | undefined;
  try {
    id = (await openPelicanPreview(html)).sessionId;
    const first = await pelicanFrame(id);
    const second = await pelicanFrame(id);
    await controlPelicanPreview(id, "pause");
    const frozen = await pelicanFrame(id);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const stillFrozen = await pelicanFrame(id);
    const session = sessionFor(id);
    if (session.blocked)
      return result("BLOCKED", "作品依赖或尝试使用被隔离策略禁止的资源／能力。", html);
    // A generated script error no longer hides an otherwise renderable work; the
    // captured pixels decide READY/STATIC and a completely unusable page still fails.
    if (!frozen.equals(stillFrozen))
      // Pause control may drift for this work, but the captured frames are a valid
      // preview; hide it only when the page itself cannot be rendered.
      return result("READY", null, html, frozen);
    if (first.equals(second))
      return result("STATIC", "在受限观察时段内未观察到画面变化；未确认有效动画。", html, frozen);
    await controlPelicanPreview(id, "resume");
    const resumed = await pelicanFrame(id);
    if (resumed.equals(frozen))
      return result("UNSUPPORTED", "作品无法在预览时钟下接续播放。", html, frozen);
    return result("READY", null, html, first);
  } catch (error) {
    if (error instanceof PreviewFailure) {
      return result(
        error.status,
        error.status === "BLOCKED"
          ? "作品依赖或尝试使用被隔离策略禁止的资源／能力。"
          : "作品运行时发生错误。",
        html,
      );
    }
    return result("UNSUPPORTED", "隔离浏览器不可用、运行超时或作品超出当前预览能力。", html);
  } finally {
    if (id) await controlPelicanPreview(id, "close");
  }
}
