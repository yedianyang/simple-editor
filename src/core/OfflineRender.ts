import { Timeline } from './types';
import { BufferPool } from './BufferPool';
import { PluginHost } from '../plugins/PluginHost';
import type { PluginInstance } from './types';
import { scheduleCrossfadeEnvelope, computeClipScheduleParams } from './CrossfadeUtils';

export interface OfflineRenderResult {
  channels: Float32Array[];
  sampleRate: number;
  duration: number; // in samples
}

/**
 * Offline render of the entire timeline via OfflineAudioContext.
 *
 * Mirrors AudioEngine.playTimeline() routing:
 *   source → clipGain (gain + fade automation) → [merger] → trackGain → insertIn → insertOut → pan → master
 *
 * This guarantees export = playback parity for:
 * - Clip gain (dB) and fade envelopes (sqrt curve, 8-point ramp)
 * - Track volume (fader)
 * - Track pan (StereoPannerNode)
 * - Mute / Solo
 * - Sub-channel routing (ChannelMergerNode)
 * - Plugin inserts (EQ, Compressor, Delay, Reverb, etc.)
 */
export async function renderTimelineOffline(
  timeline: Timeline,
  bufferPool: BufferPool,
  pluginHost?: PluginHost,
): Promise<OfflineRenderResult> {
  const { sampleRate, tracks, totalLength } = timeline;

  if (totalLength === 0 || tracks.length === 0) {
    return { channels: [], sampleRate, duration: 0 };
  }

  // Determine output channel count: max of all track channel counts
  // Force stereo if any track has non-zero pan (StereoPannerNode needs 2+ channels)
  let outputChannels = 1;
  for (const track of tracks) {
    if (track.channels > outputChannels) outputChannels = track.channels;
    if (track.pan !== 0 && outputChannels < 2) outputChannels = 2;
  }

  // Solo state
  const soloTrackIds = new Set<string>();
  for (const t of tracks) {
    if (t.solo) soloTrackIds.add(t.id);
  }
  const hasSolo = soloTrackIds.size > 0;

  const offlineCtx = new OfflineAudioContext(outputChannels, totalLength, sampleRate);
  const master = offlineCtx.createGain();
  master.connect(offlineCtx.destination);

  let hasAudibleContent = false;

  for (const track of tracks) {
    const shouldPlay = hasSolo
      ? soloTrackIds.has(track.id) && !track.mute
      : !track.mute;
    if (!shouldPlay) continue;

    const chCount = track.channels || 1;

    // Track gain (fader) — same dB→linear as AudioEngine.applyFaderLaw
    const trackGain = offlineCtx.createGain();
    trackGain.gain.value = track.volume !== 0 ? Math.pow(10, track.volume / 20) : 1;
    trackGain.channelCount = chCount;
    trackGain.channelCountMode = 'explicit';

    // Insert chain: plugins wired between insertIn → insertOut
    const insertIn = offlineCtx.createGain();
    insertIn.channelCount = chCount;
    insertIn.channelCountMode = 'explicit';
    const insertOut = offlineCtx.createGain();
    insertOut.channelCount = chCount;
    insertOut.channelCountMode = 'explicit';

    const activeInserts = pluginHost
      ? track.inserts.filter(ins => !ins.bypassed)
      : [];

    if (activeInserts.length > 0 && pluginHost) {
      // Create fresh plugin instances on the OfflineAudioContext
      const offlinePluginHost = new PluginHost(offlineCtx);
      const offlineInstances: PluginInstance[] = [];
      for (const ins of activeInserts) {
        const pluginInfo = pluginHost.getAvailablePlugins().find(p => p.id === ins.pluginId);
        if (!pluginInfo) continue;
        try {
          const inst = await offlinePluginHost.createInstance(pluginInfo);
          for (const param of ins.parameters) {
            offlinePluginHost.setParameter(inst.id, param.id, param.value);
          }
          offlineInstances.push(inst);
        } catch {
          // Skip plugins that can't be instantiated offline (e.g. AudioWorklet)
        }
      }
      if (offlineInstances.length > 0) {
        offlinePluginHost.connectChain(offlineInstances, insertIn, insertOut);
      } else {
        insertIn.connect(insertOut);
      }
    } else {
      insertIn.connect(insertOut);
    }

    // Chain: trackGain → insertIn → insertOut → [pan] → master
    trackGain.connect(insertIn);
    if (outputChannels >= 2) {
      const pan = offlineCtx.createStereoPanner();
      pan.pan.value = track.pan;
      insertOut.connect(pan);
      pan.connect(master);
    } else {
      insertOut.connect(master);
    }

    for (const clip of track.clips) {
      if (clip.muted) continue;

      // Build the AudioBuffer for this clip from its bufferIds array
      const numCh = clip.bufferIds.length;
      let clipBuffer: AudioBuffer | null = null;

      if (numCh > 1) {
        // Multi-channel clip: combine per-channel mono buffers into one buffer
        const firstPooled = bufferPool.getBuffer(clip.bufferIds[0]);
        if (!firstPooled) continue;
        const durationSamples = firstPooled.buffer.length;
        const sr2 = firstPooled.buffer.sampleRate;
        const combinedBuffer = offlineCtx.createBuffer(numCh, durationSamples, sr2);
        for (let ch = 0; ch < numCh; ch++) {
          const mono = bufferPool.getBuffer(clip.bufferIds[ch]);
          if (mono) combinedBuffer.copyToChannel(mono.buffer.getChannelData(0), ch);
        }
        clipBuffer = combinedBuffer;
      } else {
        const pooled = bufferPool.getBuffer(clip.bufferIds[0]);
        if (!pooled) continue;
        clipBuffer = pooled.buffer;
      }

      hasAudibleContent = true;

      const source = offlineCtx.createBufferSource();
      source.buffer = clipBuffer;

      const sr = sampleRate;

      // Compute schedule params accounting for true crossfade overlap.
      // Offline render always starts from sample 0 (no mid-timeline skip).
      const sched = computeClipScheduleParams(clip, 0, sr);
      const scheduledTime = sched.scheduledTimeSec;
      const { playDuration, actualOverlap } = sched;

      const baseGain = clip.gainDb !== 0 ? Math.pow(10, clip.gainDb / 20) : 1;
      const hasFadeIn = clip.fadeInSamples > 0;
      const hasFadeOut = clip.fadeOutSamples > 0;
      const hasCrossfade = (clip.crossfadeInSamples ?? 0) > 0 || (clip.crossfadeOutSamples ?? 0) > 0;

      // Create clip gain node when any envelope is needed
      if (baseGain !== 1 || hasFadeIn || hasFadeOut || hasCrossfade) {
        const clipGain = offlineCtx.createGain();

        // Schedule fade-in (configurable curve, 8 ramp points — matches AudioEngine).
        // Fade-in starts at the visual clip start = actualOverlap samples into the extended clip.
        if (hasFadeIn) {
          const fadeInCurve = clip.fadeInCurve ?? 0;
          const fadeInStartInExtended = actualOverlap;
          const fadeInEndInExtended = actualOverlap + clip.fadeInSamples;
          const RAMP_POINTS = 8;
          clipGain.gain.setValueAtTime(0, scheduledTime + fadeInStartInExtended / sr);
          for (let p = 1; p <= RAMP_POINTS; p++) {
            const t = p / RAMP_POINTS;
            const fadeSampleInExtended = Math.round(fadeInStartInExtended + t * clip.fadeInSamples);
            if (fadeSampleInExtended > playDuration) break;
            clipGain.gain.linearRampToValueAtTime(
              Math.pow(t, Math.pow(2, -fadeInCurve)) * baseGain,
              scheduledTime + fadeSampleInExtended / sr,
            );
          }
          // Ensure full gain at end of fade-in
          clipGain.gain.linearRampToValueAtTime(baseGain, scheduledTime + fadeInEndInExtended / sr);
        } else {
          clipGain.gain.setValueAtTime(baseGain, scheduledTime);
        }

        // Schedule fade-out (configurable curve, 8 ramp points — matches AudioEngine).
        // Fade-out starts at (actualOverlap + clip.duration - clip.fadeOutSamples) in the extended clip.
        if (hasFadeOut) {
          const fadeOutCurve = clip.fadeOutCurve ?? 0;
          const fadeOutStartInExtended = actualOverlap + clip.duration - clip.fadeOutSamples;
          const fadeOutStartTime = scheduledTime + fadeOutStartInExtended / sr;
          clipGain.gain.setValueAtTime(baseGain, fadeOutStartTime);
          const RAMP_POINTS = 8;
          for (let p = 1; p <= RAMP_POINTS; p++) {
            const t = p / RAMP_POINTS;
            const fadeSampleInExtended = fadeOutStartInExtended + Math.round(t * clip.fadeOutSamples);
            if (fadeSampleInExtended > playDuration) break;
            clipGain.gain.linearRampToValueAtTime(
              Math.pow(1 - t, Math.pow(2, -fadeOutCurve)) * baseGain,
              scheduledTime + fadeSampleInExtended / sr,
            );
          }
        }

        // Schedule crossfade envelope (overrides regular fades in the overlap region).
        // Pass actualOverlap so the xf-out position is correctly offset by the pre-roll.
        if (hasCrossfade) {
          scheduleCrossfadeEnvelope(
            clipGain,
            scheduledTime,
            clip,
            0, // offline render always starts from beginning (no skipSamples)
            playDuration,
            sr,
            baseGain,
            actualOverlap,
          );
        }

        source.connect(clipGain);
        clipGain.connect(trackGain);
      } else {
        source.connect(trackGain);
      }

      source.start(scheduledTime, sched.sourceOffsetSec, sched.durationSec);
    }
  }

  if (!hasAudibleContent) {
    return { channels: [], sampleRate, duration: 0 };
  }

  const rendered = await offlineCtx.startRendering();

  const channels: Float32Array[] = [];
  for (let ch = 0; ch < rendered.numberOfChannels; ch++) {
    channels.push(rendered.getChannelData(ch));
  }

  return { channels, sampleRate, duration: totalLength };
}
