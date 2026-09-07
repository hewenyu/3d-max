import { DomainError } from './domain-error';
import {
  refreshScriptBreakdown,
  scriptApplySchema,
  scriptBlocks,
  scriptBreakdownSchema,
  type ScriptScene,
} from './script-schema';
import type { Command, Project, SequenceClip, Vec3 } from './types';

export function scriptSceneCommandCount(scene: ScriptScene, coverage = true) {
  const characters = new Set([
    ...scene.characters,
    ...scene.items.flatMap((item) => (item.character ? [item.character] : [])),
  ]);
  const dialogues = scene.items.filter((item) => item.kind === 'dialogue').length;
  return (
    4 +
    characters.size +
    scene.items.length +
    dialogues * 2 +
    (coverage ? characters.size + scriptBlocks(scene).length : 1)
  );
}

export function planScriptImport(project: Project, raw: unknown) {
  const { options, breakdown: input } = scriptApplySchema.parse(raw);
  const breakdown = scriptBreakdownSchema.parse(refreshScriptBreakdown(input));
  const selectedIds = options.sceneIds ?? breakdown.scenes.map((scene) => scene.id);
  if (
    new Set(selectedIds).size !== selectedIds.length ||
    selectedIds.some((id) => !breakdown.scenes.some((scene) => scene.id === id))
  )
    throw new DomainError('剧本场次选择包含重复或不存在的 ID', 'VALIDATION_ERROR');
  if (new Set(breakdown.scenes.map((scene) => scene.id)).size !== breakdown.scenes.length)
    throw new DomainError('剧本场次 ID 重复', 'VALIDATION_ERROR');
  const selected = breakdown.scenes.filter((scene) => selectedIds.includes(scene.id));
  const blocking = breakdown.diagnostics.filter(
    (item) => item.severity === 'error' && (!item.sceneId || selectedIds.includes(item.sceneId)),
  );
  if (blocking.length)
    throw new DomainError(blocking.map((item) => item.message).join('\n'), 'SCRIPT_DIAGNOSTICS');
  const scenes = selected.filter((scene) => scene.items.length);
  if (!scenes.length) throw new DomainError('请选择包含动作或对白的场次', 'SCRIPT_EMPTY');
  if (scenes.some((scene) => new Set(scene.items.map((item) => item.id)).size !== scene.items.length))
    throw new DomainError('剧本条目 ID 重复', 'VALIDATION_ERROR');
  const estimatedCommands =
    scenes.reduce((sum, scene) => sum + scriptSceneCommandCount(scene, options.createCoverage), 0) + 4;
  if (estimatedCommands > 500)
    throw new DomainError(
      `所选场次需要约 ${estimatedCommands} 条编辑命令，单次上限 500。请减少本次场次选择后分批应用。`,
      'SCRIPT_LIMIT',
    );
  const prefix = options.prefix ?? `script-${crypto.randomUUID().slice(0, 12)}`;
  const existingIds = [
    ...project.objects,
    ...project.cameras,
    ...project.shots,
    ...project.sequences,
    ...project.beats,
    ...(project.production?.storyScenes ?? []),
    ...(project.production?.scenes ?? []),
    ...(project.production?.scenes.flatMap((scene) => [...scene.objects, ...scene.performances]) ?? []),
  ].map((entity) => entity.id);
  if (existingIds.some((id) => id.startsWith(`${prefix}-`)))
    throw new DomainError('该导入标识已存在，请使用新的 prefix 或撤销之前的导入', 'CONFLICT', 409);
  const commands: Command[] = [{ type: 'production.initialize', payload: {} }];
  const clips: SequenceClip[] = [];
  const sequenceId = `${prefix}-sequence`;
  const created: {
    sourceSceneId: string;
    sceneId: string;
    performanceId: string;
    storySceneId: string;
    durationSeconds: number;
    actorIds: string[];
    shotIds: string[];
  }[] = [];
  for (const [index, scene] of scenes.entries()) {
    const sceneId = `${prefix}-scene-${index + 1}`;
    const performanceId = `${prefix}-take-${index + 1}`;
    const storySceneId = `${prefix}-story-${index + 1}`;
    const actors = scene.characters.map((name, actorIndex) => ({
      name,
      id: `${prefix}-s${index + 1}-actor-${actorIndex + 1}`,
      x: (actorIndex - (scene.characters.length - 1) / 2) * 2.2,
    }));
    const actorFor = (name?: string) => actors.find((actor) => actor.name === name);
    const wideId = `${prefix}-s${index + 1}-wide`;
    const cameraCommand = (id: string, name: string, position: Vec3, target: Vec3, fov: number): Command => ({
      type: 'camera.create',
      payload: { id, name: name.slice(0, 200), position, target, fov },
    });
    commands.push(
      { type: 'scene.create', payload: { id: sceneId, performanceId, name: scene.heading, select: true } },
      {
        type: 'object.create',
        payload: {
          id: `${prefix}-s${index + 1}-floor`,
          name: '调度地面',
          type: 'plane',
          dimensions: [Math.max(14, actors.length * 2.5), 0.1, 12],
          tone: '#bac3bd',
        },
      },
      {
        type: 'storyScene.create',
        payload: {
          id: storySceneId,
          name: scene.heading,
          sceneId,
          performanceId,
          location: scene.location,
          timeOfDay: scene.timeOfDay,
          description: scene.items
            .filter((item) => item.kind === 'action')
            .map((item) => item.text)
            .join('\n')
            .slice(0, 10000),
        },
      },
      cameraCommand(
        wideId,
        `${scene.heading} / 全景`,
        [0, 3.2, Math.max(9, actors.length * 2.1)],
        [0, 1, 0],
        48,
      ),
    );
    for (const actor of actors) {
      commands.push({
        type: 'object.create',
        payload: {
          id: actor.id,
          name: actor.name,
          type: 'actor',
          position: [actor.x, 0, 0],
          dimensions: [0.55, 1.75, 0.38],
        },
      });
      if (options.createCoverage)
        commands.push(
          cameraCommand(
            `${actor.id}-camera`,
            `${actor.name} / 中近景`,
            [actor.x + 0.7, 1.55, 3.6],
            [actor.x, 1.3, 0],
            38,
          ),
        );
    }
    const shotIds: string[] = [];
    const blocks = scriptBlocks(scene);
    for (const [blockIndex, block] of blocks.entries()) {
      for (const item of block.items) {
        const beatId = `${prefix}-s${index + 1}-beat-${scene.items.indexOf(item) + 1}`;
        const actor = actorFor(item.character);
        commands.push({
          type: 'beat.create',
          payload: {
            id: beatId,
            label:
              item.kind === 'dialogue' ? `${item.character} / 对白` : `动作 ${scene.items.indexOf(item) + 1}`,
            kind: item.kind,
            actorId: actor?.id ?? null,
            time: block.start,
            endTime: block.start + item.durationSeconds,
            text: item.text,
            notes: [
              item.direction,
              item.durationEstimated ? '剧本拆解估计时长' : '剧本明确时长',
              item.parallelGroup ? `同时对白：${item.parallelGroup}` : '',
            ]
              .filter(Boolean)
              .join('\n'),
          },
        });
        if (actor && item.kind === 'dialogue')
          commands.push(
            {
              type: 'object.keyframe.set',
              payload: { id: actor.id, keyframe: { time: block.start, action: 'talk', easing: 'step' } },
            },
            {
              type: 'object.keyframe.set',
              payload: {
                id: actor.id,
                keyframe: { time: block.start + item.durationSeconds, action: 'idle', easing: 'step' },
              },
            },
          );
      }
      if (options.createCoverage) {
        const item = block.items[0]!;
        const actor = block.items.length === 1 ? actorFor(item.character) : undefined;
        const shotId = `${prefix}-s${index + 1}-shot-${blockIndex + 1}`;
        commands.push({
          type: 'shot.create',
          payload: {
            id: shotId,
            name: `${scene.heading} / ${blockIndex + 1}`.slice(0, 200),
            cameraId: actor ? `${actor.id}-camera` : wideId,
            sceneId,
            performanceId,
            storySceneId,
            sourceIn: block.start,
            sourceOut: block.start + block.duration,
            subjectIds: actor ? [actor.id] : actors.map((actor) => actor.id),
            beatId: `${prefix}-s${index + 1}-beat-${scene.items.indexOf(item) + 1}`,
            intent: block.items
              .map((item) => (item.kind === 'dialogue' ? `${item.character}：${item.text}` : item.text))
              .join('\n')
              .slice(0, 10000),
          },
        });
        clips.push({
          id: `${shotId}-clip`,
          shotId,
          sourceIn: block.start,
          sourceOut: block.start + block.duration,
        });
        shotIds.push(shotId);
      }
    }
    if (!options.createCoverage) {
      const shotId = `${prefix}-s${index + 1}-shot`;
      commands.push({
        type: 'shot.create',
        payload: {
          id: shotId,
          name: `${scene.heading} / 全场`.slice(0, 200),
          cameraId: wideId,
          sceneId,
          performanceId,
          storySceneId,
          sourceIn: 0,
          sourceOut: scene.durationSeconds,
          subjectIds: actors.map((actor) => actor.id),
          intent: '全场调度占位',
        },
      });
      clips.push({ id: `${shotId}-clip`, shotId, sourceIn: 0, sourceOut: scene.durationSeconds });
      shotIds.push(shotId);
    }
    created.push({
      sourceSceneId: scene.id,
      sceneId,
      performanceId,
      storySceneId,
      durationSeconds: scene.durationSeconds,
      actorIds: actors.map((actor) => actor.id),
      shotIds,
    });
  }
  commands.push(
    {
      type: 'sequence.create',
      payload: { id: sequenceId, name: `${breakdown.title} / 剧本拆解`.slice(0, 200), clips },
    },
    { type: 'project.update', payload: { activeSequenceId: sequenceId } },
    {
      type: 'scene.select',
      payload: { sceneId: created[0]!.sceneId, performanceId: created[0]!.performanceId },
    },
  );
  if (commands.length > 500) throw new DomainError('生成命令超过 500 条，请减少本次场次选择', 'SCRIPT_LIMIT');
  return {
    commands,
    summary: {
      prefix,
      sequenceId,
      sourceTitle: breakdown.title,
      scenes: created,
      commandCount: commands.length,
      durationSeconds: created.reduce((sum, scene) => sum + scene.durationSeconds, 0),
      unresolvedBlocking: true,
    },
  };
}
