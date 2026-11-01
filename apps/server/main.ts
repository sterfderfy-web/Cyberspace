import { networkInterfaces } from "node:os";
import { createServer } from "./app.js";
const host = process.env.CYBERSPACE_HOST ?? "0.0.0.0";
const port = Number(process.env.CYBERSPACE_PORT ?? 3210);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("CYBERSPACE_PORT должен быть от 1 до 65535");
const localAddresses = Object.values(networkInterfaces())
  .flat()
  .filter((a) => a?.family === "IPv4")
  .map((a) => a!.address);
const origins = (
  process.env.CYBERSPACE_ORIGINS ??
  ["localhost", "127.0.0.1", ...localAddresses]
    .map((h) => `http://${h}:${port}`)
    .join(",")
)
  .split(",")
  .map((s) => s.trim());
const { app, repo } = await createServer({
  db: process.env.CYBERSPACE_DB ?? ".local/cyberspace.sqlite",
  origins,
  secureCookies: process.env.CYBERSPACE_SECURE_COOKIE === "1",
});
if (!repo.actors().length) {
  await app.close();
  throw new Error("Сначала выполните npm run setup");
}
await app.listen({ host, port });
console.log(
  "Cyberspace · локальная демонстрация HTTP, только тестовые секреты",
);
console.log(
  `Сервер: ${host}:${port}\nРазрешённые адреса:\n${origins.join("\n")}`,
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
