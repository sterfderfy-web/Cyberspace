import {
  notePropertiesSchema,
  actionSchema,
  isNote,
  type Command,
  type Note,
} from "../contracts/index.js";
import {
  DomainError,
  type ModuleDefinition,
  type ModuleCommand,
  type ModuleContext,
} from "../contracts/modules.js";
const execute = (raw: ModuleCommand, ctx: ModuleContext) => {
  const command = raw as Command;
  if (Buffer.byteLength(command.input.text, "utf8") > 65536)
    throw new DomainError(413, "TOO_LARGE", "Текст превышает 64 КиБ UTF-8");
  const object =
    command.action === "update_note"
      ? ctx.object(command.object_id!)
      : undefined;
  if (command.action === "update_note" && (!object || !isNote(object)))
    throw new DomainError(404, "NOT_FOUND", "Заметка недоступна");
  const previous = object as Note | undefined;
  if (previous && previous.revision !== command.expected_revision)
    throw new DomainError(
      409,
      "REVISION_CONFLICT",
      "Заметка уже изменена. Перечитайте её перед сохранением",
    );
  const note = applyNote(command, {
    id: previous?.id ?? ctx.newId(),
    spaceId: ctx.spaceId,
    now: ctx.now,
    previous,
  });
  ctx.saveObject(note);
  return { object: note };
};
export const notesModule: ModuleDefinition = {
  id: "notes",
  version: 0,
  dependencies: [],
  request_schema: actionSchema,
  actions: {
    create_note: {
      input_schema: notePropertiesSchema,
      required_permissions: ["read", "write", "execute"],
      execute,
    },
    update_note: {
      input_schema: notePropertiesSchema,
      required_permissions: ["read", "write", "execute"],
      execute,
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
