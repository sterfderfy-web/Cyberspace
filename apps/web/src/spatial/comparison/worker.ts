import { compareText } from "./text.js";
onmessage = (event: MessageEvent<{ a: string; b: string }>) => {
  try {
    postMessage({ rows: compareText(event.data.a, event.data.b) });
  } catch (e) {
    postMessage({ error: (e as Error).message });
  }
};
