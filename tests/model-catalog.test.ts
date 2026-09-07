import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../server/store';
import { modelCatalog } from '../server/model-service';
import { validateModel } from '../server/assets';
import { skinnedModelAsset } from './fixtures/skinned-model';

for (const binary of [false, true])
  test(`imported ${binary ? 'GLB' : 'glTF'} exposes actual hierarchy, skins, durations and validated editable animation`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'whiteframe-model-'));
    const store = new Store(directory);
    try {
      store.newProject('Model metadata', 'empty');
      const bytes = await skinnedModelAsset(binary);
      const extension = binary ? '.glb' : '.gltf';
      const path = join(directory, `model${extension}`);
      await writeFile(path, bytes);
      await validateModel(bytes, extension, store);
      store.addAsset({
        id: 'model',
        name: `Model${extension}`,
        path,
        size: bytes.length,
        mime: binary ? 'model/gltf-binary' : 'model/gltf+json',
        url: '/api/assets/model/file',
      });
      store.commands({
        commands: [
          {
            type: 'object.create',
            payload: { id: 'imported', type: 'model', assetUrl: '/api/assets/model/file' },
          },
        ],
      });
      const catalog = await modelCatalog(store, { objectId: 'imported' });
      assert.equal(catalog.nodes.length, 3);
      assert.equal(
        catalog.nodes.find((node) => node.name === 'Upper body')!.parent,
        catalog.nodes.find((node) => node.name === 'Root')!.index,
      );
      assert.equal(catalog.skins[0].joints.length, 2);
      assert.deepEqual(
        catalog.animations.map((animation) => [animation.index, animation.name, animation.duration]),
        [
          [0, 'Sway left', 2],
          [1, 'Sway right', 2],
        ],
      );
      assert.equal(catalog.compatibility.builtinActorRetargeting, false);
      store.commands({
        commands: [{ type: 'model.animation.set', payload: { id: 'imported', animationIndex: 1 } }],
      });
      assert.equal(store.project().objects[0].animationIndex, 1);
      const before = store.project();
      assert.throws(
        () =>
          store.commands({
            commands: [{ type: 'model.animation.set', payload: { id: 'imported', animationIndex: 99 } }],
          }),
        /absent/,
      );
      assert.deepEqual(store.project(), before);
      store.commands({
        commands: [{ type: 'model.animation.set', payload: { id: 'imported', animationIndex: null } }],
      });
      assert.equal(store.project().objects[0].animationIndex, null);
      store.travel(-1);
      assert.equal(store.project().objects[0].animationIndex, 1);
      store.commands({
        commands: [{ type: 'object.update', payload: { id: 'imported', patch: { locked: true } } }],
      });
      assert.throws(
        () =>
          store.commands({
            commands: [{ type: 'model.animation.set', payload: { id: 'imported', animationIndex: 0 } }],
          }),
        /locked/i,
      );
    } finally {
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

test('model inspection cannot read arbitrary files or external network resources', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'whiteframe-model-security-'));
  const store = new Store(directory);
  try {
    store.newProject('Local only', 'empty');
    for (const uri of ['https://example.com/model.bin', '/etc/passwd']) {
      const bytes = Buffer.from(
        JSON.stringify({ asset: { version: '2.0' }, buffers: [{ byteLength: 48, uri }] }),
      );
      await assert.rejects(validateModel(bytes, '.gltf', store), /embedded|local/);
      const path = join(directory, 'blocked.gltf');
      await writeFile(path, bytes);
      if (!store.asset('bad'))
        store.addAsset({
          id: 'bad',
          path,
          name: 'bad',
          url: '/api/assets/bad/file',
          mime: 'model/gltf+json',
          size: bytes.length,
        });
      if (!store.project().objects.length)
        store.commands({
          commands: [
            {
              type: 'object.create',
              payload: { id: 'bad-object', type: 'model', assetUrl: '/api/assets/bad/file' },
            },
          ],
        });
      await assert.rejects(modelCatalog(store, { objectId: 'bad-object' }), /unavailable local resource/);
    }
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
