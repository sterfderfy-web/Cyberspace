import React, { useEffect, useRef, useState } from "react";
import type { Space } from "../../../../packages/contracts/index.js";
import {
  identityTransform,
  type ObserverState,
  type PersonalComposition,
  type SceneSnapshot,
  type SpatialView,
  type ViewInput,
  type SpatialCommand,
  type SpatialResult,
  type Transform,
} from "../../../../packages/contracts/spatial.js";
import { api, ApiError, requestId } from "../api.js";
import {
  SpatialAdapter,
  type InteractionMode,
  type ComparisonPlacement,
} from "./adapter.js";
import { SpatialDocuments, useDocumentEditors } from "./documents.js";
import TextComparison from "./comparison/TextComparison.js";
import ImageComparison from "./comparison/ImageComparison.js";
import "./spatial.css";
function read<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(sessionStorage.getItem(key) ?? "null") ?? fallback;
  } catch {
    return fallback;
  }
}
function remember(key: string, value: unknown) {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private browsing can disable storage */
  }
}
function input(v: SpatialView): ViewInput {
  const {
    object_id,
    parent_view_id,
    renderer_id,
    renderer_version,
    config,
    transform,
    visible,
    opacity,
    layer,
    order,
  } = v;
  return structuredClone({
    object_id,
    parent_view_id,
    renderer_id,
    renderer_version,
    config,
    transform,
    visible,
    opacity,
    layer,
    order,
  });
}
export default function SpatialWorkspace({
  actorId,
  spaceId,
  spaces,
}: {
  actorId: string;
  spaceId: string;
  spaces: Space[];
}) {
  const key = `spatial:${actorId}:${spaceId}`,
    host = useRef<HTMLDivElement>(null),
    adapter = useRef<SpatialAdapter | null>(null);
  const [graphics, setGraphics] = useState<SpatialAdapter | null>(null),
    [mode, setMode] = useState<InteractionMode>("select"),
    [multi, setMulti] = useState<string[]>([]),
    [comparison, setComparison] = useState<ComparisonPlacement | null>(null),
    [images, setImages] = useState(false);
  const [composition, setComposition] = useState<PersonalComposition>(() =>
    read(key + ":composition", {
      version: 0,
      space_ids: [spaceId],
      excluded_view_ids: [],
    }),
  );
  const [scenes, setScenes] = useState<Record<string, SceneSnapshot>>({}),
    [selected, setSelected] = useState(""),
    [draft, setDraft] = useState<ViewInput | null>(null),
    [base, setBase] = useState<SpatialView | null>(null),
    [dirty, setDirty] = useState(false);
  const [error, setError] = useState(""),
    [status, setStatus] = useState(""),
    [busy, setBusy] = useState(false),
    [pending, setPending] = useState<{
      space: string;
      command: SpatialCommand;
    } | null>(() => read(key + ":pending", null)),
    [objectId, setObjectId] = useState("");
  const state = useRef({ scenes, busy, pending, dirty });
  state.current = { scenes, busy, pending, dirty };
  const current = Object.values(scenes)
      .flatMap((s) => s.views)
      .find((v) => v.id === selected),
    scene = scenes[current?.space_id ?? base?.space_id ?? ""];
  const editable = (id: string) =>
    ["read", "write", "execute"].every((p) =>
      state.current.scenes[id]?.permissions.includes(p as "read"),
    );
  const choose = (v: SpatialView) => {
    if (state.current.pending || state.current.dirty) return;
    setSelected(v.id);
    setBase(v);
    setDraft(input(v));
  };
  const refreshRef = useRef<(id: string) => Promise<void>>(async () => {});
  const editors = useDocumentEditors(scenes, (id) => refreshRef.current(id));
  const views = Object.values(scenes).flatMap((s) => s.views);
  const compareA = views.find((v) => v.id === comparison?.a),
    compareB = views.find((v) => v.id === comparison?.b);
  const compareActive = comparison && compareA && compareB ? comparison : null;
  useEffect(() => {
    const ids = new Set(views.map((v) => v.id));
    setMulti((old) =>
      old.every((id) => ids.has(id)) ? old : old.filter((id) => ids.has(id)),
    );
    if (comparison && (!ids.has(comparison.a) || !ids.has(comparison.b)))
      setComparison(null);
  }, [scenes]);
  useEffect(() => {
    graphics?.setMode(mode);
  }, [graphics, mode]);
  useEffect(() => {
    graphics?.setComparison(compareActive);
  }, [graphics, compareActive]);
  useEffect(() => {
    remember(key + ":composition", composition);
  }, [composition, key]);
  useEffect(() => {
    remember(key + ":pending", pending);
  }, [pending, key]);
  useEffect(() => {
    let stopped = false;
    const sequence: Record<string, number> = {};
    const cleanups: (() => void)[] = [];
    setScenes((previous) =>
      Object.fromEntries(
        Object.entries(previous).filter(([id]) =>
          composition.space_ids.includes(id),
        ),
      ),
    );
    async function refresh(id: string) {
      const request = (sequence[id] = (sequence[id] ?? 0) + 1);
      try {
        const s = await api<SceneSnapshot>(`/spaces/${id}/scene`);
        if (!stopped && sequence[id] === request)
          setScenes((old) =>
            old[id] && old[id].cursor > s.cursor ? old : { ...old, [id]: s },
          );
      } catch (e) {
        if (!stopped && sequence[id] === request) {
          setError((e as Error).message);
          if (e instanceof ApiError && [401, 403, 404].includes(e.status)) {
            setPending((old) => {
              if (old?.space === id) {
                remember(key + ":pending", null);
                return null;
              }
              return old;
            });
            setScenes((old) => {
              const next = { ...old };
              delete next[id];
              return next;
            });
          }
        }
      }
    }
    refreshRef.current = refresh;
    for (const id of composition.space_ids) {
      let socket: WebSocket,
        timer: ReturnType<typeof setTimeout>,
        attempt = 0;
      const connect = () => {
        if (stopped) return;
        socket = new WebSocket(
          `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/v0/spaces/${id}/events`,
        );
        socket.onopen = () => {
          attempt = 0;
          void refresh(id);
        };
        socket.onmessage = () => void refresh(id);
        socket.onclose = (e) => {
          if (stopped) return;
          void refresh(id);
          if (e.code !== 1008)
            timer = setTimeout(connect, Math.min(10000, 500 * 2 ** attempt++));
        };
        socket.onerror = () => socket.close();
      };
      connect();
      cleanups.push(() => {
        clearTimeout(timer);
        socket?.close();
      });
    }
    return () => {
      stopped = true;
      cleanups.forEach((fn) => fn());
    };
  }, [composition.space_ids.join(",")]);
  async function send(space: string, command: SpatialCommand) {
    if (state.current.busy) return;
    setBusy(true);
    setPending({ space, command });
    setError("");
    setStatus("Сохранение размещения…");
    try {
      const result = await api<SpatialResult>(
        `/spaces/${space}/actions`,
        "POST",
        command,
      );
      await refreshRef.current(space);
      setPending(null);
      setDirty(false);
      if (result.view) {
        setSelected(result.view.id);
        setBase(result.view);
        setDraft(input(result.view));
      } else {
        setSelected("");
        setBase(null);
        setDraft(null);
      }
      setStatus("Размещение сохранено");
    } catch (e) {
      if (e instanceof ApiError) {
        setPending(null);
        setStatus(
          e.status === 409
            ? "Конфликт: черновик сохранён. Загрузите актуальный View перед новой правкой."
            : "Не сохранено",
        );
      } else
        setStatus(
          "Результат неизвестен. Повторите запрос с тем же идентификатором.",
        );
      setError((e as Error).message);
      await refreshRef.current(space);
    } finally {
      setBusy(false);
    }
  }
  const sendRef = useRef(send);
  sendRef.current = send;
  useEffect(() => {
    if (!host.current) return;
    try {
      adapter.current = new SpatialAdapter(
        host.current,
        read<ObserverState | undefined>(key + ":observer", undefined),
        {
          select: choose,
          move: (v, transform) => {
            if (
              state.current.pending ||
              state.current.busy ||
              state.current.dirty
            )
              return;
            const next = { ...input(v), transform };
            setBase(v);
            setDraft(next);
            setDirty(true);
            void sendRef.current(v.space_id, {
              request_id: requestId(),
              module: "spatial",
              action: "update_view",
              view_id: v.id,
              expected_revision: v.revision,
              input: next,
            });
          },
          observe: (observer) => remember(key + ":observer", observer),
          error: setError,
        },
      );
      setGraphics(adapter.current);
    } catch (e) {
      setError(
        `Графика недоступна: ${(e as Error).message}. Список и параметры View доступны ниже.`,
      );
    }
    return () => {
      adapter.current?.dispose();
      adapter.current = null;
    };
  }, [key]);
  useEffect(() => {
    adapter.current?.update(
      Object.values(scenes).map((scene) => ({
        scene,
        offset: composition.source_offsets?.[scene.space.id] ?? {
          x: 0,
          y: 0,
          z: 0,
        },
      })),
      composition.excluded_view_ids,
      selected,
      (id) => editable(id) && !pending && !dirty && !busy,
    );
  }, [
    scenes,
    composition.excluded_view_ids,
    composition.source_offsets,
    pending,
    dirty,
    busy,
  ]);
  useEffect(() => adapter.current?.select(selected), [selected]);
  useEffect(() => {
    if (
      current &&
      !state.current.dirty &&
      !state.current.pending &&
      !state.current.busy &&
      (!base || base.id !== current.id || base.revision !== current.revision)
    ) {
      setBase(current);
      setDraft(input(current));
    }
    if (base && !scenes[base.space_id]) {
      setBase(null);
      setDraft(null);
      setSelected("");
      setDirty(false);
    }
  }, [scenes, current, dirty, pending, busy]);
  const patch = (change: Partial<ViewInput>) => {
    state.current.dirty = true;
    setDraft((d) => (d ? { ...d, ...change } : d));
    setDirty(true);
  };
  const vector = (group: keyof Transform, axis: string, value: number) => {
    if (draft)
      patch({
        transform: {
          ...draft.transform,
          [group]: { ...draft.transform[group], [axis]: value },
        },
      });
  };
  async function create(copy?: SpatialView) {
    const s = copy ? scenes[copy.space_id] : scenes[spaceId];
    const object =
      copy?.object_id ||
      objectId ||
      s?.objects.find((o) => o.type === "note")?.id;
    if (!s || !object) return;
    const placement = adapter.current?.placement(
      composition.source_offsets?.[s.space.id] ?? { x: 0, y: 0, z: 0 },
    );
    if (!copy && !placement) {
      setError(
        "Для первоначального размещения нужна доступная графическая сцена.",
      );
      return;
    }
    const data: ViewInput = copy
      ? input(copy)
      : {
          object_id: object,
          parent_view_id: null,
          renderer_id: "notes.panel",
          renderer_version: 0,
          config: { width_m: placement!.width, height_m: placement!.height },
          transform: { ...identityTransform(), position: placement!.position },
          visible: true,
          opacity: 1,
          layer: 0,
          order: 0,
        };
    if (copy) {
      data.transform.position.x += (Number(data.config.width_m) || 0) * 0.15;
      data.order = Math.min(10000, data.order + 1);
    }
    await send(s.space.id, {
      request_id: requestId(),
      module: "spatial",
      action: "create_view",
      input: data,
    });
  }
  return (
    <section
      className="spatial-workspace"
      aria-label="Пространственная рабочая область"
    >
      <div className="spatial-toolbar">
        <strong>Пространственная область</strong>
        <button
          aria-pressed={mode === "select"}
          onClick={() => setMode("select")}
        >
          Выбор / перемещение
        </button>
        <button aria-pressed={mode === "pan"} onClick={() => setMode("pan")}>
          Панорама
        </button>
        <button
          aria-pressed={mode === "orbit"}
          onClick={() => setMode("orbit")}
        >
          Орбита
        </button>
        <button aria-pressed={mode === "edit"} onClick={() => setMode("edit")}>
          Редактировать документы
        </button>
        <button
          aria-pressed={mode === "scale"}
          onClick={() => setMode("scale")}
        >
          Масштаб View
        </button>
        <button
          aria-label="Приблизить"
          onClick={() => adapter.current?.zoom(0.8)}
        >
          ＋
        </button>
        <button
          aria-label="Отдалить"
          onClick={() => adapter.current?.zoom(1.25)}
        >
          −
        </button>
        <button onClick={() => adapter.current?.front()}>Спереди</button>
        <button onClick={() => adapter.current?.fit()}>Показать всё</button>
      </div>
      <p className="interaction-status" role="status">
        Режим:{" "}
        {
          {
            select: "перемещение панелей",
            pan: "навигация",
            orbit: "орбита",
            edit: "редактирование текста",
            scale: "масштаб панелей — тяните вправо/влево",
          }[mode]
        }
      </p>
      <div ref={host} className="spatial-canvas">
        <SpatialDocuments
          scenes={scenes}
          excluded={composition.excluded_view_ids}
          editors={editors}
          adapter={graphics}
          mode={mode}
        />
      </div>
      <div className="comparison-toolbar">
        <button
          disabled={multi.length !== 2 || !!comparison}
          onClick={() =>
            setComparison({
              a: multi[0],
              b: multi[1],
              alpha: 0.5,
              show: "both",
            })
          }
        >
          Сравнить выбранные View
        </button>
        <span>Выбрано: {multi.length} · отметьте панели в списке</span>
        <button onClick={() => setImages((v) => !v)}>
          Сравнение изображений
        </button>
        {compareActive && (
          <>
            <label>
              Прозрачность верхнего View
              <input
                type="range"
                min="0"
                max="1"
                step=".01"
                value={compareActive.alpha}
                onChange={(e) =>
                  setComparison({
                    ...compareActive,
                    alpha: Number(e.target.value),
                  })
                }
              />
            </label>
            {(["both", "a", "b"] as const).map((show) => (
              <button
                key={show}
                aria-pressed={compareActive.show === show}
                onClick={() => setComparison({ ...compareActive, show })}
              >
                {{ both: "Наложение", a: "Только A", b: "Только B" }[show]}
              </button>
            ))}
            <button onClick={() => setComparison(null)}>
              Завершить сравнение
            </button>
            <p>
              Личная композиция сравнения: общий масштаб и положение. Исходные
              View не изменены.
            </p>
          </>
        )}
      </div>
      {compareActive &&
        compareA &&
        compareB &&
        editors.drafts[compareA.object_id] &&
        editors.drafts[compareB.object_id] && (
          <TextComparison
            key={compareA.id + compareB.id}
            a={editors.drafts[compareA.object_id].text}
            b={editors.drafts[compareB.object_id].text}
            draft={
              editors.drafts[compareA.object_id].dirty ||
              editors.drafts[compareB.object_id].dirty
            }
          />
        )}
      {images && <ImageComparison />}
      <p className="muted">
        Перетащите панель для размещения. Колесо / жест двумя пальцами — масштаб
        камеры. Координаты в метрах; камера и скрытие «у меня» относятся только
        к этой вкладке.
      </p>
      {status && <p role="status">{status}</p>}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {pending && !busy && (
        <button onClick={() => void send(pending.space, pending.command)}>
          Повторить запрос размещения
        </button>
      )}
      <div className="spatial-details">
        <div>
          <h3>Личная композиция</h3>
          {spaces.map((s) => (
            <label key={s.id}>
              <input
                type="checkbox"
                checked={composition.space_ids.includes(s.id)}
                disabled={s.id === spaceId}
                onChange={(e) =>
                  setComposition((c) => ({
                    ...c,
                    space_ids: e.target.checked
                      ? [...c.space_ids, s.id]
                      : c.space_ids.filter((id) => id !== s.id),
                  }))
                }
              />
              {s.name}
            </label>
          ))}
          {composition.space_ids.map((id) => (
            <div className="spatial-vector" key={id}>
              <strong>
                Личный сдвиг: {spaces.find((s) => s.id === id)?.name ?? id}
              </strong>
              {(["x", "y", "z"] as const).map((axis) => (
                <label key={axis}>
                  Сдвиг {axis}
                  <input
                    aria-label={`Личный сдвиг ${id}.${axis}`}
                    type="number"
                    step="any"
                    min="-1000000"
                    max="1000000"
                    value={composition.source_offsets?.[id]?.[axis] ?? 0}
                    onChange={(e) => {
                      const value = Number(e.target.value);
                      if (Number.isFinite(value) && Math.abs(value) <= 1e6)
                        setComposition((c) => ({
                          ...c,
                          source_offsets: {
                            ...c.source_offsets,
                            [id]: {
                              x: 0,
                              y: 0,
                              z: 0,
                              ...c.source_offsets?.[id],
                              [axis]: value,
                            },
                          },
                        }));
                    }}
                  />
                </label>
              ))}
            </div>
          ))}
          <h3>Добавить представление</h3>
          <label>
            Исходный объект
            <select
              aria-label="Исходный объект"
              value={
                objectId ||
                scenes[spaceId]?.objects.find((o) => o.type === "note")?.id ||
                ""
              }
              onChange={(e) => setObjectId(e.target.value)}
            >
              {scenes[spaceId]?.objects
                .filter((o) => o.type === "note")
                .map((o) => (
                  <option key={o.id} value={o.id}>
                    {String(o.properties.title)}
                  </option>
                ))}
            </select>
          </label>
          <button
            disabled={
              !editable(spaceId) ||
              busy ||
              !!pending ||
              dirty ||
              !scenes[spaceId]?.objects.some((o) => o.type === "note")
            }
            onClick={() => void create()}
          >
            Добавить View
          </button>
          <h3>Представления</h3>
          {Object.values(scenes).flatMap((s) =>
            s.views.map((v) => (
              <div className="view-row" key={v.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={multi.includes(v.id)}
                    disabled={
                      !!comparison ||
                      (!multi.includes(v.id) && multi.length >= 2)
                    }
                    onChange={(e) =>
                      setMulti((ids) =>
                        e.target.checked
                          ? [...ids, v.id]
                          : ids.filter((id) => id !== v.id),
                      )
                    }
                  />
                  Выбрать для сравнения
                </label>
                <button
                  aria-pressed={v.id === selected}
                  disabled={dirty || !!pending}
                  onClick={() => choose(v)}
                >
                  {String(
                    s.objects.find((o) => o.id === v.object_id)?.properties
                      .title ?? v.object_id,
                  )}{" "}
                  · {v.renderer_id} · r{v.revision}
                </button>
                <label>
                  <input
                    type="checkbox"
                    checked={composition.excluded_view_ids.includes(v.id)}
                    onChange={(e) =>
                      setComposition((c) => ({
                        ...c,
                        excluded_view_ids: e.target.checked
                          ? [...c.excluded_view_ids, v.id]
                          : c.excluded_view_ids.filter((id) => id !== v.id),
                      }))
                    }
                  />
                  Скрыть у меня
                </label>
              </div>
            )),
          )}
        </div>
        <div>
          {base && draft && scene ? (
            <>
              <h3>Общее размещение View</h3>
              {!current && !busy && (
                <p className="error">
                  View отсутствует в актуальной сцене. Черновик можно отбросить.
                </p>
              )}
              <details>
                <summary>Свойства исходного объекта</summary>
                <pre className="source-properties">
                  {JSON.stringify(
                    scene.objects.find((o) => o.id === base.object_id),
                    null,
                    2,
                  )}
                </pre>
              </details>
              <p>
                Ревизия {base.revision} · {scene.space.name}
              </p>
              {current && current.revision !== base.revision && (
                <p className="error">
                  На сервере новая ревизия. Черновик не перезаписан.
                </p>
              )}
              <fieldset
                disabled={
                  !editable(base.space_id) ||
                  busy ||
                  !!pending ||
                  base.id === compareActive?.a ||
                  base.id === compareActive?.b
                }
              >
                <label>
                  Визуализатор
                  <select
                    aria-label="Визуализатор"
                    value={draft.renderer_id}
                    onChange={(e) => patch({ renderer_id: e.target.value })}
                  >
                    <option value="notes.panel">Документ</option>
                    <option value="notes.summary">Карточка-сводка</option>
                    {!["notes.panel", "notes.summary"].includes(
                      draft.renderer_id,
                    ) && (
                      <option value={draft.renderer_id}>
                        Недоступен в этом клиенте: {draft.renderer_id}
                      </option>
                    )}
                  </select>
                </label>
                <label>
                  Родитель
                  <select
                    aria-label="Родитель"
                    value={draft.parent_view_id ?? ""}
                    onChange={(e) =>
                      patch({ parent_view_id: e.target.value || null })
                    }
                  >
                    <option value="">Корень сцены</option>
                    {scene.views
                      .filter((v) => v.id !== base.id)
                      .map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.id.slice(0, 8)}
                        </option>
                      ))}
                  </select>
                </label>
                {(["position", "rotation", "scale"] as const).map((group) => (
                  <div key={group} className="spatial-vector">
                    <strong>
                      {
                        {
                          position: "Положение, м",
                          rotation: "Поворот, quaternion",
                          scale: "Масштаб",
                        }[group]
                      }
                    </strong>
                    {Object.entries(draft.transform[group]).map(
                      ([axis, value]) => (
                        <label key={axis}>
                          {group}.{axis}
                          <input
                            type="number"
                            step="any"
                            value={value}
                            onChange={(e) =>
                              vector(group, axis, Number(e.target.value))
                            }
                          />
                        </label>
                      ),
                    )}
                  </div>
                ))}
                {["width_m", "height_m"]
                  .filter((k) => typeof draft.config[k] === "number")
                  .map((k) => (
                    <label key={k}>
                      {k}
                      <input
                        type="number"
                        min="0.001"
                        max="10000"
                        step="any"
                        value={Number(draft.config[k])}
                        onChange={(e) =>
                          patch({
                            config: {
                              ...draft.config,
                              [k]: Number(e.target.value),
                            },
                          })
                        }
                      />
                    </label>
                  ))}
                {(["opacity", "layer", "order"] as const).map((k) => (
                  <label key={k}>
                    {
                      {
                        opacity: "Непрозрачность",
                        layer: "Слой",
                        order: "Порядок",
                      }[k]
                    }
                    <input
                      type="number"
                      step={k === "opacity" ? 0.1 : 1}
                      value={draft[k]}
                      onChange={(e) => patch({ [k]: Number(e.target.value) })}
                    />
                  </label>
                ))}
                <label>
                  <input
                    type="checkbox"
                    checked={draft.visible}
                    onChange={(e) => patch({ visible: e.target.checked })}
                  />
                  Видим для всех
                </label>
                <button
                  disabled={!dirty}
                  onClick={() =>
                    void send(base.space_id, {
                      request_id: requestId(),
                      module: "spatial",
                      action: "update_view",
                      view_id: base.id,
                      expected_revision: base.revision,
                      input: draft,
                    })
                  }
                >
                  Сохранить размещение
                </button>
                <button disabled={dirty} onClick={() => void create(base)}>
                  Ещё один View
                </button>
                <button
                  disabled={dirty}
                  onClick={() =>
                    void send(base.space_id, {
                      request_id: requestId(),
                      module: "spatial",
                      action: "delete_view",
                      view_id: base.id,
                      expected_revision: base.revision,
                    })
                  }
                >
                  Удалить View
                </button>
              </fieldset>
              <button
                disabled={!!pending}
                onClick={() => {
                  if (current) {
                    setBase(current);
                    setDraft(input(current));
                    setDirty(false);
                    setError("");
                    setStatus("Загружено актуальное размещение");
                  } else {
                    setBase(null);
                    setDraft(null);
                    setSelected("");
                    setDirty(false);
                    setError("");
                    setStatus("Представление удалено");
                  }
                }}
              >
                Отбросить черновик View
              </button>
              <p className="muted">
                Изменение View не меняет текст документа. Для текста откройте
                «Заметки».
              </p>
            </>
          ) : (
            <p>
              Выберите представление на сцене или в списке. Если объектов нет,
              создайте заметку в разделе «Заметки».
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
