import React, { useEffect, useRef, useState } from "react";
import { testImage, combineImages } from "./images.js";
const a = testImage(0),
  b = testImage(1);
export default function ImageComparison() {
  const canvas = useRef<HTMLCanvasElement>(null),
    [mode, setMode] = useState<"blend" | "difference">("blend"),
    [alpha, setAlpha] = useState(0.5),
    [zoom, setZoom] = useState(1),
    [offset, setOffset] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(
    null,
  );
  useEffect(() => {
    canvas.current
      ?.getContext("2d")
      ?.putImageData(
        new ImageData(combineImages(a, b, mode, alpha), 320, 200),
        0,
        0,
      );
  }, [mode, alpha]);
  return (
    <section
      className="image-comparison"
      aria-label="Сравнение тестовых изображений"
    >
      <h3>Изображения · локальная демонстрация 320 × 200</h3>
      <label>
        Режим изображения
        <select
          aria-label="Режим изображения"
          value={mode}
          onChange={(e) => setMode(e.target.value as typeof mode)}
        >
          <option value="blend">Alpha Blend</option>
          <option value="difference">Difference</option>
        </select>
      </label>
      <label>
        Прозрачность изображения
        <input
          type="range"
          min="0"
          max="1"
          step=".01"
          value={alpha}
          onChange={(e) => setAlpha(Number(e.target.value))}
        />
      </label>
      <label>
        Масштаб изображений
        <input
          type="range"
          min=".5"
          max="4"
          step=".1"
          value={zoom}
          onChange={(e) => setZoom(Number(e.target.value))}
        />
      </label>
      <button
        onClick={() => {
          setZoom(1);
          setOffset({ x: 0, y: 0 });
        }}
      >
        Сбросить изображение
      </button>
      <div
        className="image-stage"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = {
            x: e.clientX,
            y: e.clientY,
            ox: offset.x,
            oy: offset.y,
          };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (d)
            setOffset({ x: d.ox + e.clientX - d.x, y: d.oy + e.clientY - d.y });
        }}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
      >
        <canvas
          aria-label="Результат сравнения изображений"
          ref={canvas}
          width={320}
          height={200}
          style={{
            transform: `translate(${offset.x}px,${offset.y}px) scale(${zoom})`,
          }}
        />
      </div>
      <p>
        Два синтетических изображения вычисляются локально. Данные пространства
        не изменяются.
      </p>
    </section>
  );
}
