import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import type { Project, SceneObject, TimelineSample, Vec3 } from '../../shared/types';
import { sampleCamera, sampleObject, sampleTimeline } from '../../shared/timeline';
import { buildObject, disposeBuiltObject, type BuiltObject } from './ObjectFactory';

type ViewMode = 'edit' | 'camera' | 'top';
interface TimeOptions {
  sequenceId?: string;
  shotId?: string;
  sourceTime?: number;
}
interface EngineOptions {
  interactive?: boolean;
  onSelect?: (id: string | null) => void;
  onTransform?: (id: string, patch: { position: Vec3; rotation: Vec3; scale: Vec3 }) => void;
}

function aspectRatio(project: Project | null) {
  return project?.settings.aspect === '9:16' ? 9 / 16 : project?.settings.aspect === '1:1' ? 1 : 16 / 9;
}

export class SceneEngine {
  readonly canvas: HTMLCanvasElement;
  ready: Promise<void> = Promise.resolve();
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly objectGroup = new THREE.Group();
  private readonly helpers = new THREE.Group();
  private readonly cameraHelpers = new THREE.Group();
  private readonly selectionHelpers = new THREE.Group();
  private readonly editorCamera = new THREE.PerspectiveCamera(43, 1, 0.05, 300);
  private readonly shotCamera = new THREE.PerspectiveCamera(43, 16 / 9, 0.025, 300);
  private readonly topCamera = new THREE.OrthographicCamera(-6, 6, 6, -6, 0.05, 300);
  private readonly orbit: OrbitControls;
  private readonly transform: TransformControls;
  private readonly keyLight: THREE.DirectionalLight;
  private readonly ambient: THREE.HemisphereLight;
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly safeOverlay: HTMLDivElement;
  private readonly resizeObserver: ResizeObserver;
  private readonly objects = new Map<string, BuiltObject>();
  private readonly distanceTables = new Map<string, Array<{ time: number; distance: number }>>();
  private project: Project | null = null;
  private mode: ViewMode = 'edit';
  private selected: string[] = [];
  private helpersEnabled = true;
  private safeFrameEnabled = false;
  private width = 1;
  private height = 1;
  private editorFramingScale = 1;
  private generation = 0;
  private destroyed = false;
  private dragging = false;
  private pointerStart: { x: number; y: number } | null = null;
  private time = 0;
  private timeOptions: TimeOptions = {};
  private animationFrame = 0;
  private axisLine: THREE.Line | null = null;
  private lookLines = new THREE.Group();
  private lastSample: TimelineSample | null = null;

  constructor(
    private readonly container: HTMLElement,
    private readonly options: EngineOptions = {},
  ) {
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(options.interactive === false ? 1 : Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.VSMShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.22;
    this.canvas = this.renderer.domElement;
    this.canvas.style.cssText = 'display:block;width:100%;height:100%;outline:none;touch-action:none';
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute('aria-label', '3D 场景视口');
    this.container.append(this.canvas);
    this.scene.background = new THREE.Color('#cfd6d3');
    this.scene.add(this.objectGroup, this.helpers);
    this.helpers.add(this.cameraHelpers, this.selectionHelpers, this.lookLines);
    this.editorCamera.position.set(7.8, 6.4, 9.5);
    this.shotCamera.position.set(0, 2.1, 6.6);
    this.shotCamera.lookAt(0, 1.05, 0);
    this.topCamera.position.set(0, 20, 0);
    this.topCamera.up.set(0, 0, -1);
    this.topCamera.lookAt(0, 0, 0);
    this.orbit = new OrbitControls(this.editorCamera, this.canvas);
    this.orbit.target.set(0, 0.65, 0);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.09;
    this.orbit.minDistance = 0.25;
    this.orbit.maxDistance = 65;
    this.orbit.maxPolarAngle = Math.PI * 0.495;
    this.orbit.enabled = options.interactive !== false;
    this.orbit.update();
    this.transform = new TransformControls(this.editorCamera, this.canvas);
    this.transform.setSize(0.8);
    this.scene.add(this.transform.getHelper());
    this.transform.addEventListener('dragging-changed', (event) => {
      this.dragging = Boolean(event.value);
      this.orbit.enabled = !this.dragging && this.mode !== 'camera' && this.options.interactive !== false;
      if (!this.dragging) this.emitTransform();
    });
    this.transform.addEventListener('objectChange', () => {
      this.refreshSelection();
      this.draw();
    });
    this.transform.addEventListener('change', () => this.draw());
    this.ambient = new THREE.HemisphereLight('#ffffff', '#949f98', 2.0);
    this.keyLight = new THREE.DirectionalLight('#fff9ef', 3.1);
    this.keyLight.position.set(4, 8, 5);
    this.keyLight.castShadow = true;
    this.keyLight.shadow.mapSize.set(2048, 2048);
    Object.assign(this.keyLight.shadow.camera, {
      left: -10,
      right: 10,
      top: 10,
      bottom: -10,
      near: 0.1,
      far: 40,
    });
    this.keyLight.shadow.bias = -0.00015;
    this.keyLight.shadow.normalBias = 0.025;
    this.keyLight.shadow.radius = 4;
    this.keyLight.shadow.blurSamples = 8;
    const fill = new THREE.DirectionalLight('#e8f2f0', 1.25);
    fill.position.set(-6, 4, -1);
    this.scene.add(this.ambient, this.keyLight, fill);
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(200, 200),
      new THREE.MeshStandardMaterial({ color: '#d1d7d3', roughness: 1 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.12;
    ground.receiveShadow = true;
    this.scene.add(ground);
    const grid = new THREE.GridHelper(40, 40, '#a0ada7', '#b9c4bd');
    grid.position.y = 0.003;
    const gridMaterial = grid.material as THREE.Material;
    gridMaterial.transparent = true;
    gridMaterial.opacity = 0.26;
    this.helpers.add(grid);
    const axes = new THREE.AxesHelper(0.65);
    axes.position.set(0, 0.006, 0);
    this.helpers.add(axes);
    this.safeOverlay = document.createElement('div');
    this.safeOverlay.style.cssText =
      'pointer-events:none;position:absolute;display:none;border:1px solid rgba(255,255,255,.45);box-sizing:border-box;z-index:2';
    for (const fraction of [1 / 3, 2 / 3]) {
      const horizontal = document.createElement('div');
      horizontal.style.cssText = `position:absolute;left:0;right:0;top:${fraction * 100}%;border-top:1px dashed rgba(255,255,255,.24)`;
      const vertical = document.createElement('div');
      vertical.style.cssText = `position:absolute;top:0;bottom:0;left:${fraction * 100}%;border-left:1px dashed rgba(255,255,255,.24)`;
      this.safeOverlay.append(horizontal, vertical);
    }
    if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
    container.append(this.safeOverlay);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    if (options.interactive !== false) {
      this.canvas.addEventListener('pointerdown', this.onPointerDown);
      this.canvas.addEventListener('pointerup', this.onPointerUp);
      this.canvas.addEventListener('dblclick', this.onDoubleClick);
    }
    this.resize();
    if (options.interactive !== false) this.animate();
    else this.draw();
  }

  setProject(project: Project): Promise<void> {
    const current = ++this.generation;
    this.project = project;
    this.ready = this.buildProject(project, current);
    return this.ready;
  }

  private async buildProject(project: Project, generation: number) {
    const results = await Promise.allSettled(project.objects.map((object) => buildObject(object)));
    const built = results.map((result) => (result.status === 'fulfilled' ? result.value : null));
    if (generation !== this.generation || this.destroyed) {
      built.forEach((item) => {
        if (item) disposeBuiltObject(item);
      });
      return;
    }
    const failed = results.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') {
      built.forEach((item) => {
        if (item) disposeBuiltObject(item);
      });
      throw failed.reason;
    }
    this.transform.detach();
    this.objects.forEach(disposeBuiltObject);
    this.objects.clear();
    this.distanceTables.clear();
    project.objects.forEach((object, index) => {
      const result = built[index]!;
      this.objects.set(object.id, result);
      this.objectGroup.add(result.root);
      if (object.type === 'actor') this.buildDistanceTable(object);
    });
    const lighting = project.settings.lighting;
    this.ambient.intensity = lighting.ambient * 2;
    this.keyLight.intensity = lighting.intensity * 1.25;
    const azimuth = THREE.MathUtils.degToRad(lighting.azimuth);
    const elevation = THREE.MathUtils.degToRad(lighting.elevation);
    this.keyLight.position.set(
      10 * Math.sin(azimuth) * Math.cos(elevation),
      10 * Math.sin(elevation),
      10 * Math.cos(azimuth) * Math.cos(elevation),
    );
    this.rebuildCameraHelpers();
    this.setTime(this.time, this.timeOptions);
    this.setSelection(this.selected);
    this.resize(this.width, this.height);
  }

  private buildDistanceTable(object: SceneObject) {
    const boundaries = [
      ...new Set([0, ...object.keyframes.filter((key) => key.position || key.action).map((key) => key.time)]),
    ].sort((a, b) => a - b);
    const table = [{ time: 0, distance: 0 }];
    let previous = new THREE.Vector3(...sampleObject(object, 0).position);
    for (let interval = 1; interval < boundaries.length; interval++) {
      const start = boundaries[interval - 1];
      const end = boundaries[interval];
      const samples = Math.min(32, Math.max(2, Math.ceil((end - start) * 24)));
      for (let step = 1; step <= samples; step++) {
        const time = THREE.MathUtils.lerp(start, end, step / samples);
        const sampled = sampleObject(object, time);
        const position = new THREE.Vector3(...sampled.position);
        table.push({ time, distance: table[table.length - 1].distance + previous.distanceTo(position) });
        previous = position;
      }
    }
    this.distanceTables.set(object.id, table);
  }

  setTime(sequenceTime: number, options: TimeOptions = {}) {
    this.time = Math.max(0, sequenceTime);
    this.timeOptions = options;
    if (!this.project || this.destroyed) return;
    const sample = sampleTimeline(this.project, this.time, options.sequenceId);
    if (options.shotId) {
      const shot = this.project.shots.find((item) => item.id === options.shotId);
      if (shot) {
        sample.shot = shot;
        sample.sourceTime = options.sourceTime ?? shot.sourceIn + this.time;
        const camera = this.project.cameras.find((item) => item.id === shot.cameraId);
        sample.camera = camera ? sampleCamera(camera, sample.sourceTime) : null;
      }
    } else if (options.sourceTime !== undefined) {
      sample.sourceTime = options.sourceTime;
      const camera = this.project.cameras.find((item) => item.id === sample.shot?.cameraId);
      sample.camera = camera ? sampleCamera(camera, sample.sourceTime) : null;
    }
    this.lastSample = sample;
    const sampled = new Map<string, SceneObject>();
    for (const object of this.project.objects)
      sampled.set(object.id, sampleObject(object, sample.sourceTime));
    for (const object of sampled.values()) {
      const item = this.objects.get(object.id);
      if (!item) continue;
      const parent = object.parentId ? this.objects.get(object.parentId)?.root : this.objectGroup;
      if (item.root.parent !== parent) (parent || this.objectGroup).add(item.root);
      item.root.position.fromArray(object.position);
      item.root.rotation.set(...(object.rotation.map(THREE.MathUtils.degToRad) as Vec3));
      item.root.scale.fromArray(object.scale);
      item.root.visible =
        object.visible && !(this.mode === 'camera' && sample.shot?.hiddenIds.includes(object.id));
      if (item.rig) {
        const table = this.distanceTables.get(object.id) || [{ time: 0, distance: 0 }];
        let low = 0;
        let high = table.length - 1;
        while (high - low > 1) {
          const middle = Math.floor((low + high) / 2);
          if (table[middle].time > sample.sourceTime) high = middle;
          else low = middle;
        }
        const before = table[low];
        const after = table[high];
        const ratio =
          after.time === before.time
            ? 0
            : THREE.MathUtils.clamp((sample.sourceTime - before.time) / (after.time - before.time), 0, 1);
        const distance =
          table[table.length - 1].distance > 0.001
            ? THREE.MathUtils.lerp(before.distance, after.distance, ratio)
            : sample.sourceTime * (object.actor?.speed ?? 1);
        item.rig.update(object, sample.sourceTime, distance);
      }
      item.mixer?.setTime(sample.sourceTime);
    }
    this.objectGroup.updateMatrixWorld(true);
    for (const object of sampled.values()) {
      if (!object.attachment) continue;
      const item = this.objects.get(object.id);
      const target = this.objects.get(object.attachment.objectId);
      if (!item || !target) continue;
      const parent = target.rig?.getBone(object.attachment.bone) || target.root;
      parent.add(item.root);
      item.root.position.fromArray(object.attachment.offset);
      item.root.rotation.set(...(object.rotation.map(THREE.MathUtils.degToRad) as Vec3));
    }
    this.objectGroup.updateMatrixWorld(true);
    for (const object of sampled.values()) {
      const item = this.objects.get(object.id);
      if (object.actor?.lookAtId && item?.rig) {
        const target = this.objects.get(object.actor.lookAtId);
        if (target) {
          const point = target.rig
            ? target.rig.head.getWorldPosition(new THREE.Vector3())
            : new THREE.Box3().setFromObject(target.root).getCenter(new THREE.Vector3());
          item.rig.lookAt(point, object);
        }
      }
    }
    this.objectGroup.updateMatrixWorld(true);
    if (sample.camera) {
      this.shotCamera.position.fromArray(sample.camera.position);
      this.shotCamera.lookAt(new THREE.Vector3(...sample.camera.target));
      this.shotCamera.fov = sample.camera.fov;
      this.shotCamera.aspect = aspectRatio(this.project);
      this.shotCamera.updateProjectionMatrix();
    }
    this.refreshSelection();
    this.syncTransformTarget();
    this.updateCameraHelpers(sample.sourceTime);
    this.updateDirectorHelpers(sampled);
    this.draw();
  }

  setView(mode: ViewMode) {
    this.mode = mode;
    this.orbit.object = mode === 'top' ? this.topCamera : this.editorCamera;
    this.orbit.enableRotate = mode !== 'top';
    this.orbit.enabled = mode !== 'camera' && this.options.interactive !== false;
    this.transform.camera = this.activeCamera;
    this.updateHelperVisibility();
    this.setTime(this.time, this.timeOptions);
    this.resize(this.width, this.height);
  }

  setSelection(ids: string[]) {
    this.selected = [...ids];
    this.syncTransformTarget();
    this.refreshSelection();
    this.updateHelperVisibility();
    this.draw();
  }

  private syncTransformTarget() {
    let target: THREE.Object3D | undefined;
    if (this.selected.length === 1 && this.options.interactive !== false) {
      const object = this.project?.objects.find((item) => item.id === this.selected[0]);
      if (object && !object.locked && !sampleObject(object, this.lastSample?.sourceTime ?? 0).attachment) {
        target = this.objects.get(object.id)?.root;
      }
    }
    if (this.transform.object !== target) {
      this.transform.detach();
      if (target) this.transform.attach(target);
    }
  }

  setTransformMode(mode: 'translate' | 'rotate' | 'scale') {
    this.transform.setMode(mode);
  }

  setSnap(enabled: boolean) {
    this.transform.setTranslationSnap(enabled ? 0.1 : null);
    this.transform.setRotationSnap(enabled ? Math.PI / 12 : null);
    this.transform.setScaleSnap(enabled ? 0.1 : null);
  }

  setHelpers(enabled: boolean) {
    this.helpersEnabled = enabled;
    this.updateHelperVisibility();
    this.draw();
  }

  setSafeFrame(enabled: boolean) {
    this.safeFrameEnabled = enabled;
    this.updateSafeFrame();
  }

  focus(id?: string) {
    const target = id
      ? this.objects.get(id)?.root
      : this.selected[0]
        ? this.objects.get(this.selected[0])?.root
        : null;
    const bounds = target
      ? new THREE.Box3().setFromObject(target)
      : new THREE.Box3(new THREE.Vector3(-3, 0, -2.5), new THREE.Vector3(3, 2, 2.5));
    if (bounds.isEmpty()) return;
    const center = bounds.getCenter(new THREE.Vector3());
    const size = Math.max(0.7, bounds.getSize(new THREE.Vector3()).length());
    const direction = this.editorCamera.position.clone().sub(this.orbit.target).normalize();
    this.editorCamera.position.copy(center).addScaledVector(direction, size * 1.55);
    this.orbit.target.copy(center);
    if (this.mode === 'top') {
      this.topCamera.position.set(center.x, 20, center.z);
      this.topCamera.zoom = Math.min(6, Math.max(0.4, 9 / size));
      this.topCamera.updateProjectionMatrix();
    }
    this.orbit.update();
    this.draw();
  }

  resize(width?: number, height?: number) {
    this.width = Math.max(1, Math.round(width ?? this.container.clientWidth));
    this.height = Math.max(1, Math.round(height ?? this.container.clientHeight));
    this.renderer.setSize(this.width, this.height, false);
    this.editorCamera.aspect = this.width / this.height;
    const framingScale = Math.max(1, 1.2 / this.editorCamera.aspect);
    this.editorCamera.position
      .sub(this.orbit.target)
      .multiplyScalar(framingScale / this.editorFramingScale)
      .add(this.orbit.target);
    this.editorFramingScale = framingScale;
    this.editorCamera.updateProjectionMatrix();
    const topWidth = 6 * Math.max(1, this.width / this.height);
    const topHeight = 6 * Math.max(1, this.height / this.width);
    this.topCamera.left = -topWidth;
    this.topCamera.right = topWidth;
    this.topCamera.top = topHeight;
    this.topCamera.bottom = -topHeight;
    this.topCamera.updateProjectionMatrix();
    this.updateSafeFrame();
    this.draw();
  }

  capture() {
    this.draw();
    return this.canvas.toDataURL('image/png');
  }

  getEditorCamera(): { position: Vec3; target: Vec3; fov: number } {
    return {
      position: this.editorCamera.position.toArray() as Vec3,
      target: this.orbit.target.toArray() as Vec3,
      fov: this.editorCamera.fov,
    };
  }

  getObjectTarget(id: string): Vec3 | undefined {
    const built = this.objects.get(id);
    if (!built) return undefined;
    built.root.updateWorldMatrix(true, true);
    if (built.rig) {
      const position = built.rig.head.getWorldPosition(new THREE.Vector3());
      const scale = built.rig.root.getWorldScale(new THREE.Vector3());
      position.y -= 0.2 * scale.y;
      return position.toArray() as Vec3;
    }
    const bounds = new THREE.Box3().setFromObject(built.root);
    return (
      bounds.isEmpty()
        ? built.root.getWorldPosition(new THREE.Vector3())
        : bounds.getCenter(new THREE.Vector3())
    ).toArray() as Vec3;
  }

  getFrameRect() {
    if (this.mode !== 'camera') return { x: 0, y: 0, width: this.width, height: this.height };
    const ratio = aspectRatio(this.project);
    const width = Math.min(this.width, this.height * ratio);
    const height = width / ratio;
    return { x: (this.width - width) / 2, y: (this.height - height) / 2, width, height };
  }

  getSample() {
    return this.lastSample;
  }

  private get activeCamera() {
    return this.mode === 'camera'
      ? this.shotCamera
      : this.mode === 'top'
        ? this.topCamera
        : this.editorCamera;
  }

  private updateSafeFrame() {
    const frame = this.getFrameRect();
    const inset = 0.05;
    Object.assign(this.safeOverlay.style, {
      display: this.safeFrameEnabled && this.mode === 'camera' ? 'block' : 'none',
      left: `${frame.x + frame.width * inset}px`,
      top: `${frame.y + frame.height * inset}px`,
      width: `${frame.width * (1 - inset * 2)}px`,
      height: `${frame.height * (1 - inset * 2)}px`,
    });
  }

  private refreshSelection() {
    this.selectionHelpers.children.forEach((item) => {
      if (item instanceof THREE.BoxHelper) {
        item.geometry.dispose();
        (item.material as THREE.Material).dispose();
      }
    });
    this.selectionHelpers.clear();
    for (const id of this.selected) {
      const target = this.objects.get(id);
      if (target) this.selectionHelpers.add(new THREE.BoxHelper(target.root, '#188b76'));
    }
  }

  private rebuildCameraHelpers() {
    this.clearHelpers(this.cameraHelpers);
    if (!this.project) return;
    for (const source of this.project.cameras) {
      const camera = new THREE.PerspectiveCamera(source.fov, aspectRatio(this.project), 0.12, 0.65);
      camera.position.fromArray(source.position);
      camera.lookAt(new THREE.Vector3(...source.target));
      camera.updateMatrixWorld(true);
      const helper = new THREE.CameraHelper(camera);
      helper.setColors(
        new THREE.Color('#587f79'),
        new THREE.Color('#587f79'),
        new THREE.Color('#587f79'),
        new THREE.Color('#88a69e'),
        new THREE.Color('#88a69e'),
      );
      helper.userData.entityId = source.id;
      this.cameraHelpers.add(helper);
      const handle = new THREE.Mesh(
        new THREE.BoxGeometry(0.15, 0.11, 0.18),
        new THREE.MeshBasicMaterial({ color: '#587f79' }),
      );
      handle.position.copy(camera.position);
      handle.quaternion.copy(camera.quaternion);
      handle.userData.entityId = source.id;
      this.cameraHelpers.add(handle);
    }
  }

  private updateCameraHelpers(sourceTime: number) {
    for (const source of this.project?.cameras || []) {
      const sampled = sampleCamera(source, sourceTime);
      for (const helper of this.cameraHelpers.children) {
        if (helper.userData.entityId !== source.id) continue;
        if (helper instanceof THREE.CameraHelper) {
          const camera = helper.camera as THREE.PerspectiveCamera;
          camera.position.fromArray(sampled.position);
          camera.lookAt(new THREE.Vector3(...sampled.target));
          camera.fov = sampled.fov;
          camera.updateProjectionMatrix();
          camera.updateMatrixWorld(true);
          helper.update();
        } else {
          helper.position.fromArray(sampled.position);
          helper.lookAt(new THREE.Vector3(...sampled.target));
        }
      }
    }
  }

  private updateDirectorHelpers(sampled: Map<string, SceneObject>) {
    if (this.axisLine) {
      this.axisLine.geometry.dispose();
      (this.axisLine.material as THREE.Material).dispose();
      this.axisLine.removeFromParent();
      this.axisLine = null;
    }
    const axis = this.project?.settings.axisActorIds || [];
    const points = axis
      .slice(0, 2)
      .map((id) => this.objects.get(id)?.root.getWorldPosition(new THREE.Vector3()));
    if (points.length === 2 && points.every(Boolean)) {
      const a = points[0]!;
      const b = points[1]!;
      a.y = b.y = 0.016;
      const direction = b.clone().sub(a).normalize();
      a.addScaledVector(direction, -1.7);
      b.addScaledVector(direction, 1.7);
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([a, b]),
        new THREE.LineDashedMaterial({
          color: '#b78f58',
          dashSize: 0.16,
          gapSize: 0.08,
          transparent: true,
          opacity: 0.65,
        }),
      );
      line.computeLineDistances();
      this.helpers.add(line);
      this.axisLine = line;
    }
    this.clearHelpers(this.lookLines);
    for (const object of sampled.values()) {
      const rig = this.objects.get(object.id)?.rig;
      if (!rig || !object.actor?.lookAtId) continue;
      const target = this.objects.get(object.actor.lookAtId);
      if (!target) continue;
      const a = rig.head.getWorldPosition(new THREE.Vector3());
      const b =
        target.rig?.head.getWorldPosition(new THREE.Vector3()) ||
        target.root.getWorldPosition(new THREE.Vector3());
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([a, b]),
        new THREE.LineDashedMaterial({
          color: '#94a3a9',
          dashSize: 0.045,
          gapSize: 0.065,
          transparent: true,
          opacity: 0.5,
        }),
      );
      line.computeLineDistances();
      this.lookLines.add(line);
    }
  }

  private clearHelpers(group: THREE.Group) {
    group.traverse((child) => {
      if (child instanceof THREE.Line || child instanceof THREE.Mesh) {
        child.geometry.dispose();
        const materials = Array.isArray(child.material) ? child.material : [child.material];
        materials.forEach((material) => material.dispose());
      }
    });
    group.clear();
  }

  private updateHelperVisibility() {
    const enabled = this.helpersEnabled && this.mode !== 'camera';
    this.helpers.visible = enabled;
    this.transform.getHelper().visible = enabled && this.selected.length === 1;
    this.transform.enabled = enabled && this.options.interactive !== false;
  }

  private emitTransform() {
    const target = this.transform.object;
    if (!target || !target.userData.entityId) return;
    this.options.onTransform?.(target.userData.entityId, {
      position: target.position.toArray() as Vec3,
      rotation: [target.rotation.x, target.rotation.y, target.rotation.z].map(
        THREE.MathUtils.radToDeg,
      ) as Vec3,
      scale: target.scale.toArray() as Vec3,
    });
  }

  private onPointerDown = (event: PointerEvent) => {
    this.pointerStart = { x: event.clientX, y: event.clientY };
  };
  private onPointerUp = (event: PointerEvent) => {
    if (!this.pointerStart || this.dragging || this.transform.axis || event.button !== 0) return;
    if (Math.hypot(event.clientX - this.pointerStart.x, event.clientY - this.pointerStart.y) > 5) return;
    const bounds = this.canvas.getBoundingClientRect();
    const frame = this.getFrameRect();
    this.pointer.set(
      ((event.clientX - bounds.left - frame.x) / frame.width) * 2 - 1,
      -((event.clientY - bounds.top - frame.y) / frame.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointer, this.activeCamera);
    const hits = this.raycaster.intersectObjects(
      [...this.objectGroup.children, ...(this.mode !== 'camera' ? this.cameraHelpers.children : [])],
      true,
    );
    let id: string | null = null;
    for (const hit of hits) {
      let item: THREE.Object3D | null = hit.object;
      let visible = true;
      let candidate: string | null = null;
      while (item) {
        if (!item.visible) visible = false;
        if (item.userData.entityId && !candidate) candidate = item.userData.entityId;
        item = item.parent;
      }
      if (visible) id = candidate;
      if (id) break;
    }
    this.options.onSelect?.(id);
    this.pointerStart = null;
  };
  private onDoubleClick = () => this.focus();

  private animate = () => {
    if (this.destroyed) return;
    this.animationFrame = requestAnimationFrame(this.animate);
    if (this.orbit.enabled && this.orbit.update()) this.draw();
  };

  private draw() {
    if (this.destroyed) return;
    const frame = this.getFrameRect();
    this.renderer.setScissorTest(false);
    this.renderer.setViewport(0, 0, this.width, this.height);
    this.renderer.setClearColor('#1c2623', 1);
    this.renderer.clear();
    this.renderer.setViewport(frame.x, frame.y, frame.width, frame.height);
    this.renderer.setScissor(frame.x, frame.y, frame.width, frame.height);
    this.renderer.setScissorTest(true);
    this.renderer.render(this.scene, this.activeCamera);
    this.renderer.setScissorTest(false);
  }

  dispose() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.generation++;
    cancelAnimationFrame(this.animationFrame);
    this.resizeObserver.disconnect();
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('dblclick', this.onDoubleClick);
    this.orbit.dispose();
    this.transform.dispose();
    this.objects.forEach(disposeBuiltObject);
    this.clearHelpers(this.helpers);
    this.scene.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
        const materials = Array.isArray(child.material) ? child.material : [child.material];
        materials.forEach((material) => material.dispose());
      }
    });
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.canvas.remove();
    this.safeOverlay.remove();
  }
}
