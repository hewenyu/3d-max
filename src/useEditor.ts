import { useCallback, useEffect, useRef, useState } from 'react';
import { api, execute, getProject } from './api';
import type { Command, Project, RenderJob } from '../shared/types';

interface CommandOptions {
  projectId?: string;
  staleMessage?: string;
}
type CommandInput = string | Command[] | ((project: Project) => Command[]);

export function useEditor() {
  const [project, setProject] = useState<Project | null>(null);
  const [error, setError] = useState('');
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [jobs, setJobs] = useState<RenderJob[]>([]);
  const [history, setHistory] = useState({ canUndo: false, canRedo: false });
  const current = useRef(project);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const projectGeneration = useRef(0);
  const accept = useCallback((next: Project) => {
    if (!current.current || next.id !== current.current.id || next.revision >= current.current.revision) {
      current.current = next;
      setProject(next);
    }
  }, []);
  const acceptResponse = useCallback(
    (next: Project, generation: number) => {
      if (generation === projectGeneration.current || next.id === current.current?.id) accept(next);
    },
    [accept],
  );
  const refreshHistory = useCallback(() => {
    void api<{ canUndo: boolean; canRedo: boolean }>('/history')
      .then(setHistory)
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    const generation = projectGeneration.current;
    void getProject()
      .then((next) => acceptResponse(next, generation))
      .catch((e) => setError(e.message));
    void api<RenderJob[]>('/renders')
      .then(setJobs)
      .catch(() => undefined);
    refreshHistory();
    const events = new EventSource('/api/events');
    events.onopen = () => setConnected(true);
    events.onerror = () => setConnected(false);
    events.addEventListener('project', (event) => {
      const data = JSON.parse((event as MessageEvent).data);
      projectGeneration.current++;
      accept(data.project ?? data);
      refreshHistory();
    });
    events.addEventListener('render', (event) => {
      const data = JSON.parse((event as MessageEvent).data);
      const job: RenderJob = data.job ?? data;
      setJobs((previous) => [job, ...previous.filter((item) => item.id !== job.id)]);
    });
    return () => events.close();
  }, [accept, acceptResponse, refreshHistory]);

  const command = useCallback(
    (type: CommandInput, payload: Record<string, unknown> = {}, options: CommandOptions = {}) => {
      const targetProjectId = options.projectId ?? current.current?.id;
      const staleError = () => {
        const error = new Error(options.staleMessage ?? '项目已切换，未执行上一项目的编辑');
        setError(error.message);
        return error;
      };
      if (current.current?.id !== targetProjectId) return Promise.reject(staleError());
      const task = queue.current.then(async () => {
        if (!current.current) return;
        if (current.current.id !== targetProjectId) throw staleError();
        setBusy(true);
        try {
          const result = await execute(
            typeof type === 'function'
              ? type(current.current)
              : Array.isArray(type)
                ? type
                : [{ type, payload }],
            current.current.revision,
            current.current.id,
          );
          if (current.current?.id === targetProjectId) accept(result.project);
          refreshHistory();
          return result;
        } catch (e) {
          setError((e as Error).message);
          const generation = projectGeneration.current;
          await getProject()
            .then((next) => acceptResponse(next, generation))
            .catch(() => undefined);
          throw e;
        } finally {
          setBusy(false);
        }
      });
      queue.current = task.catch(() => undefined);
      return task;
    },
    [accept, acceptResponse, refreshHistory],
  );

  const run = useCallback(
    (type: CommandInput, payload: Record<string, unknown> = {}) => {
      void command(type, payload).catch(() => undefined);
    },
    [command],
  );
  const undo = useCallback(
    (redo = false) => {
      const targetProjectId = current.current?.id;
      const task = queue.current.then(async () => {
        if (!current.current) return;
        if (current.current.id !== targetProjectId) throw new Error('项目已切换，未执行上一项目的撤销或重做');
        setBusy(true);
        try {
          const next = await api<Project>(`/history/${redo ? 'redo' : 'undo'}`, {
            method: 'POST',
            body: JSON.stringify({ projectId: targetProjectId, expectedRevision: current.current.revision }),
          });
          if (current.current?.id === targetProjectId) accept(next);
          refreshHistory();
        } finally {
          setBusy(false);
        }
      });
      queue.current = task.catch(() => undefined);
      void task.catch((error: Error) => setError(error.message));
    },
    [accept, refreshHistory],
  );
  const replace = useCallback(
    async (path: string, data: unknown) => {
      const generation = ++projectGeneration.current;
      try {
        const next = await api<Project>(path, { method: 'POST', body: JSON.stringify(data) });
        acceptResponse(next, generation);
        refreshHistory();
        return true;
      } catch (e) {
        setError((e as Error).message);
        return false;
      }
    },
    [acceptResponse, refreshHistory],
  );
  return {
    project,
    accept,
    error,
    setError,
    connected,
    busy,
    jobs,
    setJobs,
    history,
    command,
    run,
    undo,
    replace,
  };
}

export type EditorActions = ReturnType<typeof useEditor>;
