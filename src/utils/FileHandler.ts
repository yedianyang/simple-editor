/**
 * Multi-channel audio file import/export handler.
 * Supports WAV (up to 32-bit float) and AIF formats.
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
   * Import file from native file path (Electron).
   */
  static async importFilePath(filePath: string): Promise<ArrayBuffer> {
    if (window.electronAPI) {
      const buffer = await window.electronAPI.readFile(filePath);
      return (buffer as any).buffer || buffer;
    }
    throw new Error('File path import requires Electron');
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

  static exportWAV(audioBuffer: AudioBuffer, bitDepth = 16, dither = 'none'): Blob {
    const numChannels = audioBuffer.numberOfChannels;
    const sampleRate = audioBuffer.sampleRate;
    const length = audioBuffer.length;

    let bytesPerSample: number;
    let formatCode: number;
    if (bitDepth === 32) {
      bytesPerSample = 4;
      formatCode = 3; // Float
    } else {
      bytesPerSample = bitDepth / 8;
      formatCode = 1; // PCM
    }

    const dataSize = length * numChannels * bytesPerSample;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    // RIFF header
    this.writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    this.writeString(view, 8, 'WAVE');

    // fmt chunk
    this.writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, formatCode, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * numChannels * bytesPerSample, true);
    view.setUint16(32, numChannels * bytesPerSample, true);
    view.setUint16(34, bitDepth, true);

    // data chunk
    this.writeString(view, 36, 'data');
    view.setUint32(40, dataSize, true);

    const channels: Float32Array[] = [];
    for (let c = 0; c < numChannels; c++) {
      channels.push(audioBuffer.getChannelData(c));
    }

    const noiseShaper = dither === 'shaped' ? this.createNoiseShaper(numChannels) : null;

    let offset = 44;
    for (let i = 0; i < length; i++) {
      for (let c = 0; c < numChannels; c++) {
        let sample = channels[c][i];

        if (bitDepth === 32) {
          view.setFloat32(offset, sample, true);
        } else if (bitDepth === 24) {
          if (dither === 'tpdf') sample += this.ditherTPDF(24);
          else if (dither === 'shaped' && noiseShaper) sample = noiseShaper.process(sample, c, 24);
          const intSample = Math.round(Math.max(-1, Math.min(1, sample)) * 0x7FFFFF);
          view.setUint8(offset, intSample & 0xFF);
          view.setUint8(offset + 1, (intSample >> 8) & 0xFF);
          view.setUint8(offset + 2, (intSample >> 16) & 0xFF);
        } else {
          if (dither === 'tpdf') sample += this.ditherTPDF(16);
          else if (dither === 'shaped' && noiseShaper) sample = noiseShaper.process(sample, c, 16);
          const intSample = Math.round(Math.max(-1, Math.min(1, sample)) * 0x7FFF);
          view.setInt16(offset, intSample, true);
        }
        offset += bytesPerSample;
      }
    }

    return new Blob([buffer], { type: 'audio/wav' });
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

  /**
   * Export individual channels as separate WAV files.
   */
  static exportChannelWAVs(audioBuffer: AudioBuffer, bitDepth = 24, dither = 'none'): Blob[] {
    const blobs: Blob[] = [];
    const ctx = new OfflineAudioContext(1, audioBuffer.length, audioBuffer.sampleRate);

    for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
      const monoBuffer = ctx.createBuffer(1, audioBuffer.length, audioBuffer.sampleRate);
      monoBuffer.getChannelData(0).set(audioBuffer.getChannelData(c));
      blobs.push(this.exportWAV(monoBuffer, bitDepth, dither));
    }
    return blobs;
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
