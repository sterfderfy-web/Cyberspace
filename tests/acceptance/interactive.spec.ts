import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import { fixture } from "./fixture.js";
import {
  identityTransform,
  type SpatialView,
} from "../../packages/contracts/spatial.js";
async function seed(f: Awaited<ReturnType<typeof fixture>>, count = 2) {
  const notes = [],
    views: SpatialView[] = [];
  for (let i = 0; i < count; i++) {
    const object = (
      await f.request(
        f.owner,
        "POST",
        `/spaces/${f.space.id}/actions`,
        f.command(
          `Документ ${i + 1}`,
          Array.from(
            { length: 80 },
            (_, j) => `Строка ${j}: ${i ? "новый" : "старый"} текст`,
          ).join("\n"),
        ),
      )
    ).json().object;
    notes.push(object);
    const response = await f.request(
      f.owner,
      "POST",
      `/spaces/${f.space.id}/actions`,
      {
        request_id: randomUUID(),
        module: "spatial",
        action: "create_view",
        input: {
          object_id: object.id,
          parent_view_id: null,
          renderer_id: "notes.panel",
          renderer_version: 0,
          config: { width_m: 4, height_m: 3 },
          transform: {
            ...identityTransform(),
            position: {
              x: (i % 4) * 4.5 - 2,
              y: -Math.floor(i / 4) * 3.5,
              z: 0,
            },
          },
          visible: true,
          opacity: 1,
          layer: 0,
          order: i,
        },
      },
    );
    views.push(response.json().view);
  }
  return { notes, views };
}
async function login(
  page: Page,
  f: Awaited<ReturnType<typeof fixture>>,
  actor = f.owner,
) {
  await page.goto(f.url);
  await page.getByLabel("ID участника").fill(actor.id);
  await page.getByLabel("Учётный секрет").fill(actor.secret);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await page
    .getByRole("button", { name: "Пространственная область", exact: true })
    .click();
  await expect(page.locator(".spatial-document").first()).toBeVisible();
}
const panel = (p: Page, id: string) =>
  p.locator(`.spatial-document[data-view-id="${id}"]`);
test("Rotated editor: native hit testing, literal HTML, lost response and one scale commit", async ({
  browser,
}) => {
  const f = await fixture(),
    ctx = await browser.newContext({ viewport: { width: 1600, height: 1100 } }),
    page = await ctx.newPage();
  try {
    const { notes, views } = await seed(f, 1);
    const v = views[0];
    const {
      object_id,
      parent_view_id,
      renderer_id,
      renderer_version,
      config,
      visible,
      opacity,
      layer,
      order,
    } = v;
    const transform = {
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: Math.sin(0.3), z: 0, w: Math.cos(0.3) },
      scale: { x: 1.1, y: 0.9, z: 1 },
    };
    await f.request(f.owner, "POST", `/spaces/${f.space.id}/actions`, {
      request_id: randomUUID(),
      module: "spatial",
      action: "update_view",
      view_id: v.id,
      expected_revision: v.revision,
      input: {
        object_id,
        parent_view_id,
        renderer_id,
        renderer_version,
        config,
        transform,
        visible,
        opacity,
        layer,
        order,
      },
    });
    const savedTransform = f.server.repo.view(v.id)!.transform;
    await login(page, f);
    await page
      .getByRole("button", { name: "Редактировать документы", exact: true })
      .click();
    const doc = panel(page, v.id),
      text = doc.getByLabel("Текст документа");
    await text.click();
    await text.fill('<img src=x onerror="window.pwned=1">\nТекст с поворотом');
    await page.route(
      "**/actions",
      async (route) => {
        await route.fetch();
        await route.abort("failed");
      },
      { times: 1 },
    );
    await doc
      .getByRole("button", { name: "Сохранить документ", exact: true })
      .click();
    await expect(doc.getByText(/Результат неизвестен/)).toBeVisible();
    const revision = f.server.repo.object(notes[0].id)!.revision;
    await doc
      .getByRole("button", {
        name: "Повторить сохранение документа",
        exact: true,
      })
      .click();
    await expect(
      doc.getByText("Документ сохранён", { exact: true }),
    ).toBeVisible();
    expect(f.server.repo.object(notes[0].id)!.revision).toBe(revision);
    expect(await page.evaluate(() => (window as any).pwned)).toBeUndefined();
    await expect(doc.locator("img")).toHaveCount(0);
    expect(f.server.repo.view(v.id)!.transform).toEqual(savedTransform);
    await page
      .getByRole("button", { name: "Масштаб View", exact: true })
      .click();
    const canvas = page.locator(".spatial-canvas > canvas");
    await canvas.scrollIntoViewIfNeeded();
    const box = (await doc.boundingBox())!,
      before = f.server.repo.view(v.id)!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2, {
      steps: 8,
    });
    expect(f.server.repo.view(v.id)!.revision).toBe(before.revision);
    await page.mouse.up();
    await expect
      .poll(() => f.server.repo.view(v.id)!.revision)
      .toBe(before.revision + 1);
    expect(f.server.repo.view(v.id)!.transform.scale.x).toBeGreaterThan(
      before.transform.scale.x,
    );
    expect(f.server.repo.object(notes[0].id)!.revision).toBe(revision);
  } finally {
    await ctx.close();
    await f.close();
  }
});
test("Connected source read revocation clears editor drafts and active comparison without removing the primary workspace", async ({
  browser,
}) => {
  const f = await fixture(),
    ctx = await browser.newContext({ viewport: { width: 1600, height: 1100 } }),
    page = await ctx.newPage();
  try {
    await seed(f, 1);
    const foreign = {
      ...f.space,
      id: randomUUID(),
      name: "Защищённый источник",
    };
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
        f.command("Секретный документ", "Защищённый текст"),
      )
    ).json().object;
    const view = (
      await f.request(f.owner, "POST", `/spaces/${foreign.id}/actions`, {
        request_id: randomUUID(),
        module: "spatial",
        action: "create_view",
        input: {
          object_id: note.id,
          parent_view_id: null,
          renderer_id: "notes.panel",
          renderer_version: 0,
          config: { width_m: 4, height_m: 3 },
          transform: { ...identityTransform(), position: { x: 3, y: 0, z: 0 } },
          visible: true,
          opacity: 1,
          layer: 0,
          order: 1,
        },
      })
    ).json().view;
    await login(page, f);
    await page.getByLabel("Защищённый источник", { exact: true }).check();
    await expect(page.locator(".spatial-document")).toHaveCount(2);
    await page
      .getByRole("button", { name: "Редактировать документы", exact: true })
      .click();
    await panel(page, view.id)
      .getByLabel("Текст документа")
      .fill("Защищённый черновик");
    for (const row of await page.locator(".view-row").all())
      await row.getByLabel("Выбрать для сравнения").check();
    await page
      .getByRole("button", { name: "Сравнить выбранные View", exact: true })
      .click();
    await expect(
      page.getByLabel("Текстовое сравнение", { exact: true }),
    ).toBeVisible();
    f.server.repo.grant(foreign.id, f.owner.id, []);
    f.server.publish(foreign.id);
    await expect(page.locator(".spatial-document")).toHaveCount(1);
    await expect(
      page.getByLabel("Текстовое сравнение", { exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByText("Защищённый черновик", { exact: true }),
    ).toHaveCount(0);
    f.server.repo.grant(foreign.id, f.owner.id, ["read"]);
    await page.getByLabel("Защищённый источник", { exact: true }).uncheck();
    await page.getByLabel("Защищённый источник", { exact: true }).check();
    await expect(
      panel(page, view.id).getByLabel("Текст документа"),
    ).toHaveValue("Защищённый текст");
  } finally {
    await ctx.close();
    await f.close();
  }
});
test("Interactive documents: shared draft, focus/caret, CAS, ACL, reversible comparison and images", async ({
  browser,
}) => {
  const f = await fixture(),
    ctx = await browser.newContext({ viewport: { width: 1600, height: 1100 } }),
    peerCtx = await browser.newContext({
      viewport: { width: 1600, height: 1100 },
    });
  const page = await ctx.newPage(),
    peer = await peerCtx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    const { notes, views } = await seed(f);
    await f.grant(f.member, ["read", "write", "execute"]);
    await login(page, f);
    await login(peer, f, f.member);
    await page
      .getByRole("button", { name: "Редактировать документы", exact: true })
      .click();
    await peer
      .getByRole("button", { name: "Редактировать документы", exact: true })
      .click();
    const first = panel(page, views[0].id),
      field = first.getByLabel("Текст документа");
    await field.fill("Общий текст\nНовая строка");
    await field.evaluate((e) => {
      (window as any).__editor = e;
      (e as HTMLTextAreaElement).setSelectionRange(3, 3);
    });
    const transformBefore = f.server.repo.view(views[0].id);
    await first
      .getByRole("button", { name: "Сохранить документ", exact: true })
      .click();
    await expect(
      first.getByText("Документ сохранён", { exact: true }),
    ).toBeVisible();
    expect(f.server.repo.view(views[0].id)).toEqual(transformBefore);
    await expect(
      panel(peer, views[0].id).getByLabel("Текст документа"),
    ).toHaveValue("Общий текст\nНовая строка");
    await field.focus();
    await field.evaluate((e) =>
      (e as HTMLTextAreaElement).setSelectionRange(4, 4),
    );
    const move = {
      ...views[1],
      transform: { ...views[1].transform, position: { x: 3, y: 1, z: 0 } },
    };
    const oldStyle = await panel(page, views[1].id).getAttribute("style");
    const {
      object_id,
      parent_view_id,
      renderer_id,
      renderer_version,
      config,
      transform,
      visible,
      opacity,
      layer,
      order,
    } = move;
    await f.request(f.owner, "POST", `/spaces/${f.space.id}/actions`, {
      request_id: randomUUID(),
      module: "spatial",
      action: "update_view",
      view_id: move.id,
      expected_revision: 1,
      input: {
        object_id,
        parent_view_id,
        renderer_id,
        renderer_version,
        config,
        transform,
        visible,
        opacity,
        layer,
        order,
      },
    });
    await expect
      .poll(() => panel(page, views[1].id).getAttribute("style"))
      .not.toBe(oldStyle);
    await expect(field).toBeFocused();
    expect(
      await field.evaluate(
        (e) =>
          e === (window as any).__editor &&
          (e as HTMLTextAreaElement).selectionStart === 4,
      ),
    ).toBe(true);
    await field.fill("Черновик владельца");
    const remote = panel(peer, views[0].id);
    await remote.getByLabel("Текст документа").fill("Правка участника");
    await remote
      .getByRole("button", { name: "Сохранить документ", exact: true })
      .click();
    await expect(
      remote.getByText("Документ сохранён", { exact: true }),
    ).toBeVisible();
    await first
      .getByRole("button", { name: "Сохранить документ", exact: true })
      .click();
    await expect(first.getByText(/Конфликт документа/)).toBeVisible();
    await expect(field).toHaveValue("Черновик владельца");
    await first
      .getByRole("button", { name: "Перечитать документ", exact: true })
      .click();
    await expect(field).toHaveValue("Правка участника");
    // One Object, two independent View panels, one editor draft.
    const v = views[0];
    await f.request(f.owner, "POST", `/spaces/${f.space.id}/actions`, {
      request_id: randomUUID(),
      module: "spatial",
      action: "create_view",
      input: {
        object_id: v.object_id,
        parent_view_id: null,
        renderer_id: v.renderer_id,
        renderer_version: 0,
        config: v.config,
        transform: { ...identityTransform(), position: { x: -2, y: 4, z: 0 } },
        visible: true,
        opacity: 1,
        layer: 0,
        order: 2,
      },
    });
    await expect(page.locator(".spatial-document")).toHaveCount(3);
    await field.fill("Два View одного Object");
    await expect(
      page.locator(`[data-object-id="${v.object_id}"] textarea`).nth(1),
    ).toHaveValue("Два View одного Object");
    await first
      .getByRole("button", { name: "Сохранить документ", exact: true })
      .click();
    await expect(
      first.getByText("Документ сохранён", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Выбор / перемещение", exact: true })
      .click();
    expect(await first.evaluate((e) => getComputedStyle(e).pointerEvents)).toBe(
      "none",
    );
    await page
      .locator(".view-row")
      .nth(0)
      .getByLabel("Выбрать для сравнения")
      .check();
    await page
      .locator(".view-row")
      .nth(1)
      .getByLabel("Выбрать для сравнения")
      .check();
    const saved = f.server.repo.views(f.space.id);
    const originalProjection = await panel(page, views[1].id).evaluate(
      (e) => e.style.transform,
    );
    await page
      .getByRole("button", { name: "Сравнить выбранные View", exact: true })
      .click();
    await expect(page.locator(".diff-added").first()).toBeVisible();
    await page.getByLabel("Прозрачность верхнего View").fill("0.3");
    expect(f.server.repo.views(f.space.id)).toEqual(saved);
    await page.getByRole("button", { name: "Только A", exact: true }).click();
    await expect(panel(page, views[1].id)).toBeHidden();
    await page
      .getByRole("button", { name: "Редактировать документы", exact: true })
      .click();
    const objectBeforeComparisonEdit = f.server.repo.object(v.object_id)!;
    await field.fill("Сравнение обновлено");
    await expect(page.getByLabel("Различия A", { exact: true })).toContainText(
      "Сравнение обновлено",
    );
    await expect(
      page.getByText("Текстовое сравнение · с учётом личного черновика", {
        exact: true,
      }),
    ).toBeVisible();
    expect(f.server.repo.object(v.object_id)).toEqual(
      objectBeforeComparisonEdit,
    );
    await expect(remote.getByLabel("Текст документа")).toHaveValue(
      "Два View одного Object",
    );
    await expect(
      peer.getByLabel("Текстовое сравнение", { exact: true }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "Наложение", exact: true }).click();
    await page
      .getByLabel("Различия A", { exact: true })
      .evaluate((e) => (e.scrollTop = 300));
    await expect
      .poll(() =>
        page
          .getByLabel("Различия B", { exact: true })
          .evaluate((e) => e.scrollTop),
      )
      .toBeGreaterThan(0);
    await page
      .getByRole("button", { name: "Завершить сравнение", exact: true })
      .click();
    expect(f.server.repo.views(f.space.id)).toEqual(saved);
    await expect
      .poll(() => panel(page, views[1].id).evaluate((e) => e.style.transform))
      .toBe(originalProjection);
    await page
      .getByRole("button", { name: "Сравнение изображений", exact: true })
      .click();
    const image = page.getByLabel("Результат сравнения изображений", {
      exact: true,
    });
    const blend = await image.evaluate((e) =>
      Array.from(
        (e as HTMLCanvasElement).getContext("2d")!.getImageData(100, 100, 1, 1)
          .data,
      ),
    );
    await page
      .getByLabel("Режим изображения", { exact: true })
      .selectOption("difference");
    const diff = await image.evaluate((e) =>
      Array.from(
        (e as HTMLCanvasElement).getContext("2d")!.getImageData(100, 100, 1, 1)
          .data,
      ),
    );
    expect(diff).not.toEqual(blend);
    await remote
      .getByLabel("Текст документа")
      .fill("Не потерять при отзыве write");
    await f.grant(f.member, ["read"]);
    await expect(remote.getByLabel("Текст документа")).toHaveAttribute(
      "readonly",
      "",
    );
    await expect(remote.getByLabel("Текст документа")).toHaveValue(
      "Не потерять при отзыве write",
    );
    await expect(
      remote.getByRole("button", { name: "Сохранить документ", exact: true }),
    ).toBeDisabled();
    await f.grant(f.member, []);
    await expect(peer.locator(".spatial-document")).toHaveCount(0);
    await expect(
      peer.getByText("Не потерять при отзыве write", { exact: true }),
    ).toHaveCount(0);
    await page.reload();
    await page
      .getByRole("button", { name: "Пространственная область", exact: true })
      .click();
    await expect(page.locator(".spatial-document")).toHaveCount(3);
    expect(f.server.repo.views(f.space.id)).toEqual(saved);
    expect(errors).toEqual([]);
  } finally {
    await ctx.close();
    await peerCtx.close();
    await f.close();
  }
});
test("Eight interactive documents: measured navigation cadence, input latency, heap and resource lifecycle", async ({
  browser,
}) => {
  const f = await fixture(),
    ctx = await browser.newContext({ viewport: { width: 1600, height: 1100 } }),
    page = await ctx.newPage();
  try {
    await seed(f, 8);
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("Performance.enable");
    await login(page, f);
    await page
      .getByRole("button", { name: "Показать всё", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Редактировать документы", exact: true })
      .click();
    await expect(page.locator(".spatial-document")).toHaveCount(8);
    expect(
      await page
        .locator(".spatial-document textarea")
        .first()
        .evaluate((e) => {
          const r = e.getBoundingClientRect();
          return (
            document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) ===
            e
          );
        }),
    ).toBe(true);
    const resourceBefore = await page
      .locator(".spatial-canvas")
      .getAttribute("data-resources");
    await cdp.send("HeapProfiler.collectGarbage");
    const before = await cdp.send("Performance.getMetrics");
    const domBefore = await cdp.send("Memory.getDOMCounters");
    const navigation = await page.evaluate(async () => {
      const stats = (
        document.querySelector(".spatial-canvas") as HTMLElement & {
          spatialFrameStats: { rendered: number };
        }
      ).spatialFrameStats;
      const renderStart = stats.rendered;
      const canvas = document.querySelector(".spatial-canvas > canvas")!;
      const rect = canvas.getBoundingClientRect();
      const intervals: number[] = [];
      let last = performance.now();
      const started = last;
      for (let i = 0; i < 3000 && performance.now() - started < 8000; i++) {
        canvas.dispatchEvent(
          new WheelEvent("wheel", {
            deltaY: i % 40 < 20 ? 4 : -4,
            clientX: rect.x + rect.width / 2,
            clientY: rect.y + rect.height / 2,
            bubbles: true,
            cancelable: true,
          }),
        );
        await new Promise<void>((resolve) =>
          requestAnimationFrame((time) => {
            intervals.push(time - last);
            last = time;
            resolve();
          }),
        );
      }
      return {
        intervals: intervals.slice(1),
        rendered: stats.rendered - renderStart,
        elapsedMs: performance.now() - started,
      };
    });
    const frames = navigation.intervals;
    const field = page.locator(".spatial-document textarea").first();
    await field.focus();
    await field.evaluate((e) => {
      (window as any).__latencies = [];
      e.addEventListener("input", () => {
        const start = performance.now();
        requestAnimationFrame(() =>
          requestAnimationFrame(() =>
            (window as any).__latencies.push(performance.now() - start),
          ),
        );
      });
    });
    await field.press("End");
    await field.pressSequentially(" performance", { delay: 70 });
    await expect
      .poll(() => page.evaluate(() => (window as any).__latencies.length))
      .toBe(12);
    const latencies: number[] = await page.evaluate(
      () => (window as any).__latencies,
    );
    const transient = await cdp.send("Performance.getMetrics");
    await cdp.send("HeapProfiler.collectGarbage");
    const after = await cdp.send("Performance.getMetrics"),
      domAfter = await cdp.send("Memory.getDOMCounters");
    expect(
      await page.locator(".spatial-canvas").getAttribute("data-resources"),
    ).toBe(resourceBefore);
    const percentile = (a: number[], p: number) =>
      [...a].sort((x, y) => x - y)[
        Math.min(a.length - 1, Math.floor(a.length * p))
      ];
    const heap = (m: { metrics: { name: string; value: number }[] }) =>
      m.metrics.find((v) => v.name === "JSHeapUsedSize")!.value;
    const report = {
      date: new Date().toISOString(),
      environment: {
        os: os.platform(),
        release: os.release(),
        cpu: os.cpus()[0]?.model,
        browser: browser.version(),
        viewport: "1600x1100",
        headless: true,
        documents: 8,
        linesPerDocument: 80,
      },
      navigation: {
        renderedFrames: navigation.rendered,
        renderCallsFps: (navigation.rendered * 1000) / navigation.elapsedMs,
        frames: frames.length,
        seconds: frames.reduce((a, b) => a + b, 0) / 1000,
        rafFps: 1000 / (frames.reduce((a, b) => a + b, 0) / frames.length),
        frameP50Ms: percentile(frames, 0.5),
        frameP95Ms: percentile(frames, 0.95),
      },
      input: {
        samples: latencies.length,
        inputToSecondRafP50Ms: percentile(latencies, 0.5),
        inputToSecondRafP95Ms: percentile(latencies, 0.95),
      },
      memory: {
        jsHeapBeforeBytes: heap(before),
        jsHeapAfterBytes: heap(after),
        jsHeapTransientBytes: heap(transient),
        domBefore,
        domAfter,
      },
      resources: JSON.parse(resourceBefore!),
      scope:
        "8 seconds rAF cadence and WebGL render-call count during wheel navigation; input event to second rAF; CDP JS heap before/after GC plus transient sample, not total RAM/VRAM or physical display FPS",
    };
    mkdirSync(".local/measurements", { recursive: true });
    writeFileSync(
      ".local/measurements/pr6-performance.json",
      JSON.stringify(report, null, 2),
    );
    console.log("PR6 performance: " + JSON.stringify(report));
    await page.screenshot({
      path: ".local/pr6-interactive.png",
      fullPage: true,
    });
    await page
      .locator(".spatial-canvas")
      .evaluate((e) => ((window as any).__oldSpatialHost = e));
    await page.getByRole("button", { name: /Заметки 8/ }).click();
    await expect(page.locator(".spatial-document")).toHaveCount(0);
    const released = await page.evaluate(() =>
      JSON.parse((window as any).__oldSpatialHost.dataset.resources),
    );
    expect(released.live).toBe(0);
    expect(released.created).toBe(released.disposed);
    await cdp.detach();
  } finally {
    await ctx.close();
    await f.close();
  }
});
