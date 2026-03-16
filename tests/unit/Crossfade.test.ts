import { describe, it, expect } from 'vitest';
import { Clip } from '../../src/core/types';
import {
  equalPowerXfGain,
  equalGainXfGain,
  clampCrossfadeSamples,
  applyCrossfadeToClips,
} from '../../src/core/CrossfadeUtils';

// ==================== Crossfade gain formulas ====================

describe('equalPowerXfGain', () => {
  it('outgoing clip at t=0 has gain 1', () => {
    expect(equalPowerXfGain('out', 0)).toBeCloseTo(1, 10);
  });

  it('outgoing clip at t=1 has gain 0', () => {
    expect(equalPowerXfGain('out', 1)).toBeCloseTo(0, 10);
  });

  it('incoming clip at t=0 has gain 0', () => {
    expect(equalPowerXfGain('in', 0)).toBeCloseTo(0, 10);
  });

  it('incoming clip at t=1 has gain 1', () => {
    expect(equalPowerXfGain('in', 1)).toBeCloseTo(1, 10);
  });

  it('energy is preserved at midpoint (cos² + sin² ≈ 1)', () => {
    const outGain = equalPowerXfGain('out', 0.5);
    const inGain = equalPowerXfGain('in', 0.5);
    // cos(0.5 * PI/2)² + sin(0.5 * PI/2)² = 1
    expect(outGain * outGain + inGain * inGain).toBeCloseTo(1, 5);
  });

  it('outgoing gain is cos(t * PI/2)', () => {
    expect(equalPowerXfGain('out', 0.25)).toBeCloseTo(Math.cos(0.25 * Math.PI / 2), 10);
    expect(equalPowerXfGain('out', 0.75)).toBeCloseTo(Math.cos(0.75 * Math.PI / 2), 10);
  });

  it('incoming gain is sin(t * PI/2)', () => {
    expect(equalPowerXfGain('in', 0.25)).toBeCloseTo(Math.sin(0.25 * Math.PI / 2), 10);
    expect(equalPowerXfGain('in', 0.75)).toBeCloseTo(Math.sin(0.75 * Math.PI / 2), 10);
  });
});

describe('equalGainXfGain', () => {
  it('outgoing clip at t=0 has gain 1', () => {
    expect(equalGainXfGain('out', 0)).toBeCloseTo(1, 10);
  });

  it('outgoing clip at t=1 has gain 0', () => {
    expect(equalGainXfGain('out', 1)).toBeCloseTo(0, 10);
  });

  it('incoming clip at t=0 has gain 0', () => {
    expect(equalGainXfGain('in', 0)).toBeCloseTo(0, 10);
  });

  it('incoming clip at t=1 has gain 1', () => {
    expect(equalGainXfGain('in', 1)).toBeCloseTo(1, 10);
  });

  it('gains sum to 1 at any point (equal gain law)', () => {
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      const outGain = equalGainXfGain('out', t);
      const inGain = equalGainXfGain('in', t);
      expect(outGain + inGain).toBeCloseTo(1, 10);
    }
  });

  it('outgoing gain is (1 - t)', () => {
    expect(equalGainXfGain('out', 0.3)).toBeCloseTo(0.7, 10);
    expect(equalGainXfGain('out', 0.7)).toBeCloseTo(0.3, 10);
  });

  it('incoming gain is t', () => {
    expect(equalGainXfGain('in', 0.3)).toBeCloseTo(0.3, 10);
    expect(equalGainXfGain('in', 0.7)).toBeCloseTo(0.7, 10);
  });
});

// ==================== Crossfade constraint ====================

describe('clampCrossfadeSamples', () => {
  it('limits crossfade to half of the shorter clip duration', () => {
    const clipA: Partial<Clip> = { duration: 2000 };
    const clipB: Partial<Clip> = { duration: 1000 };
    // max crossfade = min(2000/2, 1000/2) = min(1000, 500) = 500
    expect(clampCrossfadeSamples(clipA as Clip, clipB as Clip, 800)).toBe(500);
  });

  it('returns requested samples if within constraint', () => {
    const clipA: Partial<Clip> = { duration: 4000 };
    const clipB: Partial<Clip> = { duration: 4000 };
    // max = min(2000, 2000) = 2000
    expect(clampCrossfadeSamples(clipA as Clip, clipB as Clip, 1000)).toBe(1000);
  });

  it('returns 0 for 0 request', () => {
    const clipA: Partial<Clip> = { duration: 4000 };
    const clipB: Partial<Clip> = { duration: 4000 };
    expect(clampCrossfadeSamples(clipA as Clip, clipB as Clip, 0)).toBe(0);
  });

  it('limits to half of clipA duration when clipA is shorter', () => {
    const clipA: Partial<Clip> = { duration: 400 };
    const clipB: Partial<Clip> = { duration: 2000 };
    // max = min(200, 1000) = 200
    expect(clampCrossfadeSamples(clipA as Clip, clipB as Clip, 500)).toBe(200);
  });

  it('limits to half of clipB duration when clipB is shorter', () => {
    const clipA: Partial<Clip> = { duration: 2000 };
    const clipB: Partial<Clip> = { duration: 600 };
    // max = min(1000, 300) = 300
    expect(clampCrossfadeSamples(clipA as Clip, clipB as Clip, 500)).toBe(300);
  });

  it('caps negative request to 0', () => {
    const clipA: Partial<Clip> = { duration: 2000 };
    const clipB: Partial<Clip> = { duration: 2000 };
    expect(clampCrossfadeSamples(clipA as Clip, clipB as Clip, -100)).toBe(0);
  });
});

// ==================== Crossfade model ====================

describe('applyCrossfadeToClips', () => {
  function makeClip(id: string, timelineOffset: number, duration: number): Clip {
    return {
      id,
      bufferIds: ['buf'],
      name: 'test',
      timelineOffset,
      sourceStart: 0,
      sourceEnd: duration,
      duration,
      gainDb: 0,
      fadeInSamples: 0,
      fadeOutSamples: 0,
      muted: false,
    };
  }

  it('sets crossfadeOutSamples on clipA and crossfadeInSamples on clipB', () => {
    const clipA = makeClip('a', 0, 5000);
    const clipB = makeClip('b', 4000, 5000);
    applyCrossfadeToClips(clipA, clipB, 1000, 'equalPower');
    expect(clipA.crossfadeOutSamples).toBe(1000);
    expect(clipB.crossfadeInSamples).toBe(1000);
  });

  it('sets crossfadeType on both clips', () => {
    const clipA = makeClip('a', 0, 5000);
    const clipB = makeClip('b', 4000, 5000);
    applyCrossfadeToClips(clipA, clipB, 1000, 'equalGain');
    expect(clipA.crossfadeType).toBe('equalGain');
    expect(clipB.crossfadeType).toBe('equalGain');
  });

  it('clamps 1000-sample crossfade within clip duration constraints', () => {
    // clipA duration=5000, clipB duration=5000 → max=2500 → 1000 is within bounds
    const clipA = makeClip('a', 0, 5000);
    const clipB = makeClip('b', 4000, 5000);
    applyCrossfadeToClips(clipA, clipB, 1000, 'equalPower');
    // 1000 <= min(2500, 2500) → clamped value stays 1000
    expect(clipA.crossfadeOutSamples).toBe(1000);
    expect(clipB.crossfadeInSamples).toBe(1000);
  });

  it('clears crossfade when set to 0', () => {
    const clipA = makeClip('a', 0, 5000);
    const clipB = makeClip('b', 4000, 5000);
    clipA.crossfadeOutSamples = 500;
    clipB.crossfadeInSamples = 500;
    applyCrossfadeToClips(clipA, clipB, 0, 'equalPower');
    expect(clipA.crossfadeOutSamples).toBe(0);
    expect(clipB.crossfadeInSamples).toBe(0);
  });
});
