import { afterEach, describe, expect, it } from "vitest";
import {
  preparePelicanPreview,
  openPelicanPreview,
  pelicanFrame,
  controlPelicanPreview,
} from "./renderer";
import type { Page } from "playwright";

const sessions: string[] = [];
const html = (body: string) => `<!doctype html><html><body>${body}</body></html>`;
async function open(body: string) {
  const session = await openPelicanPreview(html(body));
  sessions.push(session.sessionId);
  return session.sessionId;
}
function pageFor(id: string): Page {
  const state = (globalThis as Record<symbol, unknown>)[
    Symbol.for("promptmaster.pelican.renderer.v1")
  ] as { sessions: Map<string, { page: Page }> };
  return state.sessions.get(id)!.page;
}
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((id) => controlPelicanPreview(id, "close")));
});

describe("pelican isolated renderer", () => {
  it("extracts exactly one complete fenced document without rewriting it or accepting ambiguous wrappers", async () => {
    const document = html(
      '<svg><circle r="8"><animate attributeName="cx" from="10" to="200" dur="1s" repeatCount="indefinite"/></circle></svg>',
    );
    expect(
      await preparePelicanPreview(
        `Here is the animation:\n\`\`\`html\n${document}\n\`\`\`\nAnimation explanation.`,
      ),
    ).toMatchObject({ html: document, status: "READY", adapterVersion: "remote-clock-v4" });
    for (const raw of [
      `\`\`\`html\n${document}\n\`\`\`\n\`\`\`html\n${document}\n\`\`\``,
      `<script>outside()</script>\n\`\`\`html\n${document}\n\`\`\``,
      `Explanation\n\`\`\`html\n${document.slice(0, -7)}\n\`\`\``,
    ])
      expect(await preparePelicanPreview(raw)).toMatchObject({ status: "INVALID", html: null });
  }, 20000);
  it("retains only whole-document Markdown fence stripping, and marks truncation before execution", async () => {
    const raw = html('<svg width="50" height="50"><circle cx="25" cy="25" r="10"/></svg>');
    const prepared = await preparePelicanPreview(`\`\`\`html\n${raw}\n\`\`\``);
    expect(prepared.html).toBe(raw);
    expect(prepared.status).toBe("STATIC");
    expect(prepared.thumbnail?.subarray(0, 4).toString("hex")).toBe("89504e47");
    expect(await preparePelicanPreview(raw, "length")).toMatchObject({
      status: "TRUNCATED",
      thumbnail: null,
    });
    expect(await preparePelicanPreview(`Here is your result:\n${raw}`)).toMatchObject({
      status: "INVALID",
      html: null,
    });
  }, 20000);
  it("extracts a fenced document surrounded by backtick-bearing prose, and still rejects executable wrappers", async () => {
    const doc = html('<svg width="50" height="50"><circle cx="25" cy="25" r="10"/></svg>');
    const wrapped = `下面是一个可直接保存为 \`.html\` 的示例。\n\`\`\`html\n${doc}\n\`\`\`\n\n使用方法：\n1. 保存为 \`pelican.html\`\n2. 用浏览器打开查看。`;
    expect(await preparePelicanPreview(wrapped)).toMatchObject({ html: doc, status: "STATIC" });
    expect(
      await preparePelicanPreview(
        `<p>before</p>\n\`\`\`html\n${doc}\n\`\`\`\n<div>after</div>`,
      ),
    ).toMatchObject({ status: "INVALID", html: null });
  }, 20000);

  it("freezes actual CSS, SVG, rAF, timers, Date and performance clocks and continues without wall-time jumps", async () => {
    const id = await open(
      `<style>@keyframes ride {to {transform:translateX(300px)}}#css{animation:ride 10s linear infinite}</style><div id="css">CSS</div><svg><circle id="smil" r="10"><animate attributeName="cx" values="0;300" dur="10s" repeatCount="indefinite"/></circle></svg><div id="js"></div><script>window.ticks=0;window.raf=0;setInterval(()=>window.ticks++,20);function ride(t){window.raf=t;document.querySelector('#js').textContent=t;requestAnimationFrame(ride)}requestAnimationFrame(ride)</script>`,
    );
    const page = pageFor(id);
    const clocks = () =>
      page.evaluate(() => ({
        ticks: (window as unknown as { ticks: number }).ticks,
        raf: (window as unknown as { raf: number }).raf,
        date: Date.now(),
        performance: performance.now(),
        css: Number(document.getAnimations()[0].currentTime),
        svg: (document.querySelector("svg") as SVGSVGElement).getCurrentTime(),
      }));
    await pelicanFrame(id);
    await controlPelicanPreview(id, "pause");
    const before = await clocks();
    const image = await pelicanFrame(id);
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(await clocks()).toEqual(before);
    expect(await pelicanFrame(id)).toEqual(image);
    await controlPelicanPreview(id, "resume");
    expect(await pelicanFrame(id)).not.toEqual(image);
    const after = await clocks();
    expect(after.performance - before.performance).toBe(192);
    expect(after.date - before.date).toBe(192);
    expect(after.css - before.css).toBeCloseTo(192, 0);
    expect(after.svg - before.svg).toBeCloseTo(0.192, 3);
    expect(after.raf - before.raf).toBe(192);
    expect(after.ticks).toBeGreaterThan(before.ticks);
    await Promise.all([pelicanFrame(id), pelicanFrame(id)]);
    expect((await clocks()).date - after.date).toBe(384);
  }, 20000);

  it("detects real visual animation, refuses runtime errors and strips blocked external dependencies", async () => {
    expect(
      (
        await preparePelicanPreview(
          html(
            '<svg><circle r="12"><animate attributeName="cx" from="10" to="200" dur="1s" repeatCount="indefinite"/></circle></svg>',
          ),
        )
      ).status,
    ).toBe("READY");
    // A throwing page script no longer hides a renderable result; it becomes a static work.
    expect(
      (await preparePelicanPreview(html('<script>throw new Error("bad")</script>'))).status,
    ).toBe("STATIC");
    // External images are stripped from the preview-only copy rather than failing the sandbox.
    const stripped = await preparePelicanPreview(html('<img src="https://example.com/secret">'));
    expect(stripped.status).toBe("STATIC");
    expect(stripped.html).not.toContain("https://example.com");
    // External stylesheets (e.g. Google Fonts) are removed so the work still renders.
    const font = await preparePelicanPreview(
      `<!doctype html><html><head><link href="https://fonts.googleapis.com/css2?family=Noto+Serif+SC" rel="stylesheet"></head><body><svg width="50" height="50"><circle cx="25" cy="25" r="10"/></svg></body></html>`,
    );
    expect(font.status).toBe("STATIC");
    expect(font.html).not.toContain("fonts.googleapis.com");
  }, 20000);

  it("keeps rendering when a generated animation frame throws on a missing element", async () => {
    const result = await preparePelicanPreview(
      html(
        '<svg width="80" height="40"><circle r="10"><animate attributeName="cx" from="10" to="60" dur="1s" repeatCount="indefinite"/></circle></svg><script>const missing=document.querySelector("#does-not-exist");requestAnimationFrame(()=>missing.setAttribute("x","1"))</script>',
      ),
    );
    expect(result.status).toBe("READY");
    expect(result.thumbnail).not.toBeNull();
  });
  it("blocks network, sockets, workers, file reads, frames, navigation, forms and popups in an opaque origin", async () => {
    const id = await open(`<script>
      window.credentials=false;try {window.credentials=!!document.cookie}catch{}
      fetch('http://127.0.0.1:9/secret').catch(()=>{});
      fetch('file:///etc/passwd').catch(()=>{});
      try{new WebSocket('ws://127.0.0.1:9/')}catch{}
      try{new Worker('data:text/javascript,fetch("https://example.com")')}catch{}
      window.open('https://example.com');
    </script><iframe srcdoc="<script>fetch('https://example.com')<\/script>"></iframe><form action="https://example.com"><input></form>`);
    const page = pageFor(id);
    expect(
      await page.evaluate(() => {
        let storage = false;
        try {
          localStorage.setItem("x", "x");
          storage = true;
        } catch {}
        return {
          storage,
          credentials: (window as unknown as { credentials: boolean }).credentials,
          frames: window.frames.length,
          origin: self.origin,
        };
      }),
    ).toMatchObject({ storage: false, credentials: false, origin: "null" });
    expect(page.context().pages()).toHaveLength(1);
    await page.evaluate(() => {
      try {
        (document.querySelector("form") as HTMLFormElement).submit();
      } catch {}
    });
    expect(page.url()).toBe("https://pelican.invalid/document");
    await page.evaluate(() => {
      location.href = "file:///etc/passwd";
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(page.url()).toBe("https://pelican.invalid/document");
  }, 20000);

  it("releases sessions on close, rejects unknown ids, serializes close races and caps concurrent sessions", async () => {
    const ids = await Promise.all([1, 2, 3, 4].map(() => open("<svg/>")));
    await expect(openPelicanPreview(html("<svg/>"))).rejects.toThrow(/capacity/i);
    await Promise.allSettled([
      pelicanFrame(ids[0]),
      controlPelicanPreview(ids[0], "close"),
      pelicanFrame(ids[0]),
    ]);
    await expect(pelicanFrame(ids[0])).rejects.toThrow(/session/i);
    const id = await open("<svg/>");
    await controlPelicanPreview(id, "close");
    await expect(pelicanFrame("unknown")).rejects.toThrow(/session/i);
  }, 30000);
});

// Additional regression cases exercise cancellation and the actual wire boundary.
import { createServer } from "node:http";
import { once } from "node:events";

it("makes zero outbound HTTP requests even when model code uses multiple browser channels", async () => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.end("secret");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  try {
    const id = await open(
      `<img src="http://127.0.0.1:${port}/image"><script src="http://127.0.0.1:${port}/script"></script><style>@import url('http://127.0.0.1:${port}/style');</style><script>fetch('http://127.0.0.1:${port}/fetch').catch(()=>{});try{navigator.sendBeacon('http://127.0.0.1:${port}/beacon','x')}catch{};try{new WebSocket('ws://127.0.0.1:${port}/ws')}catch{};try{new EventSource('http://127.0.0.1:${port}/event')}catch{};</script>`,
    );
    await expect(pelicanFrame(id)).rejects.toThrow(/blocked/i);
    expect(requests).toBe(0);
  } finally {
    server.close();
  }
}, 20000);

it("terminates runaway model code and recovers the reserved capacity", async () => {
  const start = Date.now();
  const result = await preparePelicanPreview(html("<script>while(true){}</script>"));
  expect(result.status).toBe("UNSUPPORTED");
  expect(Date.now() - start).toBeLessThan(10000);
  const id = await open("<svg/>");
  expect(await pelicanFrame(id)).toBeInstanceOf(Buffer);
}, 20000);

it("keeps explicitly paused CSS and Web Animations paused", async () => {
  const id = await open(
    "<style>@keyframes x {to {opacity:0}} div{animation:x 1s infinite;animation-play-state:paused}</style><div>paused</div>",
  );
  const page = pageFor(id);
  const time = await page.evaluate(() => document.getAnimations()[0].currentTime);
  await pelicanFrame(id);
  expect(await page.evaluate(() => document.getAnimations()[0].currentTime)).toBe(time);
});
it("renders default document.timeline reads instead of hard-rejecting them", async () => {
  // Reads of the default document.timeline are tolerated; classification falls back to
  // the runtime freeze-and-resume pixel checks instead of a source-level rejection.
  const result = await preparePelicanPreview(
    html(
      "<svg/><script>requestAnimationFrame(()=>console.log(document.timeline.currentTime))</script>",
    ),
  );
  expect(result.status).not.toBe("UNSUPPORTED");
});

it("drops expired sessions and closes the actual renderer", async () => {
  const id = await open("<svg/>");
  const page = pageFor(id);
  const state = (globalThis as Record<symbol, unknown>)[
    Symbol.for("promptmaster.pelican.renderer.v1")
  ] as { sessions: Map<string, { expires: number }> };
  state.sessions.get(id)!.expires = Date.now() - 1;
  await expect(pelicanFrame(id)).rejects.toThrow(/session/i);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(page.isClosed()).toBe(true);
});
it("does not start an originally paused SVG animation", async () => {
  const id = await open(
    '<svg><circle r="10"><animate attributeName="cx" values="0;100" dur="1s" repeatCount="indefinite"/></circle></svg><script>document.querySelector("svg").pauseAnimations()</script>',
  );
  const page = pageFor(id);
  const before = await page.evaluate(() =>
    (document.querySelector("svg") as SVGSVGElement).getCurrentTime(),
  );
  await pelicanFrame(id);
  expect(
    await page.evaluate(() => (document.querySelector("svg") as SVGSVGElement).getCurrentTime()),
  ).toBe(before);
});
it("captures the whole work when its explicit SVG exceeds the default viewport", async () => {
  const id = await open(
    '<svg width="1400" height="1000"><rect width="1400" height="1000" fill="red"/><circle cx="1380" cy="980" r="10"/></svg>',
  );
  const image = await pelicanFrame(id);
  expect(image.readUInt32BE(16)).toBeGreaterThanOrEqual(1400);
  expect(image.readUInt32BE(20)).toBeGreaterThanOrEqual(1000);
  await controlPelicanPreview(id, "pause");
  expect(await pelicanFrame(id)).toEqual(image);
});

it("truthfully marks a work beyond bounded capture dimensions as unsupported", async () => {
  const result = await preparePelicanPreview(
    html('<svg width="3000" height="2500"><rect width="3000" height="2500"/></svg>'),
  );
  expect(result.status).toBe("UNSUPPORTED");
  expect(result.thumbnail).toBeNull();
});
it("aborts inline srcdoc child documents before any child script runs", async () => {
  const id = await open(
    "<script>window.childExecuted=false;window.addEventListener(\"message\",()=>window.childExecuted=true)</script><iframe srcdoc=\"<script>parent.postMessage('executed','*')</script>\"></iframe>",
  );
  const page = pageFor(id);
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(
    await page.evaluate(() => (window as unknown as { childExecuted: boolean }).childExecuted),
  ).toBe(false);
  await expect(pelicanFrame(id)).rejects.toThrow(/blocked/i);
});
it("blocks synchronous writes into an initially same-origin about:blank child", async () => {
  const id = await open(
    '<script>window.childExecuted=false;window.addEventListener("message",()=>window.childExecuted=true);const f=document.createElement("iframe");document.body.append(f);try{f.contentDocument.write("<script>parent.postMessage(1,\'*\')<\\/script>");f.contentDocument.close()}catch{}</script>',
  );
  const page = pageFor(id);
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(
    await page.evaluate(() => (window as unknown as { childExecuted: boolean }).childExecuted),
  ).toBe(false);
  await expect(pelicanFrame(id)).rejects.toThrow(/blocked/i);
});
