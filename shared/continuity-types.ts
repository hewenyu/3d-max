import { z } from 'zod';
import type { Project, Vec3 } from './types';
import { DomainError } from './domain-error';

const identifier = z.string().min(1).max(200);
export const continuityRules = [
  'axis-crossing',
  'screen-direction',
  'eyeline-switch',
  'action-phase',
  'prop-state',
  'camera-collision',
  'subject-out-of-frame',
  'subject-occluded',
  'contact-error',
] as const;
export type ContinuityRule = (typeof continuityRules)[number];
export const continuityStateSchema = z
  .object({
    ignored: z
      .array(
        z
          .object({
            findingId: identifier,
            reason: z.string().trim().min(1).max(2000),
          })
          .strict(),
      )
      .max(10000),
  })
  .strict();
export type ContinuityState = z.infer<typeof continuityStateSchema>;
export const reportOptionsSchema = z
  .object({
    sequenceId: identifier.optional(),
    sampleRate: z.number().int().min(1).max(30).optional(),
    maxSamples: z.number().int().min(1).max(20000).default(20000),
  })
  .strict();
export type ContinuityOptions = z.input<typeof reportOptionsSchema>;
export interface ContinuityFinding {
  id: string;
  rule: ContinuityRule;
  severity: 'warning' | 'error';
  shotId: string;
  clipId: string;
  cameraId: string;
  objectIds: string[];
  sourceTime: number;
  sourceEndTime: number;
  sequenceTime: number;
  sequenceEndTime: number;
  otherShotId?: string;
  message: string;
  evidence: Record<string, string | number | boolean | null | Vec3 | string[]>;
  ignored: boolean;
  ignoreReason?: string;
}
export interface ContinuityReport {
  projectId: string;
  revision: number;
  sequenceId: string;
  sampledFrames: number;
  sampleRate: number;
  duration: number;
  findings: ContinuityFinding[];
}

export const continuityCommandDefinitions = [
  {
    type: 'continuity.ignore',
    description:
      'Record a director-approved intentional continuity exception by exact finding ID. A nonempty reason is required; null restores the finding. Findings change identity when relevant scene or camera content changes.',
    schema: z
      .object({ findingId: identifier, reason: z.string().trim().min(1).max(2000).nullable() })
      .strict(),
  },
];

export function applyContinuityCommand(
  project: Project & { continuity?: ContinuityState },
  type: string,
  payload: Record<string, unknown>,
): unknown {
  if (type !== 'continuity.ignore') throw new DomainError(`Unknown continuity command: ${type}`);
  const parsed = continuityCommandDefinitions[0].schema.parse(payload);
  const state = project.continuity ?? { ignored: [] };
  state.ignored = state.ignored.filter((entry) => entry.findingId !== parsed.findingId);
  if (parsed.reason !== null) state.ignored.push({ findingId: parsed.findingId, reason: parsed.reason });
  project.continuity = state;
  return parsed;
}

export function continuityHash(value: unknown): string {
  const source = JSON.stringify(value);
  let hash = 14695981039346656037n;
  for (let index = 0; index < source.length; index++)
    hash = BigInt.asUintN(64, (hash ^ BigInt(source.charCodeAt(index))) * 1099511628211n);
  return hash.toString(36);
}

export const continuityRuleLabels: Record<ContinuityRule, string> = {
  'axis-crossing': '摄影机越轴',
  'screen-direction': '运动方向反转',
  'eyeline-switch': '注视目标变化',
  'action-phase': '动作阶段跳变',
  'prop-state': '持物状态变化',
  'camera-collision': '摄影机穿入物体',
  'subject-out-of-frame': '主体出画',
  'subject-occluded': '主体遮挡',
  'contact-error': '接触约束误差',
};
