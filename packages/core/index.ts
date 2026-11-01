import { randomUUID, createHash } from "node:crypto";
import {
  permissions,
  isNote,
  type SpaceObject,
  type Actor,
  type Audit,
  type ExportData,
  type Grant,
  type Note,
  type Permission,
  type Session,
  type Snapshot,
  type Space,
} from "../contracts/index.js";
import {
  DomainError,
  ModuleRegistry,
  type ModuleCommand,
  type ModuleDefinition,
} from "../contracts/modules.js";
import type { SpatialView, SceneSnapshot } from "../contracts/spatial.js";
export { DomainError } from "../contracts/modules.js";
export interface Repository {
  transaction<T>(work: () => T): T;
  space(id: string): Space | undefined;
  spaces(): Space[];
  saveSpace(space: Space): void;
  objects(space: string): SpaceObject[];
  object(id: string): SpaceObject | undefined;
  saveObject(object: SpaceObject): void;
  views(space: string): SpatialView[];
  view(id: string): SpatialView | undefined;
  saveView(view: SpatialView): void;
  deleteView(id: string): void;
  sceneRevision(space: string): number;
  bumpScene(space: string): number;
  actors(): Actor[];
  actor(id: string): Actor | undefined;
  rights(space: string, actor: string): Permission[];
  grant(space: string, actor: string, rights: Permission[]): void;
  request(
    actor: string,
    scope: string,
    id: string,
  ): { hash: string; result: unknown } | undefined;
  saveRequest(
    actor: string,
    scope: string,
    id: string,
    hash: string,
    result: unknown,
  ): void;
  audit(entry: Audit): void;
  audits(space: string): Audit[];
  event(space: Space): void;
}
export interface Identity {
  actor: Actor;
  session: Session;
}
const fail = (status: number, code: string, message: string): never => {
  throw new DomainError(status, code, message);
};
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
export class Core {
  readonly modules: ModuleRegistry;
  constructor(
    public repo: Repository,
    modules: ModuleDefinition[] = [],
  ) {
    this.modules = new ModuleRegistry(modules);
  }
  access(
    identity: Identity,
    spaceId: string,
    required: Permission[] = ["read"],
  ): Space {
    const space = this.repo.space(spaceId),
      actions = this.repo.rights(spaceId, identity.actor.id);
    if (!space || !actions.includes("read"))
      return fail(404, "NOT_FOUND", "Пространство недоступно");
    if (!required.every((p) => actions.includes(p)))
      return fail(403, "FORBIDDEN", "Недостаточно прав");
    return space;
  }
  snapshot(identity: Identity, id: string): Snapshot {
    const space = this.access(identity, id);
    return {
      space,
      objects: this.repo.objects(id).filter(isNote),
      cursor: space.revision,
      permissions: this.repo.rights(id, identity.actor.id),
    };
  }
  scene(identity: Identity, id: string): SceneSnapshot {
    const space = this.access(identity, id);
    return {
      version: 0,
      space,
      scene_revision: this.repo.sceneRevision(id),
      cursor: space.revision,
      views: this.repo.views(id),
      objects: this.repo.objects(id),
      permissions: this.repo.rights(id, identity.actor.id),
    };
  }
  private record(
    identity: Identity,
    space: string | null,
    request: string | null,
    action: string,
    target: string,
    result: string,
  ) {
    this.repo.audit({
      space_id: space,
      actor_id: identity.actor.id,
      session_id: identity.session.id,
      request_id: request,
      time: new Date().toISOString(),
      action,
      target,
      result,
    });
  }
  private mutate<T>(
    identity: Identity,
    scope: string,
    id: string,
    payload: unknown,
    action: string,
    target: string,
    authorize: () => void,
    work: () => T,
  ): T {
    try {
      return this.repo.transaction(() => {
        authorize();
        const hash = createHash("sha256")
          .update(canonical({ action, target, payload }))
          .digest("hex");
        const prior = this.repo.request(identity.actor.id, scope, id);
        if (prior) {
          if (prior.hash !== hash)
            return fail(
              409,
              "REQUEST_REUSED",
              "request_id уже использован с другим содержимым",
            );
          return prior.result as T;
        }
        const result = work();
        this.record(
          identity,
          scope === "instance" ? null : scope,
          id,
          action,
          target,
          "OK",
        );
        this.repo.saveRequest(identity.actor.id, scope, id, hash, result);
        return result;
      });
    } catch (error) {
      if (error instanceof DomainError)
        this.record(
          identity,
          scope === "instance" ? null : scope,
          id,
          action,
          target,
          error.code,
        );
      throw error;
    }
  }
  command(
    identity: Identity,
    spaceId: string,
    command: ModuleCommand,
  ): Record<string, unknown> {
    const action = this.modules.action(command.module, command.action);
    if (!action)
      throw new DomainError(
        400,
        "UNKNOWN_ACTION",
        "Неизвестное действие модуля",
      );
    return this.mutate(
      identity,
      spaceId,
      command.request_id,
      command,
      command.module + "." + command.action,
      command.view_id ?? command.object_id ?? spaceId,
      () => {
        this.access(identity, spaceId, [
          "read",
          ...action.required_permissions,
        ]);
      },
      () => {
        const result = action.execute(command, {
          spaceId,
          now: new Date().toISOString(),
          newId: randomUUID,
          object: (id) => {
            const o = this.repo.object(id);
            return o?.space_id === spaceId ? o : undefined;
          },
          saveObject: (o) => {
            const prior = this.repo.object(o.id);
            if (o.space_id !== spaceId || (prior && prior.space_id !== spaceId))
              fail(403, "FORBIDDEN", "Объект принадлежит другому пространству");
            this.repo.saveObject(o);
          },
          views: () => this.repo.views(spaceId),
          saveView: (v) => {
            const prior = this.repo.view(v.id);
            if (v.space_id !== spaceId || (prior && prior.space_id !== spaceId))
              fail(
                403,
                "FORBIDDEN",
                "Представление принадлежит другому пространству",
              );
            this.repo.saveView(v);
          },
          deleteView: (id) => {
            if (this.repo.view(id)?.space_id !== spaceId)
              fail(404, "NOT_FOUND", "Представление недоступно");
            this.repo.deleteView(id);
          },
          bumpScene: () => this.repo.bumpScene(spaceId),
        });
        const space = this.bump(spaceId);
        return {
          request_id: command.request_id,
          ...result,
          space_revision: space.revision,
        };
      },
    );
  }
  private bump(id: string) {
    const space = this.repo.space(id)!;
    space.revision++;
    this.repo.saveSpace(space);
    this.repo.event(space);
    return space;
  }
  setRights(
    identity: Identity,
    spaceId: string,
    actorId: string,
    grant: Grant,
  ) {
    return this.mutate(
      identity,
      spaceId,
      grant.request_id,
      grant,
      "permissions.replace",
      actorId,
      () => {
        this.access(identity, spaceId, ["read", "manage"]);
      },
      () => {
        if (!this.repo.actor(actorId))
          return fail(404, "NOT_FOUND", "Участник не найден");
        if (
          this.repo.space(spaceId)!.revision !== grant.expected_space_revision
        )
          return fail(
            409,
            "REVISION_CONFLICT",
            "Права или пространство изменились. Обновите снимок",
          );
        const activeManagers = this.repo
          .actors()
          .filter(
            (a) =>
              !a.disabled &&
              a.id !== actorId &&
              ["read", "manage"].every((p) =>
                this.repo.rights(spaceId, a.id).includes(p as Permission),
              ),
          );
        if (
          !["read", "manage"].every((p) =>
            grant.actions.includes(p as Permission),
          ) &&
          activeManagers.length === 0
        )
          return fail(
            409,
            "LAST_MANAGER",
            "Нельзя удалить последнего управляющего",
          );
        this.repo.grant(spaceId, actorId, grant.actions);
        return {
          request_id: grant.request_id,
          space_revision: this.bump(spaceId).revision,
          actions: grant.actions,
        };
      },
    );
  }
  export(identity: Identity, id: string): ExportData {
    const space = this.access(identity, id, ["read", "manage"]);
    this.record(identity, id, null, "space.export", id, "OK");
    return {
      version: 0,
      space: { name: space.name },
      objects: this.repo
        .objects(id)
        .filter(isNote)
        .map((n) => ({
          type: n.type,
          schema_version: n.schema_version,
          properties: n.properties,
        })),
    };
  }
  import(identity: Identity, data: ExportData & { request_id: string }) {
    return this.mutate(
      identity,
      "instance",
      data.request_id,
      data,
      "space.import",
      "instance",
      () => {
        if (!identity.actor.instance_owner)
          fail(403, "FORBIDDEN", "Импорт доступен владельцу экземпляра");
      },
      () => {
        if (
          data.objects.some(
            (n) => Buffer.byteLength(n.properties.text, "utf8") > 65536,
          )
        )
          return fail(413, "TOO_LARGE", "Текст превышает 64 КиБ UTF-8");
        const now = new Date().toISOString(),
          space = {
            id: randomUUID(),
            name: data.space.name,
            revision: 1,
            created_at: now,
          };
        this.repo.saveSpace(space);
        this.repo.grant(space.id, identity.actor.id, [...permissions]);
        for (const n of data.objects)
          this.repo.saveObject({
            ...n,
            id: randomUUID(),
            space_id: space.id,
            revision: 1,
            created_at: now,
            updated_at: now,
          });
        this.repo.event(space);
        return { request_id: data.request_id, space };
      },
    );
  }
}
