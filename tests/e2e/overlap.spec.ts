import { test, expect } from '@playwright/test';

test.describe('Overlap auto-trim (Pro Tools behavior)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => (window as unknown as { app: unknown }).app !== undefined, null, { timeout: 15000 });
  });

  test('moving a clip to fully cover another removes the covered clip', async ({ page }) => {
    const result = await page.evaluate(() => {
      const app = (window as unknown as {
        app: {
          timelineModel: {
            createTimeline: (sr: number) => void;
            addTrack: (name: string, color: string, idx: number) => { id: string };
            addClip: (trackId: string, clip: unknown) => void;
            moveClip: (trackId: string, clipId: string, newOffset: number) => void;
            resolveOverlaps: (trackId: string, protectedClipId: string) => {
              removed: Array<{ id: string }>;
              trimmed: Array<{ clipId: string }>;
            };
            timeline: { tracks: Array<{ id: string; clips: Array<{ id: string; timelineOffset: number; duration: number }> }> };
          };
          bufferPool: { store: (id: string, buf: Float32Array) => void };
        };
      }).app;

      app.timelineModel.createTimeline(48000);
      app.bufferPool.store('buf-a', new Float32Array(48000));
      app.bufferPool.store('buf-b', new Float32Array(96000));

      const track = app.timelineModel.addTrack('Track 1', '#3b82f6', 0);

      // Small clip at offset 24000, duration 48000 (0.5s to 1.5s)
      app.timelineModel.addClip(track.id, {
        id: 'small-clip',
        bufferId: 'buf-a',
        name: 'Small Clip',
        timelineOffset: 24000,
        sourceStart: 0,
        sourceEnd: 48000,
        duration: 48000,
        gainDb: 0,
        fadeInSamples: 0,
        fadeOutSamples: 0,
        muted: false,
      });

      // Large clip at offset 200000 (far away), duration 96000 (2s)
      app.timelineModel.addClip(track.id, {
        id: 'large-clip',
        bufferId: 'buf-b',
        name: 'Large Clip',
        timelineOffset: 200000,
        sourceStart: 0,
        sourceEnd: 96000,
        duration: 96000,
        gainDb: 0,
        fadeInSamples: 0,
        fadeOutSamples: 0,
        muted: false,
      });

      // Move large clip to offset 0 -- it fully covers the small clip (0 to 96000 covers 24000 to 72000)
      app.timelineModel.moveClip(track.id, 'large-clip', 0);
      const overlapResult = app.timelineModel.resolveOverlaps(track.id, 'large-clip');

      return {
        removedCount: overlapResult.removed.length,
        remainingClips: app.timelineModel.timeline.tracks[0].clips.length,
        remainingClipIds: app.timelineModel.timeline.tracks[0].clips.map(c => c.id),
      };
    });

    expect(result.removedCount).toBe(1);
    expect(result.remainingClips).toBe(1);
    expect(result.remainingClipIds).toContain('large-clip');
  });

  test('partial overlap trims the overlapped clip (right overlap)', async ({ page }) => {
    const result = await page.evaluate(() => {
      const app = (window as unknown as {
        app: {
          timelineModel: {
            createTimeline: (sr: number) => void;
            addTrack: (name: string, color: string, idx: number) => { id: string };
            addClip: (trackId: string, clip: unknown) => void;
            moveClip: (trackId: string, clipId: string, newOffset: number) => void;
            resolveOverlaps: (trackId: string, protectedClipId: string) => {
              removed: Array<{ id: string }>;
              trimmed: Array<{ clipId: string; before: { duration: number }; after: { duration: number } }>;
            };
            timeline: { tracks: Array<{ id: string; clips: Array<{ id: string; timelineOffset: number; duration: number }> }> };
          };
          bufferPool: { store: (id: string, buf: Float32Array) => void };
        };
      }).app;

      app.timelineModel.createTimeline(48000);
      app.bufferPool.store('buf-1', new Float32Array(48000));
      app.bufferPool.store('buf-2', new Float32Array(48000));

      const track = app.timelineModel.addTrack('Track 1', '#3b82f6', 0);

      // Clip A at offset 0, duration 48000
      app.timelineModel.addClip(track.id, {
        id: 'clip-a',
        bufferId: 'buf-1',
        name: 'Clip A',
        timelineOffset: 0,
        sourceStart: 0,
        sourceEnd: 48000,
        duration: 48000,
        gainDb: 0,
        fadeInSamples: 0,
        fadeOutSamples: 0,
        muted: false,
      });

      // Clip B at offset 100000 (far away), duration 48000
      app.timelineModel.addClip(track.id, {
        id: 'clip-b',
        bufferId: 'buf-2',
        name: 'Clip B',
        timelineOffset: 100000,
        sourceStart: 0,
        sourceEnd: 48000,
        duration: 48000,
        gainDb: 0,
        fadeInSamples: 0,
        fadeOutSamples: 0,
        muted: false,
      });

      // Move clip B to overlap with clip A's right half (offset 24000)
      // Clip B: 24000-72000, Clip A: 0-48000 -> overlap at 24000-48000
      app.timelineModel.moveClip(track.id, 'clip-b', 24000);
      const overlapResult = app.timelineModel.resolveOverlaps(track.id, 'clip-b');

      const clipA = app.timelineModel.timeline.tracks[0].clips.find(
        (c: { id: string }) => c.id === 'clip-a'
      );

      return {
        trimmedCount: overlapResult.trimmed.length,
        clipADuration: clipA?.duration,
        clipAEnd: clipA ? clipA.timelineOffset + clipA.duration : 0,
      };
    });

    // Clip A should be trimmed so it ends at 24000 (where clip B starts)
    expect(result.trimmedCount).toBe(1);
    expect(result.clipADuration).toBe(24000);
    expect(result.clipAEnd).toBe(24000);
  });

  test('clip spanning moved clip gets split into two parts', async ({ page }) => {
    const result = await page.evaluate(() => {
      const app = (window as unknown as {
        app: {
          timelineModel: {
            createTimeline: (sr: number) => void;
            addTrack: (name: string, color: string, idx: number) => { id: string };
            addClip: (trackId: string, clip: unknown) => void;
            moveClip: (trackId: string, clipId: string, newOffset: number) => void;
            resolveOverlaps: (trackId: string, protectedClipId: string) => {
              removed: Array<{ id: string }>;
              trimmed: Array<{ clipId: string }>;
              added: Array<{ id: string }>;
            };
            timeline: { tracks: Array<{ id: string; clips: Array<{ id: string; timelineOffset: number; duration: number }> }> };
          };
          bufferPool: { store: (id: string, buf: Float32Array) => void };
        };
      }).app;

      app.timelineModel.createTimeline(48000);
      app.bufferPool.store('buf-long', new Float32Array(96000));
      app.bufferPool.store('buf-short', new Float32Array(24000));

      const track = app.timelineModel.addTrack('Track 1', '#3b82f6', 0);

      // Long clip spanning 0-96000
      app.timelineModel.addClip(track.id, {
        id: 'long-clip',
        bufferId: 'buf-long',
        name: 'Long Clip',
        timelineOffset: 0,
        sourceStart: 0,
        sourceEnd: 96000,
        duration: 96000,
        gainDb: 0,
        fadeInSamples: 0,
        fadeOutSamples: 0,
        muted: false,
      });

      // Short clip placed far away initially
      app.timelineModel.addClip(track.id, {
        id: 'short-clip',
        bufferId: 'buf-short',
        name: 'Short Clip',
        timelineOffset: 200000,
        sourceStart: 0,
        sourceEnd: 24000,
        duration: 24000,
        gainDb: 0,
        fadeInSamples: 0,
        fadeOutSamples: 0,
        muted: false,
      });

      // Move short clip into the middle of the long clip (offset 36000)
      // This should split the long clip: [0-36000] and [60000-96000]
      app.timelineModel.moveClip(track.id, 'short-clip', 36000);
      const overlapResult = app.timelineModel.resolveOverlaps(track.id, 'short-clip');

      return {
        addedCount: overlapResult.added.length,
        trimmedCount: overlapResult.trimmed.length,
        totalClips: app.timelineModel.timeline.tracks[0].clips.length,
      };
    });

    // The long clip should be split: original trimmed to left part, new right part added
    expect(result.trimmedCount).toBe(1);
    expect(result.addedCount).toBe(1);
    // Total: left part of long + short clip + right part of long = 3
    expect(result.totalClips).toBe(3);
  });

  test('timeline renders without errors after overlap resolution', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await page.evaluate(() => {
      const app = (window as unknown as {
        app: {
          timelineModel: {
            createTimeline: (sr: number) => void;
            addTrack: (name: string, color: string, idx: number) => { id: string };
            addClip: (trackId: string, clip: unknown) => void;
            moveClip: (trackId: string, clipId: string, newOffset: number) => void;
            resolveOverlaps: (trackId: string, protectedClipId: string) => void;
            timeline: { tracks: Array<{ id: string }> };
          };
          bufferPool: { store: (id: string, buf: Float32Array) => void };
          timelineRenderer: { setTimeline: (t: unknown) => void; render: () => void } | null;
        };
      }).app;

      app.timelineModel.createTimeline(48000);
      app.bufferPool.store('ov-a', new Float32Array(48000));
      app.bufferPool.store('ov-b', new Float32Array(48000));

      const track = app.timelineModel.addTrack('Track 1', '#3b82f6', 0);

      app.timelineModel.addClip(track.id, {
        id: 'ov-clip-a',
        bufferId: 'ov-a',
        name: 'Overlap A',
        timelineOffset: 0,
        sourceStart: 0,
        sourceEnd: 48000,
        duration: 48000,
        gainDb: 0,
        fadeInSamples: 0,
        fadeOutSamples: 0,
        muted: false,
      });

      app.timelineModel.addClip(track.id, {
        id: 'ov-clip-b',
        bufferId: 'ov-b',
        name: 'Overlap B',
        timelineOffset: 24000,
        sourceStart: 0,
        sourceEnd: 48000,
        duration: 48000,
        gainDb: 0,
        fadeInSamples: 0,
        fadeOutSamples: 0,
        muted: false,
      });

      // Resolve overlap with clip B as the protected (newly placed) clip
      app.timelineModel.resolveOverlaps(track.id, 'ov-clip-b');

      if (app.timelineRenderer) {
        app.timelineRenderer.setTimeline(app.timelineModel.timeline);
        app.timelineRenderer.render();
      }
    });

    // Verify no JavaScript errors occurred during render
    expect(errors).toEqual([]);

    // Canvas should still be visible
    const canvas = page.locator('#timeline-canvas');
    await expect(canvas).toBeVisible();
  });
});
