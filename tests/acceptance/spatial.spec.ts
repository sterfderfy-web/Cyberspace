import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { fixture } from "./fixture.js";
import type { SpatialView } from "../../packages/contracts/spatial.js";
test("Spatial command: lost response, reload and idempotent retry; touch cancellation", async ({
  browser,
}) => {
  const f = await fixture(),
    ctx = await browser.newContext({
      viewport: { width: 820, height: 1180 },
      isMobile: true,
      hasTouch: true,
    });
  try {
    await f.request(
      f.owner,
      "POST",
      `/spaces/${f.space.id}/actions`,
      f.command(),
    );
    const page = await ctx.newPage();
    await page.goto(f.url);
    await page.getByLabel("ID участника").fill(f.owner.id);
    await page.getByLabel("Учётный секрет").fill(f.owner.secret);
    await page.getByRole("button", { name: "Войти", exact: true }).click();
    await page
      .getByRole("button", { name: "Пространственная область", exact: true })
      .click();
    await page.route(
      "**/actions",
      async (route) => {
        await route.fetch();
        await route.abort("failed");
      },
      { times: 1 },
    );
    await page
      .getByRole("button", { name: "Добавить View", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Повторить запрос размещения" }),
    ).toBeVisible();
    expect(f.server.repo.views(f.space.id)).toHaveLength(1);
    const revision = f.server.repo.sceneRevision(f.space.id);
    await page.reload();
    await page
      .getByRole("button", { name: "Пространственная область", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Повторить запрос размещения" })
      .click();
    await expect(
      page.getByText("Размещение сохранено", { exact: true }),
    ).toBeVisible();
    expect(f.server.repo.views(f.space.id)).toHaveLength(1);
    expect(f.server.repo.sceneRevision(f.space.id)).toBe(revision);
    await page
      .getByRole("button", { name: "Показать всё", exact: true })
      .click();
    const canvas = page.locator(".spatial-canvas canvas");
    await canvas.scrollIntoViewIfNeeded();
    const box = (await canvas.boundingBox())!;
    const cdp = await ctx.newCDPSession(page),
      point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [point],
    });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: point.x + 40, y: point.y + 20 }],
    });
    expect(f.server.repo.sceneRevision(f.space.id)).toBe(revision);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchCancel",
      touchPoints: [],
    });
    expect(f.server.repo.sceneRevision(f.space.id)).toBe(revision);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [point],
    });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: point.x + 40, y: point.y + 20 }],
    });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await expect
      .poll(() => f.server.repo.sceneRevision(f.space.id))
      .toBe(revision + 1);
    await cdp.detach();
    await page.getByLabel("position.x", { exact: true }).fill("9");
    const deleted = f.server.repo.views(f.space.id)[0];
    await f.request(f.owner, "POST", `/spaces/${f.space.id}/actions`, {
      request_id: randomUUID(),
      module: "spatial",
      action: "delete_view",
      view_id: deleted.id,
      expected_revision: deleted.revision,
    });
    await expect(page.locator(".view-row")).toHaveCount(0);
    await page
      .getByRole("button", { name: "Отбросить черновик View", exact: true })
      .click();
    await expect(page.getByLabel("position.x", { exact: true })).toHaveCount(0);
  } finally {
    await ctx.close();
    await f.close();
  }
});
test("Spatial workspace: eight documents, independent Views, drag commit, camera, conflict, ACL and reload", async ({
  browser,
}) => {
  const f = await fixture();
  const desktop = await browser.newContext({
      viewport: { width: 1500, height: 1100 },
    }),
    second = await browser.newContext({
      viewport: { width: 1300, height: 1000 },
    });
  const page = await desktop.newPage(),
    peer = await second.newPage(),
    errors: string[] = [];
  const path = `/spaces/${f.space.id}/actions`;
  const login = async (p: Page) => {
    p.on("pageerror", (e) => errors.push(e.message));
    await p.goto(f.url);
    await p.getByLabel("ID участника").fill(f.owner.id);
    await p.getByLabel("Учётный секрет").fill(f.owner.secret);
    await p.getByRole("button", { name: "Войти", exact: true }).click();
    await p
      .getByRole("button", { name: "Пространственная область", exact: true })
      .click();
    await expect(p.locator(".spatial-canvas canvas")).toBeVisible();
  };
  try {
    const notes = [];
    for (let i = 0; i < 8; i++)
      notes.push(
        (
          await f.request(
            f.owner,
            "POST",
            path,
            f.command(`Документ ${i + 1}`, `Содержимое ${i + 1}`),
          )
        ).json().object,
      );
    await login(page);
    await login(peer);
    await page
      .getByRole("button", { name: "Добавить View", exact: true })
      .click();
    await expect(
      page.getByText("Размещение сохранено", { exact: true }),
    ).toBeVisible();
    await expect(peer.locator(".view-row")).toHaveCount(1);
    const first = f.server.repo.views(f.space.id)[0];
    await page.getByLabel("position.x", { exact: true }).fill("-2");
    await page.getByLabel("scale.x", { exact: true }).fill("1.4");
    await page
      .getByRole("button", { name: "Сохранить размещение", exact: true })
      .click();
    await expect.poll(() => f.server.repo.view(first.id)?.revision).toBe(2);
    await page
      .getByLabel("Визуализатор", { exact: true })
      .selectOption("notes.summary");
    await page
      .getByRole("button", { name: "Сохранить размещение", exact: true })
      .click();
    await expect
      .poll(() => f.server.repo.view(first.id)?.renderer_id)
      .toBe("notes.summary");
    await page
      .getByRole("button", { name: "Ещё один View", exact: true })
      .click();
    await expect(peer.locator(".view-row")).toHaveCount(2);
    expect(f.server.repo.objects(f.space.id)).toEqual(notes);
    await page
      .getByRole("button", { name: "Показать всё", exact: true })
      .click();
    const canvas = page.locator(".spatial-canvas canvas"),
      box = (await canvas.boundingBox())!;
    const before = f.server.repo.sceneRevision(f.space.id);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      box.x + box.width / 2 + 65,
      box.y + box.height / 2 - 30,
      { steps: 12 },
    );
    expect(f.server.repo.sceneRevision(f.space.id)).toBe(before);
    await page.mouse.up();
    await expect
      .poll(() => f.server.repo.sceneRevision(f.space.id))
      .toBe(before + 1);
    expect(f.server.repo.objects(f.space.id)).toEqual(notes);
    await page.locator(".view-row").first().getByLabel("Скрыть у меня").check();
    await expect(
      peer.locator(".view-row").first().getByLabel("Скрыть у меня"),
    ).not.toBeChecked();
    expect(f.server.repo.sceneRevision(f.space.id)).toBe(before + 1);
    await page.getByRole("button", { name: "Приблизить", exact: true }).click();
    const storageKey = `spatial:${f.owner.id}:${f.space.id}:observer`;
    const observer = await page.evaluate(
      (key) => sessionStorage.getItem(key),
      storageKey,
    );
    expect(observer).toBeTruthy();
    expect(
      await peer.evaluate((key) => sessionStorage.getItem(key), storageKey),
    ).not.toBe(observer);
    // Two browser drafts compete for the same View revision; source data remains intact.
    await page.locator(".view-row").first().getByRole("button").click();
    await peer.locator(".view-row").first().getByRole("button").click();
    await page.getByLabel("position.y", { exact: true }).fill("4");
    await peer.getByLabel("position.y", { exact: true }).fill("8");
    await peer
      .getByRole("button", { name: "Сохранить размещение", exact: true })
      .click();
    await expect(
      page.getByText("На сервере новая ревизия. Черновик не перезаписан."),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Сохранить размещение", exact: true })
      .click();
    await expect(
      page.getByText(
        "Конфликт: черновик сохранён. Загрузите актуальный View перед новой правкой.",
      ),
    ).toBeVisible();
    await expect(page.getByLabel("position.y", { exact: true })).toHaveValue(
      "4",
    );
    await page
      .getByRole("button", { name: "Отбросить черновик View", exact: true })
      .click();
    await expect(page.getByLabel("position.y", { exact: true })).toHaveValue(
      "8",
    );
    for (let i = 1; i < 8; i++) {
      await page
        .getByLabel("Исходный объект", { exact: true })
        .selectOption(notes[i].id);
      await page
        .getByRole("button", { name: "Добавить View", exact: true })
        .click();
      await expect(page.locator(".view-row")).toHaveCount(i + 2);
      await page
        .getByLabel("position.x", { exact: true })
        .fill(String((i % 4) * 5));
      await page
        .getByLabel("position.y", { exact: true })
        .fill(String(Math.floor(i / 4) * -4));
      await page
        .getByRole("button", { name: "Сохранить размещение", exact: true })
        .click();
      await expect(
        page.getByRole("button", { name: "Сохранить размещение", exact: true }),
      ).toBeDisabled();
    }
    await page
      .getByRole("button", { name: "Показать всё", exact: true })
      .click();
    await page.screenshot({
      path: ".local/spatial-workspace.png",
      fullPage: true,
    });
    expect(f.server.repo.objects(f.space.id)).toEqual(notes);
    await page.reload();
    await page
      .getByRole("button", { name: "Пространственная область", exact: true })
      .click();
    await expect(page.locator(".view-row")).toHaveCount(9);
    await expect(
      page.locator(".view-row").first().getByLabel("Скрыть у меня"),
    ).toBeChecked();
    await f.stop();
    await f.restart();
    await expect(peer.getByText("● На связи")).toBeVisible();
    await expect(peer.locator(".view-row")).toHaveCount(9);
    // A different actor reads the same scene but has no placement permissions.
    const reader = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    try {
      const p = await reader.newPage();
      await p.goto(f.url);
      await p.getByLabel("ID участника").fill(f.member.id);
      await p.getByLabel("Учётный секрет").fill(f.member.secret);
      await p.getByRole("button", { name: "Войти", exact: true }).click();
      await p
        .getByRole("button", { name: "Пространственная область", exact: true })
        .click();
      await expect(p.locator(".view-row")).toHaveCount(9);
      await expect(
        p.getByRole("button", { name: "Добавить View", exact: true }),
      ).toBeDisabled();
      await p.locator(".view-row").first().getByRole("button").click();
      await expect(p.getByLabel("position.x", { exact: true })).toBeDisabled();
      await f.grant(f.member, []);
      await expect(p.locator(".view-row")).toHaveCount(0);
    } finally {
      await reader.close();
    }
    expect(errors).toEqual([]);
  } finally {
    await desktop.close();
    await second.close();
    await f.close();
  }
});
test("Composition: independent source ACL, unknown renderer fallback and read revocation", async ({
  browser,
}) => {
  const f = await fixture({
    extraRenderers: [
      {
        id: "future.panel",
        version: 0,
        name: "Future",
        object_types: ["note"],
        required_capabilities: ["6dof"],
        config_schema: { type: "object", additionalProperties: false },
      },
    ],
  });
  const ctx = await browser.newContext({
    viewport: { width: 1400, height: 1000 },
  });
  try {
    const foreign = { ...f.space, id: randomUUID(), name: "Второй источник" };
    f.server.repo.saveSpace(foreign);
    f.server.repo.grant(foreign.id, f.owner.id, [
      "read",
      "write",
      "execute",
      "manage",
    ]);
    const note = (
      await f.request(
        f.owner,
        "POST",
        `/spaces/${foreign.id}/actions`,
        f.command("Внешний документ"),
      )
    ).json().object;
    const v: SpatialView = (
      await f.request(f.owner, "POST", `/spaces/${foreign.id}/actions`, {
        request_id: randomUUID(),
        module: "spatial",
        action: "create_view",
        input: {
          object_id: note.id,
          parent_view_id: null,
          renderer_id: "future.panel",
          renderer_version: 0,
          config: {},
          transform: {
            position: { x: 0, y: 0, z: 0 },
            rotation: { x: 0, y: 0, z: 0, w: 1 },
            scale: { x: 1, y: 1, z: 1 },
          },
          visible: true,
          opacity: 1,
          layer: 0,
          order: 0,
        },
      })
    ).json().view;
    const p = await ctx.newPage();
    await p.goto(f.url);
    await p.getByLabel("ID участника").fill(f.owner.id);
    await p.getByLabel("Учётный секрет").fill(f.owner.secret);
    await p.getByRole("button", { name: "Войти", exact: true }).click();
    await p
      .getByRole("button", { name: "Пространственная область", exact: true })
      .click();
    await p.getByLabel("Второй источник", { exact: true }).check();
    await expect(p.locator(".view-row")).toHaveCount(1);
    await p.locator(".view-row button").click();
    await expect(p.getByLabel("Визуализатор", { exact: true })).toHaveValue(
      "future.panel",
    );
    expect(f.server.repo.view(v.id)?.revision).toBe(1);
    f.server.repo.grant(foreign.id, f.owner.id, []);
    f.server.publish(foreign.id);
    await expect(p.locator(".view-row")).toHaveCount(0);
    await expect(p.getByLabel("position.x", { exact: true })).toHaveCount(0);
  } finally {
    await ctx.close();
    await f.close();
  }
});
