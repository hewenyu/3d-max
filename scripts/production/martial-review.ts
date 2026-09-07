import { ProductionMcp } from './production-mcp';
import type { Project } from '../../shared/types';

const film = new ProductionMcp('martial', process.env.WHITEFRAME_PRODUCTION_API ?? 'http://127.0.0.1:4201');
try {
  await film.connect();
  film.project = await film.call<Project>('project_get');
  for (const [sourceTime, shot] of [
    [4, 0],
    [20.5, 2],
    [40, 4],
    [47.4, 5],
    [56, 7],
    [68, 8],
    [90.9, 11],
    [112.5, 14],
    [125, 15],
  ] as const)
    await film.preview(sourceTime - shot * 8, `preview-${sourceTime}`, `martial-shot-${shot}`);
  await film.save({
    storyboard: film.project.shots.map((shot) => ({
      id: shot.id,
      name: shot.name,
      sourceIn: shot.sourceIn,
      sourceOut: shot.sourceOut,
    })),
    contactConstraints: film.project.objects.reduce(
      (count, object) => count + (object.actor?.animation?.constraints.length ?? 0),
      0,
    ),
    exchanges: 23,
    audioTracks: film.project.audio.length,
    requiredBeats: [
      '双人攻防',
      '闪避',
      '格挡',
      '受击',
      '倒地起身',
      '持械',
      '空间交代',
      '局部特写',
      '反应镜头',
      '连续变速及独立摄影机时间',
    ],
  });
} finally {
  await film.close();
}
