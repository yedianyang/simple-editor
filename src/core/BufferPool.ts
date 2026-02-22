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

  clear(): void {
    this.buffers.clear();
  }
}
