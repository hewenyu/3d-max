import { captureTemplate } from '../../shared/templates';
import { parseScript } from '../../shared/script-parser';
import type { Command, Project } from '../../shared/types';

export interface McpCommandCase {
  type: string;
  payload: Record<string, unknown> | ((project: Project) => Record<string, unknown>);
  setup?: Command[];
}
const command = (type: string, payload: Record<string, unknown>): Command => ({ type, payload });
const item = (type: string, payload: McpCommandCase['payload'], setup: Command[] = []): McpCommandCase => ({
  type,
  payload,
  setup,
});

export function mcpCommandSeed(modelUrl: string, audioUrl: string): Command[] {
  return [
    command('object.create', { id: 'target', type: 'box', dimensions: [2, 2, 2] }),
    command('object.create', { id: 'operand', type: 'box', dimensions: [2, 2, 2], position: [1, 0, 0] }),
    command('object.create', { id: 'actor', type: 'actor' }),
    command('object.create', { id: 'model', type: 'model', assetUrl: modelUrl }),
    command('object.keyframe.set', {
      id: 'target',
      keyframe: { id: 'object-key', time: 1, position: [1, 0, 0] },
    }),
    command('camera.create', { id: 'camera', position: [5, 4, 7], target: [0, 1, 0] }),
    command('camera.create', { id: 'unused-camera' }),
    command('camera.keyframe.set', {
      id: 'camera',
      keyframe: {
        id: 'camera-key',
        time: 1,
        fov: 40,
        position: [5, 4, 7],
        target: [0, 1, 0],
        easing: 'linear',
      },
    }),
    command('shot.create', { id: 'shot', cameraId: 'camera', sourceIn: 0, sourceOut: 4 }),
    command('sequence.create', {
      id: 'sequence',
      clips: [{ id: 'clip', shotId: 'shot', sourceIn: 0, sourceOut: 4 }],
    }),
    command('project.update', { activeSequenceId: 'sequence' }),
    command('sequence.create', { id: 'unused-sequence' }),
    command('beat.create', { id: 'beat', time: 1, endTime: 2, text: 'Action' }),
    command('audio.create', { id: 'audio', url: audioUrl, start: 1, duration: 2, sync: 'source' }),
    command('note.create', { id: 'note', text: 'Review this beat' }),
  ];
}

export function mcpCommandCases(audioUrl: string): McpCommandCase[] {
  const convert = command('mesh.convert', { id: 'target' });
  const mirror = command('modifier.add', {
    id: 'target',
    modifier: { id: 'mirror', type: 'mirror', axis: 'x' },
  });
  const array = command('modifier.add', {
    id: 'target',
    modifier: { id: 'array', type: 'array', count: 2, offset: [3, 0, 0] },
  });
  const terrain = command('terrain.set', {
    id: 'target',
    terrain: { sizeX: 10, sizeZ: 10, segmentsX: 2, segmentsZ: 2 },
  });
  const clip = command('actor.clip.set', {
    id: 'actor',
    clip: { id: 'action', action: 'punch', start: 1, end: 2 },
  });
  const contact = command('actor.constraint.set', {
    id: 'actor',
    constraint: {
      id: 'contact',
      effector: 'rightHand',
      start: 1,
      end: 2,
      target: { kind: 'world', position: [0.3, 1.2, 0.2] },
    },
  });
  const joint = command('actor.joint-key.set', {
    id: 'actor',
    keyframe: { id: 'joint', joint: 'rightElbow', time: 1, rotation: [-50, 0, 0] },
  });
  const faceKey = command('actor.face.key.set', {
    id: 'actor',
    keyframe: { id: 'face-key', time: 1, values: { smile: 0.7 } },
  });
  const faceClip = command('actor.face.clip.set', {
    id: 'actor',
    clip: {
      id: 'face-clip',
      name: 'Speech',
      start: 1,
      end: 3,
      cues: [{ id: 'cue', start: 0, end: 1, viseme: 'A' }],
    },
  });
  const path = command('motion.path.set', {
    id: 'target',
    path: {
      points: [{ position: [0, 0, 0] }, { position: [0, 0, 10] }],
      speed: [{ duration: 2, fromSpeed: 1, toSpeed: 1, easing: 'constant' }],
    },
  });
  const optics = command('camera.optics.set', {
    id: 'camera',
    optics: {
      enabled: true,
      focusDistance: 5,
      focusTargetId: null,
      fStop: 2.8,
      sensorWidthMm: 36,
      keyframes: [],
    },
  });
  const opticsKey = command('camera.optics.keyframe.set', {
    id: 'camera',
    keyframe: { id: 'focus-key', time: 1, focusDistance: 2, easing: 'linear' },
  });
  const composition = command('camera.composition.set', {
    id: 'camera',
    aspect: '9:16',
    composition: { position: [4, 3, 6], target: [0, 1, 0], fov: 45, keyframes: [] },
  });
  const scene = command('scene.create', { id: 'scene-b', performanceId: 'take-b', name: 'Second scene' });
  const take = command('performance.duplicate', {
    sceneId: 'scene-b',
    id: 'take-b',
    newId: 'take-c',
    name: 'Alternate',
    select: false,
  });
  const story = command('storyScene.create', {
    id: 'story',
    sceneId: 'scene-b',
    performanceId: 'take-b',
    name: 'EXT. ROAD',
    location: 'Road',
    timeOfDay: 'Day',
    description: 'A car enters.',
  });
  const sync = command('sync.group.set', {
    group: {
      id: 'sync',
      name: 'Cue',
      members: [
        { kind: 'beat', id: 'beat' },
        { kind: 'audio', id: 'audio' },
      ],
    },
  });
  return [
    item('production.initialize', {}),
    item('lighting.plan.create', { id: 'lighting-new', name: 'Key light' }),
    item('lighting.plan.update', { id: 'lighting', patch: { name: 'Updated light' } }, [
      command('lighting.plan.create', { id: 'lighting', name: 'Key light' }),
    ]),
    item('lighting.plan.duplicate', { id: 'lighting', newId: 'lighting-copy' }, [
      command('lighting.plan.create', { id: 'lighting', name: 'Key light' }),
    ]),
    item('lighting.plan.delete', { id: 'lighting' }, [
      command('lighting.plan.create', { id: 'lighting', name: 'Key light' }),
    ]),
    item('lighting.scene.bind', { planId: 'lighting' }, [
      command('lighting.plan.create', { id: 'lighting', name: 'Key light' }),
    ]),
    item('lighting.shot.bind', { shotId: 'shot', planId: 'lighting' }, [
      command('lighting.plan.create', { id: 'lighting', name: 'Key light' }),
    ]),
    item('scene.create', { id: 'scene-new', name: 'New scene' }),
    item('scene.select', { sceneId: 'scene-b' }, [
      { ...scene, payload: { ...scene.payload, select: false } },
    ]),
    item('scene.update', { id: 'scene-b', patch: { name: 'Renamed scene' } }, [scene]),
    item('scene.delete', { id: 'scene-b' }, [scene]),
    item('performance.duplicate', { sceneId: 'scene-b', id: 'take-b', newId: 'take-new', name: 'New take' }, [
      scene,
    ]),
    item('performance.select', { sceneId: 'scene-b', id: 'take-c' }, [scene, take]),
    item('performance.update', { sceneId: 'scene-b', id: 'take-b', patch: { name: 'Renamed take' } }, [
      scene,
    ]),
    item('performance.delete', { sceneId: 'scene-b', id: 'take-c' }, [scene, take]),
    item('shot.binding', { id: 'shot', sceneId: 'scene-b', performanceId: 'take-b' }, [scene]),
    item('storyScene.create', story.payload, [scene]),
    item('storyScene.update', { id: 'story', patch: { description: 'The chase begins.' } }, [scene, story]),
    item('storyScene.delete', { id: 'story' }, [scene, story]),
    item('modifier.add', mirror.payload),
    item('modifier.set', { id: 'target', modifier: { id: 'mirror', type: 'mirror', axis: 'z' } }, [mirror]),
    item('modifier.remove', { id: 'target', modifierId: 'mirror' }, [mirror]),
    item('modifier.reorder', { id: 'target', modifierId: 'mirror', index: 1 }, [mirror, array]),
    item('modifier.bake', { id: 'target' }, [mirror]),
    item('mesh.convert', { id: 'target' }),
    item('mesh.set', {
      id: 'target',
      mesh: {
        vertices: [
          [0, 0, 0],
          [1, 0, 0],
          [0, 1, 0],
        ],
        faces: [[0, 1, 2]],
      },
    }),
    item('mesh.vertex.set', { id: 'target', index: 0, position: [-1.5, 0, -1] }, [convert]),
    item('mesh.vertex.add', { id: 'target', position: [3, 0, 0] }, [convert]),
    item('mesh.vertex.delete', { id: 'target', index: 8 }, [
      convert,
      command('mesh.vertex.add', { id: 'target', position: [3, 0, 0] }),
    ]),
    item('mesh.face.extrude', { id: 'target', faceIndex: 4, distance: 0.5 }, [convert]),
    item('mesh.face.delete', { id: 'target', faceIndex: 0 }, [convert]),
    item('mesh.face.add', { id: 'target', indices: [0, 1, 2] }, [
      convert,
      command('mesh.face.delete', { id: 'target', faceIndex: 0 }),
    ]),
    item('mesh.boolean', { id: 'target', operandId: 'operand', operation: 'union' }),
    item('curve.set', {
      id: 'target',
      curve: {
        points: [
          [0, 0, 0],
          [0, 0, 5],
        ],
        profile: 'road',
        width: 2,
      },
    }),
    item('terrain.set', terrain.payload),
    item('terrain.sculpt', { id: 'target', center: [0, 0], radius: 3, amount: 1, mode: 'raise' }, [terrain]),
    item('terrain.point.set', { id: 'target', row: 1, column: 1, height: 3 }, [terrain]),
    item('actor.animation.set', {
      id: 'actor',
      animation: {
        clips: [{ id: 'action', action: 'block', start: 0, end: 1 }],
        jointKeys: [],
        constraints: [],
      },
    }),
    item('actor.clip.set', clip.payload),
    item('actor.clip.delete', { id: 'actor', itemId: 'action' }, [clip]),
    item('actor.constraint.set', contact.payload),
    item('actor.constraint.delete', { id: 'actor', itemId: 'contact' }, [contact]),
    item('actor.joint-key.set', joint.payload),
    item('actor.joint-key.delete', { id: 'actor', itemId: 'joint' }, [joint]),
    item('motion.events.set', {
      id: 'target',
      events: [{ id: 'event', time: 1, kind: 'impact', position: [0, 0, 0] }],
    }),
    item('motion.path.set', path.payload),
    item('motion.path.fit', { id: 'target', duration: 3 }, [path]),
    item('motion.path.bake', { id: 'target', fps: 4 }, [path]),
    item('vehicle.create', { id: 'vehicle', kind: 'car' }),
    item('vehicle.configure', { id: 'target', vehicle: { kind: 'car' } }),
    item('physics.body.set', { id: 'target', body: { mode: 'dynamic' } }),
    item('simulation.apply', {
      start: 0,
      end: 1,
      tracks: [
        {
          id: 'target',
          keyframes: [
            { id: 'sim-0', time: 0, position: [0, 3, 0], rotation: [0, 0, 0] },
            { id: 'sim-1', time: 1, position: [0, 0, 0], rotation: [0, 0, 0] },
          ],
        },
      ],
    }),
    item('effect.create', { id: 'effect', effect: { kind: 'impact' } }),
    item('effect.configure', { id: 'target', effect: { kind: 'explosion', radius: 2 } }),
    item('camera.composition.set', composition.payload),
    item('camera.composition.delete', { id: 'camera', aspect: '9:16' }, [composition]),
    item('camera.optics.set', optics.payload),
    item('camera.optics.keyframe.set', opticsKey.payload, [optics]),
    item('camera.optics.keyframe.delete', { id: 'camera', keyframeId: 'focus-key' }, [optics, opticsKey]),
    item('model.animation.set', { id: 'model', animationIndex: 1 }),
    item('camera.preset', { id: 'camera', preset: 'wide', subjectId: 'actor' }),
    item('continuity.ignore', { findingId: 'intentional-cut', reason: 'Intentional director choice' }),
    item('template.instantiate', (project) => ({
      template: captureTemplate(project, {
        kind: 'objects',
        objectIds: ['actor'],
        name: 'Performer',
        description: '',
      }),
    })),
    item('sync.group.set', sync.payload),
    item('sync.group.delete', { id: 'sync' }, [sync]),
    item('sync.member.remove', { id: 'sync', member: { kind: 'beat', id: 'beat' } }, [sync]),
    item('sync.group.move', { id: 'sync', time: 3 }, [sync]),
    item('actor.face.set', { id: 'actor', face: { base: { smile: 0.5 } } }),
    item('actor.face.key.set', faceKey.payload),
    item('actor.face.key.delete', { id: 'actor', itemId: 'face-key' }, [faceKey]),
    item('actor.face.clip.set', faceClip.payload),
    item('actor.face.clip.delete', { id: 'actor', itemId: 'face-clip' }, [faceClip]),
    item(
      'actor.face.cue.set',
      { id: 'actor', clipId: 'face-clip', cue: { id: 'cue-b', start: 1, end: 2, viseme: 'D' } },
      [faceClip],
    ),
    item('actor.face.cue.delete', { id: 'actor', clipId: 'face-clip', itemId: 'cue' }, [faceClip]),
    item('model.morph.bindings.set', { id: 'model', bindings: [] }),
    item('script.apply', {
      breakdown: parseScript({
        format: 'fountain',
        source: '.EXT. ROAD - DAY\n\nA car arrives.\n\n@DRIVER\nWe are here.',
      }),
    }),
    item('clip.transition', { sequenceId: 'sequence', clipId: 'clip', fadeIn: 0.5 }),
    item('clip.retime', {
      sequenceId: 'sequence',
      clipId: 'clip',
      retiming: {
        segments: [{ duration: 8, fromSpeed: 0.5, toSpeed: 0.5, easing: 'constant' }],
        audio: 'mute',
      },
    }),
    item('clip.trim', { sequenceId: 'sequence', clipId: 'clip', sourceIn: 1, sourceOut: 3 }),
    item('clip.split', { sequenceId: 'sequence', clipId: 'clip', time: 2 }),
    item('camera.motion', { id: 'camera', motion: 'dolly_in', start: 0, end: 3, distance: 1 }),
    item('project.update', { name: 'Renamed project' }),
    item('project.settings', { fps: 30 }),
    item('object.create', { id: 'new-object', type: 'sphere' }),
    item('object.update', { id: 'target', patch: { name: 'Renamed object' } }),
    item('object.delete', { id: 'target' }),
    item('object.duplicate', { id: 'target', newId: 'target-copy' }),
    item('object.keyframe.set', { id: 'target', keyframe: { id: 'new-key', time: 2, position: [2, 0, 0] } }),
    item('object.keyframe.delete', { id: 'target', keyframeId: 'object-key' }),
    item('object.group', { ids: ['target', 'operand'], id: 'group' }),
    item('object.align', { ids: ['target', 'operand'], axis: 'x' }),
    item('camera.create', { id: 'new-camera' }),
    item('camera.update', { id: 'camera', patch: { fov: 55 } }),
    item('camera.delete', { id: 'unused-camera' }),
    item('camera.keyframe.set', {
      id: 'camera',
      keyframe: {
        id: 'new-camera-key',
        time: 2,
        fov: 35,
        position: [4, 3, 6],
        target: [0, 1, 0],
        easing: 'smooth',
      },
    }),
    item('camera.keyframe.delete', { id: 'camera', keyframeId: 'camera-key' }),
    item('shot.create', { id: 'new-shot', cameraId: 'camera', sourceIn: 0, sourceOut: 2 }),
    item('shot.update', { id: 'shot', patch: { name: 'Renamed shot' } }),
    item('shot.delete', { id: 'shot' }),
    item('sequence.create', { id: 'new-sequence' }),
    item('sequence.update', { id: 'sequence', patch: { name: 'Alternate edit' } }),
    item('sequence.delete', { id: 'unused-sequence' }),
    item('sequence.duplicate', { id: 'sequence', name: 'Independent copy' }),
    item('beat.create', { id: 'new-beat', time: 3, text: 'Reaction' }),
    item('beat.update', { id: 'beat', patch: { text: 'Changed action' } }),
    item('beat.delete', { id: 'beat' }),
    item('audio.create', { id: 'new-audio', url: audioUrl, duration: 1 }),
    item('audio.update', { id: 'audio', patch: { volume: 0.5 } }),
    item('audio.delete', { id: 'audio' }),
    item('note.create', { id: 'new-note', text: 'New review note' }),
    item('note.delete', { id: 'note' }),
  ];
}
