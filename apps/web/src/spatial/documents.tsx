import React, { useCallback, useEffect, useRef, useState } from "react";
import type {
  Note,
  Command,
  CommandResult,
} from "../../../../packages/contracts/index.js";
import { isNote } from "../../../../packages/contracts/index.js";
import type {
  SceneSnapshot,
  SpatialView,
} from "../../../../packages/contracts/spatial.js";
import { api, ApiError, requestId } from "../api.js";
import type { SpatialAdapter, InteractionMode } from "./adapter.js";
import { VisualizerRegistry, webVisualizers } from "./renderers.js";
export interface EditorDraft {
  base: Note;
  title: string;
  text: string;
  dirty: boolean;
  pending: Command | null;
  busy: boolean;
  message: string;
}
const fromNote = (note: Note): EditorDraft => ({
  base: note,
  ...note.properties,
  dirty: false,
  pending: null,
  busy: false,
  message: "",
});
export function useDocumentEditors(
  scenes: Record<string, SceneSnapshot>,
  refresh: (space: string) => Promise<void>,
) {
  const [drafts, setDrafts] = useState<Record<string, EditorDraft>>({});
  const latest = useRef({ scenes, drafts, refresh });
  latest.current = { scenes, drafts, refresh };
  const notes = Object.values(scenes).flatMap((s) => s.objects.filter(isNote));
  const canWrite = (space: string) =>
    ["read", "write", "execute"].every((p) =>
      latest.current.scenes[space]?.permissions.includes(p as "read"),
    );
  useEffect(() => {
    setDrafts((old) => {
      const next: Record<string, EditorDraft> = {};
      let changed = Object.keys(old).length !== notes.length;
      for (const note of notes) {
        const d = old[note.id];
        next[note.id] =
          !d ||
          (!d.dirty &&
            !d.pending &&
            !d.busy &&
            d.base.revision !== note.revision)
            ? fromNote(note)
            : d;
        if (next[note.id] !== d) changed = true;
      }
      return changed ? next : old;
    });
  }, [scenes]);
  function patch(
    id: string,
    change: Partial<Pick<EditorDraft, "title" | "text">>,
  ) {
    const d = latest.current.drafts[id];
    if (!d || d.pending || d.busy || !canWrite(d.base.space_id)) return;
    setDrafts((old) => ({
      ...old,
      [id]: { ...old[id], ...change, dirty: true, message: "" },
    }));
  }
  function reset(id: string) {
    const note = Object.values(latest.current.scenes)
      .flatMap((s) => s.objects)
      .find((o) => o.id === id);
    if (note && isNote(note))
      setDrafts((old) => ({ ...old, [id]: fromNote(note) }));
  }
  async function save(id: string) {
    const d = latest.current.drafts[id];
    if (!d || d.busy || !canWrite(d.base.space_id)) return;
    if (new TextEncoder().encode(d.text).length > 65536) {
      setDrafts((old) => ({
        ...old,
        [id]: { ...d, message: "Текст превышает 64 КиБ UTF-8" },
      }));
      return;
    }
    const command: Command = d.pending ?? {
      request_id: requestId(),
      module: "notes",
      action: "update_note",
      object_id: id,
      expected_revision: d.base.revision,
      input: { title: d.title, text: d.text },
    };
    const active = {
      ...d,
      pending: command,
      busy: true,
      message: "Сохранение документа…",
    };
    latest.current.drafts = { ...latest.current.drafts, [id]: active };
    setDrafts((old) => ({ ...old, [id]: active }));
    const readable = () =>
      latest.current.scenes[d.base.space_id]?.objects.some((o) => o.id === id);
    try {
      const result = await api<CommandResult>(
        `/spaces/${d.base.space_id}/actions`,
        "POST",
        command,
      );
      if (!readable()) return;
      setDrafts((old) =>
        old[id]
          ? {
              ...old,
              [id]: {
                ...fromNote(result.object),
                message: "Документ сохранён",
              },
            }
          : old,
      );
      await latest.current.refresh(d.base.space_id);
    } catch (e) {
      if (!readable()) return;
      setDrafts((old) =>
        old[id]
          ? {
              ...old,
              [id]: {
                ...old[id],
                busy: false,
                pending: e instanceof ApiError ? null : command,
                message:
                  e instanceof ApiError && e.status === 409
                    ? "Конфликт документа: черновик сохранён"
                    : e instanceof ApiError
                      ? e.message
                      : "Результат неизвестен: повторите сохранение",
              },
            }
          : old,
      );
      await latest.current.refresh(d.base.space_id);
    }
  }
  return { drafts, patch, reset, save, canWrite };
}
export type Editors = ReturnType<typeof useDocumentEditors>;
const registry = new VisualizerRegistry(webVisualizers);
function DocumentPanel({
  view,
  note,
  editor,
  editors,
  adapter,
  mode,
}: {
  view: SpatialView;
  note: Note;
  editor: EditorDraft;
  editors: Editors;
  adapter: SpatialAdapter | null;
  mode: InteractionMode;
}) {
  const bind = useCallback(
    (element: HTMLElement | null) => adapter?.bindPanel(view.id, element),
    [adapter, view.id],
  );
  const writable = editors.canWrite(note.space_id),
    editing = mode === "edit";
  return (
    <article
      ref={bind}
      className="spatial-document"
      data-view-id={view.id}
      data-object-id={note.id}
      data-mode={mode}
      aria-label={`Документ: ${editor.title}`}
      hidden={!adapter}
    >
      <div className="document-handle">
        {editing
          ? "Редактирование"
          : "Панель · перемещение / масштаб в выбранном режиме"}{" "}
        <span>Object r{note.revision}</span>
      </div>
      <label>
        Название документа
        <input
          value={editor.title}
          maxLength={200}
          readOnly={!editing || !writable || !!editor.pending || editor.busy}
          tabIndex={editing ? 0 : -1}
          onChange={(e) => editors.patch(note.id, { title: e.target.value })}
        />
      </label>
      <label className="document-content">
        Текст документа
        <textarea
          value={editor.text}
          readOnly={!editing || !writable || !!editor.pending || editor.busy}
          tabIndex={editing ? 0 : -1}
          spellCheck={false}
          onChange={(e) => editors.patch(note.id, { text: e.target.value })}
          onKeyDown={(e) => {
            if (editing && (e.ctrlKey || e.metaKey) && e.key === "s") {
              e.preventDefault();
              void editors.save(note.id);
            }
          }}
        />
      </label>
      <div className="document-actions">
        <button
          tabIndex={editing ? 0 : -1}
          disabled={
            !writable || editor.busy || (!editor.dirty && !editor.pending)
          }
          onClick={() => void editors.save(note.id)}
        >
          {editor.pending
            ? "Повторить сохранение документа"
            : "Сохранить документ"}
        </button>
        <button
          tabIndex={editing ? 0 : -1}
          disabled={!!editor.pending || editor.busy || !editor.dirty}
          onClick={() => editors.reset(note.id)}
        >
          Перечитать документ
        </button>
      </div>
      <div role="status">
        {!writable ? "Только чтение · черновик сохранён в этой вкладке. " : ""}
        {editor.dirty && note.revision !== editor.base.revision
          ? "На сервере новая ревизия документа. "
          : ""}
        {editor.message ||
          (editor.dirty
            ? "Есть несохранённые изменения"
            : "Сохранённая версия")}
      </div>
    </article>
  );
}
export function SpatialDocuments({
  scenes,
  excluded,
  editors,
  adapter,
  mode,
}: {
  scenes: Record<string, SceneSnapshot>;
  excluded: string[];
  editors: Editors;
  adapter: SpatialAdapter | null;
  mode: InteractionMode;
}) {
  return (
    <div className="document-layer" data-interaction={mode}>
      {Object.values(scenes).flatMap((scene) =>
        scene.views
          .filter((v) => registry.interactive(v) && !excluded.includes(v.id))
          .map((view) => {
            const note = scene.objects.find((o) => o.id === view.object_id),
              editor = editors.drafts[view.object_id];
            return note && isNote(note) && editor ? (
              <DocumentPanel
                key={view.id}
                {...{ view, note, editor, editors, adapter, mode }}
              />
            ) : null;
          }),
      )}
    </div>
  );
}
