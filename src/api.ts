import type {
  Command,
  CommandRequest,
  CommandResponse,
  Project,
  RenderJob,
  RenderOptions,
} from '../shared/types';

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: {
      ...(init?.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new ApiError(
      detail.error?.message ?? detail.message ?? `请求失败 (${response.status})`,
      response.status,
      detail.error?.code,
    );
  }
  return response.json() as Promise<T>;
}

export const getProject = () => api<Project>('/project');
export const execute = (
  commands: Command[],
  revision: number,
  projectId: string,
  expectedContext?: CommandRequest['expectedContext'],
) =>
  api<CommandResponse>('/commands', {
    method: 'POST',
    body: JSON.stringify({
      commands,
      projectId,
      expectedRevision: revision,
      expectedContext,
      requestId: crypto.randomUUID(),
    }),
  });
export const startRender = (options: RenderOptions) =>
  api<RenderJob>('/renders', { method: 'POST', body: JSON.stringify(options) });
export async function uploadAsset(file: File) {
  const data = new FormData();
  data.append('file', file);
  return api<{ id: string; name: string; url: string; duration?: number }>('/assets', {
    method: 'POST',
    body: data,
  });
}
