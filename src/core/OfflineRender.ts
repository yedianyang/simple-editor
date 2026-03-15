import { Timeline } from './types';
import { BufferPool } from './BufferPool';
import { PluginHost } from '../plugins/PluginHost';
import type { PluginInstance } from './types';
import { scheduleCrossfadeEnvelope } from './CrossfadeUtils';

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

    // Channel merger for multi-channel tracks
    let merger: ChannelMergerNode | null = null;
    if (chCount > 1) {
      merger = offlineCtx.createChannelMerger(chCount);
      merger.connect(trackGain);
    }

    for (const clip of track.clips) {
      if (clip.muted) continue;

      const pooled = bufferPool.getBuffer(clip.bufferId);
      if (!pooled) continue;
      hasAudibleContent = true;

      const source = offlineCtx.createBufferSource();
      source.buffer = pooled.buffer;

      const sr = sampleRate;
      const sourceOffset = clip.sourceStart;
      const playDuration = clip.duration;
      const scheduledTime = clip.timelineOffset / sr;
      const baseGain = clip.gainDb !== 0 ? Math.pow(10, clip.gainDb / 20) : 1;
      const hasFadeIn = clip.fadeInSamples > 0;
      const hasFadeOut = clip.fadeOutSamples > 0;
      const hasCrossfade = (clip.crossfadeInSamples ?? 0) > 0 || (clip.crossfadeOutSamples ?? 0) > 0;

      // Create clip gain node when any envelope is needed
      if (baseGain !== 1 || hasFadeIn || hasFadeOut || hasCrossfade) {
        const clipGain = offlineCtx.createGain();

        // Schedule fade-in (configurable curve, 8 ramp points — matches AudioEngine)
        if (hasFadeIn) {
          const fadeInCurve = clip.fadeInCurve ?? 0;
          const fadeInEnd = clip.fadeInSamples;
          const RAMP_POINTS = 8;
          clipGain.gain.setValueAtTime(0, scheduledTime);
          for (let p = 1; p <= RAMP_POINTS; p++) {
            const t = p / RAMP_POINTS;
            const fadeSample = Math.round(t * fadeInEnd);
            if (fadeSample > playDuration) break;
            clipGain.gain.linearRampToValueAtTime(
              Math.pow(t, Math.pow(2, -fadeInCurve)) * baseGain,
              scheduledTime + fadeSample / sr,
            );
          }
          // Ensure full gain at end of fade-in
          const fadeEndTime = scheduledTime + fadeInEnd / sr;
          clipGain.gain.linearRampToValueAtTime(baseGain, fadeEndTime);
        } else {
          clipGain.gain.setValueAtTime(baseGain, scheduledTime);
        }

        // Schedule fade-out (configurable curve, 8 ramp points — matches AudioEngine)
        if (hasFadeOut) {
          const fadeOutCurve = clip.fadeOutCurve ?? 0;
          const fadeOutStart = clip.duration - clip.fadeOutSamples;
          const fadeOutStartTime = scheduledTime + fadeOutStart / sr;
          clipGain.gain.setValueAtTime(baseGain, fadeOutStartTime);
          const RAMP_POINTS = 8;
          for (let p = 1; p <= RAMP_POINTS; p++) {
            const t = p / RAMP_POINTS;
            const fadeSample = fadeOutStart + Math.round(t * clip.fadeOutSamples);
            if (fadeSample > playDuration) break;
            clipGain.gain.linearRampToValueAtTime(
              Math.pow(1 - t, Math.pow(2, -fadeOutCurve)) * baseGain,
              scheduledTime + fadeSample / sr,
            );
          }
        }

        // Schedule crossfade envelope (overrides regular fades in the overlap region)
        if (hasCrossfade) {
          scheduleCrossfadeEnvelope(
            clipGain,
            scheduledTime,
            clip,
            0, // offline render always starts from beginning (no skipSamples)
            playDuration,
            sr,
            baseGain,
          );
        }

        source.connect(clipGain);
        if (merger && clip.subChannel != null) {
          clipGain.connect(merger, 0, clip.subChannel);
        } else {
          clipGain.connect(trackGain);
        }
      } else {
        if (merger && clip.subChannel != null) {
          source.connect(merger, 0, clip.subChannel);
        } else {
          source.connect(trackGain);
        }
      }

      source.start(scheduledTime, sourceOffset / sr, playDuration / sr);
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
