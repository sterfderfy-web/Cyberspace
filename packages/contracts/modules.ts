import type { Permission, SpaceObject } from "./index.js";
import type { SpatialView } from "./spatial.js";
export class DomainError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export interface ModuleCommand {
  request_id: string;
  module: string;
  action: string;
  object_id?: string;
  view_id?: string;
  expected_revision?: number;
  input?: unknown;
}
export interface ModuleContext {
  spaceId: string;
  now: string;
  newId: () => string;
  object: (id: string) => SpaceObject | undefined;
  saveObject: (object: SpaceObject) => void;
  views: () => SpatialView[];
  saveView: (view: SpatialView) => void;
  deleteView: (id: string) => void;
  bumpScene: () => number;
}
export interface ModuleDefinition {
  id: string;
  version: number;
  dependencies: string[];
  request_schema: Record<string, unknown>;
  actions: Record<
    string,
    {
      input_schema?: unknown;
      required_permissions: Permission[];
      execute: (
        command: ModuleCommand,
        context: ModuleContext,
      ) => Record<string, unknown>;
    }
  >;
}
export class ModuleRegistry {
  private modules = new Map<string, ModuleDefinition>();
  constructor(modules: ModuleDefinition[]) {
    for (const module of modules) {
      if (this.modules.has(module.id))
        throw new Error("Повтор модуля: " + module.id);
      this.modules.set(module.id, module);
    }
    for (const module of modules)
      for (const dependency of module.dependencies)
        if (!this.modules.has(dependency))
          throw new Error("Отсутствует зависимость модуля: " + dependency);
  }
  action(module: string, action: string) {
    return this.modules.get(module)?.actions[action];
  }
  schemas() {
    return { oneOf: [...this.modules.values()].map((m) => m.request_schema) };
  }
  declarations() {
    return [...this.modules.values()].map((m) => ({
      id: m.id,
      version: m.version,
      dependencies: m.dependencies,
      request_schema: m.request_schema,
      actions: Object.fromEntries(
        Object.entries(m.actions).map(([key, a]) => [
          key,
          {
            input_schema: a.input_schema,
            required_permissions: a.required_permissions,
          },
        ]),
      ),
    }));
  }
}
