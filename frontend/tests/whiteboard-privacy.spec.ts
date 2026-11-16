import { test, expect } from "./fixtures";
import { createTestAccount, cleanupTestAccount } from "../scripts/test-account.mjs";

const origin = "http://127.0.0.1:3000";
const emptyScene = { elements: [], appState: {}, files: {} };

test("whiteboards, images and libraries stay private across accounts and stale tabs cannot overwrite", async ({
  context,
  testAccount,
}) => {
  const other = await createTestAccount();
  try {
    const first = await context.request.get("/api/whiteboard");
    expect(first.status()).toBe(200);
    expect(first.headers()["cache-control"]).toContain("no-store");
    const a = await first.json();
    expect(a.ownerId).toBe(testAccount.id);
    expect(a.visibility).toBe("PRIVATE");
    const scene = {
      ...emptyScene,
      elements: [{ id: "private-a", type: "rectangle", x: 0, y: 0, width: 80, height: 60 }],
      files: {
        imageA: {
          id: "imageA",
          mimeType: "image/png",
          dataURL: "data:image/png;base64,aA==",
          created: 1,
        },
      },
    };
    const libraryItems = [
      { id: "library-a", status: "unpublished", created: 1, elements: scene.elements },
    ];
    const saved = await context.request.put("/api/whiteboard", {
      headers: { origin },
      data: { ownerId: a.ownerId, revision: a.revision, scene, libraryItems },
    });
    expect(saved.status()).toBe(200);
    const revision = (await saved.json()).revision;
    expect(
      (
        await context.request.put("/api/whiteboard", {
          headers: { origin },
          data: { ownerId: a.ownerId, revision: a.revision, scene: emptyScene, libraryItems: [] },
        })
      ).status(),
    ).toBe(409);
    await context.addCookies([{ name: "pm_session", value: other.token, url: origin }]);
    expect(
      (
        await context.request.get("/api/whiteboard", {
          headers: { "x-whiteboard-owner": a.ownerId },
        })
      ).status(),
    ).toBe(409);
    const b = await (await context.request.get("/api/whiteboard")).json();
    expect(b.ownerId).toBe(other.id);
    expect(b.scene).toEqual(emptyScene);
    expect(b.libraryItems).toEqual([]);
    expect(
      (
        await context.request.put("/api/whiteboard", {
          headers: { origin },
          data: { ownerId: a.ownerId, revision, scene, libraryItems },
        })
      ).status(),
    ).toBe(409);
    expect(
      (
        await context.request.put("/api/whiteboard", {
          headers: { origin },
          data: { ...b, visibility: "PUBLIC" },
        })
      ).status(),
    ).toBe(400);
    await context.addCookies([{ name: "pm_session", value: testAccount.token, url: origin }]);
    const restored = await (await context.request.get("/api/whiteboard")).json();
    expect(restored.scene).toEqual(scene);
    expect(restored.libraryItems).toEqual(libraryItems);
    expect(restored.revision).toBe(revision);
    await context.clearCookies();
    expect((await context.request.get("/api/whiteboard")).status()).toBe(401);
    expect(
      (await context.request.put("/api/whiteboard", { headers: { origin }, data: {} })).status(),
    ).toBe(401);
  } finally {
    await cleanupTestAccount(other);
  }
});

test("legacy shared browser cache never becomes a user's whiteboard and toolbar fits in the header", async ({
  page,
  context,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      "excalidraw",
      JSON.stringify([{ id: "legacy-private", type: "text", text: "legacy secret" }]),
    );
  });
  await page.goto("/en/app/whiteboard");
  const board = page.frameLocator('iframe[title="Excalidraw whiteboard"]');
  await expect(board.locator("canvas.interactive")).toBeVisible();
  const toolbar = await board.locator(".shapes-section").boundingBox();
  const header = await board.locator(".pm-whiteboard-header").boundingBox();
  expect(header).not.toBeNull();
  expect(toolbar!.y).toBeGreaterThanOrEqual(header!.y);
  expect(toolbar!.y + toolbar!.height).toBeLessThanOrEqual(header!.y + header!.height + 1);
  const stored = await (await context.request.get("/api/whiteboard")).json();
  expect(stored.scene.elements.some((e: { id: string }) => e.id === "legacy-private")).toBe(false);
  expect(await page.evaluate(() => localStorage.getItem("excalidraw"))).toContain("legacy-private");
  const standalone = await context.newPage();
  await context.clearCookies();
  await standalone.goto("/modules/excalidraw/index.html?lng=en");
  await expect(standalone.getByRole("link", { name: "Log in", exact: true })).toBeVisible();
  await expect(standalone.locator("canvas")).toHaveCount(0);
});

test("switching accounts in one browser restores each private drawing and locks the old standalone tab", async ({
  page,
  context,
  testAccount,
}) => {
  const other = await createTestAccount();
  const old = await (await context.request.get("/api/whiteboard")).json();
  await context.request.put("/api/whiteboard", {
    headers: { origin },
    data: { ownerId: old.ownerId, revision: old.revision, scene: emptyScene, libraryItems: [] },
  });
  try {
    await page.goto("/en/app/whiteboard");
    const board = page.frameLocator("iframe");
    await expect(board.locator("canvas.interactive")).toBeVisible();
    await board.getByRole("button", { name: "Rectangle", exact: true }).click();
    await expect(board.getByRole("button", { name: "Rectangle", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const canvas = (await board.locator("canvas.interactive").boundingBox())!;
    await page.mouse.move(canvas.x + 300, canvas.y + 230);
    await page.mouse.down();
    await page.mouse.move(canvas.x + 500, canvas.y + 350, { steps: 10 });
    await page.mouse.up();
    await expect
      .poll(
        async () =>
          (await (await context.request.get("/api/whiteboard")).json()).scene.elements.filter(
            (e: { isDeleted: boolean }) => !e.isDeleted,
          ).length,
      )
      .toBe(1);
    const own = await (await context.request.get("/api/whiteboard")).json();
    const toolbarBefore = await board.locator(".shapes-section").boundingBox();
    await board.getByRole("button", { name: "Library", exact: true }).click();
    await board.locator(".library-unit__dragger.library-unit__pulse").click();
    await expect
      .poll(
        async () =>
          (await (await context.request.get("/api/whiteboard")).json()).libraryItems.length,
      )
      .toBe(1);
    await expect(board.locator(".library-menu-browse-button")).toHaveCount(0);
    await board
      .locator(".library-unit__dragger:not(.library-unit__pulse)")
      .first()
      .click({ modifiers: ["Shift"] });
    await board.locator(".library-menu-dropdown-container--in-heading button").click();
    await expect(board.locator(".library-menu")).not.toContainText("Publish");
    await page.keyboard.press("Escape");
    const toolbarAfter = await board.locator(".shapes-section").boundingBox();
    expect(Math.abs(toolbarBefore!.x - toolbarAfter!.x)).toBeLessThan(1);
    const header = (await board.locator(".pm-whiteboard-header").boundingBox())!;
    expect((await board.locator(".sidebar").boundingBox())!.y).toBeGreaterThanOrEqual(
      header.y + header.height,
    );
    const popupEvent = page.waitForEvent("popup");
    await board.getByRole("link", { name: "Open separately", exact: true }).click();
    const standalone = await popupEvent;
    await expect(standalone.locator("canvas.interactive")).toBeVisible();
    await context.addCookies([{ name: "pm_session", value: other.token, url: origin }]);
    await standalone.evaluate(() =>
      window.dispatchEvent(new StorageEvent("storage", { key: "pm-account-changed" })),
    );
    await expect(
      standalone.getByText("Your session changed. Reopen your whiteboard."),
    ).toBeVisible();
    await expect(standalone.locator("canvas")).toHaveCount(0);
    await page.goto("/en/app/whiteboard");
    await expect(board.locator("canvas.interactive")).toBeVisible();
    const b = await (await context.request.get("/api/whiteboard")).json();
    expect(b.scene.elements).toEqual([]);
    expect(b.libraryItems).toEqual([]);
    expect(b.ownerId).toBe(other.id);
    await board.getByRole("button", { name: "Text", exact: true }).click();
    const bCanvas = (await board.locator("canvas.interactive").boundingBox())!;
    await page.mouse.click(bCanvas.x + 360, bCanvas.y + 260);
    await page.keyboard.insertText("Account B private note");
    await page.keyboard.press("Escape");
    await expect
      .poll(async () =>
        (await (await context.request.get("/api/whiteboard")).json()).scene.elements.some(
          (e: { text?: string }) => e.text === "Account B private note",
        ),
      )
      .toBe(true);
    await context.addCookies([{ name: "pm_session", value: testAccount.token, url: origin }]);
    await page.goto("/en/app/whiteboard");
    await expect(board.locator("canvas.interactive")).toBeVisible();
    const restored = await (await context.request.get("/api/whiteboard")).json();
    expect(restored.scene.elements.map((e: { id: string }) => e.id)).toEqual(
      own.scene.elements.map((e: { id: string }) => e.id),
    );
    expect(restored.libraryItems).toHaveLength(1);
    expect(
      restored.scene.elements.some((e: { text?: string }) => e.text === "Account B private note"),
    ).toBe(false);
  } finally {
    await page.goto("about:blank");
    await cleanupTestAccount(other);
  }
});

test("save failures offer retry and a lost response recovers without overwriting another tab", async ({
  page,
  context,
}) => {
  const old = await (await context.request.get("/api/whiteboard")).json();
  await context.request.put("/api/whiteboard", {
    headers: { origin },
    data: { ownerId: old.ownerId, revision: old.revision, scene: emptyScene, libraryItems: [] },
  });
  await page.goto("/en/app/whiteboard");
  const board = page.frameLocator("iframe");
  await expect(board.locator("canvas.interactive")).toBeVisible();
  let failedRequests = 0;
  await page.route("**/api/whiteboard", (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    failedRequests++;
    return route.fulfill({ status: 503, json: { error: "UNAVAILABLE" } });
  });
  await board.getByRole("button", { name: "Text", exact: true }).click();
  const box = (await board.locator("canvas.interactive").boundingBox())!;
  await page.mouse.click(box.x + 360, box.y + 260);
  await page.keyboard.insertText("Recover this private note");
  await page.keyboard.press("Escape");
  await expect(board.getByRole("alert")).toContainText("Save failed");
  // Observe an idle period: rendering the failure must not start a retry loop.
  await page.waitForTimeout(1100);
  expect(failedRequests).toBe(1);
  await expect(board.getByRole("button", { name: "Export backup", exact: true })).toBeVisible();
  await page.unroute("**/api/whiteboard");
  let loseResponse = true;
  await page.route("**/api/whiteboard", async (route) => {
    if (route.request().method() !== "PUT" || !loseResponse) return route.continue();
    loseResponse = false;
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    await route.fulfill({ status: 503, json: { error: "UNAVAILABLE" } });
  });
  await board.getByRole("button", { name: "Retry save", exact: true }).click();
  await expect.poll(() => loseResponse).toBe(false);
  await expect(board.getByRole("alert")).toContainText("Save failed");
  await board.getByRole("button", { name: "Retry save", exact: true }).click();
  await expect(board.getByRole("alert")).toHaveCount(0);
  const saved = await (await context.request.get("/api/whiteboard")).json();
  expect(
    saved.scene.elements.some((e: { text?: string }) => e.text === "Recover this private note"),
  ).toBe(true);
  await context.request.put("/api/whiteboard", {
    headers: { origin },
    data: { ownerId: saved.ownerId, revision: saved.revision, scene: emptyScene, libraryItems: [] },
  });
  await board.getByRole("button", { name: "Rectangle", exact: true }).click();
  await expect(board.getByRole("alert")).toContainText("Another tab updated this board");
  expect((await (await context.request.get("/api/whiteboard")).json()).scene.elements).toEqual([]);
});

test("uploaded images restore from private storage and desktop toolbar never overlaps header actions", async ({
  page,
  context,
}) => {
  const old = await (await context.request.get("/api/whiteboard")).json();
  await context.request.put("/api/whiteboard", {
    headers: { origin },
    data: { ownerId: old.ownerId, revision: old.revision, scene: emptyScene, libraryItems: [] },
  });
  await page.addInitScript(() => {
    Reflect.deleteProperty(window, "showOpenFilePicker");
  });
  await page.goto("/en/app/whiteboard");
  const board = page.frameLocator("iframe");
  await expect(board.locator("canvas.interactive")).toBeVisible();
  await board.locator('button[title="More tools"]').click();
  const chooserEvent = page.waitForEvent("filechooser");
  await board.getByTestId("toolbar-image").click();
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aG3sAAAAASUVORK5CYII=";
  await (
    await chooserEvent
  ).setFiles({ name: "private.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") });
  const box = (await board.locator("canvas.interactive").boundingBox())!;
  await page.mouse.click(box.x + 330, box.y + 260);
  await page.keyboard.press("Escape");
  await expect
    .poll(async () => {
      const b = await (await context.request.get("/api/whiteboard")).json();
      return b.scene.elements.some(
        (e: { type: string; fileId: string }) =>
          e.type === "image" &&
          b.scene.files[e.fileId]?.dataURL.startsWith("data:image/png;base64,"),
      );
    })
    .toBe(true);
  await page.reload();
  await expect(board.locator("canvas.interactive")).toBeVisible();
  await expect(board.getByRole("alert")).toHaveCount(0);
  await expect(board.getByRole("dialog")).toHaveCount(0);
  expect(
    Object.keys((await (await context.request.get("/api/whiteboard")).json()).scene.files),
  ).toHaveLength(1);
  for (const width of [1024, 1280, 1920]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect
      .poll(async () => {
        const toolbar = await board.locator(".shapes-section").boundingBox();
        const title = await board.locator(".pm-whiteboard-header h1").boundingBox();
        const actions = await board.locator(".pm-whiteboard-header-actions").boundingBox();
        const header = await board.locator(".pm-whiteboard-header").boundingBox();
        return (
          !!toolbar &&
          !!title &&
          !!actions &&
          !!header &&
          toolbar.x >= title.x + title.width &&
          toolbar.x + toolbar.width <= actions.x &&
          toolbar.y + toolbar.height <= header.y + header.height
        );
      })
      .toBe(true);
  }
});
