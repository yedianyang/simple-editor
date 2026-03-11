import { test, expect } from '@playwright/test';

test.describe('WAV iXML track names (inline rename)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => (window as unknown as { app: unknown }).app !== undefined, null, { timeout: 15000 });

    // Set up a timeline with one track and a clip so the timeline renders
    await page.evaluate(() => {
      const app = (window as unknown as {
        app: {
          timelineModel: {
            createTimeline: (sr: number) => void;
            addTrack: (name: string, color: string, idx: number, ch?: number) => { id: string; name: string; clips: unknown[] };
            timeline: { tracks: Array<{ id: string; name: string; clips: unknown[] }> };
          };
          bufferPool: { store: (id: string, buf: Float32Array) => void };
          timelineRenderer: { setTimeline: (t: unknown) => void; render: () => void } | null;
          audioEngine: { audioBuffer: AudioBuffer; audioContext: AudioContext };
        };
      }).app;

      const ctx = app.audioEngine.audioContext;
      app.audioEngine.audioBuffer = ctx.createBuffer(1, 48000, 48000);

      app.timelineModel.createTimeline(48000);
      app.timelineModel.addTrack('Ambience L', '#3b82f6', 0);

      // Add a dummy clip
      const track = app.timelineModel.timeline.tracks[0];
      const bufferId = 'test-buf-1';
      app.bufferPool.store(bufferId, new Float32Array(48000));
      track.clips.push({
        id: 'clip-1',
        bufferId,
        name: 'Test Clip',
        timelineOffset: 0,
        sourceStart: 0,
        sourceEnd: 48000,
        duration: 48000,
        gainDb: 0,
        fadeInSamples: 0,
        fadeOutSamples: 0,
        muted: false,
      });

      if (app.timelineRenderer) {
        app.timelineRenderer.setTimeline(app.timelineModel.timeline);
        app.timelineRenderer.render();
      }
    });
  });

  test('double-click on track header area creates an inline input', async ({ page }) => {
    const canvas = page.locator('#timeline-canvas');
    await expect(canvas).toBeVisible();

    // The track name is rendered at approximately x=6, y=RULER_HEIGHT(30)+17=47
    // Double-click in the track name region (header area top-left)
    const box = await canvas.boundingBox();
    if (!box) throw new Error('Canvas not visible');

    // Track name area: x 4-48, y RULER_HEIGHT(30)+6 to RULER_HEIGHT(30)+20
    await canvas.dblclick({ position: { x: 20, y: 45 } });

    // An input element should appear in the document body
    const input = page.locator('input[type="text"][style*="z-index"]');
    await expect(input).toBeVisible({ timeout: 2000 });
  });

  test('inline input shows current track name', async ({ page }) => {
    const canvas = page.locator('#timeline-canvas');
    await canvas.dblclick({ position: { x: 20, y: 45 } });

    const input = page.locator('input[type="text"][style*="z-index"]');
    await expect(input).toBeVisible({ timeout: 2000 });
    await expect(input).toHaveValue('Ambience L');
  });

  test('pressing Enter saves the new track name', async ({ page }) => {
    const canvas = page.locator('#timeline-canvas');
    await canvas.dblclick({ position: { x: 20, y: 45 } });

    const input = page.locator('input[type="text"][style*="z-index"]');
    await expect(input).toBeVisible({ timeout: 2000 });

    await input.fill('Wind Atmos');
    await input.press('Enter');

    // Input should be removed
    await expect(input).toBeHidden({ timeout: 2000 });

    // Verify the track name was updated in the model
    const trackName = await page.evaluate(() => {
      const app = (window as unknown as {
        app: { timelineModel: { timeline: { tracks: Array<{ name: string }> } } };
      }).app;
      return app.timelineModel.timeline.tracks[0].name;
    });
    expect(trackName).toBe('Wind Atmos');
  });

  test('pressing Escape cancels the edit', async ({ page }) => {
    const canvas = page.locator('#timeline-canvas');
    await canvas.dblclick({ position: { x: 20, y: 45 } });

    const input = page.locator('input[type="text"][style*="z-index"]');
    await expect(input).toBeVisible({ timeout: 2000 });

    await input.fill('Should Not Save');
    await input.press('Escape');

    // Input should be removed
    await expect(input).toBeHidden({ timeout: 2000 });

    // Verify the original name is preserved
    const trackName = await page.evaluate(() => {
      const app = (window as unknown as {
        app: { timelineModel: { timeline: { tracks: Array<{ name: string }> } } };
      }).app;
      return app.timelineModel.timeline.tracks[0].name;
    });
    expect(trackName).toBe('Ambience L');
  });
});
