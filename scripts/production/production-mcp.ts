import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Command, CommandResponse, Project, ShotCamera, Vec3 } from '../../shared/types';
import { sequenceDuration } from '../../shared/timeline';

export class ProductionMcp {
  readonly client = new Client({ name: 'whiteframe-film-production', version: '1.0.0' });
  readonly directory: string;
  project!: Project;
  private tools = new Map<string, unknown>();
  constructor(
    readonly theme: string,
    readonly apiUrl = process.env.WHITEFRAME_PRODUCTION_API ?? 'http://127.0.0.1:4199',
  ) {
    this.directory = resolve(
      process.env.WHITEFRAME_PRODUCTIONS_DIR ?? '.data/full-delivery/productions',
      theme,
    );
  }
  async connect() {
    await mkdir(this.directory, { recursive: true });
    const connection = (await (await fetch(`${this.apiUrl}/api/connection`)).json()) as {
      url: string;
      token: string;
    };
    await this.client.connect(
      new StreamableHTTPClientTransport(new URL(connection.url), {
        requestInit: { headers: { Authorization: `Bearer ${connection.token}` } },
      }),
    );
    const catalog = await this.client.listTools();
    catalog.tools.forEach((tool) => this.tools.set(tool.name, tool.inputSchema));
    await writeFile(resolve(this.directory, 'mcp-capabilities.json'), JSON.stringify(catalog, null, 2));
  }
  async call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const started = new Date().toISOString();
    const response = await this.client.callTool({ name, arguments: args }, undefined, { timeout: 120000 });
    const content = response.content as { type: string; text?: string }[];
    const value = content.find((item) => item.type === 'text')?.text;
    await appendFile(
      resolve(this.directory, 'mcp-operations.jsonl'),
      `${JSON.stringify({ started, completed: new Date().toISOString(), name, arguments: args, isError: Boolean(response.isError), responseHash: createHash('sha256').update(JSON.stringify(response)).digest('hex'), responseBytes: JSON.stringify(response).length })}\n`,
    );
    if (response.isError || !value) throw new Error(`${name}: ${value ?? 'No JSON result'}`);
    const result = JSON.parse(value) as T;
    if (result && typeof result === 'object' && 'project' in result)
      this.project = (result as { project: Project }).project;
    return result;
  }
  async create(name: string) {
    this.project = await this.call<Project>('project_new', { name, template: 'empty' });
    await writeFile(resolve(this.directory, 'project-id.txt'), `${this.project.id}\n`);
    return this.project;
  }
  async edit(commands: Command[]) {
    for (let offset = 0; offset < commands.length; offset += 120) {
      await this.call<CommandResponse>('edit_batch', {
        commands: commands.slice(offset, offset + 120),
        projectId: this.project.id,
        expectedRevision: this.project.revision,
        requestId: randomUUID(),
        expectedContext: {
          sceneId: this.project.production?.activeSceneId ?? null,
          performanceId: this.project.production?.activePerformanceId ?? null,
        },
      });
    }
    return this.project;
  }
  async command(name: string, payload: Record<string, unknown>) {
    return this.call<CommandResponse>(name, {
      ...payload,
      projectId: this.project.id,
      expectedRevision: this.project.revision,
      requestId: randomUUID(),
      expectedContext: {
        sceneId: this.project.production?.activeSceneId ?? null,
        performanceId: this.project.production?.activePerformanceId ?? null,
      },
    });
  }
  supports(name: string, property: string) {
    return Boolean(
      (this.tools.get(name) as { properties?: Record<string, unknown> } | undefined)?.properties?.[property],
    );
  }
  async preview(time: number, name: string, shotId?: string) {
    const args = { time, width: 1280, height: 720, ...(shotId ? { shotId } : {}) };
    const result = await this.client.callTool({ name: 'preview_capture', arguments: args }, undefined, {
      timeout: 120000,
    });
    if (result.isError) throw new Error(JSON.stringify(result));
    const image = (result.content as { type: string; data?: string }[]).find((item) => item.type === 'image');
    if (!image?.data) throw new Error('MCP did not provide a rendered image');
    await writeFile(resolve(this.directory, `${name}.png`), Buffer.from(image.data, 'base64'));
    await appendFile(
      resolve(this.directory, 'mcp-operations.jsonl'),
      `${JSON.stringify({ name: 'preview_capture', arguments: args, completed: new Date().toISOString(), imageFile: `${name}.png`, imageHash: createHash('sha256').update(image.data).digest('hex') })}\n`,
    );
  }
  async save(extra: Record<string, unknown>) {
    this.project = await this.call<Project>('project_get');
    await writeFile(resolve(this.directory, 'project.json'), JSON.stringify(this.project, null, 2));
    const duration = sequenceDuration(this.project);
    await writeFile(
      resolve(this.directory, 'production-report.json'),
      JSON.stringify(
        {
          theme: this.theme,
          projectId: this.project.id,
          revision: this.project.revision,
          source: 'Official MCP tools and shared editing commands',
          sequenceDuration: duration,
          requiredFramesAt24fps: Math.ceil(duration * 24),
          objects: this.project.objects.length,
          cameras: this.project.cameras.length,
          shots: this.project.shots.length,
          animationKeys: this.project.objects.reduce((sum, object) => sum + object.keyframes.length, 0),
          status: 'editable-project-created-video-export-pending',
          ...extra,
        },
        null,
        2,
      ),
    );
    console.log(
      JSON.stringify({
        theme: this.theme,
        projectId: this.project.id,
        duration,
        objects: this.project.objects.length,
        shots: this.project.shots.length,
        directory: this.directory,
      }),
    );
  }
  async close() {
    await this.client.close();
  }
}

export function camera(id: string, name: string, position: Vec3, target: Vec3, fov = 45): ShotCamera {
  return { id, name, position, target, fov, locked: false, keyframes: [] };
}
