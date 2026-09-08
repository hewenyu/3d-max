import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';

export default defineConfig({
  testDir: './tests',
  testMatch: '**/component-workspace.spec.ts',
  workers: 1,
  fullyParallel: false,
  timeout: 120000,
  expect: { timeout: 15000 },
  reporter: 'list',
  outputDir: '.data/advanced-modeling/component-tests',
  use: {
    baseURL: 'http://127.0.0.1:5181',
    viewport: { width: 1440, height: 1000 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npx concurrently -k -n api,web "tsx server/index.ts" "vite --host 127.0.0.1 --strictPort"',
    url: 'http://127.0.0.1:5181/api/health',
    reuseExistingServer: false,
    timeout: 60000,
    env: {
      PORT: '4181',
      WEB_PORT: '5181',
      APP_URL: 'http://127.0.0.1:5181',
      WHITEFRAME_DATA_DIR: resolve('.data/advanced-modeling/component-tests/data'),
    },
  },
});
