import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Download, LoaderCircle, RotateCcw } from 'lucide-react';
import type { RenderJob } from '../../shared/types';
import { useWorkspaceSurface, settleWorkspace, waitWorkspaceReady } from '../workspace/Surfaces';
import { WorkspaceFailure, type WorkspaceMedia } from '../../shared/workspace';

function mediaError(error: MediaError | null) {
  if (error?.code === MediaError.MEDIA_ERR_NETWORK) return '视频载入失败，请检查连接后重试。';
  if (error?.code === MediaError.MEDIA_ERR_DECODE) return '视频无法解码，请重新导出后播放。';
  return '无法播放此视频，文件可能已移动、删除或损坏。';
}

export function VideoPlayer({ job, onBack }: { job: RenderJob; onBack: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const stream = `/api/renders/${encodeURIComponent(job.id)}/stream${attempt ? `?retry=${attempt}` : ''}`;
  useWorkspaceSurface('video', {
    read: (): WorkspaceMedia => {
      const element = video.current;
      return {
        jobId: job.id,
        time: element?.currentTime ?? 0,
        duration: Number.isFinite(element?.duration) ? element!.duration : 0,
        paused: element?.paused ?? true,
        muted: element?.muted ?? false,
        volume: element?.volume ?? 1,
        playbackRate: element?.playbackRate ?? 1,
        readyState: element?.readyState ?? 0,
        loading,
        ended: element?.ended ?? false,
        error: error || (element?.error ? mediaError(element.error) : null),
      };
    },
    apply: async (command) => {
      if (command.type === 'fullscreen') {
        try {
          if (!video.current) throw new Error('Video player is not ready');
          if (command.enabled && document.fullscreenElement !== video.current)
            await video.current.requestFullscreen();
          else if (!command.enabled && document.fullscreenElement) await document.exitFullscreen();
          if ((document.fullscreenElement === video.current) !== command.enabled)
            throw new Error('Browser did not apply video fullscreen');
        } catch (cause) {
          throw new WorkspaceFailure(
            'FULLSCREEN_REJECTED',
            cause instanceof Error ? cause.message : String(cause),
          );
        }
        return;
      }
      if (command.type !== 'video') return;
      if (command.action === 'retry') {
        setError('');
        setLoading(true);
        setAttempt((value) => value + 1);
        await settleWorkspace();
      }
      await waitWorkspaceReady(
        () => !!video.current && (video.current.readyState >= 1 || !!video.current.error),
      );
      const element = video.current!;
      if (element.error) throw new WorkspaceFailure('MEDIA_ERROR', mediaError(element.error));
      if (command.time !== undefined) {
        if (command.time > element.duration)
          throw new WorkspaceFailure('INVALID_MEDIA_TIME', 'Time is outside the exported video');
        element.currentTime = command.time;
        await waitWorkspaceReady(() => !element.seeking || !!element.error);
        if (element.error) throw new WorkspaceFailure('MEDIA_ERROR', mediaError(element.error));
      }
      if (command.muted !== undefined) element.muted = command.muted;
      if (command.volume !== undefined) element.volume = command.volume;
      if (command.playbackRate !== undefined) element.playbackRate = command.playbackRate;
      if (command.action === 'pause') element.pause();
      if (command.action === 'play') {
        try {
          await element.play();
        } catch (cause) {
          throw new WorkspaceFailure(
            'PLAYBACK_REJECTED',
            cause instanceof Error ? cause.message : String(cause),
          );
        }
      }
    },
  });
  useEffect(() => {
    const element = video.current;
    return () => {
      element?.pause();
      element?.removeAttribute('src');
      element?.load();
    };
  }, [attempt, job.id]);
  return (
    <div className="export-video-player">
      <div className="video-review-toolbar">
        <button className="text-button" onClick={onBack}>
          <ArrowLeft size={16} />
          返回导出记录
        </button>
        <span className="flex-spacer" />
        <span className="small muted">
          r{job.projectRevision} · {new Date(job.createdAt).toLocaleString('zh-CN')}
        </span>
        <a
          className="text-button"
          href={job.url ?? `/api/renders/${encodeURIComponent(job.id)}/file`}
          download
        >
          <Download size={15} />
          下载 MP4
        </a>
      </div>
      <div className="video-review-stage" aria-busy={loading && !error}>
        <video
          key={`${job.id}:${attempt}`}
          ref={video}
          src={stream}
          controls
          playsInline
          autoPlay
          preload="metadata"
          aria-label="已导出白模视频"
          onLoadStart={() => {
            setLoading(true);
            setError('');
          }}
          onCanPlay={() => setLoading(false)}
          onPlaying={() => setLoading(false)}
          onWaiting={() => setLoading(true)}
          onSeeked={() => {
            if ((video.current?.readyState ?? 0) >= 3) setLoading(false);
          }}
          onError={() => {
            setLoading(false);
            setError(mediaError(video.current?.error ?? null));
          }}
        />
        {loading && !error && (
          <div className="video-loading" role="status">
            <LoaderCircle size={20} className="spin" />
            <span>正在载入视频</span>
          </div>
        )}
        {error && (
          <div className="video-playback-error" role="alert">
            <p>{error}</p>
            <button
              className="text-button"
              onClick={() => {
                setError('');
                setLoading(true);
                setAttempt((value) => value + 1);
              }}
            >
              <RotateCcw size={16} />
              重试播放
            </button>
          </div>
        )}
      </div>
      <div className="video-review-details">
        <span>{job.name ?? '已导出视频'}</span>
        <span>
          {job.options.aspect ?? 'MP4'} · {job.options.resolution ?? 720}p · {job.options.fps ?? 24} fps
        </span>
        <span>{job.totalFrames} 帧</span>
      </div>
    </div>
  );
}
