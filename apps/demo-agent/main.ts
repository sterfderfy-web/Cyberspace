import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import type {
  Command,
  CommandResult,
  ErrorBody,
  Space,
} from "../../packages/contracts/index.js";
const base = (process.env.CYBERSPACE_URL ?? "http://127.0.0.1:3210").replace(
  /\/$/,
  "",
);
let actorId = process.env.CYBERSPACE_AGENT_ID,
  secret = process.env.CYBERSPACE_AGENT_SECRET,
  spaceId = process.env.CYBERSPACE_SPACE_ID;
if (!actorId || !secret) {
  const credentials = JSON.parse(
    readFileSync(
      process.env.CYBERSPACE_AGENT_CREDENTIALS ?? ".local/agent.json",
      "utf8",
    ),
  );
  actorId = credentials.agent.id;
  secret = credentials.agent.secret;
  spaceId ??= credentials.space_id;
}
let token = "";
async function call<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const response = await fetch(base + "/api/v0" + path, {
    method,
    headers: {
      Origin: new URL(base).origin,
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = (await response.json()) as T & ErrorBody;
  if (!response.ok)
    throw new Error(`${response.status} ${result.code}: ${result.message}`);
  return result;
}
const login = await call<{ token: string }>("/sessions", "POST", {
  actor_id: actorId,
  secret,
  mode: "agent",
});
token = login.token;
secret = undefined;
if (!spaceId) spaceId = (await call<Space[]>("/spaces"))[0]?.id;
if (!spaceId) throw new Error("Нет доступного пространства");
console.log(
  "Демо-агент без LLM. Отдельный процесс; доступ только через сетевой API.",
);
let pending: Command | undefined;
async function run() {
  const command =
    pending ??
    ({
      request_id: randomUUID(),
      module: "notes",
      action: "create_note",
      input: {
        title: "Результат демо-агента",
        text: "Детерминированное действие без LLM. Команда выполнена по явному заданию через API.",
      },
    } satisfies Command);
  pending = command;
  try {
    const result = await call<CommandResult>(
      `/spaces/${spaceId}/actions`,
      "POST",
      command,
    );
    console.log(
      `OK · объект ${result.object.id} · ревизия ${result.space_revision} · request_id ${command.request_id}`,
    );
    pending = undefined;
  } catch (e) {
    const message = (e as Error).message;
    console.error(message);
    if (/^\d{3} /.test(message)) pending = undefined;
    else
      console.error(
        "Результат неизвестен. Следующее задание повторит тот же request_id.",
      );
    if (process.argv.includes("--once")) process.exitCode = 1;
  }
}
try {
  if (process.argv.includes("--once")) await run();
  else {
    const terminal = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    console.log(
      "Enter — создать заметку; q — завершить. После отзыва execute нажмите Enter ещё раз: ожидается 403 в той же сессии.",
    );
    try {
      while (true) {
        const answer = await terminal.question("Задание > ");
        if (answer.trim().toLowerCase() === "q") break;
        await run();
      }
    } finally {
      terminal.close();
    }
  }
} finally {
  await call("/session", "DELETE").catch(() => {});
}
