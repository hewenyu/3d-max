import { useEffect, useRef, useState } from 'react';
import { Check, Clock3, Download, MessageSquare, Pencil, RotateCcw, Send, X } from 'lucide-react';
import type { ReviewComment, ReviewPrincipal, ReviewPublication } from '../../shared/review';
import { IconButton } from './Controls';
import './review.css';

export interface ReviewState {
  publication: ReviewPublication;
  principal: ReviewPrincipal;
  comments: ReviewComment[];
}
export function ReviewWorkspace({
  state,
  videoUrl,
  downloadUrl,
  add,
  update,
}: {
  state: ReviewState;
  videoUrl: string;
  downloadUrl: string;
  add: (input: { requestId: string; time: number; text: string; replyTo?: string }) => Promise<void>;
  update: (
    id: string,
    input: { expectedVersion: number; text?: string; status?: 'open' | 'resolved' },
  ) => Promise<void>;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [time, setTime] = useState(0);
  const [text, setText] = useState('');
  const [replyTo, setReplyTo] = useState<string>();
  const [editing, setEditing] = useState<ReviewComment>();
  const [filter, setFilter] = useState('all');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef<{ fingerprint: string; id: string } | undefined>(undefined);
  const { publication, principal, comments } = state;
  useEffect(() => {
    const element = video.current;
    return () => {
      element?.pause();
      element?.removeAttribute('src');
      element?.load();
    };
  }, [publication.id]);
  const stamp = (seconds: number) =>
    `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}:${String(Math.floor((seconds % 1) * publication.fps)).padStart(2, '0')}`;
  const execute = async (operation: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await operation();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const submit = () =>
    execute(async () => {
      if (editing) await update(editing.id, { expectedVersion: editing.version, text });
      else {
        const input = { time, text, ...(replyTo ? { replyTo } : {}) };
        const fingerprint = JSON.stringify(input);
        if (pending.current?.fingerprint !== fingerprint)
          pending.current = { fingerprint, id: crypto.randomUUID() };
        await add({ ...input, requestId: pending.current.id });
        pending.current = undefined;
      }
      setText('');
      setReplyTo(undefined);
      setEditing(undefined);
    });
  const seek = (seconds: number) => {
    if (!video.current) return;
    video.current.currentTime = seconds;
    video.current.pause();
    setTime(seconds);
  };
  const editable = (comment: ReviewComment) =>
    principal.role === 'owner' || (principal.role === 'reviewer' && comment.author.id === principal.id);
  const row = (comment: ReviewComment) => (
    <div className="review-comment" key={comment.id}>
      <div className="review-comment-meta">
        <strong>{comment.author.name}</strong>
        <button className="text-button mono" onClick={() => seek(comment.time)}>
          <Clock3 size={13} />
          {stamp(comment.time)}
        </button>
        <span className="flex-spacer" />
        {comment.status === 'resolved' && <span className="small muted">已解决</span>}
        {editable(comment) && (
          <IconButton
            icon={Pencil}
            label="编辑审片意见"
            disabled={busy}
            onClick={() => {
              setEditing(comment);
              setReplyTo(undefined);
              setText(comment.text);
            }}
          />
        )}
        {!comment.replyTo && editable(comment) && (
          <IconButton
            icon={comment.status === 'resolved' ? RotateCcw : Check}
            label={comment.status === 'resolved' ? '重新打开意见' : '解决意见'}
            disabled={busy}
            onClick={() =>
              void execute(() =>
                update(comment.id, {
                  expectedVersion: comment.version,
                  status: comment.status === 'resolved' ? 'open' : 'resolved',
                }),
              )
            }
          />
        )}
        {!comment.replyTo && principal.role !== 'viewer' && (
          <IconButton
            icon={MessageSquare}
            label="回复审片意见"
            disabled={busy}
            onClick={() => {
              setEditing(undefined);
              setReplyTo(comment.id);
              setText('');
              seek(comment.time);
            }}
          />
        )}
      </div>
      <p>{comment.text}</p>
    </div>
  );
  return (
    <div className="review-workspace">
      <section className="review-media">
        <video
          key={publication.id}
          ref={video}
          src={videoUrl}
          controls
          playsInline
          preload="metadata"
          aria-label="审片视频"
          onTimeUpdate={() => setTime(video.current?.currentTime ?? 0)}
          onError={() => setError('视频无法载入，访问可能已撤销。')}
        />
        <div className="review-media-meta">
          <span>
            r{publication.projectRevision} · {publication.duration.toFixed(2)} s · {publication.fps} fps
          </span>
          <a className="text-button" href={downloadUrl} download>
            <Download size={15} />
            下载 MP4
          </a>
        </div>
      </section>
      <section className="review-discussion" aria-label="审片意见">
        <div className="review-discussion-header">
          <strong>审片意见</strong>
          <select
            aria-label="审片意见筛选"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          >
            <option value="all">全部</option>
            <option value="open">未解决</option>
            <option value="resolved">已解决</option>
          </select>
        </div>
        <div className="review-threads">
          {comments
            .filter((comment) => !comment.replyTo && (filter === 'all' || comment.status === filter))
            .map((comment) => (
              <article className="review-thread" key={comment.id}>
                {row(comment)}
                <div className="review-replies">
                  {comments.filter((reply) => reply.replyTo === comment.id).map(row)}
                </div>
              </article>
            ))}
          {comments.length === 0 && <p className="muted small">暂无审片意见</p>}
        </div>
        {principal.role !== 'viewer' && (
          <form
            className="review-composer"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <div className="row">
              <span className="small">{editing ? '编辑意见' : replyTo ? '回复意见' : principal.name}</span>
              <span className="flex-spacer" />
              <span className="mono small">{stamp(time)}</span>
              {(editing || replyTo) && (
                <IconButton
                  icon={X}
                  label="取消编辑意见"
                  onClick={() => {
                    setEditing(undefined);
                    setReplyTo(undefined);
                    setText('');
                  }}
                />
              )}
            </div>
            <textarea
              aria-label="审片意见内容"
              value={text}
              maxLength={10000}
              onChange={(event) => setText(event.target.value)}
              disabled={busy}
            />
            <button type="submit" className="primary-button" disabled={busy || !text.trim()}>
              <Send size={14} />
              {editing ? '保存意见' : '提交意见'}
            </button>
          </form>
        )}
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
      </section>
    </div>
  );
}
