import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    const canvases = new Set();
    window.webglContexts = 0;
    window.contextLosses = 0;
    HTMLCanvasElement.prototype.getContext = function (type, ...args) {
      const result = original.call(this, type, ...args);
      if ((type === 'webgl' || type === 'webgl2') && result && !canvases.has(this)) {
        canvases.add(this);
        window.webglContexts++;
      }
      return result;
    };
    addEventListener('webglcontextlost', () => window.contextLosses++, true);
  });
  await page.route('**/__thumbnail-test', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<html><body style="margin:0;background:#25282a"><div id="stage" style="width:100%;height:560px"></div><div id="thumbnails" style="display:flex;flex-wrap:wrap"></div><script type="module">
      import { SceneEngine } from '/src/engine/SceneEngine.ts';
      import { requestShotThumbnail } from '/src/engine/ThumbnailRenderer.ts';
      import { createDemoProject } from '/shared/project.ts';
      const project = createDemoProject();
      project.shots = Array.from({ length: 24 }, (_, i) => ({ ...project.shots[i % 3], id: 'qa-shot-' + i }));
      project.sequences = [];
      const stage = new SceneEngine(document.getElementById('stage'));
      await stage.setProject(project);
      window.stageEngine = stage;
      window.ready = Promise.all(project.shots.map(async shot => {
        const src = await requestShotThumbnail(project, shot);
        const image = new Image(); image.width = 160; image.height = 90; image.src = src;
        await image.decode(); document.getElementById('thumbnails').append(image);
      })).then(() => { window.finished = true; });
    </script></body></html>`,
    }),
  );
  await page.goto(`${process.env.WHITEFRAME_QA_URL || 'http://127.0.0.1:5173'}/__thumbnail-test`);
  await page.waitForFunction(() => window.finished === true, { timeout: 60000 });
  const result = await page.evaluate(() => {
    window.stageEngine.setTime(1);
    const canvas = document.querySelector('#stage canvas');
    const temporary = document.createElement('canvas');
    temporary.width = 80;
    temporary.height = 80;
    const context = temporary.getContext('2d');
    context.drawImage(canvas, 0, 0, 80, 80);
    const values = context.getImageData(0, 0, 80, 80).data;
    const colors = new Set();
    for (let i = 0; i < values.length; i += 4) colors.add(`${values[i]},${values[i + 1]},${values[i + 2]}`);
    return {
      contexts: window.webglContexts,
      losses: window.contextLosses,
      thumbnails: document.querySelectorAll('#thumbnails img').length,
      colors: colors.size,
    };
  });
  await page.screenshot({ path: '/tmp/whiteframe-thumbnails-24.png' });
  assert.equal(result.contexts, 2);
  assert.equal(result.losses, 0);
  assert.equal(result.thumbnails, 24);
  assert.ok(result.colors > 25);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
