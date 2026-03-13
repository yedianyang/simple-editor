import { Timeline, Track, Clip } from './types';
import { BufferPool } from './BufferPool';

export interface OfflineRenderResult {
  channels: Float32Array[];
  sampleRate: number;
  duration: number; // in samples
}

/**
 * Offline render of the entire timeline into Float32Array channels.
 *
 * Behaviour mirrors AudioEngine.playTimeline() but operates on raw sample
 * buffers instead of Web Audio scheduling nodes:
 *
 * - Determines total duration from all clips across all tracks
 * - Creates output Float32Array channels (matching highest track channel count)
 * - For each track (skip if muted, respect solo):
 *   - For each clip (skip if muted):
 *     - Read source audio from BufferPool via clip.bufferId
 *     - Apply clip.gainDb
 *     - Apply fadeIn / fadeOut envelopes (sqrt curve, matching real-time playback)
 *     - Write (sum) to output at correct sample position
 *     - Respect clip.sourceStart and clip.duration for trimmed clips
 * - Returns { channels, sampleRate, duration }
 */
export function renderTimelineOffline(timeline: Timeline, bufferPool: BufferPool): OfflineRenderResult {
  const { sampleRate, tracks, totalLength } = timeline;

  if (totalLength === 0 || tracks.length === 0) {
    return { channels: [], sampleRate, duration: 0 };
  }

  // Determine output channel count: max of all track channel counts
  let outputChannels = 1;
  for (const track of tracks) {
    if (track.channels > outputChannels) {
      outputChannels = track.channels;
    }
  }

  // Determine solo state
  const soloTrackIds = new Set<string>();
  for (const track of tracks) {
    if (track.solo) soloTrackIds.add(track.id);
  }
  const hasSolo = soloTrackIds.size > 0;

  // Check if any track actually has audible content
  let hasAudibleContent = false;
  for (const track of tracks) {
    const shouldPlay = hasSolo
      ? soloTrackIds.has(track.id) && !track.mute
      : !track.mute;
    if (!shouldPlay) continue;
    for (const clip of track.clips) {
      if (!clip.muted) {
        const pooled = bufferPool.getBuffer(clip.bufferId);
        if (pooled) {
          hasAudibleContent = true;
          break;
        }
      }
    }
    if (hasAudibleContent) break;
  }

  if (!hasAudibleContent) {
    return { channels: [], sampleRate, duration: 0 };
  }

  // Allocate output channels (zero-initialized)
  const output: Float32Array[] = [];
  for (let ch = 0; ch < outputChannels; ch++) {
    output.push(new Float32Array(totalLength));
  }

  // Render each track
  for (const track of tracks) {
    const shouldPlay = hasSolo
      ? soloTrackIds.has(track.id) && !track.mute
      : !track.mute;
    if (!shouldPlay) continue;

    for (const clip of track.clips) {
      if (clip.muted) continue;

      const pooled = bufferPool.getBuffer(clip.bufferId);
      if (!pooled) continue;

      const srcData = pooled.buffer.getChannelData(0);
      const clipOffset = clip.timelineOffset;
      const clipDuration = clip.duration;
      const sourceStart = clip.sourceStart;
      const baseGain = clip.gainDb !== 0 ? Math.pow(10, clip.gainDb / 20) : 1;

      // Pre-compute fade boundaries
      const fadeInEnd = clip.fadeInSamples;
      const fadeOutStart = clipDuration - clip.fadeOutSamples;

      // Determine which output channels this clip writes to
      let targetChannels: number[];
      if (clip.subChannel != null && clip.subChannel < outputChannels) {
        targetChannels = [clip.subChannel];
      } else if (track.channels === 1 && outputChannels > 1) {
        // Mono track with no subChannel: write to all output channels
        targetChannels = Array.from({ length: outputChannels }, (_, i) => i);
      } else {
        // Default: write to channel 0
        targetChannels = [0];
      }

      // Render clip samples
      for (let i = 0; i < clipDuration; i++) {
        const srcIdx = sourceStart + i;
        if (srcIdx < 0 || srcIdx >= srcData.length) continue;

        const outIdx = clipOffset + i;
        if (outIdx < 0 || outIdx >= totalLength) continue;

        let sample = srcData[srcIdx];

        // Apply gain
        let gain = baseGain;

        // Apply fade-in (sqrt curve)
        if (clip.fadeInSamples > 0 && i < fadeInEnd) {
          const t = i / fadeInEnd;
          gain *= Math.sqrt(t);
        }

        // Apply fade-out (sqrt(1-t) curve)
        if (clip.fadeOutSamples > 0 && i >= fadeOutStart) {
          const t = (i - fadeOutStart) / clip.fadeOutSamples;
          gain *= Math.sqrt(1 - t);
        }

        sample *= gain;

        // Sum to output channels
        for (const ch of targetChannels) {
          output[ch][outIdx] += sample;
        }
      }
    }
  }

  return { channels: output, sampleRate, duration: totalLength };
}
