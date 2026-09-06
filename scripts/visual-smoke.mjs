import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const url = process.env.WHITEFRAME_QA_URL || 'http://127.0.0.1:5173';
const output = process.env.WHITEFRAME_QA_OUT || '/tmp/whiteframe-visual-qa';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const results = [];

async function pixels(page) {
  return page.locator('[data-testid="stage"] canvas').evaluate((canvas) => {
    const sample = document.createElement('canvas');
    sample.width = 96;
    sample.height = 96;
    const context = sample.getContext('2d');
    context.drawImage(canvas, 0, 0, 96, 96);
    const values = Array.from(context.getImageData(0, 0, 96, 96).data);
    const colors = new Set();
    for (let i = 0; i < values.length; i += 4) colors.add(values.slice(i, i + 3).join(','));
    return { width: canvas.width, height: canvas.height, colorCount: colors.size, values };
  });
}

async function layout(page) {
  return page.evaluate(() => {
    const visible = (element) =>
      element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0;
    const overflowingText = [
      ...document.querySelectorAll('button, label, h1, h2, h3, p, .field-label, .shot-card-label'),
    ]
      .filter(
        (element) =>
          visible(element) &&
          element.scrollWidth > element.clientWidth + 2 &&
          getComputedStyle(element).overflowX === 'visible',
      )
      .map((element) => ({
        tag: element.tagName,
        text: element.textContent?.trim().slice(0, 80),
        width: element.clientWidth,
        scrollWidth: element.scrollWidth,
      }));
    return { viewportWidth: innerWidth, pageWidth: document.documentElement.scrollWidth, overflowingText };
  });
}

try {
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 1280, height: 800 },
    { width: 390, height: 844 },
  ]) {
    const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
    const errors = [];
    const mutations = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (request) => {
      if (
        request.url().includes('/api/') &&
        !['GET', 'HEAD'].includes(request.method()) &&
        !request.url().endsWith('/preview')
      )
        mutations.push(request.url());
    });
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.locator('[data-testid="stage"] canvas').waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.querySelector('[data-testid="stage"] canvas')?.width > 100);
    const name = `${viewport.width}x${viewport.height}`;
    const initial = await pixels(page);
    assert.ok(initial.colorCount > 25, `${name}: initial canvas is blank`);
    await page.screenshot({ path: join(output, `${name}-editor.png`) });
    const initialLayout = await layout(page);
    assert.equal(initialLayout.pageWidth, viewport.width, `${name}: page overflows horizontally`);
    await page.getByRole('button', { name: '回到开始', exact: true }).click();
    await page.screenshot({ path: join(output, `${name}-start.png`), timeout: 60000 });
    const before = await pixels(page);
    await page.getByRole('button', { name: '播放', exact: true }).click();
    await page.waitForFunction(() => {
      const text = document.querySelector('.transport-time')?.textContent || '';
      const [minutes, seconds] = text.trim().split(' / ')[0].split(':').map(Number);
      return minutes * 60 + seconds >= 1;
    });
    await page.getByRole('button', { name: '暂停', exact: true }).click();
    const after = await pixels(page);
    const changed = after.values.filter((value, index) => Math.abs(value - before.values[index]) > 3).length;
    assert.ok(changed > 30, `${name}: playback did not change visible pixels`);
    await page.getByRole('button', { name: '俯视调度', exact: true }).click();
    await page.screenshot({ path: join(output, `${name}-top.png`) });
    const top = await pixels(page);
    assert.ok(top.colorCount > 25, `${name}: top view is blank`);
    const shots = page.locator('.shot-card');
    const shotResults = [];
    for (let index = 0; index < (await shots.count()); index++) {
      await shots.nth(index).click();
      await page.screenshot({ path: join(output, `${name}-shot-${index + 1}.png`), timeout: 60000 });
      const camera = await pixels(page);
      assert.ok(camera.colorCount > 25, `${name}: shot ${index + 1} is blank`);
      shotResults.push({ shot: index + 1, colors: camera.colorCount });
    }
    if (viewport.width < 500) {
      await page.getByRole('button', { name: '场景资源面板', exact: true }).click();
      await page.screenshot({ path: join(output, `${name}-scene-panel.png`) });
      await page.getByRole('button', { name: '收起资源面板', exact: true }).click();
      await page.getByRole('button', { name: '属性面板', exact: true }).click();
      await page.screenshot({ path: join(output, `${name}-inspector.png`) });
    }
    results.push({
      viewport,
      initialColors: initial.colorCount,
      changedComponents: changed,
      initialLayout,
      shotResults,
      errors,
      mutations,
    });
    assert.deepEqual(errors, [], `${name}: browser errors`);
    assert.deepEqual(mutations, [], `${name}: read-only QA changed business data`);
    await page.close();
  }
} finally {
  await browser.close();
  await writeFile(join(output, 'report.json'), JSON.stringify(results, null, 2));
}
console.log(JSON.stringify({ output, results }, null, 2));
