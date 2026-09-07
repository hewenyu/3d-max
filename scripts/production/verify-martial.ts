import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Box3, Mesh, Vector3 } from 'three';
import { ContinuityScene } from '../../shared/continuity-scene';
import { sampleTimeline, sequenceDuration } from '../../shared/timeline';
import type { Project } from '../../shared/types';

const directory = resolve('.data/full-delivery/productions/martial');
const project = JSON.parse(await readFile(resolve(directory, 'project.json'), 'utf8')) as Project;
const scene = new ContinuityScene(project, 'martial-numeric-review');
const frameCount = Math.ceil(sequenceDuration(project) * 24);
const contacts = new Map<
  string,
  {
    activeFrames: number;
    fullWeightFrames: number;
    worstFullError: number;
    unreachableFrames: number;
    worstTime: number;
  }
>();
const bodyParts = new Map<string, Mesh[]>();
for (const fighter of ['qing', 'lan']) {
  const meshes: Mesh[] = [];
  scene.objects.get(fighter)!.rig!.root.traverse((node) => {
    if (node instanceof Mesh) meshes.push(node);
  });
  bodyParts.set(fighter, meshes);
}
let lowestBody = Infinity;
let largestGripOffset = 0;
let minimumTorsoDistance = Infinity;
const badFrames: { frame: number; time: number; kind: string; value: number }[] = [];
try {
  for (let index = 0; index < frameCount; index++) {
    const time = index / 24;
    const frame = scene.sample(sampleTimeline(project, time));
    for (const fighter of ['qing', 'lan']) {
      const actor = scene.objects.get(fighter)!.rig!;
      const bounds = new Box3();
      for (const mesh of bodyParts.get(fighter)!) bounds.union(new Box3().setFromObject(mesh));
      lowestBody = Math.min(lowestBody, bounds.min.y);
      if (bounds.min.y < -0.025)
        badFrames.push({ frame: index, time, kind: `${fighter}-floor`, value: bounds.min.y });
      for (const result of frame.objects.get(fighter)!.contacts) {
        if (result.status === 'inactive') continue;
        const record = contacts.get(result.id) ?? {
          activeFrames: 0,
          fullWeightFrames: 0,
          worstFullError: 0,
          unreachableFrames: 0,
          worstTime: time,
        };
        record.activeFrames++;
        if (result.weight >= 0.99) {
          record.fullWeightFrames++;
          if ((result.error ?? Infinity) > record.worstFullError) {
            record.worstFullError = result.error ?? Infinity;
            record.worstTime = time;
          }
          if (!result.reachable) record.unreachableFrames++;
        }
        contacts.set(result.id, record);
      }
      const staff = frame.objects.get(`${fighter}-staff`)!;
      if (staff.object.attachment) {
        const offset = staff.position.distanceTo(actor.rightHand.getWorldPosition(new Vector3()));
        largestGripOffset = Math.max(largestGripOffset, offset);
        if (offset > 0.04) badFrames.push({ frame: index, time, kind: `${fighter}-grip`, value: offset });
      }
    }
    const left = scene.objects.get('qing')!.rig!.chest.getWorldPosition(new Vector3());
    const right = scene.objects.get('lan')!.rig!.chest.getWorldPosition(new Vector3());
    minimumTorsoDistance = Math.min(minimumTorsoDistance, left.distanceTo(right));
  }
  const switches = [];
  for (const fighter of ['qing', 'lan']) {
    const time = fighter === 'qing' ? 56 : 57;
    const before = scene
      .sample(sampleTimeline(project, time - 1e-5))
      .objects.get(`${fighter}-staff`)!
      .matrix.clone();
    const after = scene
      .sample(sampleTimeline(project, time + 1e-5))
      .objects.get(`${fighter}-staff`)!
      .matrix.clone();
    const points = [
      [0, 0, 0],
      [0, 1.12, 0],
    ].map((value) => new Vector3(...value));
    switches.push({
      fighter,
      time,
      maxPointJump: Math.max(
        ...points.map((point) =>
          point.clone().applyMatrix4(before).distanceTo(point.clone().applyMatrix4(after)),
        ),
      ),
    });
  }
  const report = {
    projectId: project.id,
    revision: project.revision,
    duration: sequenceDuration(project),
    frameCount,
    lowestBody,
    largestGripOffset,
    minimumTorsoDistance,
    contactWindows: Object.fromEntries(contacts),
    attachmentSwitches: switches,
    badFrames,
    visualReview: 'Nine key source-time images reviewed; complete exported playback pending',
  };
  await writeFile(resolve(directory, 'numeric-review.json'), JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify({ ...report, badFrames: badFrames.slice(0, 8), badFrameCount: badFrames.length }, null, 2),
  );
  assert.equal(badFrames.length, 0, 'Body grounding or staff grip requires correction');
  assert.ok(
    switches.every((item) => item.maxPointJump < 0.02),
    'Staff attachment jumps at pickup',
  );
  assert.ok(
    [...contacts.values()].every(
      (item) => item.fullWeightFrames > 0 && item.worstFullError < 0.03 && item.unreachableFrames === 0,
    ),
    'Contact windows require correction',
  );
  assert.ok(minimumTorsoDistance > 0.35, 'Unexpected torso collision');
} finally {
  scene.dispose();
}
