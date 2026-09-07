import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import type { Project, SceneObject, TimelineSample, Vec3 } from '../../shared/types';
import { sampleCamera, sampleObject, sampleTimeline } from '../../shared/timeline';
import type { BuiltObject } from './ObjectFactory';
import type { ActorConstraintResult } from '../../shared/actor-animation';
import { applyActorConstraints } from './ActorConstraints';
import { CameraOpticsRenderer } from './CameraOpticsRenderer';
import { fitPerspectiveObservation, fitTopObservation } from './ObservationFraming';
import { sceneFarPlane } from '../../shared/scene-framing';
import { resolveLighting } from '../../shared/lighting-plans';
import { sampleSequenceOpacity, sampleSequenceTransition } from '../../shared/transitions';
import { TransitionRenderer } from './TransitionRenderer';
import { gaitDistance, SceneResourceCache, type SceneBinding, type SceneResources } from './SceneResources';

type ViewMode = 'edit' | 'camera' | 'top';
interface TimeOptions {
  sequenceId?: string;
  shotId?: string;
  sourceTime?: number;
}
interface EngineOptions {
  interactive?: boolean;
  onSelect?: (id: string | null, additive?: boolean) => void;
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
  private opticsRenderer: CameraOpticsRenderer | null = null;
  private transitionRenderer: TransitionRenderer | null = null;
  private drawing = false;
  private readonly topCamera = new THREE.OrthographicCamera(-6, 6, 6, -6, 0.05, 300);
  private readonly editorOrbit: OrbitControls;
  private readonly topOrbit: OrbitControls;
  private readonly transform: TransformControls;
  private readonly keyLight: THREE.DirectionalLight;
  private readonly ambient: THREE.HemisphereLight;
  private readonly ground: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>;
  private readonly lightDirection = new THREE.Vector3(4, 8, 5).normalize();
  private sceneBounds = new THREE.Box3();
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly safeOverlay: HTMLDivElement;
  private readonly resizeObserver: ResizeObserver;
  private objects = new Map<string, BuiltObject>();
  private readonly resourceCache = new SceneResourceCache();
  private resources: SceneResources | null = null;
  private binding: SceneBinding | null = null;
  private pendingBuild: AbortController | null = null;
  private projectLoading = false;
  private project: Project | null = null;
  private mode: ViewMode = 'edit';
  private selected: string[] = [];
  private helpersEnabled = true;
  private safeFrameEnabled = false;
  private width = 1;
  private height = 1;
  private editorFramingScale = 1;
  private editorFocusBounds: THREE.Box3 | null = null;
  private topFocusBounds: THREE.Box3 | null = null;
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
  private constraintResults = new Map<string, ActorConstraintResult[]>();

  constructor(
    private readonly container: HTMLElement,
    private readonly options: EngineOptions = {},
  ) {
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      preserveDrawingBuffer: true,
      logarithmicDepthBuffer: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(options.interactive === false ? 1 : Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
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
    this.editorOrbit = new OrbitControls(this.editorCamera, this.canvas);
    this.topOrbit = new OrbitControls(this.topCamera, this.canvas);
    this.topOrbit.enableRotate = false;
    this.topOrbit.enableDamping = true;
    this.topOrbit.dampingFactor = 0.09;
    this.topOrbit.enabled = false;
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
    this.scene.add(this.ambient, this.keyLight, this.keyLight.target, fill);
    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshStandardMaterial({ color: '#d1d7d3', roughness: 1 }),
    );
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.position.y = -0.12;
    this.ground.scale.set(200, 200, 1);
    this.ground.receiveShadow = true;
    this.scene.add(this.ground);
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
    this.editorOrbit.addEventListener('change', () => this.draw());
    this.topOrbit.addEventListener('change', () => this.draw());
    this.resize();
    if (options.interactive !== false) this.animate();
    else this.draw();
  }

  setProject(project: Project): Promise<void> {
    const current = ++this.generation;
    this.pendingBuild?.abort();
    const controller = new AbortController();
    this.pendingBuild = controller;
    this.projectLoading = true;
    this.transform.detach();
    this.refreshSelection();
    this.ready = this.buildProject(project, current, controller.signal);
    return this.ready;
  }

  private async buildProject(project: Project, generation: number, signal: AbortSignal) {
    const resources = await this.resourceCache.prepare(project, signal);
    if (!resources) return;
    if (generation !== this.generation || this.destroyed) return resources.release();
    this.transform.detach();
    this.detachResourceRoots();
    this.resources?.release();
    this.resources = resources;
    this.binding = null;
    this.project = project;
    this.projectLoading = false;
    this.pendingBuild = null;
    this.rebuildCameraHelpers();
    this.setTime(this.time, this.timeOptions);
    this.setSelection(this.selected);
    this.resize(this.width, this.height);
  }

  private detachResourceRoots() {
    for (const binding of this.resources?.bindings ?? [])
      for (const object of binding.objects.values()) object.root.removeFromParent();
    this.objectGroup.clear();
  }

  private activateBinding(binding: SceneBinding) {
    if (this.binding === binding) return;
    this.transform.detach();
    for (const object of this.objects.values()) object.root.removeFromParent();
    this.objectGroup.clear();
    this.binding = binding;
    this.objects = binding.objects;
    for (const object of this.objects.values()) this.objectGroup.add(object.root);
    const environment = binding.project.settings.environment;
    this.scene.background = new THREE.Color(environment?.background ?? '#cfd6d3');
    this.ground.visible = environment?.ground ?? true;
    this.ground.material.color.set(environment?.groundTone ?? '#d1d7d3');
  }

  setTime(sequenceTime: number, options: TimeOptions = {}) {
    this.time = Math.max(0, sequenceTime);
    this.timeOptions = options;
    if (!this.project || !this.resources || this.destroyed) return;
    const sample = sampleTimeline(this.project, this.time, options.sequenceId);
    if (options.shotId) {
      const shot = this.project.shots.find((item) => item.id === options.shotId);
      if (shot) {
        sample.shot = shot;
        sample.sourceTime = options.sourceTime ?? shot.sourceIn + this.time;
        sample.cameraTime = sample.sourceTime;
        const camera = this.project.cameras.find((item) => item.id === shot.cameraId);
        sample.camera = camera ? sampleCamera(camera, sample.sourceTime, this.project.settings.aspect) : null;
      }
    } else if (options.sourceTime !== undefined) {
      sample.sourceTime = options.sourceTime;
      sample.cameraTime = options.sourceTime;
      const camera = this.project.cameras.find((item) => item.id === sample.shot?.cameraId);
      sample.camera = camera ? sampleCamera(camera, sample.sourceTime, this.project.settings.aspect) : null;
    }
    this.applySample(sample);
    this.draw();
  }

  private applySample(sample: TimelineSample) {
    if (!this.project || !this.resources) return;
    this.lastSample = sample;
    const binding =
      this.mode === 'camera' && sample.shot
        ? (this.resources.shots.get(sample.shot.id) ?? this.resources.workspace)
        : this.resources.workspace;
    this.activateBinding(binding);
    const lighting = resolveLighting(this.project, this.mode === 'camera' ? sample.shot : null);
    this.ambient.intensity = lighting.ambient * 2;
    this.keyLight.intensity = lighting.intensity * 1.25;
    const azimuth = THREE.MathUtils.degToRad(lighting.azimuth);
    const elevation = THREE.MathUtils.degToRad(lighting.elevation);
    this.keyLight.position.set(
      10 * Math.sin(azimuth) * Math.cos(elevation),
      10 * Math.sin(elevation),
      10 * Math.cos(azimuth) * Math.cos(elevation),
    );
    this.lightDirection.copy(this.keyLight.position).normalize();
    const sampled = new Map<string, SceneObject>();
    for (const object of binding.project.objects)
      sampled.set(object.id, sampleObject(object, sample.sourceTime, { render: true }));
    for (const object of sampled.values()) {
      const item = this.objects.get(object.id);
      if (!item) continue;
      item.root.name = object.name;
      const parent = object.parentId ? this.objects.get(object.parentId)?.root : this.objectGroup;
      if (item.root.parent !== parent) (parent || this.objectGroup).add(item.root);
      item.root.position.fromArray(object.position);
      item.root.rotation.set(...(object.rotation.map(THREE.MathUtils.degToRad) as Vec3));
      item.root.scale.fromArray(object.scale);
      item.root.visible =
        object.visible && !(this.mode === 'camera' && sample.shot?.hiddenIds.includes(object.id));
      if (item.rig) {
        const distance = gaitDistance(
          binding.distances.get(object.id),
          sample.sourceTime,
          object.actor?.speed ?? 1,
        );
        item.rig.update(object, sample.sourceTime, distance);
      }
      if (item.vehicleRig) {
        const source = binding.project.objects.find((candidate) => candidate.id === object.id)!;
        item.vehicleRig.update(
          source,
          sample.sourceTime,
          gaitDistance(binding.distances.get(object.id), sample.sourceTime, 0),
        );
      }
      item.effectRig?.update(object, sample.sourceTime);
      item.morphRig?.reset();
      item.mixer?.setTime(sample.sourceTime);
      item.morphRig?.update(object.morph, sample.sourceTime);
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
    this.constraintResults = applyActorConstraints(sampled, this.objects, sample.sourceTime);
    this.objectGroup.updateMatrixWorld(true);
    this.sceneBounds.setFromObject(this.objectGroup);
    const extent = this.sceneBounds.isEmpty()
      ? 200
      : Math.max(
          200,
          ...this.sceneBounds.min.toArray().map(Math.abs),
          ...this.sceneBounds.max.toArray().map(Math.abs),
        ) * 4;
    this.ground.scale.set(extent, extent, 1);
    if (sample.camera) {
      this.shotCamera.position.fromArray(sample.camera.position);
      this.shotCamera.lookAt(new THREE.Vector3(...sample.camera.target));
      this.shotCamera.fov = sample.camera.fov;
      this.shotCamera.aspect = aspectRatio(this.project);
      this.shotCamera.far = sceneFarPlane(this.shotCamera.position, this.sceneBounds);
      this.shotCamera.updateProjectionMatrix();
    }
    this.refreshSelection();
    this.syncTransformTarget();
    this.updateCameraHelpers(sample.cameraTime);
    this.updateDirectorHelpers(sampled);
  }

  setView(mode: ViewMode) {
    if (mode !== this.mode) this.settleObservationControls();
    this.orbit.enabled = false;
    this.mode = mode;
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
    if (this.canEditBinding && this.selected.length === 1 && this.options.interactive !== false) {
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
    const ids = id ? [id] : this.selected;
    const bounds = new THREE.Box3();
    if (ids.length) {
      for (const objectId of ids) {
        const root = this.objects.get(objectId)?.root;
        if (!root) continue;
        root.updateWorldMatrix(true, true);
        bounds.expandByObject(root);
      }
    } else {
      this.objectGroup.updateWorldMatrix(true, true);
      bounds.setFromObject(this.objectGroup);
      if (bounds.isEmpty()) bounds.set(new THREE.Vector3(-3, 0, -2.5), new THREE.Vector3(3, 2, 2.5));
    }
    if (bounds.isEmpty()) return;
    this.settleObservationControls();
    if (this.mode === 'top') {
      const fit = fitTopObservation(bounds, this.topCamera);
      this.topCamera.position.copy(fit.position);
      this.topCamera.zoom = fit.zoom;
      this.topOrbit.target.copy(fit.center);
      this.topFocusBounds = bounds;
      this.topCamera.updateProjectionMatrix();
    } else {
      const fit = fitPerspectiveObservation(bounds, this.editorCamera, this.editorOrbit.target);
      this.editorCamera.position.copy(fit.position);
      this.editorOrbit.target.copy(fit.center);
      this.editorFocusBounds = bounds;
    }
    this.updateObservationLimits();
    this.orbit.update();
    this.draw();
  }

  private get orbit() {
    return this.mode === 'top' ? this.topOrbit : this.editorOrbit;
  }

  private settleObservationControls() {
    const damping = this.orbit.enableDamping;
    this.orbit.enableDamping = false;
    this.orbit.update();
    this.orbit.enableDamping = damping;
  }

  private updateObservationLimits() {
    this.editorOrbit.maxDistance = Math.max(
      65,
      this.editorCamera.position.distanceTo(this.editorOrbit.target) * 4,
    );
    this.topOrbit.maxDistance = Math.max(65, this.topCamera.position.distanceTo(this.topOrbit.target) * 4);
  }

  resize(width?: number, height?: number) {
    const previousFit = this.editorFocusBounds
      ? fitPerspectiveObservation(this.editorFocusBounds, this.editorCamera, this.editorOrbit.target).distance
      : null;
    const previousTopFit = this.topFocusBounds
      ? fitTopObservation(this.topFocusBounds, this.topCamera).zoom
      : null;
    this.width = Math.max(1, Math.round(width ?? this.container.clientWidth));
    this.height = Math.max(1, Math.round(height ?? this.container.clientHeight));
    this.renderer.setSize(this.width, this.height, false);
    this.editorCamera.aspect = this.width / this.height;
    const framingScale = Math.max(1, 1.2 / this.editorCamera.aspect);
    const scale =
      this.editorFocusBounds && previousFit
        ? fitPerspectiveObservation(this.editorFocusBounds, this.editorCamera, this.editorOrbit.target)
            .distance / previousFit
        : framingScale / this.editorFramingScale;
    this.editorCamera.position
      .sub(this.editorOrbit.target)
      .multiplyScalar(scale)
      .add(this.editorOrbit.target);
    this.editorFramingScale = framingScale;
    this.editorCamera.updateProjectionMatrix();
    const topWidth = 6 * Math.max(1, this.width / this.height);
    const topHeight = 6 * Math.max(1, this.height / this.width);
    this.topCamera.left = -topWidth;
    this.topCamera.right = topWidth;
    this.topCamera.top = topHeight;
    this.topCamera.bottom = -topHeight;
    if (this.topFocusBounds && previousTopFit)
      this.topCamera.zoom *= fitTopObservation(this.topFocusBounds, this.topCamera).zoom / previousTopFit;
    this.topCamera.updateProjectionMatrix();
    this.updateObservationLimits();
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
      target: this.editorOrbit.target.toArray() as Vec3,
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

  getConstraintResults(id = this.selected[0]) {
    return id ? (this.constraintResults.get(id) ?? []) : [];
  }

  getRenderContext() {
    return {
      sceneId: this.binding?.sceneId ?? null,
      performanceId: this.binding?.performanceId ?? null,
      sceneName: this.binding?.project.sceneName ?? null,
      workspace: this.binding?.workspace ?? false,
      loading: this.projectLoading,
    };
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
    const inset = this.project?.settings.safeArea ?? {
      top: 0.05,
      right: 0.05,
      bottom: 0.05,
      left: 0.05,
      thirds: true,
    };
    Object.assign(this.safeOverlay.style, {
      display: this.safeFrameEnabled && this.mode === 'camera' ? 'block' : 'none',
      left: `${frame.x + frame.width * inset.left}px`,
      top: `${frame.y + frame.height * inset.top}px`,
      width: `${frame.width * (1 - inset.left - inset.right)}px`,
      height: `${frame.height * (1 - inset.top - inset.bottom)}px`,
    });
    for (const child of this.safeOverlay.children)
      (child as HTMLElement).style.display = inset.thirds ? 'block' : 'none';
  }

  private refreshSelection() {
    this.selectionHelpers.children.forEach((item) => {
      if (item instanceof THREE.BoxHelper) {
        item.geometry.dispose();
        (item.material as THREE.Material).dispose();
      }
    });
    this.selectionHelpers.clear();
    if (!this.canEditBinding) return;
    for (const id of this.selected) {
      const target = this.objects.get(id);
      if (target) this.selectionHelpers.add(new THREE.BoxHelper(target.root, '#188b76'));
    }
  }

  private rebuildCameraHelpers() {
    this.clearHelpers(this.cameraHelpers);
    if (!this.project) return;
    for (const source of this.project.cameras) {
      const sampled = sampleCamera(source, 0, this.project.settings.aspect);
      const camera = new THREE.PerspectiveCamera(sampled.fov, aspectRatio(this.project), 0.12, 0.65);
      camera.position.fromArray(sampled.position);
      camera.lookAt(new THREE.Vector3(...sampled.target));
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
      const sampled = sampleCamera(source, sourceTime, this.project?.settings.aspect);
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
    const axis = this.binding?.project.settings.axisActorIds || [];
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
    this.transform.getHelper().visible = enabled && this.canEditBinding && this.selected.length === 1;
    this.transform.enabled = enabled && this.canEditBinding && this.options.interactive !== false;
  }

  private get canEditBinding() {
    return !this.projectLoading && this.binding?.workspace === true;
  }

  private emitTransform() {
    const target = this.transform.object;
    if (!this.canEditBinding || !target || !target.userData.entityId) return;
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
    if (!this.canEditBinding) {
      this.pointerStart = null;
      return;
    }
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
    this.options.onSelect?.(id, event.shiftKey || event.metaKey || event.ctrlKey);
    this.pointerStart = null;
  };
  private onDoubleClick = () => this.focus();

  private animate = () => {
    if (this.destroyed) return;
    this.animationFrame = requestAnimationFrame(this.animate);
    if (this.orbit.enabled) this.orbit.update();
  };

  private draw() {
    if (this.destroyed || this.drawing) return;
    this.drawing = true;
    try {
      const sample = this.lastSample;
      const useTransitions =
        this.project &&
        sample &&
        this.mode === 'camera' &&
        !this.timeOptions.shotId &&
        this.timeOptions.sourceTime === undefined;
      const transition = useTransitions
        ? sampleSequenceTransition(this.project!, this.time, this.timeOptions.sequenceId)
        : null;
      const opacity = useTransitions
        ? sampleSequenceOpacity(this.project!, this.time, this.timeOptions.sequenceId)
        : 1;
      if (transition) {
        this.transitionRenderer ??= new TransitionRenderer();
        this.transitionRenderer.render(
          this.renderer,
          this.getFrameRect(),
          () => {
            this.applySample(transition.outgoing);
            this.drawFrame();
          },
          () => {
            this.applySample(transition.incoming);
            this.drawFrame();
          },
          transition.progress,
        );
        this.applySample(sample!);
      } else if (opacity < 1) {
        this.transitionRenderer ??= new TransitionRenderer();
        this.transitionRenderer.render(
          this.renderer,
          this.getFrameRect(),
          () => this.drawFrame(),
          undefined,
          0,
          opacity,
        );
      } else this.drawFrame();
    } finally {
      this.drawing = false;
    }
  }

  private drawFrame() {
    const active = this.activeCamera;
    const far = sceneFarPlane(active.position, this.sceneBounds);
    if (active.far !== far) {
      active.far = far;
      active.updateProjectionMatrix();
    }
    const focus =
      this.mode === 'camera' && this.lastSample?.camera
        ? new THREE.Vector3(...this.lastSample.camera.target)
        : this.orbit.target;
    const shadowRadius = THREE.MathUtils.clamp(active.position.distanceTo(focus) * 0.9, 10, 200);
    this.keyLight.target.position.copy(focus);
    this.keyLight.position.copy(focus).addScaledVector(this.lightDirection, shadowRadius * 2);
    Object.assign(this.keyLight.shadow.camera, {
      left: -shadowRadius,
      right: shadowRadius,
      top: shadowRadius,
      bottom: -shadowRadius,
      far: Math.max(40, shadowRadius * 4),
    });
    this.keyLight.shadow.camera.updateProjectionMatrix();
    const frame = this.getFrameRect();
    this.renderer.setScissorTest(false);
    this.renderer.setViewport(0, 0, this.width, this.height);
    this.renderer.setClearColor('#1c2623', 1);
    this.renderer.clear();
    this.renderer.setViewport(frame.x, frame.y, frame.width, frame.height);
    this.renderer.setScissor(frame.x, frame.y, frame.width, frame.height);
    this.renderer.setScissorTest(true);
    const optics = this.lastSample?.camera?.optics;
    if (this.mode === 'camera' && optics?.enabled) {
      this.opticsRenderer ??= new CameraOpticsRenderer(this.scene, this.shotCamera);
      const target = optics.focusTargetId ? this.getObjectTarget(optics.focusTargetId) : undefined;
      this.shotCamera.updateMatrixWorld(true);
      const focusDistance = target
        ? -this.shotCamera.worldToLocal(new THREE.Vector3(...target)).z
        : optics.focusDistance;
      this.opticsRenderer.render(this.renderer, frame.width, frame.height, optics, focusDistance);
    } else this.renderer.render(this.scene, this.activeCamera);
    this.renderer.setScissorTest(false);
  }

  dispose() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.generation++;
    this.pendingBuild?.abort();
    cancelAnimationFrame(this.animationFrame);
    this.resizeObserver.disconnect();
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('dblclick', this.onDoubleClick);
    this.editorOrbit.dispose();
    this.topOrbit.dispose();
    this.transform.dispose();
    this.opticsRenderer?.dispose();
    this.transitionRenderer?.dispose();
    this.detachResourceRoots();
    this.resources?.release();
    this.resources = null;
    this.objects.clear();
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
