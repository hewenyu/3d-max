import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';
import base from './playwright.config';

const port = 4185;
const origin = `http://127.0.0.1:${port}`;

export default defineConfig({
  ...base,
  testMatch: [
    '**/camera-view.spec.ts',
    '**/observation-focus.spec.ts',
    '**/timeline-ruler.spec.ts',
    '**/review.spec.ts',
    '**/video-playback.spec.ts',
    '**/export-context.spec.ts',
    '**/export-formats.spec.ts',
    '**/export-retry.spec.ts',
    '**/mcp-service-catalog.spec.ts',
    '**/lighting-plans.spec.ts',
  ],
  metadata: { builtFrontend: true },
  outputDir: 'test-results-production',
  use: { ...base.use, baseURL: origin },
  webServer: {
    command: 'npm run start',
    url: `${origin}/api/health`,
    reuseExistingServer: false,
    timeout: 60000,
    env: {
      PORT: String(port),
      APP_URL: origin,
      WHITEFRAME_DATA_DIR: resolve('.data/e2e-production'),
      WHITEFRAME_DIST_DIR: resolve(process.env.WHITEFRAME_DIST_DIR || 'dist'),
      WHITEFRAME_REVIEW_PORT: '4285',
      WHITEFRAME_REVIEW_URL: 'http://127.0.0.1:4285',
    },
  },
});
