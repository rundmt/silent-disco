// The party end to end: the real app plays its test tone, the DJ console
// drives it, and phone pages in Chromium listen over WebRTC.
import { expect, test, type Page } from '@playwright/test';
import { audioStats, startRelay, startStation, watchPeers, type Station } from './station';

let station: Station;
test.beforeEach(async () => {
  station = await startStation();
});
test.afterEach(async () => {
  await station.stop();
});

async function openPhone(page: Page, url = station.phoneURL) {
  await page.setViewportSize({ width: 390, height: 800 });
  await watchPeers(page);
  await page.goto(url);
  await page.click('button.play');
  await expect(page.locator('.status-line')).toHaveText(/Listening live/, { timeout: 10_000 });
}

async function expectAudioFlowing(page: Page, what: string) {
  const before = await audioStats(page);
  await page.waitForTimeout(1500);
  const after = await audioStats(page);
  expect(after.bytes - before.bytes, `${what}: audio bytes in 1.5 s`).toBeGreaterThan(5_000);
  return after;
}

test('a phone hears the DJ', async ({ page }) => {
  await openPhone(page);
  const s = await expectAudioFlowing(page, 'listening');
  expect(s.open).toBe(1);
  // The tone is playing, not silence.
  await expect.poll(async () => (await audioStats(page)).level, { timeout: 5_000 }).toBeGreaterThan(0.01);
});

test('the console goes off air and back, and phones follow', async ({ page, context }) => {
  const dj = await context.newPage();
  await dj.goto(station.consoleURL);
  await expect(dj.locator('#goLive')).toHaveText('Stop broadcast'); // terminal mode starts live

  await openPhone(page);
  await expect(dj.locator('#count')).toHaveText('1', { timeout: 10_000 });

  await dj.click('#goLive');
  await expect(dj.locator('#goLive')).toHaveText('Go live');
  await expect(page.locator('.status-line')).toHaveText(/off air/);
  // Off air still sends (silent) audio so phones' buffers stay small.
  await expectAudioFlowing(page, 'off air');
  await expect.poll(async () => (await audioStats(page)).level, { timeout: 5_000 }).toBeLessThan(0.001);

  await dj.click('#goLive');
  await expect(page.locator('.status-line')).toHaveText(/Listening live/);
  await expect.poll(async () => (await audioStats(page)).level, { timeout: 5_000 }).toBeGreaterThan(0.01);
});

test('music keeps playing when the phone loses its connection to the page server', async ({ page }) => {
  const relay = await startRelay(station.port);
  try {
    await openPhone(page, relay.url);
    await expectAudioFlowing(page, 'before');

    const seen = relay.accepted;
    relay.cut(); // what Android does to Chrome in the background
    await expectAudioFlowing(page, 'while cut off');
    // The page reconnects its event stream on its own and resumes as the same phone.
    await expect.poll(() => relay.accepted, { timeout: 15_000 }).toBeGreaterThan(seen);
    await page.waitForTimeout(1000);
    const after = await expectAudioFlowing(page, 'after reconnecting');
    // Same audio connection: no renegotiation, no second peer.
    expect(after.peers).toBe(1);
    expect(after.open).toBe(1);
    await expect(page.locator('.stage')).toBeVisible();
    await expect(page.locator('.status-line')).toHaveText(/Listening live/, { timeout: 10_000 });

    const state = await page.request.get(`http://127.0.0.1:${station.port}/api/state`, {
      headers: { 'X-Token': station.token },
    });
    expect(state.ok()).toBe(true);
  } finally {
    await relay.close();
  }
});

test('the DJ restyles every phone', async ({ page, context }) => {
  const dj = await context.newPage();
  await dj.goto(station.consoleURL);
  await openPhone(page);

  await dj.click('#visualStyle >> text=Bars');
  await dj.click('.swatch-chip[title="Sunset"]');
  await expect(page.locator('main.listener')).toHaveAttribute('style', /--c1:\s*#ff3b6b/);

  // A white flash lights up the phone's screen for a moment. Watch a corner
  // of the visuals canvas, which is otherwise dark, frame by frame.
  const flashed = page.evaluate(
    () =>
      new Promise<boolean>((resolve) => {
        const canvas = document.querySelector('canvas.visualizer') as HTMLCanvasElement;
        const g = canvas.getContext('2d')!;
        const until = performance.now() + 5000;
        const look = () => {
          const [r, gr, b] = g.getImageData(2, 2, 1, 1).data;
          if (r > 180 && gr > 180 && b > 180) return resolve(true);
          if (performance.now() > until) return resolve(false);
          requestAnimationFrame(look);
        };
        look();
      }),
  );
  await dj.locator('#flash .flash-btn').first().dispatchEvent('pointerdown');
  expect(await flashed, 'phone flashed white').toBe(true);
});

test('the console API refuses requests without its token', async ({ request }) => {
  expect((await request.get(`http://127.0.0.1:${station.port}/api/state`)).status()).toBe(403);
  expect((await request.post(`http://127.0.0.1:${station.port}/api/live`, { data: { live: false } })).status()).toBe(403);
});
