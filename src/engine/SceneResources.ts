import { productionPerformance, resolveShotProject } from '../../shared/production';
import type { Project, SceneObject, Shot } from '../../shared/types';
import { buildObject, disposeBuiltObject, type BuiltObject } from './ObjectFactory';

import { distanceTable, type DistanceTable } from '../../shared/motion-distance';
export { gaitDistance } from '../../shared/motion-distance';

export interface SceneBinding {
  key: string;
  sceneKey: string;
  sceneId: string | null;
  performanceId: string | null;
  project: Project;
  workspace: boolean;
  objects: Map<string, BuiltObject>;
  distances: Map<string, DistanceTable>;
}

export interface SceneResources {
  workspace: SceneBinding;
  shots: Map<string, SceneBinding>;
  bindings: SceneBinding[];
  release: () => void;
}

interface ResourceEntry {
  references: number;
  pending: Promise<BuiltObject>;
  value?: BuiltObject;
}

function geometrySignature(object: SceneObject) {
  return JSON.stringify([
    object.type,
    object.dimensions,
    object.tone,
    object.assetUrl,
    object.animationName,
    object.animationIndex,
    object.modeling,
    object.vehicle,
    object.effect?.kind,
  ]);
}

function bindingIdentity(project: Project, shot?: Shot) {
  const sceneId = shot?.sceneId ?? project.production?.activeSceneId ?? '';
  const takeId = shot?.sceneId
    ? productionPerformance(project, sceneId, shot.performanceId)?.id
    : project.production?.activePerformanceId;
  return {
    sceneKey: JSON.stringify([project.id, sceneId]),
    key: JSON.stringify([project.id, sceneId, takeId ?? '']),
    sceneId: sceneId || null,
    performanceId: takeId ?? null,
  };
}

/** Leases keep live resources intact while a newer project revision is loading. */
export class SceneResourceCache {
  private readonly entries = new Map<string, ResourceEntry>();

  constructor(
    private readonly build = buildObject,
    private readonly dispose = disposeBuiltObject,
  ) {}

  async prepare(project: Project, signal: AbortSignal): Promise<SceneResources | null> {
    const bindings = new Map<string, SceneBinding>();
    const shots = new Map<string, SceneBinding>();
    const leases = new Map<string, ResourceEntry>();
    const assignments: Promise<void>[] = [];
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      for (const [key, entry] of leases) {
        entry.references--;
        if (entry.references > 0) continue;
        if (this.entries.get(key) === entry) this.entries.delete(key);
        if (entry.value) this.dispose(entry.value);
      }
    };
    const makeBinding = (shot?: Shot): SceneBinding => {
      const identity = bindingIdentity(project, shot);
      const existing = bindings.get(identity.key);
      if (existing) return existing;
      const view = shot ? resolveShotProject(project, shot) : project;
      const workspace = view === project;
      const binding: SceneBinding = {
        ...identity,
        project: view,
        workspace,
        objects: new Map(),
        distances: new Map(),
      };
      bindings.set(identity.key, binding);
      for (const object of view.objects) {
        const key = JSON.stringify([identity.sceneKey, object.id, geometrySignature(object)]);
        let entry = leases.get(key);
        if (!entry) {
          entry = this.entries.get(key);
          if (!entry) {
            const created: ResourceEntry = {
              references: 0,
              pending: Promise.resolve().then(() => this.build(object)),
            };
            created.pending.then(
              (value) => {
                created.value = value;
                if (created.references === 0) this.dispose(value);
              },
              () => {
                if (this.entries.get(key) === created) this.entries.delete(key);
              },
            );
            this.entries.set(key, created);
            entry = created;
          }
          entry.references++;
          leases.set(key, entry);
        }
        assignments.push(entry.pending.then((value) => void binding.objects.set(object.id, value)));
        if (object.type === 'actor' || object.vehicle)
          binding.distances.set(object.id, distanceTable(object));
      }
      return binding;
    };
    let cancel: () => void = () => {};
    try {
      const workspace = makeBinding();
      for (const shot of project.shots) shots.set(shot.id, makeBinding(shot));
      const cancelled = new Promise<null>((resolve) => {
        cancel = () => {
          release();
          resolve(null);
        };
        signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted) cancel();
      });
      const prepared = Promise.allSettled(assignments).then((results) => {
        if (signal.aborted) return null;
        const failure = results.find((result) => result.status === 'rejected');
        if (failure?.status === 'rejected') throw failure.reason;
        return { workspace, shots, bindings: [...bindings.values()], release };
      });
      return await Promise.race([prepared, cancelled]);
    } catch (error) {
      void Promise.allSettled(assignments);
      release();
      throw error;
    } finally {
      signal.removeEventListener('abort', cancel);
    }
  }
}
