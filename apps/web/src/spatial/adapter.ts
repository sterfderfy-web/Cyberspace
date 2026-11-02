import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type {
  ObserverState,
  SceneSnapshot,
  SpatialView,
  Transform,
  Vec3,
} from "../../../../packages/contracts/spatial.js";
import {
  worldMatrix,
  localMatrix,
  effectiveAppearance,
} from "../../../../packages/spatial-runtime/index.js";
import {
  VisualizerRegistry,
  webVisualizers,
  visualResources,
  type VisualInstance,
} from "./renderers.js";
import { panelProjection } from "./projection.js";
export type InteractionMode = "select" | "pan" | "orbit" | "edit" | "scale";
export interface ComparisonPlacement {
  a: string;
  b: string;
  alpha: number;
  show: "both" | "a" | "b";
}
export interface SceneEntry {
  scene: SceneSnapshot;
  offset: Vec3;
}
export class SpatialAdapter {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(45, 1, 0.001, 1e8);
  private controls: OrbitControls;
  private registry = new VisualizerRegistry(webVisualizers);
  private meshes: THREE.Mesh[] = [];
  private instances = new Map<
    string,
    { renderer: string; visual: VisualInstance }
  >();
  private panels = new Map<string, HTMLElement>();
  private comparison: ComparisonPlacement | null = null;
  private entries: SceneEntry[] = [];
  private resize: ResizeObserver;
  private selected: string | null = null;
  private mode: InteractionMode = "select";
  private stopped = false;
  private needsFrame = true;
  private drag?: {
    view: SpatialView;
    mesh: THREE.Mesh;
    plane: THREE.Plane;
    start: THREE.Vector3;
    origin: THREE.Vector3;
    parent: THREE.Matrix4;
    pointer: number;
    moved: boolean;
    transform: Transform;
    startX: number;
    originals: { mesh: THREE.Mesh; matrix: THREE.Matrix4 }[];
  };
  private ray = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private frame = 0;
  private frameStats = { rendered: 0 };
  private grid = new THREE.GridHelper(200, 100, 0x24575a, 0x1b363d);
  constructor(
    private host: HTMLElement,
    observer: ObserverState | undefined,
    private callbacks: {
      select: (view: SpatialView) => void;
      move: (view: SpatialView, transform: Transform) => void;
      observe: (state: ObserverState) => void;
      error: (message: string) => void;
    },
  ) {
    // A counter for reproducible browser measurements; no DOM mutations per frame.
    Object.defineProperty(host, "spatialFrameStats", {
      value: this.frameStats,
      configurable: true,
    });
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setClearColor(0x10272e);
    host.appendChild(this.renderer.domElement);
    this.renderer.domElement.setAttribute(
      "aria-label",
      "Пространственная сцена",
    );
    this.renderer.domElement.setAttribute("tabindex", "0");
    this.camera.position.set(0, 0, 12);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = false;
    this.controls.minDistance = 0.02;
    this.controls.maxDistance = 1e6;
    this.controls.zoomToCursor = true;
    if (observer) {
      this.camera.position.copy(observer.position);
      this.controls.target.copy(observer.target);
    }
    this.controls.update();
    this.setMode("select");
    this.grid.rotation.x = Math.PI / 2;
    this.grid.position.z = -0.03;
    this.scene.add(this.grid);
    (this.grid.material as THREE.Material).dispose();
    this.grid.material = new THREE.LineBasicMaterial({
      color: 0x27505a,
      transparent: true,
      opacity: 0.4,
      depthWrite: false,
    });
    this.controls.addEventListener("change", () => {
      this.needsFrame = true;
      this.callbacks.observe(this.observer());
    });
    this.controls.addEventListener("end", () =>
      this.callbacks.observe(this.observer()),
    );
    const canvas = this.renderer.domElement;
    canvas.addEventListener("pointerdown", this.down, true);
    canvas.addEventListener("pointermove", this.move, true);
    canvas.addEventListener("pointerup", this.up, true);
    canvas.addEventListener("pointercancel", this.cancel, true);
    canvas.addEventListener("webglcontextlost", this.contextLost);
    this.resize = new ResizeObserver(() => {
      const r = host.getBoundingClientRect();
      this.camera.aspect = r.width / Math.max(r.height, 1);
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(r.width, r.height);
      this.needsFrame = true;
    });
    this.resize.observe(host);
    const tick = () => {
      if (this.stopped) return;
      if (this.needsFrame) {
        this.projectPanels();
        this.renderer.render(this.scene, this.camera);
        this.frameStats.rendered++;
        this.needsFrame = false;
      }
      this.frame = requestAnimationFrame(tick);
    };
    tick();
  }
  private contextLost = (e: Event) => {
    e.preventDefault();
    this.callbacks.error(
      "Графический контекст потерян. Сохранённая сцена доступна; обновите страницу для восстановления графики.",
    );
  };
  observer(): ObserverState {
    return {
      position: {
        x: this.camera.position.x,
        y: this.camera.position.y,
        z: this.camera.position.z,
      },
      target: {
        x: this.controls.target.x,
        y: this.controls.target.y,
        z: this.controls.target.z,
      },
      selected_view_id: this.selected,
    };
  }
  setMode(mode: InteractionMode) {
    this.cancel();
    this.mode = mode;
    this.controls.enableRotate = mode === "orbit";
    this.controls.mouseButtons.LEFT =
      mode === "orbit" ? THREE.MOUSE.ROTATE : THREE.MOUSE.PAN;
    this.controls.touches.ONE =
      mode === "orbit" ? THREE.TOUCH.ROTATE : THREE.TOUCH.PAN;
  }
  private disposeMeshes() {
    for (const { visual } of this.instances.values()) {
      this.scene.remove(visual.mesh);
      visual.dispose();
    }
    this.instances.clear();
    this.meshes = [];
  }
  select(id: string | null) {
    this.selected = id;
    for (const mesh of this.meshes)
      (mesh.material as THREE.MeshBasicMaterial).color.set(
        mesh.userData.view.id === id ? 0xc4ffe6 : 0xffffff,
      );
    this.needsFrame = true;
  }
  update(
    entries: SceneEntry[],
    excluded: string[],
    selected: string | null,
    canEdit: (space: string) => boolean,
  ) {
    this.cancel();
    this.entries = entries;
    this.selected = selected;
    const retained = new Set<string>();
    for (const entry of entries)
      for (const view of entry.scene.views) {
        if (excluded.includes(view.id)) continue;
        const object = entry.scene.objects.find((o) => o.id === view.object_id);
        if (!object) continue;
        retained.add(view.id);
        const renderer = view.renderer_id + ":" + view.renderer_version;
        let instance = this.instances.get(view.id);
        if (instance?.renderer !== renderer) {
          if (instance) {
            this.scene.remove(instance.visual.mesh);
            instance.visual.dispose();
            this.instances.delete(view.id);
          }
          const visual = this.registry.create(object, view);
          if (!visual) continue;
          instance = { renderer, visual };
          this.instances.set(view.id, instance);
          this.scene.add(visual.mesh);
        } else instance.visual.update(object, view);
        const mesh = instance.visual.mesh;
        const appearance = effectiveAppearance(view, entry.scene.views);
        mesh.visible = appearance.visible;
        mesh.matrixAutoUpdate = false;
        mesh.matrix.fromArray(worldMatrix(view, entry.scene.views));
        mesh.matrix.premultiply(
          new THREE.Matrix4().makeTranslation(
            entry.offset.x,
            entry.offset.y,
            entry.offset.z,
          ),
        );
        const material = mesh.material as THREE.MeshBasicMaterial;
        material.opacity = appearance.opacity;
        material.color.set(view.id === selected ? 0xc4ffe6 : 0xffffff);
        mesh.renderOrder = view.layer * 20001 + view.order;
        mesh.userData = {
          view,
          entry,
          canEdit: canEdit(view.space_id),
          baseMatrix: mesh.matrix.clone(),
          appearance,
        };
      }
    for (const [id, { visual }] of this.instances)
      if (!retained.has(id)) {
        this.scene.remove(visual.mesh);
        visual.dispose();
        this.instances.delete(id);
      }
    this.meshes = [...this.instances.values()].map((i) => i.visual.mesh);
    this.applyComparison();
    this.scene.updateMatrixWorld(true);
    this.host.dataset.resources = JSON.stringify({
      ...visualResources,
      live: this.instances.size,
    });
    this.needsFrame = true;
  }
  private point(e: PointerEvent) {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(
      ((e.clientX - r.left) / r.width) * 2 - 1,
      (-(e.clientY - r.top) / r.height) * 2 + 1,
    );
    this.ray.setFromCamera(this.pointer, this.camera);
  }
  private down = (e: PointerEvent) => {
    if (this.drag) return;
    if (!["select", "scale"].includes(this.mode) || e.button !== 0) return;
    this.point(e);
    const hits = this.ray
      .intersectObjects(this.meshes)
      .filter((h) => h.object.visible);
    if (!hits.length) return;
    // depth-test сохраняет геометрию; order разрешает наложение в одной плоскости.
    const nearest = hits[0].distance,
      hit = hits
        .filter((h) => Math.abs(h.distance - nearest) < 0.0001)
        .sort((a, b) => b.object.renderOrder - a.object.renderOrder)[0];
    const mesh = hit.object as THREE.Mesh,
      { view, entry, canEdit } = mesh.userData as {
        view: SpatialView;
        entry: SceneEntry;
        canEdit: boolean;
      };
    e.stopImmediatePropagation();
    this.controls.enabled = false;
    this.renderer.domElement.setPointerCapture(e.pointerId);
    if (
      canEdit &&
      view.id !== this.comparison?.a &&
      view.id !== this.comparison?.b
    ) {
      const normal = this.camera.getWorldDirection(new THREE.Vector3()),
        parent = new THREE.Matrix4().makeTranslation(
          entry.offset.x,
          entry.offset.y,
          entry.offset.z,
        );
      if (view.parent_view_id) {
        const p = entry.scene.views.find((v) => v.id === view.parent_view_id)!;
        parent.multiply(
          new THREE.Matrix4().fromArray(worldMatrix(p, entry.scene.views)),
        );
      }
      this.drag = {
        view,
        mesh,
        plane: new THREE.Plane().setFromNormalAndCoplanarPoint(
          normal,
          hit.point,
        ),
        start: hit.point.clone(),
        origin: new THREE.Vector3().setFromMatrixPosition(mesh.matrix),
        parent,
        pointer: e.pointerId,
        moved: false,
        transform: structuredClone(view.transform),
        startX: e.clientX,
        originals: this.meshes
          .filter((candidate) => {
            let v: SpatialView | undefined = candidate.userData.view;
            if (v?.space_id !== view.space_id) return false;
            while (v) {
              if (v.id === view.id) return true;
              v = entry.scene.views.find(
                (parent) => parent.id === v!.parent_view_id,
              );
            }
            return false;
          })
          .map((mesh) => ({ mesh, matrix: mesh.matrix.clone() })),
      };
    }
    this.selected = view.id;
    this.callbacks.select(view);
  };
  private move = (e: PointerEvent) => {
    const d = this.drag;
    if (!d || e.pointerId !== d.pointer) return;
    e.stopImmediatePropagation();
    if (this.mode === "scale") {
      const factor = Math.exp((e.clientX - d.startX) * 0.005),
        original = d.view.transform.scale;
      d.transform.scale = {
        x: Math.min(1000, Math.max(0.001, original.x * factor)),
        y: Math.min(1000, Math.max(0.001, original.y * factor)),
        z: Math.min(1000, Math.max(0.001, original.z * factor)),
      };
      const next = d.parent
          .clone()
          .multiply(new THREE.Matrix4().fromArray(localMatrix(d.transform))),
        change = next.multiply(
          d.originals
            .find((o) => o.mesh === d.mesh)!
            .matrix.clone()
            .invert(),
        );
      for (const o of d.originals)
        o.mesh.matrix.copy(o.matrix).premultiply(change);
      d.moved = true;
      this.needsFrame = true;
      return;
    }
    this.point(e);
    const p = this.ray.ray.intersectPlane(d.plane, new THREE.Vector3());
    if (!p) return;
    const delta = p.sub(d.start);
    if (delta.length() < 0.001) return;
    d.moved = true;
    const world = d.origin.clone().add(delta),
      local = world.clone().applyMatrix4(d.parent.clone().invert());
    d.transform.position = { x: local.x, y: local.y, z: local.z };
    for (const original of d.originals) {
      original.mesh.matrix.copy(original.matrix);
      original.mesh.matrix.setPosition(
        new THREE.Vector3().setFromMatrixPosition(original.matrix).add(delta),
      );
    }
    this.needsFrame = true;
  };
  private up = (e: PointerEvent) => {
    const d = this.drag;
    if (d && e.pointerId !== d.pointer) return;
    this.drag = undefined;
    this.controls.enabled = true;
    if (this.renderer.domElement.hasPointerCapture(e.pointerId))
      this.renderer.domElement.releasePointerCapture(e.pointerId);
    if (d) {
      e.stopImmediatePropagation();
      if (d.moved) this.callbacks.move(d.view, d.transform);
    }
  };
  private cancel = () => {
    if (this.drag) {
      for (const original of this.drag.originals)
        original.mesh.matrix.copy(original.matrix);
      if (this.renderer.domElement.hasPointerCapture(this.drag.pointer))
        this.renderer.domElement.releasePointerCapture(this.drag.pointer);
      this.drag = undefined;
    }
    this.controls.enabled = true;
    this.needsFrame = true;
  };
  zoom(factor: number) {
    this.camera.position
      .sub(this.controls.target)
      .multiplyScalar(factor)
      .add(this.controls.target);
    this.controls.update();
    this.needsFrame = true;
  }
  bindPanel(id: string, element: HTMLElement | null) {
    if (element) this.panels.set(id, element);
    else this.panels.delete(id);
    const mesh = this.instances.get(id)?.visual.mesh;
    if (mesh) (mesh.material as THREE.Material).visible = !element;
    this.needsFrame = true;
  }
  setComparison(value: ComparisonPlacement | null) {
    this.cancel();
    this.comparison = value;
    this.applyComparison();
    this.needsFrame = true;
  }
  private applyComparison() {
    for (const mesh of this.meshes) {
      mesh.matrix.copy(mesh.userData.baseMatrix);
      mesh.visible = mesh.userData.appearance.visible;
      mesh.renderOrder =
        mesh.userData.view.layer * 20001 + mesh.userData.view.order;
      (mesh.material as THREE.MeshBasicMaterial).opacity =
        mesh.userData.appearance.opacity;
    }
    const c = this.comparison;
    if (!c) return;
    const a = this.instances.get(c.a)?.visual.mesh,
      b = this.instances.get(c.b)?.visual.mesh;
    if (!a || !b) return;
    const av = a.userData.view as SpatialView,
      bv = b.userData.view as SpatialView;
    b.matrix
      .copy(a.matrix)
      .multiply(
        new THREE.Matrix4().makeScale(
          Number(av.config.width_m) / Number(bv.config.width_m),
          Number(av.config.height_m) / Number(bv.config.height_m),
          1,
        ),
      );
    a.visible &&= c.show !== "b";
    b.visible &&= c.show !== "a";
    (b.material as THREE.MeshBasicMaterial).opacity =
      c.show === "b" ? 1 : c.alpha;
    b.renderOrder = a.renderOrder + 1;
  }
  private projectPanels() {
    this.camera.updateMatrixWorld();
    const ordered = [...this.meshes].sort(
      (a, b) =>
        a.renderOrder - b.renderOrder ||
        new THREE.Vector3()
          .setFromMatrixPosition(b.matrix)
          .distanceToSquared(this.camera.position) -
          new THREE.Vector3()
            .setFromMatrixPosition(a.matrix)
            .distanceToSquared(this.camera.position),
    );
    for (const [id, node] of this.panels) {
      const mesh = this.instances.get(id)?.visual.mesh;
      if (!mesh) {
        node.hidden = true;
        continue;
      }
      const view = mesh.userData.view as SpatialView;
      const p = panelProjection(
        mesh.matrix,
        this.camera,
        this.host.clientWidth,
        this.host.clientHeight,
        Number(view.config.width_m),
        Number(view.config.height_m),
      );
      node.hidden = !mesh.visible || !p.visible;
      node.style.width = p.width + "px";
      node.style.height = p.height + "px";
      node.style.transform = p.transform;
      node.style.opacity = String(
        (mesh.material as THREE.MeshBasicMaterial).opacity,
      );
      node.style.zIndex = String(ordered.indexOf(mesh) + 1);
      (mesh.material as THREE.Material).visible = false;
    }
  }
  pan(x: number, y: number) {
    const distance = this.camera.position.distanceTo(this.controls.target),
      shift = new THREE.Vector3(
        x * distance * 0.1,
        y * distance * 0.1,
        0,
      ).applyQuaternion(this.camera.quaternion);
    this.camera.position.add(shift);
    this.controls.target.add(shift);
    this.controls.update();
  }
  front() {
    const distance = this.camera.position.distanceTo(this.controls.target);
    this.camera.position
      .copy(this.controls.target)
      .add(new THREE.Vector3(0, 0, distance));
    this.camera.up.set(0, 1, 0);
    this.controls.update();
  }
  fit() {
    const box = new THREE.Box3();
    for (const mesh of this.meshes) if (mesh.visible) box.expandByObject(mesh);
    if (box.isEmpty()) {
      this.controls.target.set(0, 0, 0);
      this.camera.position.set(0, 0, 12);
    } else {
      const center = box.getCenter(new THREE.Vector3()),
        size = box.getSize(new THREE.Vector3());
      const distance =
        (Math.max(size.y, size.x / this.camera.aspect, size.z, 0.1) /
          (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)))) *
        1.35;
      this.controls.target.copy(center);
      this.camera.position.copy(center).add(new THREE.Vector3(0, 0, distance));
    }
    this.controls.update();
    this.needsFrame = true;
  }
  placement(offset: Vec3) {
    const width =
      this.camera.position.distanceTo(this.controls.target) *
      2 *
      Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) *
      0.45;
    return {
      position: {
        x: this.controls.target.x - offset.x,
        y: this.controls.target.y - offset.y,
        z: this.controls.target.z - offset.z,
      },
      width: Math.min(10000, Math.max(0.001, width)),
      height: Math.min(10000, Math.max(0.001, width / 1.6)),
    };
  }
  dispose() {
    this.stopped = true;
    cancelAnimationFrame(this.frame);
    this.resize.disconnect();
    const c = this.renderer.domElement;
    c.removeEventListener("pointerdown", this.down, true);
    c.removeEventListener("pointermove", this.move, true);
    c.removeEventListener("pointerup", this.up, true);
    c.removeEventListener("pointercancel", this.cancel, true);
    c.removeEventListener("webglcontextlost", this.contextLost);
    this.controls.dispose();
    this.disposeMeshes();
    this.panels.clear();
    this.host.dataset.resources = JSON.stringify({
      ...visualResources,
      live: 0,
    });
    this.grid.geometry.dispose();
    (this.grid.material as THREE.Material).dispose();
    this.renderer.dispose();
    c.remove();
  }
}
