import { test, expect } from '@playwright/test';

test.describe('Cross-track split/merge', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => (window as unknown as { app: unknown }).app !== undefined, null, { timeout: 15000 });
  });

  test('stereo track shows 2 sub-channel clips (L+R)', async ({ page }) => {
    const clipCount = await page.evaluate(() => {
      const app = (window as unknown as {
        app: {
          timelineModel: {
            createTimeline: (sr: number) => void;
            importMultiChannelFile: (ids: string[], name: string, sr: number, len: number) => void;
            timeline: { tracks: Array<{ id: string; channels: number; clips: Array<{ subChannel?: number }> }> };
          };
          bufferPool: { store: (id: string, buf: Float32Array) => void };
          timelineRenderer: { setTimeline: (t: unknown) => void; render: () => void } | null;
        };
      }).app;

      app.timelineModel.createTimeline(48000);

      // Store 2 channel buffers
      const bufL = new Float32Array(48000);
      const bufR = new Float32Array(48000);
      app.bufferPool.store('stereo-L', bufL);
      app.bufferPool.store('stereo-R', bufR);

      // Import as stereo file
      app.timelineModel.importMultiChannelFile(
        ['stereo-L', 'stereo-R'],
        'Field Recording',
        48000,
        48000,
      );

      if (app.timelineRenderer) {
        app.timelineRenderer.setTimeline(app.timelineModel.timeline);
        app.timelineRenderer.render();
      }

      const track = app.timelineModel.timeline.tracks[0];
      return track.clips.length;
    });

    // A stereo track should have 2 clips (L sub-channel 0, R sub-channel 1)
    expect(clipCount).toBe(2);
  });

  test('stereo track clips have correct subChannel indices', async ({ page }) => {
    const subChannels = await page.evaluate(() => {
      const app = (window as unknown as {
        app: {
          timelineModel: {
            createTimeline: (sr: number) => void;
            importMultiChannelFile: (ids: string[], name: string, sr: number, len: number) => void;
            timeline: { tracks: Array<{ clips: Array<{ subChannel?: number }> }> };
          };
          bufferPool: { store: (id: string, buf: Float32Array) => void };
        };
      }).app;

      app.timelineModel.createTimeline(48000);
      app.bufferPool.store('st-L', new Float32Array(48000));
      app.bufferPool.store('st-R', new Float32Array(48000));
      app.timelineModel.importMultiChannelFile(['st-L', 'st-R'], 'Stereo', 48000, 48000);

      return app.timelineModel.timeline.tracks[0].clips.map(c => c.subChannel);
    });

    expect(subChannels).toEqual([0, 1]);
  });

  test('two mono tracks each have 1 clip', async ({ page }) => {
    const result = await page.evaluate(() => {
      const app = (window as unknown as {
        app: {
          timelineModel: {
            createTimeline: (sr: number) => void;
            addTrack: (name: string, color: string, idx: number, ch?: number) => { id: string; clips: unknown[] };
            addClip: (trackId: string, clip: unknown) => void;
            timeline: { tracks: Array<{ id: string; channels: number; clips: unknown[] }> };
          };
          bufferPool: { store: (id: string, buf: Float32Array) => void };
          timelineRenderer: { setTimeline: (t: unknown) => void; render: () => void } | null;
        };
      }).app;

      app.timelineModel.createTimeline(48000);

      app.bufferPool.store('mono-1', new Float32Array(48000));
      app.bufferPool.store('mono-2', new Float32Array(48000));

      const t1 = app.timelineModel.addTrack('Mono L', '#3b82f6', 0, 1);
      const t2 = app.timelineModel.addTrack('Mono R', '#10b981', 1, 1);

      app.timelineModel.addClip(t1.id, {
        id: 'mono-clip-1',
        bufferId: 'mono-1',
        name: 'Mono Clip L',
        timelineOffset: 0,
        sourceStart: 0,
        sourceEnd: 48000,
        duration: 48000,
        gainDb: 0,
        fadeInSamples: 0,
        fadeOutSamples: 0,
        muted: false,
      });

      app.timelineModel.addClip(t2.id, {
        id: 'mono-clip-2',
        bufferId: 'mono-2',
        name: 'Mono Clip R',
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

      return {
        trackCount: app.timelineModel.timeline.tracks.length,
        track1Clips: app.timelineModel.timeline.tracks[0].clips.length,
        track2Clips: app.timelineModel.timeline.tracks[1].clips.length,
        track1Channels: app.timelineModel.timeline.tracks[0].channels,
        track2Channels: app.timelineModel.timeline.tracks[1].channels,
      };
    });

    expect(result.trackCount).toBe(2);
    expect(result.track1Clips).toBe(1);
    expect(result.track2Clips).toBe(1);
    expect(result.track1Channels).toBe(1);
    expect(result.track2Channels).toBe(1);
  });

  test('tracks display correct channel count (stereo = 2)', async ({ page }) => {
    const channelCount = await page.evaluate(() => {
      const app = (window as unknown as {
        app: {
          timelineModel: {
            createTimeline: (sr: number) => void;
            importMultiChannelFile: (ids: string[], name: string, sr: number, len: number) => void;
            timeline: { tracks: Array<{ channels: number }> };
          };
          bufferPool: { store: (id: string, buf: Float32Array) => void };
        };
      }).app;

      app.timelineModel.createTimeline(48000);
      app.bufferPool.store('ch-L', new Float32Array(48000));
      app.bufferPool.store('ch-R', new Float32Array(48000));
      app.timelineModel.importMultiChannelFile(['ch-L', 'ch-R'], 'StereoFile', 48000, 48000);

      return app.timelineModel.timeline.tracks[0].channels;
    });

    expect(channelCount).toBe(2);
  });
});
