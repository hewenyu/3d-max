import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';

const origin = 'http://127.0.0.1:4191';
export default defineConfig({
  testDir: './tests',
  testMatch: '**/component-workspace.spec.ts',
  workers: 1,
  fullyParallel: false,
  timeout: 120000,
  expect: { timeout: 15000 },
  reporter: 'list',
  metadata: { builtFrontend: true },
  outputDir: '.data/advanced-modeling/component-production-tests',
  use: {
    baseURL: origin,
    viewport: { width: 1440, height: 1000 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npx tsx server/index.ts',
    url: `${origin}/api/health`,
    reuseExistingServer: false,
    timeout: 60000,
    env: {
      PORT: '4191',
      APP_URL: origin,
      WHITEFRAME_REVIEW_PORT: '4291',
      WHITEFRAME_REVIEW_URL: 'http://127.0.0.1:4291',
      WHITEFRAME_DATA_DIR: resolve('.data/advanced-modeling/component-production-tests/data'),
      WHITEFRAME_DIST_DIR: resolve(process.env.WHITEFRAME_COMPONENT_DIST ?? 'dist'),
    },
  },
});
