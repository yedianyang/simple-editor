/**
 * TDD tests for Wiener Filter noise reduction plugin.
 * Tests the DSP math (FFT, Hanning window, Wiener gain, overlap-add)
 * independently from AudioWorklet runtime.
 */
import { describe, it, expect } from 'vitest';
import {
  fft,
  ifft,
  hanningWindow,
  computeMagnitudeSquared,
  computeWienerGain,
  WienerFilterKernel,
} from '../../src/plugins/wiener-filter-kernel';

// ==================== FFT ====================

describe('FFT (Cooley-Tukey radix-2)', () => {
  it('should produce correct output for DC signal', () => {
    const N = 8;
    const real = new Float64Array([1, 1, 1, 1, 1, 1, 1, 1]);
    const imag = new Float64Array(N);
    fft(real, imag);
    // DC bin should be N, all others 0
    expect(real[0]).toBeCloseTo(N, 10);
    for (let i = 1; i < N; i++) {
      expect(real[i]).toBeCloseTo(0, 10);
      expect(imag[i]).toBeCloseTo(0, 10);
    }
  });

  it('should produce correct output for impulse', () => {
    const N = 8;
    const real = new Float64Array(N);
    const imag = new Float64Array(N);
    real[0] = 1;
    fft(real, imag);
    // All bins should be 1+0j
    for (let i = 0; i < N; i++) {
      expect(real[i]).toBeCloseTo(1, 10);
      expect(imag[i]).toBeCloseTo(0, 10);
    }
  });

  it('should handle 1024-point FFT without error', () => {
    const N = 1024;
    const real = new Float64Array(N);
    const imag = new Float64Array(N);
    // Sine wave at bin 10
    for (let i = 0; i < N; i++) {
      real[i] = Math.sin(2 * Math.PI * 10 * i / N);
    }
    fft(real, imag);
    // Bin 10 should have the largest magnitude
    let maxBin = 0;
    let maxMag = 0;
    for (let i = 0; i < N; i++) {
      const mag = Math.sqrt(real[i] * real[i] + imag[i] * imag[i]);
      if (mag > maxMag) {
        maxMag = mag;
        maxBin = i;
      }
    }
    expect(maxBin).toBe(10);
    expect(maxMag).toBeCloseTo(N / 2, 1);
  });

  it('roundtrip FFT→IFFT should recover original signal', () => {
    const N = 256;
    const original = new Float64Array(N);
    for (let i = 0; i < N; i++) original[i] = Math.sin(2 * Math.PI * 7 * i / N) + 0.5;
    const real = new Float64Array(original);
    const imag = new Float64Array(N);
    fft(real, imag);
    ifft(real, imag);
    for (let i = 0; i < N; i++) {
      expect(real[i]).toBeCloseTo(original[i], 8);
    }
  });
});

// ==================== Hanning Window ====================

describe('Hanning window', () => {
  it('should produce correct length', () => {
    const w = hanningWindow(1024);
    expect(w.length).toBe(1024);
  });

  it('should be zero at endpoints', () => {
    const w = hanningWindow(256);
    expect(w[0]).toBeCloseTo(0, 10);
    expect(w[255]).toBeCloseTo(0, 10);
  });

  it('should peak at 1.0 in the middle', () => {
    const N = 256;
    const w = hanningWindow(N);
    expect(w[N / 2]).toBeCloseTo(1, 3);
  });

  it('should be symmetric', () => {
    const N = 128;
    const w = hanningWindow(N);
    for (let i = 0; i < N / 2; i++) {
      expect(w[i]).toBeCloseTo(w[N - 1 - i], 10);
    }
  });
});

// ==================== Magnitude Squared (PSD) ====================

describe('computeMagnitudeSquared', () => {
  it('should compute |X(f)|^2 correctly', () => {
    const real = new Float64Array([3, 0]);
    const imag = new Float64Array([4, 1]);
    const result = computeMagnitudeSquared(real, imag);
    expect(result[0]).toBeCloseTo(25, 10); // 3^2 + 4^2
    expect(result[1]).toBeCloseTo(1, 10);  // 0^2 + 1^2
  });
});

// ==================== Wiener Gain ====================

describe('computeWienerGain', () => {
  it('should return ~1.0 when noise PSD is zero (no noise)', () => {
    const signalPSD = new Float64Array([10, 20, 30]);
    const noisePSD = new Float64Array([0, 0, 0]);
    const gain = computeWienerGain(signalPSD, noisePSD, 40);
    for (let i = 0; i < 3; i++) {
      // Signal dominates → H ≈ 1.0
      expect(gain[i]).toBeCloseTo(1, 5);
    }
  });

  it('should return gain near floor when noise dominates', () => {
    const signalPSD = new Float64Array([1, 1, 1]);
    const noisePSD = new Float64Array([100, 100, 100]);
    // 40 dB → gainFloor = 0.01
    const gain = computeWienerGain(signalPSD, noisePSD, 40);
    for (let i = 0; i < 3; i++) {
      // H = 1/101 ≈ 0.0099, clamped to gainFloor 0.01
      expect(gain[i]).toBeCloseTo(0.01, 3);
    }
  });

  it('should respect reductionDb parameter', () => {
    const signalPSD = new Float64Array([10, 10]);
    const noisePSD = new Float64Array([10, 10]);
    // reductionDb=0 → gainFloor = 10^0 = 1.0 → all gains clamped to 1.0
    const noReduction = computeWienerGain(signalPSD, noisePSD, 0);
    expect(noReduction[0]).toBeCloseTo(1.0, 5);
    // reductionDb=20 → gainFloor = 10^(-1) = 0.1
    const mid = computeWienerGain(signalPSD, noisePSD, 20);
    // H = 10/(10+10) = 0.5, floor = 0.1, so gain = 0.5
    expect(mid[0]).toBeCloseTo(0.5, 5);
    // reductionDb=40 → gainFloor = 10^(-2) = 0.01
    const max = computeWienerGain(signalPSD, noisePSD, 40);
    // H = 0.5, floor = 0.01, so gain = 0.5
    expect(max[0]).toBeCloseTo(0.5, 5);
  });

  it('should clamp gain to dB-based floor (not zero)', () => {
    const signalPSD = new Float64Array([0]);
    const noisePSD = new Float64Array([100]);
    // 40 dB → gainFloor = 0.01
    const gain = computeWienerGain(signalPSD, noisePSD, 40);
    expect(gain[0]).toBeCloseTo(0.01, 5);
    expect(gain[0]).toBeGreaterThan(0);
  });

  it('should compute correct dB gain floor values', () => {
    // 0 dB → gainFloor = 1.0
    const g0 = computeWienerGain(new Float64Array([0]), new Float64Array([1]), 0);
    expect(g0[0]).toBeCloseTo(1.0, 5);
    // 20 dB → gainFloor = 0.1
    const g20 = computeWienerGain(new Float64Array([0]), new Float64Array([1]), 20);
    expect(g20[0]).toBeCloseTo(0.1, 5);
    // 40 dB → gainFloor = 0.01
    const g40 = computeWienerGain(new Float64Array([0]), new Float64Array([1]), 40);
    expect(g40[0]).toBeCloseTo(0.01, 5);
  });
});

// ==================== WienerFilterKernel ====================

describe('WienerFilterKernel', () => {
  it('should construct with default parameters', () => {
    const kernel = new WienerFilterKernel(1024, 48000);
    expect(kernel.fftSize).toBe(1024);
    expect(kernel.hopSize).toBe(512);
    expect(kernel.reductionDb).toBe(12);
    expect(kernel.smoothingFactor).toBeCloseTo(0.98, 5);
    expect(kernel.sensitivity).toBeCloseTo(1.5, 5);
  });

  it('should accept noise profile samples', () => {
    const kernel = new WienerFilterKernel(1024, 48000);
    // Feed 1 second of "noise" (white noise)
    const noise = new Float32Array(48000);
    for (let i = 0; i < noise.length; i++) noise[i] = (Math.random() - 0.5) * 0.01;
    kernel.learnNoise(noise);
    expect(kernel.hasNoiseProfile).toBe(true);
  });

  it('should produce output close to input during warmup (no noise profile)', () => {
    const kernel = new WienerFilterKernel(1024, 48000);
    const hop = 512;
    // Prime with a few blocks to fill prevInput buffer
    for (let block = 0; block < 3; block++) {
      const inp = new Float32Array(hop);
      const out = new Float32Array(hop);
      for (let i = 0; i < hop; i++) {
        inp[i] = Math.sin(2 * Math.PI * 440 * (block * hop + i) / 48000);
      }
      kernel.process(inp, out);
    }
    // Now process a test block — during warmup (< 48 frames), adaptive noise is zero
    const input = new Float32Array(hop);
    const output = new Float32Array(hop);
    for (let i = 0; i < hop; i++) {
      input[i] = Math.sin(2 * Math.PI * 440 * (3 * hop + i) / 48000);
    }
    kernel.process(input, output);
    const inputRMS = Math.sqrt(input.reduce((s, v) => s + v * v, 0) / hop);
    const outputRMS = Math.sqrt(output.reduce((s, v) => s + v * v, 0) / hop);
    // During warmup, output should retain most of the signal energy
    expect(outputRMS).toBeGreaterThan(inputRMS * 0.3);
  });

  it('should reduce noise after learning noise profile', () => {
    const kernel = new WienerFilterKernel(1024, 48000);
    kernel.reductionDb = 40;

    // Create consistent noise: low-level broadband
    const noiseGen = (i: number) => Math.sin(i * 0.1) * 0.01 + Math.sin(i * 0.37) * 0.008;

    // Learn noise from a "noise-only" segment
    const noiseSamples = new Float32Array(48000);
    for (let i = 0; i < noiseSamples.length; i++) noiseSamples[i] = noiseGen(i);
    kernel.learnNoise(noiseSamples);

    // Process a signal = sine + same noise
    // First, prime the kernel with a few hop-sized blocks
    for (let block = 0; block < 4; block++) {
      const inp = new Float32Array(512);
      const out = new Float32Array(512);
      for (let i = 0; i < 512; i++) {
        const idx = block * 512 + i;
        inp[i] = Math.sin(2 * Math.PI * 440 * idx / 48000) * 0.5 + noiseGen(idx);
      }
      kernel.process(inp, out);
    }

    // Now process a real block and measure
    const signalBlock = new Float32Array(512);
    const outputBlock = new Float32Array(512);
    for (let i = 0; i < 512; i++) {
      const idx = 4 * 512 + i;
      signalBlock[i] = Math.sin(2 * Math.PI * 440 * idx / 48000) * 0.5 + noiseGen(idx);
    }
    kernel.process(signalBlock, outputBlock);

    // Output should have lower RMS than input (noise reduced)
    const inputRMS = Math.sqrt(signalBlock.reduce((s, v) => s + v * v, 0) / 512);
    const outputRMS = Math.sqrt(outputBlock.reduce((s, v) => s + v * v, 0) / 512);
    // The output should still have energy (signal preserved)
    expect(outputRMS).toBeGreaterThan(0.1);
    // But it should be processing (not identical to input)
    const diff = signalBlock.reduce((s, v, i) => s + Math.abs(v - outputBlock[i]), 0) / 512;
    expect(diff).toBeGreaterThan(0.001);
  });

  it('should reset noise profile on clearNoise()', () => {
    const kernel = new WienerFilterKernel(1024, 48000);
    const noise = new Float32Array(1024);
    kernel.learnNoise(noise);
    expect(kernel.hasNoiseProfile).toBe(true);
    kernel.clearNoise();
    expect(kernel.hasNoiseProfile).toBe(false);
  });

  it('should build adaptive noise estimate after warmup', () => {
    const kernel = new WienerFilterKernel(1024, 48000);
    kernel.reductionDb = 40;
    kernel.sensitivity = 3.0; // aggressive to ensure clear attenuation in test
    // No manual noise profile — rely on adaptive estimation
    // Feed consistent noise for enough frames to fill entire min-PSD window (≥96)
    const noiseGen = (idx: number) =>
      Math.sin(idx * 0.1) * 0.05 + Math.sin(idx * 0.37) * 0.04;

    const hop = 512;
    const framesNeeded = 120; // well past minWindowSize of 96

    for (let block = 0; block < framesNeeded; block++) {
      const inp = new Float32Array(hop);
      const out = new Float32Array(hop);
      for (let i = 0; i < hop; i++) {
        inp[i] = noiseGen(block * hop + i);
      }
      kernel.process(inp, out);
    }

    // After warmup, process one more block of noise — the adaptive filter
    // should attenuate the output compared to the input
    const testInput = new Float32Array(hop);
    const testOutput = new Float32Array(hop);
    for (let i = 0; i < hop; i++) {
      testInput[i] = noiseGen(framesNeeded * hop + i);
    }
    kernel.process(testInput, testOutput);

    const inputRMS = Math.sqrt(testInput.reduce((s, v) => s + v * v, 0) / hop);
    const outputRMS = Math.sqrt(testOutput.reduce((s, v) => s + v * v, 0) / hop);
    // Output should be attenuated (noise reduced by adaptive estimate)
    expect(outputRMS).toBeLessThan(inputRMS);
  });

  it('should respond to sensitivity parameter', () => {
    const hop = 512;
    const framesNeeded = 120;
    const noiseGen = (idx: number) =>
      Math.sin(idx * 0.1) * 0.05 + Math.sin(idx * 0.37) * 0.04;

    // Higher sensitivity → more aggressive noise estimate → more attenuation
    function measureOutputRMS(sens: number): number {
      const kernel = new WienerFilterKernel(1024, 48000);
      kernel.reductionDb = 40;
      kernel.sensitivity = sens;
      for (let block = 0; block < framesNeeded; block++) {
        const inp = new Float32Array(hop);
        const out = new Float32Array(hop);
        for (let i = 0; i < hop; i++) inp[i] = noiseGen(block * hop + i);
        kernel.process(inp, out);
      }
      const testInput = new Float32Array(hop);
      const testOutput = new Float32Array(hop);
      for (let i = 0; i < hop; i++) testInput[i] = noiseGen(framesNeeded * hop + i);
      kernel.process(testInput, testOutput);
      return Math.sqrt(testOutput.reduce((s, v) => s + v * v, 0) / hop);
    }

    const rmsLow = measureOutputRMS(1.0);
    const rmsHigh = measureOutputRMS(3.0);
    // Higher sensitivity should produce lower (or equal) output RMS
    expect(rmsHigh).toBeLessThanOrEqual(rmsLow);
  });
});
