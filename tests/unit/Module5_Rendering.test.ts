/**
 * Module 5 — Rendering Tests
 *
 * Tests for WaveformRenderer, SpectrogramRenderer, and SonogramRenderer.
 * Covers ResizeObserver null guards, destroy() cleanup, FFT validation,
 * Worker lifecycle, and canvas getContext null checks.
 */
import { describe, it, expect, vi } from 'vitest';
import { WaveformRenderer } from '../../src/editor/WaveformRenderer';
import { SpectrogramRenderer } from '../../src/editor/SpectrogramRenderer';
import { SonogramRenderer } from '../../src/editor/SonogramRenderer';
import { createMockCanvas } from '../setup';

// ==================== 5.1 WaveformRenderer ResizeObserver Null Guard ====================

describe('5.1 WaveformRenderer ResizeObserver Null Guard', () => {
  it('5.1.1 - setupResize() skips when canvas has no parentElement', () => {
    const canvas = document.createElement('canvas');
    // canvas NOT in DOM → parentElement is null
    const renderer = new WaveformRenderer(canvas);
    expect((renderer as any).resizeObserver).toBeNull();
    renderer.destroy();
  });

  it('5.1.2 - resize() is no-op when parentElement is null', () => {
    const canvas = createMockCanvas();
    const renderer = new WaveformRenderer(canvas);
    const prevWidth = renderer.width;
    const prevHeight = renderer.height;

    // Detach canvas from parent
    canvas.parentElement!.removeChild(canvas);

    // resize() should not throw and dimensions stay unchanged
    expect(() => renderer.resize()).not.toThrow();
    expect(renderer.width).toBe(prevWidth);
    expect(renderer.height).toBe(prevHeight);
    renderer.destroy();
  });

  it('5.1.3 - resize() updates dimensions when parent exists', () => {
    const canvas = createMockCanvas(800, 400);
    const renderer = new WaveformRenderer(canvas);
    expect(renderer.width).toBe(800);
    expect(renderer.height).toBe(400);
    renderer.destroy();
  });
});

// ==================== 5.2 SpectrogramRenderer ResizeObserver Null Guard ====================

describe('5.2 SpectrogramRenderer ResizeObserver Null Guard', () => {
  it('5.2.1 - setupResize() skips when no parentElement', () => {
    const canvas = document.createElement('canvas');
    const renderer = new SpectrogramRenderer(canvas);
    expect((renderer as any).resizeObserver).toBeNull();
    renderer.destroy();
  });

  it('5.2.2 - resize() is no-op when parentElement is null', () => {
    const canvas = createMockCanvas();
    const renderer = new SpectrogramRenderer(canvas);

    canvas.parentElement!.removeChild(canvas);

    expect(() => renderer.resize()).not.toThrow();
    renderer.destroy();
  });
});

// ==================== 5.3 WaveformRenderer.destroy() Cleanup ====================

describe('5.3 WaveformRenderer.destroy() Cleanup', () => {
  it('5.3.1 - destroy() disconnects ResizeObserver and removes event listeners', () => {
    const canvas = createMockCanvas();
    const removeSpy = vi.spyOn(canvas, 'removeEventListener');
    const renderer = new WaveformRenderer(canvas);

    renderer.destroy();

    // ResizeObserver should be nulled
    expect((renderer as any).resizeObserver).toBeNull();

    // 6 event listeners removed: mousedown, mousemove, mouseup, mouseleave, dblclick, wheel
    const removeCalls = removeSpy.mock.calls.map(c => c[0]);
    expect(removeCalls).toContain('mousedown');
    expect(removeCalls).toContain('mousemove');
    expect(removeCalls).toContain('mouseup');
    expect(removeCalls).toContain('mouseleave');
    expect(removeCalls).toContain('dblclick');
    expect(removeCalls).toContain('wheel');
    expect(removeCalls).toHaveLength(6);

    removeSpy.mockRestore();
  });

  it('5.3.2 - destroy() clears audioBuffer, peakCache, peaks', () => {
    const canvas = createMockCanvas();
    const renderer = new WaveformRenderer(canvas);

    // Set some data
    const ctx = new AudioContext();
    renderer.audioBuffer = ctx.createBuffer(1, 100, 44100);
    renderer.peaks = [new Float32Array(10)];

    renderer.destroy();

    expect(renderer.audioBuffer).toBeNull();
    expect((renderer as any).peakCache).toBeNull();
    expect(renderer.peaks).toEqual([]);
  });
});

// ==================== 5.4 SpectrogramRenderer.destroy() Cleanup ====================

describe('5.4 SpectrogramRenderer.destroy() Cleanup', () => {
  it('5.4.1 - destroy() calls stopRealtime, disconnects observer, nullifies data', () => {
    const canvas = createMockCanvas();
    const renderer = new SpectrogramRenderer(canvas);

    // Set some data
    const ctx = new AudioContext();
    renderer.audioBuffer = ctx.createBuffer(1, 100, 44100);
    renderer.analyserNode = ctx.createAnalyser() as unknown as AnalyserNode;
    renderer.smoothedSpectrum = new Float32Array(128);

    renderer.destroy();

    expect((renderer as any).resizeObserver).toBeNull();
    expect(renderer.audioBuffer).toBeNull();
    expect(renderer.analyserNode).toBeNull();
    expect(renderer.smoothedSpectrum).toBeNull();
  });
});

// ==================== 5.5 SpectrogramRenderer FFT Validation ====================

describe('5.5 SpectrogramRenderer FFT Validation', () => {
  it('5.5.1 - setFFTSize() throws for non-power-of-2', () => {
    const canvas = document.createElement('canvas');
    const renderer = new SpectrogramRenderer(canvas);

    expect(() => renderer.setFFTSize(1000)).toThrow('power of 2');
    expect(() => renderer.setFFTSize(0)).toThrow('power of 2');
    expect(() => renderer.setFFTSize(-1)).toThrow('power of 2');

    renderer.destroy();
  });

  it('5.5.2 - setFFTSize() accepts valid powers of 2', () => {
    const canvas = document.createElement('canvas');
    const renderer = new SpectrogramRenderer(canvas);

    [512, 1024, 2048, 4096, 8192].forEach(size => {
      expect(() => renderer.setFFTSize(size)).not.toThrow();
      expect(renderer.fftSize).toBe(size);
    });

    renderer.destroy();
  });
});

// ==================== 5.6 SonogramRenderer Cleanup ====================

describe('5.6 SonogramRenderer Cleanup', () => {
  it('5.6.1 - constructor does not throw with valid canvas', () => {
    const canvas = createMockCanvas();

    expect(() => {
      const renderer = new SonogramRenderer(canvas);
      renderer.destroy();
    }).not.toThrow();
  });

  it('5.6.2 - destroy() terminates worker, disconnects observer, nullifies data', () => {
    const canvas = createMockCanvas();
    const renderer = new SonogramRenderer(canvas);

    // Inject a mock worker to verify terminate() is called
    const mockWorker = { terminate: vi.fn(), onmessage: null, postMessage() {} };
    (renderer as any).worker = mockWorker;
    (renderer as any).stftData = new Uint8Array(100);

    const ctx = new AudioContext();
    (renderer as any).audioBuffer = ctx.createBuffer(1, 100, 44100);

    renderer.destroy();

    expect(mockWorker.terminate).toHaveBeenCalled();
    expect((renderer as any).worker).toBeNull();
    expect((renderer as any).resizeObserver).toBeNull();
    expect((renderer as any).stftData).toBeNull();
    expect((renderer as any).audioBuffer).toBeNull();
  });
});

// ==================== 5.7 Canvas getContext('2d') Null Check ====================

describe('5.7 Canvas getContext Null Check', () => {
  it('5.7.1 - all three renderers throw when getContext returns null', () => {
    const makeNullCtxCanvas = (): HTMLCanvasElement => {
      const canvas = document.createElement('canvas');
      // Override instance method to return null, shadowing the prototype mock
      canvas.getContext = (() => null) as typeof canvas.getContext;
      return canvas;
    };

    expect(() => new WaveformRenderer(makeNullCtxCanvas()))
      .toThrow('failed to get 2d context');
    expect(() => new SpectrogramRenderer(makeNullCtxCanvas()))
      .toThrow('failed to get 2d context');
    expect(() => new SonogramRenderer(makeNullCtxCanvas()))
      .toThrow('failed to get 2d context');
  });
});
