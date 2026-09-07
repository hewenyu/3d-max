import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Matrix3, Matrix4, PerspectiveCamera, Vector3 } from 'three';
import { OBB } from 'three/addons/math/OBB.js';
import { quaternionFor } from '../../shared/motion';
import { sampleObject, sampleTimeline, sequenceDuration } from '../../shared/timeline';
import type { Project, SceneObject } from '../../shared/types';

for (const theme of ['racing', 'space']) {
  const directory = resolve('.data/full-delivery/productions', theme);
  const project = JSON.parse(await readFile(resolve(directory, 'project.json'), 'utf8')) as Project;
  const vehicles = project.objects.filter((object) => object.vehicle);
  const fps = project.settings.fps;
  const frameCount = Math.ceil(sequenceDuration(project) * fps);
  const boxesOverlap: { frame: number; time: number; objects: string[] }[] = [];
  const staticIntervals: { frame: number; time: number; id: string }[] = [];
  const shotCoverage = new Map<
    string,
    { frames: number; noVehicleCenterVisible: number; maximumVisibleVehicles: number }
  >();
  let minimumMovement = Infinity;
  let minimumSeparation = Infinity;
  const sampledBox = (object: SceneObject) => {
    const rotation = quaternionFor(object.rotation);
    const center = new Vector3(0, object.dimensions[1] * 0.5, 0)
      .applyQuaternion(rotation)
      .add(new Vector3(...object.position));
    return new OBB(
      center,
      new Vector3(...object.dimensions).multiplyScalar(0.5),
      new Matrix3().setFromMatrix4(new Matrix4().makeRotationFromQuaternion(rotation)),
    );
  };
  for (let frame = 0; frame < frameCount; frame++) {
    const time = frame / fps;
    const timeline = sampleTimeline(project, time);
    const nextTimeline = sampleTimeline(project, Math.min((frame + 1) / fps, sequenceDuration(project)));
    const alive = vehicles
      .map((object) => ({
        source: object,
        sampled: sampleObject(object, timeline.sourceTime, { render: true }),
      }))
      .filter(({ sampled }) => sampled.scale[0] > 0.01);
    for (const [index, { source, sampled }] of alive.entries()) {
      const next = sampleObject(source, nextTimeline.sourceTime, { render: true });
      if (nextTimeline.sourceTime > timeline.sourceTime && next.scale[0] > 0.01) {
        const movement = new Vector3(...sampled.position).distanceTo(new Vector3(...next.position));
        minimumMovement = Math.min(minimumMovement, movement);
        if (movement < 1e-6) staticIntervals.push({ frame, time, id: source.id });
      }
      const box = sampledBox(sampled);
      for (const { sampled: other } of alive.slice(index + 1)) {
        minimumSeparation = Math.min(
          minimumSeparation,
          new Vector3(...sampled.position).distanceTo(new Vector3(...other.position)),
        );
        if (box.intersectsOBB(sampledBox(other)))
          boxesOverlap.push({ frame, time, objects: [sampled.id, other.id] });
      }
    }
    if (timeline.camera && timeline.shot) {
      const camera = new PerspectiveCamera(timeline.camera.fov, 16 / 9, 0.01, 100000);
      camera.position.set(...timeline.camera.position);
      camera.lookAt(...timeline.camera.target);
      camera.updateMatrixWorld();
      const visible = alive.filter(({ sampled }) => {
        const ndc = new Vector3(...sampled.position).project(camera);
        return Math.abs(ndc.x) < 1 && Math.abs(ndc.y) < 1 && ndc.z > -1 && ndc.z < 1;
      }).length;
      const coverage = shotCoverage.get(timeline.shot.id) ?? {
        frames: 0,
        noVehicleCenterVisible: 0,
        maximumVisibleVehicles: 0,
      };
      coverage.frames++;
      coverage.noVehicleCenterVisible += visible === 0 ? 1 : 0;
      coverage.maximumVisibleVehicles = Math.max(coverage.maximumVisibleVehicles, visible);
      shotCoverage.set(timeline.shot.id, coverage);
    }
  }
  const report = {
    projectId: project.id,
    revision: project.revision,
    frameCount,
    fps,
    duration: sequenceDuration(project),
    minimumMovementMetersPerOutputFrame: minimumMovement,
    minimumLiveVehicleCenterSeparation: minimumSeparation,
    staticIntervals,
    vehicleDimensionObbOverlaps: boxesOverlap,
    shotCoverage: Object.fromEntries(shotCoverage),
    limitations:
      'Data-level checks of every output frame. Dimension OBBs are conservative vehicle proxies. Vehicle-center visibility excludes partial geometry; an interior camera may show the road and windshield while the mounted car center is outside the frustum. These checks do not replace full exported-video playback review.',
  };
  await writeFile(resolve(directory, 'frame-motion-verification.json'), JSON.stringify(report, null, 2));
  const previous = JSON.parse(await readFile(resolve(directory, 'production-report.json'), 'utf8')) as Record<
    string,
    unknown
  >;
  await writeFile(
    resolve(directory, 'production-report.json'),
    JSON.stringify(
      {
        ...previous,
        minimumLiveShipMovementPerFrame: theme === 'space' ? minimumMovement : undefined,
        geometryVerification: report,
        review:
          'Actual PNGs visually reviewed and frame-level motion/vehicle OBB checks completed. Full MP4 export and playback review pending.',
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      theme,
      frameCount,
      minimumMovement,
      minimumSeparation,
      staticIntervals: staticIntervals.length,
      obbOverlaps: boxesOverlap.length,
      shotCoverage: report.shotCoverage,
    }),
  );
}
