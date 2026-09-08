import { createContext, useContext, useRef, useSyncExternalStore, type ReactNode } from 'react';
import type { ComponentWorkspaceCommand, ComponentWorkspaceState } from '../../shared/topology-workspace';
import type { TopologyMesh } from '../../shared/topology/types';
import type { PreparedComponentSource } from '../engine/ComponentSource';

export interface TopologyWorkspaceSource {
  getState(): ComponentWorkspaceState;
  apply(command: ComponentWorkspaceCommand): Promise<void>;
  prepareSource(mesh: TopologyMesh): Promise<PreparedComponentSource>;
  subscribe(listener: () => void): () => void;
}
export class TopologyWorkspaceBridge {
  private source: TopologyWorkspaceSource | null = null;
  private detach: (() => void) | undefined;
  private listeners = new Set<() => void>();
  getState = () => this.source?.getState() ?? null;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private notify = () => this.listeners.forEach((listener) => listener());
  attach(source: TopologyWorkspaceSource | null) {
    this.detach?.();
    this.source = source;
    this.detach = source?.subscribe(this.notify);
    this.notify();
  }
  apply = async (command: ComponentWorkspaceCommand) => {
    if (!this.source) throw new Error('3D 视口尚未就绪');
    await this.source.apply(command);
  };
  prepare = async (mesh: TopologyMesh) => {
    if (!this.source) throw new Error('3D 视口尚未就绪');
    return this.source.prepareSource(mesh);
  };
}
export const TopologyWorkspaceContext = createContext<TopologyWorkspaceBridge | null>(null);
export function TopologyWorkspaceProvider({ children }: { children: ReactNode }) {
  const bridge = useRef(new TopologyWorkspaceBridge()).current;
  return <TopologyWorkspaceContext.Provider value={bridge}>{children}</TopologyWorkspaceContext.Provider>;
}
export function useTopologyWorkspace() {
  const bridge = useContext(TopologyWorkspaceContext)!;
  const state = useSyncExternalStore(bridge.subscribe, bridge.getState, bridge.getState);
  return { state, apply: bridge.apply, prepare: bridge.prepare };
}
