import * as THREE from "three";
// CSS coordinates (top-left, Y down) → local plane → clip → viewport.
// Homogeneous W preserves perspective, including rotated/scaled parents.
export function panelProjection(
  world: THREE.Matrix4,
  camera: THREE.Camera,
  width: number,
  height: number,
  widthM: number,
  heightM: number,
) {
  const pixelWidth = 640,
    pixelHeight = (640 * heightM) / widthM;
  const local = new THREE.Matrix4().set(
    widthM / pixelWidth,
    0,
    0,
    -widthM / 2,
    0,
    -heightM / pixelHeight,
    0,
    heightM / 2,
    0,
    0,
    1,
    0,
    0,
    0,
    0,
    1,
  );
  const clip = new THREE.Matrix4()
    .multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
    .multiply(world)
    .multiply(local);
  const viewport = new THREE.Matrix4().set(
    width / 2,
    0,
    0,
    width / 2,
    0,
    -height / 2,
    0,
    height / 2,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    1,
  );
  const css = viewport.multiply(clip);
  // Keep the unused CSS Z axis invertible. A singular matrix has correct XY
  // coordinates but browsers cannot paint or hit-test its DOM subtree.
  css.elements[8] = 0;
  css.elements[9] = 0;
  css.elements[10] = 1;
  css.elements[11] = 0;
  const corners = [
    [0, 0],
    [pixelWidth, 0],
    [pixelWidth, pixelHeight],
    [0, pixelHeight],
  ].map(([x, y]) => new THREE.Vector4(x, y, 0, 1).applyMatrix4(clip));
  const visible =
    corners.every((p) => p.w > 0.001) &&
    !corners.every((p) => p.z < -p.w) &&
    !corners.every((p) => p.z > p.w);
  return {
    transform: `matrix3d(${css.elements.join(",")})`,
    width: pixelWidth,
    height: pixelHeight,
    visible,
  };
}
