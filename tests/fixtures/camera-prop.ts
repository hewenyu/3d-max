import { actorAnimationSchema } from '../../shared/actor-animation';
import { createEmptyProject, createObject } from '../../shared/project';

export function attachedCameraFixture() {
  const project = createEmptyProject('道具交接跟随');
  project.settings.aspect = '16:9';
  const group = createObject('group', '移动父级');
  group.id = 'moving-parent';
  group.position = [-1, 0, 0];
  group.rotation = [0, -20, 0];
  group.scale = [1.1, 1.1, 1.1];
  group.keyframes = [
    { id: 'group-end', time: 3, position: [1, 0, 0.5], rotation: [0, 35, 0], easing: 'linear' },
  ];
  const marker = createObject('group', '交接接触点');
  marker.id = 'contact-point';
  marker.parentId = group.id;
  marker.position = [0, 1.15, 0.22];
  const first = createObject('actor', '交出者');
  first.id = 'giver';
  first.parentId = group.id;
  first.position = [-0.4, 0, 0];
  first.actor!.animation = actorAnimationSchema.parse({
    constraints: [
      {
        id: 'giver-contact',
        effector: 'leftHand',
        start: 0,
        end: 3.1,
        tolerance: 0.001,
        iterations: 100,
        target: { kind: 'object', objectId: marker.id },
      },
    ],
  });
  const second = createObject('actor', '接收者');
  second.id = 'receiver';
  second.tone = '#b9bfbd';
  second.parentId = group.id;
  second.position = [0.4, 0, 0];
  second.actor!.animation = actorAnimationSchema.parse({
    constraints: [
      {
        id: 'receiver-contact',
        effector: 'rightHand',
        start: 0,
        end: 3.1,
        tolerance: 0.001,
        iterations: 100,
        target: { kind: 'object', objectId: marker.id },
      },
    ],
  });
  const prop = createObject('phone', '交接手机');
  prop.id = 'handover-prop';
  prop.dimensions = [0.12, 0.23, 0.02];
  prop.tone = '#737c78';
  prop.attachment = { objectId: first.id, bone: 'leftHand', offset: [0, 0, 0] };
  prop.keyframes = [
    { id: 'handover', time: 1.5, attachment: { objectId: second.id, bone: 'rightHand', offset: [0, 0, 0] } },
  ];
  const ground = createObject('plane', '地面');
  ground.position = [0, -0.05, 0];
  ground.tone = '#a4aaa5';
  project.objects = [group, marker, first, second, prop, ground];
  project.cameras = [
    {
      id: 'prop-camera',
      name: '道具跟随镜头',
      position: [1.5, 2.2, 4.5],
      target: [-1, 1.2, 0.2],
      fov: 38,
      locked: false,
      keyframes: [],
    },
  ];
  project.shots = [
    {
      id: 'prop-shot',
      name: '道具交接',
      cameraId: 'prop-camera',
      sourceIn: 0,
      sourceOut: 3,
      intent: '',
      subjectIds: [prop.id],
      hiddenIds: [],
      beatId: null,
      locked: false,
    },
  ];
  project.sequences[0].clips = [{ id: 'prop-clip', shotId: 'prop-shot', sourceIn: 0, sourceOut: 3 }];
  return project;
}
