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
  actor?: { action: Action; speed: number; pose: ActorPose; lookAtId: string | null };
  attachment?: Attachment | null;
  assetUrl?: string;
  animationName?: string;
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
  id: string;
  name: string;
  position: Vec3;
  target: Vec3;
  fov: number;
  locked: boolean;
  keyframes: CameraKeyframe[];
}
export interface Shot {
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
  fps: number;
  aspect: '16:9' | '9:16' | '1:1';
  resolution: 720 | 1080;
  lighting: { intensity: number; ambient: number; azimuth: number; elevation: number };
  axisActorIds: string[];
}
export interface Project {
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
