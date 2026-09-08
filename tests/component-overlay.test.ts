import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { selectComponents, selectTopologyComponents } from '../shared/topology/selection';
import { defaultComponentWorkspace, type ComponentWorkspaceState } from '../shared/topology-workspace';
import { ComponentOverlay } from '../src/engine/ComponentOverlay';
import { pickComponents } from '../src/engine/ComponentPicking';
import { prepareComponentSource } from '../src/engine/ComponentSourceData';
import { topologyCube } from './fixtures/topology-command-cases';

function fixture() {
  const prepared = prepareComponentSource(topologyCube());
  const topology = prepared.topology;
  const state: ComponentWorkspaceState = {
    ...structuredClone(defaultComponentWorkspace),
    objectId: 'target',
    mode: 'face',
    selection: {
      namespace: topology.mesh.identity.namespace,
      kind: 'face',
      ids: [topology.mesh.identity.faceIds[1]],
    },
  };
  return { topology, state, overlay: new ComponentOverlay(prepared, state) };
}
test('selection reuses source tessellation and static wire geometry while selected faces retain actual triangle indices', () => {
  const { topology, state, overlay } = fixture();
  try {
    const pickingGeometry = overlay.picking.geometry;
    const wire = (overlay.root.children[0].children[0] as THREE.LineSegments).geometry;
    const highlights = overlay.root.children[1];
    const first = highlights.children[0] as THREE.Mesh;
    assert.equal(first.geometry.getIndex()!.count, 6);
    assert.equal(first.geometry.getAttribute('position'), pickingGeometry.getAttribute('position'));
    overlay.setState({ ...state, selection: { ...state.selection!, ids: topology.mesh.identity.faceIds } });
    assert.equal(overlay.topology, topology);
    assert.equal(overlay.picking.geometry, pickingGeometry);
    assert.equal((overlay.root.children[0].children[0] as THREE.LineSegments).geometry, wire);
    const all = highlights.children[0] as THREE.Mesh;
    assert.equal(all.geometry.getIndex()!.count, pickingGeometry.getIndex()!.count);
    overlay.setState({
      ...state,
      mode: 'vertex',
      selection: { ...state.selection!, kind: 'vertex', ids: topology.mesh.identity.vertexIds.slice(0, 1) },
    });
    const vertices = highlights.children[0] as THREE.Points;
    assert.equal(vertices.geometry.getAttribute('position'), pickingGeometry.getAttribute('position'));
    assert.notEqual(
      vertices.geometry.getAttribute('color').getX(0),
      vertices.geometry.getAttribute('color').getX(1),
    );
  } finally {
    overlay.dispose();
  }
});
test('cached topology selection retains connected, inverted and stale-selection semantics', () => {
  const { topology, overlay } = fixture();
  try {
    for (const operation of ['replace', 'connected', 'grow', 'shrink', 'invert'] as const) {
      const request = {
        namespace: topology.mesh.identity.namespace,
        kind: 'face' as const,
        ids: topology.mesh.identity.faceIds.slice(0, 1),
        operation,
      };
      assert.deepEqual(selectTopologyComponents(topology, request), selectComponents(topology.mesh, request));
    }
    assert.throws(
      () =>
        selectTopologyComponents(topology, {
          namespace: 'stale',
          kind: 'face',
          ids: [],
          operation: 'replace',
        }),
      { code: 'STALE_SELECTION' },
    );
  } finally {
    overlay.dispose();
  }
});
test('physical face and vertex rays use cached geometry after changing overlay modes', () => {
  const { topology, overlay, state } = fixture();
  try {
    const root = new THREE.Group();
    overlay.update(root, false);
    const camera = new THREE.PerspectiveCamera(50, 1, 0.01, 100);
    camera.position.set(0, 0, 5);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    const view = { camera, frame: { x: 0, y: 0, width: 500, height: 500 }, occluders: [] };
    assert.deepEqual(pickComponents(overlay, state, view, [{ x: 250, y: 250 }]), [
      topology.mesh.identity.faceIds[1],
    ]);
    const point = new THREE.Vector3(1, 1, 1).project(camera);
    const vertexState = { ...state, mode: 'vertex' as const, xray: true };
    overlay.setState(vertexState);
    overlay.update(root, false);
    assert.deepEqual(
      pickComponents(overlay, vertexState, view, [{ x: (point.x + 1) * 250, y: (1 - point.y) * 250 }]),
      [topology.mesh.identity.vertexIds[6]],
    );
  } finally {
    overlay.dispose();
  }
});
test('wireframe visibility restores on solid mode and disposal releases the cached picking geometry once', () => {
  const { overlay } = fixture();
  const root = new THREE.Group();
  const source = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
  root.add(source);
  let disposed = 0;
  overlay.picking.geometry.addEventListener('dispose', () => disposed++);
  try {
    overlay.update(root, true);
    assert.equal(source.visible, false);
    overlay.update(root, false);
    assert.equal(source.visible, true);
    overlay.update(root, true);
    overlay.dispose();
    assert.equal(source.visible, true);
    assert.equal(disposed, 1);
  } finally {
    source.geometry.dispose();
    source.material.dispose();
  }
});
