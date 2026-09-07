import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { SpeechCatalog, SpeechRequest, SpeechResult } from '../shared/speech';
import type { FaceAnalysisResult } from '../shared/face-analysis';
import type { Project, RenderJob } from '../shared/types';

const exec = promisify(execFile);
test('UI and MCP synthesize actual dialogue, retain retries, drive lip sync, play audio and export a voiced MP4', async ({
  page,
  request,
}, testInfo) => {
  const directory = testInfo.outputPath('artifacts');
  await mkdir(directory, { recursive: true });
  const connection = await (await request.get('/api/connection')).json();
  const client = new Client({ name: 'speech-acceptance', version: '1' });
  const errors: string[] = [];
  const journal: unknown[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const call = async <T = any>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 180000 });
    journal.push({ name, args, isError: Boolean(result.isError) });
    const text = (result.content as { type: string; text?: string }[]).find(
      (item) => item.type === 'text',
    )?.text;
    if (result.isError) throw new Error(`${name}: ${text}`);
    return JSON.parse(text!) as T;
  };
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(connection.url), {
        requestInit: { headers: { Authorization: `Bearer ${connection.token}` } },
      }),
    );
    const catalog = await call<SpeechCatalog>('speech_catalog');
    expect(catalog.available).toBe(true);
    const engine = catalog.engines.find(
      (item) => item.available && item.voices.some((voice) => /zh|cmn/.test(voice.language)),
    )!;
    expect(engine).toBeTruthy();
    const voice =
      engine.voices.find((item) => item.id === 'Tingting') ??
      engine.voices.find((item) => /zh|cmn/.test(item.language))!;
    let project = await call<Project>('project_new', {
      name: 'Live speech generation QA',
      template: 'empty',
    });
    project = (
      await call('edit_batch', {
        projectId: project.id,
        expectedRevision: project.revision,
        commands: [
          { type: 'object.create', payload: { id: 'speaker', type: 'actor', name: '对白角色' } },
          {
            type: 'camera.create',
            payload: {
              id: 'speech-camera',
              name: '对白近景',
              position: [0.12, 1.63, 1.3],
              target: [0, 1.62, 0],
              fov: 25,
            },
          },
          {
            type: 'shot.create',
            payload: {
              id: 'speech-shot',
              name: '合成对白',
              cameraId: 'speech-camera',
              sourceIn: 0,
              sourceOut: 8,
            },
          },
          {
            type: 'sequence.update',
            payload: {
              id: project.activeSequenceId,
              patch: { clips: [{ id: 'speech-clip', shotId: 'speech-shot', sourceIn: 0, sourceOut: 8 }] },
            },
          },
        ],
      })
    ).project;
    await page.goto('/');
    await page.getByRole('button', { name: '导演', exact: true }).click();
    await expect(page.getByRole('combobox', { name: '对白语音', exact: true })).toBeEnabled();
    await page.getByRole('combobox', { name: '语音引擎', exact: true }).selectOption(engine.id);
    await page.getByRole('combobox', { name: '对白语音', exact: true }).selectOption(voice.id);
    await page.getByRole('combobox', { name: '合成对白角色', exact: true }).selectOption('speaker');
    await page.getByRole('textbox', { name: '合成对白文本', exact: true }).fill('看着我，我们从这里开始。');
    const responsePromise = page.waitForResponse((response) =>
      response.url().endsWith('/api/speech/synthesize'),
    );
    await page.getByRole('button', { name: '合成并加入时间线', exact: true }).click();
    const response = await responsePromise;
    expect(response.status()).toBe(200);
    const speech = (await response.json()) as SpeechResult;
    const uiRequest = response.request().postDataJSON() as SpeechRequest;
    await expect(page.locator('.speech-result')).toContainText('已生成');
    expect(speech.speech.duration).toBeGreaterThan(1);
    expect(speech.speech.duration).toBeLessThan(6);
    const replay = await call<SpeechResult>('speech_synthesize', uiRequest);
    expect(replay.replayed).toBe(true);
    expect(replay.speech).toEqual(speech.speech);
    const originalBytes = await (await request.get(speech.speech.url)).body();
    await writeFile(`${directory}/generated-chinese.wav`, originalBytes);
    const audio = page.locator('audio[aria-label="合成对白试听"]');
    await audio.evaluate(async (element) => {
      await (element as HTMLAudioElement).play();
    });
    await expect
      .poll(() => audio.evaluate((element) => (element as HTMLAudioElement).currentTime))
      .toBeGreaterThan(0.2);
    await audio.evaluate((element) => (element as HTMLAudioElement).pause());
    await page.locator('.speech-panel').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${directory}/desktop.png` });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: '属性面板', exact: true }).click();
    await page.locator('.speech-panel').scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await page.screenshot({ path: `${directory}/mobile.png` });
    project = await call<Project>('project_get');
    const analysis = await call<FaceAnalysisResult>('actor_face_lipsync_analyze', {
      projectId: project.id,
      expectedRevision: project.revision,
      objectId: 'speaker',
      audioId: speech.speech.audioId,
      linkTiming: true,
    });
    expect(analysis.clip.cues.length).toBeGreaterThan(5);
    project = (
      await call('edit_batch', {
        projectId: analysis.projectId,
        expectedRevision: analysis.revision,
        expectedContext: analysis.context,
        commands: analysis.commands,
      })
    ).project;
    const group = project.synchronization!.find((item) =>
      item.members.some((member) => member.kind === 'audio' && member.id === speech.speech.audioId),
    )!;
    expect(group.members.map((member) => member.kind).sort()).toEqual(['actor-face-clip', 'audio', 'beat']);
    const extra = await call<SpeechResult>('speech_synthesize', {
      projectId: project.id,
      expectedRevision: project.revision,
      requestId: randomUUID(),
      engine: engine.id,
      voice: voice.id,
      rate: 240,
      text: '现在开始。',
      actorId: 'speaker',
      start: 6,
      name: 'MCP 合成对白',
    });
    expect(extra.project.audio).toHaveLength(2);
    expect(extra.speech.duration).toBeGreaterThan(0.5);
    const hashes: string[] = [];
    const cueTime = analysis.clip.cues.find((cue) => !['A', 'X'].includes(cue.viseme))!;
    for (const [time, name] of [
      [5.5, 'neutral'],
      [(cueTime.start + cueTime.end) / 2, 'speaking'],
    ] as const) {
      const preview = await client.callTool({
        name: 'preview_capture',
        arguments: { shotId: 'speech-shot', time, width: 1280, height: 720 },
      });
      expect(preview.isError).not.toBe(true);
      const image = (preview.content as { type: string; data?: string }[]).find(
        (item) => item.type === 'image',
      )!;
      const bytes = Buffer.from(image.data!, 'base64');
      hashes.push(createHash('sha256').update(bytes).digest('hex'));
      await writeFile(`${directory}/${name}.png`, bytes);
    }
    expect(hashes[0]).not.toBe(hashes[1]);
    const job = await call<RenderJob>('render_start', {
      projectId: extra.project.id,
      expectedRevision: extra.project.revision,
      shotId: 'speech-shot',
      fps: 24,
      resolution: 720,
      aspect: '16:9',
      includeAudio: true,
    });
    await expect
      .poll(
        async () => {
          const next = await call<RenderJob>('render_status', { id: job.id });
          if (next.status === 'failed') throw new Error(next.error);
          return next.status;
        },
        { timeout: 120000, intervals: [1000, 2000] },
      )
      .toBe('completed');
    const complete = await call<RenderJob>('render_status', { id: job.id });
    const videoPath = `${directory}/speech.mp4`;
    await writeFile(videoPath, await (await request.get(complete.url!)).body());
    const probe = JSON.parse(
      (await exec('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', videoPath]))
        .stdout,
    );
    expect(probe.streams.find((item: { codec_type: string }) => item.codec_type === 'video')).toMatchObject({
      codec_name: 'h264',
      width: 1280,
      height: 720,
      nb_frames: '192',
    });
    expect(probe.streams.some((item: { codec_type: string }) => item.codec_type === 'audio')).toBe(true);
    const { stdout: pcm } = await exec(
      'ffmpeg',
      ['-v', 'error', '-i', videoPath, '-vn', '-ac', '1', '-ar', '16000', '-f', 's16le', '-'],
      { encoding: 'buffer', maxBuffer: 1024 * 1024 },
    );
    let sum = 0;
    for (let i = 0; i < pcm.length; i += 2) sum += (pcm.readInt16LE(i) / 32768) ** 2;
    const rms = Math.sqrt(sum / (pcm.length / 2));
    expect(rms).toBeGreaterThan(0.005);
    expect(errors).toEqual([]);
    await writeFile(
      `${directory}/report.json`,
      JSON.stringify(
        {
          engine: engine.id,
          voice,
          uiSpeech: speech.speech,
          mcpSpeech: extra.speech,
          cues: analysis.clip.cues.length,
          group,
          hashes,
          video: probe,
          exportedAudioRms: rms,
          errors,
        },
        null,
        2,
      ),
    );
  } finally {
    await writeFile(`${directory}/mcp-operations.json`, JSON.stringify(journal, null, 2));
    await client.close();
  }
});
