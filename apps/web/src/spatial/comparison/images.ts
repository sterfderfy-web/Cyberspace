// Deterministic local fixtures; no Object, file upload or remote resource protocol.
export function testImage(variant: 0 | 1, width = 320, height = 200) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4,
        box =
          x > (variant ? 115 : 95) &&
          x < (variant ? 225 : 205) &&
          y > 55 &&
          y < 145;
      data[i] = box ? 235 : 24;
      data[i + 1] = box ? (variant ? 125 : 190) : 55;
      data[i + 2] = box ? 65 : 68;
      data[i + 3] = 255;
    }
  return data;
}
export function combineImages(
  a: Uint8ClampedArray,
  b: Uint8ClampedArray,
  mode: "blend" | "difference",
  alpha: number,
) {
  if (a.length !== b.length || a.length % 4)
    throw Error("Размеры изображений должны совпадать");
  const result = new Uint8ClampedArray(a.length);
  for (let i = 0; i < a.length; i++)
    result[i] =
      i % 4 === 3
        ? 255
        : mode === "difference"
          ? Math.abs(a[i] - b[i]) * alpha
          : a[i] * (1 - alpha) + b[i] * alpha;
  return result;
}
