import { useCallback, useEffect, useState } from 'react';
import { Copy, Plus, Users, X } from 'lucide-react';
import type { ReviewInvite, ReviewPublication } from '../../shared/review';
import type { RenderJob } from '../../shared/types';
import { api } from '../api';
import { Field, IconButton, Modal } from './Controls';
import { ReviewWorkspace, type ReviewState } from './ReviewWorkspace';

export function ReviewDialog({ jobs, onClose }: { jobs: RenderJob[]; onClose: () => void }) {
  const [publications, setPublications] = useState<ReviewPublication[]>([]);
  const [id, setId] = useState('');
  const [state, setState] = useState<ReviewState & { invites: ReviewInvite[] }>();
  const [jobId, setJobId] = useState(jobs.find((job) => job.status === 'completed')?.id ?? '');
  const [title, setTitle] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<'reviewer' | 'viewer'>('reviewer');
  const [invitation, setInvitation] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const result = await api<{ publications: ReviewPublication[] }>('/reviews');
    setPublications(result.publications);
    if (!id && result.publications.length) setId(result.publications[0]!.id);
    if (id) setState(await api(`/reviews/${id}`));
  }, [id]);
  useEffect(() => {
    void load().catch((failure: Error) => setError(failure.message));
    const timer = setInterval(() => {
      void load().catch((failure: Error) => setError(failure.message));
    }, 3000);
    return () => clearInterval(timer);
  }, [load]);
  const execute = async (action: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await action();
      await load();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const select = (value: string) => {
    setId(value);
    setState(undefined);
    setInvitation('');
  };
  return (
    <Modal title="团队审片" onClose={onClose} wide>
      <div className="modal-content review-owner">
        <div className="review-publication-controls">
          <Field label="审片版本">
            <select aria-label="审片版本" value={id} onChange={(event) => select(event.target.value)}>
              <option value="">未选择</option>
              {publications.map((publication) => (
                <option value={publication.id} key={publication.id}>
                  {publication.title} · r{publication.projectRevision}
                </option>
              ))}
            </select>
          </Field>
          <details>
            <summary>发布成片版本</summary>
            <fieldset disabled={busy}>
              <Field label="成片">
                <select
                  aria-label="发布成片"
                  value={jobId}
                  onChange={(event) => setJobId(event.target.value)}
                >
                  <option value="">选择已导出视频</option>
                  {jobs
                    .filter((job) => job.status === 'completed')
                    .map((job) => (
                      <option key={job.id} value={job.id}>
                        {job.name ?? job.id} · r{job.projectRevision}
                      </option>
                    ))}
                </select>
              </Field>
              <Field label="标题">
                <input
                  aria-label="审片版本标题"
                  value={title}
                  maxLength={200}
                  onChange={(event) => setTitle(event.target.value)}
                />
              </Field>
              <button
                className="text-button"
                disabled={!jobId || !title.trim()}
                onClick={() =>
                  void execute(async () => {
                    const publication = await api<ReviewPublication>('/reviews', {
                      method: 'POST',
                      body: JSON.stringify({ jobId, title }),
                    });
                    select(publication.id);
                    setTitle('');
                  })
                }
              >
                <Plus size={14} />
                发布审片版本
              </button>
            </fieldset>
          </details>
        </div>
        {state && state.publication.id === id && (
          <>
            <ReviewWorkspace
              key={id}
              state={state}
              videoUrl={`/api/renders/${state.publication.jobId}/stream`}
              downloadUrl={`/api/renders/${state.publication.jobId}/file`}
              add={async (input) => {
                await api(`/reviews/${id}/comments`, { method: 'POST', body: JSON.stringify(input) });
                await load();
              }}
              update={async (commentId, input) => {
                await api(`/reviews/${id}/comments/${commentId}`, {
                  method: 'PATCH',
                  body: JSON.stringify(input),
                });
                await load();
              }}
            />
            <details className="review-participants">
              <summary>审片成员</summary>
              <fieldset disabled={busy}>
                <div className="review-invite-form">
                  <Field label="姓名">
                    <input
                      aria-label="审片成员姓名"
                      value={name}
                      maxLength={100}
                      onChange={(event) => setName(event.target.value)}
                    />
                  </Field>
                  <Field label="权限">
                    <select
                      aria-label="审片成员权限"
                      value={role}
                      onChange={(event) => setRole(event.target.value as typeof role)}
                    >
                      <option value="reviewer">审片与评论</option>
                      <option value="viewer">仅查看</option>
                    </select>
                  </Field>
                  <button
                    className="text-button"
                    disabled={!name.trim()}
                    onClick={() =>
                      void execute(async () => {
                        const result = await api<{ url: string }>(`/reviews/${id}/invites`, {
                          method: 'POST',
                          body: JSON.stringify({ name, role }),
                        });
                        setInvitation(result.url);
                        setName('');
                      })
                    }
                  >
                    <Users size={14} />
                    创建邀请
                  </button>
                </div>
                {invitation && (
                  <div className="review-invitation">
                    <input aria-label="审片邀请链接" readOnly value={invitation} />
                    <IconButton
                      icon={Copy}
                      label="复制审片邀请链接"
                      onClick={() => {
                        void navigator.clipboard
                          .writeText(invitation)
                          .catch((failure: Error) => setError(failure.message));
                      }}
                    />
                  </div>
                )}
                {state.invites.map((invite) => (
                  <div className="review-invite-row" key={invite.id}>
                    <span>{invite.name}</span>
                    <span className="muted small">
                      {invite.revoked ? '已撤销' : invite.role === 'viewer' ? '仅查看' : '审片与评论'}
                    </span>
                    <span className="flex-spacer" />
                    {!invite.revoked && (
                      <IconButton
                        icon={X}
                        label={`撤销 ${invite.name} 的审片访问`}
                        onClick={() =>
                          void execute(async () => {
                            await api(`/reviews/${id}/invites/${invite.id}`, { method: 'DELETE' });
                          })
                        }
                      />
                    )}
                  </div>
                ))}
              </fieldset>
            </details>
          </>
        )}
        {!state && !id && <p className="muted small">暂无审片版本</p>}
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
