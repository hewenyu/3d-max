import assert from 'node:assert/strict';
import test from 'node:test';
import { applyCommands, validateProject } from '../shared/commands';
import { createDemoProject } from '../shared/project';
import { createScene, ensureProduction, selectProduction, syncProduction } from '../shared/production';
import { captureTemplate } from '../shared/templates';
import { lightingPlanUsage, resolveLighting } from '../shared/lighting-plans';
import type { Command, Project } from '../shared/types';

const key = { intensity: 4, ambient: 0.2, azimuth: -110, elevation: 25 };
const fill = { intensity: 0.4, ambient: 1.4, azimuth: 80, elevation: 60 };
const command = (type: string, payload: Record<string, unknown>): Command => ({ type, payload });
const edit = (project: Project, ...commands: Command[]) => applyCommands(project, commands).project;
function fixture() {
  return edit(
    createDemoProject(),
    command('lighting.plan.create', { id: 'key', name: 'Side key', lighting: key }),
    command('lighting.plan.create', { id: 'fill', name: 'Soft fill', lighting: fill }),
  );
}

test('named lighting resolves shot override, bound scene default and legacy base without mutating scene state', () => {
  let project = fixture();
  const base = structuredClone(project.settings.lighting);
  project = edit(
    project,
    command('lighting.scene.bind', { planId: 'key' }),
    command('lighting.shot.bind', { shotId: project.shots[1].id, planId: 'fill' }),
  );
  assert.deepEqual(resolveLighting(project), key);
  assert.deepEqual(resolveLighting(project, project.shots[0]), key);
  assert.deepEqual(resolveLighting(project, project.shots[1]), fill);
  assert.deepEqual(project.settings.lighting, base);
  assert.deepEqual(lightingPlanUsage(project, 'key').shotIds, [project.shots[0].id, project.shots[2].id]);
  project = edit(
    project,
    command('lighting.shot.bind', { shotId: project.shots[1].id, planId: null }),
    command('lighting.scene.bind', { planId: null }),
  );
  assert.deepEqual(resolveLighting(project, project.shots[1]), base);
  assert.deepEqual(validateProject(JSON.parse(JSON.stringify(project))), project);
});

test('inactive scene bindings survive take changes and preserve independent scene settings', () => {
  let project = fixture();
  const production = ensureProduction(project);
  const original = production.activeSceneId;
  const other = createScene(project, 'Other', { id: 'other' });
  syncProduction(project);
  project = edit(
    project,
    command('lighting.scene.bind', { sceneId: other.id, planId: 'fill' }),
    command('lighting.scene.bind', { sceneId: original, planId: 'key' }),
  );
  assert.deepEqual(resolveLighting(project), key);
  const originalShot = project.shots[0];
  selectProduction(project, other.id);
  assert.deepEqual(resolveLighting(project), fill);
  assert.deepEqual(resolveLighting(project, originalShot), key);
  selectProduction(project, original);
  assert.equal(project.settings.lightingPlanId, 'key');
  assert.deepEqual(validateProject(project), project);
});

test('plan duplication, renaming, locking and deletion are independent and reject live references', () => {
  let project = edit(
    fixture(),
    command('lighting.plan.duplicate', { id: 'key', newId: 'copy', name: 'Candidate' }),
  );
  project = edit(
    project,
    command('lighting.plan.update', { id: 'copy', patch: { name: 'Edited', lighting: fill, locked: true } }),
  );
  assert.deepEqual(project.lightingPlans?.find((plan) => plan.id === 'key')?.lighting, key);
  assert.throws(
    () => edit(project, command('lighting.plan.update', { id: 'copy', patch: { lighting: key } })),
    { code: 'LOCKED' },
  );
  assert.throws(() => edit(project, command('lighting.plan.delete', { id: 'copy' })), { code: 'LOCKED' });
  project = edit(
    project,
    command('lighting.plan.update', { id: 'copy', patch: { locked: false } }),
    command('lighting.plan.delete', { id: 'copy' }),
    command('lighting.scene.bind', { planId: 'key' }),
  );
  assert.throws(() => edit(project, command('lighting.plan.delete', { id: 'key' })), { code: 'IN_USE' });
  assert.equal(project.lightingPlans?.length, 2);
});

test('indirect lighting edits respect locked scenes, shots and sequences through every generic entry', () => {
  for (const lock of ['scene', 'shot', 'sequence'] as const) {
    let project = fixture();
    const production = ensureProduction(project);
    project = edit(project, command('lighting.scene.bind', { planId: 'key' }));
    if (lock === 'scene') project.production!.scenes[0].locked = true;
    else if (lock === 'shot') project.shots[0].locked = true;
    else project.sequences[0].locked = true;
    const before = structuredClone(project);
    assert.throws(
      () => edit(project, command('lighting.plan.update', { id: 'key', patch: { lighting: fill } })),
      { code: 'LOCKED' },
    );
    assert.throws(() =>
      edit(project, command('lighting.scene.bind', { sceneId: production.activeSceneId, planId: 'fill' })),
    );
    if (lock !== 'scene')
      assert.throws(
        () =>
          edit(
            project,
            command('shot.update', { id: project.shots[0].id, patch: { lightingPlanId: 'fill' } }),
          ),
        { code: 'LOCKED' },
      );
    assert.throws(() => edit(project, command('project.settings', { lightingPlanId: 'fill' })));
    assert.deepEqual(project, before);
    const independent = edit(
      project,
      command('lighting.plan.update', { id: 'fill', patch: { lighting: { ...fill, ambient: 2 } } }),
    );
    assert.equal(independent.lightingPlans?.find((plan) => plan.id === 'fill')?.lighting.ambient, 2);
  }
});

test('invalid IDs, duplicate plans and nonfinite or out-of-range values roll back atomic batches', () => {
  const project = fixture();
  for (const invalid of [
    command('lighting.scene.bind', { planId: 'missing' }),
    command('lighting.scene.bind', { sceneId: 'missing', planId: 'key' }),
    command('lighting.shot.bind', { shotId: 'missing', planId: 'key' }),
    command('lighting.plan.create', { id: 'key', name: 'Duplicate' }),
    command('lighting.plan.update', { id: 'key', patch: { lighting: { ...key, intensity: 11 } } }),
    command('lighting.plan.update', { id: 'key', patch: { lighting: { ...key, azimuth: Infinity } } }),
  ]) {
    assert.throws(() => edit(project, command('project.update', { name: 'Must roll back' }), invalid));
    assert.notEqual(project.name, 'Must roll back');
  }
  assert.throws(() =>
    validateProject({ ...project, settings: { ...project.settings, lightingPlanId: 'missing' } }),
  );
});

test('sequence variants clone shot lighting overrides while scene defaults remain shared', () => {
  let project = edit(
    fixture(),
    command('lighting.scene.bind', { planId: 'key' }),
    command('lighting.shot.bind', { shotId: 'shot-reveal', planId: 'fill' }),
  );
  const original = project.sequences[0];
  project = edit(project, command('sequence.duplicate', { id: original.id, newId: 'candidate' }));
  const clone = project.sequences.find((sequence) => sequence.id === 'candidate')!;
  const copiedShot = project.shots.find((shot) => shot.id === clone.clips.at(-1)!.shotId)!;
  assert.notEqual(copiedShot.lightingPlanId, 'fill');
  project = edit(
    project,
    command('lighting.plan.update', { id: copiedShot.lightingPlanId, patch: { lighting: key } }),
  );
  assert.deepEqual(
    resolveLighting(
      project,
      project.shots.find((shot) => shot.id === 'shot-reveal')!,
    ),
    fill,
  );
  assert.deepEqual(resolveLighting(project, copiedShot), key);
});

test('scene templates preserve and remap required plans into independent editable instances', () => {
  const project = edit(
    fixture(),
    command('lighting.scene.bind', { planId: 'key' }),
    command('lighting.shot.bind', { shotId: 'shot-reveal', planId: 'fill' }),
  );
  const template = captureTemplate(project, { kind: 'scene', name: 'Lit scene' });
  assert.equal(template.project.lightingPlans?.length, 2);
  let destination = edit(createDemoProject(), command('template.instantiate', { template }));
  const firstScene = destination.production!.activeSceneId;
  const firstPlan = destination.settings.lightingPlanId;
  destination = edit(destination, command('template.instantiate', { template }));
  assert.notEqual(destination.settings.lightingPlanId, firstPlan);
  assert.deepEqual(resolveLighting(destination), key);
  destination = edit(
    destination,
    command('lighting.plan.update', { id: destination.settings.lightingPlanId, patch: { lighting: fill } }),
  );
  selectProduction(destination, firstScene);
  assert.deepEqual(resolveLighting(destination), key);
  const objectTemplate = captureTemplate(project, {
    kind: 'objects',
    name: 'Object',
    objectIds: [project.objects[0].id],
  });
  assert.equal(objectTemplate.project.settings.lightingPlanId, undefined);
  validateProject(destination);
});

test('maximum-length lighting names remain valid when plans and sequences are duplicated', () => {
  for (const name of ['灯'.repeat(200), '灯'.repeat(196) + '🎥🎥']) {
    let project = edit(
      fixture(),
      command('lighting.plan.update', { id: 'fill', patch: { name } }),
      command('lighting.shot.bind', { shotId: 'shot-reveal', planId: 'fill' }),
    );
    project = edit(
      project,
      command('lighting.plan.duplicate', { id: 'fill', newId: 'copy' }),
      command('sequence.duplicate', { id: project.activeSequenceId }),
    );
    const copies = project.lightingPlans!.filter((plan) => plan.id !== 'fill' && plan.id !== 'key');
    assert.equal(copies.length, 2);
    for (const copy of copies) {
      assert.ok(copy.name.length <= 200);
      assert.ok(copy.name.endsWith(' 副本'));
      assert.ok(!/[\uD800-\uDBFF] 副本$/.test(copy.name));
    }
    assert.equal(project.lightingPlans!.find((plan) => plan.id === 'fill')!.name, name);
    assert.throws(() =>
      edit(project, command('lighting.plan.duplicate', { id: 'fill', name: '灯'.repeat(201) })),
    );
  }
});
