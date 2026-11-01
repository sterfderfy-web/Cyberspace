import Fastify, { type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import staticFiles from "@fastify/static";
import rateLimit from "@fastify/rate-limit";
import type { WebSocket } from "ws";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Core, DomainError, type Identity } from "../../packages/core/index.js";
import { SqliteRepository } from "../../packages/storage-sqlite/index.js";
import {
  grantSchema,
  importSchema,
  loginSchema,
  type ExportData,
  type Grant,
} from "../../packages/contracts/index.js";
import { notesModule } from "../../packages/module-notes/index.js";
import {
  spatialModule,
  panelRenderers,
} from "../../packages/module-spatial/index.js";
import type {
  ModuleDefinition,
  ModuleCommand,
} from "../../packages/contracts/modules.js";
import type { RendererDescriptor } from "../../packages/contracts/spatial.js";
export interface ServerOptions {
  db: string;
  origins: string[];
  secureCookies?: boolean;
  staticRoot?: string;
  maxConnections?: number;
  heartbeatMs?: number;
  maxBufferedBytes?: number;
  extraModules?: ModuleDefinition[];
  extraRenderers?: RendererDescriptor[];
}
export async function createServer(options: ServerOptions) {
  const renderers = [...panelRenderers, ...(options.extraRenderers ?? [])];
  if (
    new Set(renderers.map((r) => r.id + ":" + r.version)).size !==
    renderers.length
  )
    throw new Error("Повтор визуализатора");
  const repo = new SqliteRepository(options.db),
    core = new Core(repo, [
      notesModule,
      spatialModule(renderers),
      ...(options.extraModules ?? []),
    ]);
  const app = Fastify({
    bodyLimit: 128 * 1024,
    logger: false,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
  });
  await app.register(cookie);
  await app.register(rateLimit, { max: 300, timeWindow: 60_000 });
  await app.register(websocket, { options: { maxPayload: 1024 } });
  const clients = new Map<
    WebSocket,
    { token: string; spaceId: string; alive: boolean }
  >();
  const validOrigin = (origin: string | undefined) =>
    !!origin && options.origins.includes(origin);
  function identity(token: string | undefined): Identity {
    if (!token)
      throw new DomainError(401, "UNAUTHENTICATED", "Войдите в систему");
    const session = repo.session(token),
      actor = session && repo.actor(session.actor_id);
    if (
      !session ||
      session.revoked_at ||
      session.expires_at <= Date.now() ||
      !actor ||
      actor.disabled
    )
      throw new DomainError(
        401,
        "SESSION_EXPIRED",
        "Сессия завершена. Войдите снова",
      );
    return { session, actor };
  }
  function token(req: FastifyRequest) {
    return req.headers.authorization?.startsWith("Bearer ")
      ? req.headers.authorization.slice(7)
      : req.cookies.cyberspace;
  }
  const auth = (req: FastifyRequest) => identity(token(req));
  function recheck(socket: WebSocket) {
    const client = clients.get(socket)!;
    try {
      const who = identity(client.token);
      return core.access(who, client.spaceId);
    } catch {
      socket.close(1008, "Доступ отозван");
      clients.delete(socket);
      return undefined;
    }
  }
  function publish(spaceId?: string) {
    for (const [socket, client] of clients) {
      if (spaceId && client.spaceId !== spaceId) continue;
      const space = recheck(socket);
      if (!space) continue;
      if (socket.bufferedAmount > (options.maxBufferedBytes ?? 65536)) {
        socket.close(1013, "Медленное соединение");
        clients.delete(socket);
        continue;
      }
      socket.send(
        JSON.stringify({
          version: 0,
          type: "space.changed",
          space_id: space.id,
          cursor: space.revision,
        }),
      );
    }
  }
  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/api/")) return;
    reply.header("Cache-Control", "no-store");
    if (req.headers.origin && !validOrigin(req.headers.origin))
      throw new DomainError(403, "ORIGIN_DENIED", "Недопустимый Origin");
    const mutation = !["GET", "HEAD", "OPTIONS"].includes(req.method);
    if (
      mutation &&
      !req.headers.authorization?.startsWith("Bearer ") &&
      !validOrigin(req.headers.origin)
    )
      throw new DomainError(
        403,
        "ORIGIN_REQUIRED",
        "Для браузерного запроса нужен разрешённый Origin",
      );
  });
  app.addHook("onSend", async (_req, reply) => {
    reply
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "no-referrer")
      .header(
        "Content-Security-Policy",
        "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'",
      );
  });
  app.setErrorHandler((error, req, reply) => {
    const e = error as Error & { statusCode?: number; validation?: unknown };
    const status =
      error instanceof DomainError ? error.status : (e.statusCode ?? 500);
    const code =
      error instanceof DomainError
        ? error.code
        : e.validation
          ? "INVALID_PAYLOAD"
          : status === 413
            ? "TOO_LARGE"
            : status === 429
              ? "RATE_LIMITED"
              : "REQUEST_ERROR";
    const candidate = (req.body as { request_id?: unknown } | undefined)
      ?.request_id;
    const request_id =
      typeof candidate === "string" && /^[0-9a-f-]{36}$/i.test(candidate)
        ? candidate
        : undefined;
    reply.code(status).send({
      request_id,
      code,
      message:
        error instanceof DomainError
          ? error.message
          : status === 500
            ? "Внутренняя ошибка сервера"
            : status === 429
              ? "Слишком много запросов. Подождите минуту"
              : status === 413
                ? "Превышен размер запроса"
                : "Некорректный запрос",
    });
  });
  app.post<{
    Body: { actor_id: string; secret: string; mode: "browser" | "agent" };
  }>(
    "/api/v0/sessions",
    {
      schema: { body: loginSchema },
      config: { rateLimit: { max: 15, timeWindow: 60_000 } },
    },
    async (req, reply) => {
      if (!validOrigin(req.headers.origin))
        throw new DomainError(
          403,
          "ORIGIN_REQUIRED",
          "Укажите разрешённый Origin",
        );
      if (!repo.verifySecret(req.body.actor_id, req.body.secret))
        throw new DomainError(401, "LOGIN_FAILED", "Неверные учётные данные");
      const { token: sessionToken, session } = repo.newSession(
          req.body.actor_id,
        ),
        actor = repo.actor(req.body.actor_id)!;
      repo.audit({
        space_id: null,
        actor_id: actor.id,
        session_id: session.id,
        request_id: null,
        time: new Date().toISOString(),
        action: "session.create",
        target: session.id,
        result: "OK",
      });
      if (req.body.mode === "browser")
        reply.setCookie("cyberspace", sessionToken, {
          httpOnly: true,
          sameSite: "strict",
          secure: options.secureCookies ?? false,
          path: "/",
          maxAge: 8 * 3600,
        });
      return {
        actor,
        session,
        ...(req.body.mode === "agent" ? { token: sessionToken } : {}),
      };
    },
  );
  app.get("/api/v0/session", async (req) => auth(req));
  app.delete("/api/v0/session", async (req, reply) => {
    const who = auth(req);
    repo.revoke(who.session.id);
    publish();
    reply.clearCookie("cyberspace", { path: "/" });
    return { ok: true };
  });
  app.get("/api/v0/spaces", async (req) => {
    const who = auth(req);
    return repo
      .spaces()
      .filter((s) => repo.rights(s.id, who.actor.id).includes("read"));
  });
  app.get<{ Params: { id: string } }>("/api/v0/spaces/:id", async (req) =>
    core.snapshot(auth(req), req.params.id),
  );
  app.get<{ Params: { id: string } }>(
    "/api/v0/spaces/:id/modules",
    async (req) => {
      core.access(auth(req), req.params.id);
      return core.modules.declarations();
    },
  );
  app.get<{ Params: { id: string } }>("/api/v0/spaces/:id/scene", async (req) =>
    core.scene(auth(req), req.params.id),
  );
  app.get<{ Params: { id: string } }>(
    "/api/v0/spaces/:id/renderers",
    async (req) => {
      core.access(auth(req), req.params.id);
      return renderers;
    },
  );
  app.post<{ Params: { id: string }; Body: ModuleCommand }>(
    "/api/v0/spaces/:id/actions",
    { schema: { body: core.modules.schemas() } },
    async (req) => {
      const result = core.command(auth(req), req.params.id, req.body);
      publish(req.params.id);
      return result;
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/v0/spaces/:id/permissions",
    async (req) => {
      core.access(auth(req), req.params.id, ["read", "manage"]);
      return repo.actors().map((actor) => ({
        actor,
        actions: repo.rights(req.params.id, actor.id),
      }));
    },
  );
  app.put<{ Params: { id: string; actor_id: string }; Body: Grant }>(
    "/api/v0/spaces/:id/permissions/:actor_id",
    { schema: { body: grantSchema } },
    async (req) => {
      const result = core.setRights(
        auth(req),
        req.params.id,
        req.params.actor_id,
        req.body,
      );
      publish(req.params.id);
      return result;
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/v0/spaces/:id/audit",
    async (req) => {
      core.access(auth(req), req.params.id, ["read", "manage"]);
      return repo.audits(req.params.id);
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/v0/spaces/:id/export",
    async (req) => core.export(auth(req), req.params.id),
  );
  app.post<{ Body: ExportData & { request_id: string } }>(
    "/api/v0/imports",
    { bodyLimit: 10 * 1024 * 1024, schema: { body: importSchema } },
    async (req) => core.import(auth(req), req.body),
  );
  app.get<{ Params: { id: string } }>(
    "/api/v0/spaces/:id/events",
    {
      websocket: true,
      preValidation: async (req) => {
        if (!validOrigin(req.headers.origin) || req.url.includes("?"))
          throw new DomainError(
            403,
            "ORIGIN_DENIED",
            "Подписка требует Origin; параметры URL запрещены",
          );
        const who = auth(req);
        core.access(who, req.params.id);
        const count = [...clients.values()].filter(
          (c) => c.token === token(req),
        ).length;
        if (clients.size >= (options.maxConnections ?? 100) || count >= 8)
          throw new DomainError(
            429,
            "CONNECTION_LIMIT",
            "Превышен лимит соединений",
          );
      },
    },
    (socket, req) => {
      clients.set(socket, {
        token: token(req)!,
        spaceId: req.params.id,
        alive: true,
      });
      socket.on("pong", () => {
        const c = clients.get(socket);
        if (c) c.alive = true;
      });
      socket.on("close", () => clients.delete(socket));
      socket.on("error", () => clients.delete(socket));
      socket.on("message", () =>
        socket.close(1008, "Подписка доступна только для чтения"),
      );
      const space = recheck(socket);
      if (space)
        socket.send(
          JSON.stringify({
            version: 0,
            type: "space.changed",
            space_id: space.id,
            cursor: space.revision,
          }),
        );
    },
  );
  const heartbeat = setInterval(() => {
    for (const [socket, c] of clients) {
      if (!recheck(socket)) continue;
      if (!c.alive) {
        socket.terminate();
        clients.delete(socket);
        continue;
      }
      c.alive = false;
      socket.ping();
    }
  }, options.heartbeatMs ?? 15_000);
  heartbeat.unref();
  app.addHook("preClose", async () => {
    clearInterval(heartbeat);
    for (const socket of clients.keys()) socket.terminate();
    clients.clear();
  });
  app.addHook("onClose", async () => repo.close());
  const root = options.staticRoot ?? resolve("dist/web");
  if (existsSync(root)) await app.register(staticFiles, { root });
  return { app, repo, core, publish, clients };
}
