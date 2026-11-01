import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { resolve, join, sep } from "node:path";
import { createServer } from "../../apps/server/app.js";
import { fixture } from "./fixture.js";
function output(child: ChildProcessWithoutNullStreams) {
  let value = "";
  const callbacks = new Set<() => void>();
  child.stdout.on("data", (chunk) => {
    value += chunk;
    for (const cb of callbacks) cb();
  });
  child.stderr.on("data", (chunk) => {
    value += chunk;
    for (const cb of callbacks) cb();
  });
  return {
    wait(fragment: string) {
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          callbacks.delete(check);
          reject(new Error(`Ожидание ${fragment}: ${value}`));
        }, 15000);
        const check = () => {
          if (value.includes(fragment)) {
            clearTimeout(timer);
            callbacks.delete(check);
            resolve();
          }
        };
        callbacks.add(check);
        check();
      });
    },
  };
}
test(
  "A06: отдельный процесс агента, явные задания и отзыв execute в той же сессии",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture();
    t.after(() => f.close());
    const child = spawn(process.execPath, ["dist/apps/demo-agent/main.js"], {
      env: {
        ...process.env,
        CYBERSPACE_URL: f.url,
        CYBERSPACE_AGENT_ID: f.agent.id,
        CYBERSPACE_AGENT_SECRET: f.agent.secret,
        CYBERSPACE_SPACE_ID: f.space.id,
      },
      windowsHide: true,
    });
    t.after(() => {
      if (child.exitCode === null) child.kill();
    });
    const log = output(child);
    await log.wait("Задание >");
    child.stdin.write("\n");
    await log.wait("OK · объект");
    assert.equal(f.server.repo.objects(f.space.id).length, 1);
    await f.grant(f.agent, ["read", "write"]);
    child.stdin.write("\n");
    await log.wait("403 FORBIDDEN");
    assert.equal(f.server.repo.objects(f.space.id).length, 1);
    const rows = f.server.repo
      .audits(f.space.id)
      .filter((a) => a.actor_id === f.agent.id);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].session_id, rows[1].session_id);
    const exited = once(child, "exit");
    child.stdin.write("q\n");
    assert.equal((await exited)[0], 0);
  },
);

test(
  "Локальная настройка воспроизводима, повтор сохраняет данные; агент читает отдельный файл",
  { timeout: 30000 },
  async () => {
    const root = resolve(".local/tests");
    mkdirSync(root, { recursive: true });
    const dir = mkdtempSync(join(root, "setup-"));
    const db = join(dir, "instance.sqlite"),
      credentialsPath = join(dir, "credentials.json"),
      agentPath = join(dir, "agent.json");
    const env = {
      ...process.env,
      CYBERSPACE_DB: db,
      CYBERSPACE_CREDENTIALS: credentialsPath,
      CYBERSPACE_AGENT_CREDENTIALS: agentPath,
    };
    const runSetup = async () => {
      const child = spawn(process.execPath, ["dist/apps/server/setup.js"], {
        env,
        windowsHide: true,
      });
      child.stdout.resume();
      child.stderr.resume();
      return (await once(child, "exit"))[0];
    };
    let server: Awaited<ReturnType<typeof createServer>> | undefined;
    try {
      assert.equal(await runSetup(), 0);
      const credentials = readFileSync(credentialsPath, "utf8"),
        agentFile = readFileSync(agentPath, "utf8"),
        all = JSON.parse(credentials),
        agent = JSON.parse(agentFile);
      assert.deepEqual(Object.keys(agent).sort(), ["agent", "space_id"]);
      assert.equal(agent.agent.id, all.agent.id);
      assert.ok(!agentFile.includes(all.owner.secret));
      assert.ok(!agentFile.includes(all.member.secret));
      assert.equal(await runSetup(), 1);
      assert.equal(readFileSync(credentialsPath, "utf8"), credentials);
      assert.equal(readFileSync(agentPath, "utf8"), agentFile);
      const origins: string[] = [];
      server = await createServer({ db, origins });
      await server.app.listen({ host: "127.0.0.1", port: 0 });
      const address = server.app.server.address();
      if (!address || typeof address === "string")
        throw new Error("No listener");
      const url = `http://127.0.0.1:${address.port}`;
      origins.push(url);
      const child = spawn(
        process.execPath,
        ["dist/apps/demo-agent/main.js", "--once"],
        {
          env: {
            ...env,
            CYBERSPACE_URL: url,
            CYBERSPACE_AGENT_ID: "",
            CYBERSPACE_AGENT_SECRET: "",
            CYBERSPACE_SPACE_ID: "",
          },
          windowsHide: true,
        },
      );
      child.stdout.resume();
      child.stderr.resume();
      assert.equal((await once(child, "exit"))[0], 0);
      assert.equal(server.repo.objects(all.space_id).length, 1);
    } finally {
      if (server) await server.app.close();
      if (!resolve(dir).startsWith(root + sep))
        throw new Error("Unsafe cleanup");
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
test(
  "A10/A12: перезапуск настоящего процесса Node, сетевой снимок и сохранение",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture();
    const command = f.command("Долговременная заметка");
    await f.request(f.owner, "POST", `/spaces/${f.space.id}/actions`, command);
    const before = (
      await f.request(f.owner, "GET", `/spaces/${f.space.id}`)
    ).json();
    await f.stop();
    let child: ChildProcessWithoutNullStreams | undefined;
    t.after(async () => {
      if (child && child.exitCode === null) {
        const exited = once(child, "exit");
        child.kill();
        await exited;
      }
      await f.restart();
      await f.close();
    });
    const launch = async () => {
      child = spawn(process.execPath, ["dist/apps/server/main.js"], {
        env: {
          ...process.env,
          CYBERSPACE_HOST: "127.0.0.1",
          CYBERSPACE_PORT: String(f.port),
          CYBERSPACE_DB: f.config.db,
          CYBERSPACE_ORIGINS: f.url,
        },
        windowsHide: true,
      });
      await output(child).wait("Разрешённые адреса:");
    };
    await launch();
    const headers = { Authorization: `Bearer ${f.tokens[f.owner.id]}` };
    assert.deepEqual(
      await (
        await fetch(`${f.url}/api/v0/spaces/${f.space.id}`, { headers })
      ).json(),
      before,
    );
    const exited = once(child!, "exit");
    child!.kill();
    await exited;
    await launch();
    assert.deepEqual(
      await (
        await fetch(`${f.url}/api/v0/spaces/${f.space.id}`, { headers })
      ).json(),
      before,
    );
  },
);
