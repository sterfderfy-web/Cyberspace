import * as THREE from "three";
import type { SpaceObject } from "../../../../packages/contracts/index.js";
import type { SpatialView } from "../../../../packages/contracts/spatial.js";
// Контракт исполнения относится только к Web-адаптеру. Ядро видит лишь дескрипторы.
export interface WebVisualizer {
  id: string;
  version: number;
  create: (
    object: Readonly<SpaceObject>,
    view: Readonly<SpatialView>,
  ) => THREE.Mesh;
}
function textLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxLines: number,
) {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/)) {
      if (ctx.measureText(line + " " + word).width > maxWidth && line) {
        lines.push(line);
        line = word;
      } else line += (line ? " " : "") + word;
      if (lines.length >= maxLines) return lines;
    }
    lines.push(line);
    if (lines.length >= maxLines) return lines;
  }
  return lines;
}
function panel(
  object: Readonly<SpaceObject>,
  view: Readonly<SpatialView>,
  summary: boolean,
) {
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = 640;
  const c = canvas.getContext("2d")!;
  c.fillStyle = summary ? "#163e45" : "#f8f8f0";
  c.fillRect(0, 0, 1024, 640);
  c.fillStyle = summary ? "#b7f1d3" : "#1c725c";
  c.fillRect(0, 0, 1024, 10);
  c.font = "18px system-ui";
  c.fillText(
    summary ? "СВОДКА / АЛЬТЕРНАТИВНЫЙ ВИД" : "ДОКУМЕНТ / ИСХОДНЫЕ ДАННЫЕ",
    40,
    55,
  );
  c.fillStyle = summary ? "#f0f7eb" : "#173e3f";
  c.font = "bold 40px system-ui";
  textLines(c, String(object.properties.title ?? object.type), 940, 2).forEach(
    (line, i) => c.fillText(line, 40, 125 + i * 50),
  );
  c.font = summary ? "30px system-ui" : "27px system-ui";
  c.fillStyle = summary ? "#b7d5ce" : "#44615b";
  const text = String(object.properties.text ?? "");
  textLines(c, text, 940, summary ? 5 : 9).forEach((line, i) =>
    c.fillText(line, 40, 245 + i * 36),
  );
  c.font = "18px system-ui";
  c.fillStyle = summary ? "#a1c2b7" : "#6d8073";
  c.fillText(
    summary
      ? `${text.length} символов · ревизия данных ${object.revision}`
      : `Ревизия данных ${object.revision} · редактирование через «Открыть документ»`,
    40,
    600,
  );
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    side: THREE.DoubleSide,
    transparent: true,
    depthWrite: false,
  });
  return new THREE.Mesh(
    new THREE.PlaneGeometry(
      Number(view.config.width_m),
      Number(view.config.height_m),
    ),
    material,
  );
}
export const webVisualizers: WebVisualizer[] = [
  { id: "notes.panel", version: 0, create: (o, v) => panel(o, v, false) },
  { id: "notes.summary", version: 0, create: (o, v) => panel(o, v, true) },
];
export class VisualizerRegistry {
  private entries = new Map<string, WebVisualizer>();
  constructor(entries: WebVisualizer[]) {
    for (const entry of entries) {
      const key = entry.id + ":" + entry.version;
      if (this.entries.has(key)) throw new Error("Повтор визуализатора");
      this.entries.set(key, entry);
    }
  }
  create(object: SpaceObject, view: SpatialView) {
    return this.entries
      .get(view.renderer_id + ":" + view.renderer_version)
      ?.create(
        Object.freeze(structuredClone(object)),
        Object.freeze(structuredClone(view)),
      );
  }
}
