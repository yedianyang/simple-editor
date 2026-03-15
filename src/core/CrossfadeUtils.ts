import { Clip } from './types';

/**
 * Compute the gain for the outgoing or incoming clip in an equal-power crossfade.
 *
 * @param role  'out' = outgoing clip (fading from 1 → 0), 'in' = incoming clip (fading from 0 → 1)
 * @param t     Normalized position in the crossfade region [0, 1]
 * @returns     Linear gain value
 */
export function equalPowerXfGain(role: 'out' | 'in', t: number): number {
  if (role === 'out') {
    return Math.cos(t * Math.PI / 2);
  }
  return Math.sin(t * Math.PI / 2);
}

/**
 * Compute the gain for the outgoing or incoming clip in an equal-gain crossfade.
 *
 * @param role  'out' = outgoing clip (fading from 1 → 0), 'in' = incoming clip (fading from 0 → 1)
 * @param t     Normalized position in the crossfade region [0, 1]
 * @returns     Linear gain value
 */
export function equalGainXfGain(role: 'out' | 'in', t: number): number {
  if (role === 'out') {
    return 1 - t;
  }
  return t;
}

/**
 * Clamp a requested crossfade length to the maximum allowed by the clip durations.
 * Maximum crossfade = min(clipA.duration / 2, clipB.duration / 2).
 *
 * @param clipA          The outgoing (first) clip
 * @param clipB          The incoming (second) clip
 * @param requestedSamples  Desired crossfade length in samples
 * @returns              Clamped crossfade length in samples (always >= 0)
 */
export function clampCrossfadeSamples(clipA: Clip, clipB: Clip, requestedSamples: number): number {
  const maxSamples = Math.min(Math.floor(clipA.duration / 2), Math.floor(clipB.duration / 2));
  return Math.max(0, Math.min(requestedSamples, maxSamples));
}

/**
 * Apply a crossfade between two adjacent clips (mutates clipA and clipB in place).
 * Respects the clip-duration constraint: crossfade <= min(clipA.duration/2, clipB.duration/2).
 *
 * @param clipA          The outgoing (first) clip
 * @param clipB          The incoming (second) clip
 * @param samples        Desired crossfade length in samples
 * @param type           Crossfade curve type ('equalPower' | 'equalGain')
 */
export function applyCrossfadeToClips(
  clipA: Clip,
  clipB: Clip,
  samples: number,
  type: 'equalPower' | 'equalGain',
): void {
  const clamped = clampCrossfadeSamples(clipA, clipB, samples);
  clipA.crossfadeOutSamples = clamped;
  clipA.crossfadeType = type;
  clipB.crossfadeInSamples = clamped;
  clipB.crossfadeType = type;
}

/**
 * Schedule crossfade gain automation on a GainNode for a clip that has crossfade data.
 * Call this AFTER the regular fade-in/out scheduling so it overrides in the overlap region.
 *
 * @param gainNode       The clip's gain node (has already had base gain + regular fades set)
 * @param scheduledTime  Web Audio context time when the clip starts playing
 * @param clip           The clip being scheduled
 * @param skipSamples    Samples skipped from the clip start (when starting mid-clip)
 * @param playDuration   Samples to play
 * @param sr             Sample rate
 * @param baseGain       Clip base gain (linear, from gainDb)
 */
export function scheduleCrossfadeEnvelope(
  gainNode: { gain: { setValueAtTime: (v: number, t: number) => void; linearRampToValueAtTime: (v: number, t: number) => void } },
  scheduledTime: number,
  clip: Clip,
  skipSamples: number,
  playDuration: number,
  sr: number,
  baseGain: number,
): void {
  const xfType = clip.crossfadeType ?? 'equalPower';
  const RAMP_POINTS = 8;

  // Crossfade-out: applies to the end of the clip
  if (clip.crossfadeOutSamples && clip.crossfadeOutSamples > 0) {
    const xfOutStart = clip.duration - clip.crossfadeOutSamples;
    const xfOutStartInPlayback = xfOutStart - skipSamples;

    if (xfOutStartInPlayback < playDuration) {
      if (xfOutStartInPlayback > 0) {
        gainNode.gain.setValueAtTime(baseGain, scheduledTime + xfOutStartInPlayback / sr);
      }
      for (let p = 1; p <= RAMP_POINTS; p++) {
        const t = p / RAMP_POINTS;
        const xfSample = Math.round(xfOutStart + t * clip.crossfadeOutSamples);
        const sampleInPlayback = xfSample - skipSamples;
        if (sampleInPlayback < 0) continue;
        if (sampleInPlayback > playDuration) break;

        const gainAtPoint = xfType === 'equalPower'
          ? equalPowerXfGain('out', t) * baseGain
          : equalGainXfGain('out', t) * baseGain;
        gainNode.gain.linearRampToValueAtTime(gainAtPoint, scheduledTime + sampleInPlayback / sr);
      }
    }
  }

  // Crossfade-in: applies to the start of the clip
  if (clip.crossfadeInSamples && clip.crossfadeInSamples > 0) {
    const xfInEnd = clip.crossfadeInSamples;
    const xfInEndInPlayback = xfInEnd - skipSamples;

    if (xfInEndInPlayback > 0) {
      // Set gain to 0 at the very start (or current position if mid-fade)
      const progressAtStart = skipSamples / xfInEnd;
      const startGain = xfType === 'equalPower'
        ? equalPowerXfGain('in', Math.min(1, progressAtStart)) * baseGain
        : equalGainXfGain('in', Math.min(1, progressAtStart)) * baseGain;
      gainNode.gain.setValueAtTime(startGain, scheduledTime);

      for (let p = 1; p <= RAMP_POINTS; p++) {
        const t = p / RAMP_POINTS;
        const xfSample = Math.round(t * xfInEnd);
        const sampleInPlayback = xfSample - skipSamples;
        if (sampleInPlayback < 0) continue;
        if (sampleInPlayback > playDuration) break;

        const gainAtPoint = xfType === 'equalPower'
          ? equalPowerXfGain('in', t) * baseGain
          : equalGainXfGain('in', t) * baseGain;
        gainNode.gain.linearRampToValueAtTime(gainAtPoint, scheduledTime + sampleInPlayback / sr);
      }

      // Ensure full gain at the end of crossfade-in
      if (xfInEndInPlayback <= playDuration) {
        gainNode.gain.linearRampToValueAtTime(baseGain, scheduledTime + xfInEndInPlayback / sr);
      }
    }
  }
}
