import { createHash, randomUUID } from 'node:crypto';
import { expect, type Page } from '@playwright/test';
import type { Project } from '../../shared/types';
import type { WorkspaceState } from '../../shared/workspace';

type Call = <T = any>(name: string, args?: Record<string, unknown>) => Promise<T>;
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export async function exerciseTransferCatalog(call: Call, bytes: Buffer) {
  const input = {
    kind: 'asset',
    name: 'chunked-catalog.glb',
    size: bytes.length,
    sha256: hash(bytes),
    requestId: randomUUID(),
  };
  const transfer = await call('transfer_begin', input);
  expect((await call('transfer_begin', input)).id).toBe(transfer.id);
  for (let offset = 0, index = 0; offset < bytes.length; offset += transfer.chunkBytes, index++) {
    const chunk = bytes.subarray(offset, offset + transfer.chunkBytes);
    await call('transfer_chunk', {
      id: transfer.id,
      index,
      dataBase64: chunk.toString('base64'),
      sha256: hash(chunk),
    });
  }
  const status = await call('transfer_status', { id: transfer.id });
  expect(status.missingChunks).toEqual([]);
  const asset = await call('transfer_commit', { id: transfer.id });
  expect(await call('transfer_commit', { id: transfer.id })).toEqual(asset);
  const abandoned = await call('transfer_begin', { ...input, requestId: randomUUID() });
  expect((await call('transfer_cancel', { id: abandoned.id })).state).toBe('cancelled');
  return { transferId: transfer.id, asset };
}

export async function exerciseWorkspaceCatalog(call: Call, page: Page, project: Project) {
  const identity = { projectId: project.id, expectedRevision: project.revision };
  await page.goto('/');
  let session!: { id: string; state: WorkspaceState };
  await expect
    .poll(async () => {
      const sessions =
        await call<{ id: string; connected: boolean; state: WorkspaceState }[]>('workspace_list');
      session = sessions.find(
        (item) => item.connected && item.state.projectId === project.id && !item.state.viewport.loading,
      )!;
      return session?.state.projectRevision;
    })
    .toBe(project.revision);
  const guard = { ...identity, workspaceId: session.id };
  const state = await call<WorkspaceState>('workspace_get', guard);
  expect(state.projectId).toBe(project.id);
  const selected = await call<WorkspaceState>('workspace_apply', {
    ...guard,
    requestId: randomUUID(),
    command: { type: 'selection', ids: ['speaker'] },
  });
  expect(selected.selection).toEqual(['speaker']);
  expect(selected.projectRevision).toBe(project.revision);
  const inspected = await call('viewport_inspect', { ...guard, objectIds: ['speaker'] });
  expect(inspected.objects.map((object: { id: string }) => object.id)).toEqual(['speaker']);
  const capture = await call('viewport_capture', { ...guard, overlays: true });
  expect(capture.state.selection).toEqual(['speaker']);
  const headless = await call('scene_view_capture', {
    ...identity,
    context: { kind: 'sequence', time: 0.5 },
    view: 'edit',
    width: 640,
    height: 360,
    observation: { position: [4, 3, 7], target: [0, 1, 0] },
  });
  expect(headless.projectId).toBe(project.id);
  const constraints = await call('contact_constraints_inspect', {
    ...identity,
    context: { kind: 'source', sourceTime: 0.5 },
    objectIds: ['speaker'],
  });
  expect(constraints.projectId).toBe(project.id);
  return { workspaceId: session.id, state: selected, inspected, headless, constraints };
}
