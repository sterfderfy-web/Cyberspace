import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { compareText } from "../../apps/web/src/spatial/comparison/text.js";
import {
  testImage,
  combineImages,
} from "../../apps/web/src/spatial/comparison/images.js";
import { panelProjection } from "../../apps/web/src/spatial/projection.js";
test("Text comparison: insert/delete/changed fragments, Cyrillic, whitespace and limits", () => {
  const rows = compareText(
    "Общий\nСтарый текст\nУдалён\n",
    "Общий\nНовый текст\nДобавлен\n",
  );
  assert.equal(rows[0].kind, "same");
  assert.ok(
    rows.some((r) =>
      r.left.some((f) => f.kind === "removed" && f.value.includes("Старый")),
    ),
  );
  assert.ok(
    rows.some((r) =>
      r.right.some((f) => f.kind === "added" && f.value.includes("Новый")),
    ),
  );
  for (const [a, b] of [
    ["", "a\n"],
    ["a\n", ""],
    ["x\n\ny", "x\ny"],
    ["a b\n", "a  b\n"],
    ["😀 привет", "😀 пока"],
  ]) {
    const diff = compareText(a, b);
    assert.equal(
      diff
        .flatMap((r) => r.left)
        .map((f) => f.value)
        .join(""),
      a,
    );
    assert.equal(
      diff
        .flatMap((r) => r.right)
        .map((f) => f.value)
        .join(""),
      b,
    );
  }
  assert.throws(() => compareText("a".repeat(65537), ""), /64/);
  assert.throws(
    () => compareText("x\n".repeat(4001), "x\n".repeat(4001)),
    /4000/,
  );
});
test("Image comparison: exact pixels, identical images, alpha endpoints, no source mutation", () => {
  const a = testImage(0),
    b = testImage(1),
    saved = a.slice();
  assert.deepEqual(combineImages(a, b, "blend", 0), a);
  assert.deepEqual(combineImages(a, b, "blend", 1), b);
  const identical = combineImages(a, a, "difference", 1);
  assert.equal(identical[0], 0);
  assert.equal(identical[3], 255);
  const difference = combineImages(a, b, "difference", 1);
  assert.ok(difference.some((v, i) => i % 4 !== 3 && v > 0));
  assert.deepEqual(a, saved);
  assert.throws(() => combineImages(a, b.slice(4), "blend", 0.5));
});
test("DOM projection: perspective, rotation, scale and parent world matrix align with WebGL", () => {
  const camera = new THREE.PerspectiveCamera(45, 1.5, 0.01, 1000);
  camera.position.set(1, 2, 12);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  const parent = new THREE.Matrix4().compose(
    new THREE.Vector3(2, -1, 1),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(0.2, 0.5, 0.3)),
    new THREE.Vector3(1.5, 0.8, 1),
  );
  const child = new THREE.Matrix4().makeTranslation(-1, 2, 0);
  const world = parent.multiply(child),
    p = panelProjection(world, camera, 900, 600, 4, 2);
  assert.ok(p.visible);
  const values = p.transform.slice(9, -1).split(",").map(Number),
    matrix = new THREE.Matrix4().fromArray(values);
  for (const [x, y] of [
    [0, 0],
    [640, 0],
    [640, 320],
    [0, 320],
    [320, 160],
  ]) {
    const css = new THREE.Vector4(x, y, 0, 1).applyMatrix4(matrix);
    const projected = new THREE.Vector3((x / 640) * 4 - 2, 1 - (y / 320) * 2, 0)
      .applyMatrix4(world)
      .project(camera);
    assert.ok(Math.abs(css.x / css.w - (projected.x + 1) * 450) < 1e-8);
    assert.ok(Math.abs(css.y / css.w - (1 - projected.y) * 300) < 1e-8);
  }
  assert.equal(
    panelProjection(
      new THREE.Matrix4().makeTranslation(0, 0, 30),
      camera,
      900,
      600,
      4,
      2,
    ).visible,
    false,
  );
});
