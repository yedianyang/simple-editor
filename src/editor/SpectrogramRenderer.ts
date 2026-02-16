/**
 * Spectrum analyzer / spectrogram renderer.
 * Supports real-time and static spectrum display.
 */
export class SpectrogramRenderer {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  audioBuffer: AudioBuffer | null = null;
  fftSize = 2048;
  analyserNode: AnalyserNode | null = null;
  isRealtime = false;
  animationFrame = 0;
  scrollOffset = 0;
  samplesPerPixel = 100;
  playheadPosition = 0;
  selectionStart: number | null = null;
  selectionEnd: number | null = null;
  smoothedSpectrum: Float32Array | null = null;
  width = 0;
  height = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.setupResize();
  }

  setupResize(): void {
    const resizeObserver = new ResizeObserver(() => this.resize());
    resizeObserver.observe(this.canvas.parentElement!);
    this.resize();
  }

  resize(): void {
    const rect = this.canvas.parentElement!.getBoundingClientRect();
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

  setAudioBuffer(buffer: AudioBuffer | null): void {
    this.audioBuffer = buffer;
    this.smoothedSpectrum = null;
    this.render();
  }

  setAnalyserNode(node: AnalyserNode | null): void {
    this.analyserNode = node;
  }

  setFFTSize(size: number): void {
    this.fftSize = size;
    this.smoothedSpectrum = null;
  }

  setScrollOffset(offset: number): void {
    this.scrollOffset = offset;
    if (!this.isRealtime) this.render();
  }

  setSamplesPerPixel(spp: number): void {
    this.samplesPerPixel = spp;
    if (!this.isRealtime) this.render();
  }

  setPlayheadPosition(sample: number): void {
    this.playheadPosition = sample;
    if (!this.isRealtime) this.render();
  }

  setSelection(start: number | null, end: number | null): void {
    this.selectionStart = start;
    this.selectionEnd = end;
    if (!this.isRealtime) this.render();
  }

  sampleToPixel(sample: number): number {
    return (sample - this.scrollOffset) / this.samplesPerPixel;
  }

  startRealtime(): void {
    this.isRealtime = true;
    this.smoothedSpectrum = null;
    this.renderRealtime();
  }

  stopRealtime(): void {
    this.isRealtime = false;
    if (this.animationFrame) {
      cancelAnimationFrame(this.animationFrame);
    }
    this.smoothedSpectrum = null;
    this.render();
  }

  renderRealtime(): void {
    if (!this.isRealtime || !this.analyserNode) return;

    const ctx = this.ctx;
    const width = this.width;
    const height = this.height;
    const frequencyData = new Uint8Array(this.analyserNode.frequencyBinCount);
    this.analyserNode.getByteFrequencyData(frequencyData);

    ctx.fillStyle = '#0d1117';
    ctx.fillRect(0, 0, width, height);

    const numBins = 128;
    const binSize = Math.floor(frequencyData.length / numBins);
    const binnedData = new Float32Array(numBins);

    for (let i = 0; i < numBins; i++) {
      let sum = 0;
      const start = i * binSize;
      for (let j = 0; j < binSize; j++) {
        sum += frequencyData[start + j];
      }
      binnedData[i] = sum / binSize / 255;
    }

    if (!this.smoothedSpectrum || this.smoothedSpectrum.length !== numBins) {
      this.smoothedSpectrum = new Float32Array(binnedData);
    } else {
      const smoothing = 0.7;
      for (let i = 0; i < numBins; i++) {
        this.smoothedSpectrum[i] = this.smoothedSpectrum[i] * smoothing + binnedData[i] * (1 - smoothing);
      }
    }

    const gradient = ctx.createLinearGradient(0, height, 0, 0);
    gradient.addColorStop(0, 'rgba(59, 130, 246, 0.1)');
    gradient.addColorStop(0.5, 'rgba(59, 130, 246, 0.4)');
    gradient.addColorStop(1, 'rgba(59, 130, 246, 0.8)');

    ctx.beginPath();
    ctx.moveTo(0, height);

    for (let i = 0; i < numBins; i++) {
      const logPos = Math.log10(1 + i * 9 / numBins) / Math.log10(10);
      const x = logPos * width;
      const barHeight = this.smoothedSpectrum[i] * height * 0.9;

      if (i === 0) {
        ctx.lineTo(x, height - barHeight);
      } else {
        const prevLogPos = Math.log10(1 + (i - 1) * 9 / numBins) / Math.log10(10);
        const prevX = prevLogPos * width;
        const cpX = (prevX + x) / 2;
        const prevHeight = this.smoothedSpectrum[i - 1] * height * 0.9;
        ctx.quadraticCurveTo(prevX, height - prevHeight, cpX, height - (prevHeight + barHeight) / 2);
      }
    }

    ctx.lineTo(width, height);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();

    ctx.beginPath();
    for (let i = 0; i < numBins; i++) {
      const logPos = Math.log10(1 + i * 9 / numBins) / Math.log10(10);
      const x = logPos * width;
      const barHeight = this.smoothedSpectrum[i] * height * 0.9;

      if (i === 0) {
        ctx.moveTo(x, height - barHeight);
      } else {
        const prevLogPos = Math.log10(1 + (i - 1) * 9 / numBins) / Math.log10(10);
        const prevX = prevLogPos * width;
        const cpX = (prevX + x) / 2;
        const prevHeight = this.smoothedSpectrum[i - 1] * height * 0.9;
        ctx.quadraticCurveTo(prevX, height - prevHeight, cpX, height - (prevHeight + barHeight) / 2);
      }
    }
    ctx.strokeStyle = 'rgba(59, 130, 246, 0.9)';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.shadowColor = '#3b82f6';
    ctx.shadowBlur = 10;
    ctx.stroke();
    ctx.shadowBlur = 0;

    this.drawFrequencyLabels(ctx, width, height);

    this.animationFrame = requestAnimationFrame(() => this.renderRealtime());
  }

  render(): void {
    const ctx = this.ctx;
    const width = this.width;
    const height = this.height;

    ctx.fillStyle = '#0d1117';
    ctx.fillRect(0, 0, width, height);

    if (this.selectionStart !== null && this.selectionEnd !== null) {
      const startX = this.sampleToPixel(Math.min(this.selectionStart, this.selectionEnd));
      const endX = this.sampleToPixel(Math.max(this.selectionStart, this.selectionEnd));
      ctx.fillStyle = 'rgba(37, 99, 235, 0.2)';
      ctx.fillRect(startX, 0, endX - startX, height);
    }

    if (!this.audioBuffer) {
      ctx.fillStyle = '#444';
      ctx.font = '12px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Spectrum Analyzer', width / 2, height / 2);
      return;
    }

    // Compute spectrum at playhead position
    const sampleRate = this.audioBuffer.sampleRate;
    const channelData = this.audioBuffer.getChannelData(0);
    const startSample = Math.max(0, this.playheadPosition - this.fftSize / 2);

    const samples = new Float32Array(this.fftSize);
    for (let i = 0; i < this.fftSize; i++) {
      const idx = startSample + i;
      if (idx < channelData.length && idx >= 0) {
        const window = 0.5 * (1 - Math.cos(2 * Math.PI * i / this.fftSize));
        samples[i] = channelData[idx] * window;
      }
    }

    const spectrum = this.computeFFT(samples);
    const numBins = 128;
    const binnedData = new Float32Array(numBins);

    for (let i = 0; i < numBins; i++) {
      const freqRatio = Math.pow(10, i / numBins) / 10;
      const binIndex = Math.floor(freqRatio * spectrum.length);
      const nextBinIndex = Math.floor(Math.pow(10, (i + 1) / numBins) / 10 * spectrum.length);

      let sum = 0;
      let count = 0;
      for (let j = binIndex; j < nextBinIndex && j < spectrum.length; j++) {
        sum += spectrum[j];
        count++;
      }
      if (count > 0) {
        const magnitude = sum / count;
        const db = 20 * Math.log10(magnitude + 1e-10);
        binnedData[i] = Math.max(0, Math.min(1, (db + 80) / 70));
      }
    }

    const gradient = ctx.createLinearGradient(0, height, 0, 0);
    gradient.addColorStop(0, 'rgba(59, 130, 246, 0.05)');
    gradient.addColorStop(0.3, 'rgba(59, 130, 246, 0.3)');
    gradient.addColorStop(0.7, 'rgba(59, 130, 246, 0.5)');
    gradient.addColorStop(1, 'rgba(59, 130, 246, 0.7)');

    const points: { x: number; y: number }[] = [];
    for (let i = 0; i < numBins; i++) {
      const logPos = Math.log10(1 + i * 9 / numBins) / Math.log10(10);
      const x = logPos * width;
      const y = height - binnedData[i] * height * 0.85;
      points.push({ x, y });
    }

    ctx.beginPath();
    ctx.moveTo(0, height);
    ctx.lineTo(points[0].x, points[0].y);

    for (let i = 1; i < points.length - 1; i++) {
      const xc = (points[i].x + points[i + 1].x) / 2;
      const yc = (points[i].y + points[i + 1].y) / 2;
      ctx.quadraticCurveTo(points[i].x, points[i].y, xc, yc);
    }

    ctx.lineTo(points[points.length - 1].x, points[points.length - 1].y);
    ctx.lineTo(width, height);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length - 1; i++) {
      const xc = (points[i].x + points[i + 1].x) / 2;
      const yc = (points[i].y + points[i + 1].y) / 2;
      ctx.quadraticCurveTo(points[i].x, points[i].y, xc, yc);
    }
    ctx.lineTo(points[points.length - 1].x, points[points.length - 1].y);

    ctx.strokeStyle = '#3b82f6';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.shadowColor = '#6366f1';
    ctx.shadowBlur = 8;
    ctx.stroke();
    ctx.shadowBlur = 0;

    this.drawFrequencyLabels(ctx, width, height);
  }

  drawFrequencyLabels(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    ctx.fillStyle = '#666';
    ctx.font = '9px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textAlign = 'left';
    const sampleRate = this.audioBuffer ? this.audioBuffer.sampleRate : 44100;
    const nyquist = sampleRate / 2;
    const freqs = [100, 500, 1000, 2000, 5000, 10000, 20000].filter(f => f < nyquist);

    freqs.forEach(freq => {
      const logPos = Math.log10(1 + (freq / nyquist) * 9) / Math.log10(10);
      const x = logPos * width;
      const label = freq >= 1000 ? `${freq / 1000}k` : freq.toString();
      ctx.fillText(label, x + 2, height - 3);

      ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height - 12);
      ctx.stroke();
    });
  }

  computeFFT(samples: Float32Array): Float32Array {
    const n = samples.length;
    // Radix-2 Cooley-Tukey FFT — O(N log N) instead of O(N²)
    const real = new Float32Array(n);
    const imag = new Float32Array(n);

    // Bit-reversal permutation
    for (let i = 0; i < n; i++) {
      let j = 0;
      let x = i;
      for (let bit = 1; bit < n; bit <<= 1) {
        j = (j << 1) | (x & 1);
        x >>= 1;
      }
      real[j] = samples[i];
    }

    // Butterfly computation
    for (let size = 2; size <= n; size *= 2) {
      const halfSize = size / 2;
      const angleStep = -2 * Math.PI / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0; j < halfSize; j++) {
          const angle = angleStep * j;
          const cos = Math.cos(angle);
          const sin = Math.sin(angle);
          const idx1 = i + j;
          const idx2 = i + j + halfSize;
          const tReal = real[idx2] * cos - imag[idx2] * sin;
          const tImag = real[idx2] * sin + imag[idx2] * cos;
          real[idx2] = real[idx1] - tReal;
          imag[idx2] = imag[idx1] - tImag;
          real[idx1] += tReal;
          imag[idx1] += tImag;
        }
      }
    }

    // Compute magnitude spectrum (first half only)
    const spectrum = new Float32Array(n / 2);
    for (let k = 0; k < n / 2; k++) {
      spectrum[k] = Math.sqrt(real[k] * real[k] + imag[k] * imag[k]) / n;
    }
    return spectrum;
  }
}
