import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getConfig } from '../server/config.ts';

test('development rendering follows Vite despite a saved production build and respects overrides', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'whiteframe-config-'));
  const previousDirectory = process.cwd();
  const previousArguments = process.argv;
  const keys = ['APP_URL', 'PORT', 'WEB_PORT'] as const;
  const environment = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    process.chdir(directory);
    for (const key of keys) delete process.env[key];
    await mkdir(join(directory, 'dist'));
    await writeFile(join(directory, 'dist', 'index.html'), '<!doctype html>');
    process.argv = [process.execPath, 'server/index.ts', '--dev'];
    assert.equal(getConfig().appUrl, 'http://127.0.0.1:5173');
    process.env.WEB_PORT = '5273';
    process.env.PORT = '4273';
    assert.equal(getConfig().appUrl, 'http://127.0.0.1:5273');
    assert.equal(getConfig().apiUrl, 'http://127.0.0.1:4273');
    process.env.APP_URL = 'http://127.0.0.1:5373';
    assert.equal(getConfig().appUrl, 'http://127.0.0.1:5373');
    delete process.env.APP_URL;
    process.argv = [process.execPath, 'server/index.ts'];
    assert.equal(getConfig().appUrl, 'http://127.0.0.1:4273');
    process.env.APP_URL = 'http://127.0.0.1:5473';
    assert.equal(getConfig().appUrl, 'http://127.0.0.1:5473');
    delete process.env.APP_URL;
    await rm(join(directory, 'dist'), { recursive: true });
    assert.equal(getConfig().appUrl, 'http://127.0.0.1:5273');
  } finally {
    process.chdir(previousDirectory);
    process.argv = previousArguments;
    for (const key of keys) {
      if (environment[key] === undefined) delete process.env[key];
      else process.env[key] = environment[key];
    }
    await rm(directory, { recursive: true, force: true });
  }
});
