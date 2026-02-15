import { CHANNEL_WEIGHTS } from '../core/types';

/**
 * Professional audio metering: Peak, RMS, True Peak, LUFS.
 * Supports multi-channel measurement per ITU-R BS.1770-4.
 */
export class Metering {
  peakValue: HTMLElement;
  peakBar: HTMLElement;
  rmsPeakValue: HTMLElement;
  truePeakValue: HTMLElement;
  lufsValue: HTMLElement;
  lufsIntegratedEl: HTMLElement;
  lufsShortTermEl: HTMLElement;
  lufsMomentaryEl: HTMLElement;

  analyserNode: AnalyserNode | null = null;
  audioBuffer: AudioBuffer | null = null;
  isRealtime = false;
  animationFrame = 0;

  fileStats = { rmsPeak: null as number | null, truePeak: null as number | null, lufs: null as number | null };

  lufsState = {
    kWeightedChannels: null as Float32Array[] | null,
    sampleRate: 0,
    blockSize: 0,
    integratedBlocks: [] as Array<{ ms: number; lufs: number }>,
    shortTermBlocks: [] as Array<{ ms: number; lufs: number }>,
    currentSample: 0,
    lastBlockSample: 0,
  };

  constructor() {
    this.peakValue = document.getElementById('peakValue')!;
    this.peakBar = document.getElementById('peakBar')!;
    this.rmsPeakValue = document.getElementById('rmsPeakValue')!;
    this.truePeakValue = document.getElementById('truePeakValue')!;
    this.lufsValue = document.getElementById('lufsValue')!;
    this.lufsIntegratedEl = document.getElementById('lufsIntegrated')!;
    this.lufsShortTermEl = document.getElementById('lufsShortTerm')!;
    this.lufsMomentaryEl = document.getElementById('lufsMomentary')!;
  }

  setAnalyserNode(node: AnalyserNode | null): void {
    this.analyserNode = node;
  }

  setAudioBuffer(buffer: AudioBuffer | null): void {
    this.audioBuffer = buffer;
    if (buffer) {
      this.calculateFileStats(buffer);
      this.prepareRealtimeLUFS(buffer);
    } else {
      this.reset();
    }
  }

  prepareRealtimeLUFS(audioBuffer: AudioBuffer): void {
    const numChannels = audioBuffer.numberOfChannels;
    const sampleRate = audioBuffer.sampleRate;
    const coeffs = this.getKWeightingCoeffs(sampleRate);

    this.lufsState.kWeightedChannels = [];
    this.lufsState.sampleRate = sampleRate;
    this.lufsState.blockSize = Math.floor(sampleRate * 0.4);

    for (let c = 0; c < numChannels; c++) {
      const data = audioBuffer.getChannelData(c);
      const afterShelf = this.applyBiquad(data, coeffs.shelf);
      const kWeighted = this.applyBiquad(afterShelf, coeffs.highpass);
      this.lufsState.kWeightedChannels.push(kWeighted);
    }
  }

  calculateFileStats(audioBuffer: AudioBuffer): void {
    const numChannels = audioBuffer.numberOfChannels;
    const length = audioBuffer.length;
    const sampleRate = audioBuffer.sampleRate;

    // RMS Peak
    const windowSize = Math.floor(sampleRate * 0.3);
    let rmsPeakLinear = 0;
    for (let c = 0; c < numChannels; c++) {
      const data = audioBuffer.getChannelData(c);
      for (let i = 0; i < length - windowSize; i += Math.floor(windowSize / 4)) {
        let sum = 0;
        for (let j = 0; j < windowSize; j++) {
          sum += data[i + j] * data[i + j];
        }
        const rms = Math.sqrt(sum / windowSize);
        if (rms > rmsPeakLinear) rmsPeakLinear = rms;
      }
    }
    const rmsPeak = rmsPeakLinear > 0 ? 20 * Math.log10(rmsPeakLinear) : -Infinity;

    // True Peak with 4x oversampling
    let truePeakLinear = 0;
    for (let c = 0; c < numChannels; c++) {
      const data = audioBuffer.getChannelData(c);
      for (let i = 0; i < length; i++) {
        const abs = Math.abs(data[i]);
        if (abs > truePeakLinear) truePeakLinear = abs;
      }
      for (let i = 1; i < length - 2; i++) {
        for (let phase = 1; phase <= 3; phase++) {
          const t = phase / 4;
          const s0 = data[i - 1], s1 = data[i], s2 = data[i + 1], s3 = data[i + 2];
          const interSample = s1 + 0.5 * t * (s2 - s0 + t * (2 * s0 - 5 * s1 + 4 * s2 - s3 + t * (3 * (s1 - s2) + s3 - s0)));
          const absInter = Math.abs(interSample);
          if (absInter > truePeakLinear) truePeakLinear = absInter;
        }
      }
    }
    const truePeak = truePeakLinear > 0 ? 20 * Math.log10(truePeakLinear) : -Infinity;

    const lufs = this.calculateLUFS(audioBuffer);

    this.fileStats = { rmsPeak, truePeak, lufs };
    this.updateFileStatsDisplay();
  }

  getKWeightingCoeffs(sampleRate: number) {
    if (sampleRate === 48000) {
      return {
        shelf: { b0: 1.53512485958697, b1: -2.69169618940638, b2: 1.19839281085285, a1: -1.69065929318241, a2: 0.73248077421585 },
        highpass: { b0: 1.0, b1: -2.0, b2: 1.0, a1: -1.99004745483398, a2: 0.99007225036621 }
      };
    } else if (sampleRate === 44100) {
      return {
        shelf: { b0: 1.53084094649361, b1: -2.65099526752845, b2: 1.16907762258337, a1: -1.66375011657313, a2: 0.71265879083903 },
        highpass: { b0: 1.0, b1: -2.0, b2: 1.0, a1: -1.98916615635498, a2: 0.98919469658594 }
      };
    } else {
      const fc1 = 1500.0, fc2 = 38.0;
      const K1 = Math.tan(Math.PI * fc1 / sampleRate);
      const V = Math.pow(10, 4 / 20);
      const norm1 = 1 / (1 + Math.sqrt(2) * K1 + K1 * K1);
      const shelf = {
        b0: (1 + Math.sqrt(2 * V) * K1 + V * K1 * K1) * norm1,
        b1: 2 * (V * K1 * K1 - 1) * norm1,
        b2: (1 - Math.sqrt(2 * V) * K1 + V * K1 * K1) * norm1,
        a1: 2 * (K1 * K1 - 1) * norm1,
        a2: (1 - Math.sqrt(2) * K1 + K1 * K1) * norm1
      };

      const K2 = Math.tan(Math.PI * fc2 / sampleRate);
      const Q = 0.707;
      const norm2 = 1 / (1 + K2 / Q + K2 * K2);
      const highpass = {
        b0: norm2,
        b1: -2 * norm2,
        b2: norm2,
        a1: 2 * (K2 * K2 - 1) * norm2,
        a2: (1 - K2 / Q + K2 * K2) * norm2
      };

      return { shelf, highpass };
    }
  }

  applyBiquad(samples: Float32Array, coeffs: any): Float32Array {
    const output = new Float32Array(samples.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < samples.length; i++) {
      const x0 = samples[i];
      const y0 = coeffs.b0 * x0 + coeffs.b1 * x1 + coeffs.b2 * x2 - coeffs.a1 * y1 - coeffs.a2 * y2;
      output[i] = y0;
      x2 = x1; x1 = x0;
      y2 = y1; y1 = y0;
    }
    return output;
  }

  calculateLUFS(audioBuffer: AudioBuffer): number {
    const numChannels = audioBuffer.numberOfChannels;
    const length = audioBuffer.length;
    const sampleRate = audioBuffer.sampleRate;
    const coeffs = this.getKWeightingCoeffs(sampleRate);

    const kWeightedChannels: Float32Array[] = [];
    for (let c = 0; c < numChannels; c++) {
      const data = audioBuffer.getChannelData(c);
      const afterShelf = this.applyBiquad(data, coeffs.shelf);
      const kWeighted = this.applyBiquad(afterShelf, coeffs.highpass);
      kWeightedChannels.push(kWeighted);
    }

    const weights = CHANNEL_WEIGHTS[numChannels] || Array(numChannels).fill(1.0);

    const blockSize = Math.floor(sampleRate * 0.4);
    const hopSize = Math.floor(sampleRate * 0.1);
    const blocks: number[] = [];

    for (let start = 0; start + blockSize <= length; start += hopSize) {
      let blockSum = 0;
      for (let c = 0; c < numChannels; c++) {
        const weight = weights[c];
        if (weight === 0) continue;
        const kWeighted = kWeightedChannels[c];
        let channelSum = 0;
        for (let i = 0; i < blockSize; i++) {
          const sample = kWeighted[start + i];
          channelSum += sample * sample;
        }
        blockSum += weight * (channelSum / blockSize);
      }
      blocks.push(blockSum);
    }

    if (blocks.length === 0) return -Infinity;

    const blockLoudness = blocks.map(ms => ms > 0 ? -0.691 + 10 * Math.log10(ms) : -Infinity);

    // Absolute gating at -70 LUFS
    const absoluteGated = blocks.filter((_, i) => blockLoudness[i] > -70);
    if (absoluteGated.length === 0) return -Infinity;

    const absoluteMean = absoluteGated.reduce((a, b) => a + b, 0) / absoluteGated.length;
    const ungatedLoudness = absoluteMean > 0 ? -0.691 + 10 * Math.log10(absoluteMean) : -Infinity;

    // Relative gating at -10 LU below
    const relativeThreshold = ungatedLoudness - 10;
    const relativeGated = blocks.filter((_, i) => blockLoudness[i] > relativeThreshold);
    if (relativeGated.length === 0) return -Infinity;

    const finalMean = relativeGated.reduce((a, b) => a + b, 0) / relativeGated.length;
    return finalMean > 0 ? -0.691 + 10 * Math.log10(finalMean) : -Infinity;
  }

  updateFileStatsDisplay(): void {
    const { rmsPeak, truePeak, lufs } = this.fileStats;
    this.rmsPeakValue.textContent = rmsPeak !== null && isFinite(rmsPeak) ? rmsPeak.toFixed(1) + ' dB' : '-';
    this.truePeakValue.textContent = truePeak !== null && isFinite(truePeak) ? truePeak.toFixed(1) + ' dB' : '-';
    this.lufsValue.textContent = lufs !== null && isFinite(lufs) ? lufs.toFixed(1) + ' LUFS' : '-';
  }

  startRealtime(): void {
    this.isRealtime = true;
    this.lufsState.integratedBlocks = [];
    this.lufsState.shortTermBlocks = [];
    this.lufsState.currentSample = 0;
    this.lufsState.lastBlockSample = 0;
    this.updateRealtime();
  }

  stopRealtime(): void {
    this.isRealtime = false;
    if (this.animationFrame) cancelAnimationFrame(this.animationFrame);
    this.updatePeakDisplay(-Infinity);
    this.lufsMomentaryEl.textContent = '-';
  }

  setPlaybackPosition(sample: number): void {
    this.lufsState.currentSample = sample;
  }

  updateRealtime(): void {
    if (!this.isRealtime || !this.analyserNode) return;

    const bufferLength = this.analyserNode.fftSize;
    const dataArray = new Float32Array(bufferLength);
    this.analyserNode.getFloatTimeDomainData(dataArray);

    let peak = 0;
    for (let i = 0; i < bufferLength; i++) {
      const abs = Math.abs(dataArray[i]);
      if (abs > peak) peak = abs;
    }
    const peakDb = peak > 0 ? 20 * Math.log10(peak) : -Infinity;
    this.updatePeakDisplay(peakDb);
    this.updateRealtimeLUFS();

    this.animationFrame = requestAnimationFrame(() => this.updateRealtime());
  }

  updateRealtimeLUFS(): void {
    if (!this.lufsState.kWeightedChannels || this.lufsState.kWeightedChannels.length === 0) return;

    const blockSize = this.lufsState.blockSize;
    const hopSize = Math.floor(blockSize / 4);
    const currentSample = this.lufsState.currentSample;
    const numChannels = this.lufsState.kWeightedChannels.length;
    const totalLength = this.lufsState.kWeightedChannels[0].length;
    const weights = CHANNEL_WEIGHTS[numChannels] || Array(numChannels).fill(1.0);

    while (this.lufsState.lastBlockSample + blockSize <= currentSample) {
      const blockStart = this.lufsState.lastBlockSample;
      if (blockStart + blockSize > totalLength) break;

      let blockSum = 0;
      for (let c = 0; c < numChannels; c++) {
        const weight = weights[c];
        if (weight === 0) continue;
        const kWeighted = this.lufsState.kWeightedChannels[c];
        let channelSum = 0;
        for (let i = 0; i < blockSize; i++) {
          const sample = kWeighted[blockStart + i];
          channelSum += sample * sample;
        }
        blockSum += weight * (channelSum / blockSize);
      }

      const blockLUFS = blockSum > 0 ? -0.691 + 10 * Math.log10(blockSum) : -Infinity;
      this.lufsState.integratedBlocks.push({ ms: blockSum, lufs: blockLUFS });
      this.lufsState.shortTermBlocks.push({ ms: blockSum, lufs: blockLUFS });
      this.lufsState.lastBlockSample += hopSize;
    }

    if (this.lufsState.shortTermBlocks.length > 30) {
      this.lufsState.shortTermBlocks = this.lufsState.shortTermBlocks.slice(-30);
    }

    this.displayRealtimeLUFS();
  }

  displayRealtimeLUFS(): void {
    const momentaryBlocks = this.lufsState.shortTermBlocks.slice(-4);
    const momentary = this.calculateGatedLUFS(momentaryBlocks, false);
    this.lufsMomentaryEl.textContent = isFinite(momentary) ? momentary.toFixed(1) + ' LUFS' : '-';

    const shortTerm = this.calculateGatedLUFS(this.lufsState.shortTermBlocks, false);
    this.lufsShortTermEl.textContent = isFinite(shortTerm) ? shortTerm.toFixed(1) + ' LUFS' : '-';

    const integrated = this.calculateGatedLUFS(this.lufsState.integratedBlocks, true);
    this.lufsIntegratedEl.textContent = isFinite(integrated) ? integrated.toFixed(1) + ' LUFS' : '-';
  }

  calculateGatedLUFS(blocks: Array<{ ms: number; lufs: number }>, useGating: boolean): number {
    if (blocks.length === 0) return -Infinity;

    if (!useGating) {
      const sum = blocks.reduce((a, b) => a + b.ms, 0);
      const mean = sum / blocks.length;
      return mean > 0 ? -0.691 + 10 * Math.log10(mean) : -Infinity;
    }

    const absoluteGated = blocks.filter(b => b.lufs > -70);
    if (absoluteGated.length === 0) return -Infinity;

    const absoluteSum = absoluteGated.reduce((a, b) => a + b.ms, 0);
    const absoluteMean = absoluteSum / absoluteGated.length;
    const ungatedLoudness = absoluteMean > 0 ? -0.691 + 10 * Math.log10(absoluteMean) : -Infinity;

    const relativeThreshold = ungatedLoudness - 10;
    const relativeGated = blocks.filter(b => b.lufs > relativeThreshold);
    if (relativeGated.length === 0) return -Infinity;

    const finalSum = relativeGated.reduce((a, b) => a + b.ms, 0);
    const finalMean = finalSum / relativeGated.length;
    return finalMean > 0 ? -0.691 + 10 * Math.log10(finalMean) : -Infinity;
  }

  updatePeakDisplay(peakDb: number): void {
    this.peakValue.textContent = isFinite(peakDb) ? peakDb.toFixed(1) : '-∞';
    this.peakValue.className = 'meter-value' + this.getColorClass(peakDb);
    this.peakBar.style.width = this.dbToPercent(peakDb) + '%';
  }

  getColorClass(db: number): string {
    if (db >= -1) return ' danger';
    if (db >= -6) return ' warning';
    return '';
  }

  dbToPercent(db: number): number {
    if (!isFinite(db)) return 0;
    return Math.max(0, Math.min(100, (db + 60) / 60 * 100));
  }

  reset(): void {
    this.updatePeakDisplay(-Infinity);
    this.fileStats = { rmsPeak: null, truePeak: null, lufs: null };
    this.updateFileStatsDisplay();
    this.lufsState.kWeightedChannels = null;
    this.lufsState.integratedBlocks = [];
    this.lufsState.shortTermBlocks = [];
    this.lufsIntegratedEl.textContent = '-';
    this.lufsShortTermEl.textContent = '-';
    this.lufsMomentaryEl.textContent = '-';
  }
}
