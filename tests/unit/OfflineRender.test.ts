/**
 * Offline Timeline Render Tests
 *
 * Tests for renderTimelineOffline() — the offline bounce/export function
 * that renders all timeline edits (clips, gain, fades, mute/solo) into
 * interleaved Float32Array channels.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { BufferPool } from '../../src/core/BufferPool';
import { Timeline, Track, Clip } from '../../src/core/types';
import { renderTimelineOffline, OfflineRenderResult } from '../../src/core/OfflineRender';

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

function makeClip(bufferId: string, overrides: Partial<Clip> = {}): Clip {
  return {
    id: `clip_${Math.random().toString(36).slice(2, 8)}`,
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

  it('returns empty result for timeline with no tracks', () => {
    const tl = makeTimeline({ totalLength: 0, tracks: [] });
    const result = renderTimelineOffline(tl, pool);
    expect(result.channels).toHaveLength(0);
    expect(result.sampleRate).toBe(48000);
    expect(result.duration).toBe(0);
  });

  it('returns empty result for timeline with tracks but no clips', () => {
    const tl = makeTimeline({ totalLength: 0, tracks: [makeTrack('t1')] });
    const result = renderTimelineOffline(tl, pool);
    expect(result.channels).toHaveLength(0);
    expect(result.duration).toBe(0);
  });

  // ---------- Single clip, no edits ----------

  it('renders a single clip at timeline position 0 unchanged', () => {
    const bid = addConstBuffer(pool, 0.5, 100);
    const clip = makeClip(bid, { sourceEnd: 100, duration: 100, timelineOffset: 0 });
    const track = makeTrack('t1', [clip]);
    const tl = makeTimeline({ totalLength: 100, tracks: [track] });

    const result = renderTimelineOffline(tl, pool);

    expect(result.channels).toHaveLength(1);
    expect(result.channels[0].length).toBe(100);
    // All samples should be 0.5
    for (let i = 0; i < 100; i++) {
      expect(result.channels[0][i]).toBeCloseTo(0.5, 5);
    }
    expect(result.sampleRate).toBe(48000);
    expect(result.duration).toBe(100);
  });

  // ---------- Clip with timelineOffset ----------

  it('places a clip at the correct timeline offset with silence before', () => {
    const bid = addConstBuffer(pool, 1.0, 50);
    const clip = makeClip(bid, { sourceEnd: 50, duration: 50, timelineOffset: 100 });
    const track = makeTrack('t1', [clip]);
    const tl = makeTimeline({ totalLength: 150, tracks: [track] });

    const result = renderTimelineOffline(tl, pool);

    expect(result.channels[0].length).toBe(150);
    // First 100 samples should be silent
    for (let i = 0; i < 100; i++) {
      expect(result.channels[0][i]).toBeCloseTo(0, 5);
    }
    // Next 50 samples should be 1.0
    for (let i = 100; i < 150; i++) {
      expect(result.channels[0][i]).toBeCloseTo(1.0, 5);
    }
  });

  // ---------- Trimmed clip (sourceStart > 0) ----------

  it('respects sourceStart for trimmed clips', () => {
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

    const result = renderTimelineOffline(tl, pool);

    expect(result.channels[0].length).toBe(100);
    // Sample at output[0] should come from source[50]
    const srcData = pool.getBuffer(bid)!.buffer.getChannelData(0);
    for (let i = 0; i < 100; i++) {
      expect(result.channels[0][i]).toBeCloseTo(srcData[50 + i], 5);
    }
  });

  // ---------- Gain (dB) ----------

  it('applies clip gainDb correctly', () => {
    const bid = addConstBuffer(pool, 1.0, 100);
    const clip = makeClip(bid, {
      sourceEnd: 100,
      duration: 100,
      timelineOffset: 0,
      gainDb: -6,
    });
    const track = makeTrack('t1', [clip]);
    const tl = makeTimeline({ totalLength: 100, tracks: [track] });

    const result = renderTimelineOffline(tl, pool);

    const expectedGain = Math.pow(10, -6 / 20);
    for (let i = 0; i < 100; i++) {
      expect(result.channels[0][i]).toBeCloseTo(expectedGain, 4);
    }
  });

  // ---------- Fade In ----------

  it('applies fade-in envelope (sqrt curve)', () => {
    const bid = addConstBuffer(pool, 1.0, 100);
    const clip = makeClip(bid, {
      sourceEnd: 100,
      duration: 100,
      timelineOffset: 0,
      fadeInSamples: 50,
    });
    const track = makeTrack('t1', [clip]);
    const tl = makeTimeline({ totalLength: 100, tracks: [track] });

    const result = renderTimelineOffline(tl, pool);

    // First sample should be 0 (sqrt(0) = 0)
    expect(result.channels[0][0]).toBeCloseTo(0, 5);
    // Mid-fade sample 25: sqrt(25/50) = sqrt(0.5) ≈ 0.707
    expect(result.channels[0][25]).toBeCloseTo(Math.sqrt(0.5), 3);
    // Last fade sample 49: sqrt(49/50) ≈ 0.9899
    expect(result.channels[0][49]).toBeCloseTo(Math.sqrt(49 / 50), 3);
    // After fade (sample 50): full amplitude
    expect(result.channels[0][50]).toBeCloseTo(1.0, 5);
    expect(result.channels[0][99]).toBeCloseTo(1.0, 5);
  });

  // ---------- Fade Out ----------

  it('applies fade-out envelope (sqrt curve)', () => {
    const bid = addConstBuffer(pool, 1.0, 100);
    const clip = makeClip(bid, {
      sourceEnd: 100,
      duration: 100,
      timelineOffset: 0,
      fadeOutSamples: 50,
    });
    const track = makeTrack('t1', [clip]);
    const tl = makeTimeline({ totalLength: 100, tracks: [track] });

    const result = renderTimelineOffline(tl, pool);

    // Before fade-out (sample 0..49): full amplitude
    expect(result.channels[0][0]).toBeCloseTo(1.0, 5);
    expect(result.channels[0][49]).toBeCloseTo(1.0, 5);
    // Fade-out starts at sample 50 (duration - fadeOutSamples = 100 - 50 = 50)
    // At sample 50: sqrt(1 - 0/50) = 1.0
    expect(result.channels[0][50]).toBeCloseTo(1.0, 5);
    // At sample 75: sqrt(1 - 25/50) = sqrt(0.5) ≈ 0.707
    expect(result.channels[0][75]).toBeCloseTo(Math.sqrt(0.5), 3);
    // Last sample (99): sqrt(1 - 49/50) = sqrt(0.02) ≈ 0.141
    expect(result.channels[0][99]).toBeCloseTo(Math.sqrt(1 - 49 / 50), 3);
  });

  // ---------- Combined fade-in + fade-out + gain ----------

  it('applies gain and fades together', () => {
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

    const result = renderTimelineOffline(tl, pool);

    const baseGain = Math.pow(10, -6 / 20);
    // Mid-body (no fade): should be baseGain
    expect(result.channels[0][50]).toBeCloseTo(baseGain, 4);
    // Fade-in sample 0: 0
    expect(result.channels[0][0]).toBeCloseTo(0, 5);
    // Fade-in sample 10: sqrt(10/20) * baseGain
    expect(result.channels[0][10]).toBeCloseTo(Math.sqrt(0.5) * baseGain, 3);
  });

  // ---------- Muted clip ----------

  it('skips muted clips', () => {
    const bid = addConstBuffer(pool, 1.0, 100);
    const clip = makeClip(bid, {
      sourceEnd: 100,
      duration: 100,
      timelineOffset: 0,
      muted: true,
    });
    const track = makeTrack('t1', [clip]);
    const tl = makeTimeline({ totalLength: 100, tracks: [track] });

    const result = renderTimelineOffline(tl, pool);

    // Output should still be 100 samples long but silent
    // Actually, with all clips muted, total audible length is 0
    // The function should still produce output based on totalLength
    for (let i = 0; i < (result.channels[0]?.length ?? 0); i++) {
      expect(result.channels[0][i]).toBeCloseTo(0, 5);
    }
  });

  // ---------- Muted track ----------

  it('skips muted tracks', () => {
    const bid = addConstBuffer(pool, 1.0, 100);
    const clip = makeClip(bid, { sourceEnd: 100, duration: 100 });
    const track = makeTrack('t1', [clip], { mute: true });
    const tl = makeTimeline({ totalLength: 100, tracks: [track] });

    const result = renderTimelineOffline(tl, pool);

    for (let i = 0; i < (result.channels[0]?.length ?? 0); i++) {
      expect(result.channels[0][i]).toBeCloseTo(0, 5);
    }
  });

  // ---------- Solo ----------

  it('respects solo — only solo tracks are rendered', () => {
    const bid1 = addConstBuffer(pool, 0.5, 100);
    const bid2 = addConstBuffer(pool, 0.3, 100);
    const clip1 = makeClip(bid1, { sourceEnd: 100, duration: 100 });
    const clip2 = makeClip(bid2, { sourceEnd: 100, duration: 100 });
    const track1 = makeTrack('t1', [clip1], { solo: true });
    const track2 = makeTrack('t2', [clip2]);
    const tl = makeTimeline({ totalLength: 100, tracks: [track1, track2] });

    const result = renderTimelineOffline(tl, pool);

    // Only track1 should contribute
    for (let i = 0; i < 100; i++) {
      expect(result.channels[0][i]).toBeCloseTo(0.5, 5);
    }
  });

  // ---------- Mixing (summing) two tracks ----------

  it('sums audio from multiple tracks', () => {
    const bid1 = addConstBuffer(pool, 0.3, 100);
    const bid2 = addConstBuffer(pool, 0.2, 100);
    const clip1 = makeClip(bid1, { sourceEnd: 100, duration: 100 });
    const clip2 = makeClip(bid2, { sourceEnd: 100, duration: 100 });
    const track1 = makeTrack('t1', [clip1]);
    const track2 = makeTrack('t2', [clip2]);
    const tl = makeTimeline({ totalLength: 100, tracks: [track1, track2] });

    const result = renderTimelineOffline(tl, pool);

    for (let i = 0; i < 100; i++) {
      expect(result.channels[0][i]).toBeCloseTo(0.5, 5);
    }
  });

  // ---------- Multi-channel (stereo) output ----------

  it('produces stereo output when a track has 2 channels via subChannel clips', () => {
    const bidL = addConstBuffer(pool, 0.4, 100);
    const bidR = addConstBuffer(pool, 0.6, 100);
    const clipL = makeClip(bidL, { sourceEnd: 100, duration: 100, subChannel: 0 });
    const clipR = makeClip(bidR, { sourceEnd: 100, duration: 100, subChannel: 1 });
    const track = makeTrack('t1', [clipL, clipR], { channels: 2 });
    const tl = makeTimeline({ totalLength: 100, tracks: [track] });

    const result = renderTimelineOffline(tl, pool);

    expect(result.channels).toHaveLength(2);
    for (let i = 0; i < 100; i++) {
      expect(result.channels[0][i]).toBeCloseTo(0.4, 5);
      expect(result.channels[1][i]).toBeCloseTo(0.6, 5);
    }
  });

  // ---------- Overlapping clips on same track sum together ----------

  it('sums overlapping clips on the same track', () => {
    const bid1 = addConstBuffer(pool, 0.3, 100);
    const bid2 = addConstBuffer(pool, 0.2, 50);
    const clip1 = makeClip(bid1, { sourceEnd: 100, duration: 100, timelineOffset: 0 });
    const clip2 = makeClip(bid2, { sourceEnd: 50, duration: 50, timelineOffset: 25 });
    const track = makeTrack('t1', [clip1, clip2]);
    const tl = makeTimeline({ totalLength: 100, tracks: [track] });

    const result = renderTimelineOffline(tl, pool);

    // Samples 0-24: only clip1 (0.3)
    for (let i = 0; i < 25; i++) {
      expect(result.channels[0][i]).toBeCloseTo(0.3, 5);
    }
    // Samples 25-74: clip1 + clip2 (0.3 + 0.2 = 0.5)
    for (let i = 25; i < 75; i++) {
      expect(result.channels[0][i]).toBeCloseTo(0.5, 5);
    }
    // Samples 75-99: only clip1 (0.3)
    for (let i = 75; i < 100; i++) {
      expect(result.channels[0][i]).toBeCloseTo(0.3, 5);
    }
  });

  // ---------- Missing buffer gracefully skipped ----------

  it('skips clips with missing buffers without crashing', () => {
    const clip = makeClip('nonexistent-buffer-id', { sourceEnd: 100, duration: 100 });
    const track = makeTrack('t1', [clip]);
    const tl = makeTimeline({ totalLength: 100, tracks: [track] });

    expect(() => renderTimelineOffline(tl, pool)).not.toThrow();
    const result = renderTimelineOffline(tl, pool);
    // Should produce silent output
    for (let i = 0; i < (result.channels[0]?.length ?? 0); i++) {
      expect(result.channels[0][i]).toBeCloseTo(0, 5);
    }
  });

  // ---------- Mono clips on stereo output (no subChannel) ----------

  it('maps mono clips without subChannel to all output channels', () => {
    const bidL = addConstBuffer(pool, 0.4, 100);
    const bidR = addConstBuffer(pool, 0.6, 100);
    // Track with 2 channels: one clip has subChannel 0, other has subChannel 1
    const clipL = makeClip(bidL, { sourceEnd: 100, duration: 100, subChannel: 0 });
    const clipR = makeClip(bidR, { sourceEnd: 100, duration: 100, subChannel: 1 });
    const stereoTrack = makeTrack('t1', [clipL, clipR], { channels: 2 });

    // Also a mono track without subChannel — should be summed to both channels
    const bidMono = addConstBuffer(pool, 0.1, 100);
    const monoClip = makeClip(bidMono, { sourceEnd: 100, duration: 100 });
    const monoTrack = makeTrack('t2', [monoClip], { channels: 1 });

    const tl = makeTimeline({ totalLength: 100, tracks: [stereoTrack, monoTrack] });

    const result = renderTimelineOffline(tl, pool);

    expect(result.channels).toHaveLength(2);
    for (let i = 0; i < 100; i++) {
      expect(result.channels[0][i]).toBeCloseTo(0.5, 5); // 0.4 + 0.1
      expect(result.channels[1][i]).toBeCloseTo(0.7, 5); // 0.6 + 0.1
    }
  });
});
