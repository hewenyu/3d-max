import type { ModelingData } from './modeling';
import type { ProductionState } from './production';
import type { ActorAnimation } from './actor-animation';
import type { EffectSettings, MotionEvent, MotionPath, VehicleSettings } from './motion';
import type { RigidBodySettings } from './physics';
import type { Aspect, CameraComposition, CameraOptics, SafeArea } from './camera-optics';
import type { ContinuityState } from './continuity-types';
import type { SynchronizationGroup } from './synchronization';
import type { FaceAnimation, ModelMorph } from './face-animation';

export type Vec3 = [number, number, number];
export type ObjectType =
  | 'box'
  | 'sphere'
  | 'cylinder'
  | 'plane'
  | 'wall'
  | 'door'
  | 'window'
  | 'sofa'
  | 'table'
  | 'chair'
  | 'actor'
  | 'phone'
  | 'group'
  | 'model';
export type Action = 'idle' | 'walk' | 'sit' | 'talk';
export interface ActorPose {
  headPitch: number;
  headYaw: number;
  leftArm: number;
  rightArm: number;
  leftLeg: number;
  rightLeg: number;
}
export interface Attachment {
  objectId: string;
  bone: 'rightHand' | 'leftHand' | 'head' | 'root';
  offset: Vec3;
}
export interface ObjectKeyframe {
  id: string;
  time: number;
  position?: Vec3;
  rotation?: Vec3;
  scale?: Vec3;
  pose?: Partial<ActorPose>;
  action?: Action;
  lookAtId?: string | null;
  attachment?: Attachment | null;
  easing?: 'linear' | 'smooth' | 'step';
}
export interface SceneObject {
  id: string;
  name: string;
  type: ObjectType;
  parentId: string | null;
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
  dimensions: Vec3;
  visible: boolean;
  locked: boolean;
  tone: string;
  keyframes: ObjectKeyframe[];
  actor?: {
    action: Action;
    speed: number;
    pose: ActorPose;
    lookAtId: string | null;
    animation?: ActorAnimation;
    face?: FaceAnimation;
  };
  attachment?: Attachment | null;
  assetUrl?: string;
  animationName?: string;
  animationIndex?: number | null;
  morph?: ModelMorph;
  modeling?: ModelingData;
  motion?: MotionPath;
  vehicle?: VehicleSettings;
  physics?: RigidBodySettings;
  motionEvents?: MotionEvent[];
  effect?: EffectSettings;
  rotationInterpolation?: 'linear' | 'quaternion';
}
export interface CameraKeyframe {
  id: string;
  time: number;
  position: Vec3;
  target: Vec3;
  fov: number;
  easing: 'linear' | 'smooth' | 'step';
}
export interface ShotCamera {
  optics?: CameraOptics;
  compositions?: Partial<Record<Aspect, CameraComposition>>;
  id: string;
  name: string;
  position: Vec3;
  target: Vec3;
  fov: number;
  locked: boolean;
  keyframes: CameraKeyframe[];
}
export interface Shot {
  lightingPlanId?: string;
  sceneId?: string;
  performanceId?: string;
  storySceneId?: string;
  id: string;
  name: string;
  cameraId: string;
  sourceIn: number;
  sourceOut: number;
  intent: string;
  subjectIds: string[];
  hiddenIds: string[];
  beatId: string | null;
  locked: boolean;
}
export interface SequenceClip {
  id: string;
  shotId: string;
  sourceIn: number;
  sourceOut: number;
  retiming?: ClipRetiming;
  cameraTiming?: CameraTiming;
  fadeIn?: number;
  fadeOut?: number;
  transitionIn?: import('./transitions').DissolveTransition;
}
export interface SpeedSegment {
  duration: number;
  fromSpeed: number;
  toSpeed: number;
  easing: 'constant' | 'linear' | 'smooth';
  curveIn?: number;
  curveOut?: number;
}
export interface ClipRetiming {
  segments: SpeedSegment[];
  audio: 'follow' | 'warp' | 'mute';
}
export interface CameraTiming {
  mode: 'source' | 'independent';
  sourceIn?: number;
  rate?: number;
}
export interface Sequence {
  id: string;
  name: string;
  clips: SequenceClip[];
  locked: boolean;
}
export interface Beat {
  id: string;
  label: string;
  time: number;
  endTime: number;
  kind: 'dialogue' | 'pause' | 'reaction' | 'reveal' | 'action';
  actorId: string | null;
  text: string;
  notes: string;
  locked: boolean;
}
export interface AudioClip {
  fadeIn?: number;
  fadeOut?: number;
  fadeCurve?: 'linear' | 'equalPower';
  id: string;
  name: string;
  url: string;
  start: number;
  sourceIn: number;
  duration: number;
  volume: number;
  muted: boolean;
  locked: boolean;
  sync: 'source' | 'sequence';
}
export interface DirectorNote {
  id: string;
  shotId: string | null;
  time: number;
  text: string;
}
export interface ProjectSettings {
  lightingPlanId?: string;
  environment?: { ground: boolean; background: string; groundTone: string };
  safeArea?: SafeArea;
  fps: number;
  aspect: '16:9' | '9:16' | '1:1';
  resolution: 720 | 1080;
  lighting: { intensity: number; ambient: number; azimuth: number; elevation: number };
  axisActorIds: string[];
}
export interface Project {
  lightingPlans?: import('./lighting-plans').LightingPlan[];
  continuity?: ContinuityState;
  synchronization?: SynchronizationGroup[];
  production?: ProductionState;
  schemaVersion: 1;
  id: string;
  name: string;
  sceneName: string;
  revision: number;
  objects: SceneObject[];
  cameras: ShotCamera[];
  shots: Shot[];
  sequences: Sequence[];
  activeSequenceId: string;
  beats: Beat[];
  audio: AudioClip[];
  notes: DirectorNote[];
  settings: ProjectSettings;
  updatedAt: string;
}
export interface Command {
  type: string;
  payload: Record<string, unknown>;
}
export interface CommandRequest {
  expectedContext?: { sceneId: string | null; performanceId: string | null };
  commands: Command[];
  projectId?: string;
  expectedRevision?: number;
  requestId?: string;
}
export interface CommandResponse {
  project: Project;
  results: unknown[];
  replayed?: boolean;
}
export interface TimelineSample {
  clip: SequenceClip | null;
  shot: Shot | null;
  camera: ShotCamera | null;
  sourceTime: number;
  cameraTime: number;
  clipTime: number;
  playbackRate: number;
  audioMuted: boolean;
  sequenceTime: number;
  duration: number;
  clipStart: number;
}
export interface RenderOptions {
  projectId?: string;
  expectedRevision?: number;
  sequenceId?: string;
  shotId?: string;
  fps?: number;
  resolution?: 720 | 1080;
  aspect?: '16:9' | '9:16' | '1:1';
  includeAudio?: boolean;
  burnIn?: boolean;
}
export interface RenderJob {
  id: string;
  name?: string;
  status: 'queued' | 'rendering' | 'encoding' | 'completed' | 'failed' | 'cancelled';
  progress: number;
  frame: number;
  totalFrames: number;
  projectRevision: number;
  createdAt: string;
  options: RenderOptions;
  url?: string;
  error?: string;
}
