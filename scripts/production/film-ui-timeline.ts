import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { expect, type Page } from '@playwright/test';

async function geometry(page: Page) {
  return page.locator('.timeline-ruler').evaluate((ruler) => {
    const scroll = ruler.closest('.timeline-scroll')!;
    const [rulerBounds, scrollBounds, stickyBounds] = [
      ruler,
      scroll,
      scroll.querySelector('.track-labels')!,
    ].map((element) => {
      const bounds = element.getBoundingClientRect();
      return {
        left: bounds.left,
        right: bounds.right,
        top: bounds.top,
        bottom: bounds.bottom,
        width: bounds.width,
        height: bounds.height,
      };
    });
    return {
      ruler: rulerBounds,
      scroll: scrollBounds,
      sticky: stickyBounds,
      scrollLeft: scroll.scrollLeft,
      maximumScroll: scroll.scrollWidth - scroll.clientWidth,
      labels: [...ruler.querySelectorAll<HTMLSpanElement>(':scope > span')].map((label) => {
        const range = document.createRange();
        range.selectNodeContents(label);
        const [bounds, textBounds] = [label.getBoundingClientRect(), range.getBoundingClientRect()].map(
          (rect) => ({
            left: rect.left,
            right: rect.right,
            top: rect.top,
            bottom: rect.bottom,
            width: rect.width,
            height: rect.height,
          }),
        );
        return {
          text: label.textContent ?? '',
          time: Number(label.dataset.time),
          terminal: label.classList.contains('ruler-end'),
          ...bounds,
          textBounds,
        };
      }),
      cardWidths: [...scroll.querySelectorAll('.shot-card')].map(
        (card) => card.getBoundingClientRect().width,
      ),
    };
  });
}

function validateGeometry(
  value: Awaited<ReturnType<typeof geometry>>,
  duration: number,
  terminalVisible: boolean,
) {
  assert.ok(value.labels.length >= 2);
  assert.equal(value.labels[0].time, 0);
  const terminal = value.labels.at(-1)!;
  assert.equal(terminal.time, duration);
  assert.equal(terminal.terminal, true);
  for (const [index, label] of value.labels.entries()) {
    assert.equal(
      label.text,
      `${new Intl.NumberFormat('en-US', { useGrouping: false, maximumFractionDigits: 3 }).format(label.time)}s`,
    );
    assert.ok(label.left >= value.ruler.left - 0.1);
    assert.ok(label.right <= value.ruler.right + 0.1);
    assert.ok(label.textBounds.left >= label.left - 0.1);
    assert.ok(label.textBounds.right <= label.right + 0.1);
    assert.ok(label.textBounds.top >= value.ruler.top - 0.1);
    assert.ok(label.textBounds.bottom <= value.ruler.bottom + 0.1);
    const tickEdge = label.terminal ? label.right : label.left;
    assert.ok(Math.abs(tickEdge - value.ruler.left - (label.time / duration) * value.ruler.width) <= 1);
    if (index) {
      assert.ok(label.time > value.labels[index - 1].time);
      assert.ok(label.left - value.labels[index - 1].right >= 9);
    }
  }
  assert.ok(Math.abs(terminal.right - value.ruler.right) <= 0.1);
  if (terminalVisible) {
    assert.ok(terminal.left >= value.sticky.right);
    assert.ok(terminal.right <= value.scroll.right + 0.1);
    assert.ok(terminal.textBounds.right <= value.scroll.right + 0.1);
  }
}

async function displayedTime(page: Page, fps: number) {
  const text = await page
    .locator('.transport-time')
    .evaluate((element) => element.firstChild!.textContent!.trim());
  assert.match(text, /^\d+:\d{2}:\d{2}$/);
  const [minutes, seconds, frames] = text.split(':').map(Number);
  return minutes * 60 + seconds + frames / fps;
}

async function seek(page: Page, duration: number, fps: number, drag: boolean) {
  const current = await geometry(page);
  const left = Math.max(current.ruler.left, current.sticky.right) + 3;
  const right = Math.min(current.ruler.right, current.scroll.right) - 3;
  assert.ok(right - left > 50);
  const x = Math.round(left + (right - left) * (drag ? 0.72 : 0.28));
  const y = Math.round(current.ruler.top + current.ruler.height / 2);
  if (drag) {
    await page.mouse.move(Math.round(left + (right - left) * 0.18), y);
    await page.mouse.down();
    await page.mouse.move(x, y, { steps: 10 });
    await page.mouse.up();
  } else await page.mouse.click(x, y);
  const expected = ((x - current.ruler.left) / current.ruler.width) * duration;
  await expect
    .poll(async () => Math.abs((await displayedTime(page, fps)) - expected))
    .toBeLessThanOrEqual(1 / fps + 0.001);
  const percent = await page
    .locator('.playhead')
    .evaluate((element: HTMLElement) => parseFloat(element.style.left));
  assert.ok(Math.abs((percent / 100) * duration - expected) < 0.001);
  return {
    drag,
    clientX: x,
    clientY: y,
    expected,
    displayed: await displayedTime(page, fps),
    playheadPercent: percent,
    scrollLeft: current.scrollLeft,
  };
}

export async function verifyTimeline(
  page: Page,
  duration: number,
  fps: number,
  width: number,
  directory: string,
  viewport: string,
) {
  const scroll = page.locator('.timeline-scroll');
  await expect.poll(async () => (await geometry(page)).labels.at(-1)?.time).toBe(duration);
  const initial = await geometry(page);
  assert.equal(initial.scrollLeft, 0);
  validateGeometry(initial, duration, initial.maximumScroll === 0);
  const seeks = [await seek(page, duration, fps, false), await seek(page, duration, fps, true)];
  assert.ok(seeks[1].displayed > seeks[0].displayed);
  await page.screenshot({ path: resolve(directory, `${viewport}-ruler-start.png`) });
  let scrolled: Awaited<ReturnType<typeof geometry>> | undefined;
  if (width <= 520) assert.ok(initial.maximumScroll > 0);
  if (initial.maximumScroll > 0) {
    await page.mouse.move((initial.scroll.left + initial.scroll.right) / 2, initial.ruler.top + 45);
    await page.mouse.wheel(10000, 0);
    await expect.poll(() => scroll.evaluate((element) => element.scrollLeft)).toBe(initial.maximumScroll);
    scrolled = await geometry(page);
    validateGeometry(scrolled, duration, true);
    assert.deepEqual(
      scrolled.labels.map(({ text, time }) => ({ text, time })),
      initial.labels.map(({ text, time }) => ({ text, time })),
    );
    for (const [index, label] of scrolled.labels.entries())
      assert.ok(Math.abs(initial.labels[index].left - label.left - scrolled.scrollLeft) <= 1);
    seeks.push(await seek(page, duration, fps, false), await seek(page, duration, fps, true));
    await page.screenshot({ path: resolve(directory, `${viewport}-ruler-end.png`) });
    await page.mouse.move((scrolled.scroll.left + scrolled.scroll.right) / 2, scrolled.ruler.top + 45);
    await page.mouse.wheel(-10000, 0);
    await expect.poll(() => scroll.evaluate((element) => element.scrollLeft)).toBe(0);
  }
  await page.getByRole('button', { name: '回到开始', exact: true }).click();
  await expect.poll(() => displayedTime(page, fps)).toBe(0);
  const restored = await geometry(page);
  assert.deepEqual(restored.cardWidths, initial.cardWidths);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
  return { duration, fps, initial, scrolled, restored, seeks, returnedToStart: true };
}
