import React, { useEffect, useRef, useState } from "react";
import type { DiffRow } from "./text.js";
export default function TextComparison({
  a,
  b,
  draft,
}: {
  a: string;
  b: string;
  draft: boolean;
}) {
  const [result, setResult] = useState<{
      a: string;
      b: string;
      rows?: DiffRow[];
      error?: string;
    } | null>(null),
    left = useRef<HTMLDivElement>(null),
    right = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let worker: Worker | undefined, deadline: ReturnType<typeof setTimeout>;
    const timer = setTimeout(() => {
      worker = new Worker(new URL("./worker.ts", import.meta.url), {
        type: "module",
      });
      deadline = setTimeout(() => {
        worker?.terminate();
        setResult({ a, b, error: "Превышено время сравнения (1 секунда)" });
      }, 1000);
      worker.onmessage = (e) => {
        clearTimeout(deadline);
        setResult({ a, b, ...e.data });
        worker?.terminate();
      };
      worker.onerror = () => {
        clearTimeout(deadline);
        setResult({ a, b, error: "Не удалось выполнить сравнение" });
        worker?.terminate();
      };
      worker.postMessage({ a, b });
    }, 150);
    return () => {
      clearTimeout(timer);
      clearTimeout(deadline);
      worker?.terminate();
    };
  }, [a, b]);
  const current = result?.a === a && result?.b === b ? result : null;
  const sync = (source: HTMLDivElement, target: HTMLDivElement | null) => {
    if (target) {
      target.scrollTop = source.scrollTop;
      target.scrollLeft = source.scrollLeft;
    }
  };
  return (
    <section className="text-comparison" aria-label="Текстовое сравнение">
      <h3>
        Текстовое сравнение ·{" "}
        {draft ? "с учётом личного черновика" : "сохранённые документы"}
      </h3>
      {!current && <p>Вычисление различий…</p>}
      {current?.error && <p role="alert">{current.error}</p>}
      <div className="diff-columns">
        {(["left", "right"] as const).map((side, index) => (
          <div
            key={side}
            ref={index ? right : left}
            className="diff-scroll"
            aria-label={index ? "Различия B" : "Различия A"}
            tabIndex={0}
            onScroll={(e) =>
              sync(e.currentTarget, index ? left.current : right.current)
            }
          >
            {current?.rows?.map((row, i) => (
              <div className={`diff-row ${row.kind}`} key={i}>
                <span className="diff-line">{i + 1}</span>
                <pre>
                  {row[side].map((f, j) => (
                    <span key={j} className={`diff-${f.kind}`}>
                      {f.value.replace(/\n$/, "")}
                    </span>
                  ))}
                  {!row[side].length ? " " : ""}
                </pre>
              </div>
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}
