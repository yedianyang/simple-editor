import { PooledBuffer } from './types';

let idCounter = 0;

function generateId(): string {
  idCounter++;
  const rand = Math.random().toString(36).substring(2, 8);
  return `buf_${idCounter}_${rand}`;
}

/**
 * Manages mono AudioBuffers with reference counting.
 * Multi-channel files are split into individual mono PooledBuffers.
 */
export class BufferPool {
  private buffers = new Map<string, PooledBuffer>();

  /** Store a mono AudioBuffer, returns unique ID. */
  addBuffer(buffer: AudioBuffer, sourceFileName: string, channelIndex: number): string {
    const id = generateId();
    this.buffers.set(id, {
      id,
      buffer,
      sampleRate: buffer.sampleRate,
      length: buffer.length,
      sourceFileName,
      sourceChannelIndex: channelIndex,
      refCount: 1,
    });
    return id;
  }

  /**
   * Split an N-channel AudioBuffer into N mono PooledBuffers.
   * Returns an array of IDs (one per channel).
   */
  importMultiChannel(buffer: AudioBuffer, sourceFileName: string): string[] {
    const ids: string[] = [];
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      const monoBuffer = new OfflineAudioContext(1, buffer.length, buffer.sampleRate)
        .createBuffer(1, buffer.length, buffer.sampleRate);
      monoBuffer.copyToChannel(buffer.getChannelData(ch), 0);
      ids.push(this.addBuffer(monoBuffer, sourceFileName, ch));
    }
    return ids;
  }

  /**
   * Create mono PooledBuffers directly from a flat Float32Array (IPC data).
   * Skips the intermediate multi-channel AudioBuffer — only 1 copy per channel
   * (subarray view → copyToChannel).
   * Layout: [ch0_all_samples, ch1_all_samples, ...]
   */
  importFromRawChannels(
    samples: Float32Array,
    numChannels: number,
    numSamples: number,
    sampleRate: number,
    sourceFileName: string,
  ): string[] {
    const ids: string[] = [];
    for (let ch = 0; ch < numChannels; ch++) {
      const offset = ch * numSamples;
      const channelView = samples.subarray(offset, offset + numSamples) as Float32Array<ArrayBuffer>;
      const monoCtx = new OfflineAudioContext(1, numSamples, sampleRate);
      const monoBuffer = monoCtx.createBuffer(1, numSamples, sampleRate);
      monoBuffer.copyToChannel(channelView, 0);
      ids.push(this.addBuffer(monoBuffer, sourceFileName, ch));
    }
    return ids;
  }

  getBuffer(id: string): PooledBuffer | null {
    return this.buffers.get(id) ?? null;
  }

  addRef(id: string): void {
    const entry = this.buffers.get(id);
    if (entry) entry.refCount++;
  }

  /** Decrement refCount; remove buffer when it reaches 0. */
  release(id: string): void {
    const entry = this.buffers.get(id);
    if (!entry) return;
    entry.refCount--;
    if (entry.refCount <= 0) {
      this.buffers.delete(id);
    }
  }

  /**
   * Create a new buffer with reversed channel data.
   * Returns the new buffer's ID.
   */
  createReversedBuffer(bufferId: string): string | null {
    const pooled = this.buffers.get(bufferId);
    if (!pooled) return null;

    const src = pooled.buffer;
    const ctx = new OfflineAudioContext(1, src.length, src.sampleRate);
    const reversed = ctx.createBuffer(1, src.length, src.sampleRate);

    const srcData = src.getChannelData(0);
    const dstData = reversed.getChannelData(0);
    for (let i = 0, j = srcData.length - 1; i < srcData.length; i++, j--) {
      dstData[i] = srcData[j];
    }

    return this.addBuffer(reversed, pooled.sourceFileName + ' [reversed]', pooled.sourceChannelIndex);
  }

  /**
   * Create a new buffer normalized to a target dB level.
   * Only the region [sourceStart, sourceEnd) is analysed for peak;
   * the entire buffer is scaled by the same gain factor.
   * Returns the new buffer's ID.
   */
  createNormalizedBuffer(
    bufferId: string,
    sourceStart: number,
    sourceEnd: number,
    targetDb: number,
  ): string | null {
    const pooled = this.buffers.get(bufferId);
    if (!pooled) return null;

    const src = pooled.buffer;
    const srcData = src.getChannelData(0);

    // Find peak in the specified region
    const start = Math.max(0, sourceStart);
    const end = Math.min(srcData.length, sourceEnd);
    let peak = 0;
    for (let i = start; i < end; i++) {
      const abs = Math.abs(srcData[i]);
      if (abs > peak) peak = abs;
    }

    if (peak === 0) return null; // silence — nothing to normalize

    const targetLinear = Math.pow(10, targetDb / 20);
    const gain = targetLinear / peak;

    const ctx = new OfflineAudioContext(1, src.length, src.sampleRate);
    const normalized = ctx.createBuffer(1, src.length, src.sampleRate);
    const dstData = normalized.getChannelData(0);

    for (let i = 0; i < srcData.length; i++) {
      dstData[i] = srcData[i] * gain;
    }

    return this.addBuffer(normalized, pooled.sourceFileName + ' [normalized]', pooled.sourceChannelIndex);
  }

  clear(): void {
    this.buffers.clear();
  }
}
