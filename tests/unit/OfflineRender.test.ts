/**
 * Offline Timeline Render Tests
 *
 * Tests for renderTimelineOffline() — the offline bounce/export function
 * that renders all timeline edits (clips, gain, fades, mute/solo, track volume,
 * track pan) via OfflineAudioContext for export=playback parity.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { BufferPool } from '../../src/core/BufferPool';
import { Timeline, Track, Clip, TrackInsert } from '../../src/core/types';
import { renderTimelineOffline } from '../../src/core/OfflineRender';
import { PluginHost } from '../../src/plugins/PluginHost';

// ==================== Helpers ====================

function makeTimeline(opts: Partial<Timeline> & { tracks?: Track[] } = {}): Timeline {
  return {
    sampleRate: opts.sampleRate ?? 48000,
    totalLength: opts.totalLength ?? 0,
    tracks: opts.tracks ?? [],
    playheadSample: 0,
    selectionStart: null,
    selectionEnd: null,
    selectedClipIds: [],
    selectedTrackIds: [],
    samplesPerPixel: 256,
    scrollOffset: 0,
    ...opts,
  };
}

function makeTrack(id: string, clips: Clip[] = [], overrides: Partial<Track> = {}): Track {
  return {
    id,
    name: `Track ${id}`,
    color: '#3b82f6',
    channels: 1,
    clips,
    volume: 0,
    pan: 0,
    mute: false,
    solo: false,
    channelIndex: 0,
    inserts: [],
    height: 80,
    ...overrides,
  };
}

function makeClip(bufferIdArg: string, overrides: Partial<Clip> = {}): Clip {
  return {
    id: `clip_${Math.random().toString(36).slice(2, 8)}`,
    bufferIds: [bufferIdArg],
    name: 'Test Clip',
    timelineOffset: 0,
    sourceStart: 0,
    sourceEnd: 48000,
    duration: 48000,
    gainDb: 0,
    fadeInSamples: 0,
    fadeOutSamples: 0,
    muted: false,
    ...overrides,
  };
}

/** Create a mono buffer in the pool with constant sample value. */
function addConstBuffer(pool: BufferPool, value: number, length: number, sampleRate = 48000): string {
  const ctx = new AudioContext();
  const buf = ctx.createBuffer(1, length, sampleRate);
  const data = buf.getChannelData(0);
  data.fill(value);
  return pool.addBuffer(buf, 'test.wav', 0);
}

/** Create a mono buffer with a ramp 0..1 over `length` samples. */
function addRampBuffer(pool: BufferPool, length: number, sampleRate = 48000): string {
  const ctx = new AudioContext();
  const buf = ctx.createBuffer(1, length, sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < length; i++) {
    data[i] = i / (length - 1);
  }
  return pool.addBuffer(buf, 'ramp.wav', 0);
}

// ==================== Tests ====================

describe('renderTimelineOffline', () => {
  let pool: BufferPool;

  beforeEach(() => {
    pool = new BufferPool();
  });

  // ---------- Empty timeline ----------

  it('returns empty result for timeline with no tracks', async () => {
    const tl = makeTimeline({ totalLength: 0, tracks: [] });
    const result = await renderTimelineOffline(tl, pool);
    expect(result.channels).toHaveLength(0);
    expect(result.sampleRate).toBe(48000);
    expect(result.duration).toBe(0);
  });

  it('returns empty result for timeline with tracks but no clips', async () => {
    const tl = makeTimeline({ totalLength: 0, tracks: [makeTrack('t1')] });
    const result = await renderTimelineOffline(tl, pool);
    expect(result.channels).toHaveLength(0);
    expect(result.duration).toBe(0);
  });

  // ---------- Single clip, no edits ----------

  it('renders a single clip at timeline position 0 unchanged', async () => {
    const bid = addConstBuffer(pool, 0.5, 100);
    const clip = makeClip(bid, { sourceEnd: 100, duration: 100, timelineOffset: 0 });
    const track = makeTrack('t1', [clip]);
    const tl = makeTimeline({ totalLength: 100, tracks: [track] });

    const result = await renderTimelineOffline(tl, pool);

    expect(result.channels.length).toBeGreaterThanOrEqual(1);
    expect(result.channels[0].length).toBe(100);
    // All samples should be 0.5
    for (let i = 0; i < 100; i++) {
      expect(result.channels[0][i]).toBeCloseTo(0.5, 2);
    }
    expect(result.sampleRate).toBe(48000);
    expect(result.duration).toBe(100);
  });

  // ---------- Clip with timelineOffset ----------

  it('places a clip at the correct timeline offset with silence before', async () => {
    const bid = addConstBuffer(pool, 1.0, 50);
    const clip = makeClip(bid, { sourceEnd: 50, duration: 50, timelineOffset: 100 });
    const track = makeTrack('t1', [clip]);
    const tl = makeTimeline({ totalLength: 150, tracks: [track] });

    const result = await renderTimelineOffline(tl, pool);

    expect(result.channels[0].length).toBe(150);
    // First 100 samples should be silent
    for (let i = 0; i < 100; i++) {
      expect(result.channels[0][i]).toBeCloseTo(0, 2);
    }
    // Next 50 samples should be 1.0
    for (let i = 100; i < 150; i++) {
      expect(result.channels[0][i]).toBeCloseTo(1.0, 2);
    }
  });

  // ---------- Trimmed clip (sourceStart > 0) ----------

  it('respects sourceStart for trimmed clips', async () => {
    const bid = addRampBuffer(pool, 200);
    // Trim: use samples 50..150 (100 samples from the source)
    const clip = makeClip(bid, {
      sourceStart: 50,
      sourceEnd: 150,
      duration: 100,
      timelineOffset: 0,
    });
    const track = makeTrack('t1', [clip]);
    const tl = makeTimeline({ totalLength: 100, tracks: [track] });

    const result = await renderTimelineOffline(tl, pool);

    expect(result.channels[0].length).toBe(100);
    // Sample at output[0] should come from source[50]
    const srcData = pool.getBuffer(bid)!.buffer.getChannelData(0);
    for (let i = 0; i < 100; i++) {
      expect(result.channels[0][i]).toBeCloseTo(srcData[50 + i], 2);
    }
  });

  // ---------- Gain (dB) ----------

  it('applies clip gainDb correctly', async () => {
    const bid = addConstBuffer(pool, 1.0, 100);
    const clip = makeClip(bid, {
      sourceEnd: 100,
      duration: 100,
      timelineOffset: 0,
      gainDb: -6,
    });
    const track = makeTrack('t1', [clip]);
    const tl = makeTimeline({ totalLength: 100, tracks: [track] });

    const result = await renderTimelineOffline(tl, pool);

    const expectedGain = Math.pow(10, -6 / 20);
    for (let i = 0; i < 100; i++) {
      expect(result.channels[0][i]).toBeCloseTo(expectedGain, 2);
    }
  });

  // ---------- Fade In ----------

  it('applies fade-in envelope (linear curve, default)', async () => {
    const bid = addConstBuffer(pool, 1.0, 100);
    const clip = makeClip(bid, {
      sourceEnd: 100,
      duration: 100,
      timelineOffset: 0,
      fadeInSamples: 50,
    });
    const track = makeTrack('t1', [clip]);
    const tl = makeTimeline({ totalLength: 100, tracks: [track] });

    const result = await renderTimelineOffline(tl, pool);

    // First sample should be near 0
    expect(result.channels[0][0]).toBeCloseTo(0, 1);
    // Mid-fade sample 25: linear t=0.5 → gain ≈ 0.5
    expect(result.channels[0][25]).toBeCloseTo(0.5, 1);
    // After fade (sample 50+): full amplitude
    expect(result.channels[0][50]).toBeCloseTo(1.0, 1);
    expect(result.channels[0][99]).toBeCloseTo(1.0, 1);
  });

  it('applies fade-in envelope (sqrt curve, fadeInCurve=1)', async () => {
    const bid = addConstBuffer(pool, 1.0, 100);
    const clip = makeClip(bid, {
      sourceEnd: 100,
      duration: 100,
      timelineOffset: 0,
      fadeInSamples: 50,
      fadeInCurve: 1,
    });
    const track = makeTrack('t1', [clip]);
    const tl = makeTimeline({ totalLength: 100, tracks: [track] });

    const result = await renderTimelineOffline(tl, pool);

    // First sample should be near 0
    expect(result.channels[0][0]).toBeCloseTo(0, 1);
    // Mid-fade sample 25: sqrt(0.5) ≈ 0.707 (fast attack)
    expect(result.channels[0][25]).toBeCloseTo(Math.sqrt(0.5), 1);
    // After fade (sample 50+): full amplitude
    expect(result.channels[0][50]).toBeCloseTo(1.0, 1);
  });

  // ---------- Fade Out ----------

  it('applies fade-out envelope (linear curve, default)', async () => {
    const bid = addConstBuffer(pool, 1.0, 100);
    const clip = makeClip(bid, {
      sourceEnd: 100,
      duration: 100,
      timelineOffset: 0,
      fadeOutSamples: 50,
    });
    const track = makeTrack('t1', [clip]);
    const tl = makeTimeline({ totalLength: 100, tracks: [track] });

    const result = await renderTimelineOffline(tl, pool);

    // Before fade-out (sample 0..49): full amplitude
    expect(result.channels[0][0]).toBeCloseTo(1.0, 1);
    expect(result.channels[0][49]).toBeCloseTo(1.0, 1);
    // Fade-out starts at sample 50
    expect(result.channels[0][50]).toBeCloseTo(1.0, 1);
    // At sample 75: linear t=0.5 → gain ≈ 0.5
    expect(result.channels[0][75]).toBeCloseTo(0.5, 1);
  });

  it('applies fade-out envelope (sqrt curve, fadeOutCurve=1)', async () => {
    const bid = addConstBuffer(pool, 1.0, 100);
    const clip = makeClip(bid, {
      sourceEnd: 100,
      duration: 100,
      timelineOffset: 0,
      fadeOutSamples: 50,
      fadeOutCurve: 1,
    });
    const track = makeTrack('t1', [clip]);
    const tl = makeTimeline({ totalLength: 100, tracks: [track] });

    const result = await renderTimelineOffline(tl, pool);

    // Before fade-out (sample 0..49): full amplitude
    expect(result.channels[0][0]).toBeCloseTo(1.0, 1);
    // At sample 75: sqrt(1 - 25/50) = sqrt(0.5) ≈ 0.707
    expect(result.channels[0][75]).toBeCloseTo(Math.sqrt(0.5), 1);
  });

  // ---------- Combined fade-in + fade-out + gain ----------

  it('applies gain and fades together', async () => {
    const bid = addConstBuffer(pool, 1.0, 100);
    const clip = makeClip(bid, {
      sourceEnd: 100,
      duration: 100,
      timelineOffset: 0,
      gainDb: -6,
      fadeInSamples: 20,
      fadeOutSamples: 20,
    });
    const track = makeTrack('t1', [clip]);
    const tl = makeTimeline({ totalLength: 100, tracks: [track] });

    const result = await renderTimelineOffline(tl, pool);

    const baseGain = Math.pow(10, -6 / 20);
    // Mid-body (no fade): should be baseGain
    expect(result.channels[0][50]).toBeCloseTo(baseGain, 2);
    // Fade-in sample 0: near 0
    expect(result.channels[0][0]).toBeCloseTo(0, 1);
  });

  // ---------- Muted clip ----------

  it('skips muted clips', async () => {
    const bid = addConstBuffer(pool, 1.0, 100);
    const clip = makeClip(bid, {
      sourceEnd: 100,
      duration: 100,
      timelineOffset: 0,
      muted: true,
    });
    const track = makeTrack('t1', [clip]);
    const tl = makeTimeline({ totalLength: 100, tracks: [track] });

    const result = await renderTimelineOffline(tl, pool);

    // All muted — should return empty
    expect(result.channels).toHaveLength(0);
    expect(result.duration).toBe(0);
  });

  // ---------- Muted track ----------

  it('skips muted tracks', async () => {
    const bid = addConstBuffer(pool, 1.0, 100);
    const clip = makeClip(bid, { sourceEnd: 100, duration: 100 });
    const track = makeTrack('t1', [clip], { mute: true });
    const tl = makeTimeline({ totalLength: 100, tracks: [track] });

    const result = await renderTimelineOffline(tl, pool);

    // Muted track — should return empty
    expect(result.channels).toHaveLength(0);
    expect(result.duration).toBe(0);
  });

  // ---------- Solo ----------

  it('respects solo — only solo tracks are rendered', async () => {
    const bid1 = addConstBuffer(pool, 0.5, 100);
    const bid2 = addConstBuffer(pool, 0.3, 100);
    const clip1 = makeClip(bid1, { sourceEnd: 100, duration: 100 });
    const clip2 = makeClip(bid2, { sourceEnd: 100, duration: 100 });
    const track1 = makeTrack('t1', [clip1], { solo: true });
    const track2 = makeTrack('t2', [clip2]);
    const tl = makeTimeline({ totalLength: 100, tracks: [track1, track2] });

    const result = await renderTimelineOffline(tl, pool);

    // Only track1 should contribute
    for (let i = 0; i < 100; i++) {
      expect(result.channels[0][i]).toBeCloseTo(0.5, 2);
    }
  });

  // ---------- Mixing (summing) two tracks ----------

  it('sums audio from multiple tracks', async () => {
    const bid1 = addConstBuffer(pool, 0.3, 100);
    const bid2 = addConstBuffer(pool, 0.2, 100);
    const clip1 = makeClip(bid1, { sourceEnd: 100, duration: 100 });
    const clip2 = makeClip(bid2, { sourceEnd: 100, duration: 100 });
    const track1 = makeTrack('t1', [clip1]);
    const track2 = makeTrack('t2', [clip2]);
    const tl = makeTimeline({ totalLength: 100, tracks: [track1, track2] });

    const result = await renderTimelineOffline(tl, pool);

    for (let i = 0; i < 100; i++) {
      expect(result.channels[0][i]).toBeCloseTo(0.5, 2);
    }
  });

  // ---------- Multi-channel (stereo) output ----------

  it('produces stereo output when a track has a single stereo clip with bufferIds', async () => {
    const bidL = addConstBuffer(pool, 0.4, 100);
    const bidR = addConstBuffer(pool, 0.6, 100);
    // Single stereo clip: bufferIds = [L, R]
    const stereoClip = makeClip(bidL, { sourceEnd: 100, duration: 100, bufferIds: [bidL, bidR] });
    const track = makeTrack('t1', [stereoClip], { channels: 2 });
    const tl = makeTimeline({ totalLength: 100, tracks: [track] });

    const result = await renderTimelineOffline(tl, pool);

    expect(result.channels.length).toBeGreaterThanOrEqual(2);
    for (let i = 0; i < 100; i++) {
      expect(result.channels[0][i]).toBeCloseTo(0.4, 2);
      expect(result.channels[1][i]).toBeCloseTo(0.6, 2);
    }
  });

  // ---------- Overlapping clips on same track sum together ----------

  it('sums overlapping clips on the same track', async () => {
    const bid1 = addConstBuffer(pool, 0.3, 100);
    const bid2 = addConstBuffer(pool, 0.2, 50);
    const clip1 = makeClip(bid1, { sourceEnd: 100, duration: 100, timelineOffset: 0 });
    const clip2 = makeClip(bid2, { sourceEnd: 50, duration: 50, timelineOffset: 25 });
    const track = makeTrack('t1', [clip1, clip2]);
    const tl = makeTimeline({ totalLength: 100, tracks: [track] });

    const result = await renderTimelineOffline(tl, pool);

    // Samples 0-24: only clip1 (0.3)
    for (let i = 0; i < 25; i++) {
      expect(result.channels[0][i]).toBeCloseTo(0.3, 2);
    }
    // Samples 25-74: clip1 + clip2 (0.3 + 0.2 = 0.5)
    for (let i = 25; i < 75; i++) {
      expect(result.channels[0][i]).toBeCloseTo(0.5, 2);
    }
    // Samples 75-99: only clip1 (0.3)
    for (let i = 75; i < 100; i++) {
      expect(result.channels[0][i]).toBeCloseTo(0.3, 2);
    }
  });

  // ---------- Missing buffer gracefully skipped ----------

  it('skips clips with missing buffers without crashing', async () => {
    const clip = makeClip('nonexistent-buffer-id', { sourceEnd: 100, duration: 100 });
    const track = makeTrack('t1', [clip]);
    const tl = makeTimeline({ totalLength: 100, tracks: [track] });

    const result = await renderTimelineOffline(tl, pool);
    // All buffers missing = no audible content
    expect(result.channels).toHaveLength(0);
    expect(result.duration).toBe(0);
  });

  // ---------- Stereo clip on stereo output + mono track ----------

  it('stereo clip on stereo track + mono clip on mono track renders correctly', async () => {
    const bidL = addConstBuffer(pool, 0.4, 100);
    const bidR = addConstBuffer(pool, 0.6, 100);
    // Single stereo clip with bufferIds [L, R]
    const stereoClip = makeClip(bidL, { sourceEnd: 100, duration: 100, bufferIds: [bidL, bidR] });
    const stereoTrack = makeTrack('t1', [stereoClip], { channels: 2 });

    // Also a mono track — should be summed to both channels
    const bidMono = addConstBuffer(pool, 0.1, 100);
    const monoClip = makeClip(bidMono, { sourceEnd: 100, duration: 100 });
    const monoTrack = makeTrack('t2', [monoClip], { channels: 1 });

    const tl = makeTimeline({ totalLength: 100, tracks: [stereoTrack, monoTrack] });

    const result = await renderTimelineOffline(tl, pool);

    expect(result.channels.length).toBeGreaterThanOrEqual(2);
    // Mono 0.1 goes through StereoPannerNode(pan=0): each channel gets 0.1 * cos(π/4) ≈ 0.071
    const panGain = Math.cos(Math.PI / 4); // ≈ 0.707
    for (let i = 0; i < 100; i++) {
      expect(result.channels[0][i]).toBeCloseTo(0.4 + 0.1 * panGain, 1); // ~0.471
      expect(result.channels[1][i]).toBeCloseTo(0.6 + 0.1 * panGain, 1); // ~0.671
    }
  });

  // ---------- Track volume (fader) ----------

  it('applies track volume (fader law)', async () => {
    const bid = addConstBuffer(pool, 1.0, 100);
    const clip = makeClip(bid, { sourceEnd: 100, duration: 100 });
    // track.volume = -6 dB
    const track = makeTrack('t1', [clip], { volume: -6 });
    const tl = makeTimeline({ totalLength: 100, tracks: [track] });

    const result = await renderTimelineOffline(tl, pool);

    const expected = Math.pow(10, -6 / 20); // ~0.501
    for (let i = 0; i < 100; i++) {
      expect(result.channels[0][i]).toBeCloseTo(expected, 1);
    }
  });

  // ---------- Track pan ----------

  it('applies track pan to stereo output', async () => {
    const bid = addConstBuffer(pool, 1.0, 100);
    const clip = makeClip(bid, { sourceEnd: 100, duration: 100 });
    // Mono track, pan hard right → forces stereo output
    const track = makeTrack('t1', [clip], { pan: 1 });
    const tl = makeTimeline({ totalLength: 100, tracks: [track] });

    const result = await renderTimelineOffline(tl, pool);

    expect(result.channels.length).toBeGreaterThanOrEqual(2);
    // Hard right pan: left channel should be near-silent, right should have signal
    const leftRms = Math.sqrt(result.channels[0].reduce((s, v) => s + v * v, 0) / 100);
    const rightRms = Math.sqrt(result.channels[1].reduce((s, v) => s + v * v, 0) / 100);
    expect(leftRms).toBeLessThan(0.1);
    expect(rightRms).toBeGreaterThan(0.5);
  });

  // ---------- Plugin inserts ----------

  it('applies a Gain plugin insert to exported audio', async () => {
    const bid = addConstBuffer(pool, 1.0, 100);
    const clip = makeClip(bid, { sourceEnd: 100, duration: 100 });

    // Create a real PluginHost on the AudioContext to set up the plugin
    const ctx = new AudioContext();
    const pluginHost = new PluginHost(ctx);
    const gainPlugin = await pluginHost.createInstance(
      pluginHost.getAvailablePlugins().find(p => p.id === 'builtin:gain')!,
    );
    // Set gain to -6 dB
    pluginHost.setParameter(gainPlugin.id, 0, -6);

    const insert: TrackInsert = {
      instanceId: gainPlugin.id,
      pluginId: 'builtin:gain',
      parameters: gainPlugin.parameters,
      bypassed: false,
    };
    const track = makeTrack('t1', [clip], { inserts: [insert] });
    const tl = makeTimeline({ totalLength: 100, tracks: [track] });

    const result = await renderTimelineOffline(tl, pool, pluginHost);

    // The offline render creates a SEPARATE plugin instance on the OfflineAudioContext
    // and copies params from TrackInsert.parameters. Gain -6 dB → linear ≈ 0.501
    const expectedGain = Math.pow(10, -6 / 20);
    for (let i = 0; i < 100; i++) {
      expect(result.channels[0][i]).toBeCloseTo(expectedGain, 1);
    }
  });

  it('does not apply bypassed plugin inserts', async () => {
    const bid = addConstBuffer(pool, 1.0, 100);
    const clip = makeClip(bid, { sourceEnd: 100, duration: 100 });

    const ctx = new AudioContext();
    const pluginHost = new PluginHost(ctx);
    const gainPlugin = await pluginHost.createInstance(
      pluginHost.getAvailablePlugins().find(p => p.id === 'builtin:gain')!,
    );
    pluginHost.setParameter(gainPlugin.id, 0, -12); // -12 dB

    const insert: TrackInsert = {
      instanceId: gainPlugin.id,
      pluginId: 'builtin:gain',
      parameters: gainPlugin.parameters,
      bypassed: true, // Bypassed!
    };
    const track = makeTrack('t1', [clip], { inserts: [insert] });
    const tl = makeTimeline({ totalLength: 100, tracks: [track] });

    const result = await renderTimelineOffline(tl, pool, pluginHost);

    // Bypassed → gain plugin not applied → output should be 1.0
    for (let i = 0; i < 100; i++) {
      expect(result.channels[0][i]).toBeCloseTo(1.0, 2);
    }
  });

  it('renders correctly without pluginHost (backward compat)', async () => {
    const bid = addConstBuffer(pool, 0.5, 100);
    const clip = makeClip(bid, { sourceEnd: 100, duration: 100 });

    // Track has inserts defined but no pluginHost passed → inserts ignored
    const insert: TrackInsert = {
      instanceId: 'some_id',
      pluginId: 'builtin:gain',
      parameters: [{ id: 0, name: 'Gain', value: -12, min: -60, max: 24, defaultValue: 0 }],
      bypassed: false,
    };
    const track = makeTrack('t1', [clip], { inserts: [insert] });
    const tl = makeTimeline({ totalLength: 100, tracks: [track] });

    const result = await renderTimelineOffline(tl, pool);

    // No pluginHost → inserts not applied → output = 0.5
    for (let i = 0; i < 100; i++) {
      expect(result.channels[0][i]).toBeCloseTo(0.5, 2);
    }
  });

  it('applies Compressor plugin without crashing', async () => {
    const bid = addConstBuffer(pool, 0.8, 100);
    const clip = makeClip(bid, { sourceEnd: 100, duration: 100 });

    const ctx = new AudioContext();
    const pluginHost = new PluginHost(ctx);
    const compPlugin = await pluginHost.createInstance(
      pluginHost.getAvailablePlugins().find(p => p.id === 'builtin:compressor')!,
    );

    const insert: TrackInsert = {
      instanceId: compPlugin.id,
      pluginId: 'builtin:compressor',
      parameters: compPlugin.parameters,
      bypassed: false,
    };
    const track = makeTrack('t1', [clip], { inserts: [insert] });
    const tl = makeTimeline({ totalLength: 100, tracks: [track] });

    // Should not throw — compressor is wired but mock doesn't simulate compression
    const result = await renderTimelineOffline(tl, pool, pluginHost);
    expect(result.channels.length).toBeGreaterThanOrEqual(1);
    expect(result.duration).toBe(100);
  });
});
