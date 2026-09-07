import assert from 'node:assert/strict';
import test from 'node:test';
import { cameraOpticsSchema, sampleOptics } from '../shared/camera-optics';

test('focus and aperture use independent sparse tracks while focus target switches discretely', () => {
  const optics = cameraOpticsSchema.parse({
    enabled: true,
    focusDistance: 2,
    fStop: 2,
    sensorWidthMm: 36,
    focusTargetId: 'near',
    keyframes: [
      { id: 'far', time: 4, focusDistance: 10, focusTargetId: 'far', easing: 'linear' },
      { id: 'aperture', time: 2, fStop: 8, easing: 'smooth' },
      { id: 'manual', time: 5, focusTargetId: null, easing: 'step' },
    ],
  });
  const atOne = sampleOptics(optics, 1)!;
  assert.equal(atOne.focusDistance, 4);
  assert.equal(atOne.fStop, 5);
  assert.equal(atOne.focusTargetId, 'near');
  assert.equal(sampleOptics(optics, 4)!.focusTargetId, 'far');
  assert.equal(sampleOptics(optics, 5)!.focusTargetId, null);
  assert.equal(optics.focusDistance, 2);
  assert.equal(optics.keyframes[0].id, 'far');
  assert.equal(sampleOptics(undefined, 1), undefined);
});
