import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { timelineRulerTicks } from '../src/components/TimelineRuler';

const measure = (label: string) => label.length * 6 + 7;

test('timeline ruler labels fit their measured widths, including fractional end times', () => {
  for (const duration of [0.125, 2, 3.25, 9.98, 10, 120, 120.01, 134, 3600, 86400])
    for (const width of [150, 308, 582, 624, 1314, 2500]) {
      const ticks = timelineRulerTicks(duration, width, measure);
      assert.equal(ticks[0].time, 0);
      assert.equal(ticks.at(-1)?.time, duration);
      assert.equal(ticks.at(-1)?.terminal, true);
      let previousRight = -10;
      for (const tick of ticks) {
        assert.ok(tick.time >= 0 && tick.time <= duration);
        const left = (tick.percent / 100) * width - (tick.terminal ? measure(tick.label) : 0);
        assert.ok(left >= previousRight + 10 - 1e-8, `${duration}s, ${width}px, ${tick.label}`);
        previousRight = left + measure(tick.label);
        assert.ok(previousRight <= width + 1e-8);
      }
      assert.ok(ticks.length <= Math.ceil(width / 56) + 2);
    }
});

test('timeline ruler chooses readable intervals and never adds a tick beyond the duration', () => {
  const compact = timelineRulerTicks(134, 582, measure);
  const wide = timelineRulerTicks(134, 1314, measure);
  assert.equal(compact[1].time, 20);
  assert.equal(wide[1].time, 10);
  assert.ok(wide.length > compact.length);
  assert.equal(compact.at(-1)?.label, '134s');
  assert.ok(timelineRulerTicks(120.01, 582, measure).every((tick) => tick.time <= 120.01));
  assert.ok(!timelineRulerTicks(120.01, 582, measure).some((tick) => tick.time === 120));
});

test('empty and temporarily narrow rulers have a bounded stable origin tick', () => {
  for (const duration of [0, 3, 134])
    for (const width of [0, 1, 20]) {
      const ticks = timelineRulerTicks(duration, width, measure);
      assert.deepEqual(ticks, [{ time: 0, label: '0s', percent: 0, terminal: false }]);
    }
});

test('sub-millisecond durations terminate with finite origin and endpoint ticks', () => {
  const durations = [Number.MIN_VALUE, 1e-320, 1e-310, 0.000001, 0.0001, 0.000499, 0.000999];
  const moduleUrl = new URL('../src/components/TimelineRuler.tsx', import.meta.url).href;
  // A separate process bounds regressions that would otherwise block the test runner's event loop.
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '--eval',
      `
    import { timelineRulerTicks } from ${JSON.stringify(moduleUrl)};
    const observations = ${JSON.stringify(durations)}.flatMap(duration => [150, 582, 1314].map(width => ({
      duration, width, ticks: timelineRulerTicks(duration, width, label => label.length * 6 + 7),
    })));
    console.log(JSON.stringify(observations));
  `,
    ],
    { encoding: 'utf8', timeout: 5000 },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const observations = JSON.parse(result.stdout) as {
    duration: number;
    width: number;
    ticks: ReturnType<typeof timelineRulerTicks>;
  }[];
  assert.equal(observations.length, durations.length * 3);
  for (const { duration, ticks } of observations) {
    assert.equal(ticks.length, 2);
    assert.deepEqual(
      ticks.map((tick) => tick.time),
      [0, duration],
    );
    assert.deepEqual(
      ticks.map((tick) => tick.percent),
      [0, 100],
    );
    assert.equal(ticks.at(-1)?.terminal, true);
    assert.ok(ticks.every((tick) => Number.isFinite(tick.time) && Number.isFinite(tick.percent)));
  }
});
