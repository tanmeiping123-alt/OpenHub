import { createServer } from "node:http";
import { once } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { Agent } from "undici";
import { pelicanFetch } from "./transport";

afterEach(() => vi.restoreAllMocks());

it.each(["headers", "body"])(
  "removes fetch transport deadlines and promptly aborts pending %s",
  async (phase) => {
    let arrived!: () => void;
    const active = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const server = createServer((_request, response) => {
      if (phase === "body") {
        response.writeHead(200);
        response.write("partial");
      }
      arrived();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Local HTTP address required");
    const dispatch = vi.spyOn(Agent.prototype, "dispatch");
    const controller = new AbortController();
    const request = pelicanFetch(`http://127.0.0.1:${address.port}`, {
      signal: controller.signal,
    }).then((response) => response.text());
    const settled = request.catch((error) => error);
    try {
      await active;
      expect(dispatch.mock.calls[0][0]).toMatchObject({ headersTimeout: 0, bodyTimeout: 0 });
      controller.abort();
      expect((await settled).name).toBe("AbortError");
    } finally {
      controller.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
