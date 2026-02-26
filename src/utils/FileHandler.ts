import type { ParsedAudioData } from './TauriAPI';

/**
 * Multi-channel audio file import/export handler.
 * Supports AIF export and file import (WAV import via Rust parser).
 * WAV export has moved to src/core/WavEncoder.ts.
 */
export class FileHandler {
  static async importFile(file: File): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target!.result as ArrayBuffer);
      reader.onerror = (e) => reject(e);
      reader.readAsArrayBuffer(file);
    });
  }

  /**
   * Import file from native file path via Rust WAV decoder.
   * Returns pre-parsed Float32 PCM data — skips decodeAudioData entirely.
   * Falls back to localfile:// protocol + ArrayBuffer for non-WAV formats.
   */
  static async importFilePath(filePath: string): Promise<ParsedAudioData | ArrayBuffer> {
    if (!window.appAPI) {
      throw new Error('Native API not available');
    }

    const ext = filePath.toLowerCase().split('.').pop();
    const isWav = ext === 'wav' || ext === 'wave';

    if (isWav) {
      // Use Rust WAV parser — returns parsed Float32 PCM directly
      return window.appAPI.readLargeAudioFile(filePath);
    }

    // Non-WAV formats: read raw bytes, let decodeAudioData handle it
    return window.appAPI.readLargeFile(filePath);
  }

  // TPDF Dithering
  static ditherTPDF(bitDepth: number): number {
    const lsb = 1.0 / (1 << (bitDepth - 1));
    return (Math.random() - Math.random()) * lsb;
  }

  // Noise shaped dithering
  static createNoiseShaper(numChannels: number) {
    const errorBuffer = new Array(numChannels).fill(0);
    return {
      process: (sample: number, channel: number, bitDepth: number): number => {
        const lsb = 1.0 / (1 << (bitDepth - 1));
        const shaped = sample + errorBuffer[channel] * 0.5;
        const dithered = shaped + (Math.random() - Math.random()) * lsb;
        const scale = (1 << (bitDepth - 1)) - 1;
        const quantized = Math.round(Math.max(-1, Math.min(1, dithered)) * scale) / scale;
        errorBuffer[channel] = shaped - quantized;
        return quantized;
      }
    };
  }

  static exportAIF(audioBuffer: AudioBuffer, bitDepth = 16, dither = 'none'): Blob {
    const numChannels = audioBuffer.numberOfChannels;
    const sampleRate = audioBuffer.sampleRate;
    const length = audioBuffer.length;
    const bytesPerSample = bitDepth / 8;

    const dataSize = length * numChannels * bytesPerSample;
    const commSize = 18;
    const ssndSize = 8 + dataSize;
    const formSize = 4 + 8 + commSize + 8 + ssndSize;

    const buffer = new ArrayBuffer(12 + 8 + commSize + 8 + ssndSize);
    const view = new DataView(buffer);

    this.writeString(view, 0, 'FORM');
    view.setUint32(4, formSize, false);
    this.writeString(view, 8, 'AIFF');

    this.writeString(view, 12, 'COMM');
    view.setUint32(16, commSize, false);
    view.setInt16(20, numChannels, false);
    view.setUint32(22, length, false);
    view.setInt16(26, bitDepth, false);
    this.writeExtendedFloat(view, 28, sampleRate);

    const ssndOffset = 12 + 8 + commSize;
    this.writeString(view, ssndOffset, 'SSND');
    view.setUint32(ssndOffset + 4, ssndSize, false);
    view.setUint32(ssndOffset + 8, 0, false);
    view.setUint32(ssndOffset + 12, 0, false);

    const channels: Float32Array[] = [];
    for (let c = 0; c < numChannels; c++) {
      channels.push(audioBuffer.getChannelData(c));
    }

    const noiseShaper = dither === 'shaped' ? this.createNoiseShaper(numChannels) : null;

    let offset = ssndOffset + 16;
    for (let i = 0; i < length; i++) {
      for (let c = 0; c < numChannels; c++) {
        let sample = channels[c][i];

        if (bitDepth === 24) {
          if (dither === 'tpdf') sample += this.ditherTPDF(24);
          else if (dither === 'shaped' && noiseShaper) sample = noiseShaper.process(sample, c, 24);
          const intSample = Math.round(Math.max(-1, Math.min(1, sample)) * 0x7FFFFF);
          view.setUint8(offset, (intSample >> 16) & 0xFF);
          view.setUint8(offset + 1, (intSample >> 8) & 0xFF);
          view.setUint8(offset + 2, intSample & 0xFF);
        } else if (bitDepth === 32) {
          const intSample = Math.round(Math.max(-1, Math.min(1, sample)) * 0x7FFFFFFF);
          view.setInt32(offset, intSample, false);
        } else {
          if (dither === 'tpdf') sample += this.ditherTPDF(16);
          else if (dither === 'shaped' && noiseShaper) sample = noiseShaper.process(sample, c, 16);
          const intSample = Math.round(Math.max(-1, Math.min(1, sample)) * 0x7FFF);
          view.setInt16(offset, intSample, false);
        }
        offset += bytesPerSample;
      }
    }

    return new Blob([buffer], { type: 'audio/aiff' });
  }

  private static writeString(view: DataView, offset: number, string: string): void {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  }

  private static writeExtendedFloat(view: DataView, offset: number, value: number): void {
    let exponent = 16398;
    let mantissa = value;
    while (mantissa < 32768) {
      mantissa *= 2;
      exponent--;
    }
    view.setUint16(offset, exponent, false);
    view.setUint32(offset + 2, mantissa * 65536, false);
    view.setUint32(offset + 6, 0, false);
  }
}
