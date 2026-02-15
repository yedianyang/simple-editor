import { ChannelLayout, CHANNEL_NAMES } from './types';

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
    this.audioBuffer = await this.audioContext!.decodeAudioData(arrayBuffer);
    this.setupChannelRouting(this.audioBuffer.numberOfChannels);
    return this.audioBuffer;
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
}
