import * as THREE from 'three';
import type { ComponentWorkspaceState } from '../../shared/topology-workspace';
import type { ComponentSourceData } from './ComponentSourceData';

const selectedColor = '#e17642';
function clearShapes(group: THREE.Group) {
  group.traverse((child) => {
    if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments || child instanceof THREE.Points) {
      child.geometry.dispose();
      (Array.isArray(child.material) ? child.material : [child.material]).forEach((material) =>
        material.dispose(),
      );
    }
  });
  group.clear();
}

export class ComponentOverlay {
  readonly root = new THREE.Group();
  readonly picking: THREE.Mesh;
  private readonly decorations = new THREE.Group();
  private readonly highlights = new THREE.Group();
  private readonly faceRanges: Uint32Array;
  private decorationKey = '';
  private selectionKey = '';
  private selection: ComponentWorkspaceState['selection'] = null;
  private hidden: THREE.Mesh[] = [];
  get topology() {
    return this.data.topology;
  }
  get mesh() {
    return this.topology.mesh;
  }

  constructor(
    private readonly data: ComponentSourceData,
    state: ComponentWorkspaceState,
  ) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
    geometry.userData.polygonIndices = data.polygonIndices;
    geometry.boundingBox = new THREE.Box3(
      new THREE.Vector3(...data.bounds.min),
      new THREE.Vector3(...data.bounds.max),
    );
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(...data.bounds.center), data.bounds.radius);
    this.picking = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    this.faceRanges = data.faceRanges;
    this.root.add(this.decorations, this.highlights);
    this.root.matrixAutoUpdate = false;
    this.picking.matrixAutoUpdate = false;
    this.setState(state);
  }

  setState(state: ComponentWorkspaceState) {
    const mesh = this.mesh,
      topology = this.topology,
      geometry = this.picking.geometry;
    const selected = new Set(state.selection?.ids ?? []);
    const depthTest = !state.xray;
    const line = (
      parent: THREE.Group,
      positions: THREE.Vector3[] | Float32Array,
      color: string,
      opacity = 1,
    ) => {
      const geometry =
        positions instanceof Float32Array
          ? new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(positions, 3))
          : new THREE.BufferGeometry().setFromPoints(positions);
      const result = new THREE.LineSegments(
        geometry,
        new THREE.LineBasicMaterial({ color, depthTest, transparent: opacity < 1, opacity }),
      );
      result.renderOrder = 5;
      parent.add(result);
    };
    const decorationKey = JSON.stringify([state.display, state.boundaries, state.normals, state.xray]);
    if (this.decorationKey !== decorationKey) {
      clearShapes(this.decorations);
      if (state.display !== 'solid') line(this.decorations, this.data.wire, '#526d73', 0.65);
      if (state.boundaries) line(this.decorations, this.data.boundaries, '#cc4b69');
      if (state.normals) line(this.decorations, this.data.normals, '#527dba');
      this.decorationKey = decorationKey;
    }
    const selectionKey = `${state.mode}:${state.xray}`;
    if (this.selection === state.selection && this.selectionKey === selectionKey) return;
    clearShapes(this.highlights);
    if (state.mode === 'edge')
      line(
        this.highlights,
        [...selected].flatMap((id) => {
          const index = topology.edgeById.get(id);
          return index === undefined
            ? []
            : topology.edges[index].vertices.map((vertex) => new THREE.Vector3(...mesh.vertices[vertex]));
        }),
        selectedColor,
      );
    if (state.mode === 'vertex') {
      const selectedRgb = new THREE.Color(selectedColor).toArray(),
        normalRgb = new THREE.Color('#47677b').toArray();
      const colors = new Float32Array(mesh.vertices.length * 3);
      mesh.identity.vertexIds.forEach((id, index) =>
        colors.set(selected.has(id) ? selectedRgb : normalRgb, index * 3),
      );
      const pointsGeometry = new THREE.BufferGeometry();
      pointsGeometry.setAttribute('position', geometry.getAttribute('position'));
      pointsGeometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      const points = new THREE.Points(
        pointsGeometry,
        new THREE.PointsMaterial({ size: 7, sizeAttenuation: false, vertexColors: true, depthTest }),
      );
      points.renderOrder = 6;
      this.highlights.add(points);
    }
    if (state.mode === 'face' && selected.size) {
      const sourceIndices = geometry.getIndex()!;
      const indices: number[] = [];
      // Triangles remain grouped by source polygon, so picking and feedback share one tessellation.
      for (const id of selected) {
        const face = topology.faceById.get(id);
        if (face === undefined) continue;
        for (let index = this.faceRanges[face] * 3; index < this.faceRanges[face + 1] * 3; index++)
          indices.push(sourceIndices.getX(index));
      }
      if (indices.length) {
        const facesGeometry = new THREE.BufferGeometry();
        facesGeometry.setAttribute('position', geometry.getAttribute('position'));
        facesGeometry.setIndex(indices);
        facesGeometry.boundingBox = geometry.boundingBox;
        facesGeometry.boundingSphere = geometry.boundingSphere;
        const surface = new THREE.Mesh(
          facesGeometry,
          new THREE.MeshBasicMaterial({
            color: selectedColor,
            side: THREE.DoubleSide,
            transparent: true,
            opacity: 0.4,
            depthTest,
            depthWrite: false,
            polygonOffset: true,
            polygonOffsetFactor: -2,
            polygonOffsetUnits: -2,
          }),
        );
        surface.renderOrder = 4;
        this.highlights.add(surface);
      }
    }
    this.selection = state.selection;
    this.selectionKey = selectionKey;
  }

  update(root: THREE.Object3D, wireframe: boolean) {
    root.updateWorldMatrix(true, true);
    this.root.matrix.copy(root.matrixWorld);
    this.root.updateMatrixWorld(true);
    this.picking.matrix.copy(root.matrixWorld);
    this.picking.updateMatrixWorld(true);
    if (wireframe && !this.hidden.length)
      root.traverse((child) => {
        if (child instanceof THREE.Mesh && child.visible && child.parent === root) {
          this.hidden.push(child);
          child.visible = false;
        }
      });
    if (!wireframe) this.restoreVisibility();
  }
  restoreVisibility() {
    this.hidden.forEach((mesh) => {
      mesh.visible = true;
    });
    this.hidden = [];
  }
  dispose() {
    this.restoreVisibility();
    this.root.removeFromParent();
    clearShapes(this.decorations);
    clearShapes(this.highlights);
    this.picking.geometry.dispose();
    (this.picking.material as THREE.Material).dispose();
  }
}
