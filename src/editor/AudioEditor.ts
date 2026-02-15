/**
 * Audio editing operations for multi-channel buffers.
 * All operations are non-destructive (create new buffers) or in-place
 * with undo support.
 */
export class AudioEditor {
  audioContext: AudioContext;

  constructor(audioContext: AudioContext) {
    this.audioContext = audioContext;
  }

  createBuffer(length: number, numChannels: number, sampleRate: number): AudioBuffer {
    return this.audioContext.createBuffer(numChannels, length, sampleRate);
  }

  trim(audioBuffer: AudioBuffer, startSample: number, endSample: number): AudioBuffer {
    const numChannels = audioBuffer.numberOfChannels;
    const sampleRate = audioBuffer.sampleRate;
    const newLength = endSample - startSample;
    const newBuffer = this.createBuffer(newLength, numChannels, sampleRate);

    for (let c = 0; c < numChannels; c++) {
      const oldData = audioBuffer.getChannelData(c);
      const newData = newBuffer.getChannelData(c);
      for (let i = 0; i < newLength; i++) {
        newData[i] = oldData[startSample + i];
      }
    }
    return newBuffer;
  }

  deleteSelection(audioBuffer: AudioBuffer, startSample: number, endSample: number): AudioBuffer | null {
    const numChannels = audioBuffer.numberOfChannels;
    const sampleRate = audioBuffer.sampleRate;
    const deleteLength = endSample - startSample;
    const newLength = audioBuffer.length - deleteLength;

    if (newLength <= 0) return null;

    const newBuffer = this.createBuffer(newLength, numChannels, sampleRate);

    for (let c = 0; c < numChannels; c++) {
      const oldData = audioBuffer.getChannelData(c);
      const newData = newBuffer.getChannelData(c);
      for (let i = 0; i < startSample; i++) {
        newData[i] = oldData[i];
      }
      for (let i = endSample; i < audioBuffer.length; i++) {
        newData[i - deleteLength] = oldData[i];
      }
    }
    return newBuffer;
  }

  normalize(audioBuffer: AudioBuffer, targetDbFS = 0, startSample = 0, endSample: number | null = null): AudioBuffer {
    if (endSample === null) endSample = audioBuffer.length;
    const numChannels = audioBuffer.numberOfChannels;

    let peak = 0;
    for (let c = 0; c < numChannels; c++) {
      const data = audioBuffer.getChannelData(c);
      for (let i = startSample; i < endSample; i++) {
        const abs = Math.abs(data[i]);
        if (abs > peak) peak = abs;
      }
    }

    if (peak === 0) return audioBuffer;

    const targetLinear = Math.pow(10, targetDbFS / 20);
    const gain = targetLinear / peak;

    for (let c = 0; c < numChannels; c++) {
      const data = audioBuffer.getChannelData(c);
      for (let i = startSample; i < endSample; i++) {
        data[i] *= gain;
      }
    }
    return audioBuffer;
  }

  /**
   * Normalize a single channel independently.
   */
  normalizeChannel(audioBuffer: AudioBuffer, channel: number, targetDbFS = 0, startSample = 0, endSample: number | null = null): AudioBuffer {
    if (endSample === null) endSample = audioBuffer.length;
    if (channel < 0 || channel >= audioBuffer.numberOfChannels) return audioBuffer;

    const data = audioBuffer.getChannelData(channel);
    let peak = 0;
    for (let i = startSample; i < endSample; i++) {
      const abs = Math.abs(data[i]);
      if (abs > peak) peak = abs;
    }

    if (peak === 0) return audioBuffer;

    const targetLinear = Math.pow(10, targetDbFS / 20);
    const gain = targetLinear / peak;

    for (let i = startSample; i < endSample; i++) {
      data[i] *= gain;
    }
    return audioBuffer;
  }

  fadeIn(audioBuffer: AudioBuffer, startSample: number, endSample: number): AudioBuffer {
    const numChannels = audioBuffer.numberOfChannels;
    const fadeLength = endSample - startSample;

    for (let c = 0; c < numChannels; c++) {
      const data = audioBuffer.getChannelData(c);
      for (let i = 0; i < fadeLength; i++) {
        const gain = i / fadeLength;
        data[startSample + i] *= gain;
      }
    }
    return audioBuffer;
  }

  fadeOut(audioBuffer: AudioBuffer, startSample: number, endSample: number): AudioBuffer {
    const numChannels = audioBuffer.numberOfChannels;
    const fadeLength = endSample - startSample;

    for (let c = 0; c < numChannels; c++) {
      const data = audioBuffer.getChannelData(c);
      for (let i = 0; i < fadeLength; i++) {
        const gain = 1 - (i / fadeLength);
        data[startSample + i] *= gain;
      }
    }
    return audioBuffer;
  }

  applyGain(audioBuffer: AudioBuffer, gainDb: number, startSample = 0, endSample: number | null = null): AudioBuffer {
    if (endSample === null) endSample = audioBuffer.length;
    const numChannels = audioBuffer.numberOfChannels;
    const gainLinear = Math.pow(10, gainDb / 20);

    for (let c = 0; c < numChannels; c++) {
      const data = audioBuffer.getChannelData(c);
      for (let i = startSample; i < endSample; i++) {
        data[i] *= gainLinear;
      }
    }
    return audioBuffer;
  }

  /**
   * Apply gain to a single channel.
   */
  applyChannelGain(audioBuffer: AudioBuffer, channel: number, gainDb: number, startSample = 0, endSample: number | null = null): AudioBuffer {
    if (endSample === null) endSample = audioBuffer.length;
    if (channel < 0 || channel >= audioBuffer.numberOfChannels) return audioBuffer;

    const gainLinear = Math.pow(10, gainDb / 20);
    const data = audioBuffer.getChannelData(channel);
    for (let i = startSample; i < endSample; i++) {
      data[i] *= gainLinear;
    }
    return audioBuffer;
  }

  reverse(audioBuffer: AudioBuffer, startSample = 0, endSample: number | null = null): AudioBuffer {
    if (endSample === null) endSample = audioBuffer.length;
    const numChannels = audioBuffer.numberOfChannels;

    for (let c = 0; c < numChannels; c++) {
      const data = audioBuffer.getChannelData(c);
      const region = data.slice(startSample, endSample);
      region.reverse();
      for (let i = 0; i < region.length; i++) {
        data[startSample + i] = region[i];
      }
    }
    return audioBuffer;
  }

  /**
   * Extract a single channel as a new mono AudioBuffer.
   */
  extractChannel(audioBuffer: AudioBuffer, channel: number): AudioBuffer {
    const sampleRate = audioBuffer.sampleRate;
    const length = audioBuffer.length;
    const newBuffer = this.createBuffer(length, 1, sampleRate);
    const srcData = audioBuffer.getChannelData(channel);
    const dstData = newBuffer.getChannelData(0);
    dstData.set(srcData);
    return newBuffer;
  }

  /**
   * Merge multiple mono buffers into a multi-channel buffer.
   */
  mergeChannels(buffers: AudioBuffer[]): AudioBuffer {
    if (buffers.length === 0) throw new Error('No buffers to merge');

    const sampleRate = buffers[0].sampleRate;
    const length = Math.min(...buffers.map(b => b.length));
    const numChannels = buffers.length;
    const newBuffer = this.createBuffer(length, numChannels, sampleRate);

    for (let c = 0; c < numChannels; c++) {
      const srcData = buffers[c].getChannelData(0);
      const dstData = newBuffer.getChannelData(c);
      for (let i = 0; i < length; i++) {
        dstData[i] = srcData[i];
      }
    }
    return newBuffer;
  }

  /**
   * Change the channel count of a buffer (upmix/downmix).
   */
  changeChannelCount(audioBuffer: AudioBuffer, targetChannels: number): AudioBuffer {
    const srcChannels = audioBuffer.numberOfChannels;
    if (srcChannels === targetChannels) return audioBuffer;

    const sampleRate = audioBuffer.sampleRate;
    const length = audioBuffer.length;
    const newBuffer = this.createBuffer(length, targetChannels, sampleRate);

    for (let c = 0; c < targetChannels; c++) {
      const dstData = newBuffer.getChannelData(c);
      if (c < srcChannels) {
        // Copy existing channel
        const srcData = audioBuffer.getChannelData(c);
        dstData.set(srcData);
      } else {
        // Duplicate from existing channels (wrap around)
        const srcData = audioBuffer.getChannelData(c % srcChannels);
        dstData.set(srcData);
      }
    }
    return newBuffer;
  }
}
