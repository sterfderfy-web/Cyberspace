import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { SqliteRepository } from "../../packages/storage-sqlite/index.js";
import { permissions } from "../../packages/contracts/index.js";
const path = resolve(process.env.CYBERSPACE_DB ?? ".local/cyberspace.sqlite");
const credentials = resolve(
  process.env.CYBERSPACE_CREDENTIALS ?? ".local/credentials.json",
);
const agentCredentials = resolve(
  process.env.CYBERSPACE_AGENT_CREDENTIALS ??
    resolve(dirname(credentials), "agent.json"),
);
const repo = new SqliteRepository(path);
try {
  if (
    repo.actors().length ||
    existsSync(credentials) ||
    existsSync(agentCredentials)
  )
    throw new Error(
      "Настройка уже выполнена. Существующие данные и секреты сохранены. Для чистого экземпляра задайте новые пути CYBERSPACE_DB и CYBERSPACE_CREDENTIALS.",
    );
  repo.transaction(() => {
    const owner = repo.createActor("human", "Владелец", true),
      member = repo.createActor("human", "Участник"),
      agent = repo.createActor("agent", "Демо-агент · без LLM");
    const space = {
      id: randomUUID(),
      name: "Мастерская",
      revision: 1,
      created_at: new Date().toISOString(),
    };
    repo.saveSpace(space);
    repo.grant(space.id, owner.id, [...permissions]);
    repo.grant(space.id, member.id, ["read"]);
    repo.grant(space.id, agent.id, ["read", "write", "execute"]);
    repo.event(space);
    mkdirSync(dirname(credentials), { recursive: true });
    writeFileSync(
      credentials,
      JSON.stringify({ space_id: space.id, owner, member, agent }, null, 2),
      { flag: "wx", mode: 0o600 },
    );
    mkdirSync(dirname(agentCredentials), { recursive: true });
    writeFileSync(
      agentCredentials,
      JSON.stringify(
        { space_id: space.id, agent: { id: agent.id, secret: agent.secret } },
        null,
        2,
      ),
      { flag: "wx", mode: 0o600 },
    );
  });
  console.log("Создана «Мастерская». Локальные учётные данные: " + credentials);
} finally {
  repo.close();
}
