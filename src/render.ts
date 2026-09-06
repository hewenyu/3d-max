import type { Project } from '../shared/types';
import { SceneEngine } from './engine/SceneEngine';

interface FrameOptions {
  sequenceId?: string;
  shotId?: string;
  sourceTime?: number;
  burnIn?: boolean;
}
interface RenderBridge {
  load: (project: Project, width: number, height: number) => Promise<void>;
  frame: (time: number, options?: FrameOptions) => Promise<string>;
}

declare global {
  interface Window {
    __WHITEFRAME_RENDER__?: RenderBridge;
  }
}

function timecode(time: number, fps: number) {
  const frames = Math.max(0, Math.round(time * fps));
  const seconds = Math.floor(frames / fps);
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60, frames % fps]
    .map((value) => String(value).padStart(2, '0'))
    .join(':');
}

export function setupRenderPage(): void {
  document.body.style.cssText = 'margin:0;background:#cfd6d3;overflow:hidden';
  const container = document.createElement('div');
  container.style.cssText = 'position:relative;width:1280px;height:720px';
  document.body.replaceChildren(container);
  const engine = new SceneEngine(container, { interactive: false });
  const composite = document.createElement('canvas');
  let loadedProject: Project | null = null;
  let width = 1280;
  let height = 720;
  engine.setHelpers(false);
  engine.setView('camera');
  window.__WHITEFRAME_RENDER__ = {
    async load(project, nextWidth, nextHeight) {
      if (
        !Number.isInteger(nextWidth) ||
        !Number.isInteger(nextHeight) ||
        nextWidth < 1 ||
        nextHeight < 1 ||
        nextWidth > 4096 ||
        nextHeight > 4096
      ) {
        throw new Error('Render dimensions must be between 1 and 4096 pixels');
      }
      width = nextWidth;
      height = nextHeight;
      loadedProject = project;
      container.style.width = `${width}px`;
      container.style.height = `${height}px`;
      await engine.setProject(project);
      engine.resize(width, height);
      composite.width = width;
      composite.height = height;
      await document.fonts.ready;
    },
    async frame(time, options = {}) {
      if (!loadedProject) throw new Error('Load a project before rendering frames');
      await engine.ready;
      engine.setTime(time, options);
      if (!options.burnIn) return engine.capture();
      const context = composite.getContext('2d');
      if (!context) throw new Error('2D composition context unavailable');
      context.drawImage(engine.canvas, 0, 0, width, height);
      const padding = Math.max(16, Math.round(width * 0.025));
      const textSize = Math.max(14, Math.round(height * 0.025));
      const bandHeight = textSize + padding * 1.5;
      context.fillStyle = 'rgba(15,24,20,.65)';
      context.fillRect(0, height - bandHeight, width, bandHeight);
      context.font = `500 ${textSize}px monospace`;
      context.textBaseline = 'middle';
      context.fillStyle = '#f1f4ef';
      context.textAlign = 'left';
      const sample = engine.getSample();
      context.fillText(
        sample?.shot?.name || loadedProject.sceneName,
        padding,
        height - bandHeight / 2,
        width * 0.6,
      );
      context.textAlign = 'right';
      context.fillText(timecode(time, loadedProject.settings.fps), width - padding, height - bandHeight / 2);
      return composite.toDataURL('image/png');
    },
  };
}
