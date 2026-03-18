import { Clip } from './types';

/**
 * Parameters for scheduling a clip with crossfade overlap.
 * The crossfade overlap model requires clips to be played BEYOND their visual
 * boundaries: the outgoing clip (crossfadeOut) extends past its visual end,
 * and the incoming clip (crossfadeIn) starts before its visual start.
 */
export interface ClipScheduleParams {
  /** Absolute timeline sample where the extended clip starts. */
  extendedTimelineStart: number;
  /** Absolute timeline sample where the extended clip ends. */
  effectiveEndSample: number;
  /** Source buffer offset in seconds (accounts for crossfade extension and mid-playback skip). */
  sourceOffsetSec: number;
  /** Seconds to schedule this clip at (max(0, (extendedStart - startSample)) / sr). */
  scheduledTimeSec: number;
  /** Samples skipped from the extended clip start (when startSample falls inside the clip). */
  skipSamples: number;
  /** Remaining samples to play after the skip. */
  playDuration: number;
  /** playDuration in seconds. */
  durationSec: number;
  /**
   * Actual pre-roll samples before the clip's visual start.
   * = min(crossfadeInSamples, clip.sourceStart). Used by scheduleCrossfadeEnvelope.
   */
  actualOverlap: number;
}

/**
 * Compute scheduling parameters for a clip, accounting for crossfade overlap.
 *
 * For a true crossfade the two clips must OVERLAP in time:
 * - ClipA (crossfadeOut): plays clip.duration + crossfadeOutSamples, extending
 *   past its visual end into the next clip's territory. Source offset and
 *   timeline position are unchanged.
 * - ClipB (crossfadeIn): starts crossfadeInSamples before its visual start,
 *   reading earlier data from the source buffer. Timeline start moves left by
 *   the actual overlap (clamped by available source data: sourceStart).
 *
 * @param clip        The clip to schedule
 * @param startSample Absolute timeline sample where playback starts
 * @param sr          Sample rate
 */
export function computeClipScheduleParams(clip: Clip, startSample: number, sr: number): ClipScheduleParams {
  const xfOut = clip.crossfadeOutSamples ?? 0;
  const xfIn = clip.crossfadeInSamples ?? 0;

  // For crossfadeIn: the actual overlap is limited by how much source data
  // exists before sourceStart (can't read before sample 0 in the buffer).
  const actualOverlap = xfIn > 0 ? Math.min(xfIn, clip.sourceStart) : 0;

  // Extended timeline bounds
  const extendedTimelineStart = clip.timelineOffset - actualOverlap;
  const totalPlayDuration = clip.duration + xfOut + actualOverlap;
  const effectiveEndSample = extendedTimelineStart + totalPlayDuration;

  // Base source offset (before mid-playback skip)
  const baseSourceOffset = clip.sourceStart - actualOverlap; // >= 0 by clamp above

  // Mid-playback skip: if startSample falls inside the extended clip
  const skipSamples = startSample > extendedTimelineStart
    ? startSample - extendedTimelineStart
    : 0;

  const playDuration = totalPlayDuration - skipSamples;
  const scheduledTimeSec = skipSamples > 0
    ? 0
    : (extendedTimelineStart - startSample) / sr;

  const sourceOffsetSec = (baseSourceOffset + skipSamples) / sr;
  const durationSec = playDuration / sr;

  return {
    extendedTimelineStart,
    effectiveEndSample,
    sourceOffsetSec,
    scheduledTimeSec,
    skipSamples,
    playDuration,
    durationSec,
    actualOverlap,
  };
}

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
 * With the true-overlap crossfade model, clips physically overlap in time:
 * - ClipA (crossfadeOut) plays `clip.duration + crossfadeOutSamples` total (no pre-roll).
 * - ClipB (crossfadeIn) starts `actualOverlap` samples before its visual start.
 *   `skipSamples` and `playDuration` are relative to the extended clip start.
 *
 * @param gainNode       The clip's gain node (has already had base gain + regular fades set)
 * @param scheduledTime  Web Audio context time when the extended clip starts playing
 * @param clip           The clip being scheduled
 * @param skipSamples    Samples skipped from the EXTENDED clip start (when starting mid-clip)
 * @param playDuration   Remaining samples to play in the extended clip
 * @param sr             Sample rate
 * @param baseGain       Clip base gain (linear, from gainDb)
 * @param actualOverlap  Actual pre-roll before visual start (= min(crossfadeInSamples, sourceStart))
 */
export function scheduleCrossfadeEnvelope(
  gainNode: { gain: { setValueAtTime: (v: number, t: number) => void; linearRampToValueAtTime: (v: number, t: number) => void } },
  scheduledTime: number,
  clip: Clip,
  skipSamples: number,
  playDuration: number,
  sr: number,
  baseGain: number,
  actualOverlap = 0,
): void {
  const xfType = clip.crossfadeType ?? 'equalPower';
  const RAMP_POINTS = 8;

  // Crossfade-out: clip body is [actualOverlap, actualOverlap + clip.duration] in extended time.
  // The fade-out region starts at actualOverlap + (clip.duration - crossfadeOutSamples).
  if (clip.crossfadeOutSamples && clip.crossfadeOutSamples > 0) {
    const xfOutStartInExtended = actualOverlap + clip.duration - clip.crossfadeOutSamples;
    const xfOutStartInPlayback = xfOutStartInExtended - skipSamples;

    if (xfOutStartInPlayback < playDuration) {
      if (xfOutStartInPlayback > 0) {
        gainNode.gain.setValueAtTime(baseGain, scheduledTime + xfOutStartInPlayback / sr);
      }
      for (let p = 1; p <= RAMP_POINTS; p++) {
        const t = p / RAMP_POINTS;
        const xfSampleInExtended = Math.round(xfOutStartInExtended + t * clip.crossfadeOutSamples);
        const sampleInPlayback = xfSampleInExtended - skipSamples;
        if (sampleInPlayback < 0) continue;
        if (sampleInPlayback > playDuration) break;

        const gainAtPoint = xfType === 'equalPower'
          ? equalPowerXfGain('out', t) * baseGain
          : equalGainXfGain('out', t) * baseGain;
        gainNode.gain.linearRampToValueAtTime(gainAtPoint, scheduledTime + sampleInPlayback / sr);
      }
    }
  }

  // Crossfade-in: the extended clip starts at time 0. The xf-in region spans [0, actualOverlap].
  // Use actualOverlap as the effective xf-in length (may be < crossfadeInSamples if buffer-clamped).
  const effectiveXfIn = actualOverlap > 0 ? actualOverlap : (clip.crossfadeInSamples ?? 0);
  if (effectiveXfIn > 0) {
    const xfInEndInPlayback = effectiveXfIn - skipSamples;

    if (xfInEndInPlayback > 0) {
      // Set gain to 0 at the very start (or current position if mid-fade)
      const progressAtStart = skipSamples / effectiveXfIn;
      const startGain = xfType === 'equalPower'
        ? equalPowerXfGain('in', Math.min(1, progressAtStart)) * baseGain
        : equalGainXfGain('in', Math.min(1, progressAtStart)) * baseGain;
      gainNode.gain.setValueAtTime(startGain, scheduledTime);

      for (let p = 1; p <= RAMP_POINTS; p++) {
        const t = p / RAMP_POINTS;
        const xfSample = Math.round(t * effectiveXfIn);
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
