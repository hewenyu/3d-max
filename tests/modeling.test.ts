import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyProject, createObject } from '../shared/project';
import { applyCommands } from '../shared/commands';
import type { Project, SceneObject } from '../shared/types';
import {
  applyModelingCommand,
  curveDataSchema,
  meshDataSchema,
  modelingCommandDefinitions,
  terrainDataSchema,
  type MeshData,
  type ModelingData,
} from '../shared/modeling';
import {
  curveToMesh,
  meshToGeometry,
  meshVolume,
  primitiveToMesh,
  terrainHeight,
  terrainToMesh,
} from '../shared/modeling-geometry';

type ModelObject = SceneObject & { modeling?: ModelingData };
function fixture() {
  const project = createEmptyProject('Modeling tests');
  const object: ModelObject = { ...createObject('box'), id: 'target', dimensions: [2, 2, 2] };
  project.objects.push(object);
  return { project, object };
}
function edit(project: Project, type: string, payload: Record<string, unknown>) {
  const definition = modelingCommandDefinitions.find((item) => item.type === type)!;
  return applyModelingCommand(project, { type, payload: definition.schema.parse(payload) });
}
function volume(object: ModelObject) {
  return meshVolume(object.modeling as MeshData);
}
function close(actual: number, expected: number, tolerance = 0.00001) {
  assert.ok(Math.abs(actual - expected) < tolerance, `Expected ${actual} to equal ${expected}`);
}

test('indexed mesh conversion and polygon extrusion preserve connected side faces and solid volume', () => {
  const { project, object } = fixture();
  edit(project, 'mesh.convert', { id: object.id });
  const initial = object.modeling as MeshData;
  assert.equal(initial.vertices.length, 8);
  assert.equal(initial.faces.length, 6);
  close(volume(object), 8);
  edit(project, 'mesh.face.extrude', { id: object.id, faceIndex: 4, distance: 1 });
  const extruded = object.modeling as MeshData;
  assert.equal(extruded.vertices.length, 12);
  assert.equal(extruded.faces.length, 10);
  close(volume(object), 12);
  close(object.dimensions[1], 3);
  edit(project, 'mesh.vertex.set', { id: object.id, index: 0, position: [-1.2, 0, -1] });
  assert.deepEqual((object.modeling as MeshData).vertices[0], [-1.2, 0, -1]);
  assert.ok((object.modeling as MeshData).faces.filter((face) => face.includes(0)).length >= 3);
});

test('proven CSG evaluates union, subtraction and intersection in object-local coordinates', () => {
  for (const [operation, expected] of [
    ['union', 12],
    ['subtract', 4],
    ['intersect', 4],
  ] as const) {
    const { project, object } = fixture();
    const operand = {
      ...createObject('box'),
      id: 'operand',
      dimensions: [2, 2, 2] as [number, number, number],
      position: [1, 0, 0] as [number, number, number],
    };
    project.objects.push(operand);
    edit(project, 'mesh.boolean', { id: object.id, operandId: operand.id, operation, keepOperand: false });
    close(volume(object), expected);
    assert.equal(object.modeling?.kind, 'mesh');
    assert.equal(operand.visible, false);
  }
});

test('Boolean operation includes parent transforms and respects locked secondary effects', () => {
  const { project, object } = fixture();
  const parent = { ...createObject('group'), id: 'parent', position: [10, 0, 0] as [number, number, number] };
  object.parentId = parent.id;
  const operand = {
    ...createObject('box'),
    id: 'operand',
    position: [11, 0, 0] as [number, number, number],
    dimensions: [2, 2, 2] as [number, number, number],
    locked: true,
  };
  project.objects.push(parent, operand);
  assert.throws(
    () =>
      edit(project, 'mesh.boolean', {
        id: object.id,
        operandId: operand.id,
        operation: 'union',
        keepOperand: false,
      }),
    { code: 'LOCKED' },
  );
  assert.equal(object.modeling, undefined);
  edit(project, 'mesh.boolean', { id: object.id, operandId: operand.id, operation: 'union' });
  close(volume(object), 12);
  assert.equal(operand.visible, true);
});

test('Boolean results with split edges remain usable in subsequent solid operations', () => {
  const { project, object } = fixture();
  const operand = {
    ...createObject('box'),
    id: 'operand',
    dimensions: [2, 2, 2] as [number, number, number],
    position: [1, 0, 0] as [number, number, number],
  };
  project.objects.push(operand);
  edit(project, 'mesh.boolean', { id: object.id, operandId: operand.id, operation: 'union' });
  close(volume(object), 12);
  edit(project, 'mesh.boolean', { id: object.id, operandId: operand.id, operation: 'subtract' });
  close(volume(object), 4);
  edit(project, 'mesh.boolean', { id: object.id, operandId: operand.id, operation: 'union' });
  close(volume(object), 12);
  edit(project, 'mesh.face.delete', { id: object.id, faceIndex: 0 });
  assert.throws(
    () => edit(project, 'mesh.boolean', { id: object.id, operandId: operand.id, operation: 'intersect' }),
    /closed/,
  );
});

test('open or invalid meshes are rejected before Boolean evaluation', () => {
  const { project, object } = fixture();
  const operand = { ...createObject('box'), id: 'operand' };
  project.objects.push(operand);
  edit(project, 'mesh.convert', { id: object.id });
  edit(project, 'mesh.face.delete', { id: object.id, faceIndex: 0 });
  assert.throws(
    () => edit(project, 'mesh.boolean', { id: object.id, operandId: operand.id, operation: 'union' }),
    /closed/,
  );
  assert.throws(() =>
    meshDataSchema.parse({
      kind: 'mesh',
      vertices: [
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
      ],
      faces: [[0, 1, 9]],
    }),
  );
  assert.throws(
    () =>
      meshToGeometry({
        kind: 'mesh',
        smooth: false,
        vertices: [
          [0, 0, 0],
          [1, 0, 0],
          [2, 0, 0],
        ],
        faces: [[0, 1, 2]],
      }),
    /zero area/,
  );
});

test('successive curved arch cuts preserve a closed solid across coordinate scales', () => {
  for (const scale of [0.1, 1, 10]) {
    const project = createEmptyProject('Repeated curved cuts');
    const gate: ModelObject = {
      ...createObject('box'),
      id: 'gate',
      dimensions: [28 * scale, 18 * scale, 4 * scale],
      position: [0, 0, 80 * scale],
    };
    const round = {
      ...createObject('cylinder'),
      id: 'round',
      dimensions: [12 * scale, 6 * scale, 12 * scale] as [number, number, number],
      position: [0, 8 * scale, 77 * scale] as [number, number, number],
      rotation: [90, 0, 0] as [number, number, number],
    };
    const opening = {
      ...createObject('box'),
      id: 'opening',
      dimensions: [12 * scale, 8.2 * scale, 6 * scale] as [number, number, number],
      position: [0, -0.1 * scale, 80 * scale] as [number, number, number],
    };
    project.objects.push(gate, round, opening);
    edit(project, 'mesh.boolean', { id: gate.id, operandId: round.id, operation: 'subtract' });
    const roundVolume = volume(gate) / scale ** 3;
    assert.ok(roundVolume > 1560 && roundVolume < 1580);
    edit(project, 'mesh.boolean', { id: gate.id, operandId: opening.id, operation: 'subtract' });
    const archVolume = volume(gate) / scale ** 3;
    assert.ok(archVolume > 1400 && archVolume < 1420, `Arch volume ${archVolume}`);
    edit(project, 'mesh.boolean', { id: gate.id, operandId: opening.id, operation: 'union' });
    assert.ok(volume(gate) / scale ** 3 > archVolume);
    edit(project, 'mesh.face.delete', { id: gate.id, faceIndex: 0 });
    assert.throws(
      () => edit(project, 'mesh.boolean', { id: gate.id, operandId: round.id, operation: 'subtract' }),
      /closed/,
    );
  }
});

test('curve roads and capped tubes produce outward oriented editable solids', () => {
  const road = curveDataSchema.parse({
    kind: 'curve',
    points: [
      [0, 0, 0],
      [0, 0, 10],
    ],
    profile: 'road',
    width: 4,
    thickness: 0.2,
    segments: 8,
  });
  close(meshVolume(curveToMesh(road)), 8);
  const tube = curveDataSchema.parse({
    kind: 'curve',
    points: [
      [0, 0, 0],
      [0, 0, 10],
    ],
    profile: 'tube',
    radius: 1,
    radialSegments: 32,
    segments: 8,
  });
  close(meshVolume(curveToMesh(tube)), Math.PI * 10, 0.21);
  const closed = curveDataSchema.parse({
    kind: 'curve',
    points: [
      [-10, 0, -10],
      [10, 0, -10],
      [10, 0, 10],
      [-10, 0, 10],
    ],
    closed: true,
    profile: 'road',
    width: 2,
    thickness: 0.2,
    segments: 32,
  });
  assert.ok(meshVolume(curveToMesh(closed)) > 20);
});

test('terrain stores explicit deterministic elevations and resamples editable grids', () => {
  const { project, object } = fixture();
  edit(project, 'terrain.set', {
    id: object.id,
    terrain: { sizeX: 20, sizeZ: 20, segmentsX: 2, segmentsZ: 2, heights: [0, 0, 0, 0, 4, 0, 0, 0, 0] },
  });
  const terrain = object.modeling as ReturnType<typeof terrainDataSchema.parse>;
  close(terrainHeight(terrain, 0, 0), 4);
  close(terrainHeight(terrain, 5, 0), 2);
  assert.ok(meshVolume(terrainToMesh(terrain)) > 400);
  edit(project, 'terrain.set', {
    id: object.id,
    terrain: { sizeX: 20, sizeZ: 20, segmentsX: 4, segmentsZ: 4 },
  });
  const sampled = object.modeling as ReturnType<typeof terrainDataSchema.parse>;
  assert.equal(sampled.heights.length, 25);
  close(sampled.heights[12], 4);
  const before = structuredClone(project);
  edit(project, 'terrain.sculpt', { id: object.id, center: [0, 0], radius: 8, amount: 2, mode: 'raise' });
  edit(before, 'terrain.sculpt', { id: object.id, center: [0, 0], radius: 8, amount: 2, mode: 'raise' });
  assert.deepEqual(object.modeling, (before.objects[0] as ModelObject).modeling);
  close((object.modeling as ReturnType<typeof terrainDataSchema.parse>).heights[12], 6);
  edit(project, 'terrain.point.set', { id: object.id, row: 2, column: 2, height: 7 });
  close((object.modeling as ReturnType<typeof terrainDataSchema.parse>).heights[12], 7);
  assert.throws(() => terrainDataSchema.parse({ ...sampled, heights: [0, 0, 0, 0] }));
});

test('converted sphere and cylinder retain positive solid volumes', () => {
  for (const type of ['sphere', 'cylinder'] as const) {
    const mesh = primitiveToMesh({ type, dimensions: [2, 2, 2] });
    const expected = type === 'sphere' ? (4 / 3) * Math.PI : 2 * Math.PI;
    close(meshVolume(mesh), expected, 0.12);
  }
});

test('public domain commands persist modeling data and roll back an entire invalid edit batch', () => {
  const { project, object } = fixture();
  const converted = applyCommands(project, [{ type: 'mesh.convert', payload: { id: object.id } }]).project;
  assert.equal(converted.objects[0].modeling?.kind, 'mesh');
  assert.equal(project.objects[0].modeling, undefined);
  const before = structuredClone(converted);
  assert.throws(
    () =>
      applyCommands(converted, [
        { type: 'mesh.face.extrude', payload: { id: object.id, faceIndex: 4, distance: 1 } },
        { type: 'mesh.vertex.set', payload: { id: object.id, index: 999, position: [0, 0, 0] } },
      ]),
    { code: 'NOT_FOUND' },
  );
  assert.deepEqual(converted, before);
  converted.objects[0].locked = true;
  assert.throws(
    () =>
      applyCommands(converted, [
        { type: 'mesh.face.extrude', payload: { id: object.id, faceIndex: 4, distance: 1 } },
      ]),
    { code: 'LOCKED' },
  );
});
