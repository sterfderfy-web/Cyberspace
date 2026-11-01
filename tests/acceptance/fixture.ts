import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { resolve, join, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer, type ServerOptions } from "../../apps/server/app.js";
import {
  permissions,
  type Command,
  type Permission,
} from "../../packages/contracts/index.js";
export async function fixture(extra: Partial<ServerOptions> = {}) {
  const root = resolve(".local/tests");
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, "run-"));
  const origins: string[] = [];
  const config: ServerOptions = {
    db: join(dir, "test.sqlite"),
    origins,
    ...extra,
  };
  let server = await createServer(config);
  const owner = server.repo.createActor("human", "Владелец", true),
    member = server.repo.createActor("human", "Участник"),
    agent = server.repo.createActor("agent", "Демо-агент · без LLM");
  const space = {
    id: randomUUID(),
    name: "Мастерская",
    revision: 1,
    created_at: new Date().toISOString(),
  };
  server.repo.saveSpace(space);
  server.repo.grant(space.id, owner.id, [...permissions]);
  server.repo.grant(space.id, member.id, ["read"]);
  server.repo.grant(space.id, agent.id, ["read", "write", "execute"]);
  server.repo.event(space);
  await server.app.listen({ host: "0.0.0.0", port: 0 });
  const address = server.app.server.address();
  if (!address || typeof address === "string") throw new Error("No listener");
  const port = address.port,
    url = `http://127.0.0.1:${port}`;
  origins.push(url);
  const tokens: Record<string, string> = {};
  async function login(
    actor: typeof owner,
    mode: "agent" | "browser" = "agent",
  ) {
    return server.app.inject({
      method: "POST",
      url: "/api/v0/sessions",
      headers: { Origin: url },
      payload: { actor_id: actor.id, secret: actor.secret, mode },
    });
  }
  for (const actor of [owner, member, agent]) {
    const response = await login(actor);
    if (response.statusCode !== 200) throw new Error(response.body);
    tokens[actor.id] = response.json().token;
  }
  async function request(
    actor: typeof owner | null,
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
  ) {
    return server.app.inject({
      method,
      url: "/api/v0" + path,
      headers: {
        Origin: url,
        ...(actor ? { Authorization: `Bearer ${tokens[actor.id]}` } : {}),
      },
      ...(body ? { payload: body as Record<string, unknown> } : {}),
    });
  }
  async function grant(actor: typeof owner, actions: Permission[]) {
    const revision = server.repo.space(space.id)!.revision;
    return request(
      owner,
      "PUT",
      `/spaces/${space.id}/permissions/${actor.id}`,
      { request_id: randomUUID(), expected_space_revision: revision, actions },
    );
  }
  function command(title = "Общая заметка", text = "Начальный текст"): Command {
    return {
      request_id: randomUUID(),
      module: "notes",
      action: "create_note",
      input: { title, text },
    };
  }
  return {
    get server() {
      return server;
    },
    dir,
    config,
    owner,
    member,
    agent,
    space,
    port,
    url,
    tokens,
    login,
    request,
    grant,
    command,
    async stop() {
      await server.app.close();
    },
    async restart() {
      server = await createServer(config);
      await server.app.listen({ host: "0.0.0.0", port });
    },
    async close() {
      await server.app.close();
      if (!resolve(dir).startsWith(root + sep))
        throw new Error("Unsafe cleanup");
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
