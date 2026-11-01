import {
  notePropertiesSchema,
  type Command,
  type Note,
} from "../contracts/index.js";
export const notesModule = {
  id: "notes",
  version: 0,
  dependencies: [],
  actions: {
    create_note: {
      input_schema: notePropertiesSchema,
      required_permissions: ["read", "write", "execute"],
    },
    update_note: {
      input_schema: notePropertiesSchema,
      required_permissions: ["read", "write", "execute"],
    },
  },
};
// Обработчик получает только проверенную команду и целевой объект, без БД и HTTP.
export function applyNote(
  command: Command,
  context: { id: string; spaceId: string; now: string; previous?: Note },
): Note {
  return {
    id: context.id,
    space_id: context.spaceId,
    type: "note",
    schema_version: 0,
    properties: { ...command.input },
    revision: (context.previous?.revision ?? 0) + 1,
    created_at: context.previous?.created_at ?? context.now,
    updated_at: context.now,
  };
}
