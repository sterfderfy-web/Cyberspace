import { diffLines, diffArrays } from "diff";
export interface Fragment {
  value: string;
  kind: "same" | "added" | "removed";
}
export interface DiffRow {
  left: Fragment[];
  right: Fragment[];
  kind: "same" | "changed" | "added" | "removed";
}
export function compareText(a: string, b: string): DiffRow[] {
  if (
    new TextEncoder().encode(a).length > 65536 ||
    new TextEncoder().encode(b).length > 65536
  )
    throw Error("Сравнение ограничено 64 КиБ на документ");
  const parts = diffLines(a, b, { timeout: 250, maxEditLength: 4000 });
  if (!parts)
    throw Error("Слишком сложное сравнение: превышен лимит вычислений");
  const rows: DiffRow[] = [];
  const lines = (s: string) => s.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p.added && !p.removed) {
      for (const line of lines(p.value))
        rows.push({
          left: [{ value: line, kind: "same" }],
          right: [{ value: line, kind: "same" }],
          kind: "same",
        });
      continue;
    }
    const removed = p.removed ? lines(p.value) : [],
      added = p.added
        ? lines(p.value)
        : parts[i + 1]?.added
          ? lines(parts[++i].value)
          : [];
    for (let j = 0; j < Math.max(removed.length, added.length); j++) {
      const l = removed[j] ?? "",
        r = added[j] ?? "";
      const tokenize = (text: string) =>
        text.match(/[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu) ?? [];
      const words =
        l && r
          ? diffArrays(tokenize(l), tokenize(r), {
              timeout: 20,
              maxEditLength: 1000,
            })
          : undefined;
      const left: Fragment[] = [],
        right: Fragment[] = [];
      if (words)
        for (const w of words) {
          if (!w.added)
            left.push({
              value: w.value.join(""),
              kind: w.removed ? "removed" : "same",
            });
          if (!w.removed)
            right.push({
              value: w.value.join(""),
              kind: w.added ? "added" : "same",
            });
        }
      else {
        if (l) left.push({ value: l, kind: "removed" });
        if (r) right.push({ value: r, kind: "added" });
      }
      rows.push({
        left,
        right,
        kind: l && r ? "changed" : l ? "removed" : "added",
      });
    }
  }
  if (rows.length > 4000) throw Error("Сравнение ограничено 4000 строками");
  return rows;
}
