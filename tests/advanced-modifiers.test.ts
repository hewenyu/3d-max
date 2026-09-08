import assert from 'node:assert/strict';
import test from 'node:test';
import { applyCommands } from '../shared/commands';
import { createEmptyProject, createObject } from '../shared/project';
import { meshDataSchema, type MeshData } from '../shared/modeling';
import { meshVolume, modelingToMesh, primitiveToMesh } from '../shared/modeling-geometry';
import { advancedModifierSchema } from '../shared/modifiers/schema';
import { evaluateAdvancedModifier } from '../shared/modifiers/evaluate';
import { orientedManifold } from '../shared/modifiers/mesh-utils';
import { evaluateModifiers } from '../shared/modifier-evaluation';
import { meshModifierSchema } from '../shared/modifier-schema';
import { projectSchema } from '../shared/schema';

const plane: MeshData = {
  kind: 'mesh',
  smooth: false,
  vertices: [
    [-1, 0, -1],
    [1, 0, -1],
    [1, 0, 1],
    [-1, 0, 1],
  ],
  faces: [[0, 3, 2, 1]],
};
const cube = () => primitiveToMesh({ type: 'box', dimensions: [2, 2, 2] });
function modifier(mesh: MeshData, input: Record<string, unknown>) {
  return meshDataSchema.parse(
    evaluateAdvancedModifier(mesh, advancedModifierSchema.parse({ id: 'm', ...input })),
  );
}
function near(actual: number, expected: number, tolerance = 1e-6) {
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} differs from ${expected}`);
}

test('OpenSubdiv consumes polygon control faces and yields closed oriented quad topology', () => {
  const source = cube();
  const result = modifier(source, { type: 'catmull-clark', iterations: 1 });
  assert.equal(result.vertices.length, 26);
  assert.equal(result.faces.length, 24);
  assert.ok(result.faces.every((face) => face.length === 4));
  assert.ok([...orientedManifold(result).values()].every((uses) => uses.length === 2));
  assert.ok(meshVolume(result) > 0 && meshVolume(result) < meshVolume(source));
  assert.deepEqual(source, cube());
  const second = modifier(source, { type: 'catmull-clark', iterations: 2 });
  assert.equal(second.faces.length, 96);
  assert.deepEqual(modifier(source, { type: 'catmull-clark', iterations: 2 }), second);
});

test('OpenSubdiv preserves explicit corners and separately smooths open polygon boundaries', () => {
  const corners = modifier(plane, { type: 'catmull-clark', boundary: 'corners' });
  const smooth = modifier(plane, { type: 'catmull-clark', boundary: 'smooth' });
  for (const vertex of plane.vertices)
    assert.ok(corners.vertices.some((point) => point.every((v, axis) => v === vertex[axis])));
  assert.ok(!smooth.vertices.some((point) => point[0] === -1 && point[2] === -1));
  assert.ok(corners.faces.every((face) => face.length === 4));
  const pentagon: MeshData = {
    kind: 'mesh',
    smooth: false,
    vertices: Array.from({ length: 5 }, (_, index) => [
      Math.cos((index * 2 * Math.PI) / 5),
      0,
      -Math.sin((index * 2 * Math.PI) / 5),
    ]),
    faces: [[0, 1, 2, 3, 4]],
  };
  assert.equal(modifier(pentagon, { type: 'catmull-clark' }).faces.length, 5);
});

test('subdivision rejects non-manifold vertex fans, reversed neighbors and complexity before allocation', () => {
  const disconnected: MeshData = {
    kind: 'mesh',
    smooth: false,
    vertices: [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
      [-1, 0, 0],
      [0, -1, 0],
    ],
    faces: [
      [0, 1, 2],
      [0, 3, 4],
    ],
  };
  assert.throws(() => modifier(disconnected, { type: 'catmull-clark' }), { code: 'MODELING_TOPOLOGY' });
  const reversed = cube();
  reversed.faces[0].reverse();
  assert.throws(() => modifier(reversed, { type: 'catmull-clark' }), { code: 'MODELING_TOPOLOGY' });
  const large: MeshData = { kind: 'mesh', smooth: false, vertices: [], faces: [] };
  for (let index = 0; index < 1600; index++) {
    const start = large.vertices.length;
    large.vertices.push(
      ...plane.vertices.map(
        (point) => [point[0] + index * 3, point[1], point[2]] as [number, number, number],
      ),
    );
    large.faces.push(plane.faces[0].map((vertex) => start + vertex));
  }
  assert.throws(() => modifier(large, { type: 'catmull-clark', iterations: 3 }), { code: 'MODELING_LIMIT' });
});

test('solidify adds correct thickness, rims, orientation and configurable offset to an open plane', () => {
  const source = structuredClone(plane);
  const result = modifier(source, { type: 'solidify', thickness: 0.4, offset: 0 });
  assert.equal(result.vertices.length, 8);
  assert.equal(result.faces.length, 6);
  near(Math.min(...result.vertices.map((point) => point[1])), -0.2);
  near(Math.max(...result.vertices.map((point) => point[1])), 0.2);
  near(meshVolume(result), 1.6);
  assert.ok([...orientedManifold(result).values()].every((uses) => uses.length === 2));
  const inward = modifier(source, { type: 'solidify', thickness: 0.4, offset: -1 });
  assert.deepEqual(inward.vertices.slice(0, 4), source.vertices);
  near(Math.min(...inward.vertices.map((point) => point[1])), -0.4);
  assert.deepEqual(source, plane);
});

test('solidify constructs outward and inward closed cube shells with mitered planar thickness', () => {
  const source = cube();
  const result = modifier(source, { type: 'solidify', thickness: 0.2, offset: -1 });
  assert.equal(result.vertices.length, 16);
  assert.equal(result.faces.length, 12);
  assert.deepEqual(result.vertices.slice(0, 8), source.vertices);
  near(meshVolume(result), 8 - 1.6 ** 3);
  const inner = result.vertices.slice(8);
  near(Math.min(...inner.map((point) => point[0])), -0.8);
  near(Math.max(...inner.map((point) => point[1])), 1.8);
});

test('twist preserves axial position and radial distance with a clamped editable interval', () => {
  const source = cube();
  const result = modifier(source, { type: 'twist', axis: 'y', angle: 90, from: 0, to: 2 });
  source.vertices.forEach((point, index) => {
    near(result.vertices[index][1], point[1]);
    near(Math.hypot(result.vertices[index][0], result.vertices[index][2]), Math.hypot(point[0], point[2]));
    if (point[1] === 0) assert.deepEqual(result.vertices[index], point);
    else {
      near(result.vertices[index][0], point[2]);
      near(result.vertices[index][2], -point[0]);
    }
  });
  assert.throws(() => modifier(source, { type: 'twist', from: 2, to: 1 }), { code: 'MODELING_RANGE' });
});

test('bend samples an actual arc and continues outside the interval along its terminal tangent', () => {
  const source: MeshData = {
    kind: 'mesh',
    smooth: false,
    vertices: [
      [0, 0, 0],
      [0, 2, 0],
      [0, 3, 0],
      [0, 3, 1],
      [0, 0, 1],
    ],
    faces: [[0, 1, 2, 3, 4]],
  };
  const result = modifier(source, { type: 'bend', axis: 'y', direction: 'x', angle: 90, from: 0, to: 2 });
  const radius = 4 / Math.PI;
  near(result.vertices[1][0], radius);
  near(result.vertices[1][1], radius);
  near(result.vertices[2][0], radius + 1);
  near(result.vertices[2][1], radius);
  assert.throws(() => modifier(source, { type: 'bend', axis: 'x', direction: 'x' }), {
    code: 'MODELING_RANGE',
  });
  assert.throws(() => modifier(cube(), { type: 'bend', angle: 180, from: 0, to: 1 }), {
    code: 'MODELING_COLLAPSE',
  });
  assert.deepEqual(modifier(cube(), { type: 'bend', angle: 0 }), cube());
});

test('curve arrays follow arc length, preserve independent copies and optionally orient the source axis', () => {
  const source = cube();
  const result = modifier(source, {
    type: 'curve-array',
    count: 3,
    axis: 'x',
    orient: true,
    points: [
      [0, 0, 0],
      [0, 0, 10],
    ],
  });
  assert.equal(result.vertices.length, 24);
  assert.equal(result.faces.length, 18);
  for (let index = 0; index < source.vertices.length; index++) {
    near(result.vertices[index][2], source.vertices[index][0]);
    near(result.vertices[index + 8][2] - result.vertices[index][2], 5);
    near(result.vertices[index + 16][2] - result.vertices[index][2], 10);
  }
  near(meshVolume(result), 24);
  const fixed = modifier(source, {
    type: 'curve-array',
    count: 2,
    orient: false,
    points: [
      [2, 0, 0],
      [2, 5, 3],
    ],
  });
  assert.deepEqual(fixed.vertices[0], [
    source.vertices[0][0] + 2,
    source.vertices[0][1],
    source.vertices[0][2],
  ]);
  assert.throws(
    () =>
      modifier(source, {
        type: 'curve-array',
        points: [
          [0, 0, 0],
          [0, 0, 0],
        ],
      }),
    { code: 'MODELING_PATH' },
  );
  assert.throws(
    () =>
      modifier(source, {
        type: 'curve-array',
        closed: true,
        points: [
          [0, 0, 0],
          [0, 0, 1],
        ],
      }),
    { code: 'MODELING_PATH' },
  );
});

test('welded mirror joins seam vertices and removes opposed seam faces into a closed solid', () => {
  const half = cube();
  half.vertices.forEach((vertex) => {
    vertex[0] += 1;
  });
  const result = evaluateModifiers(half, [
    meshModifierSchema.parse({ id: 'mirror', type: 'mirror', axis: 'x', offset: 0, weldThreshold: 0.001 }),
  ]);
  assert.equal(result.vertices.length, 12);
  assert.equal(result.faces.length, 10);
  near(meshVolume(result), 16);
  assert.ok([...orientedManifold(result).values()].every((uses) => uses.length === 2));
  assert.throws(
    () =>
      evaluateModifiers(cube(), [
        meshModifierSchema.parse({
          id: 'mirror',
          type: 'mirror',
          axis: 'x',
          offset: 0,
          weldThreshold: 0.001,
        }),
      ]),
    { code: 'MODELING_TOPOLOGY' },
  );
});

test('advanced modifier source parameters survive project roundtrip and atomic failure without mutation', () => {
  const original = createEmptyProject('Advanced modifiers');
  original.objects.push({ ...createObject('box'), id: 'box', dimensions: [2, 2, 2] });
  let project = applyCommands(original, [
    {
      type: 'modifier.add',
      payload: { id: 'box', modifier: { id: 'cc', type: 'catmull-clark', iterations: 2 } },
    },
  ]).project;
  const before = modelingToMesh(project.objects[0].modeling!);
  const restored = projectSchema.parse(JSON.parse(JSON.stringify(project)));
  assert.deepEqual(modelingToMesh(restored.objects[0].modeling!), before);
  const snapshot = structuredClone(project);
  assert.throws(
    () =>
      applyCommands(project, [
        {
          type: 'modifier.set',
          payload: { id: 'box', modifier: { id: 'cc', type: 'bend', from: 2, to: 1 } },
        },
      ]),
    { code: 'MODELING_RANGE' },
  );
  assert.deepEqual(project, snapshot);
  project = applyCommands(project, [{ type: 'modifier.bake', payload: { id: 'box' } }]).project;
  assert.equal(project.objects[0].modeling!.kind, 'mesh');
  assert.deepEqual(modelingToMesh(project.objects[0].modeling!), before);
  assert.equal(original.objects[0].modeling, undefined);
});
