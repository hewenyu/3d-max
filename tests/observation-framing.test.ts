import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Box3,
  BoxGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  OrthographicCamera,
  PerspectiveCamera,
  Vector3,
} from 'three';
import { fitPerspectiveObservation, fitTopObservation } from '../src/engine/ObservationFraming';
import { sceneFarPlane } from '../shared/scene-framing';

const padding = 1.15;
const aspects = [16 / 9, 9 / 16, 1, 3, 0.35];

function transformedGroupBounds() {
  const root = new Group();
  root.position.set(430, 65, -290);
  root.rotation.set(0.2, 0.7, -0.1);
  root.scale.set(2.3, 0.8, 1.6);
  const nested = new Group();
  nested.position.set(-32, 8, 24);
  nested.rotation.set(-0.4, 0.2, 0.3);
  nested.scale.set(0.7, 1.5, 2);
  root.add(nested);
  const material = new MeshBasicMaterial();
  const first = new Mesh(new BoxGeometry(12, 80, 18), material);
  first.position.set(8, 40, -15);
  nested.add(first);
  const second = new Mesh(new BoxGeometry(60, 2, 90), material);
  second.position.set(44, -3, 21);
  second.rotation.y = -0.35;
  root.add(second);
  root.updateWorldMatrix(true, true);
  const bounds = new Box3().setFromObject(root, true);
  first.geometry.dispose();
  second.geometry.dispose();
  material.dispose();
  return bounds;
}

function fixtures() {
  return [
    { name: '160m tower', bounds: new Box3(new Vector3(-4, 0, -3), new Vector3(4, 160, 3)) },
    { name: '160m field', bounds: new Box3(new Vector3(-80, 0, -60), new Vector3(80, 1, 60)) },
    { name: 'transformed group', bounds: transformedGroupBounds() },
    { name: 'ordinary prop', bounds: new Box3(new Vector3(-1, 0, -2), new Vector3(1, 3, 2)) },
    {
      name: 'tiny offset prop',
      bounds: new Box3(new Vector3(900, 30, -400), new Vector3(900.0001, 30.0002, -399.9999)),
    },
  ];
}

function corners(bounds: Box3) {
  const points: Vector3[] = [];
  for (const x of [bounds.min.x, bounds.max.x])
    for (const y of [bounds.min.y, bounds.max.y])
      for (const z of [bounds.min.z, bounds.max.z]) points.push(new Vector3(x, y, z));
  return points;
}

function assertVisible(
  bounds: Box3,
  camera: PerspectiveCamera | OrthographicCamera,
  center: Vector3,
  label: string,
  margin = padding,
) {
  camera.lookAt(center);
  camera.far = sceneFarPlane(camera.position, bounds);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  for (const corner of corners(bounds)) {
    const point = corner.clone().project(camera);
    const detail = `${label}: ${JSON.stringify({ corner, projected: point })}`;
    assert.ok(point.toArray().every(Number.isFinite), detail);
    assert.ok(Math.abs(point.x) <= 1 / margin + 1e-7, detail);
    assert.ok(Math.abs(point.y) <= 1 / margin + 1e-7, detail);
    assert.ok(point.z >= -1 && point.z <= 1, detail);
  }
}

function assertFiniteFit(fit: { center: Vector3; position: Vector3; distance: number }) {
  assert.ok([...fit.center.toArray(), ...fit.position.toArray(), fit.distance].every(Number.isFinite));
  assert.ok(fit.distance > 0);
  assert.ok(Math.abs(fit.position.distanceTo(fit.center) - fit.distance) < 1e-7);
}

test('perspective observation fits all world bounds across viewport proportions and lens angles', () => {
  for (const { name, bounds } of fixtures())
    for (const aspect of aspects)
      for (const fov of [25, 43, 78]) {
        const camera = new PerspectiveCamera(fov, aspect, 0.05, 300);
        camera.position.set(7.8, 6.4, 9.5);
        const target = new Vector3(0, 0.65, 0);
        const direction = camera.position.clone().sub(target).normalize();
        const fit = fitPerspectiveObservation(bounds, camera, target);
        assertFiniteFit(fit);
        assert.ok(fit.center.distanceTo(bounds.getCenter(new Vector3())) < 1e-9);
        assert.ok(fit.position.clone().sub(fit.center).normalize().distanceTo(direction) < 1e-9);
        camera.position.copy(fit.position);
        assertVisible(bounds, camera, fit.center, `${name}, aspect ${aspect}, fov ${fov}`);
      }
});

test('perspective observation includes view-axis thickness and respects camera up and custom padding', () => {
  const bounds = new Box3(new Vector3(-10, -3, -80), new Vector3(10, 3, 80));
  for (const up of [new Vector3(0, 1, 0), new Vector3(1, 0, 0)]) {
    const camera = new PerspectiveCamera(43, 9 / 16, 0.05, 300);
    camera.position.set(0, 0, 10);
    camera.up.copy(up);
    const fit = fitPerspectiveObservation(bounds, camera, new Vector3(), 1.3);
    assertFiniteFit(fit);
    assert.ok(fit.position.z > bounds.max.z + camera.near);
    camera.position.copy(fit.position);
    assertVisible(bounds, camera, fit.center, `view-axis thickness, up ${up.toArray()}`, 1.3);
  }
});

test('perspective observation remains finite for coincident target and parallel camera up', () => {
  const bounds = new Box3(new Vector3(-2, -1, -3), new Vector3(2, 1, 3));
  const camera = new PerspectiveCamera(43, 16 / 9, 0.05, 300);
  const target = new Vector3(15, 40, -10);
  camera.position.copy(target);
  const coincident = fitPerspectiveObservation(bounds, camera, target);
  assertFiniteFit(coincident);
  camera.position.copy(coincident.position);
  assertVisible(bounds, camera, coincident.center, 'coincident target');
  camera.position.copy(target).addScaledVector(camera.up, 10);
  assertFiniteFit(fitPerspectiveObservation(bounds, camera, target));
});

test('top observation fits XZ spans across viewport proportions without a minimum zoom clamp', () => {
  for (const { name, bounds } of fixtures())
    for (const aspect of aspects) {
      const halfWidth = 6 * Math.max(1, aspect);
      const halfHeight = 6 * Math.max(1, 1 / aspect);
      const camera = new OrthographicCamera(-halfWidth, halfWidth, halfHeight, -halfHeight, 0.05, 300);
      camera.up.set(0, 0, -1);
      const fit = fitTopObservation(bounds, camera);
      assertFiniteFit(fit);
      assert.ok(fit.zoom > 0 && fit.zoom <= 6);
      assert.ok(fit.center.distanceTo(bounds.getCenter(new Vector3())) < 1e-9);
      assert.equal(fit.position.x, fit.center.x);
      assert.equal(fit.position.z, fit.center.z);
      assert.ok(fit.position.y >= bounds.max.y + 1);
      if (name === '160m field') assert.ok(fit.zoom < 0.4);
      if (name === 'tiny offset prop') assert.equal(fit.zoom, 6);
      camera.position.copy(fit.position);
      camera.zoom = fit.zoom;
      assertVisible(bounds, camera, fit.center, `${name}, top aspect ${aspect}`);
      assert.ok(camera.getWorldDirection(new Vector3()).distanceTo(new Vector3(0, -1, 0)) < 1e-9);
    }
});

test('top observation keeps tall geometry below the camera and uses requested padding', () => {
  const bounds = new Box3(new Vector3(-8, 120, -15), new Vector3(8, 280, 15));
  const camera = new OrthographicCamera(-6, 6, 10, -10, 0.05, 300);
  camera.up.set(0, 0, -1);
  const fit = fitTopObservation(bounds, camera, 1.4);
  assertFiniteFit(fit);
  assert.ok(fit.position.y > 280);
  camera.position.copy(fit.position);
  camera.zoom = fit.zoom;
  assertVisible(bounds, camera, fit.center, 'elevated tower', 1.4);
});

test('observation fitting does not mutate input bounds, cameras or orbit targets', () => {
  const bounds = transformedGroupBounds();
  const beforeBounds = bounds.clone();
  const perspective = new PerspectiveCamera(43, 9 / 16, 0.05, 300);
  perspective.position.set(7.8, 6.4, 9.5);
  const top = new OrthographicCamera(-6, 6, 10, -10, 0.05, 300);
  top.position.set(0, 20, 0);
  top.up.set(0, 0, -1);
  const target = new Vector3(0, 0.65, 0);
  const beforeTarget = target.clone();
  const beforePerspective = perspective.toJSON();
  const beforeTop = top.toJSON();
  fitPerspectiveObservation(bounds, perspective, target);
  fitTopObservation(bounds, top);
  assert.ok(bounds.equals(beforeBounds));
  assert.ok(target.equals(beforeTarget));
  assert.deepEqual(perspective.toJSON(), beforePerspective);
  assert.deepEqual(top.toJSON(), beforeTop);
});
