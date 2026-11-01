import type { Space, SpaceObject, Permission } from "./index.js";
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}
export interface Quaternion extends Vec3 {
  w: number;
}
export interface Transform {
  position: Vec3;
  rotation: Quaternion;
  scale: Vec3;
}
export interface SpatialView {
  id: string;
  space_id: string;
  object_id: string;
  parent_view_id: string | null;
  renderer_id: string;
  renderer_version: number;
  config: Record<string, unknown>;
  transform: Transform;
  visible: boolean;
  opacity: number;
  layer: number;
  order: number;
  revision: number;
  created_at: string;
  updated_at: string;
}
export interface SceneSnapshot {
  version: 0;
  space: Space;
  scene_revision: number;
  cursor: number;
  views: SpatialView[];
  objects: SpaceObject[];
  permissions: Permission[];
}
export type Capability =
  | "2d"
  | "3d"
  | "stereo"
  | "3dof"
  | "6dof"
  | "hand-tracking"
  | "passthrough"
  | "spatial-anchors";
export interface RendererDescriptor {
  id: string;
  version: number;
  name: string;
  object_types: string[];
  required_capabilities: Capability[];
  config_schema: Record<string, unknown>;
}
// Личные ссылки и камера не являются общими View, ACL или содержимым Object.
export interface PersonalComposition {
  version: 0;
  space_ids: string[];
  excluded_view_ids: string[];
  source_offsets?: Record<string, Vec3>;
}
export interface ObserverState {
  position: Vec3;
  target: Vec3;
  selected_view_id: string | null;
}
export interface SpatialCommand {
  request_id: string;
  module: "spatial";
  action: "create_view" | "update_view" | "delete_view";
  view_id?: string;
  expected_revision?: number;
  input?: ViewInput;
}
export type ViewInput = Pick<
  SpatialView,
  | "object_id"
  | "parent_view_id"
  | "renderer_id"
  | "renderer_version"
  | "config"
  | "transform"
  | "visible"
  | "opacity"
  | "layer"
  | "order"
>;
export interface SpatialResult {
  request_id: string;
  space_revision: number;
  scene_revision: number;
  view?: SpatialView;
  deleted_view_id?: string;
}
export const identityTransform = (): Transform => ({
  position: { x: 0, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0, w: 1 },
  scale: { x: 1, y: 1, z: 1 },
});
const vec = (range: Record<string, unknown>) => ({
  type: "object",
  additionalProperties: false,
  required: ["x", "y", "z"],
  properties: Object.fromEntries(
    ["x", "y", "z"].map((k) => [k, { type: "number", ...range }]),
  ),
});
export const transformSchema = {
  type: "object",
  additionalProperties: false,
  required: ["position", "rotation", "scale"],
  properties: {
    position: vec({ minimum: -1e6, maximum: 1e6 }),
    scale: vec({ minimum: 0.001, maximum: 1000 }),
    rotation: {
      type: "object",
      additionalProperties: false,
      required: ["x", "y", "z", "w"],
      properties: Object.fromEntries(
        ["x", "y", "z", "w"].map((k) => [
          k,
          { type: "number", minimum: -1, maximum: 1 },
        ]),
      ),
    },
  },
};
export function spatialActionSchema(renderers: RendererDescriptor[]) {
  const input = {
    type: "object",
    additionalProperties: false,
    required: [
      "object_id",
      "parent_view_id",
      "renderer_id",
      "renderer_version",
      "config",
      "transform",
      "visible",
      "opacity",
      "layer",
      "order",
    ],
    properties: {
      object_id: { type: "string", format: "uuid" },
      parent_view_id: {
        anyOf: [{ type: "string", format: "uuid" }, { type: "null" }],
      },
      renderer_id: { type: "string" },
      renderer_version: { type: "integer", minimum: 0 },
      config: { type: "object" },
      transform: transformSchema,
      visible: { type: "boolean" },
      opacity: { type: "number", minimum: 0, maximum: 1 },
      layer: { type: "integer", minimum: -1000, maximum: 1000 },
      order: { type: "integer", minimum: -10000, maximum: 10000 },
    },
    allOf: [
      {
        oneOf: renderers.map((r) => ({
          properties: {
            renderer_id: { const: r.id },
            renderer_version: { const: r.version },
            config: r.config_schema,
          },
        })),
      },
    ],
  };
  return {
    oneOf: ["create_view", "update_view", "delete_view"].map((action) => ({
      type: "object",
      additionalProperties: false,
      required: [
        "request_id",
        "module",
        "action",
        ...(action === "create_view" ? [] : ["view_id", "expected_revision"]),
        ...(action === "delete_view" ? [] : ["input"]),
      ],
      properties: {
        request_id: { type: "string", format: "uuid" },
        module: { const: "spatial" },
        action: { const: action },
        ...(action === "create_view"
          ? {}
          : {
              view_id: { type: "string", format: "uuid" },
              expected_revision: { type: "integer", minimum: 1 },
            }),
        ...(action === "delete_view" ? {} : { input }),
      },
    })),
  };
}
