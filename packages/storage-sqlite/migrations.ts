import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
// Вызывается до любых изменений существующей базы. VACUUM INTO учитывает WAL.
export function prepareMigration(db: DatabaseSync, path: string) {
  const exists = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='migrations'",
    )
    .get();
  const version = exists
    ? Number(
        db.prepare("SELECT MAX(version) AS version FROM migrations").get()
          ?.version ?? 0,
      )
    : 0;
  if (version > 2)
    throw new Error("Версия SQLite новее поддерживаемой; запуск остановлен");
  if (version === 1 && path !== ":memory:") {
    const backup = `${path}.before-v2-${randomUUID()}.sqlite`;
    db.prepare("VACUUM INTO ?").run(backup);
    const check = new DatabaseSync(backup, { readOnly: true });
    try {
      if (check.prepare("PRAGMA quick_check").get()?.quick_check !== "ok")
        throw new Error("Резервная копия SQLite не прошла проверку");
    } finally {
      check.close();
    }
  }
  return version;
}
export function migrateToV2(db: DatabaseSync) {
  const version = Number(
    db.prepare("SELECT MAX(version) AS version FROM migrations").get()
      ?.version ?? 0,
  );
  if (version === 2) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
    CREATE UNIQUE INDEX objects_identity_space ON objects(id,space_id);
    CREATE TABLE scenes(space_id TEXT PRIMARY KEY REFERENCES spaces(id),revision INTEGER NOT NULL DEFAULT 0);
    INSERT INTO scenes(space_id,revision) SELECT id,0 FROM spaces;
    CREATE TABLE views(id TEXT PRIMARY KEY,space_id TEXT NOT NULL REFERENCES spaces(id),object_id TEXT NOT NULL,parent_view_id TEXT,data TEXT NOT NULL,
      UNIQUE(id,space_id),FOREIGN KEY(object_id,space_id) REFERENCES objects(id,space_id),FOREIGN KEY(parent_view_id,space_id) REFERENCES views(id,space_id));
    CREATE INDEX views_space ON views(space_id);
    INSERT INTO migrations(version) VALUES(2);
  `);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
