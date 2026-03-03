/**
 * Wiener Filter AudioWorkletProcessor.
 *
 * Self-contained — includes FFT and kernel functions inline
 * because AudioWorklet scope cannot import ES modules.
 *
 * Architecture:
 *   - Buffers 128-sample AudioWorklet blocks into 512-sample hops
 *   - Processes each hop through WienerFilterKernel (1024 FFT, 50% overlap-add)
 *   - Dual mono: each channel gets its own kernel instance
 *
 * MessagePort commands:
 *   { type: 'learnNoise', samples: Float32Array }
 *   { type: 'clearNoise' }
 *   { type: 'setReductionStrength', value: number }
 *   { type: 'setSmoothingFactor', value: number }
 */

// ==================== FFT (Cooley-Tukey radix-2) ====================

function fft(real, imag) {
  const N = real.length;
  if (N <= 1) return;

  let j = 0;
  for (let i = 0; i < N; i++) {
    if (i < j) {
      let tmp = real[i]; real[i] = real[j]; real[j] = tmp;
      tmp = imag[i]; imag[i] = imag[j]; imag[j] = tmp;
    }
    let m = N >> 1;
    while (m >= 1 && j >= m) {
      j -= m;
      m >>= 1;
    }
    j += m;
  }

  for (let size = 2; size <= N; size <<= 1) {
    const halfSize = size >> 1;
    const angle = -2 * Math.PI / size;
    const wReal = Math.cos(angle);
    const wImag = Math.sin(angle);

    for (let i = 0; i < N; i += size) {
      let curReal = 1;
      let curImag = 0;

      for (let k = 0; k < halfSize; k++) {
        const evenIdx = i + k;
        const oddIdx = i + k + halfSize;

        const tReal = curReal * real[oddIdx] - curImag * imag[oddIdx];
        const tImag = curReal * imag[oddIdx] + curImag * real[oddIdx];

        real[oddIdx] = real[evenIdx] - tReal;
        imag[oddIdx] = imag[evenIdx] - tImag;
        real[evenIdx] += tReal;
        imag[evenIdx] += tImag;

        const nextReal = curReal * wReal - curImag * wImag;
        const nextImag = curReal * wImag + curImag * wReal;
        curReal = nextReal;
        curImag = nextImag;
      }
    }
  }
}

function ifft(real, imag) {
  const N = real.length;
  for (let i = 0; i < N; i++) imag[i] = -imag[i];
  fft(real, imag);
  const invN = 1 / N;
  for (let i = 0; i < N; i++) {
    real[i] *= invN;
    imag[i] = -imag[i] * invN;
  }
}

// ==================== Window & PSD ====================

function hanningWindow(N) {
  const w = new Float64Array(N);
  const factor = 2 * Math.PI / (N - 1);
  for (let i = 0; i < N; i++) {
    w[i] = 0.5 * (1 - Math.cos(factor * i));
  }
  return w;
}

function computeMagnitudeSquared(real, imag) {
  const N = real.length;
  const result = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    result[i] = real[i] * real[i] + imag[i] * imag[i];
  }
  return result;
}

const GAIN_FLOOR = 0.001;

function computeWienerGain(signalPSD, noisePSD, strength) {
  const N = signalPSD.length;
  const gain = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const denom = signalPSD[i] + noisePSD[i];
    const h = denom > 0 ? signalPSD[i] / denom : GAIN_FLOOR;
    const clamped = Math.max(GAIN_FLOOR, h);
    gain[i] = 1.0 - strength * (1.0 - clamped);
  }
  return gain;
}

// ==================== WienerFilterKernel ====================

class WienerFilterKernel {
  constructor(fftSize, sr) {
    this.fftSize = fftSize;
    this.hopSize = fftSize >> 1;
    this.reductionStrength = 0.5;
    this.smoothingFactor = 0.98;
    this.window = hanningWindow(fftSize);
    this.noisePSD = null;
    this.prevInput = new Float32Array(this.hopSize);
    this.overlapBuffer = new Float64Array(this.hopSize);
    this.smoothedPSD = new Float64Array(fftSize);
  }

  get hasNoiseProfile() {
    return this.noisePSD !== null;
  }

  learnNoise(samples) {
    const N = this.fftSize;
    const hop = this.hopSize;
    const avgPSD = new Float64Array(N);
    let frameCount = 0;

    for (let offset = 0; offset + N <= samples.length; offset += hop) {
      const real = new Float64Array(N);
      const imag = new Float64Array(N);
      for (let i = 0; i < N; i++) {
        real[i] = samples[offset + i] * this.window[i];
      }
      fft(real, imag);
      const psd = computeMagnitudeSquared(real, imag);
      for (let i = 0; i < N; i++) avgPSD[i] += psd[i];
      frameCount++;
    }

    if (frameCount > 0) {
      const invCount = 1 / frameCount;
      for (let i = 0; i < N; i++) avgPSD[i] *= invCount;
    }

    this.noisePSD = avgPSD;
  }

  clearNoise() {
    this.noisePSD = null;
  }

  process(input, output) {
    const N = this.fftSize;
    const hop = this.hopSize;

    if (!this.noisePSD) {
      for (let i = 0; i < hop; i++) output[i] = input[i];
      this.prevInput.set(input);
      return;
    }

    const real = new Float64Array(N);
    const imag = new Float64Array(N);
    for (let i = 0; i < hop; i++) {
      real[i] = this.prevInput[i] * this.window[i];
    }
    for (let i = 0; i < hop; i++) {
      real[hop + i] = input[i] * this.window[hop + i];
    }

    fft(real, imag);

    const psd = computeMagnitudeSquared(real, imag);
    const alpha = this.smoothingFactor;
    for (let i = 0; i < N; i++) {
      this.smoothedPSD[i] = alpha * this.smoothedPSD[i] + (1 - alpha) * psd[i];
    }

    const gain = computeWienerGain(this.smoothedPSD, this.noisePSD, this.reductionStrength);

    for (let i = 0; i < N; i++) {
      real[i] *= gain[i];
      imag[i] *= gain[i];
    }

    ifft(real, imag);

    for (let i = 0; i < hop; i++) {
      output[i] = this.overlapBuffer[i] + real[i];
    }
    for (let i = 0; i < hop; i++) {
      this.overlapBuffer[i] = real[hop + i];
    }

    this.prevInput.set(input);
  }
}

// ==================== AudioWorkletProcessor ====================

class WienerFilterProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.fftSize = 1024;
    this.hopSize = 512;
    this.blockSize = 128; // AudioWorklet render quantum

    // Per-channel state (created lazily)
    this.kernels = [];
    this.inputBuffers = [];
    this.outputBuffers = [];
    this.inputWritePos = [];
    this.outputReadPos = [];
    this.outputReady = [];

    this.port.onmessage = (e) => this.handleMessage(e);
  }

  ensureChannels(numChannels) {
    while (this.kernels.length < numChannels) {
      const k = new WienerFilterKernel(this.fftSize, sampleRate);
      this.kernels.push(k);
      this.inputBuffers.push(new Float32Array(this.hopSize));
      this.outputBuffers.push(new Float32Array(this.hopSize));
      this.inputWritePos.push(0);
      this.outputReadPos.push(0);
      this.outputReady.push(0);
    }
  }

  handleMessage(e) {
    const { type } = e.data;
    if (type === 'learnNoise') {
      const samples = new Float32Array(e.data.samples);
      for (const k of this.kernels) k.learnNoise(samples);
      this.port.postMessage({ type: 'noiseProfileLearned' });
    } else if (type === 'clearNoise') {
      for (const k of this.kernels) k.clearNoise();
    } else if (type === 'setReductionStrength') {
      for (const k of this.kernels) k.reductionStrength = e.data.value;
    } else if (type === 'setSmoothingFactor') {
      for (const k of this.kernels) k.smoothingFactor = e.data.value;
    }
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input.length) return true;

    this.ensureChannels(input.length);

    for (let ch = 0; ch < input.length; ch++) {
      const inData = input[ch];
      const outData = output[ch];

      // Accumulate input into hop buffer
      this.inputBuffers[ch].set(inData, this.inputWritePos[ch]);
      this.inputWritePos[ch] += this.blockSize;

      // When hop buffer is full, process through kernel
      if (this.inputWritePos[ch] >= this.hopSize) {
        this.kernels[ch].process(this.inputBuffers[ch], this.outputBuffers[ch]);
        this.inputWritePos[ch] = 0;
        this.outputReadPos[ch] = 0;
        this.outputReady[ch] = this.hopSize;
      }

      // Read from output buffer
      if (this.outputReady[ch] > 0) {
        const pos = this.outputReadPos[ch];
        outData.set(this.outputBuffers[ch].subarray(pos, pos + this.blockSize));
        this.outputReadPos[ch] += this.blockSize;
        this.outputReady[ch] -= this.blockSize;
      } else {
        // Initial latency — no output yet
        outData.fill(0);
      }
    }

    return true;
  }
}

registerProcessor('wiener-filter-processor', WienerFilterProcessor);
