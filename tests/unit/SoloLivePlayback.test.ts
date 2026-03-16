/**
 * TDD tests for B2 — Solo/Mute state changes must take effect during active playback.
 *
 * Root cause: playTimeline() skips scheduling AudioBufferSourceNodes for
 * tracks excluded by mute/solo logic. When the user un-mutes or un-solos
 * during playback, there is no source to start playing.
 *
 * Fix: Schedule ALL clips regardless of mute/solo state. Audibility is
 * controlled exclusively via the track's insertOut.gain node, which
 * updateMuteSoloState() already manages correctly.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { AudioEngine } from '../../src/core/AudioEngine';
import { BufferPool } from '../../src/core/BufferPool';
import { Timeline, Track, Clip } from '../../src/core/types';

// ==================== Helpers ====================

function makeTimeline(tracks: Track[], sampleRate = 44100): Timeline {
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

describe('B2 — playTimeline schedules all tracks regardless of mute/solo', () => {
  let engine: AudioEngine;
  let bufferPool: BufferPool;
  let bufIdA: string;
  let bufIdB: string;

  beforeEach(async () => {
    engine = new AudioEngine();
    await engine.init();

    bufferPool = new BufferPool();
    const mockBufA = engine.audioContext!.createBuffer(1, 44100 * 5, 44100);
    const mockBufB = engine.audioContext!.createBuffer(1, 44100 * 5, 44100);
    bufIdA = bufferPool.addBuffer(mockBufA as unknown as AudioBuffer, 'a.wav', 0);
    bufIdB = bufferPool.addBuffer(mockBufB as unknown as AudioBuffer, 'b.wav', 0);
  });

  it('schedules sources for muted tracks so un-muting during playback works', () => {
    const clipA = makeClip(bufIdA);
    const clipB = makeClip(bufIdB);
    const trackA = makeTrack('A', [clipA]);
    const trackB = makeTrack('B', [clipB], { mute: true }); // B is muted

    engine.setupTrackRouting([trackA, trackB]);
    const timeline = makeTimeline([trackA, trackB]);
    engine.playTimeline(timeline, bufferPool);

    // Both clips must be scheduled — one per track
    expect(engine.scheduledSources).toHaveLength(2);
  });

  it('schedules sources for solo-excluded tracks so un-soloing during playback works', () => {
    const clipA = makeClip(bufIdA);
    const clipB = makeClip(bufIdB);
    const trackA = makeTrack('A', [clipA], { solo: true }); // A is solo'd, B is excluded
    const trackB = makeTrack('B', [clipB]);

    engine.setupTrackRouting([trackA, trackB]);
    const timeline = makeTimeline([trackA, trackB]);
    engine.playTimeline(timeline, bufferPool);

    // Both clips must be scheduled — audibility is controlled by insertOut gain
    expect(engine.scheduledSources).toHaveLength(2);
  });

  it('gain nodes reflect solo state at playback start', () => {
    const clipA = makeClip(bufIdA);
    const clipB = makeClip(bufIdB);
    const trackA = makeTrack('A', [clipA], { solo: true });
    const trackB = makeTrack('B', [clipB]);

    engine.setupTrackRouting([trackA, trackB]);
    const timeline = makeTimeline([trackA, trackB]);
    engine.updateMuteSoloState([trackA, trackB]);
    engine.playTimeline(timeline, bufferPool);

    // A is solo'd → gain=1; B is excluded → gain=0
    expect(engine.trackInsertOutputs.get('A')!.gain.value).toBe(1);
    expect(engine.trackInsertOutputs.get('B')!.gain.value).toBe(0);

    // But sources for B are still scheduled
    expect(engine.scheduledSources).toHaveLength(2);
  });

  it('after playback starts, un-soloing A makes B audible without restarting', () => {
    const clipA = makeClip(bufIdA);
    const clipB = makeClip(bufIdB);
    const trackA = makeTrack('A', [clipA], { solo: true });
    const trackB = makeTrack('B', [clipB]);

    engine.setupTrackRouting([trackA, trackB]);
    const timeline = makeTimeline([trackA, trackB]);
    engine.playTimeline(timeline, bufferPool);

    // Simulate: user un-solos A during playback
    trackA.solo = false;
    engine.updateMuteSoloState([trackA, trackB]);

    // Now both should be audible (gain=1)
    expect(engine.trackInsertOutputs.get('A')!.gain.value).toBe(1);
    expect(engine.trackInsertOutputs.get('B')!.gain.value).toBe(1);

    // Sources are still playing (not restarted)
    expect(engine.scheduledSources).toHaveLength(2);
    expect(engine.isPlaying).toBe(true);
  });

  it('after playback starts, soloing B makes only B audible without restarting', () => {
    const clipA = makeClip(bufIdA);
    const clipB = makeClip(bufIdB);
    const trackA = makeTrack('A', [clipA]);
    const trackB = makeTrack('B', [clipB]);

    engine.setupTrackRouting([trackA, trackB]);
    const timeline = makeTimeline([trackA, trackB]);
    engine.playTimeline(timeline, bufferPool);

    // Both playing initially
    expect(engine.scheduledSources).toHaveLength(2);

    // Simulate: user solos B during playback
    trackB.solo = true;
    engine.updateMuteSoloState([trackA, trackB]);

    // Only B audible
    expect(engine.trackInsertOutputs.get('A')!.gain.value).toBe(0);
    expect(engine.trackInsertOutputs.get('B')!.gain.value).toBe(1);

    // Sources still playing (no restart needed)
    expect(engine.scheduledSources).toHaveLength(2);
    expect(engine.isPlaying).toBe(true);
  });
});
