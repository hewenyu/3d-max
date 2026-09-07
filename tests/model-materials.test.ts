import assert from 'node:assert/strict';
import test from 'node:test';
import { Mesh, MeshStandardMaterial } from 'three';
import { createObject } from '../shared/project';
import { modelingSchema, type ModelingData } from '../shared/modeling';
import { primitiveToMesh, modelingToMesh, meshToGeometry } from '../shared/modeling-geometry';
import { buildObject, disposeBuiltObject } from '../src/engine/ObjectFactory';

async function inspect(modeling: ModelingData, flatShading: boolean) {
  const object = { ...createObject('box'), modeling };
  const built = await buildObject(object);
  const reference = meshToGeometry(modelingToMesh(modeling));
  try {
    const mesh = built.root.children[0];
    assert.ok(mesh instanceof Mesh);
    assert.ok(mesh.material instanceof MeshStandardMaterial);
    assert.equal(mesh.material.flatShading, flatShading);
    assert.deepEqual(mesh.geometry.getAttribute('position').array, reference.getAttribute('position').array);
    assert.deepEqual(mesh.geometry.getAttribute('normal').array, reference.getAttribute('normal').array);
    assert.deepEqual(mesh.geometry.getIndex()!.array, reference.getIndex()!.array);
  } finally {
    reference.dispose();
    disposeBuiltObject(built);
  }
}

test('legacy parametric road, tube and terrain keep their original smooth material without changing geometry', async () => {
  for (const profile of ['road', 'tube'])
    await inspect(
      modelingSchema.parse({
        kind: 'curve',
        profile,
        points: [
          [0, 0, 0],
          [2, 0.5, 4],
          [3, 0, 8],
        ],
        segments: 16,
      }),
      false,
    );
  await inspect(
    modelingSchema.parse({
      kind: 'terrain',
      sizeX: 4,
      sizeZ: 4,
      segmentsX: 2,
      segmentsZ: 2,
      heights: [0, 1, 0, 1, 2, 1, 0, 1, 0],
    }),
    false,
  );
});

test('editable mesh materials retain explicit smooth and flat shading', async () => {
  const mesh = primitiveToMesh({ type: 'box', dimensions: [2, 2, 2] });
  await inspect({ ...mesh, smooth: false }, true);
  await inspect({ ...mesh, smooth: true }, false);
});

test('modifier materials honor evaluated smooth and flat subdivision without reverting to base shading', async () => {
  const base = primitiveToMesh({ type: 'box', dimensions: [2, 2, 2] });
  for (const flatOnly of [false, true])
    await inspect(
      modelingSchema.parse({
        kind: 'stack',
        base,
        modifiers: [{ id: 'subdivision', type: 'subdivision', iterations: 1, flatOnly }],
      }),
      flatOnly,
    );
  for (const smooth of [false, true])
    await inspect(
      modelingSchema.parse({
        kind: 'stack',
        base: { ...base, smooth },
        modifiers: [{ id: 'array', type: 'array', count: 2, offset: [3, 0, 0] }],
      }),
      !smooth,
    );
});
