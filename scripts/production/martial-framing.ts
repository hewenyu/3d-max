import { ProductionMcp } from './production-mcp';
import type { Project } from '../../shared/types';

const film = new ProductionMcp('martial', process.env.WHITEFRAME_PRODUCTION_API ?? 'http://127.0.0.1:4201');
try {
  await film.connect();
  film.project = await film.call<Project>('project_get');
  const camera = film.project.cameras.find((item) => item.id === 'martial-camera-11')!;
  await film.edit([
    {
      type: 'camera.update',
      payload: {
        id: camera.id,
        patch: {
          position: [1.7, 0.85, 5.6],
          target: [0, 1.25, 0],
          fov: 44,
          keyframes: camera.keyframes.map((key, index) => ({
            ...key,
            position: [1.7 + (index / 32) * 0.7 - 0.35, 0.85, 5.6 - (index / 32) * 0.35],
            target: [0, 1.25, 0],
            fov: 44,
          })),
        },
      },
    },
  ]);
  await film.preview(2.9, 'preview-90.9', 'martial-shot-11');
} finally {
  await film.close();
}
