import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Download, LoaderCircle, RotateCcw } from 'lucide-react';
import type { RenderJob } from '../../shared/types';

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
