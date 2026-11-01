import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fixture } from "./fixture.js";
import { SqliteRepository } from "../../packages/storage-sqlite/index.js";
import { migrateToV2 } from "../../packages/storage-sqlite/migrations.js";
import {
  identityTransform,
  type SpatialView,
  type ViewInput,
  type Transform,
} from "../../packages/contracts/spatial.js";
import {
  ModuleRegistry,
  type ModuleDefinition,
} from "../../packages/contracts/modules.js";
import {
  validateHierarchy,
  validateTransform,
  worldMatrix,
  transformPoint,
  effectiveAppearance,
} from "../../packages/spatial-runtime/index.js";
import { panelConfigSchema } from "../../packages/module-spatial/index.js";
const viewInput = (object_id: string): ViewInput => ({
  object_id,
  parent_view_id: null,
  renderer_id: "notes.panel",
  renderer_version: 0,
  config: { width_m: 3, height_m: 2 },
  transform: identityTransform(),
  visible: true,
  opacity: 1,
  layer: 0,
  order: 0,
});
const create = (input: ViewInput) => ({
  request_id: randomUUID(),
  module: "spatial",
  action: "create_view",
  input,
});
const update = (v: SpatialView, change: Partial<ViewInput> = {}) => ({
  request_id: randomUUID(),
  module: "spatial",
  action: "update_view",
  view_id: v.id,
  expected_revision: v.revision,
  input: {
    ...viewInput(v.object_id),
    parent_view_id: v.parent_view_id,
    transform: v.transform,
    ...change,
  },
});
function view(id: string, parent: string | null = null): SpatialView {
  return {
    ...viewInput("object"),
    id,
    space_id: "space",
    parent_view_id: parent,
    revision: 1,
    created_at: "now",
    updated_at: "now",
  };
}
test("Runtime: TRS, parent multiplication, inherited appearance, engine independence", () => {
  const parent = view("parent"),
    child = view("child", "parent");
  parent.transform.position.x = 10;
  parent.transform.rotation = { x: 0, y: 0, z: Math.SQRT1_2, w: Math.SQRT1_2 };
  parent.transform.scale = { x: 2, y: 2, z: 2 };
  child.transform.position.x = 3;
  const point = transformPoint(worldMatrix(child, [child, parent]), {
    x: 0,
    y: 0,
    z: 0,
  });
  assert.ok(Math.abs(point.x - 10) < 1e-10);
  assert.ok(Math.abs(point.y - 6) < 1e-10);
  assert.equal(point.z, 0);
  parent.visible = false;
  parent.opacity = 0.5;
  child.opacity = 0.4;
  assert.deepEqual(effectiveAppearance(child, [child, parent]), {
    visible: false,
    opacity: 0.2,
  });
  const near = identityTransform();
  near.rotation.w = 1.0001;
  assert.equal(validateTransform(near).rotation.w, 1);
  assert.equal(near.rotation.w, 1.0001);
  for (const n of [NaN, Infinity, -Infinity, 1e7]) {
    const t = identityTransform();
    t.position.x = n;
    assert.throws(() => validateTransform(t));
  }
  for (const n of [0, -1, 1001, NaN]) {
    const t = identityTransform();
    t.scale.z = n;
    assert.throws(() => validateTransform(t));
  }
  const missing = identityTransform();
  delete (missing.position as Partial<Transform["position"]>).x;
  assert.throws(() => validateTransform(missing));
  const bad = identityTransform();
  bad.rotation.w = 0;
  assert.throws(() => validateTransform(bad));
  assert.throws(() => validateHierarchy([view("a", "b"), view("b", "a")]));
  assert.throws(() => validateHierarchy([view("a", "missing")]));
  assert.throws(() => validateHierarchy([view("a"), view("a")]));
  assert.throws(() =>
    validateHierarchy(
      Array.from({ length: 33 }, (_, i) =>
        view(String(i), i ? String(i - 1) : null),
      ),
    ),
  );
  assert.throws(() =>
    validateHierarchy(Array.from({ length: 257 }, (_, i) => view(String(i)))),
  );
  assert.throws(() =>
    validateHierarchy([view("a", "b"), { ...view("b"), space_id: "foreign" }]),
  );
});
test("Spatial API: independent Views, validation, CAS, dedup, ACL, restart and legacy compatibility", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const path = `/spaces/${f.space.id}/actions`;
  const note = (await f.request(f.owner, "POST", path, f.command())).json()
    .object;
  const body = create(viewInput(note.id)),
    first = await f.request(f.owner, "POST", path, body);
  assert.equal(first.statusCode, 200, first.body);
  const a: SpatialView = first.json().view;
  assert.deepEqual(
    (await f.request(f.owner, "POST", path, body)).json(),
    first.json(),
  );
  assert.equal(f.server.repo.views(f.space.id).length, 1);
  const b: SpatialView = (
    await f.request(
      f.owner,
      "POST",
      path,
      create({ ...viewInput(note.id), renderer_id: "notes.summary" }),
    )
  ).json().view;
  assert.notEqual(a.id, b.id);
  const next = structuredClone(a.transform);
  next.position = { x: 5, y: -3, z: 2 };
  next.scale = { x: 2, y: 3, z: 1 };
  const moved = await f.request(
    f.owner,
    "POST",
    path,
    update(a, { transform: next }),
  );
  assert.equal(moved.statusCode, 200, moved.body);
  assert.equal(moved.json().view.revision, 2);
  assert.deepEqual(f.server.repo.object(note.id), note);
  assert.deepEqual(f.server.repo.view(b.id), b);
  assert.equal(
    (await f.request(f.owner, "POST", path, update(a))).statusCode,
    409,
  );
  assert.equal(
    (
      await f.request(f.owner, "POST", path, {
        ...body,
        input: { ...body.input, opacity: 0.5 },
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (await f.request(f.member, "POST", path, create(viewInput(note.id))))
      .statusCode,
    403,
  );
  assert.equal(
    (await f.request(null, "GET", `/spaces/${f.space.id}/scene`)).statusCode,
    401,
  );
  for (const change of [
    { opacity: 2 },
    { layer: 0.5 },
    { config: { width_m: 0, height_m: 1 } },
    { renderer_id: "unknown" },
    {
      transform: {
        ...identityTransform(),
        rotation: { x: 0, y: 0, z: 0, w: 0 },
      },
    },
    { transform: { ...identityTransform(), position: { x: 1e9, y: 0, z: 0 } } },
  ])
    assert.equal(
      (
        await f.request(
          f.owner,
          "POST",
          path,
          create({ ...viewInput(note.id), ...change }),
        )
      ).statusCode,
      400,
    );
  assert.equal(
    (
      await f.request(
        f.owner,
        "POST",
        path,
        create({ ...viewInput(note.id), parent_view_id: randomUUID() }),
      )
    ).statusCode,
    404,
  );
  const nested = await f.request(
    f.owner,
    "POST",
    path,
    update(b, { parent_view_id: a.id }),
  );
  assert.equal(nested.statusCode, 200, nested.body);
  assert.equal(
    (
      await f.request(
        f.owner,
        "POST",
        path,
        update(moved.json().view, { parent_view_id: b.id }),
      )
    ).statusCode,
    409,
  );
  assert.equal(
    (
      await f.request(f.owner, "POST", path, {
        request_id: randomUUID(),
        module: "spatial",
        action: "delete_view",
        view_id: a.id,
        expected_revision: 2,
      })
    ).statusCode,
    409,
  );
  const foreign = { ...f.space, id: randomUUID() };
  f.server.repo.saveSpace(foreign);
  f.server.repo.grant(foreign.id, f.owner.id, ["read", "write", "execute"]);
  assert.equal(
    (
      await f.request(
        f.owner,
        "POST",
        `/spaces/${foreign.id}/actions`,
        create(viewInput(note.id)),
      )
    ).statusCode,
    404,
  );
  const other = (
    await f.request(f.owner, "POST", path, f.command("Other"))
  ).json().object;
  assert.equal(
    (
      await f.request(
        f.owner,
        "POST",
        path,
        update(moved.json().view, { object_id: other.id }),
      )
    ).statusCode,
    400,
  );
  const scene = (
    await f.request(f.owner, "GET", `/spaces/${f.space.id}/scene`)
  ).json();
  assert.equal(scene.views.length, 2);
  assert.equal(scene.scene_revision, 4);
  assert.equal(
    (await f.request(f.owner, "GET", `/spaces/${f.space.id}`)).json().objects
      .length,
    2,
  );
  assert.equal(
    (await f.request(f.owner, "GET", `/spaces/${f.space.id}/export`))
      .statusCode,
    200,
  );
  await f.stop();
  await f.restart();
  assert.deepEqual(
    (await f.request(f.owner, "GET", `/spaces/${f.space.id}/scene`)).json(),
    scene,
  );
  await f.grant(f.member, []);
  assert.equal(
    (await f.request(f.member, "GET", `/spaces/${f.space.id}/scene`))
      .statusCode,
    404,
  );
  assert.equal(
    (
      await f.request(f.owner, "POST", path, {
        request_id: randomUUID(),
        module: "spatial",
        action: "delete_view",
        view_id: b.id,
        expected_revision: 2,
      })
    ).statusCode,
    200,
  );
  assert.deepEqual(f.server.repo.object(note.id), note);
  assert.ok(
    f.server.repo
      .audits(f.space.id)
      .some(
        (a) =>
          a.action === "spatial.update_view" &&
          a.result === "REVISION_CONFLICT",
      ),
  );
  assert.equal(
    f.server.repo.db.prepare("PRAGMA foreign_key_check").all().length,
    0,
  );
});
test("Extension: new object type/action/renderer with no Core changes", async (t) => {
  const module: ModuleDefinition = {
    id: "test-marker",
    version: 0,
    dependencies: ["notes"],
    request_schema: {
      type: "object",
      additionalProperties: false,
      required: ["request_id", "module", "action"],
      properties: {
        request_id: { type: "string", format: "uuid" },
        module: { const: "test-marker" },
        action: { const: "create" },
      },
    },
    actions: {
      create: {
        required_permissions: ["write", "execute"],
        execute: (_, ctx) => {
          const object = {
            id: ctx.newId(),
            space_id: ctx.spaceId,
            type: "marker",
            schema_version: 0,
            properties: { value: 42 },
            revision: 1,
            created_at: ctx.now,
            updated_at: ctx.now,
          };
          ctx.saveObject(object);
          return { object };
        },
      },
    },
  };
  assert.throws(() => new ModuleRegistry([module]));
  assert.throws(() => new ModuleRegistry([module, module]));
  const f = await fixture({
    extraModules: [module],
    extraRenderers: [
      {
        id: "test.marker",
        version: 0,
        name: "Marker",
        object_types: ["marker"],
        required_capabilities: ["3d"],
        config_schema: panelConfigSchema,
      },
    ],
  });
  t.after(() => f.close());
  const path = `/spaces/${f.space.id}/actions`,
    response = await f.request(f.owner, "POST", path, {
      request_id: randomUUID(),
      module: "test-marker",
      action: "create",
    });
  assert.equal(response.statusCode, 200, response.body);
  const object = response.json().object;
  assert.equal(
    (
      await f.request(
        f.owner,
        "POST",
        path,
        create({ ...viewInput(object.id), renderer_id: "test.marker" }),
      )
    ).statusCode,
    200,
  );
  assert.equal(
    (await f.request(f.owner, "GET", `/spaces/${f.space.id}/scene`)).json()
      .objects[0].type,
    "marker",
  );
  assert.deepEqual(
    (await f.request(f.owner, "GET", `/spaces/${f.space.id}`)).json().objects,
    [],
  );
  assert.equal(
    (await f.request(f.owner, "POST", path, create(viewInput(object.id))))
      .statusCode,
    400,
  );
  const declarations = await f.request(
    f.owner,
    "GET",
    `/spaces/${f.space.id}/modules`,
  );
  assert.equal(declarations.statusCode, 200);
  assert.ok(
    (await f.request(f.owner, "GET", `/spaces/${f.space.id}/renderers`))
      .json()
      .some((r: { id: string }) => r.id === "test.marker"),
  );
});
test("SQLite v1 → v2: verified backup, all old rows preserved, idempotent restart, reject future schema", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  await f.request(
    f.owner,
    "POST",
    `/spaces/${f.space.id}/actions`,
    f.command(),
  );
  const tables = [
    "actors",
    "spaces",
    "objects",
    "permissions",
    "sessions",
    "requests",
    "events",
    "audit",
  ];
  const before = Object.fromEntries(
    tables.map((name) => [
      name,
      f.server.repo.db.prepare(`SELECT * FROM ${name}`).all(),
    ]),
  );
  await f.stop();
  const old = new DatabaseSync(f.config.db);
  old.exec(
    "DROP TABLE views; DROP TABLE scenes; DROP INDEX objects_identity_space; DELETE FROM migrations WHERE version=2;",
  );
  old.close();
  await f.restart();
  const backups = readdirSync(f.dir).filter((n) => n.includes(".before-v2-"));
  assert.equal(backups.length, 1);
  const backup = new DatabaseSync(join(f.dir, backups[0]), { readOnly: true });
  try {
    assert.equal(backup.prepare("PRAGMA quick_check").get()?.quick_check, "ok");
    assert.equal(
      backup.prepare("SELECT MAX(version) v FROM migrations").get()?.v,
      1,
    );
    for (const name of tables)
      assert.deepEqual(
        backup.prepare(`SELECT * FROM ${name}`).all(),
        before[name],
      );
  } finally {
    backup.close();
  }
  for (const name of tables)
    assert.deepEqual(
      f.server.repo.db.prepare(`SELECT * FROM ${name}`).all(),
      before[name],
    );
  assert.equal(f.server.repo.sceneRevision(f.space.id), 0);
  assert.deepEqual(f.server.repo.views(f.space.id), []);
  assert.equal((await f.login(f.owner)).statusCode, 200);
  await f.stop();
  await f.restart();
  assert.equal(
    readdirSync(f.dir).filter((n) => n.includes(".before-v2-")).length,
    1,
  );
  const future = join(f.dir, "future.sqlite");
  const db = new DatabaseSync(future);
  db.exec(
    "CREATE TABLE migrations(version INTEGER);INSERT INTO migrations VALUES(99)",
  );
  db.close();
  assert.throws(() => new SqliteRepository(future), /новее/);
});
test("Migration failure rolls back schema and version", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      "CREATE TABLE migrations(version INTEGER);INSERT INTO migrations VALUES(1);CREATE TABLE objects(id TEXT,space_id TEXT);CREATE TABLE spaces(id TEXT);CREATE TABLE views(id TEXT)",
    );
    assert.throws(() => migrateToV2(db));
    assert.equal(
      db.prepare("SELECT MAX(version) v FROM migrations").get()?.v,
      1,
    );
    assert.equal(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name IN ('scenes','objects_identity_space')",
        )
        .all().length,
      0,
    );
  } finally {
    db.close();
  }
});
