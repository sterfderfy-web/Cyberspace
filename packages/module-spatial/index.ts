import {
  spatialActionSchema,
  type RendererDescriptor,
  type SpatialCommand,
  type SpatialView,
} from "../contracts/spatial.js";
import {
  DomainError,
  type ModuleDefinition,
  type ModuleContext,
  type ModuleCommand,
} from "../contracts/modules.js";
import {
  validateTransform,
  validateHierarchy,
} from "../spatial-runtime/index.js";
export const panelConfigSchema = {
  type: "object",
  additionalProperties: false,
  required: ["width_m", "height_m"],
  properties: {
    width_m: { type: "number", minimum: 0.001, maximum: 10000 },
    height_m: { type: "number", minimum: 0.001, maximum: 10000 },
  },
};
export const panelRenderers: RendererDescriptor[] = [
  {
    id: "notes.panel",
    version: 0,
    name: "Документ",
    object_types: ["note"],
    required_capabilities: ["3d"],
    config_schema: panelConfigSchema,
  },
  {
    id: "notes.summary",
    version: 0,
    name: "Карточка-сводка",
    object_types: ["note"],
    required_capabilities: ["3d"],
    config_schema: panelConfigSchema,
  },
];
export function spatialModule(
  renderers: RendererDescriptor[],
): ModuleDefinition {
  const execute = (raw: ModuleCommand, ctx: ModuleContext) => {
    const command = raw as SpatialCommand,
      views = ctx.views(),
      previous = views.find((v) => v.id === command.view_id);
    if (command.action !== "create_view") {
      if (!previous)
        throw new DomainError(
          404,
          "VIEW_NOT_FOUND",
          "Представление недоступно",
        );
      if (previous.revision !== command.expected_revision)
        throw new DomainError(
          409,
          "REVISION_CONFLICT",
          "Размещение изменилось. Перечитайте сцену",
        );
    }
    if (command.action === "delete_view") {
      if (views.some((v) => v.parent_view_id === previous!.id))
        throw new DomainError(
          409,
          "VIEW_HAS_CHILDREN",
          "Сначала переназначьте дочерние представления",
        );
      ctx.deleteView(previous!.id);
      return { deleted_view_id: previous!.id, scene_revision: ctx.bumpScene() };
    }
    const input = command.input!,
      object = ctx.object(input.object_id);
    if (!object)
      throw new DomainError(
        404,
        "OBJECT_NOT_FOUND",
        "Исходный объект недоступен",
      );
    if (previous && previous.object_id !== input.object_id)
      throw new DomainError(
        400,
        "IMMUTABLE_SOURCE",
        "Для другого источника создайте новое представление",
      );
    const renderer = renderers.find(
      (r) => r.id === input.renderer_id && r.version === input.renderer_version,
    );
    if (!renderer || !renderer.object_types.includes(object.type))
      throw new DomainError(
        400,
        "RENDERER_UNSUPPORTED",
        "Визуализатор не поддерживает этот объект",
      );
    const view: SpatialView = {
      ...input,
      transform: validateTransform(input.transform),
      id: previous?.id ?? ctx.newId(),
      space_id: ctx.spaceId,
      revision: (previous?.revision ?? 0) + 1,
      created_at: previous?.created_at ?? ctx.now,
      updated_at: ctx.now,
    };
    validateHierarchy([...views.filter((v) => v.id !== view.id), view]);
    ctx.saveView(view);
    return { view, scene_revision: ctx.bumpScene() };
  };
  return {
    id: "spatial",
    version: 0,
    dependencies: [],
    request_schema: spatialActionSchema(renderers),
    actions: Object.fromEntries(
      ["create_view", "update_view", "delete_view"].map((a) => [
        a,
        { required_permissions: ["read", "write", "execute"], execute },
      ]),
    ),
  };
}
