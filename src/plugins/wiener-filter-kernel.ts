/**
 * Wiener Filter DSP kernel — pure math, no AudioWorklet dependency.
 *
 * Contains:
 * - Cooley-Tukey radix-2 FFT / IFFT
 * - Hanning window generation
 * - PSD estimation and Wiener gain computation
 * - WienerFilterKernel: stateful overlap-add processor
 */

// ==================== FFT (Cooley-Tukey radix-2) ====================

/**
 * In-place Cooley-Tukey radix-2 FFT.
 * @param real - real part (length must be power of 2), modified in place
 * @param imag - imaginary part (same length), modified in place
 */
export function fft(real: Float64Array, imag: Float64Array): void {
  const N = real.length;
  if (N <= 1) return;

  // Bit-reversal permutation
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

  // Butterfly stages
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

/**
 * In-place inverse FFT. Applies conjugate → FFT → conjugate → scale by 1/N.
 */
export function ifft(real: Float64Array, imag: Float64Array): void {
  const N = real.length;
  // Conjugate
  for (let i = 0; i < N; i++) imag[i] = -imag[i];
  fft(real, imag);
  // Conjugate and scale
  const invN = 1 / N;
  for (let i = 0; i < N; i++) {
    real[i] *= invN;
    imag[i] = -imag[i] * invN;
  }
}

// ==================== Hanning Window ====================

/**
 * Generate a Hanning window of length N.
 * w[n] = 0.5 * (1 - cos(2πn / (N-1)))
 */
export function hanningWindow(N: number): Float64Array {
  const w = new Float64Array(N);
  const factor = 2 * Math.PI / (N - 1);
  for (let i = 0; i < N; i++) {
    w[i] = 0.5 * (1 - Math.cos(factor * i));
  }
  return w;
}

// ==================== PSD / Wiener Gain ====================

/**
 * Compute |X(f)|² = real² + imag² for each frequency bin.
 */
export function computeMagnitudeSquared(real: Float64Array, imag: Float64Array): Float64Array {
  const N = real.length;
  const result = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    result[i] = real[i] * real[i] + imag[i] * imag[i];
  }
  return result;
}

/** Minimum gain floor to avoid total silence artifacts. */
const GAIN_FLOOR = 0.001;

/**
 * Compute Wiener filter gain: H(f) = P_signal(f) / (P_signal(f) + P_noise(f))
 * With reduction strength: gain = lerp(1.0, H(f), strength)
 *
 * @param signalPSD - estimated signal PSD (|X(f)|² of noisy signal)
 * @param noisePSD - estimated noise PSD (learned from noise-only segment)
 * @param strength - reduction strength in [0, 1]
 */
export function computeWienerGain(
  signalPSD: Float64Array,
  noisePSD: Float64Array,
  strength: number,
): Float64Array {
  const N = signalPSD.length;
  const gain = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const denom = signalPSD[i] + noisePSD[i];
    const h = denom > 0 ? signalPSD[i] / denom : GAIN_FLOOR;
    // Clamp to floor
    const clamped = Math.max(GAIN_FLOOR, h);
    // Interpolate with strength: 0 = no reduction, 1 = full reduction
    gain[i] = 1.0 - strength * (1.0 - clamped);
  }
  return gain;
}

// ==================== WienerFilterKernel ====================

/**
 * Stateful Wiener filter processor with overlap-add.
 *
 * Usage:
 *   1. Construct with FFT size and sample rate
 *   2. Call learnNoise() with a noise-only segment
 *   3. Call process() with hop-sized blocks (fftSize/2 samples each)
 *
 * The kernel processes mono audio. For stereo, use two instances.
 */
export class WienerFilterKernel {
  readonly fftSize: number;
  readonly hopSize: number;

  /** Reduction strength 0-1 (maps to 0-100% UI). */
  reductionStrength = 0.5;
  /** PSD smoothing factor (exponential moving average alpha). */
  smoothingFactor = 0.98;

  private window: Float64Array;
  private noisePSD: Float64Array | null = null;

  // Overlap-add state
  private prevInput: Float32Array;    // previous hop for overlap
  private overlapBuffer: Float64Array; // accumulated overlap output

  // Smoothed signal PSD
  private smoothedPSD: Float64Array;

  constructor(fftSize: number, _sampleRate: number) {
    this.fftSize = fftSize;
    this.hopSize = fftSize >> 1; // 50% overlap
    this.window = hanningWindow(fftSize);
    this.prevInput = new Float32Array(this.hopSize);
    this.overlapBuffer = new Float64Array(this.hopSize);
    this.smoothedPSD = new Float64Array(fftSize);
  }

  get hasNoiseProfile(): boolean {
    return this.noisePSD !== null;
  }

  /**
   * Learn noise PSD from a noise-only audio segment.
   * Averages PSD across overlapping frames of the segment.
   */
  learnNoise(samples: Float32Array): void {
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

  /** Clear the learned noise profile. */
  clearNoise(): void {
    this.noisePSD = null;
  }

  /**
   * Process one hop-sized block (hopSize samples).
   * Uses overlap-add with 50% overlap and Hanning window.
   *
   * @param input - input samples (length = hopSize)
   * @param output - output samples (length = hopSize), written in place
   */
  process(input: Float32Array, output: Float32Array): void {
    const N = this.fftSize;
    const hop = this.hopSize;

    if (!this.noisePSD) {
      // No noise profile — passthrough
      for (let i = 0; i < hop; i++) output[i] = input[i];
      this.prevInput.set(input);
      return;
    }

    // Assemble full FFT frame: [prevInput | input]
    const real = new Float64Array(N);
    const imag = new Float64Array(N);
    for (let i = 0; i < hop; i++) {
      real[i] = this.prevInput[i] * this.window[i];
    }
    for (let i = 0; i < hop; i++) {
      real[hop + i] = input[i] * this.window[hop + i];
    }

    // FFT
    fft(real, imag);

    // Compute signal PSD and smooth
    const psd = computeMagnitudeSquared(real, imag);
    const alpha = this.smoothingFactor;
    for (let i = 0; i < N; i++) {
      this.smoothedPSD[i] = alpha * this.smoothedPSD[i] + (1 - alpha) * psd[i];
    }

    // Compute Wiener gain
    const gain = computeWienerGain(this.smoothedPSD, this.noisePSD, this.reductionStrength);

    // Apply gain in frequency domain
    for (let i = 0; i < N; i++) {
      real[i] *= gain[i];
      imag[i] *= gain[i];
    }

    // IFFT
    ifft(real, imag);

    // Overlap-add: output the first hop samples (sum with previous overlap)
    for (let i = 0; i < hop; i++) {
      output[i] = (this.overlapBuffer[i] + real[i]) as number;
    }

    // Store second half for next overlap
    for (let i = 0; i < hop; i++) {
      this.overlapBuffer[i] = real[hop + i];
    }

    // Save current input for next frame
    this.prevInput.set(input);
  }
}
