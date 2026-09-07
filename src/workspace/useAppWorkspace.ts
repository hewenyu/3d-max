import { useContext, useRef } from 'react';
import type { Project } from '../../shared/types';
import { sampleTimeline } from '../../shared/timeline';
import { clipDuration } from '../../shared/time-map';
import {
  WorkspaceFailure,
  type WorkspaceState,
  type WorkspaceCommand,
  type WorkspaceDialog,
} from '../../shared/workspace';
import type { SceneEngine } from '../engine/SceneEngine';
import type { Playback } from '../usePlayback';
import { WorkspaceSurfaceContext, settleWorkspace, waitWorkspaceReady } from './Surfaces';
import { useWorkspaceBridge } from './useWorkspaceBridge';

interface Bindings {
  project: Project | null;
  engine: React.RefObject<SceneEngine | null>;
  playback: Playback;
  selected: string[];
  chooseObject: (ids: string[]) => void;
  mode: WorkspaceState['view'];
  setMode: (value: WorkspaceState['view']) => void;
  tool: WorkspaceState['settings']['tool'];
  setTool: (value: WorkspaceState['settings']['tool']) => void;
  snap: boolean;
  setSnap: (value: boolean) => void;
  helpers: boolean;
  setHelpers: (value: boolean) => void;
  safeFrame: boolean;
  setSafeFrame: (value: boolean) => void;
  leftVisible: boolean;
  setLeftVisible: (value: boolean) => void;
  rightVisible: boolean;
  setRightVisible: (value: boolean) => void;
  mobilePanel: 'left' | 'right' | null;
  setMobilePanel: (value: 'left' | 'right' | null) => void;
  inspectorTab: WorkspaceState['panels']['inspectorTab'];
  setInspectorTab: (value: WorkspaceState['panels']['inspectorTab']) => void;
  dialog: WorkspaceDialog;
  setDialog: (value: WorkspaceDialog) => void;
}

export function useAppWorkspace(bindings: Bindings) {
  const surfaces = useContext(WorkspaceSurfaceContext)!;
  const current = useRef(bindings);
  current.current = bindings;
  const read = (): Omit<WorkspaceState, 'revision'> | null => {
    const b = current.current;
    const engine = b.engine.current;
    const project = b.project;
    if (!project || !engine) return null;
    const sample = sampleTimeline(project, b.playback.time);
    const render = engine.getRenderContext();
    const size = engine.canvas.getBoundingClientRect();
    return {
      projectId: project.id,
      projectRevision: project.revision,
      context: {
        sceneId: project.production?.activeSceneId ?? null,
        performanceId: project.production?.activePerformanceId ?? null,
      },
      selection: b.selected,
      view: b.mode,
      observation: engine.getObservation(),
      transport: {
        time: b.playback.time,
        sourceTime: sample.sourceTime,
        cameraTime: sample.cameraTime,
        duration: b.playback.duration,
        playing: b.playback.playing,
        loop: b.playback.loop,
        muted: b.playback.muted,
      },
      settings: { tool: b.tool, snap: b.snap, helpers: b.helpers, safeFrame: b.safeFrame },
      panels: {
        leftVisible: b.leftVisible,
        rightVisible: b.rightVisible,
        mobilePanel: b.mobilePanel,
        inspectorTab: b.inspectorTab,
        inspectorMode: surfaces.read<{ mode: 'base' | 'keyframe' }>('inspector')?.mode ?? null,
        sceneTab: surfaces.read<{ tab: WorkspaceState['panels']['sceneTab'] }>('scene')?.tab ?? 'scene',
      },
      dialog: b.dialog,
      comparison: b.dialog === 'compare' ? surfaces.read('comparison') : null,
      cutReview: b.dialog === 'cuts' ? surfaces.read('cut-review') : null,
      media: b.dialog === 'export' ? surfaces.read('video') : null,
      fullscreen: document.fullscreenElement !== null,
      fullscreenTarget: !document.fullscreenElement
        ? null
        : document.fullscreenElement.matches('video')
          ? 'video'
          : document.fullscreenElement.matches('.viewport')
            ? 'viewport'
            : 'other',
      viewport: {
        width: size.width,
        height: size.height,
        loading: render.loading,
        sceneId: render.sceneId,
        performanceId: render.performanceId,
        workspace: render.workspace,
      },
    };
  };
  const apply = async (command: WorkspaceCommand) => {
    const b = current.current;
    const project = b.project;
    const engine = b.engine.current;
    if (!project || !engine) throw new WorkspaceFailure('WORKSPACE_NOT_READY', 'The project is not ready');
    const idsExist = (ids: string[]) => {
      const missing = ids.filter(
        (id) =>
          !project.objects.some((item) => item.id === id) && !project.cameras.some((item) => item.id === id),
      );
      if (missing.length)
        throw new WorkspaceFailure('ENTITY_NOT_FOUND', 'Workspace selection contains unknown entities', {
          ids: missing,
        });
    };
    const open = async (dialog: WorkspaceDialog) => {
      b.playback.setPlaying(false);
      b.setDialog(dialog);
      await settleWorkspace();
    };
    switch (command.type) {
      case 'selection': {
        idsExist(command.ids);
        const ids =
          command.mode === 'add'
            ? [...new Set([...b.selected, ...command.ids])]
            : command.mode === 'remove'
              ? b.selected.filter((id) => !command.ids.includes(id))
              : [...new Set(command.ids)];
        b.chooseObject(ids);
        break;
      }
      case 'view':
        b.setMode(command.mode);
        break;
      case 'observation': {
        const view = command.view ?? (b.mode === 'top' ? 'top' : 'edit');
        if (view === 'top' && (command.orbit || command.fov !== undefined))
          throw new WorkspaceFailure(
            'INVALID_OBSERVATION',
            'Top view supports position, target and zoom; orbit and FOV require edit view',
          );
        if (view === 'edit' && command.zoom !== undefined)
          throw new WorkspaceFailure('INVALID_OBSERVATION', 'Use dolly or FOV for perspective view');
        b.setMode(view);
        await settleWorkspace();
        engine.setObservation({ ...command, view });
        break;
      }
      case 'focus':
        if (command.ids) idsExist(command.ids);
        engine.focus(command.ids);
        break;
      case 'transport': {
        const p = b.playback;
        if (command.time !== undefined || command.stepFrames !== undefined) {
          p.setPlaying(false);
          p.seek(command.time ?? p.time + (command.stepFrames ?? 0) / project.settings.fps);
        }
        if (command.loop !== undefined) p.setLoop(command.loop);
        if (command.muted !== undefined) p.setMuted(command.muted);
        if (command.action === 'start') p.seek(0);
        if (command.action === 'end') p.seek(Math.max(0, p.duration - 1 / project.settings.fps));
        if (command.action === 'pause') p.setPlaying(false);
        if (command.action === 'toggle') p.toggle();
        if (command.action === 'play') {
          if (p.time >= p.duration && command.time === undefined) p.seek(0);
          p.setPlaying(true);
        }
        break;
      }
      case 'clip': {
        const sequence = project.sequences.find((item) => item.id === project.activeSequenceId);
        let time = 0;
        let found = false;
        for (const clip of sequence?.clips ?? []) {
          if (clip.id === command.clipId) {
            const shot = project.shots.find((item) => item.id === clip.shotId);
            b.playback.setPlaying(false);
            b.playback.seek(time);
            b.setMode('camera');
            b.setInspectorTab('shot');
            if (shot) b.chooseObject([shot.cameraId]);
            b.setInspectorTab('shot');
            found = true;
            break;
          }
          time += clipDuration(clip);
        }
        if (!found) throw new WorkspaceFailure('CLIP_NOT_FOUND', 'Clip is not in the active sequence');
        break;
      }
      case 'settings':
        if (command.tool !== undefined) b.setTool(command.tool);
        if (command.snap !== undefined) b.setSnap(command.snap);
        if (command.helpers !== undefined) b.setHelpers(command.helpers);
        if (command.safeFrame !== undefined) b.setSafeFrame(command.safeFrame);
        break;
      case 'panels':
        if (command.leftVisible !== undefined) b.setLeftVisible(command.leftVisible);
        if (command.rightVisible !== undefined) b.setRightVisible(command.rightVisible);
        if (command.mobilePanel !== undefined) b.setMobilePanel(command.mobilePanel);
        if (command.inspectorTab !== undefined) b.setInspectorTab(command.inspectorTab);
        await settleWorkspace();
        if (command.inspectorMode !== undefined) await surfaces.apply('inspector', command);
        if (command.sceneTab !== undefined) await surfaces.apply('scene', command);
        break;
      case 'dialog':
        if (
          command.name === 'cuts' &&
          (project.sequences.find((item) => item.id === project.activeSequenceId)?.clips.length ?? 0) < 2
        )
          throw new WorkspaceFailure('NO_CUTS', 'The active sequence has fewer than two clips');
        await open(command.name);
        break;
      case 'comparison':
        for (const id of [command.leftSequenceId, command.rightSequenceId])
          if (id && !project.sequences.some((item) => item.id === id))
            throw new WorkspaceFailure('SEQUENCE_NOT_FOUND', `Sequence not found: ${id}`);
        if (b.dialog !== 'compare') await open('compare');
        await surfaces.apply('comparison', command);
        break;
      case 'cut_review':
        if (command.time !== undefined) b.playback.seek(command.time);
        if ((project.sequences.find((item) => item.id === project.activeSequenceId)?.clips.length ?? 0) < 2)
          throw new WorkspaceFailure('NO_CUTS', 'The active sequence has fewer than two clips');
        await open('cuts');
        await surfaces.apply('cut-review', command);
        break;
      case 'video':
        if (command.action === 'close') {
          await open(null);
          break;
        }
        if (b.dialog !== 'export') await open('export');
        if (command.jobId) {
          await surfaces.apply('export', command);
          await settleWorkspace();
        }
        await waitWorkspaceReady(() => surfaces.entries.has('video'));
        await surfaces.apply('video', command);
        break;
      case 'fullscreen':
        if (command.target === 'video') {
          await surfaces.apply('video', command);
          break;
        }
        try {
          if (command.enabled && !document.fullscreenElement)
            await document.querySelector('.viewport')?.requestFullscreen();
          else if (!command.enabled && document.fullscreenElement) await document.exitFullscreen();
          if ((document.fullscreenElement !== null) !== command.enabled)
            throw new Error('Browser did not apply fullscreen');
        } catch (cause) {
          throw new WorkspaceFailure(
            'FULLSCREEN_REJECTED',
            cause instanceof Error ? cause.message : String(cause),
          );
        }
        break;
    }
    await settleWorkspace();
  };
  useWorkspaceBridge({
    enabled: !!bindings.project,
    name: `${bindings.project?.name ?? 'Whiteframe'} (${window.innerWidth}px)`,
    engine: () => current.current.engine.current,
    read,
    apply,
  });
  return surfaces;
}
