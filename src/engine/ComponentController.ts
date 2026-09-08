import * as THREE from 'three';
import type { Project, SceneObject } from '../../shared/types';
import type { ComponentTransformInput } from '../../shared/topology-schema';
import {
  componentWorkspaceCommandSchema,
  defaultComponentWorkspace,
  type ComponentWorkspaceCommand,
  type ComponentWorkspaceState,
} from '../../shared/topology-workspace';
import { meshFaceNormal } from '../../shared/topology/adjacency';
import {
  componentIds,
  resolveSelection,
  selectTopologyComponents,
  selectionVertices,
} from '../../shared/topology/selection';
import {
  TopologyError,
  type IdentifiedMesh,
  type MeshTopology,
  type TopologyMesh,
} from '../../shared/topology/types';
import { ComponentOverlay } from './ComponentOverlay';
import { ComponentPreview } from './ComponentPreview';
import { ComponentSource, type PreparedComponentSource } from './ComponentSource';
import { pickComponents, type ComponentView, type ScreenPoint } from './ComponentPicking';

interface Host {
  scene: THREE.Scene;
  canvas: HTMLCanvasElement;
  view(): ComponentView;
  project(): Project | null;
  root(id: string): THREE.Object3D | undefined;
  editable(): boolean;
  active(): boolean;
  changed(): void;
  orbit(enabled: boolean): void;
  commit(input: ComponentTransformInput): void;
  cancelTransform(): boolean;
  error(error: Error): void;
}
export class ComponentController {
  private state = structuredClone(defaultComponentWorkspace);
  private listeners = new Set<() => void>();
  private overlay: ComponentOverlay | null = null;
  private source: IdentifiedMesh | null = null;
  private sourceInput: TopologyMesh | null = null;
  private topology: MeshTopology | null = null;
  private prepared: PreparedComponentSource | null = null;
  private sourceWorker = new ComponentSource();
  private preparationGeneration = 0;
  private pendingSyncInput: TopologyMesh | null = null;
  private pendingApplies = 0;
  private applyQueue: Promise<void> = Promise.resolve();
  private disposed = false;
  private gizmoCache: {
    source: IdentifiedMesh;
    selection: ComponentWorkspaceState['selection'];
    settings: string;
    parent: THREE.Object3D;
    matrix: string;
  } | null = null;
  private projectKey = '';
  private selectedObject: string | undefined;
  private gesture: { path: ScreenPoint[]; combine: 'replace' | 'add' | 'remove'; pointerId: number } | null =
    null;
  private marquee: HTMLCanvasElement;
  readonly gizmo = new THREE.Group();
  private initialGizmo = new THREE.Matrix4();
  private initialRoot = new THREE.Matrix4();
  private initialPivot = new THREE.Vector3();
  private initialQuaternion = new THREE.Quaternion();
  private dragging = false;
  private pointerUpInProgress = false;
  private preview: ComponentPreview | null = null;
  constructor(private host: Host) {
    this.marquee = document.createElement('canvas');
    this.marquee.style.cssText =
      'position:absolute;inset:0;pointer-events:none;width:100%;height:100%;z-index:3';
    host.canvas.parentElement?.parentElement?.append(this.marquee);
    host.canvas.addEventListener('pointerdown', this.pointerDown, true);
    host.canvas.addEventListener('pointermove', this.pointerMove, true);
    host.canvas.addEventListener('pointerup', this.pointerUp, true);
    host.canvas.addEventListener('pointercancel', this.pointerCancel, true);
    host.canvas.addEventListener('lostpointercapture', this.pointerCancel, true);
  }
  getState = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(next: ComponentWorkspaceState) {
    this.state = next;
    this.listeners.forEach((listener) => listener());
  }
  get loading() {
    return this.pendingApplies > 0 || this.pendingSyncInput !== null;
  }
  get active() {
    return this.state.mode !== 'object' && !this.loading && this.host.active() && this.host.editable();
  }
  get transformTarget() {
    const object = this.object();
    return this.active && this.state.selection?.ids.length && object && !object.locked
      ? this.gizmo
      : undefined;
  }
  private object() {
    return this.host.project()?.objects.find((object) => object.id === this.state.objectId);
  }
  private meshInput(object: SceneObject) {
    const input = object.modeling?.kind === 'stack' ? object.modeling.base : object.modeling;
    if (input?.kind !== 'mesh')
      throw new TopologyError(
        'Convert the source to an editable mesh before selecting components',
        'SOURCE_NOT_MESH',
      );
    return input;
  }
  prepareSource = (input: TopologyMesh) => this.sourceWorker.prepare(input);
  private readSource(object: SceneObject) {
    return this.prepareSource(this.meshInput(object));
  }
  private cacheSource(prepared: PreparedComponentSource | null) {
    this.prepared = prepared;
    this.sourceInput = prepared?.input ?? null;
    this.topology = prepared?.topology ?? null;
    this.source = prepared?.source ?? null;
  }
  sync(selected: string[]) {
    const project = this.host.project();
    const key = project
      ? `${project.id}/${project.production?.activeSceneId}/${project.production?.activePerformanceId}`
      : '';
    const changedContext = key !== this.projectKey;
    this.projectKey = key;
    const changedSelection = this.selectedObject !== (selected.length === 1 ? selected[0] : undefined);
    this.selectedObject = selected.length === 1 ? selected[0] : undefined;
    if (
      changedContext ||
      (this.state.objectId && this.selectedObject !== this.state.objectId) ||
      (changedSelection && this.pendingApplies > 0)
    ) {
      this.publish({ ...this.state, objectId: null, mode: 'object', selection: null, invalidatedIds: [] });
      this.clear();
    }
    if (this.state.mode === 'object' || this.pendingApplies) return;
    const object = this.object();
    let input: TopologyMesh;
    try {
      if (!object) throw new Error('Missing object');
      input = this.meshInput(object);
    } catch {
      this.publish({
        ...this.state,
        mode: 'object',
        selection: null,
        invalidatedIds: this.state.selection?.ids ?? [],
      });
      this.clear();
      return;
    }
    if (input === this.sourceInput) {
      this.updateGizmo();
      return;
    }
    if (input === this.pendingSyncInput) return;
    const generation = ++this.preparationGeneration;
    this.pendingSyncInput = input;
    this.host.changed();
    void this.prepareSource(input)
      .then((prepared) => {
        if (this.disposed || generation !== this.preparationGeneration) return;
        this.installSync(prepared);
      })
      .catch((error: Error) => {
        if (this.disposed || generation !== this.preparationGeneration) return;
        this.host.error(error);
        this.publish({
          ...this.state,
          mode: 'object',
          selection: null,
          invalidatedIds: this.state.selection?.ids ?? [],
        });
        this.clear();
      })
      .finally(() => {
        if (generation !== this.preparationGeneration) return;
        this.pendingSyncInput = null;
        this.host.changed();
      });
  }
  private installSync(prepared: PreparedComponentSource) {
    if (this.state.mode === 'object') return;
    const { source, topology } = prepared;
    if (source === this.source) {
      this.cacheSource(prepared);
      this.updateGizmo();
      return;
    }
    const previous = this.state.selection;
    const valid = new Set(componentIds(topology, this.state.mode));
    const ids =
      previous?.namespace === source.identity.namespace ? previous.ids.filter((id) => valid.has(id)) : [];
    const retained = new Set(ids);
    this.publish({
      ...this.state,
      selection: { namespace: source.identity.namespace, kind: this.state.mode, ids },
      invalidatedIds: previous?.ids.filter((id) => !retained.has(id)) ?? [],
    });
    this.cacheSource(prepared);
    this.rebuild();
  }
  apply(input: ComponentWorkspaceCommand): Promise<void> {
    const operation = this.applyQueue.then(() => this.applyCommand(input));
    this.applyQueue = operation.catch(() => undefined);
    return operation;
  }
  private async applyCommand(input: ComponentWorkspaceCommand) {
    const command = componentWorkspaceCommandSchema.parse(input);
    if (this.disposed || !this.host.editable() || !this.host.active())
      throw new TopologyError(
        'Component editing requires the active scene in edit or top view',
        'WORKSPACE_NOT_EDITABLE',
        409,
      );
    const objectId = command.objectId ?? this.state.objectId ?? this.selectedObject ?? null;
    const mode = command.mode ?? command.selection?.kind ?? this.state.mode;
    const next = { ...this.state, objectId, mode, invalidatedIds: [] };
    for (const key of [
      'tool',
      'xray',
      'display',
      'normals',
      'boundaries',
      'space',
      'pivotMode',
      'pivot',
    ] as const)
      if (command[key] !== undefined) Object.assign(next, { [key]: command[key] });
    if (command.proportional !== undefined) next.proportional = command.proportional ?? undefined;
    const generation = ++this.preparationGeneration;
    const context = this.projectKey;
    this.pendingSyncInput = null;
    let preparing = false;
    try {
      let prepared: PreparedComponentSource | null = null;
      if (mode !== 'object') {
        const object = this.host.project()?.objects.find((object) => object.id === objectId);
        if (!object) throw new TopologyError('Select an editable mesh object', 'NOT_FOUND', 404);
        if (this.meshInput(object) === this.sourceInput && this.prepared) prepared = this.prepared;
        else {
          preparing = true;
          this.pendingApplies++;
          this.host.changed();
          prepared = await this.readSource(object);
        }
        const current = this.host.project()?.objects.find((item) => item.id === objectId);
        if (
          this.disposed ||
          generation !== this.preparationGeneration ||
          context !== this.projectKey ||
          this.selectedObject !== objectId ||
          !current ||
          (this.meshInput(current) !== prepared.input &&
            JSON.stringify(this.meshInput(current)) !== prepared.fingerprint)
        )
          throw new TopologyError(
            'The component source changed while it was being prepared',
            'SOURCE_CHANGED',
            409,
          );
        const source = prepared.source;
        const old = this.state.selection;
        next.selection =
          old &&
          old.kind === mode &&
          old.namespace === source.identity.namespace &&
          objectId === this.state.objectId
            ? old
            : { namespace: source.identity.namespace, kind: mode, ids: [] };
        if (command.selection) {
          if (command.selection.kind !== mode)
            throw new TopologyError('Selection kind must match component mode');
          const result = selectTopologyComponents(prepared.topology, command.selection);
          const removed = command.combine === 'remove' ? new Set(result.ids) : null;
          const ids =
            command.combine === 'add'
              ? [...new Set([...next.selection.ids, ...result.ids])]
              : command.combine === 'remove'
                ? next.selection.ids.filter((id) => !removed!.has(id))
                : result.ids;
          next.selection = { namespace: result.namespace, kind: result.kind, ids };
        }
      } else {
        next.selection = null;
        next.objectId = null;
      }
      this.cacheSource(prepared);
      this.publish(next);
      this.rebuild();
    } finally {
      if (preparing) this.pendingApplies--;
      if (!this.disposed) {
        if (preparing) this.sync(this.selectedObject ? [this.selectedObject] : []);
        this.host.changed();
      }
    }
  }
  private clear() {
    this.preparationGeneration++;
    this.pendingSyncInput = null;
    this.sourceWorker.reset();
    this.cancelTransform();
    this.overlay?.dispose();
    this.overlay = null;
    this.gizmo.removeFromParent();
    this.cacheSource(null);
    this.gizmoCache = null;
  }
  private rebuild() {
    if (!this.source || !this.topology || !this.prepared || this.state.mode === 'object') {
      this.overlay?.dispose();
      this.overlay = null;
      this.gizmo.removeFromParent();
      return;
    }
    if (this.overlay?.mesh === this.source) this.overlay.setState(this.state);
    else {
      this.overlay?.dispose();
      this.overlay = new ComponentOverlay(this.prepared.data, this.state);
      this.host.scene.add(this.overlay.root);
    }
    this.updateGizmo();
    this.update();
  }
  private updateGizmo() {
    const source = this.source;
    const root = this.state.objectId ? this.host.root(this.state.objectId) : undefined;
    if (!root || !source || !this.topology || !this.state.selection?.ids.length || this.dragging) return;
    root.updateWorldMatrix(true, false);
    const settings = JSON.stringify([this.state.space, this.state.pivotMode, this.state.pivot]);
    const matrix = root.matrixWorld.elements.join(',');
    const cached = this.gizmoCache;
    if (
      cached?.source === source &&
      cached.selection === this.state.selection &&
      cached.settings === settings &&
      cached.parent === root &&
      cached.matrix === matrix &&
      this.gizmo.parent === root
    )
      return;
    const topology = this.topology;
    const indices = selectionVertices(topology, this.state.selection);
    const points = indices.map((index) => new THREE.Vector3(...source.vertices[index]));
    const pivot = points
      .reduce((sum, point) => sum.add(point), new THREE.Vector3())
      .multiplyScalar(1 / points.length);
    if (this.state.pivotMode === 'bounds') new THREE.Box3().setFromPoints(points).getCenter(pivot);
    if (this.state.pivotMode === 'origin') pivot.set(0, 0, 0);
    if (this.state.pivotMode === 'active') {
      const active = selectionVertices(topology, {
        ...this.state.selection,
        ids: this.state.selection.ids.slice(-1),
      });
      pivot.copy(
        active
          .reduce((sum, index) => sum.add(new THREE.Vector3(...source.vertices[index])), new THREE.Vector3())
          .multiplyScalar(1 / active.length),
      );
    }
    this.gizmo.quaternion.identity();
    if (this.state.space === 'world')
      this.gizmo.quaternion.copy(root.getWorldQuaternion(new THREE.Quaternion()).invert());
    if (this.state.space === 'normal') {
      const faces =
        this.state.selection.kind === 'face'
          ? resolveSelection(topology, this.state.selection)
          : [...new Set(indices.flatMap((index) => topology.vertexFaces[index]))];
      const normal = faces.reduce(
        (sum, face) => sum.add(meshFaceNormal(source, source.faces[face])),
        new THREE.Vector3(),
      );
      if (normal.length() > 1e-8)
        this.gizmo.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal.normalize());
    }
    if (this.state.pivotMode === 'custom' && this.state.pivot) {
      pivot.set(...this.state.pivot);
      if (this.state.space === 'world') root.worldToLocal(pivot);
      if (this.state.space === 'normal') pivot.applyQuaternion(this.gizmo.quaternion);
    }
    root.add(this.gizmo);
    this.gizmo.position.copy(pivot);
    this.gizmo.scale.set(1, 1, 1);
    this.gizmo.updateWorldMatrix(true, true);
    this.gizmoCache = { source, selection: this.state.selection, settings, parent: root, matrix };
  }
  update() {
    if (!this.overlay) return;
    this.overlay.root.visible = this.active && !this.preview?.ready;
    const root = this.state.objectId ? this.host.root(this.state.objectId) : undefined;
    if (root && this.active) this.overlay.update(root, this.state.display === 'wireframe');
    else this.overlay.restoreVisibility();
  }
  beginTransform() {
    if (!this.transformTarget) return;
    this.dragging = true;
    this.gizmo.updateWorldMatrix(true, true);
    this.initialGizmo.copy(this.gizmo.matrixWorld);
    this.initialRoot.copy(this.gizmo.parent!.matrixWorld);
    this.initialPivot.copy(this.gizmo.position);
    this.initialQuaternion.copy(this.gizmo.quaternion);
    if (this.source && this.state.selection) {
      this.preview = new ComponentPreview(
        this.source,
        { selection: this.state.selection, proportional: this.state.proportional },
        this.gizmo.parent!,
        this.host.scene,
        () => this.host.changed(),
        this.host.error,
      );
    }
  }
  private transformMatrix() {
    this.gizmo.updateWorldMatrix(true, true);
    return this.initialRoot
      .clone()
      .invert()
      .multiply(this.gizmo.matrixWorld)
      .multiply(this.initialGizmo.clone().invert())
      .multiply(this.initialRoot);
  }
  previewTransform() {
    if (this.dragging) this.preview?.update(this.transformMatrix());
  }
  cancelTransform() {
    if (!this.dragging) return false;
    this.dragging = false;
    this.preview?.dispose();
    this.preview = null;
    this.gizmo.position.copy(this.initialPivot);
    this.gizmo.quaternion.copy(this.initialQuaternion);
    this.gizmo.scale.set(1, 1, 1);
    return true;
  }
  endTransform() {
    if (!this.dragging || !this.state.selection || !this.state.objectId) return false;
    const matrix = this.transformMatrix();
    this.cancelTransform();
    if (matrix.elements.every((value, index) => Math.abs(value - (index % 5 === 0 ? 1 : 0)) < 1e-10))
      return true;
    this.host.commit({
      id: this.state.objectId,
      selection: this.state.selection,
      matrix: matrix.toArray(),
      proportional: this.state.proportional,
    });
    return true;
  }
  private point(event: PointerEvent): ScreenPoint {
    const bounds = this.host.canvas.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  }
  private pointerDown = (event: PointerEvent) => {
    if (!this.active || event.button !== 0 || event.altKey) return;
    if (this.state.tool === 'pick' && this.transformTarget) return;
    this.gesture = {
      path: [this.point(event)],
      combine: event.ctrlKey || event.metaKey ? 'remove' : event.shiftKey ? 'add' : 'replace',
      pointerId: event.pointerId,
    };
    this.host.canvas.setPointerCapture(event.pointerId);
    this.host.orbit(false);
    event.stopImmediatePropagation();
  };
  private pointerMove = (event: PointerEvent) => {
    const gesture = this.gesture;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const point = this.point(event);
    if (this.state.tool === 'lasso') {
      const last = gesture.path.at(-1)!;
      if (Math.hypot(point.x - last.x, point.y - last.y) > 3 && gesture.path.length < 2000)
        gesture.path.push(point);
    } else gesture.path[1] = point;
    const bounds = this.host.canvas.getBoundingClientRect();
    this.marquee.width = bounds.width;
    this.marquee.height = bounds.height;
    const context = this.marquee.getContext('2d')!;
    context.strokeStyle = '#dd7c46';
    context.fillStyle = 'rgba(221,124,70,.12)';
    context.setLineDash([4, 3]);
    if (this.state.tool === 'box') {
      const start = gesture.path[0];
      context.strokeRect(start.x, start.y, point.x - start.x, point.y - start.y);
      context.fillRect(start.x, start.y, point.x - start.x, point.y - start.y);
    }
    if (this.state.tool === 'lasso') {
      context.beginPath();
      gesture.path.forEach((point, index) =>
        index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y),
      );
      context.closePath();
      context.fill();
      context.stroke();
    }
    event.stopImmediatePropagation();
  };
  private pointerUp = (event: PointerEvent) => {
    this.pointerUpInProgress = true;
    queueMicrotask(() => {
      this.pointerUpInProgress = false;
    });
    if (!this.gesture || event.pointerId !== this.gesture.pointerId) return;
    const gesture = this.gesture;
    this.finishGesture();
    try {
      this.pick(gesture.path, gesture.combine);
    } catch (error) {
      this.host.error(error as Error);
    }
    event.stopImmediatePropagation();
  };
  private pointerCancel = (event: PointerEvent) => {
    this.finishGesture();
    if (this.dragging && (event.type === 'pointercancel' || !this.pointerUpInProgress))
      this.host.cancelTransform();
  };
  private finishGesture() {
    const gesture = this.gesture;
    this.gesture = null;
    if (gesture && this.host.canvas.hasPointerCapture(gesture.pointerId))
      this.host.canvas.releasePointerCapture(gesture.pointerId);
    this.marquee.getContext('2d')?.clearRect(0, 0, this.marquee.width, this.marquee.height);
    this.host.orbit(true);
  }
  pick(path: ScreenPoint[], combine: 'replace' | 'add' | 'remove') {
    if (!this.active || !this.overlay || !this.state.selection) return;
    const ids = pickComponents(this.overlay, this.state, this.host.view(), path);
    void this.apply({
      type: 'components',
      selection: { ...this.state.selection, ids, operation: 'replace' },
      combine,
    }).catch((error: Error) => this.host.error(error));
  }
  dispose() {
    this.disposed = true;
    this.sourceWorker.dispose();
    this.clear();
    this.finishGesture();
    this.marquee.remove();
    this.host.canvas.removeEventListener('pointerdown', this.pointerDown, true);
    this.host.canvas.removeEventListener('pointermove', this.pointerMove, true);
    this.host.canvas.removeEventListener('pointerup', this.pointerUp, true);
    this.host.canvas.removeEventListener('pointercancel', this.pointerCancel, true);
    this.host.canvas.removeEventListener('lostpointercapture', this.pointerCancel, true);
    this.listeners.clear();
  }
}
