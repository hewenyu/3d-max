import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../server/app';
import type { ReviewComment, ReviewPublication } from '../shared/review';
import type { RenderJob } from '../shared/types';

test('team review isolates invitations, author identity and immutable videos through HTTP, MCP and SQLite', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'whiteframe-review-'));
  const config = {
    port: 0,
    dataDir,
    distDir: join(dataDir, 'dist'),
    appUrl: 'http://127.0.0.1:5180',
    apiUrl: 'http://127.0.0.1:4180',
    token: 'review-owner-test',
  };
  const service = createApp(config);
  const owner = service.app.listen(0, '127.0.0.1');
  const guests = service.reviewApp.listen(0, '127.0.0.1');
  await Promise.all([
    new Promise<void>((done) => owner.once('listening', done)),
    new Promise<void>((done) => guests.once('listening', done)),
  ]);
  const ownerUrl = `http://127.0.0.1:${(owner.address() as AddressInfo).port}`;
  const reviewUrl = `http://127.0.0.1:${(guests.address() as AddressInfo).port}`;
  const request = (url: string, method = 'GET', body?: unknown, token?: string) =>
    fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const clients: Client[] = [];
  let closed = false;
  try {
    const project = service.store.project();
    const job: RenderJob = {
      id: 'review-fixture',
      name: 'Immutable film',
      status: 'completed',
      progress: 1,
      frame: 48,
      totalFrames: 48,
      projectRevision: project.revision,
      createdAt: new Date().toISOString(),
      options: { fps: 24, projectId: project.id },
      url: '/api/renders/review-fixture/file',
    };
    await promisify(execFile)('ffmpeg', [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=320x180:rate=24',
      '-t',
      '2',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      join(dataDir, 'renders', `${job.id}.mp4`),
    ]);
    service.store.addJob(job, project);
    const published = await request(`${ownerUrl}/api/reviews`, 'POST', {
      jobId: job.id,
      title: 'Director review',
    });
    assert.equal(published.status, 201);
    const publication = (await published.json()) as ReviewPublication;
    const other = service.reviews.publish({ jobId: job.id, title: 'Other authorized scope' });
    const reviewer = service.reviews.invite(publication.id, { name: 'Reviewer A', role: 'reviewer' });
    const viewer = service.reviews.invite(publication.id, { name: 'Viewer B', role: 'viewer' });
    const foreign = service.reviews.invite(other.id, { name: 'Reviewer C', role: 'reviewer' });
    const director = new Client({ name: 'owner-read-parity', version: '1' });
    clients.push(director);
    await director.connect(
      new StreamableHTTPClientTransport(new URL(`${ownerUrl}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${config.token}` } },
      }),
    );
    const ownerCall = async (name: string, args: Record<string, unknown> = {}) => {
      const response = await director.callTool({ name, arguments: args });
      assert.ok(!response.isError, JSON.stringify(response));
      const content = response.content as { type: string; text?: string }[];
      return JSON.parse(content.find((part) => part.type === 'text')!.text!);
    };
    const details = await ownerCall('review_details', { publicationId: publication.id });
    assert.deepEqual(details, await (await request(`${ownerUrl}/api/reviews/${publication.id}`)).json());
    assert.deepEqual(
      details.invites.map((invite: { id: string }) => invite.id),
      [reviewer.invite.id, viewer.invite.id],
    );
    assert.equal(JSON.stringify(details).includes(reviewer.token), false);
    assert.deepEqual(
      await ownerCall('history_status'),
      await (await request(`${ownerUrl}/api/history`)).json(),
    );
    service.store.commands({
      commands: [{ type: 'project.update', payload: { name: 'Later editor revision' } }],
    });
    assert.deepEqual(await ownerCall('history_status'), { canUndo: true, canRedo: false });
    await ownerCall('history_undo', { projectId: project.id });
    assert.deepEqual(await ownerCall('history_status'), { canUndo: false, canRedo: true });
    assert.equal((await request(`${reviewUrl}/review-api/project`)).status, 401);
    assert.equal(
      (await request(`${reviewUrl}/api/connection`, 'GET', undefined, reviewer.token)).status,
      404,
    );
    assert.equal(
      (await request(`${reviewUrl}/api/commands`, 'POST', { commands: [] }, reviewer.token)).status,
      404,
    );
    const state = await (
      await request(`${reviewUrl}/review-api/project`, 'GET', undefined, reviewer.token)
    ).json();
    assert.equal(state.publication.projectRevision, project.revision);
    assert.equal(state.principal.name, 'Reviewer A');
    assert.equal(state.principal.role, 'reviewer');
    const scoped = await (
      await request(
        `${reviewUrl}/review-api/project?publicationId=${other.id}`,
        'GET',
        undefined,
        reviewer.token,
      )
    ).json();
    assert.equal(scoped.publication.id, publication.id);
    const input = { requestId: 'comment-request', time: 1.25, text: 'Adjust the cut here' };
    assert.equal(
      (
        await request(
          `${reviewUrl}/review-api/comments`,
          'POST',
          { ...input, author: { id: 'owner' } },
          reviewer.token,
        )
      ).status,
      400,
    );
    assert.equal(
      (await request(`${reviewUrl}/review-api/comments`, 'POST', input, viewer.token)).status,
      403,
    );
    const first = await request(`${reviewUrl}/review-api/comments`, 'POST', input, reviewer.token);
    assert.equal(first.status, 201);
    const comment = (await first.json()) as ReviewComment;
    assert.deepEqual(comment.author, { id: reviewer.invite.id, name: 'Reviewer A' });
    assert.deepEqual(
      await (await request(`${reviewUrl}/review-api/comments`, 'POST', input, reviewer.token)).json(),
      comment,
    );
    assert.equal(
      (
        await request(
          `${reviewUrl}/review-api/comments`,
          'POST',
          { ...input, text: 'Changed retry' },
          reviewer.token,
        )
      ).status,
      409,
    );
    assert.equal(
      (
        await request(
          `${reviewUrl}/review-api/comments`,
          'POST',
          { ...input, requestId: 'out-of-video', time: 3 },
          reviewer.token,
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await request(
          `${reviewUrl}/review-api/comments`,
          'POST',
          { ...input, requestId: 'foreign-reply', replyTo: comment.id },
          foreign.token,
        )
      ).status,
      404,
    );
    const resolved = await request(
      `${reviewUrl}/review-api/comments/${comment.id}`,
      'PATCH',
      { expectedVersion: 1, status: 'resolved' },
      reviewer.token,
    );
    assert.equal(resolved.status, 200);
    assert.equal((await resolved.json()).version, 2);
    const conflict = await request(
      `${reviewUrl}/review-api/comments/${comment.id}`,
      'PATCH',
      { expectedVersion: 1, text: 'Stale edit' },
      reviewer.token,
    );
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).error.details.comment.status, 'resolved');
    const rootComment = service.reviews.addComment(service.reviews.owner(publication.id), {
      ...input,
      requestId: 'director-comment',
    });
    assert.equal(
      (
        await request(
          `${reviewUrl}/review-api/comments/${rootComment.id}`,
          'PATCH',
          { expectedVersion: 1, text: 'Impersonation' },
          reviewer.token,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await request(
          `${reviewUrl}/review-api/comments`,
          'POST',
          { ...input, requestId: 'reply', replyTo: rootComment.id },
          reviewer.token,
        )
      ).status,
      201,
    );

    const range = await fetch(`${reviewUrl}/review-api/video`, {
      headers: { Authorization: `Bearer ${reviewer.token}`, Range: 'bytes=0-31' },
    });
    assert.equal(range.status, 206);
    assert.equal((await range.arrayBuffer()).byteLength, 32);
    const login = await request(`${reviewUrl}/review-api/login`, 'POST', { token: viewer.token });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie')!;
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.ok(!cookie.includes(viewer.token));
    const session = cookie.split(';')[0]!;
    assert.equal(
      (await fetch(`${reviewUrl}/review-api/project`, { headers: { Cookie: session } })).status,
      200,
    );
    assert.equal(
      (
        await fetch(`${reviewUrl}/review-api/comments`, {
          method: 'POST',
          headers: {
            Cookie: session,
            Origin: 'https://untrusted.example',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(input),
        })
      ).status,
      403,
    );

    for (const identity of [reviewer, viewer]) {
      const client = new Client({ name: 'review-acceptance', version: '1' });
      clients.push(client);
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${reviewUrl}/mcp`), {
          requestInit: { headers: { Authorization: `Bearer ${identity.token}` } },
        }),
      );
      const catalog = await client.listTools();
      assert.equal(
        catalog.tools.some((tool) => tool.name === 'project_get'),
        false,
      );
      assert.equal(
        catalog.tools.some((tool) => tool.name === 'review_details'),
        false,
      );
      assert.equal(
        catalog.tools.some((tool) => tool.name === 'review_comment_add'),
        identity.invite.role === 'reviewer',
      );
      const result = await client.callTool({ name: 'review_get', arguments: {} });
      assert.equal(result.isError, undefined);
      if (identity.invite.role === 'reviewer') {
        const created = await client.callTool({
          name: 'review_comment_add',
          arguments: { ...input, requestId: 'mcp-comment', text: 'MCP review' },
        });
        assert.equal(created.isError, undefined);
      }
    }
    const serialized = JSON.stringify(service.store.db.prepare('SELECT * FROM review_invites').all());
    assert.equal(serialized.includes(reviewer.token), false);
    service.reviews.revoke(publication.id, viewer.invite.id);
    const revokedDetails = await ownerCall('review_details', { publicationId: publication.id });
    assert.equal(
      revokedDetails.invites.find((invite: { id: string }) => invite.id === viewer.invite.id).revoked,
      true,
    );
    assert.equal(
      (await fetch(`${reviewUrl}/review-api/video`, { headers: { Cookie: session } })).status,
      401,
    );
    assert.equal(
      (await request(`${reviewUrl}/review-api/project`, 'GET', undefined, viewer.token)).status,
      401,
    );
    for (const client of clients) await client.close();
    clients.length = 0;
    owner.closeAllConnections();
    guests.closeAllConnections();
    await Promise.all([
      new Promise<void>((done) => owner.close(() => done())),
      new Promise<void>((done) => guests.close(() => done())),
    ]);
    await service.close();
    closed = true;
    const restored = createApp(config);
    try {
      const actor = restored.reviews.authenticate(reviewer.token);
      assert.equal(restored.reviews.publication(publication.id).projectRevision, project.revision);
      assert.equal(
        restored.reviews.comments(actor).find((item) => item.id === comment.id)?.status,
        'resolved',
      );
      assert.equal(
        restored.reviews.comments(actor).some((item) => item.text === 'MCP review'),
        true,
      );
      assert.throws(() => restored.reviews.authenticate(viewer.token), { code: 'UNAUTHORIZED' });
    } finally {
      await restored.close();
    }
  } finally {
    for (const client of clients) await client.close();
    if (!closed) {
      owner.closeAllConnections();
      guests.closeAllConnections();
      await Promise.all([
        new Promise<void>((done) => owner.close(() => done())),
        new Promise<void>((done) => guests.close(() => done())),
      ]);
      await service.close();
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});
