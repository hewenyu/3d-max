import { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Box, LoaderCircle, LogOut, RotateCcw } from 'lucide-react';
import { ReviewWorkspace, type ReviewState } from './components/ReviewWorkspace';
import './styles.css';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`/review-api${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message ?? '审片请求失败');
  return result as T;
}
function ReviewPortal() {
  const [state, setState] = useState<ReviewState>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    setState(await request<ReviewState>('/project'));
    setError('');
  }, []);
  useEffect(() => {
    const invitation = new URLSearchParams(location.hash.slice(1)).get('invite');
    if (invitation) history.replaceState(null, '', location.pathname + location.search);
    void (async () => {
      try {
        if (invitation)
          await request('/login', { method: 'POST', body: JSON.stringify({ token: invitation }) });
        await refresh();
      } catch (failure) {
        setError((failure as Error).message);
      } finally {
        setLoading(false);
      }
    })();
  }, [refresh]);
  useEffect(() => {
    if (!state) return;
    const timer = setInterval(() => {
      void refresh().catch((failure: Error) => {
        setError(failure.message);
        setState(undefined);
      });
    }, 3000);
    return () => clearInterval(timer);
  }, [Boolean(state), refresh]);
  return (
    <main className="review-portal">
      <header className="review-portal-header">
        <Box size={24} />
        <strong>白场审片</strong>
        <span className="flex-spacer" />
        {state && (
          <>
            <span>{state.principal.name}</span>
            <button
              className="icon-button"
              aria-label="退出审片"
              title="退出审片"
              onClick={() => {
                void request('/logout', { method: 'POST' }).then(() => {
                  setState(undefined);
                  setError('已退出审片');
                });
              }}
            >
              <LogOut size={17} />
            </button>
          </>
        )}
      </header>
      {state ? (
        <>
          <h1>{state.publication.title}</h1>
          <ReviewWorkspace
            key={state.publication.id}
            state={state}
            videoUrl="/review-api/video"
            downloadUrl="/review-api/video?download=1"
            add={async (input) => {
              await request('/comments', { method: 'POST', body: JSON.stringify(input) });
              await refresh();
            }}
            update={async (id, input) => {
              await request(`/comments/${id}`, { method: 'PATCH', body: JSON.stringify(input) });
              await refresh();
            }}
          />
        </>
      ) : (
        <div className="review-access-state">
          {loading ? (
            <LoaderCircle className="spin" size={24} />
          ) : (
            <>
              <h1>审片访问</h1>
              <p role="alert">{error || '审片邀请尚未载入'}</p>
              <button
                className="text-button"
                onClick={() => {
                  void refresh().catch((failure: Error) => setError(failure.message));
                }}
              >
                <RotateCcw size={15} />
                重试连接
              </button>
            </>
          )}
        </div>
      )}
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<ReviewPortal />);
