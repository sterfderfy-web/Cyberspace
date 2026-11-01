export const permissions = ["read", "write", "execute", "manage"] as const;
export type Permission = (typeof permissions)[number];
export interface Actor {
  id: string;
  kind: "human" | "agent";
  display_name: string;
  disabled: boolean;
  instance_owner: boolean;
}
export interface Session {
  id: string;
  actor_id: string;
  expires_at: number;
  revoked_at: number | null;
}
export interface Space {
  id: string;
  name: string;
  revision: number;
  created_at: string;
}
export interface SpaceObject<T extends object = Record<string, unknown>> {
  id: string;
  space_id: string;
  type: string;
  schema_version: number;
  properties: T;
  revision: number;
  created_at: string;
  updated_at: string;
}
export interface Note extends SpaceObject<{ title: string; text: string }> {
  type: "note";
  schema_version: 0;
}
export function isNote(object: SpaceObject): object is Note {
  return object.type === "note" && object.schema_version === 0;
}
export interface Snapshot {
  space: Space;
  objects: Note[];
  cursor: number;
  permissions: Permission[];
}
export interface Command {
  request_id: string;
  module: "notes";
  action: "create_note" | "update_note";
  object_id?: string;
  expected_revision?: number;
  input: Note["properties"];
}
export interface CommandResult {
  request_id: string;
  object: Note;
  space_revision: number;
}
export interface Grant {
  request_id: string;
  expected_space_revision: number;
  actions: Permission[];
}
export interface ExportData {
  version: 0;
  space: { name: string };
  objects: {
    type: "note";
    schema_version: 0;
    properties: Note["properties"];
  }[];
}
export interface Audit {
  id?: number;
  space_id: string | null;
  actor_id: string;
  session_id: string;
  request_id: string | null;
  time: string;
  action: string;
  target: string;
  result: string;
}
export interface ErrorBody {
  request_id?: string;
  code: string;
  message: string;
}
const uuid = { type: "string", format: "uuid" };
export const notePropertiesSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "text"],
  properties: {
    title: { type: "string", minLength: 1, maxLength: 200 },
    text: { type: "string", maxLength: 65536 },
  },
};
export const actionSchema = {
  oneOf: ["create_note", "update_note"].map((action) => ({
    type: "object",
    additionalProperties: false,
    required: [
      "request_id",
      "module",
      "action",
      "input",
      ...(action === "update_note" ? ["object_id", "expected_revision"] : []),
    ],
    properties: {
      request_id: uuid,
      module: { const: "notes" },
      action: { const: action },
      input: notePropertiesSchema,
      ...(action === "update_note"
        ? {
            object_id: uuid,
            expected_revision: { type: "integer", minimum: 1 },
          }
        : {}),
    },
  })),
};
export const grantSchema = {
  type: "object",
  additionalProperties: false,
  required: ["request_id", "expected_space_revision", "actions"],
  properties: {
    request_id: uuid,
    expected_space_revision: { type: "integer", minimum: 1 },
    actions: {
      type: "array",
      uniqueItems: true,
      maxItems: 4,
      items: { enum: permissions },
    },
  },
};
export const importSchema = {
  type: "object",
  additionalProperties: false,
  required: ["request_id", "version", "space", "objects"],
  properties: {
    request_id: uuid,
    version: { const: 0 },
    space: {
      type: "object",
      additionalProperties: false,
      required: ["name"],
      properties: { name: { type: "string", minLength: 1, maxLength: 200 } },
    },
    objects: {
      type: "array",
      maxItems: 1000,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["type", "schema_version", "properties"],
        properties: {
          type: { const: "note" },
          schema_version: { const: 0 },
          properties: notePropertiesSchema,
        },
      },
    },
  },
};
export const loginSchema = {
  type: "object",
  additionalProperties: false,
  required: ["actor_id", "secret", "mode"],
  properties: {
    actor_id: uuid,
    secret: { type: "string", minLength: 1, maxLength: 256 },
    mode: { enum: ["browser", "agent"] },
  },
};
