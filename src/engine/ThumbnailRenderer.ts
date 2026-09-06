import type { Project, Shot } from '../../shared/types';
import { SceneEngine } from './SceneEngine';

const cache = new Map<string, string>();
const pending = new Map<string, Promise<string | null>>();
const maxEntries = 128;
let engine: SceneEngine | null = null;
let container: HTMLDivElement | null = null;
let loadedProjectKey = '';
let requestedProjectKey = '';
let queue: Promise<unknown> = Promise.resolve();
let generation = 0;

function sharedEngine() {
  if (!engine) {
    container = document.createElement('div');
    container.style.cssText =
      'position:fixed;left:-10000px;top:0;width:240px;height:135px;pointer-events:none';
    container.setAttribute('aria-hidden', 'true');
    document.body.append(container);
    engine = new SceneEngine(container, { interactive: false });
    engine.setHelpers(false);
    engine.setSafeFrame(false);
    engine.setView('camera');
  }
  return engine;
}

export function requestShotThumbnail(project: Project, shot: Shot): Promise<string | null> {
  const projectKey = `${project.id}:${project.revision}:${project.updatedAt}`;
  const key = `${projectKey}:${shot.id}:${shot.sourceIn}:${shot.sourceOut}`;
  requestedProjectKey = projectKey;
  const cached = cache.get(key);
  if (cached) {
    cache.delete(key);
    cache.set(key, cached);
    return Promise.resolve(cached);
  }
  const existing = pending.get(key);
  if (existing) return existing;
  const requestedGeneration = generation;
  const render = async () => {
    if (requestedGeneration !== generation || requestedProjectKey !== projectKey) return null;
    const renderer = sharedEngine();
    if (loadedProjectKey !== projectKey) {
      await renderer.setProject(project);
      if (requestedGeneration !== generation) return null;
      renderer.resize(240, 135);
      loadedProjectKey = projectKey;
    }
    if (requestedGeneration !== generation || requestedProjectKey !== projectKey) return null;
    renderer.setTime(0, { shotId: shot.id, sourceTime: (shot.sourceIn + shot.sourceOut) / 2 });
    const result = renderer.capture();
    cache.set(key, result);
    while (cache.size > maxEntries) cache.delete(cache.keys().next().value!);
    return result;
  };
  const result = queue.then(render, render);
  pending.set(key, result);
  queue = result.catch(() => null);
  void result.finally(() => pending.delete(key)).catch(() => undefined);
  return result;
}

export function disposeThumbnailRenderer() {
  generation++;
  engine?.dispose();
  engine = null;
  container?.remove();
  container = null;
  loadedProjectKey = '';
  requestedProjectKey = '';
  cache.clear();
  pending.clear();
}

window.addEventListener('pagehide', disposeThumbnailRenderer);
if (import.meta.hot) import.meta.hot.dispose(disposeThumbnailRenderer);
