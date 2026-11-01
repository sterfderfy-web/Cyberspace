import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import WebSocket from "ws";
import { fixture } from "./fixture.js";
import type { Command, Note } from "../../packages/contracts/index.js";
async function subscribed(
  f: Awaited<ReturnType<typeof fixture>>,
  actor = f.member,
) {
  const socket = new WebSocket(
    f.url.replace("http", "ws") + `/api/v0/spaces/${f.space.id}/events`,
    {
      headers: { Origin: f.url, Authorization: `Bearer ${f.tokens[actor.id]}` },
    },
  );
  const first = await once(socket, "message");
  assert.equal(JSON.parse(first[0].toString()).type, "space.changed");
  return socket;
}
test("API v0: права, транзакции, повторы, восстановление и переносимость", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  let note: Note;
  await t.test(
    "A01/A02: два Actor видят одну подтверждённую заметку, уведомление без текста",
    async () => {
      const socket = await subscribed(f);
      try {
        const message = once(socket, "message");
        const response = await f.request(
          f.owner,
          "POST",
          `/spaces/${f.space.id}/actions`,
          f.command(),
        );
        assert.equal(response.statusCode, 200);
        note = response.json().object;
        const event = JSON.parse((await message)[0].toString());
        assert.deepEqual(Object.keys(event).sort(), [
          "cursor",
          "space_id",
          "type",
          "version",
        ]);
        const second = await f.request(
          f.member,
          "GET",
          `/spaces/${f.space.id}`,
        );
        assert.equal(second.json().objects[0].id, note.id);
      } finally {
        socket.terminate();
      }
    },
  );
  await t.test(
    "A04: прямой вызов читателя, отдельные write/execute/manage, журнал закрыт",
    async () => {
      const before = f.server.repo.space(f.space.id)!.revision;
      assert.equal(
        (
          await f.request(
            f.member,
            "POST",
            `/spaces/${f.space.id}/actions`,
            f.command(),
          )
        ).statusCode,
        403,
      );
      for (const path of ["permissions", "audit", "export"])
        assert.equal(
          (await f.request(f.member, "GET", `/spaces/${f.space.id}/${path}`))
            .statusCode,
          403,
        );
      assert.equal(f.server.repo.space(f.space.id)!.revision, before);
      assert.equal(
        (
          await f.request(
            f.member,
            "PUT",
            `/spaces/${f.space.id}/permissions/${f.member.id}`,
            {
              request_id: randomUUID(),
              expected_space_revision: before,
              actions: ["read", "manage"],
            },
          )
        ).statusCode,
        403,
      );
      await f.grant(f.member, ["read", "write"]);
      assert.equal(
        (
          await f.request(
            f.member,
            "POST",
            `/spaces/${f.space.id}/actions`,
            f.command(),
          )
        ).statusCode,
        403,
      );
      await f.grant(f.member, ["read", "execute"]);
      assert.equal(
        (
          await f.request(
            f.member,
            "POST",
            `/spaces/${f.space.id}/actions`,
            f.command(),
          )
        ).statusCode,
        403,
      );
    },
  );
  await t.test(
    "A05: выдача и отзыв write в существующей сессии; повтор тоже запрещён",
    async () => {
      assert.equal(
        (await f.grant(f.member, ["read", "write", "execute"])).statusCode,
        200,
      );
      const command = f.command("Участник");
      assert.equal(
        (
          await f.request(
            f.member,
            "POST",
            `/spaces/${f.space.id}/actions`,
            command,
          )
        ).statusCode,
        200,
      );
      await f.grant(f.member, ["read", "execute"]);
      assert.equal(
        (
          await f.request(
            f.member,
            "POST",
            `/spaces/${f.space.id}/actions`,
            command,
          )
        ).statusCode,
        403,
      );
      assert.equal(
        (
          await f.request(
            f.member,
            "POST",
            `/spaces/${f.space.id}/actions`,
            f.command(),
          )
        ).statusCode,
        403,
      );
    },
  );
  await t.test(
    "A06: агент работает через сетевой API; отзыв execute и audit",
    async () => {
      const headers = {
        Origin: f.url,
        Authorization: `Bearer ${f.tokens[f.agent.id]}`,
        "Content-Type": "application/json",
      };
      const action = () =>
        fetch(`${f.url}/api/v0/spaces/${f.space.id}/actions`, {
          method: "POST",
          headers,
          body: JSON.stringify(f.command("Действие агента")),
        });
      assert.equal((await action()).status, 200);
      await f.grant(f.agent, ["read", "write"]);
      assert.equal((await action()).status, 403);
      const audit = (
        await f.request(f.owner, "GET", `/spaces/${f.space.id}/audit`)
      ).json();
      assert.ok(
        audit.some(
          (a: { actor_id: string; result: string }) =>
            a.actor_id === f.agent.id && a.result === "OK",
        ),
      );
      assert.ok(
        audit.some(
          (a: { actor_id: string; result: string }) =>
            a.actor_id === f.agent.id && a.result === "FORBIDDEN",
        ),
      );
      assert.ok(!JSON.stringify(audit).includes(f.agent.secret));
      assert.ok(!JSON.stringify(audit).includes("Начальный текст"));
    },
  );
  await t.test(
    "A07: read отзывается у открытой подписки, снимка, экспорта и агента",
    async () => {
      const socket = await subscribed(f);
      const closed = once(socket, "close");
      await f.grant(f.member, []);
      assert.equal((await closed)[0], 1008);
      assert.equal(
        (await f.request(f.member, "GET", `/spaces/${f.space.id}`)).statusCode,
        404,
      );
      assert.deepEqual(
        (await f.request(f.member, "GET", "/spaces")).json(),
        [],
      );
      assert.equal(
        (await f.request(f.member, "GET", `/spaces/${f.space.id}/export`))
          .statusCode,
        404,
      );
      await f.grant(f.agent, []);
      assert.equal(
        (
          await f.request(
            f.agent,
            "POST",
            `/spaces/${f.space.id}/actions`,
            f.command(),
          )
        ).statusCode,
        404,
      );
      await f.grant(f.member, ["read", "write", "execute"]);
    },
  );
  await t.test(
    "A08: одновременная запись одной ревизии — 200/409; транзакция без частичной записи",
    async () => {
      const make = (text: string): Command => ({
        ...f.command(),
        action: "update_note",
        object_id: note.id,
        expected_revision: note.revision,
        input: { title: note.properties.title, text },
      });
      const responses = await Promise.all([
        f.request(
          f.owner,
          "POST",
          `/spaces/${f.space.id}/actions`,
          make("Правка владельца"),
        ),
        f.request(
          f.member,
          "POST",
          `/spaces/${f.space.id}/actions`,
          make("Правка участника"),
        ),
      ]);
      assert.deepEqual(responses.map((r) => r.statusCode).sort(), [200, 409]);
      const winner = responses.find((r) => r.statusCode === 200)!.json().object;
      assert.deepEqual(f.server.repo.object(note.id), winner);
      note = winner;
      const count = f.server.repo.objects(f.space.id).length,
        revision = f.server.repo.space(f.space.id)!.revision;
      const original = f.server.repo.event.bind(f.server.repo);
      f.server.repo.event = () => {
        throw new Error("Injected storage failure");
      };
      try {
        assert.equal(
          (
            await f.request(
              f.owner,
              "POST",
              `/spaces/${f.space.id}/actions`,
              f.command(),
            )
          ).statusCode,
          500,
        );
      } finally {
        f.server.repo.event = original;
      }
      assert.equal(f.server.repo.objects(f.space.id).length, count);
      assert.equal(f.server.repo.space(f.space.id)!.revision, revision);
    },
  );
  await t.test(
    "A09: request_id даёт один результат, другое тело и цель дают 409",
    async () => {
      const command = f.command("Повтор");
      const first = await f.request(
        f.owner,
        "POST",
        `/spaces/${f.space.id}/actions`,
        command,
      );
      const revision = f.server.repo.space(f.space.id)!.revision;
      const second = await f.request(
        f.owner,
        "POST",
        `/spaces/${f.space.id}/actions`,
        command,
      );
      assert.equal(second.statusCode, 200);
      assert.deepEqual(first.json(), second.json());
      assert.equal(f.server.repo.space(f.space.id)!.revision, revision);
      assert.equal(
        (
          await f.request(f.owner, "POST", `/spaces/${f.space.id}/actions`, {
            ...command,
            input: { title: "Другое", text: "" },
          })
        ).statusCode,
        409,
      );
      const rows = f.server.repo
        .audits(f.space.id)
        .filter(
          (a) => a.request_id === command.request_id && a.result === "OK",
        );
      assert.equal(rows.length, 1);
    },
  );
  await t.test(
    "A10: рестарт сохраняет объекты, права, cursor, audit, сессию и дедупликацию",
    async () => {
      const command = f.command("После рестарта");
      const before = (
        await f.request(
          f.owner,
          "POST",
          `/spaces/${f.space.id}/actions`,
          command,
        )
      ).json();
      const snapshot = f.server.core.snapshot(
          {
            actor: f.owner,
            session: f.server.repo.session(f.tokens[f.owner.id])!,
          },
          f.space.id,
        ),
        audit = f.server.repo.audits(f.space.id);
      const rights = f.server.repo.rights(f.space.id, f.member.id);
      await f.stop();
      await f.restart();
      assert.deepEqual(
        (await f.request(f.owner, "GET", `/spaces/${f.space.id}`)).json(),
        snapshot,
      );
      assert.deepEqual(f.server.repo.rights(f.space.id, f.member.id), rights);
      assert.deepEqual(f.server.repo.audits(f.space.id), audit);
      assert.deepEqual(
        (
          await f.request(
            f.owner,
            "POST",
            `/spaces/${f.space.id}/actions`,
            command,
          )
        ).json(),
        before,
      );
    },
  );
  await t.test(
    "A11: повторная подписка получает новый cursor и снимок",
    async () => {
      const socket = await subscribed(f);
      socket.terminate();
      await f.request(
        f.owner,
        "POST",
        `/spaces/${f.space.id}/actions`,
        f.command("Во время разрыва"),
      );
      const next = await subscribed(f);
      try {
        const snapshot = (
          await f.request(f.member, "GET", `/spaces/${f.space.id}`)
        ).json();
        assert.ok(
          snapshot.objects.some(
            (n: Note) => n.properties.title === "Во время разрыва",
          ),
        );
      } finally {
        next.terminate();
      }
    },
  );
  await t.test(
    "A13: экспорт в чистый экземпляр, новые ID, без секретов и чужих прав",
    async () => {
      const exported = (
        await f.request(f.owner, "GET", `/spaces/${f.space.id}/export`)
      ).json();
      const clean = await fixture();
      try {
        assert.deepEqual(Object.keys(exported).sort(), [
          "objects",
          "space",
          "version",
        ]);
        const input = { ...exported, request_id: randomUUID() };
        const imported = await clean.request(
          clean.owner,
          "POST",
          "/imports",
          input,
        );
        assert.equal(imported.statusCode, 200);
        const id = imported.json().space.id;
        assert.notEqual(id, f.space.id);
        const copied = (
          await clean.request(clean.owner, "GET", `/spaces/${id}`)
        ).json();
        assert.deepEqual(
          copied.objects.map((n: Note) => n.properties),
          exported.objects.map((n: Note) => n.properties),
        );
        assert.ok(
          copied.objects.every((n: Note) => !f.server.repo.object(n.id)),
        );
        assert.equal(
          (await clean.request(clean.member, "GET", `/spaces/${id}`))
            .statusCode,
          404,
        );
        assert.equal(
          (
            await clean.server.app.inject({
              url: `/api/v0/spaces/${id}`,
              headers: { Authorization: `Bearer ${f.tokens[f.owner.id]}` },
            })
          ).statusCode,
          401,
        );
        assert.deepEqual(
          (await clean.request(clean.owner, "POST", "/imports", input)).json(),
          imported.json(),
        );
        const count = clean.server.repo.spaces().length;
        for (const changed of [
          { version: 1 },
          {
            objects: [
              ...exported.objects,
              {
                type: "alien",
                schema_version: 0,
                properties: { title: "X", text: "" },
              },
            ],
          },
        ])
          assert.equal(
            (
              await clean.request(clean.owner, "POST", "/imports", {
                ...input,
                ...changed,
                request_id: randomUUID(),
              })
            ).statusCode,
            400,
          );
        assert.equal(clean.server.repo.spaces().length, count);
      } finally {
        await clean.close();
      }
    },
  );
  await t.test(
    "A14: нет сессии, поддельный Actor, Origin, строгая схема и размер",
    async () => {
      const before = f.server.repo.space(f.space.id)!.revision;
      assert.equal(
        (await f.request(null, "GET", `/spaces/${f.space.id}`)).statusCode,
        401,
      );
      assert.equal(
        (
          await f.request(f.owner, "POST", `/spaces/${f.space.id}/actions`, {
            ...f.command(),
            actor_id: f.member.id,
          })
        ).statusCode,
        400,
      );
      const login = await f.login(f.owner, "browser");
      const cookieHeader = login.headers["set-cookie"] as string;
      assert.match(cookieHeader, /HttpOnly/);
      assert.match(cookieHeader, /SameSite=Strict/i);
      assert.doesNotMatch(cookieHeader, /Secure/i);
      assert.equal(
        (
          await f.server.app.inject({
            method: "POST",
            url: `/api/v0/spaces/${f.space.id}/actions`,
            headers: {
              cookie: cookieHeader.split(";")[0],
              Origin: "http://evil.invalid",
            },
            payload: f.command(),
          })
        ).statusCode,
        403,
      );
      assert.equal(
        (
          await f.server.app.inject({
            method: "POST",
            url: `/api/v0/spaces/${f.space.id}/actions`,
            headers: { cookie: cookieHeader.split(";")[0] },
            payload: f.command(),
          })
        ).statusCode,
        403,
      );
      assert.equal(
        (
          await f.request(
            f.owner,
            "POST",
            `/spaces/${f.space.id}/actions`,
            f.command("Тест", "я".repeat(40000)),
          )
        ).statusCode,
        413,
      );
      assert.equal(
        (
          await f.request(f.owner, "POST", `/spaces/${f.space.id}/actions`, {
            ...f.command(),
            input: { title: 42, text: "" },
          })
        ).statusCode,
        400,
      );
      assert.equal(f.server.repo.space(f.space.id)!.revision, before);
      assert.equal((await f.grant(f.owner, [])).statusCode, 409);
      await f.request(f.member, "DELETE", "/session");
      assert.equal(
        (await f.request(f.member, "GET", "/spaces")).statusCode,
        401,
      );
    },
  );
});
test("Ограничения подписок, heartbeat, срок сессии и неверный Origin WS", async (t) => {
  const f = await fixture({ maxConnections: 1, heartbeatMs: 40 });
  t.after(() => f.close());
  const socket = await subscribed(f);
  const rejected = new WebSocket(
    f.url.replace("http", "ws") + `/api/v0/spaces/${f.space.id}/events`,
    {
      headers: {
        Origin: f.url,
        Authorization: `Bearer ${f.tokens[f.owner.id]}`,
      },
    },
  );
  const status = await new Promise<number>((resolve) => {
    rejected.on("unexpected-response", (_req, res) => {
      resolve(res.statusCode!);
      res.destroy();
      rejected.terminate();
    });
    rejected.on("error", () => {});
  });
  assert.equal(status, 429);
  const closed = once(socket, "close");
  f.server.repo.db
    .prepare("UPDATE sessions SET expires_at=? WHERE actor_id=?")
    .run(Date.now() - 1, f.member.id);
  assert.equal((await closed)[0], 1008);
  const wrong = new WebSocket(
    f.url.replace("http", "ws") + `/api/v0/spaces/${f.space.id}/events`,
    {
      headers: {
        Origin: "http://evil.invalid",
        Authorization: `Bearer ${f.tokens[f.owner.id]}`,
      },
    },
  );
  const denied = await new Promise<number>((resolve) => {
    wrong.on("unexpected-response", (_req, res) => {
      resolve(res.statusCode!);
      res.destroy();
      wrong.terminate();
    });
    wrong.on("error", () => {});
  });
  assert.equal(denied, 403);
});

test(
  "Heartbeat отключает молчащий клиент; переполненный буфер закрывается; disabled закрывает сессию",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture({ heartbeatMs: 100 });
    t.after(() => f.close());
    const silent = new WebSocket(
      f.url.replace("http", "ws") + `/api/v0/spaces/${f.space.id}/events`,
      {
        autoPong: false,
        headers: {
          Origin: f.url,
          Authorization: `Bearer ${f.tokens[f.member.id]}`,
        },
      },
    );
    const lost = once(silent, "close");
    await once(silent, "message");
    assert.equal((await lost)[0], 1006);
    const slow = await subscribed(f);
    const serverSocket = [...f.server.clients.keys()][0];
    // Имитируем заполненный транспортный буфер: проверяется поведение отключения подписчика.
    Object.defineProperty(serverSocket, "bufferedAmount", {
      get: () => 65537,
      configurable: true,
    });
    const overflow = once(slow, "close");
    f.server.publish(f.space.id);
    assert.equal((await overflow)[0], 1013);
    const disabled = await subscribed(f);
    const closed = once(disabled, "close");
    f.server.repo.db
      .prepare("UPDATE actors SET data=? WHERE id=?")
      .run(
        JSON.stringify({ ...f.member, secret: undefined, disabled: true }),
        f.member.id,
      );
    f.server.publish(f.space.id);
    assert.equal((await closed)[0], 1008);
    assert.equal((await f.request(f.member, "GET", "/spaces")).statusCode, 401);
  },
);

test(
  "Границы импорта, частота входа и повтор команды управления",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture();
    t.after(() => f.close());
    const path = `/spaces/${f.space.id}/permissions/${f.member.id}`;
    const grant = {
      request_id: randomUUID(),
      expected_space_revision: f.server.repo.space(f.space.id)!.revision,
      actions: ["read", "write"],
    };
    const original = await f.request(f.owner, "PUT", path, grant);
    assert.equal(original.statusCode, 200);
    assert.deepEqual(
      (await f.request(f.owner, "PUT", path, grant)).json(),
      original.json(),
    );
    assert.equal(
      (
        await f.request(
          f.owner,
          "PUT",
          `/spaces/${f.space.id}/permissions/${f.agent.id}`,
          grant,
        )
      ).statusCode,
      409,
    );
    const exported = {
      version: 0,
      space: { name: "Проверка" },
      objects: [
        {
          type: "note",
          schema_version: 0,
          properties: { title: "Заметка", text: "" },
        },
      ],
    };
    assert.equal(
      (
        await f.request(f.member, "POST", "/imports", {
          ...exported,
          request_id: randomUUID(),
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await f.request(f.owner, "POST", "/imports", {
          ...exported,
          request_id: randomUUID(),
          objects: Array(1001).fill(exported.objects[0]),
        })
      ).statusCode,
      400,
    );
    const longNote = {
      ...exported.objects[0],
      properties: { title: "Предел", text: "x".repeat(65536) },
    };
    assert.equal(
      (
        await f.request(f.owner, "POST", "/imports", {
          ...exported,
          request_id: randomUUID(),
          objects: Array(161).fill(longNote),
        })
      ).statusCode,
      413,
    );
    assert.equal(f.server.repo.spaces().length, 1);
    const statuses = [];
    for (let i = 0; i < 16; i++) {
      statuses.push(
        (await f.login({ ...f.owner, secret: randomUUID() })).statusCode,
      );
    }
    assert.ok(statuses.includes(401));
    assert.equal(statuses.at(-1), 429);
  },
);
