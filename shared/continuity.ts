import { DomainError } from './domain-error';
import { resolveShotProject } from './production';
import { sampleTimeline, sequenceDuration } from './timeline';
import { clipDuration } from './time-map';
import { ContinuityScene, objectEvidenceSignature, type ContinuityFrame } from './continuity-scene';
import { inspectCut, inspectFrame, type FindingInput } from './continuity-rules';
import {
  continuityHash,
  reportOptionsSchema,
  type ContinuityFinding,
  type ContinuityOptions,
  type ContinuityReport,
  type ContinuityState,
} from './continuity-types';
import type { Project } from './types';

export * from './continuity-types';

export function analyzeContinuity(
  project: Project & { continuity?: ContinuityState },
  input: ContinuityOptions = {},
): ContinuityReport {
  const options = reportOptionsSchema.parse(input);
  const sequenceId = options.sequenceId ?? project.activeSequenceId;
  const sequence = project.sequences.find((item) => item.id === sequenceId);
  if (!sequence) throw new DomainError('Continuity sequence does not exist');
  const sampleRate = options.sampleRate ?? Math.min(30, project.settings.fps);
  const duration = sequenceDuration(project, sequenceId);
  const sampleTimes = new Set<number>();
  const addTime = (time: number) => {
    sampleTimes.add(time);
    if (sampleTimes.size > options.maxSamples)
      throw new DomainError(
        `Continuity analysis is above the ${options.maxSamples} sample limit; reduce sampleRate or select a shorter sequence`,
      );
  };
  const cuts: Array<{ time: number; before: number; beforeNeighbor: number; afterNeighbor: number }> = [];
  let start = 0;
  for (const [index, clip] of sequence.clips.entries()) {
    const length = clipDuration(clip);
    const step = 1 / sampleRate;
    for (let local = 0; local < length - 1e-8; local += step) addTime(start + local);
    const last = start + Math.max(0, length - 1 / project.settings.fps);
    addTime(last);
    if (index < sequence.clips.length - 1) {
      const cut = start + length;
      const nextLength = clipDuration(sequence.clips[index + 1]);
      const beforeNeighbor = Math.max(start, last - step);
      const afterNeighbor = cut + Math.min(step, Math.max(0, nextLength - 1 / project.settings.fps));
      cuts.push({ time: cut, before: last, beforeNeighbor, afterNeighbor });
      addTime(cut);
      addTime(beforeNeighbor);
      addTime(afterNeighbor);
    }
    start += length;
  }
  const scenes = new Map<string, ContinuityScene>();
  const cameraHashes = new Map(project.cameras.map((camera) => [camera.id, continuityHash(camera)]));
  const findings = new Map<string, ContinuityFinding>();
  const identities = new Map<string, string>();
  const lastGroups = new Map<string, string>();
  const boundaryTimes = new Set(
    cuts.flatMap((cut) => [cut.time, cut.before, cut.beforeNeighbor, cut.afterNeighbor]),
  );
  const boundaries = new Map<number, ContinuityFrame>();
  const emit = (frame: ContinuityFrame, finding: FindingInput) => {
    const shot = frame.sample.shot;
    const clip = frame.sample.clip;
    if (!shot || !clip) return;
    const discriminator = [finding.evidence.constraintId ?? '', finding.evidence.status ?? ''];
    const base = JSON.stringify([
      finding.rule,
      clip.id,
      finding.objectIds,
      finding.otherShotId,
      discriminator,
    ]);
    const lastGroup = lastGroups.get(base);
    const previous = lastGroup ? findings.get(lastGroup) : undefined;
    if (previous && frame.sample.sequenceTime - previous.sequenceEndTime <= 1.5 / sampleRate) {
      previous.sequenceEndTime = Math.max(previous.sequenceEndTime, frame.sample.sequenceTime);
      previous.sourceEndTime = Math.max(previous.sourceEndTime, frame.sample.sourceTime);
      return;
    }
    const group = `${base}:${Math.round(frame.sample.sequenceTime * 1000000)}`;
    lastGroups.set(base, group);
    const identity = continuityHash([
      finding.rule,
      clip,
      finding.otherShotId,
      cameraHashes.get(shot.cameraId),
      shot,
      frame.sceneKey,
      objectEvidenceSignature(frame, finding.objectIds),
      finding.evidence,
    ]);
    identities.set(group, identity);
    findings.set(group, {
      ...finding,
      id: '',
      clipId: clip.id,
      shotId: shot.id,
      cameraId: shot.cameraId,
      sourceTime: frame.sample.sourceTime,
      sourceEndTime: frame.sample.sourceTime,
      sequenceTime: frame.sample.sequenceTime,
      sequenceEndTime: frame.sample.sequenceTime,
      ignored: false,
    });
  };
  let previous: ContinuityFrame | undefined;
  try {
    for (const time of [...sampleTimes].sort((left, right) => left - right)) {
      const sample = sampleTimeline(project, time, sequenceId);
      if (!sample.shot || !sample.camera) continue;
      const key = JSON.stringify([
        sample.shot.sceneId ?? project.production?.activeSceneId ?? '',
        sample.shot.performanceId ?? project.production?.activePerformanceId ?? '',
      ]);
      let scene = scenes.get(key);
      if (!scene) {
        const view = resolveShotProject(project, sample.shot);
        const sceneKey = sample.shot.sceneId ?? project.production?.activeSceneId ?? project.id;
        scene = new ContinuityScene(view, sceneKey);
        scenes.set(key, scene);
      }
      const frame = scene.sample(sample);
      inspectFrame(frame, scene, (finding) => emit(frame, finding), previous);
      if (boundaryTimes.has(time)) boundaries.set(time, frame);
      previous = frame;
    }
    for (const cut of cuts) {
      const before = boundaries.get(cut.before),
        after = boundaries.get(cut.time);
      if (before && after)
        inspectCut(
          before,
          after,
          (finding) => emit(after, finding),
          boundaries.get(cut.beforeNeighbor),
          boundaries.get(cut.afterNeighbor),
        );
    }
    const ignored = new Map(
      project.continuity?.ignored.map((entry) => [entry.findingId, entry.reason]) ?? [],
    );
    for (const [group, finding] of findings) {
      finding.id = `continuity-${continuityHash([
        sequenceId,
        identities.get(group),
        Math.round(finding.sequenceTime * 10000),
        Math.round(finding.sequenceEndTime * 10000),
      ])}`;
      const reason = ignored.get(finding.id);
      finding.ignored = reason !== undefined;
      if (reason !== undefined) finding.ignoreReason = reason;
    }
    return {
      projectId: project.id,
      revision: project.revision,
      sequenceId,
      duration,
      sampleRate,
      sampledFrames: sampleTimes.size,
      findings: [...findings.values()].sort(
        (left, right) => left.sequenceTime - right.sequenceTime || left.rule.localeCompare(right.rule),
      ),
    };
  } finally {
    for (const scene of scenes.values()) scene.dispose();
  }
}
