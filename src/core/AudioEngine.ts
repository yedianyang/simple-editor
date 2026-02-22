import { ChannelLayout, CHANNEL_NAMES, Track, FaderLaw, Timeline } from './types';
import { BufferPool } from './BufferPool';

/**
 * Multi-channel Audio Engine for FieldCorder DAW.
 * Supports 1-6 channel configurations with per-channel gain, mute, solo,
 * and plugin insert routing via Web Audio API.
 */
export class AudioEngine {
  audioContext: AudioContext | null = null;
  audioBuffer: AudioBuffer | null = null;
  sourceNode: AudioBufferSourceNode | null = null;
  analyserNode: AnalyserNode | null = null;
  masterGainNode: GainNode | null = null;

  // Per-channel nodes
  channelSplitter: ChannelSplitterNode | null = null;
  channelMerger: ChannelMergerNode | null = null;
  channelGainNodes: GainNode[] = [];
  channelAnalysers: AnalyserNode[] = [];

  // Plugin insert points per channel
  channelInsertInputs: GainNode[] = [];
  channelInsertOutputs: GainNode[] = [];

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

  channelLayout: ChannelLayout = ChannelLayout.STEREO;
  soloChannels: Set<number> = new Set();
  muteChannels: Set<number> = new Set();

  // Multi-track routing nodes
  trackGainNodes: Map<string, GainNode> = new Map();
  trackCrossfaderNodes: Map<string, GainNode> = new Map();
  trackPanNodes: Map<string, StereoPannerNode> = new Map();
  trackAnalysers: Map<string, AnalyserNode> = new Map();
  trackInsertInputs: Map<string, GainNode> = new Map();
  trackInsertOutputs: Map<string, GainNode> = new Map();
  scheduledSources: AudioBufferSourceNode[] = [];
  private activeSourceCount = 0;
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

  /**
   * Set up channel routing for multi-channel audio.
   * Creates splitter -> per-channel gain/insert/analyser -> merger -> master
   */
  setupChannelRouting(numChannels: number): void {
    if (!this.audioContext || !this.masterGainNode) return;

    // Clean up existing channel nodes
    this.cleanupChannelNodes();

    // For mono/stereo, we can use simple routing
    if (numChannels <= 2) {
      this.channelLayout = numChannels === 1 ? ChannelLayout.MONO : ChannelLayout.STEREO;
    } else if (numChannels <= 4) {
      this.channelLayout = ChannelLayout.QUAD;
    } else {
      this.channelLayout = ChannelLayout.SURROUND_51;
    }

    // Create splitter and merger
    this.channelSplitter = this.audioContext.createChannelSplitter(numChannels);
    // Always merge to stereo for output (downmix for monitoring)
    this.channelMerger = this.audioContext.createChannelMerger(2);

    // Create per-channel processing chain
    for (let i = 0; i < numChannels; i++) {
      // Channel gain
      const gainNode = this.audioContext.createGain();
      gainNode.gain.value = 1.0;
      this.channelGainNodes.push(gainNode);

      // Insert input (before plugins)
      const insertIn = this.audioContext.createGain();
      insertIn.gain.value = 1.0;
      this.channelInsertInputs.push(insertIn);

      // Insert output (after plugins)
      const insertOut = this.audioContext.createGain();
      insertOut.gain.value = 1.0;
      this.channelInsertOutputs.push(insertOut);

      // Per-channel analyser
      const analyser = this.audioContext.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.8;
      this.channelAnalysers.push(analyser);

      // Connect: splitter -> gain -> insertIn -> insertOut -> analyser -> merger
      this.channelSplitter.connect(gainNode, i);
      gainNode.connect(insertIn);
      // Default: insert input directly to insert output (no plugins)
      insertIn.connect(insertOut);
      insertOut.connect(analyser);

      // Downmix to stereo: even channels to left, odd channels to right
      // For proper surround downmixing
      if (numChannels <= 2) {
        analyser.connect(this.channelMerger, 0, i % 2);
      } else {
        // Simple downmix: L,C,Ls -> Left; R,LFE,Rs -> Right
        const outputChannel = this.getDownmixOutput(i, numChannels);
        analyser.connect(this.channelMerger, 0, outputChannel);
      }
    }

    // Merger -> master gain
    this.channelMerger.connect(this.masterGainNode);
  }

  private getDownmixOutput(channelIndex: number, numChannels: number): number {
    if (numChannels === 4) {
      // Quad: FL->L, FR->R, RL->L, RR->R
      return channelIndex % 2;
    }
    if (numChannels === 6) {
      // 5.1: L->L, R->R, C->both(L), LFE->both(R), Ls->L, Rs->R
      const mapping = [0, 1, 0, 1, 0, 1];
      return mapping[channelIndex];
    }
    return channelIndex % 2;
  }

  private cleanupChannelNodes(): void {
    this.channelGainNodes.forEach(n => n.disconnect());
    this.channelInsertInputs.forEach(n => n.disconnect());
    this.channelInsertOutputs.forEach(n => n.disconnect());
    this.channelAnalysers.forEach(n => n.disconnect());
    this.channelSplitter?.disconnect();
    this.channelMerger?.disconnect();

    this.channelGainNodes = [];
    this.channelInsertInputs = [];
    this.channelInsertOutputs = [];
    this.channelAnalysers = [];
    this.channelSplitter = null;
    this.channelMerger = null;
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

  setChannelVolume(channel: number, db: number): void {
    if (channel < 0 || channel >= this.channelGainNodes.length) return;
    const gain = Math.pow(10, db / 20);
    this.channelGainNodes[channel].gain.value = gain;
  }

  setChannelMute(channel: number, mute: boolean): void {
    if (mute) {
      this.muteChannels.add(channel);
    } else {
      this.muteChannels.delete(channel);
    }
    this.updateChannelMuteState();
  }

  setChannelSolo(channel: number, solo: boolean): void {
    if (solo) {
      this.soloChannels.add(channel);
    } else {
      this.soloChannels.delete(channel);
    }
    this.updateChannelMuteState();
  }

  private updateChannelMuteState(): void {
    const hasSolo = this.soloChannels.size > 0;

    for (let i = 0; i < this.channelGainNodes.length; i++) {
      const isMuted = this.muteChannels.has(i);
      const isSoloed = this.soloChannels.has(i);

      let shouldPlay = true;
      if (hasSolo) {
        shouldPlay = isSoloed && !isMuted;
      } else {
        shouldPlay = !isMuted;
      }

      // Use insert output to mute (preserves gain setting)
      if (this.channelInsertOutputs[i]) {
        this.channelInsertOutputs[i].gain.value = shouldPlay ? 1.0 : 0.0;
      }
    }
  }

  /**
   * Get the insert point for a channel to connect plugin chains.
   * Returns { input, output } - disconnect input->output and insert plugin chain.
   */
  getChannelInsertPoint(channel: number): { input: GainNode; output: GainNode } | null {
    if (channel < 0 || channel >= this.channelInsertInputs.length) return null;
    return {
      input: this.channelInsertInputs[channel],
      output: this.channelInsertOutputs[channel],
    };
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

  getChannelAnalyser(channel: number): AnalyserNode | null {
    if (channel < 0 || channel >= this.channelAnalysers.length) return null;
    return this.channelAnalysers[channel];
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

    this.setupChannelRouting(this.audioBuffer.numberOfChannels);
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

    // Slice the flat samples array into per-channel data and copy
    for (let ch = 0; ch < channels; ch++) {
      const offset = ch * num_samples;
      const channelData = samples.slice(offset, offset + num_samples);
      this.audioBuffer.copyToChannel(channelData, ch);
    }

    const bufferMB = (num_samples * channels * 4 / (1024 * 1024)).toFixed(1);
    console.log(`Audio loaded: ${channels}ch, ${sample_rate}Hz, ${num_samples} samples (${bufferMB} MB)`);

    this.setupChannelRouting(channels);
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

  play(startOffset = 0): void {
    if (!this.audioBuffer || !this.audioContext) return;

    this.stopPlayback();
    this.sourceNode = this.audioContext.createBufferSource();
    this.sourceNode.buffer = this.audioBuffer;

    // Connect through channel splitter if multi-channel
    if (this.channelSplitter && this.audioBuffer.numberOfChannels > 1) {
      this.sourceNode.connect(this.channelSplitter);
    } else {
      this.sourceNode.connect(this.masterGainNode!);
    }

    this.sourceNode.onended = () => {
      if (this.isPlaying && !this.isPaused) {
        this.stop();
        if (this.onPlaybackEnd) this.onPlaybackEnd();
      }
    };

    this.sourceNode.start(0, startOffset);
    this.startTime = this.audioContext.currentTime - startOffset;
    this.isPlaying = true;
    this.isPaused = false;

    this.updatePosition();
  }

  playSelection(startTime: number, endTime: number): void {
    if (!this.audioBuffer || !this.audioContext) return;

    this.stopPlayback();
    this.sourceNode = this.audioContext.createBufferSource();
    this.sourceNode.buffer = this.audioBuffer;

    if (this.channelSplitter && this.audioBuffer.numberOfChannels > 1) {
      this.sourceNode.connect(this.channelSplitter);
    } else {
      this.sourceNode.connect(this.masterGainNode!);
    }

    this.loopStart = startTime;
    this.loopEnd = endTime;

    this.sourceNode.onended = () => {
      if (this.isPlaying && !this.isPaused) {
        if (this.looping && this.loopEnd > this.loopStart) {
          this.playSelection(this.loopStart, this.loopEnd);
        } else {
          this.stop();
          if (this.onPlaybackEnd) this.onPlaybackEnd();
        }
      }
    };

    const duration = endTime - startTime;
    this.sourceNode.start(0, startTime, duration);
    this.startTime = this.audioContext.currentTime - startTime;
    this.isPlaying = true;
    this.isPaused = false;

    this.updatePosition();
  }

  setLooping(enabled: boolean): void {
    this.looping = enabled;
  }

  isLooping(): boolean {
    return this.looping;
  }

  resume(): void {
    if (!this.isPaused) return;
    this.play(this.pauseTime);
  }

  stopPlayback(): void {
    if (this.sourceNode) {
      try {
        this.sourceNode.stop();
      } catch (e) {}
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }
    cancelAnimationFrame(this.animationFrame);
  }

  pause(): void {
    if (!this.isPlaying || this.isPaused) return;
    this.pauseTime = this.getCurrentTime();
    this.sourceNode?.stop();
    this.isPaused = true;
    this.isPlaying = false;
    cancelAnimationFrame(this.animationFrame);
  }

  stop(): void {
    this.stopPlayback();
    this.isPlaying = false;
    this.isPaused = false;
    this.pauseTime = 0;
  }

  getCurrentTime(): number {
    if (this.isPaused) return this.pauseTime;
    if (!this.isPlaying || !this.audioContext) return 0;
    return this.audioContext.currentTime - this.startTime;
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
    this.setupChannelRouting(buffer.numberOfChannels);
  }

  getChannelNames(): string[] {
    if (!this.audioBuffer) return [];
    const numChannels = this.audioBuffer.numberOfChannels;
    return CHANNEL_NAMES[numChannels] || Array.from({ length: numChannels }, (_, i) => `Ch ${i + 1}`);
  }

  // ==================== Multi-Track Routing ====================

  /**
   * Create per-track audio routing: gain -> insertIn -> insertOut -> pan -> analyser -> master.
   */
  setupTrackRouting(tracks: Track[]): void {
    if (!this.audioContext || !this.masterGainNode) return;
    this.cleanupTrackNodes();

    for (const track of tracks) {
      const gain = this.audioContext.createGain();
      gain.gain.value = this.applyFaderLaw(track.volume);

      // Separate crossfader gain node — applyCrossfader() controls this,
      // so track volume and crossfader don't overwrite each other.
      const crossfaderGain = this.audioContext.createGain();
      crossfaderGain.gain.value = 1.0;

      const insertIn = this.audioContext.createGain();
      insertIn.gain.value = 1.0;
      const insertOut = this.audioContext.createGain();
      insertOut.gain.value = 1.0;

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

    // Determine solo state
    const soloTrackIds = new Set<string>();
    for (const track of timeline.tracks) {
      if (track.solo) soloTrackIds.add(track.id);
    }
    const hasSolo = soloTrackIds.size > 0;

    for (const track of timeline.tracks) {
      const gainNode = this.trackGainNodes.get(track.id);
      if (!gainNode) continue;

      // Mute/solo logic
      const shouldPlay = hasSolo
        ? soloTrackIds.has(track.id) && !track.mute
        : !track.mute;

      if (!shouldPlay) continue;

      for (const clip of track.clips) {
        if (clip.muted) continue;

        const pooled = bufferPool.getBuffer(clip.bufferId);
        if (!pooled) continue;

        const clipStartSample = clip.timelineOffset;
        const clipEndSample = clip.timelineOffset + clip.duration;

        // Skip clips entirely before the start position
        if (clipEndSample <= startSample) continue;

        const source = this.audioContext.createBufferSource();
        source.buffer = pooled.buffer;

        // Apply per-clip gain
        if (clip.gainDb !== 0) {
          const clipGain = this.audioContext.createGain();
          clipGain.gain.value = Math.pow(10, clip.gainDb / 20);
          source.connect(clipGain);
          clipGain.connect(gainNode);
        } else {
          source.connect(gainNode);
        }

        // Calculate start offset within the source buffer and schedule time
        let sourceOffset = clip.sourceStart;
        let scheduledTime = now + (clipStartSample - startSample) / timeline.sampleRate;
        let duration = clip.duration / timeline.sampleRate;

        // If the clip starts before our playback position, offset into it
        if (clipStartSample < startSample) {
          const skipSamples = startSample - clipStartSample;
          sourceOffset += skipSamples;
          duration -= skipSamples / timeline.sampleRate;
          scheduledTime = now;
        }

        const sourceOffsetSec = sourceOffset / timeline.sampleRate;
        source.start(scheduledTime, sourceOffsetSec, duration);
        this.scheduledSources.push(source);
      }
    }

    // Track active source count for end-of-playback detection (M7)
    this.activeSourceCount = this.scheduledSources.length;

    if (this.activeSourceCount === 0) {
      // Nothing to play
      this.isPlaying = false;
      return;
    }

    for (const source of this.scheduledSources) {
      source.onended = () => {
        this.activeSourceCount--;
        if (this.activeSourceCount <= 0 && this.isPlaying && !this.isPaused) {
          this.isPlaying = false;
          cancelAnimationFrame(this.animationFrame);
          if (this.onPlaybackEnd) this.onPlaybackEnd();
        }
      };
    }

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

  setTrackMute(trackId: string, mute: boolean): void {
    const insertOut = this.trackInsertOutputs.get(trackId);
    if (insertOut) insertOut.gain.value = mute ? 0 : 1;
  }

  setTrackSolo(trackId: string, solo: boolean): void {
    // Solo is handled at playback scheduling time; for live update,
    // mute all non-solo tracks' insert outputs.
    const soloIds = new Set<string>();
    // We don't have direct access to the timeline here,
    // so we toggle the specific track and let the caller manage group state.
    // For immediate feedback, toggle the insert output.
    const insertOut = this.trackInsertOutputs.get(trackId);
    if (!insertOut) return;

    if (solo) {
      // Mute all other tracks, unmute this one
      for (const [id, out] of this.trackInsertOutputs) {
        out.gain.value = id === trackId ? 1 : 0;
      }
    } else {
      // Unmute all tracks (caller should re-apply proper solo state)
      for (const [, out] of this.trackInsertOutputs) {
        out.gain.value = 1;
      }
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
    this.cleanupChannelNodes();
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
