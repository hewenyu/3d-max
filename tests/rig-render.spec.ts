import { expect, test } from '@playwright/test';
import { createEmptyProject, createObject } from '../shared/project';
import { actorAnimationSchema } from '../shared/actor-animation';
import { effectSchema, vehicleSchema } from '../shared/motion';
import type { SceneEngine } from '../src/engine/SceneEngine';
import type { BuiltObject } from '../src/engine/ObjectFactory';

declare global {
  interface Window {
    rigTest: SceneEngine;
  }
}

test('actor contact, vehicle wheels and timed effects sample deterministically in the actual renderer', async ({
  page,
}) => {
  const project = createEmptyProject('Rig verification');
  project.settings.aspect = '16:9';
  const actor = createObject('actor');
  actor.id = 'performer';
  actor.position = [-2, 0, 0];
  actor.actor!.animation = actorAnimationSchema.parse({
    constraints: [
      {
        id: 'contact',
        effector: 'rightHand',
        start: 0,
        end: 3,
        target: { kind: 'object', objectId: 'target', offset: [0.1, 0, 0] },
        tolerance: 0.025,
      },
    ],
  });
  const target = createObject('sphere');
  target.id = 'target';
  target.position = [-2.3, 1.2, 0.25];
  target.rotation = [0, 90, 0];
  target.dimensions = [0.09, 0.09, 0.09];
  target.tone = '#667f70';
  const attached = createObject('phone');
  attached.id = 'attached';
  attached.attachment = { objectId: actor.id, bone: 'rightHand', offset: [0, 0, 0] };
  const car = createObject('box');
  car.id = 'car';
  car.dimensions = [1.1, 0.8, 2];
  car.position = [0.2, 0, 0];
  car.vehicle = vehicleSchema.parse({ kind: 'car', wheelRadius: 0.2, wheelBase: 1.3, trackWidth: 0.85 });
  car.keyframes = [
    { id: 'car-start', time: 0, position: [0.2, 0, 0], rotation: [0, 0, 0] },
    { id: 'car-end', time: 2, position: [0.2, 0, 1.2], rotation: [0, 25, 0], easing: 'linear' },
  ];
  const effect = createObject('box');
  effect.id = 'effect';
  effect.position = [2, 1, 0];
  effect.effect = effectSchema.parse({ kind: 'explosion', start: 0.5, duration: 1, radius: 0.8 });
  project.objects = [actor, target, attached, car, effect];
  project.cameras = [
    {
      id: 'camera',
      name: 'Rigs',
      position: [6, 4, 8],
      target: [0, 1, 0],
      fov: 45,
      locked: false,
      keyframes: [],
    },
  ];
  project.shots = [
    {
      id: 'shot',
      name: 'Rigs',
      cameraId: 'camera',
      sourceIn: 0,
      sourceOut: 3,
      intent: '',
      subjectIds: [],
      hiddenIds: [],
      beatId: null,
      locked: false,
    },
  ];
  project.sequences[0].clips = [{ id: 'clip', shotId: 'shot', sourceIn: 0, sourceOut: 3 }];
  await page.route('**/rig-render-test', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><body style="margin:0"><div id="stage" style="position:relative;width:1280px;height:720px"></div></body>',
    }),
  );
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/rig-render-test');
  await page.evaluate(async (project) => {
    const path = '/src/engine/SceneEngine.ts';
    const { SceneEngine } = await import(/* @vite-ignore */ path);
    const engine = new SceneEngine(document.getElementById('stage')!, { interactive: false });
    window.rigTest = engine;
    engine.setView('camera');
    engine.setHelpers(false);
    await engine.setProject(project);
  }, project);
  const sampled = await page.evaluate(() => {
    const engine = window.rigTest;
    const objects = (engine as unknown as { objects: Map<string, BuiltObject> }).objects;
    const sample = (time: number) => {
      engine.setTime(time);
      const actor = objects.get('performer')!.rig!;
      const contact = engine.getConstraintResults('performer')[0];
      const hand = actor.rightHand.getWorldPosition(actor.rightHand.position.clone()).toArray();
      const phone = objects.get('attached')!.root;
      return {
        contact,
        hand,
        phone: phone.getWorldPosition(phone.position.clone()).toArray(),
        wheel: objects.get('car')!.vehicleRig!.root.children[1].children[0].rotation.x,
        effect: objects.get('effect')!.effectRig!.root.visible,
        png: engine.capture(),
      };
    };
    return { start: sample(0), middle: sample(1), end: sample(2), repeated: sample(1) };
  });
  expect(sampled.middle.contact.status).toBe('solved');
  expect(sampled.middle.contact.error).toBeLessThan(0.025);
  expect(sampled.middle.contact.target![0]).toBeCloseTo(-2.3);
  expect(sampled.middle.contact.target![1]).toBeCloseTo(1.2);
  expect(sampled.middle.contact.target![2]).toBeCloseTo(0.15);
  expect(sampled.middle.phone).toEqual(sampled.middle.hand);
  expect(sampled.start.wheel).toBe(0);
  expect(sampled.middle.wheel).toBeCloseTo(3);
  expect(sampled.end.wheel).toBeCloseTo(6);
  expect([sampled.start.effect, sampled.middle.effect, sampled.end.effect]).toEqual([false, true, false]);
  expect(sampled.middle.png).toBe(sampled.repeated.png);
  await page.screenshot({ path: 'test-results/rig-contact-vehicle-effect.png' });
  await page.evaluate(() => window.rigTest.dispose());
  await page.goto('/?render=1');
  await page.waitForFunction(() => Boolean(window.__WHITEFRAME_RENDER__));
  const exported = await page.evaluate(async (project) => {
    await window.__WHITEFRAME_RENDER__!.load(project, 1280, 720);
    return window.__WHITEFRAME_RENDER__!.frame(1);
  }, project);
  expect(exported).toBe(sampled.middle.png);
});
