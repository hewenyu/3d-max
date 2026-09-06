import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

export interface ServerConfig {
  port: number;
  dataDir: string;
  distDir: string;
  appUrl: string;
  apiUrl: string;
  token?: string;
}

export function getConfig(): ServerConfig {
  const port = Number(process.env.PORT || 4173);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid TCP port');
  const distDir = resolve('dist');
  const apiUrl = `http://127.0.0.1:${port}`;
  const development = process.argv.includes('--dev');
  const webUrl = `http://127.0.0.1:${process.env.WEB_PORT || 5173}`;
  const appUrl =
    process.env.APP_URL || (!development && existsSync(resolve(distDir, 'index.html')) ? apiUrl : webUrl);
  const parsed = new URL(appUrl);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || parsed.protocol !== 'http:')
    throw new Error('APP_URL must be a local HTTP URL');
  return {
    port,
    dataDir: resolve(process.env.WHITEFRAME_DATA_DIR || '.data'),
    distDir,
    appUrl,
    apiUrl,
    token: process.env.WHITEFRAME_MCP_TOKEN,
  };
}

export function prepareDirectories(config: ServerConfig) {
  for (const path of [config.dataDir, resolve(config.dataDir, 'assets'), resolve(config.dataDir, 'renders')])
    mkdirSync(path, { recursive: true });
}
