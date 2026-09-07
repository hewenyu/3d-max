import { sampleObject } from './timeline';
import type { SceneObject } from './types';

export type DistanceTable = Array<{ time: number; distance: number }>;

export function distanceTable(object: SceneObject): DistanceTable {
  const boundaries = [
    ...new Set([0, ...object.keyframes.filter((key) => key.position || key.action).map((key) => key.time)]),
  ].sort((a, b) => a - b);
  const table = [{ time: 0, distance: 0 }];
  let previous = sampleObject(object, 0, { render: true }).position;
  for (let interval = 1; interval < boundaries.length; interval++) {
    const start = boundaries[interval - 1];
    const end = boundaries[interval];
    const samples = Math.min(32, Math.max(2, Math.ceil((end - start) * 24)));
    for (let step = 1; step <= samples; step++) {
      const time = start + ((end - start) * step) / samples;
      const position = sampleObject(object, time, { render: true }).position;
      const distance = Math.hypot(...position.map((value, index) => value - previous[index]));
      table.push({ time, distance: table[table.length - 1].distance + distance });
      previous = position;
    }
  }
  return table;
}

export function gaitDistance(table: DistanceTable | undefined, time: number, speed: number) {
  if (!table || table[table.length - 1].distance <= 0.001) return time * speed;
  let low = 0;
  let high = table.length - 1;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (table[middle].time > time) high = middle;
    else low = middle;
  }
  const before = table[low];
  const after = table[high];
  const ratio =
    after.time === before.time
      ? 0
      : Math.max(0, Math.min(1, (time - before.time) / (after.time - before.time)));
  return before.distance + (after.distance - before.distance) * ratio;
}
