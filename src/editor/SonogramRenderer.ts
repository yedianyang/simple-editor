/**
 * iZotope RX-style 2D time-frequency heatmap renderer.
 * Displays STFT data as a sonogram with log-frequency Y-axis.
 * Worker-based computation keeps the UI thread responsive.
 */
export class SonogramRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private width: number = 0;
  private height: number = 0;
  private worker: Worker | null = null;

  // STFT data
  private stftData: Uint8Array | null = null;
  private numFrames: number = 0;
  private numBins: number = 0;
  private fftSize: number = 4096;
  private hopSize: number = 1024;
  private sampleRate: number = 44100;

  // Color LUT (256 entries, iZotope RX style)
  private colorLUT: Uint32Array;

  // Sync with waveform
  private scrollOffset: number = 0;
  private samplesPerPixel: number = 441;
  private playheadSample: number = 0;
  private selectedChannel: number = 0;

  // Resize
  private resizeObserver: ResizeObserver | null = null;

  // Audio source
  private audioBuffer: AudioBuffer | null = null;

  // Progress callback (optional)
  onProgress: ((percent: number) => void) | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('SonogramRenderer: failed to get 2d context');
    this.ctx = ctx;
    this.colorLUT = this.buildColorLUT();
    this.setupResize();
  }

  // ---- Color LUT (iZotope RX gradient) ----

  /**
   * Build 256-entry RGBA LUT:
   *   0-40:   black → deep blue
   *  40-80:   deep blue → blue
   *  80-120:  blue → cyan
   * 120-180:  cyan → yellow
   * 180-255:  yellow → white
   */
  private buildColorLUT(): Uint32Array {
    const lut = new Uint32Array(256);

    const stops: [number, number, number, number][] = [
      [0,   0x00, 0x00, 0x00], // black
      [40,  0x00, 0x00, 0x40], // deep blue
      [80,  0x00, 0x00, 0xFF], // blue
      [120, 0x00, 0xFF, 0xFF], // cyan
      [180, 0xFF, 0xFF, 0x00], // yellow
      [255, 0xFF, 0xFF, 0xFF], // white
    ];

    for (let i = 0; i < 256; i++) {
      // Find surrounding stops
      let s0 = 0;
      for (let s = 0; s < stops.length - 1; s++) {
        if (i >= stops[s][0]) s0 = s;
      }
      const s1 = s0 + 1;
      const range = stops[s1][0] - stops[s0][0];
      const t = range > 0 ? (i - stops[s0][0]) / range : 0;

      const r = Math.round(stops[s0][1] + (stops[s1][1] - stops[s0][1]) * t);
      const g = Math.round(stops[s0][2] + (stops[s1][2] - stops[s0][2]) * t);
      const b = Math.round(stops[s0][3] + (stops[s1][3] - stops[s0][3]) * t);

      // Pack as ABGR (little-endian Uint32 for ImageData)
      lut[i] = (255 << 24) | (b << 16) | (g << 8) | r;
    }

    return lut;
  }

  // ---- Resize ----

  private setupResize(): void {
    if (!this.canvas.parentElement) return;
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.canvas.parentElement);
    this.resize();
  }

  resize(): void {
    if (!this.canvas.parentElement) return;
    const rect = this.canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.width = rect.width;
    this.height = rect.height;
    this.canvas.width = Math.round(rect.width * dpr);
    this.canvas.height = Math.round(rect.height * dpr);
    this.canvas.style.width = rect.width + 'px';
    this.canvas.style.height = rect.height + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.render();
  }

  // ---- Audio data ----

  setAudioBuffer(buffer: AudioBuffer | null): void {
    this.audioBuffer = buffer;
    this.stftData = null;
    this.numFrames = 0;
    this.numBins = 0;

    if (buffer) {
      this.sampleRate = buffer.sampleRate;
      this.computeSTFT(buffer);
    } else {
      this.render();
    }
  }

  setChannel(index: number): void {
    if (index === this.selectedChannel) return;
    this.selectedChannel = index;
    if (this.audioBuffer) {
      this.computeSTFT(this.audioBuffer);
    }
  }

  setFFTSize(size: number): void {
    if (size === this.fftSize) return;
    this.fftSize = size;
    this.hopSize = size >> 2;
    if (this.audioBuffer) {
      this.computeSTFT(this.audioBuffer);
    }
  }

  // ---- Worker management ----

  private computeSTFT(buffer: AudioBuffer): void {
    // Terminate previous worker if still running
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }

    const channelIndex = Math.min(this.selectedChannel, buffer.numberOfChannels - 1);
    const channelData = buffer.getChannelData(channelIndex);

    // Vite handles this URL pattern: transforms the .ts worker into a
    // bundled JS file at build time. Works in both dev and production.
    this.worker = new Worker(
      new URL('./sonogram-worker.ts', import.meta.url),
      { type: 'module' },
    );

    this.worker.onmessage = (e: MessageEvent) => {
      const msg = e.data;
      if (msg.type === 'progress') {
        if (this.onProgress) this.onProgress(msg.percent);
      } else if (msg.type === 'result') {
        this.stftData = msg.magnitudes;
        this.numFrames = msg.numFrames;
        this.numBins = msg.numBins;
        this.sampleRate = msg.sampleRate;
        this.fftSize = msg.fftSize;
        this.hopSize = msg.hopSize;
        this.render();
        // Cleanup worker
        if (this.worker) {
          this.worker.terminate();
          this.worker = null;
        }
      }
    };

    this.worker.postMessage(
      {
        type: 'compute',
        channelData,
        sampleRate: buffer.sampleRate,
        fftSize: this.fftSize,
        hopSize: this.hopSize,
      },
      [channelData.buffer.slice(0)], // send a copy so we don't detach the AudioBuffer
    );
  }

  // ---- Scroll/zoom sync ----

  setScrollOffset(offset: number): void {
    this.scrollOffset = offset;
    this.render();
  }

  setSamplesPerPixel(spp: number): void {
    this.samplesPerPixel = spp;
    this.render();
  }

  setPlayheadPosition(sample: number): void {
    this.playheadSample = sample;
    this.render();
  }

  // ---- Coordinate mapping ----

  /** Log-frequency Y mapping: frequency → canvas Y (0 = top = Nyquist, height = bottom = 20 Hz). */
  private frequencyToY(freq: number): number {
    const minFreq = 20;
    const maxFreq = this.sampleRate / 2;
    if (freq <= minFreq) return this.height;
    if (freq >= maxFreq) return 0;
    return this.height * (1 - Math.log(freq / minFreq) / Math.log(maxFreq / minFreq));
  }

  /** Canvas Y → frequency (inverse of frequencyToY). */
  private yToFrequency(y: number): number {
    const minFreq = 20;
    const maxFreq = this.sampleRate / 2;
    const ratio = 1 - y / this.height;
    return minFreq * Math.pow(maxFreq / minFreq, ratio);
  }

  /** Convert sample position to STFT frame index. */
  private sampleToFrame(sample: number): number {
    return sample / this.hopSize;
  }

  // ---- Render ----

  render(): void {
    const ctx = this.ctx;
    const width = this.width;
    const height = this.height;

    if (width <= 0 || height <= 0) return;

    // Clear
    ctx.fillStyle = '#0d1117';
    ctx.fillRect(0, 0, width, height);

    if (!this.stftData || this.numFrames === 0) {
      ctx.fillStyle = '#444';
      ctx.font = '12px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Sonogram', width / 2, height / 2);
      return;
    }

    // Fast pixel-fill via ImageData + Uint32Array
    const dpr = window.devicePixelRatio || 1;
    const pw = Math.round(width * dpr);
    const ph = Math.round(height * dpr);
    const imageData = ctx.createImageData(pw, ph);
    const pixels = new Uint32Array(imageData.data.buffer);

    const minFreq = 20;
    const maxFreq = this.sampleRate / 2;
    const logMin = Math.log(minFreq);
    const logRange = Math.log(maxFreq) - logMin;
    const binFreqStep = this.sampleRate / this.fftSize; // frequency per bin

    for (let px = 0; px < pw; px++) {
      // Which sample does this pixel column correspond to?
      const cssX = px / dpr;
      const sample = this.scrollOffset + cssX * this.samplesPerPixel;
      const frame = this.sampleToFrame(sample);
      const frameIdx = Math.floor(frame);

      if (frameIdx < 0 || frameIdx >= this.numFrames) continue;

      const frameBase = frameIdx * this.numBins;

      for (let py = 0; py < ph; py++) {
        const cssY = py / dpr;
        // Log-frequency mapping: y → frequency → bin
        const ratio = 1 - cssY / height;
        const freq = minFreq * Math.exp(ratio * logRange);
        const bin = freq / binFreqStep;
        const binIdx = Math.floor(bin);

        if (binIdx < 0 || binIdx >= this.numBins) continue;

        // Bilinear-ish: just use nearest bin for speed
        const magnitude = this.stftData[frameBase + binIdx];
        pixels[py * pw + px] = this.colorLUT[magnitude];
      }
    }

    ctx.putImageData(imageData, 0, 0);

    // Reset transform for overlay drawing in CSS pixels
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Frequency axis labels
    this.drawFrequencyLabels(ctx, width, height);

    // Playhead
    const playheadX = (this.playheadSample - this.scrollOffset) / this.samplesPerPixel;
    if (playheadX >= 0 && playheadX <= width) {
      ctx.strokeStyle = '#ef4444';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(playheadX, 0);
      ctx.lineTo(playheadX, height);
      ctx.stroke();
    }
  }

  private drawFrequencyLabels(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    const freqs = [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
    const nyquist = this.sampleRate / 2;

    ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.font = '9px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textAlign = 'right';

    for (const freq of freqs) {
      if (freq > nyquist) continue;
      const y = this.frequencyToY(freq);
      if (y < 8 || y > height - 4) continue;

      const label = freq >= 1000 ? `${freq / 1000}k` : freq.toString();
      ctx.fillText(label, width - 4, y + 3);

      // Faint guide line
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width - 28, y);
      ctx.stroke();
    }
  }

  // ---- Cleanup ----

  destroy(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.stftData = null;
    this.audioBuffer = null;
  }
}
