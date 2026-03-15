import { describe, it, expect, beforeEach } from 'vitest';
import { AudioEngine } from '../../src/core/AudioEngine';
import type { Track } from '../../src/core/types';

/** Minimal track factory — only the fields updateMuteSoloState cares about. */
function makeTrack(id: string, overrides: Partial<Track> = {}): Track {
  return {
    id,
    name: `Track ${id}`,
    color: '#3b82f6',
    channels: 1,
    clips: [],
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

describe('Mute/Solo Logic — AudioEngine.updateMuteSoloState', () => {
  let engine: AudioEngine;
  let trackA: Track;
  let trackB: Track;
  let trackC: Track;

  beforeEach(async () => {
    engine = new AudioEngine();
    await engine.init();

    trackA = makeTrack('A');
    trackB = makeTrack('B');
    trackC = makeTrack('C');

    // Set up routing nodes so trackInsertOutputs is populated
    engine.setupTrackRouting([trackA, trackB, trackC]);
  });

  /** Helper: read the current gain value of a track's insert-output node. */
  function insertGain(trackId: string): number {
    return engine.trackInsertOutputs.get(trackId)!.gain.value;
  }

  // ==================== B2: Multiple Solo ====================

  it('B2.1 — solo A then solo B → A=1, B=1, C=0', () => {
    trackA.solo = true;
    trackB.solo = true;
    engine.updateMuteSoloState([trackA, trackB, trackC]);

    expect(insertGain('A')).toBe(1);
    expect(insertGain('B')).toBe(1);
    expect(insertGain('C')).toBe(0);
  });

  it('B2.2 — solo A + mute A → A=0, B=0, C=0 (mute overrides solo)', () => {
    trackA.solo = true;
    trackA.mute = true;
    engine.updateMuteSoloState([trackA, trackB, trackC]);

    // A is solo'd but muted → silent.
    // B and C are not solo'd → silenced by the active solo state.
    expect(insertGain('A')).toBe(0);
    expect(insertGain('B')).toBe(0);
    expect(insertGain('C')).toBe(0);
  });

  it('B2.3 — unsolo all → all unmuted tracks play (gain=1)', () => {
    // First apply a solo state, then clear it
    trackA.solo = true;
    engine.updateMuteSoloState([trackA, trackB, trackC]);

    trackA.solo = false;
    engine.updateMuteSoloState([trackA, trackB, trackC]);

    expect(insertGain('A')).toBe(1);
    expect(insertGain('B')).toBe(1);
    expect(insertGain('C')).toBe(1);
  });

  it('B2.4 — mute A, solo B → A=0, B=1, C=0', () => {
    trackA.mute = true;
    trackB.solo = true;
    engine.updateMuteSoloState([trackA, trackB, trackC]);

    expect(insertGain('A')).toBe(0);
    expect(insertGain('B')).toBe(1);
    expect(insertGain('C')).toBe(0);
  });

  // ==================== B3: Mute During Solo ====================

  it('B3.1 — mute a solo\'d track → that track becomes silent', () => {
    trackA.solo = true;
    engine.updateMuteSoloState([trackA, trackB, trackC]);
    expect(insertGain('A')).toBe(1); // sanity check before muting

    trackA.mute = true;
    engine.updateMuteSoloState([trackA, trackB, trackC]);

    expect(insertGain('A')).toBe(0);
  });

  it('B3.2 — solo toggle off: unsolo the only solo\'d track → all unmuted tracks play', () => {
    trackA.solo = true;
    engine.updateMuteSoloState([trackA, trackB, trackC]);
    // Sanity: only A plays while solo is on
    expect(insertGain('A')).toBe(1);
    expect(insertGain('B')).toBe(0);

    trackA.solo = false;
    engine.updateMuteSoloState([trackA, trackB, trackC]);

    expect(insertGain('A')).toBe(1);
    expect(insertGain('B')).toBe(1);
    expect(insertGain('C')).toBe(1);
  });

  it('B3.3 — muted track stays silent when no solo is active', () => {
    trackB.mute = true;
    engine.updateMuteSoloState([trackA, trackB, trackC]);

    expect(insertGain('A')).toBe(1);
    expect(insertGain('B')).toBe(0);
    expect(insertGain('C')).toBe(1);
  });
});
