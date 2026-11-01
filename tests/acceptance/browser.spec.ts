import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { fixture } from "./fixture.js";
import type { Command, Note } from "../../packages/contracts/index.js";
test("A01–A03, A05, A07–A12: браузеры, LAN HTTP, конфликт, обрыв, рестарт", async ({
  browser,
}) => {
  const f = await fixture();
  const host = process.env.CYBERSPACE_TEST_HOST ?? "127.0.0.1",
    url = `http://${host}:${f.port}`;
  f.config.origins.push(url);
  const desktop = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const tablet = await browser.newContext({
    viewport: { width: 820, height: 1180 },
    isMobile: true,
    hasTouch: true,
  });
  const external: string[] = [],
    errors: string[] = [];
  for (const ctx of [desktop, mobile, tablet]) {
    await ctx.route("**/*", (route) => {
      if (new URL(route.request().url()).origin !== url) {
        external.push(route.request().url());
        void route.abort();
      } else void route.continue();
    });
    ctx.on("page", (page) =>
      page.on("pageerror", (e) => errors.push(e.message)),
    );
  }
  const owner = await desktop.newPage(),
    member = await mobile.newPage(),
    third = await tablet.newPage();
  const login = async (page: Page, actor: typeof f.owner) => {
    await page.goto(url);
    await page.getByLabel("ID участника").fill(actor.id);
    await page.getByLabel("Учётный секрет").fill(actor.secret);
    await page.getByRole("button", { name: "Войти", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Мастерская", exact: true }),
    ).toBeVisible();
    await expect(page.getByText("● На связи")).toBeVisible();
  };
  try {
    await login(owner, f.owner);
    await login(member, f.member);
    await login(third, f.owner);
    const cookies = await mobile.cookies(url);
    expect(cookies[0].httpOnly).toBeTruthy();
    expect(cookies[0].secure).toBeFalsy();
    expect(cookies[0].sameSite).toBe("Strict");
    await owner.getByRole("button", { name: "Новая заметка" }).click();
    await owner
      .getByLabel("Заголовок", { exact: true })
      .fill("План мастерской");
    await owner
      .getByLabel("Текст", { exact: true })
      .fill("Общая заметка с ноутбука");
    const started = Date.now();
    await owner.getByRole("button", { name: "Сохранить", exact: true }).click();
    await expect(owner.getByText("Сохранено", { exact: true })).toBeVisible();
    await expect(
      member.getByRole("button", { name: /План мастерской/ }),
    ).toBeVisible({ timeout: 2000 });
    expect(Date.now() - started).toBeLessThan(2000);
    await member.getByRole("button", { name: /План мастерской/ }).click();
    await expect(member.getByLabel("Текст", { exact: true })).toHaveValue(
      "Общая заметка с ноутбука",
    );
    await expect(
      member.getByRole("button", { name: "Сохранить", exact: true }),
    ).toBeDisabled();
    await owner.getByRole("button", { name: "Новая заметка" }).click();
    await owner.getByLabel("Заголовок", { exact: true }).fill("Вторая заметка");
    await owner.getByLabel("Текст", { exact: true }).fill("Другой выбор");
    await owner.getByRole("button", { name: "Сохранить", exact: true }).click();
    await expect(
      member.getByRole("button", { name: /Вторая заметка/ }),
    ).toBeVisible();
    await expect(member.getByLabel("Заголовок", { exact: true })).toHaveValue(
      "План мастерской",
    );
    // A03: две вкладки одного Actor тоже не делят выбранную заметку.
    const sameActorTab = await desktop.newPage();
    await sameActorTab.goto(url);
    await sameActorTab.getByRole("button", { name: /План мастерской/ }).click();
    await expect(owner.getByLabel("Заголовок", { exact: true })).toHaveValue(
      "Вторая заметка",
    );
    await sameActorTab.close();
    // A02: ровно 10 заметок, 1 подтверждённое изменение/сек, два активных клиента.
    for (let i = 0; i < 8; i++)
      expect(
        (
          await f.request(
            f.owner,
            "POST",
            `/spaces/${f.space.id}/actions`,
            f.command(`Рабочая ${i}`),
          )
        ).statusCode,
      ).toBe(200);
    const target = f.server.repo.objects(f.space.id)[0],
      latencies: number[] = [];
    for (let i = 0; i < 5; i++) {
      const current = f.server.repo.object(target.id)!;
      const start = Date.now();
      const command: Command = {
        ...f.command(),
        action: "update_note",
        object_id: current.id,
        expected_revision: current.revision,
        input: { title: current.properties.title, text: `Синхронизация ${i}` },
      };
      expect(
        (
          await f.request(
            f.owner,
            "POST",
            `/spaces/${f.space.id}/actions`,
            command,
          )
        ).statusCode,
      ).toBe(200);
      await expect(member.getByLabel("Текст", { exact: true })).toHaveValue(
        `Синхронизация ${i}`,
        { timeout: 2000 },
      );
      latencies.push(Date.now() - start);
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, 1000 - (Date.now() - start))),
      );
    }
    console.log("A02 LAN HTTP: задержки, мс:", latencies.join(", "));
    expect(Math.max(...latencies)).toBeLessThan(2000);
    // Выдача через настоящий UI владельца, действующая в уже открытом mobile.
    await owner.getByRole("button", { name: "☷ Участники и права" }).click();
    await owner.getByLabel("Участник: Изменение", { exact: true }).click();
    await expect(
      owner.getByLabel("Участник: Изменение", { exact: true }),
    ).toBeChecked();
    await expect(
      owner.getByLabel("Участник: Изменение", { exact: true }),
    ).toBeEnabled();
    await owner.getByLabel("Участник: Выполнение", { exact: true }).click();
    await expect(
      owner.getByLabel("Участник: Выполнение", { exact: true }),
    ).toBeChecked();
    await expect(member.getByLabel("Текст", { exact: true })).toBeEditable();
    await member
      .getByLabel("Текст", { exact: true })
      .fill("Черновик участника");
    // Конфликт: чужая версия приходит в фоне, локальный текст остаётся.
    const current = f.server.repo.object(target.id)!;
    await f.request(f.owner, "POST", `/spaces/${f.space.id}/actions`, {
      ...f.command(),
      action: "update_note",
      object_id: current.id,
      expected_revision: current.revision,
      input: {
        title: current.properties.title,
        text: "Новая серверная версия",
      },
    });
    await expect(
      member.getByText(
        "Заметка изменена другим участником. Ваш черновик не перезаписан.",
      ),
    ).toBeVisible();
    await expect(member.getByLabel("Текст", { exact: true })).toHaveValue(
      "Черновик участника",
    );
    await member
      .getByRole("button", { name: "Сохранить", exact: true })
      .click();
    await expect(
      member.getByText("Конфликт · черновик сохранён в этой вкладке"),
    ).toBeVisible();
    member.once("dialog", (dialog) => dialog.accept());
    await member
      .getByRole("button", { name: "Перечитать", exact: true })
      .click();
    await expect(member.getByLabel("Текст", { exact: true })).toHaveValue(
      "Новая серверная версия",
    );
    // Ответ потерялся ПОСЛЕ commit. Повтор с тем же request_id не создаёт вторую правку.
    let dropped = false;
    await mobile.route("**/actions", async (route) => {
      if (!dropped) {
        dropped = true;
        await route.fetch();
        await route.abort("failed");
      } else await route.continue();
    });
    await member
      .getByLabel("Текст", { exact: true })
      .fill("Повтор после потерянного ответа");
    const revision = f.server.repo.object(target.id)!.revision;
    await member
      .getByRole("button", { name: "Сохранить", exact: true })
      .click();
    await expect(
      member.getByRole("button", { name: "Повторить запрос" }),
    ).toBeVisible();
    await member.getByRole("button", { name: "Повторить запрос" }).click();
    await expect(member.getByText("Сохранено", { exact: true })).toBeVisible();
    expect(f.server.repo.object(target.id)!.revision).toBe(revision + 1);
    await mobile.unroute("**/actions");
    await owner.getByLabel("Участник: Изменение", { exact: true }).click();
    await expect(
      owner.getByLabel("Участник: Изменение", { exact: true }),
    ).not.toBeChecked();
    await expect(
      member.getByLabel("Текст", { exact: true }),
    ).not.toBeEditable();
    // Разрыв и восстановление с актуальным снимком.
    await mobile.setOffline(true);
    for (const [socket, c] of f.server.clients) {
      const s = f.server.repo.session(c.token);
      if (s?.actor_id === f.member.id) socket.terminate();
    }
    await expect(member.getByText("● Нет связи")).toBeVisible();
    const now = f.server.repo.object(target.id)!;
    await f.request(f.owner, "POST", `/spaces/${f.space.id}/actions`, {
      ...f.command(),
      action: "update_note",
      object_id: now.id,
      expected_revision: now.revision,
      input: { title: now.properties.title, text: "Изменено во время разрыва" },
    });
    await mobile.setOffline(false);
    await expect(member.getByText("● На связи")).toBeVisible({
      timeout: 15000,
    });
    await expect(member.getByLabel("Текст", { exact: true })).toHaveValue(
      "Изменено во время разрыва",
    );
    await f.stop();
    await expect(member.getByText("● Нет связи")).toBeVisible();
    await f.restart();
    await expect(member.getByText("● На связи")).toBeVisible({
      timeout: 15000,
    });
    await expect(member.getByLabel("Текст", { exact: true })).toHaveValue(
      "Изменено во время разрыва",
    );
    // A07 очистка UI после отзыва read.
    await f.grant(f.member, []);
    await expect(
      member.getByRole("heading", { name: "Нет доступного пространства" }),
    ).toBeVisible();
    await expect(member.getByLabel("Текст", { exact: true })).toHaveCount(0);
    await f.grant(f.member, ["read"]);
    await member.getByRole("button", { name: "Обновить", exact: true }).click();
    await expect(
      member.getByRole("button", { name: /План мастерской/ }),
    ).toBeVisible();
    await member.getByRole("button", { name: /План мастерской/ }).click();
    await owner.getByRole("button", { name: /Заметки 10/ }).click();
    await third.getByRole("button", { name: /План мастерской/ }).click();
    for (const page of [owner, member, third])
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBeTruthy();
    mkdirSync(".local/screenshots", { recursive: true });
    await owner.screenshot({
      path: ".local/screenshots/desktop.png",
      fullPage: true,
    });
    await member.screenshot({
      path: ".local/screenshots/mobile.png",
      fullPage: true,
    });
    await third.screenshot({
      path: ".local/screenshots/tablet.png",
      fullPage: true,
    });
    // На этой Windows Kaspersky внедряет скрипт в HTTP-ответы. Он также заблокирован;
    // отдельно проверяем исходный HTML сервера и отсутствие внешних запросов приложения.
    const source = await f.server.app.inject("/");
    expect(source.body).not.toMatch(/https?:\/\//);
    expect(source.body).not.toContain("kaspersky");
    const injected = external.filter(
      (address) =>
        new URL(address).hostname === "me.kis.v2.scr.kaspersky-labs.com",
    );
    expect(external.filter((address) => !injected.includes(address))).toEqual(
      [],
    );
    expect(errors).toEqual([]);
    console.log(
      "A12: все внешние HTTP-запросы заблокированы; приложение: 0; внедрённые окружением:",
      injected.length,
    );
  } finally {
    await desktop.close();
    await mobile.close();
    await tablet.close();
    await f.close();
  }
});

test("A13: экспорт и повтор импорта после потерянного ответа в интерфейсе", async ({
  browser,
}) => {
  const f = await fixture();
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await f.request(
      f.owner,
      "POST",
      `/spaces/${f.space.id}/actions`,
      f.command("Переносимая заметка", "Текст копии"),
    );
    await page.goto(f.url);
    await page.getByLabel("ID участника").fill(f.owner.id);
    await page.getByLabel("Учётный секрет").fill(f.owner.secret);
    await page.getByRole("button", { name: "Войти", exact: true }).click();
    const downloaded = page.waitForEvent("download");
    await page.getByRole("button", { name: "Экспорт", exact: true }).click();
    const download = await downloaded;
    expect(download.suggestedFilename()).toBe("cyberspace-notes.json");
    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
    const exported = Buffer.concat(chunks);
    const data = JSON.parse(exported.toString());
    expect(data.objects[0].properties.text).toBe("Текст копии");
    let dropped = false;
    await context.route("**/api/v0/imports", async (route) => {
      if (!dropped) {
        dropped = true;
        await route.fetch();
        await route.abort();
      } else await route.continue();
    });
    const file = {
      name: "cyberspace-notes.json",
      mimeType: "application/json",
      buffer: exported,
    };
    await page.locator("input[type=file]").setInputFiles(file);
    await expect(
      page.getByText(
        "Результат импорта неизвестен. Выберите тот же файл повторно; копия не будет создана дважды",
      ),
    ).toBeVisible();
    expect(f.server.repo.spaces()).toHaveLength(2);
    await page.locator("input[type=file]").setInputFiles(file);
    await expect(
      page.getByText("Создана независимая копия пространства"),
    ).toBeVisible();
    expect(f.server.repo.spaces()).toHaveLength(2);
    const copy = f.server.repo.spaces().find((s) => s.id !== f.space.id)!;
    await page.getByLabel("Выбор пространства").selectOption(copy.id);
    await page.getByRole("button", { name: /Переносимая заметка/ }).click();
    await expect(page.getByLabel("Текст", { exact: true })).toHaveValue(
      "Текст копии",
    );
  } finally {
    await context.close();
    await f.close();
  }
});
