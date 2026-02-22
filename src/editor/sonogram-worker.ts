/**
 * Web Worker for STFT (Short-Time Fourier Transform) computation.
 * Self-contained — no external imports.
 *
 * Input:  { type: 'compute', channelData, sampleRate, fftSize, hopSize }
 * Output: { type: 'progress', percent } | { type: 'result', magnitudes, numFrames, numBins, ... }
 */

// ---- Hann window ----

function buildHannWindow(N: number): Float32Array {
  const w = new Float32Array(N);
  const factor = (2 * Math.PI) / (N - 1);
  for (let n = 0; n < N; n++) {
    w[n] = 0.5 * (1 - Math.cos(factor * n));
  }
  return w;
}

// ---- Radix-2 iterative in-place FFT ----

function bitReverse(x: number, bits: number): number {
  let result = 0;
  for (let i = 0; i < bits; i++) {
    result = (result << 1) | (x & 1);
    x >>= 1;
  }
  return result;
}

/**
 * In-place radix-2 Cooley-Tukey FFT.
 * `real` and `imag` are modified in place (length must be power of 2).
 */
function fft(real: Float32Array, imag: Float32Array): void {
  const n = real.length;
  const bits = Math.round(Math.log2(n));

  // Bit-reversal permutation
  for (let i = 0; i < n; i++) {
    const j = bitReverse(i, bits);
    if (j > i) {
      // Swap real
      const tr = real[i]; real[i] = real[j]; real[j] = tr;
      // Swap imag
      const ti = imag[i]; imag[i] = imag[j]; imag[j] = ti;
    }
  }

  // Butterfly stages
  for (let size = 2; size <= n; size *= 2) {
    const halfSize = size >> 1;
    const angleStep = -2 * Math.PI / size;

    // Pre-compute twiddle factors for this stage
    const twRe = new Float32Array(halfSize);
    const twIm = new Float32Array(halfSize);
    for (let k = 0; k < halfSize; k++) {
      const angle = angleStep * k;
      twRe[k] = Math.cos(angle);
      twIm[k] = Math.sin(angle);
    }

    for (let i = 0; i < n; i += size) {
      for (let j = 0; j < halfSize; j++) {
        const idx1 = i + j;
        const idx2 = idx1 + halfSize;
        const tReal = real[idx2] * twRe[j] - imag[idx2] * twIm[j];
        const tImag = real[idx2] * twIm[j] + imag[idx2] * twRe[j];
        real[idx2] = real[idx1] - tReal;
        imag[idx2] = imag[idx1] - tImag;
        real[idx1] += tReal;
        imag[idx1] += tImag;
      }
    }
  }
}

// ---- STFT computation ----

function computeSTFT(
  channelData: Float32Array,
  sampleRate: number,
  fftSize: number,
  hopSize: number,
): void {
  const numBins = fftSize >> 1;
  const numFrames = Math.max(0, Math.floor((channelData.length - fftSize) / hopSize) + 1);

  if (numFrames === 0) {
    self.postMessage({
      type: 'result',
      magnitudes: new Uint8Array(0),
      numFrames: 0,
      numBins,
      sampleRate,
      fftSize,
      hopSize,
    });
    return;
  }

  const window = buildHannWindow(fftSize);
  const magnitudes = new Uint8Array(numFrames * numBins);

  // dB range: map [-100, 0] dB → [0, 255]
  const dbMin = -100;
  const dbRange = -dbMin; // 100

  // Reference level for dB conversion (normalised to FFT size)
  const refLevel = 1.0 / fftSize;

  const real = new Float32Array(fftSize);
  const imag = new Float32Array(fftSize);

  let lastReportedPercent = -1;
  const progressInterval = Math.max(1, Math.floor(numFrames * 0.05));

  for (let frame = 0; frame < numFrames; frame++) {
    const offset = frame * hopSize;

    // Apply window and fill FFT input
    for (let i = 0; i < fftSize; i++) {
      real[i] = channelData[offset + i] * window[i];
      imag[i] = 0;
    }

    // In-place FFT
    fft(real, imag);

    // Compute magnitude → dB → quantize
    const base = frame * numBins;
    for (let k = 0; k < numBins; k++) {
      const mag = Math.sqrt(real[k] * real[k] + imag[k] * imag[k]);
      // dB relative to reference
      let db = 20 * Math.log10(mag * refLevel + 1e-10);
      // Clamp to [-100, 0]
      if (db < dbMin) db = dbMin;
      if (db > 0) db = 0;
      // Quantize to 0..255
      magnitudes[base + k] = ((db - dbMin) / dbRange * 255 + 0.5) | 0;
    }

    // Report progress every ~5%
    if (frame % progressInterval === 0 || frame === numFrames - 1) {
      const percent = Math.round((frame + 1) / numFrames * 100);
      if (percent !== lastReportedPercent) {
        lastReportedPercent = percent;
        self.postMessage({ type: 'progress', percent });
      }
    }
  }

  // Transfer the result (magnitudes buffer is transferred, not copied)
  self.postMessage(
    {
      type: 'result',
      magnitudes,
      numFrames,
      numBins,
      sampleRate,
      fftSize,
      hopSize,
    },
    [magnitudes.buffer] as any,
  );
}

// ---- Message handler ----

self.onmessage = (e: MessageEvent) => {
  const msg = e.data;
  if (msg.type === 'compute') {
    computeSTFT(
      msg.channelData,
      msg.sampleRate,
      msg.fftSize,
      msg.hopSize,
    );
  }
};
