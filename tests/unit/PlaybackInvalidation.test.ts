import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AudioEngine } from '../../src/core/AudioEngine';
import { BufferPool } from '../../src/core/BufferPool';
import { setMockCurrentTime } from '../setup';
import { Timeline, Track, Clip } from '../../src/core/types';

// ==================== Helpers ====================

function makeTimeline(tracks: Track[] = [], sampleRate = 44100): Timeline {
  return {
    sampleRate,
    totalLength: sampleRate * 10,
    tracks,
    playheadSample: 0,
    selectionStart: null,
    selectionEnd: null,
    selectedClipIds: [],
    selectedTrackIds: [],
    samplesPerPixel: 441,
    scrollOffset: 0,
  };
}

function makeTrack(id: string, clips: Clip[] = []): Track {
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
  };
}

function makeClip(bufferIdArg: string, overrides: Partial<Clip> = {}): Clip {
  return {
    id: `clip_${Math.random().toString(36).slice(2, 8)}`,
    bufferIds: [bufferIdArg],
    name: 'Test Clip',
    timelineOffset: 0,
    sourceStart: 0,
    sourceEnd: 44100 * 5,
    duration: 44100 * 5,
    gainDb: 0,
    fadeInSamples: 0,
    fadeOutSamples: 0,
    muted: false,
    ...overrides,
  };
}

// ==================== Tests ====================

describe('AudioEngine — getPlaybackPositionSamples()', () => {
  let engine: AudioEngine;

  beforeEach(async () => {
    engine = new AudioEngine();
    await engine.init();
  });

  it('returns 0 when stopped', () => {
    const result = engine.getPlaybackPositionSamples(44100);
    expect(result).toBe(0);
  });

  it('returns pauseTime * sampleRate when paused', () => {
    // Set pauseTime directly to simulate paused state
    engine.isPaused = true;
    engine.pauseTime = 2.5;

    const result = engine.getPlaybackPositionSamples(44100);
    expect(result).toBe(Math.floor(2.5 * 44100));
  });

  it('returns audioContext.currentTime - startTime * sampleRate when playing', () => {
    engine.isPlaying = true;
    engine.startTime = 1.0; // started 1 second ago in context time

    // mock context time is 3.0, so elapsed = 2.0 seconds
    setMockCurrentTime(3.0);
    // Re-create AudioContext so it picks up the new mock time
    // Instead we can manipulate the audioContext.currentTime directly
    (engine.audioContext as any).currentTime = 3.0;

    const result = engine.getPlaybackPositionSamples(44100);
    // elapsed = 3.0 - 1.0 = 2.0 seconds
    expect(result).toBe(Math.floor(2.0 * 44100));
  });

  it('uses integer floor for sample position', () => {
    engine.isPaused = true;
    engine.pauseTime = 1.00001; // fractional seconds

    const result = engine.getPlaybackPositionSamples(44100);
    expect(result).toBe(Math.floor(1.00001 * 44100));
    expect(Number.isInteger(result)).toBe(true);
  });
});

describe('invalidatePlayback()', () => {
  let engine: AudioEngine;
  let bufferPool: BufferPool;
  let timeline: Timeline;

  /**
   * Minimal test harness that simulates the App.invalidatePlayback() behaviour
   * so we can test the logic without constructing the full App class.
   */
  function invalidatePlayback(
    eng: AudioEngine,
    tl: Timeline,
    pool: BufferPool,
  ): void {
    if (!eng.isPlaying && !eng.isPaused) return;
    const sr = tl.sampleRate;
    const currentSample = eng.getPlaybackPositionSamples(sr);
    const wasPlaying = eng.isPlaying;
    eng.stopTimeline();
    if (wasPlaying) {
      eng.playTimeline(tl, pool, currentSample);
    }
  }

  beforeEach(async () => {
    engine = new AudioEngine();
    await engine.init();

    bufferPool = new BufferPool();
    const mockBuffer = engine.audioContext!.createBuffer(1, 44100 * 5, 44100);
    const bufferId = bufferPool.addBuffer(mockBuffer as any, 'test.wav', 0);

    const clip = makeClip(bufferId, { duration: 44100 * 5 });
    const track = makeTrack('t1', [clip]);
    timeline = makeTimeline([track]);
    engine.setupTrackRouting([track]);
  });

  it('when playing — stops and restarts from same position', () => {
    // Start playback
    engine.playTimeline(timeline, bufferPool, 0);
    expect(engine.isPlaying).toBe(true);

    // Simulate some time has elapsed (1 second into playback)
    const contextTime = 1.0;
    (engine.audioContext as any).currentTime = contextTime;
    // startTime was set when playback began (at context time ≈ 0)
    // getCurrentTime() = contextTime - startTime ≈ 1.0
    engine.startTime = 0;

    const oldSources = [...engine.scheduledSources];

    // Spy on stopTimeline and playTimeline
    const stopSpy = vi.spyOn(engine, 'stopTimeline');
    const playSpy = vi.spyOn(engine, 'playTimeline');

    invalidatePlayback(engine, timeline, bufferPool);

    // stopTimeline may fire more than once (playTimeline also calls it internally)
    expect(stopSpy).toHaveBeenCalled();
    expect(playSpy).toHaveBeenCalledOnce();
    expect(engine.isPlaying).toBe(true);

    // Should restart from approximately the same sample position (within 1 sample tolerance)
    const callArgs = playSpy.mock.calls[0];
    const startSampleArg = callArgs[2] as number;
    expect(startSampleArg).toBeGreaterThanOrEqual(Math.floor(1.0 * 44100) - 1);
    expect(startSampleArg).toBeLessThanOrEqual(Math.floor(1.0 * 44100) + 1);
  });

  it('when paused — stays paused (does not restart)', () => {
    // Start playback then pause
    engine.playTimeline(timeline, bufferPool, 0);
    engine.pause();
    expect(engine.isPaused).toBe(true);
    expect(engine.isPlaying).toBe(false);

    const stopSpy = vi.spyOn(engine, 'stopTimeline');
    const playSpy = vi.spyOn(engine, 'playTimeline');

    invalidatePlayback(engine, timeline, bufferPool);

    // Should call stopTimeline but NOT playTimeline (wasPlaying was false)
    expect(stopSpy).toHaveBeenCalledOnce();
    expect(playSpy).not.toHaveBeenCalled();
    // State should remain stopped (stopTimeline sets isPlaying=false, isPaused=false)
    expect(engine.isPlaying).toBe(false);
  });

  it('when stopped — no-op (does not touch engine)', () => {
    expect(engine.isPlaying).toBe(false);
    expect(engine.isPaused).toBe(false);

    const stopSpy = vi.spyOn(engine, 'stopTimeline');
    const playSpy = vi.spyOn(engine, 'playTimeline');

    invalidatePlayback(engine, timeline, bufferPool);

    expect(stopSpy).not.toHaveBeenCalled();
    expect(playSpy).not.toHaveBeenCalled();
    expect(engine.isPlaying).toBe(false);
  });

  it('preserves approximate playback position when restarting', () => {
    // Play from sample 22050 (0.5 seconds in)
    engine.playTimeline(timeline, bufferPool, 22050);
    expect(engine.isPlaying).toBe(true);

    // Simulate 1 more second has elapsed (total ~1.5 seconds = 66150 samples)
    (engine.audioContext as any).currentTime = 1.5;
    engine.startTime = 0.5; // context started at 0.5 offset so elapsed = 1.5 - 0.5 = 1.0s

    const playSpy = vi.spyOn(engine, 'playTimeline');

    invalidatePlayback(engine, timeline, bufferPool);

    expect(playSpy).toHaveBeenCalledOnce();
    const startSampleArg = playSpy.mock.calls[0][2] as number;

    // elapsed = 1.5 - 0.5 = 1.0 seconds = 44100 samples
    const expectedSample = Math.floor(1.0 * 44100);
    expect(startSampleArg).toBeGreaterThanOrEqual(expectedSample - 1);
    expect(startSampleArg).toBeLessThanOrEqual(expectedSample + 1);
  });
});
