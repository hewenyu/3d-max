import { Document, NodeIO } from '@gltf-transform/core';

export async function skinnedModelAsset(binary = false) {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const positions = doc
    .createAccessor()
    .setType('VEC3')
    .setArray(new Float32Array([-0.35, 0, 0, 0.35, 0, 0, -0.35, 1.8, 0, 0.35, 1.8, 0]))
    .setBuffer(buffer);
  const indices = doc
    .createAccessor()
    .setType('SCALAR')
    .setArray(new Uint16Array([0, 1, 2, 2, 1, 3]))
    .setBuffer(buffer);
  const joints = doc
    .createAccessor()
    .setType('VEC4')
    .setArray(new Uint16Array([0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]))
    .setBuffer(buffer);
  const weights = doc
    .createAccessor()
    .setType('VEC4')
    .setArray(new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]))
    .setBuffer(buffer);
  const mesh = doc
    .createMesh('White performer')
    .addPrimitive(
      doc
        .createPrimitive()
        .setAttribute('POSITION', positions)
        .setAttribute('JOINTS_0', joints)
        .setAttribute('WEIGHTS_0', weights)
        .setIndices(indices),
    );
  const root = doc.createNode('Root');
  const arm = doc.createNode('Upper body');
  root.addChild(arm);
  const skin = doc.createSkin('Two joint rig').setSkeleton(root).addJoint(root).addJoint(arm);
  const body = doc.createNode('Body mesh').setMesh(mesh).setSkin(skin);
  doc.createScene('Imported stage').addChild(root).addChild(body);
  const times = doc
    .createAccessor()
    .setType('SCALAR')
    .setArray(new Float32Array([0, 1, 2]))
    .setBuffer(buffer);
  for (const [index, name] of ['Sway left', 'Sway right'].entries()) {
    const direction = index ? 1 : -1;
    const values = doc
      .createAccessor()
      .setType('VEC3')
      .setArray(new Float32Array([0, 0, 0, direction * 0.9, 0, 0, 0, 0, 0]))
      .setBuffer(buffer);
    const sampler = doc.createAnimationSampler().setInput(times).setOutput(values).setInterpolation('LINEAR');
    doc
      .createAnimation(name)
      .addSampler(sampler)
      .addChannel(
        doc.createAnimationChannel().setSampler(sampler).setTargetNode(arm).setTargetPath('translation'),
      );
  }
  const io = new NodeIO();
  if (binary) return Buffer.from(await io.writeBinary(doc));
  const result = await io.writeJSON(doc);
  for (const item of result.json.buffers ?? []) {
    if (item.uri && result.resources[item.uri])
      item.uri = `data:application/octet-stream;base64,${Buffer.from(result.resources[item.uri]).toString('base64')}`;
  }
  return Buffer.from(JSON.stringify(result.json));
}
