import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  Actor,
  Audit,
  Command,
  CommandResult,
  ExportData,
  Note,
  Permission,
  Snapshot,
  Space,
} from "../../../packages/contracts/index.js";
import { api, ApiError, requestId } from "./api.js";
import "./style.css";
const SpatialWorkspace = React.lazy(() => import("./spatial/Workspace.js"));
const labels: Record<Permission, string> = {
  read: "Чтение",
  write: "Изменение",
  execute: "Выполнение",
  manage: "Управление",
};
type Rights = { actor: Actor; actions: Permission[] }[];
function App() {
  const [actor, setActor] = useState<Actor | null>(null),
    [boot, setBoot] = useState(true);
  const [loginId, setLoginId] = useState(""),
    [secret, setSecret] = useState("");
  const [spaces, setSpaces] = useState<Space[]>([]),
    [spaceId, setSpaceId] = useState("");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null),
    [selected, setSelected] = useState("");
  const [draft, setDraft] = useState({ title: "", text: "" }),
    [base, setBase] = useState<Note | null>(null),
    [dirty, setDirty] = useState(false);
  const [creating, setCreating] = useState(false),
    [status, setStatus] = useState(""),
    [error, setError] = useState("");
  const [connection, setConnection] = useState("Подключение"),
    [busy, setBusy] = useState(false),
    [pending, setPending] = useState<Command | null>(null);
  const [panel, setPanel] = useState<"notes" | "access" | "audit" | "spatial">(
      "notes",
    ),
    [rights, setRights] = useState<Rights>([]),
    [audit, setAudit] = useState<Audit[]>([]);
  const snapshotRef = useRef<Snapshot | null>(null);
  const pendingImport = useRef<{ text: string; request_id: string } | null>(
    null,
  );
  const activeSpace = useRef("");
  activeSpace.current = spaceId;
  const editable =
    !!snapshot &&
    ["read", "write", "execute"].every((p) =>
      snapshot.permissions.includes(p as Permission),
    );
  const manager = snapshot?.permissions.includes("manage");
  const online = connection === "На связи";
  const clearEditor = useCallback(() => {
    setSelected("");
    setBase(null);
    setDraft({ title: "", text: "" });
    setDirty(false);
    setCreating(false);
    setPending(null);
  }, []);
  const clearSpace = useCallback(() => {
    setSnapshot(null);
    snapshotRef.current = null;
    setRights([]);
    setAudit([]);
    clearEditor();
  }, [clearEditor]);
  const reloadSpaces = useCallback(async () => {
    const list = await api<Space[]>("/spaces");
    setSpaces(list);
    setSpaceId((current) =>
      list.some((s) => s.id === current) ? current : (list[0]?.id ?? ""),
    );
  }, []);
  useEffect(() => {
    void api<{ actor: Actor }>("/session")
      .then(async (r) => {
        setActor(r.actor);
        await reloadSpaces();
      })
      .catch((e) => {
        if (!(e instanceof ApiError && e.status === 401))
          setError("Сервер недоступен. Обновите страницу после запуска.");
      })
      .finally(() => setBoot(false));
  }, [reloadSpaces]);
  const refresh = useCallback(
    async (id: string) => {
      try {
        const next = await api<Snapshot>(`/spaces/${id}`);
        if (activeSpace.current !== id) return;
        if (!snapshotRef.current || next.cursor >= snapshotRef.current.cursor) {
          snapshotRef.current = next;
          setSnapshot(next);
        }
        if (next.permissions.includes("manage")) {
          try {
            const [r, a] = await Promise.all([
              api<Rights>(`/spaces/${id}/permissions`),
              api<Audit[]>(`/spaces/${id}/audit`),
            ]);
            if (
              activeSpace.current === id &&
              snapshotRef.current?.permissions.includes("manage")
            ) {
              setRights(r);
              setAudit(a);
            }
          } catch (e) {
            if (e instanceof ApiError && e.status === 403) {
              setRights([]);
              setAudit([]);
              setPanel((p) => (p === "access" || p === "audit" ? "notes" : p));
            } else throw e;
          }
        } else {
          setRights([]);
          setAudit([]);
          setPanel((p) => (p === "access" || p === "audit" ? "notes" : p));
        }
      } catch (e) {
        if (activeSpace.current !== id) return;
        if (e instanceof ApiError && [401, 403, 404].includes(e.status)) {
          clearSpace();
          setError(e.message);
          if (e.status === 401) {
            setActor(null);
            setSpaceId("");
          } else await reloadSpaces();
        } else {
          setConnection("Нет связи");
          throw e;
        }
      }
    },
    [clearSpace, reloadSpaces],
  );
  useEffect(() => {
    clearSpace();
    setStatus("");
    setPanel("notes");
    if (!actor || !spaceId) return;
    let stopped = false,
      socket: WebSocket,
      timer: ReturnType<typeof setTimeout>,
      attempt = 0;
    // Сначала подписка. Каждое уведомление инициирует снимок; старые ответы отбрасываются по cursor.
    const connect = () => {
      if (stopped) return;
      setConnection("Подключение");
      socket = new WebSocket(
        `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/v0/spaces/${spaceId}/events`,
      );
      socket.onopen = () => {
        attempt = 0;
        setConnection("На связи");
        void refresh(spaceId).catch(() => {});
      };
      socket.onmessage = () => {
        void refresh(spaceId).catch(() => {});
      };
      socket.onclose = (event) => {
        if (stopped) return;
        setConnection(event.code === 1008 ? "Доступ изменён" : "Нет связи");
        if (event.code === 1008) {
          void refresh(spaceId).catch(() => {});
          return;
        }
        timer = setTimeout(
          connect,
          Math.min(10_000, 500 * 2 ** attempt++) * (0.8 + Math.random() * 0.4),
        );
      };
      socket.onerror = () => socket.close();
    };
    connect();
    return () => {
      stopped = true;
      clearTimeout(timer);
      socket?.close();
    };
  }, [actor, spaceId, refresh, clearSpace]);
  useEffect(() => {
    const note = snapshot?.objects.find((n) => n.id === selected);
    if (note && !dirty && !pending) {
      setBase(note);
      setDraft(note.properties);
    }
  }, [snapshot, selected, dirty, pending]);
  const remote = snapshot?.objects.find((n) => n.id === selected);
  const conflict =
    !!base && !!remote && remote.revision !== base.revision && dirty;
  async function login(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await api<{ actor: Actor }>("/sessions", "POST", {
        actor_id: loginId.trim(),
        secret,
        mode: "browser",
      });
      setActor(result.actor);
      setSecret("");
      await reloadSpaces();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function choose(note?: Note) {
    if (pending) {
      setError(
        "Сначала выясните результат сохранения: нажмите «Повторить запрос».",
      );
      return;
    }
    if (dirty && !window.confirm("Отбросить несохранённый черновик?")) return;
    setSelected(note?.id ?? "");
    setBase(note ?? null);
    setDraft(note?.properties ?? { title: "", text: "" });
    setDirty(false);
    setCreating(!note);
    setError("");
    setStatus("");
  }
  async function save() {
    setBusy(true);
    setError("");
    setStatus("Сохранение…");
    const command: Command = pending ?? {
      request_id: requestId(),
      module: "notes",
      action: base ? "update_note" : "create_note",
      ...(base ? { object_id: base.id, expected_revision: base.revision } : {}),
      input: { ...draft },
    };
    setPending(command);
    try {
      const result = await api<CommandResult>(
        `/spaces/${spaceId}/actions`,
        "POST",
        command,
      );
      setPending(null);
      setBase(result.object);
      setSelected(result.object.id);
      setDraft(result.object.properties);
      setDirty(false);
      setCreating(false);
      setStatus("Сохранено");
      await refresh(spaceId);
    } catch (e) {
      if (e instanceof ApiError) {
        setPending(null);
        setStatus(
          e.status === 409
            ? "Конфликт · черновик сохранён в этой вкладке"
            : "Не сохранено",
        );
      } else
        setStatus(
          "Результат неизвестен. Повторите тот же запрос после восстановления связи",
        );
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function grant(actorId: string, actions: Permission[]) {
    setBusy(true);
    setError("");
    try {
      await api(`/spaces/${spaceId}/permissions/${actorId}`, "PUT", {
        request_id: requestId(),
        expected_space_revision: snapshot!.cursor,
        actions,
      });
      setStatus("Права обновлены");
      await refresh(spaceId);
    } catch (e) {
      setError((e as Error).message);
      await refresh(spaceId).catch(() => {});
    } finally {
      setBusy(false);
    }
  }
  async function exportNotes() {
    try {
      const data = await api<ExportData>(`/spaces/${spaceId}/export`);
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = "cyberspace-notes.json";
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function importNotes(file?: File) {
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      if (file.size > 10 * 1024 * 1024)
        throw new Error("Файл превышает 10 МиБ");
      const text = await file.text();
      if (pendingImport.current && pendingImport.current.text !== text)
        throw new Error(
          "Результат предыдущего импорта неизвестен. Выберите тот же файл для проверки результата",
        );
      const data = JSON.parse(text);
      const request_id = pendingImport.current?.request_id ?? requestId();
      pendingImport.current = { text, request_id };
      await api("/imports", "POST", { ...data, request_id });
      pendingImport.current = null;
      await reloadSpaces();
      setStatus("Создана независимая копия пространства");
    } catch (e) {
      if (e instanceof ApiError) pendingImport.current = null;
      if (pendingImport.current)
        setStatus(
          "Результат импорта неизвестен. Выберите тот же файл повторно; копия не будет создана дважды",
        );
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (boot)
    return (
      <main className="login">
        <p>Подключение к Cyberspace…</p>
      </main>
    );
  if (!actor)
    return (
      <main className="login">
        <div className="login-intro">
          <span className="eyebrow">CYBERSPACE / ПРОТОТИП 01</span>
          <h1>
            Общее пространство.
            <br />
            Ваш взгляд.
          </h1>
          <p>Заметки, люди и программный агент в одной локальной мастерской.</p>
          <span className="tag">Работает без интернета</span>
        </div>
        <form onSubmit={login} className="login-card">
          <h2>Войти в мастерскую</h2>
          <p className="muted">
            Используйте отдельные тестовые данные из локального файла
            credentials.json.
          </p>
          <label>
            ID участника
            <input
              name="actor"
              value={loginId}
              onChange={(e) => setLoginId(e.target.value)}
              required
              autoComplete="username"
              spellCheck={false}
            />
          </label>
          <label>
            Учётный секрет
            <input
              name="secret"
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              required
              autoComplete="current-password"
            />
          </label>
          <button className="primary" disabled={busy}>
            Войти
          </button>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <p className="fine">
            Демонстрация в доверенной локальной сети. Не используйте настоящие
            пароли.
          </p>
        </form>
      </main>
    );
  return (
    <div className="app">
      <header>
        <a className="brand" href="/">
          ◈ <span>CYBERSPACE</span>
        </a>
        <div className="header-right">
          <span
            role="status"
            className={`connection ${online ? "online" : ""}`}
          >
            ● {connection}
          </span>
          <span>{actor.display_name}</span>
          <button
            onClick={async () => {
              try {
                await api("/session", "DELETE");
                setActor(null);
                setSpaceId("");
                clearSpace();
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            Выйти
          </button>
        </div>
      </header>
      <div className="workspace">
        <aside>
          <div className="eyebrow">ПРОСТРАНСТВО</div>
          <label className="space-label">
            Выбор пространства
            <select
              value={spaceId}
              onChange={(e) => {
                if (
                  (!dirty && !pending) ||
                  window.confirm("Переключить пространство и закрыть черновик?")
                )
                  setSpaceId(e.target.value);
              }}
            >
              {spaces.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <nav>
            <button
              className={panel === "spatial" ? "active" : ""}
              onClick={() => setPanel("spatial")}
            >
              Пространственная область
            </button>
            <button
              className={panel === "notes" ? "active" : ""}
              onClick={() => setPanel("notes")}
            >
              ▤ Заметки <span>{snapshot?.objects.length ?? 0}</span>
            </button>
            {manager && (
              <>
                <button
                  className={panel === "access" ? "active" : ""}
                  onClick={() => setPanel("access")}
                >
                  ☷ Участники и права
                </button>
                <button
                  className={panel === "audit" ? "active" : ""}
                  onClick={() => setPanel("audit")}
                >
                  ↳ Журнал действий
                </button>
              </>
            )}
          </nav>
          <div className="aside-bottom">
            <strong>Демо-агент</strong>
            <p>
              Детерминированная программа без LLM. Выполняет только явные
              задания через API.
            </p>
            <span className="tag">notes · v0</span>
          </div>
        </aside>
        <main className="content">
          <div className="page-heading">
            <div>
              <div className="eyebrow">ЛОКАЛЬНАЯ СРЕДА</div>
              <h1>{snapshot?.space.name ?? "Нет доступного пространства"}</h1>
              <p className="muted">
                {snapshot
                  ? `Ревизия ${snapshot.cursor} · Изменения видны всем участникам с доступом`
                  : "Доступ может выдать владелец."}
              </p>
            </div>
            <div className="actions">
              {manager && (
                <button onClick={() => void exportNotes()} disabled={!online}>
                  Экспорт
                </button>
              )}
              {actor.instance_owner && (
                <label className="file-button">
                  Импорт копии
                  <input
                    type="file"
                    accept="application/json,.json"
                    disabled={busy}
                    onChange={(e) => {
                      void importNotes(e.target.files?.[0]);
                      e.target.value = "";
                    }}
                  />
                </label>
              )}
              <button
                onClick={() =>
                  void reloadSpaces()
                    .then(async () => {
                      if (spaceId) await refresh(spaceId);
                    })
                    .catch((e) => setError(e.message))
                }
              >
                Обновить
              </button>
            </div>
          </div>
          {error && (
            <div role="alert" className="error">
              {error}
            </div>
          )}
          {status && (
            <p role="status" className="save-status">
              {status}
            </p>
          )}
          {panel === "spatial" && snapshot && (
            <React.Suspense
              fallback={<p>Загрузка пространственной области…</p>}
            >
              <SpatialWorkspace
                key={`${actor.id}:${spaceId}`}
                actorId={actor.id}
                spaceId={spaceId}
                spaces={spaces}
              />
            </React.Suspense>
          )}
          {panel === "notes" && snapshot && (
            <div className="notes-layout">
              <section className="note-list">
                <div className="section-heading">
                  <h2>Заметки</h2>
                  <button
                    aria-label="Новая заметка"
                    disabled={!editable || !online || !!pending}
                    onClick={() => choose()}
                  >
                    ＋ Новая
                  </button>
                </div>
                {snapshot.objects.length === 0 && (
                  <p className="empty">
                    Здесь появятся общие заметки мастерской.
                  </p>
                )}
                {snapshot.objects.map((n) => (
                  <button
                    className={`note-item ${selected === n.id ? "selected" : ""}`}
                    key={n.id}
                    onClick={() => choose(n)}
                  >
                    <strong>{n.properties.title}</strong>
                    <span>
                      {n.properties.text.slice(0, 75) || "Без текста"}
                    </span>
                    <small>Ревизия {n.revision}</small>
                  </button>
                ))}
              </section>
              <section className="editor">
                {base || creating ? (
                  <>
                    <div className="section-heading">
                      <span className="eyebrow">
                        {creating
                          ? "НОВАЯ ЗАМЕТКА"
                          : `ЗАМЕТКА / РЕВИЗИЯ ${base?.revision}`}
                      </span>
                      <span className="muted">
                        {dirty
                          ? "Есть несохранённые изменения"
                          : "Подтверждённое состояние"}
                      </span>
                    </div>
                    {conflict && (
                      <div className="warning">
                        Заметка изменена другим участником. Ваш черновик не
                        перезаписан.
                      </div>
                    )}
                    <label>
                      Заголовок
                      <input
                        aria-label="Заголовок"
                        maxLength={200}
                        value={draft.title}
                        readOnly={!editable || !!pending}
                        onChange={(e) => {
                          setDraft({ ...draft, title: e.target.value });
                          setDirty(true);
                        }}
                      />
                    </label>
                    <label>
                      Текст
                      <textarea
                        aria-label="Текст"
                        value={draft.text}
                        readOnly={!editable || !!pending}
                        onChange={(e) => {
                          setDraft({ ...draft, text: e.target.value });
                          setDirty(true);
                        }}
                      />
                    </label>
                    <div className="editor-footer">
                      <span className="muted">
                        {editable
                          ? "Сохраняйте изменения явно"
                          : "Доступ только для чтения"}{" "}
                        · {new TextEncoder().encode(draft.text).length} / 65536
                        байт
                      </span>
                      <div className="actions">
                        {(conflict || dirty) && base && !pending && (
                          <button
                            onClick={() => {
                              if (
                                window.confirm(
                                  "Заменить черновик актуальной версией?",
                                )
                              ) {
                                setDirty(false);
                                setBase(remote ?? base);
                                setDraft((remote ?? base).properties);
                                setError("");
                                setStatus("Загружена актуальная версия");
                              }
                            }}
                          >
                            Перечитать
                          </button>
                        )}
                        <button
                          className="primary"
                          onClick={() => void save()}
                          disabled={
                            busy ||
                            !online ||
                            !editable ||
                            !draft.title.trim() ||
                            (!dirty && !creating && !pending)
                          }
                        >
                          {pending ? "Повторить запрос" : "Сохранить"}
                        </button>
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="editor-empty">
                    <span className="large-symbol">▤</span>
                    <h2>Место для общей мысли</h2>
                    <p>
                      Выберите заметку или создайте новую.
                      <br />
                      Ваш выбор остаётся только в этой вкладке.
                    </p>
                  </div>
                )}
              </section>
            </div>
          )}
          {panel === "access" && manager && (
            <section className="card">
              <h2>Участники и права</h2>
              <p className="muted">
                Для заметок нужны чтение, изменение и выполнение. Отзыв
                действует и в уже открытых сессиях.
              </p>
              {rights.map((r) => (
                <div className="permission-row" key={r.actor.id}>
                  <div>
                    <strong>{r.actor.display_name}</strong>
                    <small>
                      {r.actor.kind === "agent"
                        ? "Программный агент · без LLM"
                        : "Человек"}
                    </small>
                  </div>
                  <div className="permissions">
                    {(Object.keys(labels) as Permission[]).map((p) => (
                      <label key={p}>
                        <input
                          type="checkbox"
                          aria-label={`${r.actor.display_name}: ${labels[p]}`}
                          checked={r.actions.includes(p)}
                          disabled={busy || !online}
                          onChange={(e) =>
                            void grant(
                              r.actor.id,
                              e.target.checked
                                ? [...r.actions, p]
                                : r.actions.filter((a) => a !== p),
                            )
                          }
                        />
                        {labels[p]}
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </section>
          )}
          {panel === "audit" && manager && (
            <section className="card">
              <h2>Журнал действий</h2>
              <p className="muted">
                Последние 200 записей. Тексты заметок и секреты не записываются.
                После отказа нажмите «Обновить».
              </p>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Время</th>
                      <th>Участник</th>
                      <th>Действие</th>
                      <th>Результат</th>
                      <th>Запрос</th>
                    </tr>
                  </thead>
                  <tbody>
                    {audit.map((a) => (
                      <tr key={a.id}>
                        <td>{new Date(a.time).toLocaleString("ru-RU")}</td>
                        <td>
                          {rights.find((r) => r.actor.id === a.actor_id)?.actor
                            .display_name ?? a.actor_id}
                        </td>
                        <td>{a.action}</td>
                        <td>{a.result}</td>
                        <td>
                          <code>{a.request_id?.slice(0, 8) ?? "—"}</code>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </main>
      </div>
      <footer>
        Cyberspace / 0.1{" "}
        <span>Независимое пространство · Локальный прототип</span>
      </footer>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
