import type { Command } from '../../shared/types';

export function architectureArchCommands(beveled = true): Command[] {
  const commands: Command[] = [
    {
      type: 'object.create',
      payload: { id: 'front-wall', type: 'box', dimensions: [12, 4.4, 0.36], position: [0, 1.28, 2.7] },
    },
  ];
  if (beveled)
    commands.push({
      type: 'modifier.add',
      payload: {
        id: 'front-wall',
        modifier: { id: 'front-soft-edges', type: 'bevel', width: 0.04, segments: 3 },
      },
    });
  const points = [
    [-1.04, -0.08],
    [1.04, -0.08],
    [1.04, 2],
    ...Array.from({ length: 24 }, (_, index) => {
      const angle = ((index + 1) * Math.PI) / 24;
      return [1.04 * Math.cos(angle), 2 + 1.04 * Math.sin(angle)];
    }),
  ].map((position) => ({ position }));
  for (const x of [-4, 0, 4]) {
    const id = `arch-cutter-${x}`;
    commands.push(
      { type: 'object.create', payload: { id, type: 'box', position: [x, 1.28, 2.7], visible: false } },
      {
        type: 'surface.set',
        payload: {
          id,
          surface: {
            kind: 'surface',
            operation: 'sweep',
            smooth: false,
            profile: { outer: { closed: true, points }, holes: [] },
            path: { closed: false, points: [{ position: [0, 0, -0.6] }, { position: [0, 0, 0.6] }] },
            segments: 1,
            profileSegments: 1,
            caps: true,
            thickness: 0,
          },
        },
      },
      {
        type: 'modifier.add',
        payload: {
          id: 'front-wall',
          modifier: {
            id: `arch-opening-${x}`,
            type: 'boolean',
            operandId: id,
            operation: 'subtract',
          },
        },
      },
    );
  }
  commands.push(
    ...[-4, 0, 4].map((x): Command => ({
      type: 'object.update',
      payload: { id: `arch-cutter-${x}`, patch: { rotation: [0, 0, 90] } },
    })),
  );
  return commands;
}

export const archOpeningArea = 2.08 * 2 + 0.5 * 1.04 ** 2 * 24 * Math.sin(Math.PI / 24);
