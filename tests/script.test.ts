import assert from 'node:assert/strict';
import test from 'node:test';
import { parseScript } from '../shared/script-parser';
import { planScriptImport } from '../shared/script-plan';
import { scriptBlocks } from '../shared/script-schema';
import { applyCommands } from '../shared/commands';
import { createEmptyProject } from '../shared/project';
import { resolveShotProject } from '../shared/production';
import { sampleObject, sequenceDuration } from '../shared/timeline';
import { parseScriptRequest } from '../server/script-service';

const fountain = `Title: 雨夜来客

.INT. 客厅 - 夜

门缓缓打开。

@林川
(低声)
你终于来了。

@苏雨
门外有人跟着我。

.EXT. 露台 - 黎明

晨光照亮屋顶。

@林川
天亮了。`;

test('Fountain parses Chinese character cues, scene headings, actions and dialogue without HTML injection', () => {
  const result = parseScript({ format: 'fountain', source: fountain });
  assert.equal(result.title, '雨夜来客');
  assert.equal(result.scenes.length, 2);
  assert.equal(result.scenes[0]!.location, '客厅');
  assert.equal(result.scenes[0]!.timeOfDay, '夜');
  assert.deepEqual(result.characters, ['林川', '苏雨']);
  assert.equal(result.scenes[0]!.items[1]!.direction, '(低声)');
  assert.equal(result.scenes[0]!.items[1]!.kind, 'dialogue');
  assert.ok(result.estimatedDurationSeconds > 0);
  assert.ok(result.diagnostics.some((item) => item.code === 'ESTIMATED_TIMING'));
  assert.deepEqual(parseScriptRequest({ format: 'fountain', source: fountain }), result);
  const rawMarkup = parseScript({
    format: 'fountain',
    source: '.INT. ROOM - DAY\n\n<img src=x onerror=alert(1)>',
  });
  assert.equal(rawMarkup.scenes[0]!.items[0]!.text, '<img src=x onerror=alert(1)>');
});

test('simultaneous Fountain dialogue shares source time and uses the longest duration', () => {
  const result = parseScript({
    format: 'fountain',
    source: '.INT. ROOM - DAY\n\n@A\nHello.\n\n@B ^\nA significantly longer simultaneous response.',
  });
  const scene = result.scenes[0]!;
  assert.equal(scene.items.length, 2);
  assert.ok(scene.items[0]!.parallelGroup);
  assert.equal(scene.items[0]!.parallelGroup, scene.items[1]!.parallelGroup);
  assert.equal(scriptBlocks(scene).length, 1);
  assert.equal(scene.durationSeconds, Math.max(...scene.items.map((item) => item.durationSeconds)));
  const project = applyCommands(
    createEmptyProject(),
    planScriptImport(createEmptyProject(), { breakdown: result, options: { prefix: 'parallel' } }).commands,
  ).project;
  assert.equal(project.beats.length, 2);
  assert.equal(project.beats[0]!.time, project.beats[1]!.time);
  assert.equal(project.sequences.find((item) => item.id === 'parallel-sequence')!.clips.length, 1);
});

test('JSON keeps explicit durations and diagnoses invalid schema instead of fabricating a scene', () => {
  const parsed = parseScript({
    format: 'json',
    source: JSON.stringify({
      title: '明确时长',
      scenes: [
        {
          heading: '仓库',
          characters: ['守卫'],
          items: [
            { kind: 'action', text: '守卫停下。', durationSeconds: 8 },
            { kind: 'dialogue', character: '守卫', text: '站住。', durationSeconds: 3 },
          ],
        },
      ],
    }),
  });
  assert.equal(parsed.estimatedDurationSeconds, 11);
  assert.equal(parsed.scenes[0]!.items[0]!.durationEstimated, false);
  assert.ok(!parsed.diagnostics.some((item) => item.code === 'ESTIMATED_TIMING'));
  assert.equal(parseScript({ format: 'json', source: '{' }).diagnostics[0]!.code, 'JSON_SYNTAX');
  assert.equal(
    parseScript({ format: 'json', source: '{"title":"a","scenes":[]}' }).diagnostics[0]!.code,
    'JSON_SCHEMA',
  );
  const unsupported = parseScript({ format: 'fountain', source: '这是一段没有结构标记的自然语言故事。' });
  assert.equal(unsupported.scenes.length, 0);
  assert.ok(unsupported.diagnostics.some((item) => item.code === 'NO_SCENES' && item.severity === 'error'));
});

test('script plan creates independently editable scenes, performances, character talk keys and bound coverage', () => {
  const original = createEmptyProject('原工程');
  const snapshot = structuredClone(original);
  const breakdown = parseScript({ format: 'fountain', source: fountain });
  const plan = planScriptImport(original, { breakdown, options: { prefix: 'script-test' } });
  assert.deepEqual(original, snapshot);
  assert.ok(plan.commands.every((command) => command.type !== 'script.apply'));
  const { project } = applyCommands(original, plan.commands);
  assert.equal(project.production!.storyScenes.length, 2);
  assert.equal(project.production!.scenes.length, 3);
  assert.equal(project.production!.activeSceneId, plan.summary.scenes[0]!.sceneId);
  assert.equal(project.activeSequenceId, plan.summary.sequenceId);
  assert.equal(sequenceDuration(project), breakdown.estimatedDurationSeconds);
  const dialogue = project.beats.find((beat) => beat.actorId)!;
  assert.equal(
    sampleObject(
      project.objects.find((object) => object.id === dialogue.actorId)!,
      (dialogue.time + dialogue.endTime) / 2,
    ).actor!.action,
    'talk',
  );
  const secondSceneShot = project.shots.find((shot) => shot.sceneId === plan.summary.scenes[1]!.sceneId)!;
  const resolved = resolveShotProject(project, secondSceneShot);
  assert.equal(resolved.objects.filter((object) => object.type === 'actor').length, 1);
  assert.equal(resolved.objects.find((object) => object.type === 'actor')!.name, '林川');
  assert.notEqual(resolved.objects.find((object) => object.type === 'actor')!.id, dialogue.actorId);
  assert.throws(() => planScriptImport(project, { breakdown, options: { prefix: 'script-test' } }), {
    code: 'CONFLICT',
  });
});

test('scene selection supports separate imports and a no-coverage full-scene edit', () => {
  const breakdown = parseScript({ format: 'fountain', source: fountain });
  const original = createEmptyProject();
  const selected = planScriptImport(original, {
    breakdown,
    options: { prefix: 'selected', sceneIds: [breakdown.scenes[1]!.id], createCoverage: false },
  });
  const project = applyCommands(original, selected.commands).project;
  assert.equal(selected.summary.scenes.length, 1);
  assert.equal(project.shots.length, original.shots.length + 1);
  assert.equal(sequenceDuration(project), breakdown.scenes[1]!.durationSeconds);
  assert.throws(() => planScriptImport(original, { breakdown, options: { sceneIds: ['missing'] } }), {
    code: 'VALIDATION_ERROR',
  });
});

test('large scripts are rejected atomically with a usable scene-subset escape', () => {
  const source = {
    title: '分批',
    scenes: Array.from({ length: 10 }, (_, i) => ({
      heading: `INT. ROOM ${i} - DAY`,
      items: Array.from({ length: 30 }, () => ({
        kind: 'action',
        text: 'A person crosses the room.',
        durationSeconds: 1,
      })),
    })),
  };
  const breakdown = parseScript({ format: 'json', source: JSON.stringify(source) });
  const project = createEmptyProject();
  assert.throws(() => planScriptImport(project, { breakdown }), { code: 'SCRIPT_LIMIT' });
  const plan = planScriptImport(project, { breakdown, options: { sceneIds: ['scene-1'] } });
  assert.ok(plan.commands.length < 500);
  assert.equal(plan.summary.durationSeconds, 30);
  const missingCharacter = parseScript({
    format: 'json',
    source: JSON.stringify({
      title: '缺失',
      scenes: [{ heading: 'INT. ROOM - DAY', items: [{ kind: 'dialogue', text: 'Hello.' }] }],
    }),
  });
  assert.throws(() => planScriptImport(project, { breakdown: missingCharacter }), {
    code: 'SCRIPT_DIAGNOSTICS',
  });
});
