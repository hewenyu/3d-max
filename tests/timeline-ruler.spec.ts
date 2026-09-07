import { expect, test, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import type { Project } from '../shared/types';

async function rulerGeometry(page: Page) {
  return page.locator('.timeline-ruler').evaluate((ruler) => {
    const rect = (element: Element) => {
      const bounds = element.getBoundingClientRect();
      return {
        left: bounds.left,
        right: bounds.right,
        width: bounds.width,
        top: bounds.top,
        height: bounds.height,
      };
    };
    const scroll = ruler.closest('.timeline-scroll')!;
    return {
      ruler: rect(ruler),
      scroll: rect(scroll),
      sticky: rect(scroll.querySelector('.track-labels')!),
      scrollLeft: scroll.scrollLeft,
      maximumScroll: scroll.scrollWidth - scroll.clientWidth,
      labels: [...ruler.querySelectorAll<HTMLSpanElement>('span')].map((label) => ({
        text: label.textContent,
        time: Number(label.dataset.time),
        ...rect(label),
      })),
      cards: [...scroll.querySelectorAll<HTMLElement>('.shot-card')].map((card) => ({
        ...rect(card),
        percent: card.style.width,
      })),
    };
  });
}

async function displayedTime(page: Page) {
  const text = await page.locator('.transport-time').evaluate((element) => element.firstChild!.textContent!);
  const [minutes, seconds, frames] = text.trim().split(':').map(Number);
  return minutes * 60 + seconds + frames / 24;
}

test('adaptive timeline labels remain readable through resize and scroll without changing seek or clips', async ({
  page,
  request,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const records: unknown[] = [];
  for (const duration of [2, 3.25, 120, 134]) {
    const created = await request.post('/api/project/new', {
      data: { name: `Timeline ruler ${duration}s`, template: 'empty' },
    });
    expect(created.ok()).toBe(true);
    const project = (await created.json()) as Project;
    const response = await request.post('/api/commands', {
      data: {
        projectId: project.id,
        expectedRevision: project.revision,
        commands: [
          { type: 'project.settings', payload: { aspect: '16:9', fps: 24 } },
          {
            type: 'object.create',
            payload: {
              id: 'ruler-box',
              name: 'Ruler subject',
              type: 'box',
              keyframes: [
                { id: 'start', time: 0, position: [0, 0, 0] },
                { id: 'end', time: duration, position: [3, 0, 0] },
              ],
            },
          },
          {
            type: 'camera.create',
            payload: { id: 'ruler-camera', name: 'Ruler camera', position: [7, 5, 9], target: [1.5, 0.5, 0] },
          },
          {
            type: 'shot.create',
            payload: {
              id: 'ruler-shot',
              name: 'Ruler shot',
              cameraId: 'ruler-camera',
              sourceIn: 0,
              sourceOut: duration,
            },
          },
          {
            type: 'sequence.update',
            payload: {
              id: project.activeSequenceId,
              patch: {
                clips: Array.from({ length: 4 }, (_, index) => ({
                  id: `ruler-clip-${index}`,
                  shotId: 'ruler-shot',
                  sourceIn: (duration * index) / 4,
                  sourceOut: (duration * (index + 1)) / 4,
                })),
              },
            },
          },
        ],
      },
    });
    expect(response.ok(), await response.text()).toBe(true);
    const savedBefore = await (await request.get('/api/project')).json();
    await page.goto('/');
    await expect(page.locator('.project-name')).toHaveText(project.name);
    await expect(page.locator('.shot-card')).toHaveCount(4);
    for (const width of [1440, 900, 390, 620, 1440]) {
      await page.setViewportSize({ width, height: width < 820 ? 844 : 1000 });
      const scroll = page.locator('.timeline-scroll');
      await scroll.evaluate((element) => {
        element.scrollLeft = 0;
      });
      await expect.poll(async () => (await rulerGeometry(page)).labels.at(-1)?.time).toBe(duration);
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
      );
      const geometry = await rulerGeometry(page);
      expect(geometry.labels.length).toBeGreaterThan(1);
      if (duration >= 120) expect(geometry.labels.length).toBeLessThan(30);
      for (const [index, label] of geometry.labels.entries()) {
        expect(label.left).toBeGreaterThanOrEqual(geometry.ruler.left - 0.1);
        expect(label.right).toBeLessThanOrEqual(geometry.ruler.right + 0.1);
        expect(label.time).toBeGreaterThanOrEqual(0);
        expect(label.time).toBeLessThanOrEqual(duration);
        if (index) expect(label.left - geometry.labels[index - 1].right).toBeGreaterThanOrEqual(9);
      }
      expect(geometry.labels.at(-1)!.right).toBeCloseTo(geometry.ruler.right, 1);
      const assertSeek = async (drag: boolean) => {
        const current = await rulerGeometry(page);
        const left = Math.max(current.ruler.left, current.sticky.right) + 2;
        const right = Math.min(current.ruler.right, current.scroll.right) - 2;
        const x = Math.round(left + (right - left) * 0.7);
        const y = Math.round(current.ruler.top + current.ruler.height / 2);
        if (drag) {
          await page.mouse.move(Math.round(left + (right - left) * 0.2), y);
          await page.mouse.down();
          await page.mouse.move(x, y, { steps: 8 });
          await page.mouse.up();
        } else await page.mouse.click(x, y);
        const expected = ((x - current.ruler.left) / current.ruler.width) * duration;
        await expect
          .poll(async () => Math.abs((await displayedTime(page)) - expected))
          .toBeLessThanOrEqual(1 / 24 + 0.001);
        const percent = await page
          .locator('.playhead')
          .evaluate((element: HTMLElement) => parseFloat(element.style.left));
        expect(Math.abs((percent * duration) / 100 - expected)).toBeLessThan(0.001);
        return {
          drag,
          clientX: x,
          expected,
          displayed: await displayedTime(page),
          playheadPercent: percent,
          scrollLeft: current.scrollLeft,
        };
      };
      const seeks = [await assertSeek(false), await assertSeek(true)];
      await page.screenshot({ path: testInfo.outputPath(`ruler-${duration}s-${width}px-start.png`) });
      if (geometry.maximumScroll > 0) {
        await page.mouse.move((geometry.scroll.left + geometry.scroll.right) / 2, geometry.ruler.top + 45);
        await page.mouse.wheel(10000, 0);
        await expect
          .poll(() => scroll.evaluate((element) => element.scrollLeft))
          .toBe(geometry.maximumScroll);
        const scrolled = await rulerGeometry(page);
        const terminal = scrolled.labels.at(-1)!;
        expect(terminal.left).toBeGreaterThan(scrolled.sticky.right);
        expect(terminal.right).toBeLessThanOrEqual(scrolled.scroll.right);
        expect(terminal.right).toBeCloseTo(scrolled.ruler.right, 1);
        seeks.push(await assertSeek(false), await assertSeek(true));
        await page.screenshot({ path: testInfo.outputPath(`ruler-${duration}s-${width}px-end.png`) });
      }
      const after = await rulerGeometry(page);
      expect(after.cards.map((card) => card.percent)).toEqual(geometry.cards.map((card) => card.percent));
      // Selected clip borders redistribute flex rounding by fractions of a CSS pixel.
      for (let index = 0; index < after.cards.length; index++)
        expect(Math.abs(after.cards[index].width - geometry.cards[index].width)).toBeLessThan(0.1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      records.push({ duration, width, geometry, after, seeks });
    }
    expect(await (await request.get('/api/project')).json()).toEqual(savedBefore);
    records.push({ duration, projectId: project.id, savedProjectUnchanged: true });
  }
  expect(errors).toEqual([]);
  await writeFile(testInfo.outputPath('timeline-ruler.json'), JSON.stringify({ errors, records }, null, 2));
});
