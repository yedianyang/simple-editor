import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AudioEngine } from '../../src/core/AudioEngine';
import { BufferPool } from '../../src/core/BufferPool';
import { Timeline, Track, Clip } from '../../src/core/types';

// Helper: create a minimal Timeline with one track and one clip
function makeTimeline(opts: {
  sampleRate?: number;
  tracks?: Track[];
} = {}): Timeline {
  return {
    sampleRate: opts.sampleRate ?? 44100,
    totalLength: 44100 * 10,
    tracks: opts.tracks ?? [],
    playheadSample: 0,
    selectionStart: null,
    selectionEnd: null,
    selectedClipIds: [],
    selectedTrackIds: [],
    samplesPerPixel: 441,
    scrollOffset: 0,
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
    sourceEnd: 44100,
    duration: 44100,
    gainDb: 0,
    fadeInSamples: 0,
    fadeOutSamples: 0,
    muted: false,
    ...overrides,
  };
}

describe('AudioEngine — Playback & Transport', () => {
  let engine: AudioEngine;

  beforeEach(async () => {
    engine = new AudioEngine();
    await engine.init();
  });

  // ==================== Initialization ====================

  describe('Initialization', () => {
    it('constructor sets isPlaying=false, isPaused=false', () => {
      const fresh = new AudioEngine();
      expect(fresh.isPlaying).toBe(false);
      expect(fresh.isPaused).toBe(false);
    });

    it('init() creates AudioContext and master gain chain', async () => {
      expect(engine.audioContext).toBeDefined();
      expect(engine.masterGainNode).toBeDefined();
      expect(engine.analyserNode).toBeDefined();
    });

    it('init() resumes suspended context', async () => {
      expect(engine.audioContext!.state).toBe('running');
    });
  });

  // ==================== 3.1 Timeline Playback End Detection ====================

  describe('3.1 Timeline Playback End Detection', () => {
    let bufferPool: BufferPool;
    let bufferId: string;

    beforeEach(() => {
      bufferPool = new BufferPool();
      // Create a mock mono buffer in the pool
      const mockBuffer = engine.audioContext!.createBuffer(1, 44100, 44100);
      bufferId = bufferPool.addBuffer(mockBuffer as any, 'test.wav', 0);
    });

    it('3.1.1 - transport keeps rolling after all sources finish (isPlaying stays true)', () => {
      const onEnd = vi.fn();
      engine.onPlaybackEnd = onEnd;

      const clip = makeClip(bufferId, { duration: 44100 });
      const track = makeTrack('t1', [clip]);
      const timeline = makeTimeline({ tracks: [track] });
      engine.setupTrackRouting([track]);
      engine.playTimeline(timeline, bufferPool);

      expect(engine.isPlaying).toBe(true);

      // Simulate all sources ending by calling onended on each scheduled source
      for (const source of engine.scheduledSources) {
        if (source.onended) {
          (source.onended as unknown as () => void)();
        }
      }

      // Transport should keep rolling — isPlaying stays true
      expect(engine.isPlaying).toBe(true);
      // onPlaybackEnd should NOT be called when sources end
      expect(onEnd).not.toHaveBeenCalled();
    });

    it('3.1.2 - only stop() or stopTimeline() stops transport', () => {
      const clip = makeClip(bufferId, { duration: 4410 }); // ~100ms
      const track = makeTrack('t1', [clip]);
      const timeline = makeTimeline({ tracks: [track] });
      engine.setupTrackRouting([track]);

      // Play — sources end but transport keeps rolling
      engine.playTimeline(timeline, bufferPool);
      expect(engine.isPlaying).toBe(true);
      for (const source of engine.scheduledSources) {
        if (source.onended) {
          (source.onended as unknown as () => void)();
        }
      }
      expect(engine.isPlaying).toBe(true);

      // Only explicit stop stops the transport
      engine.stopTimeline();
      expect(engine.isPlaying).toBe(false);
    });

    it('3.1.3 - stop during playback then play restarts cleanly', () => {
      const clip = makeClip(bufferId, { duration: 44100 });
      const track = makeTrack('t1', [clip]);
      const timeline = makeTimeline({ tracks: [track] });
      engine.setupTrackRouting([track]);

      engine.playTimeline(timeline, bufferPool);
      expect(engine.isPlaying).toBe(true);

      // Stop mid-playback
      engine.stopTimeline();
      expect(engine.isPlaying).toBe(false);
      expect(engine.scheduledSources).toHaveLength(0);

      // Play again
      engine.playTimeline(timeline, bufferPool);
      expect(engine.isPlaying).toBe(true);
      expect(engine.scheduledSources.length).toBeGreaterThan(0);
    });
  });

  // ==================== 3.2 Timeline Pause/Resume Behavior ====================

  describe('3.2 Timeline Pause/Resume Behavior', () => {
    let bufferPool: BufferPool;

    beforeEach(() => {
      bufferPool = new BufferPool();
      const mockBuffer = engine.audioContext!.createBuffer(1, 44100 * 5, 44100);
      const bufferId = bufferPool.addBuffer(mockBuffer as any, 'test.wav', 0);
      const clip = makeClip(bufferId, { duration: 44100 * 5 });
      const track = makeTrack('t1', [clip]);
      engine.setupTrackRouting([track]);
      const timeline = makeTimeline({ tracks: [track] });
      engine.playTimeline(timeline, bufferPool);
    });

    it('3.2.1 - pause sets isPaused=true, clears scheduledSources', () => {
      expect(engine.isPlaying).toBe(true);

      engine.pause();

      expect(engine.isPaused).toBe(true);
      expect(engine.isPlaying).toBe(false);
      expect(engine.scheduledSources).toHaveLength(0);
    });

    it('3.2.2 - pause then stop resets to initial state', () => {
      engine.pause();
      engine.stop();

      expect(engine.isPlaying).toBe(false);
      expect(engine.isPaused).toBe(false);
      expect(engine.pauseTime).toBe(0);
    });
  });

  // ==================== Transport State Machine ====================

  describe('Transport State Machine', () => {
    let bufferPool: BufferPool;
    let timeline: ReturnType<typeof makeTimeline>;

    beforeEach(() => {
      bufferPool = new BufferPool();
      const mockBuffer = engine.audioContext!.createBuffer(1, 44100 * 3, 44100);
      const bufferId = bufferPool.addBuffer(mockBuffer as any, 'test.wav', 0);
      const clip = makeClip(bufferId, { duration: 44100 * 3 });
      const track = makeTrack('t1', [clip]);
      engine.setupTrackRouting([track]);
      timeline = makeTimeline({ tracks: [track] });
    });

    it('playTimeline() sets isPlaying=true, isPaused=false', () => {
      engine.playTimeline(timeline, bufferPool);
      expect(engine.isPlaying).toBe(true);
      expect(engine.isPaused).toBe(false);
    });

    it('pause() sets isPlaying=false, isPaused=true, saves pauseTime', () => {
      engine.playTimeline(timeline, bufferPool);
      engine.pause();
      expect(engine.isPlaying).toBe(false);
      expect(engine.isPaused).toBe(true);
      expect(engine.pauseTime).toBeGreaterThanOrEqual(0);
    });

    it('pause() clears all scheduledSources', () => {
      engine.playTimeline(timeline, bufferPool);
      expect(engine.scheduledSources.length).toBeGreaterThan(0);

      engine.pause();
      expect(engine.scheduledSources).toHaveLength(0);
    });

    it('stop() resets isPlaying, isPaused, pauseTime to initial', () => {
      engine.playTimeline(timeline, bufferPool);
      engine.pause();
      engine.stop();

      expect(engine.isPlaying).toBe(false);
      expect(engine.isPaused).toBe(false);
      expect(engine.pauseTime).toBe(0);
    });

    it('stopTimeline() resets isPlaying and clears scheduledSources', () => {
      engine.playTimeline(timeline, bufferPool);
      engine.stopTimeline();

      expect(engine.isPlaying).toBe(false);
      expect(engine.scheduledSources).toHaveLength(0);
    });
  });

  // ==================== Looping ====================

  describe('Looping', () => {
    it('setLooping(true)/isLooping() round-trips', () => {
      expect(engine.isLooping()).toBe(false);
      engine.setLooping(true);
      expect(engine.isLooping()).toBe(true);
      engine.setLooping(false);
      expect(engine.isLooping()).toBe(false);
    });
  });

  // ==================== Volume ====================

  describe('Volume', () => {
    it('setMasterVolume sets gain node value in dB', () => {
      engine.setMasterVolume(-6);
      const expected = Math.pow(10, -6 / 20);
      expect(engine.masterGainNode!.gain.value).toBeCloseTo(expected, 4);
    });

    it('getMasterVolume returns stored dB value', () => {
      engine.setMasterVolume(-12);
      expect(engine.getMasterVolume()).toBeCloseTo(-12, 1);
    });

    it('setMasterVolume(0) sets gain to 1.0 (unity)', () => {
      engine.setMasterVolume(0);
      expect(engine.masterGainNode!.gain.value).toBeCloseTo(1.0, 4);
    });
  });

  // ==================== Track Routing ====================

  describe('Track Routing', () => {
    it('setupTrackRouting creates per-track gain chain', () => {
      const tracks: Track[] = [
        makeTrack('t1'),
        makeTrack('t2'),
      ];
      engine.setupTrackRouting(tracks);
      expect(engine.trackGainNodes.size).toBe(2);
      expect(engine.trackPanNodes.size).toBe(2);
      expect(engine.trackAnalysers.size).toBe(2);
    });

    it('setTrackVolume applies fader law', () => {
      const tracks = [makeTrack('t1')];
      engine.setupTrackRouting(tracks);
      engine.setTrackVolume('t1', -6);
      const expected = Math.pow(10, -6 / 20);
      expect(engine.trackGainNodes.get('t1')!.gain.value).toBeCloseTo(expected, 4);
    });

    it('setTrackPan clamps to [-1, 1]', () => {
      const tracks = [makeTrack('t1')];
      engine.setupTrackRouting(tracks);
      engine.setTrackPan('t1', 2.0);
      expect(engine.trackPanNodes.get('t1')!.pan.value).toBe(1);
      engine.setTrackPan('t1', -5.0);
      expect(engine.trackPanNodes.get('t1')!.pan.value).toBe(-1);
    });

    it('setTrackMute sets insertOutput gain to 0', () => {
      const tracks = [makeTrack('t1')];
      engine.setupTrackRouting(tracks);
      engine.setTrackMute('t1', true);
      expect(engine.trackInsertOutputs.get('t1')!.gain.value).toBe(0);
      engine.setTrackMute('t1', false);
      expect(engine.trackInsertOutputs.get('t1')!.gain.value).toBe(1);
    });
  });

  // ==================== Crossfader ====================

  describe('Crossfader', () => {
    beforeEach(() => {
      const tracks = [makeTrack('tA'), makeTrack('tB')];
      engine.setupTrackRouting(tracks);
    });

    it('setCrossfaderPosition clamps to [-1, 1]', () => {
      engine.setCrossfader('tA', 'tB');
      engine.setCrossfaderPosition(5.0);
      expect(engine.crossfaderPosition).toBe(1);
      engine.setCrossfaderPosition(-5.0);
      expect(engine.crossfaderPosition).toBe(-1);
    });

    it('crossfader full left (pos=-1) gives gainA=1, gainB=0', () => {
      engine.setCrossfader('tA', 'tB');
      engine.setCrossfaderPosition(-1);
      const gainA = engine.trackCrossfaderNodes.get('tA')!.gain.value;
      const gainB = engine.trackCrossfaderNodes.get('tB')!.gain.value;
      expect(gainA).toBeCloseTo(1.0, 2);
      expect(gainB).toBeCloseTo(0.0, 2);
    });

    it('crossfader full right (pos=1) gives gainA=0, gainB=1', () => {
      engine.setCrossfader('tA', 'tB');
      engine.setCrossfaderPosition(1);
      const gainA = engine.trackCrossfaderNodes.get('tA')!.gain.value;
      const gainB = engine.trackCrossfaderNodes.get('tB')!.gain.value;
      expect(gainA).toBeCloseTo(0.0, 2);
      expect(gainB).toBeCloseTo(1.0, 2);
    });

    it('crossfader center (pos=0) gives equal power gains', () => {
      engine.setCrossfader('tA', 'tB');
      engine.setCrossfaderPosition(0);
      const gainA = engine.trackCrossfaderNodes.get('tA')!.gain.value;
      const gainB = engine.trackCrossfaderNodes.get('tB')!.gain.value;
      // Equal power at center: cos(π/4) = sin(π/4) ≈ 0.707
      expect(gainA).toBeCloseTo(Math.SQRT1_2, 2);
      expect(gainB).toBeCloseTo(Math.SQRT1_2, 2);
    });
  });
});
