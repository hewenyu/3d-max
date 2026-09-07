import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { WorkspaceFailure, type WorkspaceCommand } from '../../shared/workspace';

export interface WorkspaceSurface {
  read(): unknown;
  apply(command: WorkspaceCommand): void | Promise<void>;
}
export class WorkspaceSurfaces {
  readonly entries = new Map<string, WorkspaceSurface>();
  read<T>(name: string): T | null {
    return (this.entries.get(name)?.read() as T) ?? null;
  }
  async apply(name: string, command: WorkspaceCommand) {
    const surface = this.entries.get(name);
    if (!surface) throw new WorkspaceFailure('SURFACE_NOT_READY', `${name} is not open or ready`);
    await surface.apply(command);
  }
}
export const WorkspaceSurfaceContext = createContext<WorkspaceSurfaces | null>(null);

export function useWorkspaceSurface(name: string, surface: WorkspaceSurface) {
  const registry = useContext(WorkspaceSurfaceContext);
  const current = useRef(surface);
  current.current = surface;
  useEffect(() => {
    const entry = {
      read: () => current.current.read(),
      apply: (command: WorkspaceCommand) => current.current.apply(command),
    };
    registry?.entries.set(name, entry);
    return () => {
      if (registry?.entries.get(name) === entry) registry.entries.delete(name);
    };
  }, [registry, name]);
}

export function useWorkspaceInspectorMode() {
  const [mode, setMode] = useState<'base' | 'keyframe'>('base');
  useWorkspaceSurface('inspector', {
    read: () => ({ mode }),
    apply: (command) => {
      if (command.type === 'panels' && command.inspectorMode) setMode(command.inspectorMode);
    },
  });
  return [mode, setMode] as const;
}

export async function settleWorkspace() {
  for (let frame = 0; frame < 2; frame++)
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 100);
      requestAnimationFrame(() => {
        clearTimeout(timer);
        resolve();
      });
    });
}

export async function waitWorkspaceReady(check: () => boolean, timeout = 10000) {
  const start = performance.now();
  while (!check()) {
    if (performance.now() - start > timeout)
      throw new WorkspaceFailure('SURFACE_NOT_READY', 'The workspace did not become ready');
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}
