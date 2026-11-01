import type { Transform, Vec3, SpatialView } from "../contracts/spatial.js";
import { DomainError } from "../contracts/modules.js";
export type Matrix = number[]; // Column-major, column vectors. Никаких зависимостей от движка.
export function validateTransform(t: Transform): Transform {
  if (!t || !t.position || !t.scale || !t.rotation)
    throw new DomainError(400, "INVALID_TRANSFORM", "Неполное преобразование");
  for (const axis of ["x", "y", "z"] as const) {
    const v = t.position[axis];
    if (!Number.isFinite(v) || Math.abs(v) > 1e6)
      throw new DomainError(
        400,
        "INVALID_TRANSFORM",
        "Недопустимая координата",
      );
  }
  for (const axis of ["x", "y", "z"] as const) {
    const v = t.scale[axis];
    if (!Number.isFinite(v) || v < 0.001 || v > 1000)
      throw new DomainError(
        400,
        "INVALID_TRANSFORM",
        "Масштаб должен быть от 0.001 до 1000",
      );
  }
  const q = t.rotation,
    n = Math.hypot(q.x, q.y, q.z, q.w);
  if (!Number.isFinite(n) || Math.abs(n - 1) > 0.001)
    throw new DomainError(
      400,
      "INVALID_ROTATION",
      "Quaternion должен иметь единичную длину",
    );
  return {
    ...t,
    position: { ...t.position },
    scale: { ...t.scale },
    rotation: { x: q.x / n, y: q.y / n, z: q.z / n, w: q.w / n },
  };
}
export function localMatrix(t: Transform): Matrix {
  const { x, y, z, w } = t.rotation,
    s = t.scale,
    p = t.position;
  return [
    (1 - 2 * (y * y + z * z)) * s.x,
    2 * (x * y + z * w) * s.x,
    2 * (x * z - y * w) * s.x,
    0,
    2 * (x * y - z * w) * s.y,
    (1 - 2 * (x * x + z * z)) * s.y,
    2 * (y * z + x * w) * s.y,
    0,
    2 * (x * z + y * w) * s.z,
    2 * (y * z - x * w) * s.z,
    (1 - 2 * (x * x + y * y)) * s.z,
    0,
    p.x,
    p.y,
    p.z,
    1,
  ];
}
export function multiply(a: Matrix, b: Matrix): Matrix {
  const r = Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++)
    for (let row = 0; row < 4; row++)
      for (let k = 0; k < 4; k++)
        r[c * 4 + row] += a[k * 4 + row] * b[c * 4 + k];
  return r;
}
export function transformPoint(m: Matrix, p: Vec3): Vec3 {
  return {
    x: m[0] * p.x + m[4] * p.y + m[8] * p.z + m[12],
    y: m[1] * p.x + m[5] * p.y + m[9] * p.z + m[13],
    z: m[2] * p.x + m[6] * p.y + m[10] * p.z + m[14],
  };
}
export function validateHierarchy(views: SpatialView[]) {
  if (views.length > 256)
    throw new DomainError(
      409,
      "SCENE_LIMIT",
      "В сцене допускается до 256 представлений",
    );
  const byId = new Map(views.map((v) => [v.id, v]));
  if (byId.size !== views.length)
    throw new DomainError(400, "DUPLICATE_VIEW", "Повтор идентификатора View");
  for (const start of views) {
    const seen = new Set<string>();
    let v: SpatialView | undefined = start;
    while (v) {
      if (seen.has(v.id))
        throw new DomainError(
          409,
          "HIERARCHY_CYCLE",
          "Цикл в иерархии представлений",
        );
      seen.add(v.id);
      if (seen.size > 32)
        throw new DomainError(
          409,
          "HIERARCHY_DEPTH",
          "Глубина иерархии превышает 32",
        );
      if (v.parent_view_id) {
        const parent = byId.get(v.parent_view_id);
        if (!parent || parent.space_id !== v.space_id)
          throw new DomainError(
            404,
            "PARENT_NOT_FOUND",
            "Родитель недоступен в этой сцене",
          );
        v = parent;
      } else v = undefined;
    }
  }
}
export function worldMatrix(view: SpatialView, views: SpatialView[]): Matrix {
  validateHierarchy(views);
  const byId = new Map(views.map((v) => [v.id, v]));
  const visit = (v: SpatialView): Matrix =>
    v.parent_view_id
      ? multiply(visit(byId.get(v.parent_view_id)!), localMatrix(v.transform))
      : localMatrix(v.transform);
  return visit(view);
}
export function effectiveAppearance(view: SpatialView, views: SpatialView[]) {
  const byId = new Map(views.map((v) => [v.id, v]));
  let v: SpatialView | undefined = view,
    visible = true,
    opacity = 1;
  for (let i = 0; v && i < 32; i++) {
    visible &&= v.visible;
    opacity *= v.opacity;
    v = v.parent_view_id ? byId.get(v.parent_view_id) : undefined;
  }
  return { visible, opacity };
}
