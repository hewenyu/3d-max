import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Document, Format, NodeIO, type GLTF } from '@gltf-transform/core';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { buildObject, disposeBuiltObject } from '../src/engine/ObjectFactory';
import { assetByteLimit } from '../server/assets';
import { prepareDirectories, type ServerConfig } from '../server/config';
import { ApiError } from '../server/errors';
import { exportModelAsset, planModelConversion } from '../server/modeling-assets';
import { Store } from '../server/store';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'whiteframe-modeling-assets-'));
  const config: ServerConfig = {
    dataDir: directory,
    port: 0,
    apiUrl: 'http://127.0.0.1',
    appUrl: 'http://127.0.0.1',
    distDir: directory,
  };
  prepareDirectories(config);
  const store = new Store(directory);
  store.newProject('Model asset testing', 'empty');
  const guard = () => {
    const project = store.project();
    return {
      projectId: project.id,
      expectedRevision: project.revision,
      expectedContext: {
        sceneId: project.production?.activeSceneId ?? null,
        performanceId: project.production?.activePerformanceId ?? null,
      },
    };
  };
  const assetCount = () =>
    (store.db.prepare('SELECT COUNT(*) count FROM assets').get() as { count: number }).count;
  return {
    directory,
    config,
    store,
    guard,
    assetCount,
    close: async () => {
      store.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function sourceDocument() {
  const document = new Document();
  const buffer = document.createBuffer();
  const geometry = new THREE.BoxGeometry(2, 2, 2);
  const accessor = (name: string, attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute) =>
    document
      .createAccessor(name)
      .setType(attribute.itemSize === 3 ? 'VEC3' : 'VEC2')
      .setArray(Float32Array.from(attribute.array))
      .setBuffer(buffer);
  const primitive = document
    .createPrimitive()
    .setAttribute('POSITION', accessor('positions', geometry.getAttribute('position')))
    .setAttribute('NORMAL', accessor('normals', geometry.getAttribute('normal')))
    .setAttribute('TEXCOORD_0', accessor('uv', geometry.getAttribute('uv')))
    .setIndices(
      document
        .createAccessor()
        .setType('SCALAR')
        .setArray(Uint16Array.from(geometry.index!.array))
        .setBuffer(buffer),
    )
    .setMaterial(document.createMaterial('Source material').setBaseColorFactor([0.2, 0.5, 0.8, 1]));
  geometry.dispose();
  const mesh = document.createMesh('source-cube').addPrimitive(primitive);
  const parent = document.createNode('parent').setTranslation([3, 2, -4]).setScale([2, 1, 1]);
  parent.addChild(document.createNode('left').setMesh(mesh).setTranslation([0, 0, 0]));
  parent.addChild(
    document.createNode('right-mirrored').setMesh(mesh).setTranslation([3, 1, 0]).setScale([-1, 1, 1]),
  );
  document.getRoot().setDefaultScene(document.createScene('source-scene').addChild(parent));
  return document;
}

async function sourceBytes(binary: boolean, patch?: (json: GLTF.IGLTF) => void) {
  const io = new NodeIO();
  const document = sourceDocument();
  if (binary && !patch) return Buffer.from(await io.writeBinary(document));
  const encoded = await io.writeJSON(document, { format: Format.GLTF });
  for (const buffer of encoded.json.buffers ?? []) {
    const bytes = encoded.resources[buffer.uri!];
    buffer.uri = `data:application/octet-stream;base64,${Buffer.from(bytes).toString('base64')}`;
  }
  patch?.(encoded.json);
  return Buffer.from(JSON.stringify(encoded.json));
}

async function installModel(
  f: Awaited<ReturnType<typeof fixture>>,
  bytes: Buffer,
  binary: boolean,
  id = 'source',
) {
  const extension = binary ? '.glb' : '.gltf';
  const path = join(f.directory, 'assets', id + extension);
  await writeFile(path, bytes);
  f.store.addAsset({
    id,
    name: id + extension,
    path,
    mime: binary ? 'model/gltf-binary' : 'model/gltf+json',
    size: bytes.length,
    url: `/api/assets/${id}/file`,
  });
  f.store.commands({
    commands: [
      {
        type: 'object.create',
        payload: {
          id,
          name: 'Imported source',
          type: 'model',
          assetUrl: `/api/assets/${id}/file`,
          dimensions: [4, 5, 6],
          animationIndex: null,
        },
      },
    ],
  });
  return path;
}

const approximate = (actual: number[], expected: number[], tolerance = 0.00001) => {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, index) =>
    assert.ok(Math.abs(value - expected[index]) <= tolerance, `${value} != ${expected[index]}`),
  );
};
const sortedPoints = (points: number[][]) =>
  points
    .map((point) => point.map((value) => Math.round(value * 100000) / 100000))
    .sort((left, right) => left[0] - right[0] || left[1] - right[1] || left[2] - right[2]);

for (const binary of [true, false])
  test(`static ${binary ? 'GLB' : 'glTF'} conversion matches rendered hierarchy fit and preserves source`, async () => {
    const f = await fixture();
    try {
      const bytes = await sourceBytes(binary);
      const path = await installModel(f, bytes, binary);
      const before = f.store.project();
      const result = await planModelConversion(f.store, { ...f.guard(), objectId: 'source' });
      assert.deepEqual(f.store.project(), before);
      assert.equal(result.sourcePreserved, true);
      assert.equal(result.asset.sha256, createHash('sha256').update(bytes).digest('hex'));
      assert.deepEqual(await readFile(path), bytes);
      assert.equal(result.mesh.vertices.length, 48);
      assert.equal(result.mesh.faces.length, 24);
      assert.ok(result.diagnostics.some((item) => item.attributes?.includes('TEXCOORD_0')));
      assert.ok(result.diagnostics.some((item) => item.code === 'WHITE_MATERIAL'));
      assert.ok(result.diagnostics.some((item) => item.code === 'FLATTENED_STATIC_SCENE'));
      const glb = await new NodeIO().writeBinary(sourceDocument());
      const rendered = await new GLTFLoader().parseAsync(
        glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength) as ArrayBuffer,
        '',
      );
      rendered.scene.updateMatrixWorld(true);
      const bounds = new THREE.Box3().setFromObject(rendered.scene);
      const dimensions = bounds.getSize(new THREE.Vector3());
      const center = bounds.getCenter(new THREE.Vector3());
      const fit = Math.min(4 / dimensions.x, 5 / dimensions.y, 6 / dimensions.z);
      const expected: number[][] = [];
      rendered.scene.traverse((node) => {
        if (!(node instanceof THREE.Mesh)) return;
        const positions = node.geometry.getAttribute('position');
        for (let index = 0; index < positions.count; index++) {
          const point = new THREE.Vector3()
            .fromBufferAttribute(positions, index)
            .applyMatrix4(node.matrixWorld);
          expected.push([
            (point.x - center.x) * fit,
            (point.y - bounds.min.y) * fit,
            (point.z - center.z) * fit,
          ]);
        }
        node.geometry.dispose();
      });
      assert.deepEqual(sortedPoints(result.mesh.vertices), sortedPoints(expected));
      let signedVolume = 0;
      for (const face of result.mesh.faces) {
        const [a, b, c] = face.map((index) => new THREE.Vector3(...result.mesh.vertices[index]));
        signedVolume += a.dot(b.cross(c)) / 6;
      }
      assert.ok(signedVolume > 0, 'mirrored nodes retain outward triangle winding');
      f.store.commands({
        ...f.guard(),
        commands: [
          {
            type: 'mesh.set',
            payload: {
              id: 'source',
              mesh: { vertices: result.mesh.vertices, faces: result.mesh.faces, smooth: result.mesh.smooth },
            },
          },
        ],
      });
      assert.equal(f.store.project().objects[0].modeling?.kind, 'mesh');
      assert.ok(f.store.asset('source'));
      f.store.travel(-1);
      assert.equal(f.store.project().objects[0].assetUrl, '/api/assets/source/file');
    } finally {
      await f.close();
    }
  });

test('static conversion rejects skin, animation, morph, extensions and non-triangle primitives without mutation', async () => {
  const f = await fixture();
  try {
    const cases: { code: string; patch: (json: GLTF.IGLTF) => void }[] = [
      {
        code: 'SKINNED_MODEL',
        patch: (json) => {
          json.skins = [{ joints: [0] }];
        },
      },
      {
        code: 'ANIMATED_MODEL',
        patch: (json) => {
          json.animations = [{ channels: [], samplers: [] }];
        },
      },
      {
        code: 'MORPH_TARGETS',
        patch: (json) => {
          json.meshes![0].primitives[0].targets = [{ POSITION: 0 }];
        },
      },
      {
        code: 'MODEL_EXTENSIONS',
        patch: (json) => {
          json.extensionsUsed = ['EXT_unknown_geometry'];
        },
      },
      {
        code: 'PRIMITIVE_MODE',
        patch: (json) => {
          json.meshes![0].primitives[0].mode = 1;
        },
      },
    ];
    for (const [index, item] of cases.entries()) {
      const id = `incompatible-${index}`;
      const bytes = await sourceBytes(false, item.patch);
      const path = await installModel(f, bytes, false, id);
      const before = f.store.project();
      await assert.rejects(planModelConversion(f.store, { ...f.guard(), objectId: id }), (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.code, 'MODELING_ASSET_UNSUPPORTED');
        assert.ok(
          (error.details as { diagnostics: { code: string }[] }).diagnostics.some(
            (diagnostic) => diagnostic.code === item.code,
          ),
        );
        return true;
      });
      assert.deepEqual(f.store.project(), before);
      assert.deepEqual(await readFile(path), bytes);
    }
  } finally {
    await f.close();
  }
});

test('selected GLB export uses real factory geometry, evaluated modifiers and sampled parent world transforms', async () => {
  const f = await fixture();
  try {
    f.store.commands({
      commands: [
        {
          type: 'object.create',
          payload: {
            id: 'parent',
            type: 'group',
            position: [5, 0, -2],
            rotation: [0, 90, 0],
            scale: [2, 1, 1],
          },
        },
        {
          type: 'object.create',
          payload: {
            id: 'shape',
            type: 'sphere',
            parentId: 'parent',
            dimensions: [2, 3, 2],
            position: [1, 0, 0],
          },
        },
        {
          type: 'object.create',
          payload: {
            id: 'modeled',
            type: 'box',
            parentId: 'parent',
            dimensions: [1, 2, 1],
            position: [0, 0, 3],
          },
        },
        {
          type: 'modifier.add',
          payload: { id: 'modeled', modifier: { id: 'smooth', type: 'catmull-clark', iterations: 1 } },
        },
        { type: 'object.create', payload: { id: 'hidden', type: 'box', visible: false } },
        {
          type: 'object.keyframe.set',
          payload: { id: 'parent', keyframe: { time: 2, position: [9, 0, -2] } },
        },
      ],
    });
    const before = f.store.project();
    const response = await exportModelAsset(f.store, f.config, {
      ...f.guard(),
      scope: 'selection',
      objectIds: ['parent'],
      sourceTime: 2,
    });
    assert.deepEqual(f.store.project(), before);
    assert.deepEqual(response.objectIds, ['shape', 'modeled']);
    const asset = f.store.asset(response.id)!;
    const bytes = await readFile(asset.path);
    assert.equal(bytes.toString('ascii', 0, 4), 'glTF');
    assert.equal(bytes.readUInt32LE(8), bytes.length);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), response.sha256);
    const document = await new NodeIO().readBinary(bytes);
    assert.equal(document.getRoot().listMeshes().length, 2);
    const exported = document
      .getRoot()
      .listMeshes()
      .find((mesh) => mesh.getExtras().whiteframeObjectId === 'shape')!;
    const positions = exported.listPrimitives()[0].getAttribute('POSITION')!;
    const factory = await buildObject(before.objects.find((object) => object.id === 'shape')!);
    try {
      const mesh = factory.root.children[0] as THREE.Mesh;
      assert.equal(positions.getCount(), mesh.geometry.getAttribute('position').count);
      factory.root.updateMatrixWorld(true);
      const world = new THREE.Matrix4()
        .compose(
          new THREE.Vector3(9, 0, -2),
          new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI / 2, 0)),
          new THREE.Vector3(2, 1, 1),
        )
        .multiply(new THREE.Matrix4().makeTranslation(1, 0, 0))
        .multiply(mesh.matrixWorld);
      const point = new THREE.Vector3()
        .fromBufferAttribute(mesh.geometry.getAttribute('position'), 17)
        .applyMatrix4(world);
      approximate(positions.getElement(17, []), point.toArray());
    } finally {
      disposeBuiltObject(factory);
    }
    assert.ok(response.triangles > 1000);
    assert.ok(
      document
        .getRoot()
        .listMeshes()
        .find((mesh) => mesh.getExtras().whiteframeObjectId === 'modeled')!
        .listPrimitives()[0]
        .getIndices()!
        .getCount() > 36,
    );
    assert.equal(document.getRoot().listTextures().length, 0);
    const sceneExport = await exportModelAsset(f.store, f.config, { ...f.guard(), scope: 'scene' });
    assert.deepEqual(sceneExport.hiddenObjectIds, ['hidden']);
    const explicitHidden = await exportModelAsset(f.store, f.config, {
      ...f.guard(),
      scope: 'selection',
      objectIds: ['hidden'],
      includeHidden: true,
    });
    assert.deepEqual(explicitHidden.objectIds, ['hidden']);
  } finally {
    await f.close();
  }
});

test('static imported models and procedural furniture export without losing requested objects', async () => {
  const f = await fixture();
  try {
    await installModel(f, await sourceBytes(true), true);
    f.store.commands({ commands: [{ type: 'object.create', payload: { id: 'chair', type: 'chair' } }] });
    const exported = await exportModelAsset(f.store, f.config, { ...f.guard(), scope: 'scene' });
    assert.deepEqual(exported.objectIds, ['source', 'chair']);
    const document = await new NodeIO().read(f.store.asset(exported.id)!.path);
    assert.equal(document.getRoot().listMeshes().length, 2);
    assert.ok(
      document
        .getRoot()
        .listMeshes()
        .find((mesh) => mesh.getExtras().whiteframeObjectId === 'chair')!
        .listPrimitives().length > 1,
    );
    assert.ok(f.store.asset('source'));
  } finally {
    await f.close();
  }
});

test('selected GLB evaluates hidden Boolean dependencies from base transforms after edits and undo', async () => {
  const f = await fixture();
  try {
    f.store.commands({
      commands: [
        { type: 'object.create', payload: { id: 'target', type: 'box', dimensions: [2, 2, 2] } },
        {
          type: 'object.create',
          payload: { id: 'parent', type: 'group', position: [1, 0, 0], visible: false },
        },
        {
          type: 'object.create',
          payload: { id: 'cutter', type: 'box', dimensions: [2, 2, 2], parentId: 'parent', visible: false },
        },
        {
          type: 'object.keyframe.set',
          payload: { id: 'cutter', keyframe: { time: 2, position: [20, 0, 0] } },
        },
        {
          type: 'modifier.add',
          payload: {
            id: 'target',
            modifier: { id: 'cut', type: 'boolean', operandId: 'cutter', operation: 'subtract' },
          },
        },
      ],
    });
    const retained = structuredClone(
      f.store.project().objects.find((object) => object.id === 'target')!.modeling,
    );
    const volume = async () => {
      const exported = await exportModelAsset(f.store, f.config, {
        ...f.guard(),
        scope: 'selection',
        objectIds: ['target'],
        sourceTime: 2,
      });
      assert.deepEqual(exported.objectIds, ['target']);
      const document = await new NodeIO().read(f.store.asset(exported.id)!.path);
      let result = 0;
      for (const mesh of document.getRoot().listMeshes()) {
        for (const primitive of mesh.listPrimitives()) {
          const position = primitive.getAttribute('POSITION')!;
          const indices = primitive.getIndices()!;
          for (let index = 0; index < indices.getCount(); index += 3) {
            const vertices = [0, 1, 2].map((offset) =>
              new THREE.Vector3().fromArray(position.getElement(indices.getScalar(index + offset), [])),
            );
            result += vertices[0].dot(vertices[1].cross(vertices[2])) / 6;
          }
        }
      }
      return Math.abs(result);
    };
    approximate([await volume()], [4]);
    f.store.commands({
      commands: [{ type: 'object.update', payload: { id: 'parent', patch: { position: [0.5, 0, 0] } } }],
    });
    approximate([await volume()], [2]);
    f.store.travel(-1);
    approximate([await volume()], [4]);
    assert.deepEqual(f.store.project().objects.find((object) => object.id === 'target')!.modeling, retained);
  } finally {
    await f.close();
  }
});

test('export rejects unsupported rigs, invalid selection, cancellation and stale context without producing assets', async () => {
  const f = await fixture();
  try {
    f.store.commands({
      commands: [
        { type: 'object.create', payload: { id: 'supported', type: 'box' } },
        { type: 'object.create', payload: { id: 'rig', type: 'actor' } },
      ],
    });
    const before = f.store.project();
    await assert.rejects(
      exportModelAsset(f.store, f.config, { ...f.guard(), scope: 'scene' }),
      (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.code, 'MODELING_ASSET_UNSUPPORTED');
        assert.equal(
          (error.details as { diagnostics: { objectId: string }[] }).diagnostics[0].objectId,
          'rig',
        );
        return true;
      },
    );
    await assert.rejects(
      exportModelAsset(f.store, f.config, { ...f.guard(), scope: 'selection', objectIds: ['missing'] }),
      /unavailable/,
    );
    await assert.rejects(
      exportModelAsset(f.store, f.config, { ...f.guard(), scope: 'selection' }),
      /requires objectIds/,
    );
    await assert.rejects(
      exportModelAsset(f.store, f.config, {
        ...f.guard(),
        expectedContext: { sceneId: 'wrong', performanceId: null },
        scope: 'scene',
      }),
      /scene or performance/,
    );
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      exportModelAsset(
        f.store,
        f.config,
        { ...f.guard(), scope: 'selection', objectIds: ['supported'] },
        { signal: controller.signal },
      ),
      /cancelled/,
    );
    assert.deepEqual(f.store.project(), before);
    assert.equal(f.assetCount(), 0);
    assert.deepEqual(await readdir(join(f.directory, 'assets')), []);
  } finally {
    await f.close();
  }
});

test('concurrent edits or cancellation at final storage roll back generated asset metadata and files', async () => {
  const f = await fixture();
  try {
    f.store.commands({ commands: [{ type: 'object.create', payload: { id: 'shape', type: 'box' } }] });
    for (const cancellation of [false, true]) {
      const controller = new AbortController();
      const before = f.store.project();
      await assert.rejects(
        exportModelAsset(
          f.store,
          f.config,
          { ...f.guard(), scope: 'scene' },
          {
            signal: controller.signal,
            onProgress: ({ stage }) => {
              if (stage !== 'storing') return;
              if (cancellation) controller.abort();
              else
                f.store.commands({
                  commands: [
                    { type: 'object.update', payload: { id: 'shape', patch: { name: 'Concurrent edit' } } },
                  ],
                });
            },
          },
        ),
        cancellation ? /cancelled/ : /project changed/,
      );
      assert.equal(f.assetCount(), 0);
      assert.deepEqual(await readdir(join(f.directory, 'assets')), []);
      assert.equal(f.store.project().revision, before.revision + Number(!cancellation));
    }
  } finally {
    await f.close();
  }
});

test('conversion enforces stored-only resources, exact size limit, locks and guarded revisions', async () => {
  const f = await fixture();
  try {
    const bytes = await sourceBytes(false, (json) => {
      json.buffers![0].uri = '/etc/passwd';
    });
    const path = await installModel(f, bytes, false);
    await assert.rejects(
      planModelConversion(f.store, { ...f.guard(), objectId: 'source' }),
      /embedded|local/,
    );
    await writeFile(path, await sourceBytes(false));
    const stale = f.guard();
    f.store.commands({
      commands: [{ type: 'object.update', payload: { id: 'source', patch: { locked: true } } }],
    });
    await assert.rejects(planModelConversion(f.store, { ...stale, objectId: 'source' }), /project changed/);
    await assert.rejects(planModelConversion(f.store, { ...f.guard(), objectId: 'source' }), /Unlock/);
    f.store.commands({
      commands: [{ type: 'object.update', payload: { id: 'source', patch: { locked: false } } }],
    });
    await truncate(path, assetByteLimit + 1);
    await assert.rejects(planModelConversion(f.store, { ...f.guard(), objectId: 'source' }), /100 MiB/);
  } finally {
    await f.close();
  }
});

test('an unused external image cannot bypass the combined resource byte limit', async () => {
  const f = await fixture();
  try {
    const imagePath = join(f.directory, 'assets', 'large-image.png');
    await writeFile(imagePath, Buffer.alloc(0));
    await truncate(imagePath, assetByteLimit);
    f.store.addAsset({
      id: 'large-image',
      name: 'large-image.png',
      path: imagePath,
      mime: 'image/png',
      size: assetByteLimit,
      url: '/api/assets/large-image/file',
    });
    const bytes = await sourceBytes(false, (json) => {
      json.images = [{ uri: '/api/assets/large-image/file' }];
    });
    await installModel(f, bytes, false);
    const before = f.store.project();
    await assert.rejects(
      planModelConversion(f.store, { ...f.guard(), objectId: 'source' }),
      (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.code, 'ASSET_TOO_LARGE');
        return true;
      },
    );
    assert.deepEqual(f.store.project(), before);
    assert.equal(f.assetCount(), 2);
  } finally {
    await f.close();
  }
});
