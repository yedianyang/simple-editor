import { Track, TrackInsert, FaderLaw, Timeline } from './types';
import type { PluginHost } from '../plugins/PluginHost';
import { BufferPool } from './BufferPool';
import { scheduleCrossfadeEnvelope } from './CrossfadeUtils';

/**
 * Audio Engine for FieldCorder DAW.
 * Supports timeline-based multi-track playback with per-track gain, mute, solo,
 * and plugin insert routing via Web Audio API.
 */
export class AudioEngine {
  audioContext: AudioContext | null = null;
  audioBuffer: AudioBuffer | null = null;
  analyserNode: AnalyserNode | null = null;
  masterGainNode: GainNode | null = null;

  isPlaying = false;
  isPaused = false;
  startTime = 0;
  pauseTime = 0;
  onPlaybackEnd: (() => void) | null = null;
  onPositionUpdate: ((time: number) => void) | null = null;
  animationFrame = 0;
  fftSize = 2048;
  looping = false;
  loopStart = 0;
  loopEnd = 0;

  // Multi-track routing nodes
  trackGainNodes: Map<string, GainNode> = new Map();
  trackCrossfaderNodes: Map<string, GainNode> = new Map();
  trackPanNodes: Map<string, StereoPannerNode> = new Map();
  trackAnalysers: Map<string, AnalyserNode> = new Map();
  trackInsertInputs: Map<string, GainNode> = new Map();
  trackInsertOutputs: Map<string, GainNode> = new Map();
  scheduledSources: AudioBufferSourceNode[] = [];
  faderLaw: FaderLaw = 'equalPower';

  // Crossfader
  crossfaderPosition = 0;
  crossfaderTrackA: string | null = null;
  crossfaderTrackB: string | null = null;
  crossfaderLaw: FaderLaw = 'equalPower';

  async init(): Promise<void> {
    if (!this.audioContext) {
      this.audioContext = new AudioContext();
    }
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }
    if (!this.masterGainNode) {
      this.masterGainNode = this.audioContext.createGain();
      this.masterGainNode.gain.value = 1.0;
    }
    if (!this.analyserNode) {
      this.analyserNode = this.audioContext.createAnalyser();
      this.analyserNode.fftSize = this.fftSize;
      this.analyserNode.smoothingTimeConstant = 0.8;
      this.masterGainNode.connect(this.analyserNode);
      this.analyserNode.connect(this.audioContext.destination);
    }
  }

  setMasterVolume(db: number): void {
    if (!this.masterGainNode) return;
    const gain = Math.pow(10, db / 20);
    this.masterGainNode.gain.value = gain;
  }

  getMasterVolume(): number {
    if (!this.masterGainNode) return 0;
    return 20 * Math.log10(this.masterGainNode.gain.value);
  }

  setFFTSize(size: number): void {
    this.fftSize = size;
    if (this.analyserNode) {
      this.analyserNode.fftSize = size;
    }
  }

  getAnalyserNode(): AnalyserNode | null {
    return this.analyserNode;
  }

  async loadAudio(arrayBuffer: ArrayBuffer): Promise<AudioBuffer> {
    await this.init();
    this.stop();

    const sizeMB = (arrayBuffer.byteLength / (1024 * 1024)).toFixed(1);
    console.log(`Decoding audio: ${sizeMB} MB`);

    // For large WAV files (>100MB), manually parse to avoid decodeAudioData's
    // intermediate memory overhead which causes OOM crashes.
    // decodeAudioData holds: source ArrayBuffer + internal decode buffers + output AudioBuffer
    // Manual parsing holds: source ArrayBuffer + output AudioBuffer + one small chunk buffer
    if (arrayBuffer.byteLength > 100 * 1024 * 1024 && this.isWAVFile(arrayBuffer)) {
      console.log('Large WAV detected — using manual parser to reduce memory');
      try {
        this.audioBuffer = await this.parseWAVManual(arrayBuffer);
      } catch (err) {
        throw new Error(
          `Failed to parse WAV (${sizeMB} MB). ` +
          (err instanceof Error ? err.message : 'Unknown error')
        );
      }
    } else {
      try {
        this.audioBuffer = await this.audioContext!.decodeAudioData(arrayBuffer);
      } catch (err) {
        throw new Error(
          `Failed to decode audio (${sizeMB} MB). ` +
          (arrayBuffer.byteLength > 200 * 1024 * 1024
            ? 'The file may be too large for the available memory.'
            : 'The file format may not be supported.') +
          (err instanceof Error ? ' ' + err.message : '')
        );
      }
    }

    const bufferMB = (this.audioBuffer.length * this.audioBuffer.numberOfChannels * 4 / (1024 * 1024)).toFixed(1);
    console.log(`Audio decoded: ${this.audioBuffer.numberOfChannels}ch, ${this.audioBuffer.sampleRate}Hz, ${this.audioBuffer.length} samples (${bufferMB} MB)`);

    return this.audioBuffer;
  }

  /**
   * Load audio from pre-parsed PCM data (from Rust WAV decoder).
   * Skips decodeAudioData entirely — no OOM risk for large files.
   * Flat samples layout: [ch0_all, ch1_all, ...]
   */
  async loadFromParsedData(data: { sample_rate: number; channels: number; num_samples: number; samples: Float32Array }): Promise<AudioBuffer> {
    await this.init();
    this.stop();

    const { sample_rate, channels, num_samples, samples } = data;

    console.log(`Loading parsed audio: ${channels}ch, ${sample_rate}Hz, ${num_samples} samples`);

    this.audioBuffer = this.audioContext!.createBuffer(channels, num_samples, sample_rate);

    // Use subarray (zero-copy view) instead of slice to avoid allocating a copy
    for (let ch = 0; ch < channels; ch++) {
      const offset = ch * num_samples;
      const channelData = samples.subarray(offset, offset + num_samples) as Float32Array<ArrayBuffer>;
      this.audioBuffer.copyToChannel(channelData, ch);
    }

    const bufferMB = (num_samples * channels * 4 / (1024 * 1024)).toFixed(1);
    console.log(`Audio loaded: ${channels}ch, ${sample_rate}Hz, ${num_samples} samples (${bufferMB} MB)`);

    return this.audioBuffer;
  }

  private isWAVFile(arrayBuffer: ArrayBuffer): boolean {
    if (arrayBuffer.byteLength < 12) return false;
    const view = new DataView(arrayBuffer);
    return (
      view.getUint32(0) === 0x52494646 && // 'RIFF'
      view.getUint32(8) === 0x57415645    // 'WAVE'
    );
  }

  /**
   * Manually parse WAV file and create AudioBuffer.
   * Avoids decodeAudioData's intermediate buffers that cause OOM on large files.
   * Processes in 500K-sample chunks with async yields to keep UI responsive.
   *
   * Memory during parse: ArrayBuffer(304MB) + AudioBuffer(691MB) + chunk(2MB) ≈ 997MB
   * vs decodeAudioData:  ArrayBuffer(304MB) + internals(???) + AudioBuffer(691MB) > 1.5GB
   */
  private async parseWAVManual(arrayBuffer: ArrayBuffer): Promise<AudioBuffer> {
    const view = new DataView(arrayBuffer);

    // Walk RIFF chunks to find 'fmt ' and 'data'
    let formatCode = 0, numChannels = 0, sampleRate = 0, bitsPerSample = 0;
    let dataOffset = -1, dataSize = 0;

    let offset = 12; // skip RIFF header + 'WAVE'
    while (offset < arrayBuffer.byteLength - 8) {
      const chunkId =
        String.fromCharCode(view.getUint8(offset)) +
        String.fromCharCode(view.getUint8(offset + 1)) +
        String.fromCharCode(view.getUint8(offset + 2)) +
        String.fromCharCode(view.getUint8(offset + 3));
      const chunkSize = view.getUint32(offset + 4, true);

      if (chunkId === 'fmt ') {
        formatCode = view.getUint16(offset + 8, true);
        numChannels = view.getUint16(offset + 10, true);
        sampleRate = view.getUint32(offset + 12, true);
        bitsPerSample = view.getUint16(offset + 22, true);

        // WAVE_FORMAT_EXTENSIBLE (0xFFFE): extract actual format from SubFormat GUID
        if (formatCode === 0xFFFE) {
          const fmtStart = offset + 8;
          if (fmtStart + 40 > arrayBuffer.byteLength) {
            throw new Error('Truncated WAVEFORMATEXTENSIBLE chunk');
          }
          const validBits = view.getUint16(fmtStart + 18, true);
          if (validBits > 0) bitsPerSample = validBits;
          // SubFormat GUID at byte 24: first two bytes encode the format code
          const subFormatCode = view.getUint16(fmtStart + 24, true);
          if (subFormatCode === 1) {
            formatCode = 1; // PCM
          } else if (subFormatCode === 3) {
            formatCode = 3; // IEEE Float
          } else {
            throw new Error(`Unsupported WAVEFORMATEXTENSIBLE SubFormat code ${subFormatCode}`);
          }
        }
      } else if (chunkId === 'data') {
        dataOffset = offset + 8;
        dataSize = chunkSize;
      }

      // Chunks are word-aligned
      offset += 8 + chunkSize + (chunkSize % 2);
      if (formatCode > 0 && dataOffset >= 0) break;
    }

    if (formatCode === 0) throw new Error('Missing fmt chunk');
    if (dataOffset < 0) throw new Error('Missing data chunk');
    if (formatCode !== 1 && formatCode !== 3) {
      throw new Error(`Unsupported WAV format code ${formatCode} (only PCM=1 and IEEE float=3)`);
    }

    const bytesPerSample = bitsPerSample / 8;
    const blockAlign = numChannels * bytesPerSample;
    const numSamples = Math.floor(dataSize / blockAlign);

    console.log(`WAV manual parse: ${numChannels}ch, ${sampleRate}Hz, ${bitsPerSample}bit, ${numSamples} samples`);

    const audioBuffer = this.audioContext!.createBuffer(numChannels, numSamples, sampleRate);

    // Process one channel at a time in chunks to minimize peak memory.
    // Each chunk is 500K samples (2MB Float32), yielding between chunks.
    const CHUNK = 500_000;

    for (let ch = 0; ch < numChannels; ch++) {
      for (let start = 0; start < numSamples; start += CHUNK) {
        const end = Math.min(start + CHUNK, numSamples);
        const len = end - start;
        const chunk = new Float32Array(len);

        if (formatCode === 3 && bitsPerSample === 32) {
          for (let i = 0; i < len; i++) {
            chunk[i] = view.getFloat32(dataOffset + (start + i) * blockAlign + ch * 4, true);
          }
        } else if (bitsPerSample === 16) {
          for (let i = 0; i < len; i++) {
            chunk[i] = view.getInt16(dataOffset + (start + i) * blockAlign + ch * 2, true) / 32768;
          }
        } else if (bitsPerSample === 24) {
          for (let i = 0; i < len; i++) {
            const off = dataOffset + (start + i) * blockAlign + ch * 3;
            const b0 = view.getUint8(off);
            const b1 = view.getUint8(off + 1);
            const b2 = view.getUint8(off + 2);
            let s = (b2 << 16) | (b1 << 8) | b0;
            if (b2 & 0x80) s -= 0x1000000; // sign extend 24→32
            chunk[i] = s / 8388608;
          }
        } else if (bitsPerSample === 32) {
          for (let i = 0; i < len; i++) {
            chunk[i] = view.getInt32(dataOffset + (start + i) * blockAlign + ch * 4, true) / 2147483648;
          }
        }

        audioBuffer.copyToChannel(chunk, ch, start);

        // Yield to keep UI responsive
        await new Promise<void>(r => setTimeout(r, 0));
      }
    }

    return audioBuffer;
  }

  setLooping(enabled: boolean): void {
    this.looping = enabled;
  }

  isLooping(): boolean {
    return this.looping;
  }

  pause(): void {
    if (!this.isPlaying || this.isPaused) return;
    this.pauseTime = this.getCurrentTime();
    // Set state BEFORE stopping to prevent onended callbacks from interfering
    this.isPaused = true;
    this.isPlaying = false;
    for (const source of this.scheduledSources) {
      try { source.stop(); } catch (_) { /* already stopped */ }
      source.disconnect();
    }
    this.scheduledSources = [];
    cancelAnimationFrame(this.animationFrame);
  }

  stop(): void {
    this.isPlaying = false;
    this.isPaused = false;
    this.pauseTime = 0;
    cancelAnimationFrame(this.animationFrame);
  }

  getCurrentTime(): number {
    if (this.isPaused) return this.pauseTime;
    if (!this.isPlaying || !this.audioContext) return 0;
    return this.audioContext.currentTime - this.startTime;
  }

  /**
   * Returns the current playback position in integer samples.
   * Used by invalidatePlayback() to restart from the same position
   * after buffer swaps (e.g. denoise, undo/redo).
   */
  getPlaybackPositionSamples(sampleRate: number): number {
    if (this.isPaused) return Math.floor(this.pauseTime * sampleRate);
    if (!this.isPlaying || !this.audioContext) return 0;
    return Math.floor(this.getCurrentTime() * sampleRate);
  }

  getDuration(): number {
    return this.audioBuffer ? this.audioBuffer.duration : 0;
  }

  updatePosition(): void {
    if (!this.isPlaying) return;
    if (this.onPositionUpdate) {
      this.onPositionUpdate(this.getCurrentTime());
    }
    this.animationFrame = requestAnimationFrame(() => this.updatePosition());
  }

  setBuffer(buffer: AudioBuffer): void {
    this.stop();
    this.audioBuffer = buffer;
  }

  // ==================== Multi-Track Routing ====================

  /**
   * Create per-track audio routing: gain -> insertIn -> insertOut -> pan -> analyser -> master.
   */
  setupTrackRouting(tracks: Track[]): void {
    if (!this.audioContext || !this.masterGainNode) return;
    this.cleanupTrackNodes();

    for (const track of tracks) {
      const chCount = track.channels || 1;

      const gain = this.audioContext.createGain();
      gain.gain.value = this.applyFaderLaw(track.volume);
      gain.channelCount = chCount;
      gain.channelCountMode = 'explicit';

      // Separate crossfader gain node — applyCrossfader() controls this,
      // so track volume and crossfader don't overwrite each other.
      const crossfaderGain = this.audioContext.createGain();
      crossfaderGain.gain.value = 1.0;
      crossfaderGain.channelCount = chCount;
      crossfaderGain.channelCountMode = 'explicit';

      const insertIn = this.audioContext.createGain();
      insertIn.gain.value = 1.0;
      insertIn.channelCount = chCount;
      insertIn.channelCountMode = 'explicit';
      const insertOut = this.audioContext.createGain();
      insertOut.gain.value = 1.0;
      insertOut.channelCount = chCount;
      insertOut.channelCountMode = 'explicit';

      const pan = this.audioContext.createStereoPanner();
      pan.pan.value = track.pan;

      const analyser = this.audioContext.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.8;

      // Chain: gain -> crossfaderGain -> insertIn -> insertOut -> pan -> analyser -> master
      gain.connect(crossfaderGain);
      crossfaderGain.connect(insertIn);
      insertIn.connect(insertOut);
      insertOut.connect(pan);
      pan.connect(analyser);
      analyser.connect(this.masterGainNode);

      this.trackGainNodes.set(track.id, gain);
      this.trackCrossfaderNodes.set(track.id, crossfaderGain);
      this.trackInsertInputs.set(track.id, insertIn);
      this.trackInsertOutputs.set(track.id, insertOut);
      this.trackPanNodes.set(track.id, pan);
      this.trackAnalysers.set(track.id, analyser);
    }
  }

  /**
   * Schedule playback of all clips on the timeline from startSample.
   */
  playTimeline(timeline: Timeline, bufferPool: BufferPool, startSample = 0): void {
    if (!this.audioContext || !this.masterGainNode) return;
    this.stopTimeline();

    const startTimeSec = startSample / timeline.sampleRate;
    const now = this.audioContext.currentTime;

    // Apply current mute/solo state so gain nodes reflect the initial routing.
    // All clips are scheduled regardless of mute/solo — audibility is controlled
    // exclusively via insertOut.gain so that live mute/solo changes take effect
    // without needing to restart playback.
    this.updateMuteSoloState(timeline.tracks);

    for (const track of timeline.tracks) {
      const gainNode = this.trackGainNodes.get(track.id);
      if (!gainNode) continue;

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
          const sampleRate = firstPooled.buffer.sampleRate;
          const combinedBuffer = this.audioContext.createBuffer(numCh, durationSamples, sampleRate);
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

        const clipStartSample = clip.timelineOffset;
        const clipEndSample = clip.timelineOffset + clip.duration;

        // Skip clips entirely before the start position
        if (clipEndSample <= startSample) continue;

        const source = this.audioContext.createBufferSource();
        source.buffer = clipBuffer;

        // Calculate start offset within the source buffer and schedule time
        let sourceOffset = clip.sourceStart;
        let scheduledTime = now + (clipStartSample - startSample) / timeline.sampleRate;
        let playDuration = clip.duration;

        // If the clip starts before our playback position, offset into it
        let skipSamples = 0;
        if (clipStartSample < startSample) {
          skipSamples = startSample - clipStartSample;
          sourceOffset += skipSamples;
          playDuration -= skipSamples;
          scheduledTime = now;
        }

        const sr = timeline.sampleRate;
        const baseGain = clip.gainDb !== 0 ? Math.pow(10, clip.gainDb / 20) : 1;
        const hasFadeIn = clip.fadeInSamples > 0;
        const hasFadeOut = clip.fadeOutSamples > 0;
        const hasCrossfade = (clip.crossfadeInSamples ?? 0) > 0 || (clip.crossfadeOutSamples ?? 0) > 0;

        // Create a clip gain node when any envelope processing is needed
        if (baseGain !== 1 || hasFadeIn || hasFadeOut || hasCrossfade) {
          const clipGain = this.audioContext.createGain();

          // Schedule fade-in: configurable curve approximated with 8 ramp points
          if (hasFadeIn) {
            const fadeInCurve = clip.fadeInCurve ?? 0;
            const fadeInEnd = clip.fadeInSamples;
            const fadeInStartInPlayback = -skipSamples; // relative to playback start (can be negative)

            if (fadeInStartInPlayback + fadeInEnd > 0) {
              // Fade-in is still active at our playback position
              const RAMP_POINTS = 8;
              for (let p = 0; p <= RAMP_POINTS; p++) {
                const t = p / RAMP_POINTS; // 0..1 through the fade
                const fadeSample = Math.round(t * fadeInEnd);
                const sampleInPlayback = fadeSample - skipSamples;

                if (sampleInPlayback < 0) continue;
                if (sampleInPlayback > playDuration) break;

                const gainAtPoint = Math.pow(t, Math.pow(2, -fadeInCurve)) * baseGain;
                const timeAtPoint = scheduledTime + sampleInPlayback / sr;

                if (p === 0 || (sampleInPlayback === 0 && skipSamples > 0)) {
                  // Starting mid-fade: set initial value
                  const progressAtStart = skipSamples / fadeInEnd;
                  const startGain = Math.pow(Math.min(1, progressAtStart), Math.pow(2, -fadeInCurve)) * baseGain;
                  clipGain.gain.setValueAtTime(startGain, scheduledTime);
                } else {
                  clipGain.gain.linearRampToValueAtTime(gainAtPoint, timeAtPoint);
                }
              }
              // Ensure we reach full gain at the end of fade-in
              const fadeEndInPlayback = fadeInEnd - skipSamples;
              if (fadeEndInPlayback > 0 && fadeEndInPlayback <= playDuration) {
                clipGain.gain.linearRampToValueAtTime(baseGain, scheduledTime + fadeEndInPlayback / sr);
              }
            } else {
              // Fade-in already completed before our start position
              clipGain.gain.setValueAtTime(baseGain, scheduledTime);
            }
          } else {
            clipGain.gain.setValueAtTime(baseGain, scheduledTime);
          }

          // Schedule fade-out: configurable curve approximated with 8 ramp points
          if (hasFadeOut) {
            const fadeOutCurve = clip.fadeOutCurve ?? 0;
            const fadeOutStart = clip.duration - clip.fadeOutSamples;
            const fadeOutStartInPlayback = fadeOutStart - skipSamples;

            if (fadeOutStartInPlayback < playDuration) {
              const RAMP_POINTS = 8;

              // Ensure gain is at baseGain just before fade-out starts
              if (fadeOutStartInPlayback > 0) {
                clipGain.gain.setValueAtTime(baseGain, scheduledTime + fadeOutStartInPlayback / sr);
              }

              for (let p = 1; p <= RAMP_POINTS; p++) {
                const t = p / RAMP_POINTS; // 0..1 through the fade-out
                const fadeSample = Math.round(fadeOutStart + t * clip.fadeOutSamples);
                const sampleInPlayback = fadeSample - skipSamples;

                if (sampleInPlayback < 0) continue;
                if (sampleInPlayback > playDuration) break;

                const gainAtPoint = Math.pow(1 - t, Math.pow(2, -fadeOutCurve)) * baseGain;
                const timeAtPoint = scheduledTime + sampleInPlayback / sr;
                clipGain.gain.linearRampToValueAtTime(gainAtPoint, timeAtPoint);
              }
            }
          }

          // Schedule crossfade envelope (overrides regular fades in the overlap region)
          if (hasCrossfade) {
            scheduleCrossfadeEnvelope(
              clipGain,
              scheduledTime,
              clip,
              skipSamples,
              playDuration,
              sr,
              baseGain,
            );
          }

          source.connect(clipGain);
          clipGain.connect(gainNode);
        } else {
          source.connect(gainNode);
        }

        const sourceOffsetSec = sourceOffset / sr;
        const durationSec = playDuration / sr;
        source.start(scheduledTime, sourceOffsetSec, durationSec);
        this.scheduledSources.push(source);
      }
    }

    if (this.scheduledSources.length === 0) {
      // Nothing to play
      this.isPlaying = false;
      return;
    }

    // Transport keeps rolling after all clips finish playing.
    // Only stop() or stopTimeline() should stop the transport.
    // No onended auto-stop — the playhead animation loop runs independently.

    this.startTime = now - startTimeSec;
    this.isPlaying = true;
    this.isPaused = false;
    this.updatePosition();
  }

  stopTimeline(): void {
    for (const source of this.scheduledSources) {
      try { source.stop(); } catch (_) {}
      source.disconnect();
    }
    this.scheduledSources = [];
    this.isPlaying = false;
    this.isPaused = false;
    cancelAnimationFrame(this.animationFrame);
  }

  setTrackVolume(trackId: string, db: number): void {
    const node = this.trackGainNodes.get(trackId);
    if (node) node.gain.value = this.applyFaderLaw(db);
  }

  setTrackPan(trackId: string, pan: number): void {
    const node = this.trackPanNodes.get(trackId);
    if (node) node.pan.value = Math.max(-1, Math.min(1, pan));
  }

  /**
   * Apply mute/solo state for all tracks atomically.
   * Correct precedence: if any track is solo'd, only solo'd+unmuted tracks play.
   * If no track is solo'd, only unmuted tracks play.
   * Mute always overrides solo.
   */
  updateMuteSoloState(tracks: ReadonlyArray<Pick<Track, 'id' | 'solo' | 'mute'>>): void {
    const hasSolo = tracks.some(t => t.solo);
    for (const track of tracks) {
      const insertOut = this.trackInsertOutputs.get(track.id);
      if (!insertOut) continue;
      const shouldPlay = hasSolo
        ? (track.solo && !track.mute)
        : !track.mute;
      insertOut.gain.value = shouldPlay ? 1 : 0;
    }
  }

  getTrackAnalyser(trackId: string): AnalyserNode | null {
    return this.trackAnalysers.get(trackId) ?? null;
  }

  // ==================== Fader Law ====================

  setFaderLaw(law: FaderLaw): void {
    this.faderLaw = law;
  }

  /**
   * Convert dB to linear gain using the selected fader law.
   * Equal Power: gain = 10^(dB/20) (standard dB conversion)
   * Equal Gain:  gain = 10^(dB/20) (same formula, different crossfade behaviour)
   * The fader law distinction matters primarily for crossfading.
   */
  applyFaderLaw(dbValue: number): number {
    return Math.pow(10, dbValue / 20);
  }

  // ==================== Crossfader ====================

  setCrossfader(trackA: string, trackB: string): void {
    this.crossfaderTrackA = trackA;
    this.crossfaderTrackB = trackB;
    this.applyCrossfader();
  }

  setCrossfaderPosition(position: number): void {
    this.crossfaderPosition = Math.max(-1, Math.min(1, position));
    this.applyCrossfader();
  }

  setCrossfaderLaw(law: FaderLaw): void {
    this.crossfaderLaw = law;
    this.applyCrossfader();
  }

  private applyCrossfader(): void {
    if (!this.crossfaderTrackA || !this.crossfaderTrackB) return;

    const nodeA = this.trackCrossfaderNodes.get(this.crossfaderTrackA);
    const nodeB = this.trackCrossfaderNodes.get(this.crossfaderTrackB);
    if (!nodeA || !nodeB) return;

    const pos = this.crossfaderPosition;
    const norm = (pos + 1) / 2; // 0..1 where 0 = full A, 1 = full B

    let gainA: number, gainB: number;

    if (this.crossfaderLaw === 'equalPower') {
      gainA = Math.cos(norm * Math.PI / 2);
      gainB = Math.sin(norm * Math.PI / 2);
    } else {
      // Equal Gain: linear
      gainA = 1 - norm;
      gainB = norm;
    }

    nodeA.gain.value = gainA;
    nodeB.gain.value = gainB;
  }

  /**
   * Rebuild the insert chain for a track.
   * Wires non-bypassed plugin instances in series between insertIn and insertOut.
   * If no active plugins, connects insertIn directly to insertOut.
   */
  rebuildInsertChain(trackId: string, inserts: TrackInsert[], pluginHost: PluginHost): void {
    const insertIn = this.trackInsertInputs.get(trackId);
    const insertOut = this.trackInsertOutputs.get(trackId);
    if (!insertIn || !insertOut) return;

    const activeInstances = inserts
      .filter(ins => !ins.bypassed)
      .map(ins => pluginHost.getInstance(ins.instanceId))
      .filter((inst): inst is NonNullable<typeof inst> => inst != null && inst.audioNode != null);

    pluginHost.connectChain(activeInstances, insertIn, insertOut);
  }

  cleanupTrackNodes(): void {
    for (const [, node] of this.trackGainNodes) node.disconnect();
    for (const [, node] of this.trackCrossfaderNodes) node.disconnect();
    for (const [, node] of this.trackPanNodes) node.disconnect();
    for (const [, node] of this.trackAnalysers) node.disconnect();
    for (const [, node] of this.trackInsertInputs) node.disconnect();
    for (const [, node] of this.trackInsertOutputs) node.disconnect();

    this.trackGainNodes.clear();
    this.trackCrossfaderNodes.clear();
    this.trackPanNodes.clear();
    this.trackAnalysers.clear();
    this.trackInsertInputs.clear();
    this.trackInsertOutputs.clear();
  }

  async destroy(): Promise<void> {
    this.stop();
    this.stopTimeline();
    this.cleanupTrackNodes();
    if (this.analyserNode) {
      this.analyserNode.disconnect();
      this.analyserNode = null;
    }
    if (this.masterGainNode) {
      this.masterGainNode.disconnect();
      this.masterGainNode = null;
    }
    if (this.audioContext) {
      await this.audioContext.close();
      this.audioContext = null;
    }
    this.audioBuffer = null;
  }
}
