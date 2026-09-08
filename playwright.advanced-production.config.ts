import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';

const origin = 'http://127.0.0.1:4184';
const runtime = resolve(process.env.WHITEFRAME_ADVANCED_RUNTIME ?? '.');
const evidence = resolve(process.env.WHITEFRAME_ADVANCED_EVIDENCE ?? '.data/advanced-modeling/final-ui');

export default defineConfig({
  testDir: './tests',
  testMatch: [
    '**/component-workspace.spec.ts',
    '**/topology-ui.spec.ts',
    '**/advanced-modifiers.spec.ts',
    '**/surfaces.spec.ts',
    '**/model-assets-ui.spec.ts',
  ],
  workers: 1,
  fullyParallel: false,
  timeout: 240000,
  expect: { timeout: 15000 },
  metadata: { builtFrontend: true, runtime },
  reporter: [['list'], ['json', { outputFile: resolve(evidence, 'results.json') }]],
  outputDir: resolve(evidence, 'artifacts'),
  use: {
    baseURL: origin,
    viewport: { width: 1440, height: 1000 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node --import tsx server/index.ts',
    cwd: runtime,
    url: `${origin}/api/health`,
    reuseExistingServer: false,
    timeout: 60000,
    env: {
      PORT: '4184',
      APP_URL: origin,
      WHITEFRAME_REVIEW_PORT: '4284',
      WHITEFRAME_REVIEW_URL: 'http://127.0.0.1:4284',
      WHITEFRAME_DATA_DIR: resolve(evidence, 'data'),
      WHITEFRAME_DIST_DIR: resolve(runtime, 'dist'),
    },
  },
});
