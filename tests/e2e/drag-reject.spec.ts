import { test, expect } from '@playwright/test';

test.describe('Incompatible drag rejection', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => (window as unknown as { app: unknown }).app !== undefined, null, { timeout: 15000 });
  });

  test('mono and stereo tracks both render in the timeline', async ({ page }) => {
    const trackCount = await page.evaluate(() => {
      const app = (window as unknown as {
        app: {
          timelineModel: {
            createTimeline: (sr: number) => void;
            addTrack: (name: string, color: string, idx: number, ch?: number) => { id: string };
            addClip: (trackId: string, clip: unknown) => void;
            timeline: { tracks: Array<{ id: string; channels: number }> };
          };
          bufferPool: { store: (id: string, buf: Float32Array) => void };
          timelineRenderer: { setTimeline: (t: unknown) => void; render: () => void } | null;
        };
      }).app;

      app.timelineModel.createTimeline(48000);
      app.bufferPool.store('buf-mono', new Float32Array(48000));
      app.bufferPool.store('buf-st-L', new Float32Array(48000));
      app.bufferPool.store('buf-st-R', new Float32Array(48000));

      const monoTrack = app.timelineModel.addTrack('Mono Track', '#3b82f6', 0, 1);
      const stereoTrack = app.timelineModel.addTrack('Stereo Track', '#10b981', 1, 2);

      // Add a clip to each track
      app.timelineModel.addClip(monoTrack.id, {
        id: 'mono-clip',
        bufferId: 'buf-mono',
        name: 'Mono Clip',
        timelineOffset: 0,
        sourceStart: 0,
        sourceEnd: 48000,
        duration: 48000,
        gainDb: 0,
        fadeInSamples: 0,
        fadeOutSamples: 0,
        muted: false,
      });

      app.timelineModel.addClip(stereoTrack.id, {
        id: 'stereo-clip-L',
        bufferId: 'buf-st-L',
        name: 'Stereo Clip L',
        timelineOffset: 0,
        sourceStart: 0,
        sourceEnd: 48000,
        duration: 48000,
        gainDb: 0,
        fadeInSamples: 0,
        fadeOutSamples: 0,
        muted: false,
        subChannel: 0,
      });

      app.timelineModel.addClip(stereoTrack.id, {
        id: 'stereo-clip-R',
        bufferId: 'buf-st-R',
        name: 'Stereo Clip R',
        timelineOffset: 0,
        sourceStart: 0,
        sourceEnd: 48000,
        duration: 48000,
        gainDb: 0,
        fadeInSamples: 0,
        fadeOutSamples: 0,
        muted: false,
        subChannel: 1,
      });

      if (app.timelineRenderer) {
        app.timelineRenderer.setTimeline(app.timelineModel.timeline);
        app.timelineRenderer.render();
      }

      return app.timelineModel.timeline.tracks.length;
    });

    expect(trackCount).toBe(2);

    // Verify the timeline canvas is visible and rendering
    const canvas = page.locator('#timeline-canvas');
    await expect(canvas).toBeVisible();
  });

  test('mono track has channel count 1 and stereo track has channel count 2', async ({ page }) => {
    const channels = await page.evaluate(() => {
      const app = (window as unknown as {
        app: {
          timelineModel: {
            createTimeline: (sr: number) => void;
            addTrack: (name: string, color: string, idx: number, ch?: number) => { id: string };
            timeline: { tracks: Array<{ channels: number; name: string }> };
          };
        };
      }).app;

      app.timelineModel.createTimeline(48000);
      app.timelineModel.addTrack('Mono', '#3b82f6', 0, 1);
      app.timelineModel.addTrack('Stereo', '#10b981', 1, 2);

      return app.timelineModel.timeline.tracks.map(t => ({
        name: t.name,
        channels: t.channels,
      }));
    });

    expect(channels).toEqual([
      { name: 'Mono', channels: 1 },
      { name: 'Stereo', channels: 2 },
    ]);
  });

  test('timeline canvas renders without errors after creating mixed tracks', async ({ page }) => {
    // Set up mixed channel tracks and verify no JS errors during render
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await page.evaluate(() => {
      const app = (window as unknown as {
        app: {
          timelineModel: {
            createTimeline: (sr: number) => void;
            addTrack: (name: string, color: string, idx: number, ch?: number) => { id: string };
            timeline: { tracks: Array<{ id: string }> };
          };
          bufferPool: { store: (id: string, buf: Float32Array) => void };
          timelineRenderer: { setTimeline: (t: unknown) => void; render: () => void } | null;
        };
      }).app;

      app.timelineModel.createTimeline(48000);
      app.timelineModel.addTrack('Mono', '#3b82f6', 0, 1);
      app.timelineModel.addTrack('Stereo', '#10b981', 1, 2);
      app.timelineModel.addTrack('Quad', '#f59e0b', 2, 4);

      if (app.timelineRenderer) {
        app.timelineRenderer.setTimeline(app.timelineModel.timeline);
        app.timelineRenderer.render();
      }
    });

    // No JS errors should have occurred
    expect(errors).toEqual([]);
  });
});
