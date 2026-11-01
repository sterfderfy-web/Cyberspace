import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  createHash,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import type { Repository } from "../core/index.js";
import { prepareMigration, migrateToV2 } from "./migrations.js";
import type { SpatialView } from "../contracts/spatial.js";
import type {
  Actor,
  Audit,
  SpaceObject,
  Permission,
  Session,
  Space,
} from "../contracts/index.js";
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const parse = <T>(row: unknown): T | undefined =>
  row ? (JSON.parse((row as { data: string }).data) as T) : undefined;
export class SqliteRepository implements Repository {
  db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    try {
      prepareMigration(this.db, path);
    } catch (e) {
      this.db.close();
      throw e;
    }
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS actors(id TEXT PRIMARY KEY, data TEXT NOT NULL, salt TEXT NOT NULL, secret_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS spaces(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS objects(id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id), data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS objects_space ON objects(space_id);
      CREATE TABLE IF NOT EXISTS permissions(space_id TEXT NOT NULL REFERENCES spaces(id), actor_id TEXT NOT NULL REFERENCES actors(id), data TEXT NOT NULL, PRIMARY KEY(space_id,actor_id));
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, actor_id TEXT NOT NULL REFERENCES actors(id), token_hash TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL, revoked_at INTEGER);
      CREATE TABLE IF NOT EXISTS requests(actor_id TEXT NOT NULL, scope TEXT NOT NULL, id TEXT NOT NULL, hash TEXT NOT NULL, data TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY(actor_id,scope,id));
      CREATE TABLE IF NOT EXISTS events(space_id TEXT NOT NULL REFERENCES spaces(id), cursor INTEGER NOT NULL, PRIMARY KEY(space_id,cursor));
      CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT, space_id TEXT, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS audit_space ON audit(space_id,id);
      INSERT OR IGNORE INTO migrations(version) VALUES(1);`);
    try {
      migrateToV2(this.db);
    } catch (e) {
      this.db.close();
      throw e;
    }
  }
  close() {
    this.db.close();
  }
  transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  space(id: string) {
    return parse<Space>(
      this.db.prepare("SELECT data FROM spaces WHERE id=?").get(id),
    );
  }
  spaces() {
    return this.db
      .prepare("SELECT data FROM spaces ORDER BY rowid")
      .all()
      .map((r) => parse<Space>(r)!);
  }
  saveSpace(s: Space) {
    this.db
      .prepare(
        "INSERT INTO spaces VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(s.id, JSON.stringify(s));
  }
  objects(id: string) {
    return this.db
      .prepare("SELECT data FROM objects WHERE space_id=? ORDER BY rowid")
      .all(id)
      .map((r) => parse<SpaceObject>(r)!);
  }
  object(id: string) {
    return parse<SpaceObject>(
      this.db.prepare("SELECT data FROM objects WHERE id=?").get(id),
    );
  }
  saveObject(n: SpaceObject) {
    this.db
      .prepare(
        "INSERT INTO objects VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(n.id, n.space_id, JSON.stringify(n));
  }
  views(space: string) {
    return this.db
      .prepare("SELECT data FROM views WHERE space_id=? ORDER BY rowid")
      .all(space)
      .map((r) => parse<SpatialView>(r)!);
  }
  view(id: string) {
    return parse<SpatialView>(
      this.db.prepare("SELECT data FROM views WHERE id=?").get(id),
    );
  }
  saveView(v: SpatialView) {
    this.db
      .prepare(
        "INSERT INTO views VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET parent_view_id=excluded.parent_view_id,data=excluded.data",
      )
      .run(v.id, v.space_id, v.object_id, v.parent_view_id, JSON.stringify(v));
  }
  deleteView(id: string) {
    this.db.prepare("DELETE FROM views WHERE id=?").run(id);
  }
  sceneRevision(space: string) {
    return Number(
      this.db.prepare("SELECT revision FROM scenes WHERE space_id=?").get(space)
        ?.revision ?? 0,
    );
  }
  bumpScene(space: string) {
    this.db
      .prepare(
        "INSERT INTO scenes VALUES(?,1) ON CONFLICT(space_id) DO UPDATE SET revision=revision+1",
      )
      .run(space);
    return this.sceneRevision(space);
  }
  actor(id: string) {
    return parse<Actor>(
      this.db.prepare("SELECT data FROM actors WHERE id=?").get(id),
    );
  }
  actors() {
    return this.db
      .prepare("SELECT data FROM actors ORDER BY rowid")
      .all()
      .map((r) => parse<Actor>(r)!);
  }
  createActor(kind: Actor["kind"], name: string, owner = false) {
    const actor: Actor = {
      id: randomUUID(),
      kind,
      display_name: name,
      instance_owner: owner,
      disabled: false,
    };
    const secret = randomBytes(24).toString("base64url"),
      salt = randomBytes(16).toString("hex");
    const hash = scryptSync(secret, salt, 64).toString("hex");
    this.db
      .prepare("INSERT INTO actors VALUES(?,?,?,?)")
      .run(actor.id, JSON.stringify(actor), salt, hash);
    return { ...actor, secret };
  }
  verifySecret(id: string, secret: string) {
    const row = this.db
      .prepare("SELECT salt,secret_hash FROM actors WHERE id=?")
      .get(id) as { salt: string; secret_hash: string } | undefined;
    const computed = scryptSync(secret, row?.salt ?? "unknown-actor", 64);
    return (
      !!row &&
      timingSafeEqual(computed, Buffer.from(row.secret_hash, "hex")) &&
      !this.actor(id)?.disabled
    );
  }
  newSession(actorId: string) {
    const token = randomBytes(32).toString("base64url");
    const session: Session = {
      id: randomUUID(),
      actor_id: actorId,
      expires_at: Date.now() + 8 * 3600_000,
      revoked_at: null,
    };
    this.db
      .prepare("DELETE FROM sessions WHERE expires_at < ?")
      .run(Date.now());
    this.db
      .prepare("INSERT INTO sessions VALUES(?,?,?,?,NULL)")
      .run(session.id, actorId, digest(token), session.expires_at);
    return { token, session };
  }
  session(token: string): Session | undefined {
    return this.db
      .prepare(
        "SELECT id,actor_id,expires_at,revoked_at FROM sessions WHERE token_hash=?",
      )
      .get(digest(token)) as unknown as Session | undefined;
  }
  revoke(id: string) {
    this.db
      .prepare("UPDATE sessions SET revoked_at=? WHERE id=?")
      .run(Date.now(), id);
  }
  rights(space: string, actor: string): Permission[] {
    return (
      parse<Permission[]>(
        this.db
          .prepare(
            "SELECT data FROM permissions WHERE space_id=? AND actor_id=?",
          )
          .get(space, actor),
      ) ?? []
    );
  }
  grant(space: string, actor: string, actions: Permission[]) {
    this.db
      .prepare(
        "INSERT INTO permissions VALUES(?,?,?) ON CONFLICT(space_id,actor_id) DO UPDATE SET data=excluded.data",
      )
      .run(space, actor, JSON.stringify(actions));
  }
  request(actor: string, scope: string, id: string) {
    const row = this.db
      .prepare(
        "SELECT hash,data FROM requests WHERE actor_id=? AND scope=? AND id=? AND expires_at>?",
      )
      .get(actor, scope, id, Date.now()) as
      { hash: string; data: string } | undefined;
    return row
      ? { hash: row.hash, result: JSON.parse(row.data) as unknown }
      : undefined;
  }
  saveRequest(
    actor: string,
    scope: string,
    id: string,
    hash: string,
    result: unknown,
  ) {
    this.db
      .prepare("DELETE FROM requests WHERE expires_at <= ?")
      .run(Date.now());
    this.db
      .prepare("INSERT INTO requests VALUES(?,?,?,?,?,?)")
      .run(
        actor,
        scope,
        id,
        hash,
        JSON.stringify(result),
        Date.now() + 86400_000,
      );
  }
  audit(entry: Audit) {
    // Отказы ограничены одной записью в секунду для Actor/Space/Action/Result.
    if (entry.result !== "OK") {
      const last = this.db
        .prepare(
          "SELECT data FROM audit WHERE space_id IS ? ORDER BY id DESC LIMIT 1",
        )
        .get(entry.space_id);
      const prior = parse<Audit>(last);
      if (
        prior &&
        prior.actor_id === entry.actor_id &&
        prior.action === entry.action &&
        prior.result === entry.result &&
        Date.parse(entry.time) - Date.parse(prior.time) < 1000
      )
        return;
    }
    this.db
      .prepare("INSERT INTO audit(space_id,data) VALUES(?,?)")
      .run(entry.space_id, JSON.stringify(entry));
  }
  audits(space: string) {
    return this.db
      .prepare(
        "SELECT id,data FROM audit WHERE space_id=? ORDER BY id DESC LIMIT 200",
      )
      .all(space)
      .map((r) => ({ ...parse<Audit>(r)!, id: Number(r.id) }));
  }
  event(space: Space) {
    this.db
      .prepare("INSERT INTO events VALUES(?,?)")
      .run(space.id, space.revision);
  }
}
