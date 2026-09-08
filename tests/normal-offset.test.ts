import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Quaternion, Vector3 } from 'three';
import { solidifyMesh } from '../shared/modifiers/solidify';
import { assertSurfaceMeshValid, shellMesh } from '../shared/surfaces/mesh';
import { normalOffset } from '../shared/normal-offset';
import type { MeshData } from '../shared/modeling';

test('oblique single-plane offsets remain finite and preserve the requested normal distance', () => {
  const normal = new Vector3(0.28561965208221696, 0.9290682229643294, -0.2350609525683424);
  const offset = normalOffset([normal], 1e-9);
  assert.ok(offset.distanceTo(normal) < 1e-6);
  const rotation = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), normal);
  const mesh: MeshData = {
    kind: 'mesh',
    smooth: false,
    vertices: [
      [-1, 0, -1],
      [-1, 0, 1],
      [1, 0, 1],
      [1, 0, -1],
    ].map((point) => new Vector3(...point).applyQuaternion(rotation).toArray()),
    faces: [[0, 1, 2, 3]],
  };
  const result = solidifyMesh(mesh, {
    id: 'shell',
    enabled: true,
    type: 'solidify',
    thickness: 0.1,
    offset: 0,
  });
  for (let index = 0; index < 4; index++) {
    const separation = new Vector3(...result.vertices[index]).sub(new Vector3(...result.vertices[index + 4]));
    assert.ok(Math.abs(separation.dot(normal) - 0.1) < 1e-7);
  }
  const shell = shellMesh(mesh, 0.1);
  for (let index = 0; index < 4; index++)
    assert.ok(
      Math.abs(
        new Vector3(...mesh.vertices[index]).sub(new Vector3(...shell.vertices[index + 4])).dot(normal) - 0.1,
      ) < 1e-7,
    );
});

test('near-parallel normals retain a short offset while orthogonal corner planes keep their miters', () => {
  const normal = new Vector3(0.23, 0.87, -0.33).normalize();
  const directions = [-1e-7, 0, 1e-7].map((delta) =>
    normal
      .clone()
      .add(new Vector3(delta, 0, -delta))
      .normalize(),
  );
  const offset = normalOffset(directions, 1e-9);
  assert.ok(offset.length() < 1.001);
  assert.ok(directions.every((direction) => Math.abs(direction.dot(offset) - 1) < 1e-7));
  const corner = normalOffset([new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)], 1e-9);
  assert.ok(corner.distanceTo(new Vector3(1, 1, 1)) < 1e-7);
});

test('nearly coplanar swept quad triangles meet only at their shared diagonal', () => {
  const mesh: MeshData = {
    kind: 'mesh',
    smooth: true,
    vertices: [
      [-0.07, 1.4148091184529858, -0.8122241118324498],
      [-0.085, 1.4385377504179093, -0.8043531509588833],
      [-0.085, 1.4546399758903277, -0.8579906707300748],
      [-0.07, 1.430499581934753, -0.8644900075939137],
    ],
    faces: [
      [0, 1, 2],
      [0, 2, 3],
    ],
  };
  assert.doesNotThrow(() => assertSurfaceMeshValid(mesh, { closed: false }));
  const crossed: MeshData = {
    ...mesh,
    vertices: [...mesh.vertices.slice(0, 3), ...mesh.vertices.slice(0, 3)],
    faces: [
      [0, 1, 2],
      [3, 4, 5],
    ],
  };
  assert.throws(() => assertSurfaceMeshValid(crossed, { closed: false }), {
    code: 'SURFACE_SELF_INTERSECTION',
  });
});
