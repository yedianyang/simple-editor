import { CHANNEL_COLORS, CHANNEL_NAMES, formatTime } from '../core/types';

/**
 * Multi-channel waveform renderer.
 * Displays each channel in a separate lane with independent peak calculation.
 */
export class WaveformRenderer {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  audioBuffer: AudioBuffer | null = null;
  samplesPerPixel = 100;
  scrollOffset = 0;
  selectionStart: number | null = null;
  selectionEnd: number | null = null;
  playheadPosition = 0;
  peaks: Float32Array[] = []; // Per-channel peaks
  // Pre-computed multi-resolution peak cache for large files
  private peakCache: { channelPeaks: Float32Array[]; blockSize: number } | null = null;
  private static readonly PEAK_CACHE_BLOCK_SIZE = 256; // samples per cached peak block
  private peakCacheBuildId = 0; // generation counter to prevent stale builds overwriting new ones
  isDragging = false;
  dragStartX = 0;
  dragStartSample = 0;
  hasDragged = false;
  width = 0;
  height = 0;

  // Display options
  showAllChannels = true;
  soloViewChannel = -1; // -1 = show all

  // Callbacks
  onPlayheadChange: ((sample: number) => void) | null = null;
  onSelectionUpdate: ((start: number | null, end: number | null) => void) | null = null;
  onSelectionChange: (() => void) | null = null;
  onZoomChange: (() => void) | null = null;
  onScrollChange: (() => void) | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.setupResize();
    this.setupInteraction();
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
    // Set buffer size for crisp rendering at device pixel ratio
    this.canvas.width = Math.round(rect.width * dpr);
    this.canvas.height = Math.round(rect.height * dpr);
    // Explicitly pin CSS size so offsetX/getBoundingClientRect stay in CSS-pixel space
    this.canvas.style.width = rect.width + 'px';
    this.canvas.style.height = rect.height + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.render();
  }

  setupInteraction(): void {
    this.canvas.addEventListener('mousedown', (e) => this.onMouseDown(e));
    this.canvas.addEventListener('mousemove', (e) => this.onMouseMove(e));
    this.canvas.addEventListener('mouseup', (e) => this.onMouseUp(e));
    this.canvas.addEventListener('mouseleave', (e) => this.onMouseUp(e));
    this.canvas.addEventListener('dblclick', () => this.onDoubleClick());
    this.canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
  }

  onDoubleClick(): void {
    if (!this.audioBuffer) return;
    this.selectAll();
  }

  selectAll(): void {
    if (!this.audioBuffer) return;
    this.selectionStart = 0;
    this.selectionEnd = this.audioBuffer.length;
    this.playheadPosition = 0;
    this.render();
    this.updateSelectionInfo();
    if (this.onPlayheadChange) this.onPlayheadChange(0);
    if (this.onSelectionUpdate) this.onSelectionUpdate(0, this.audioBuffer.length);
    if (this.onSelectionChange) this.onSelectionChange();
  }

  /** Convert clientX to canvas-local CSS pixel coordinate. */
  private clientToLocalX(e: MouseEvent): number {
    const rect = this.canvas.getBoundingClientRect();
    return e.clientX - rect.left;
  }

  onMouseDown(e: MouseEvent): void {
    if (!this.audioBuffer) return;
    const x = this.clientToLocalX(e);
    this.isDragging = true;
    this.dragStartX = x;
    this.dragStartSample = this.pixelToSample(x);
    this.hasDragged = false;

    this.playheadPosition = this.dragStartSample;
    this.selectionStart = null;
    this.selectionEnd = null;
    this.render();
    if (this.onPlayheadChange) this.onPlayheadChange(this.playheadPosition);
    if (this.onSelectionUpdate) this.onSelectionUpdate(null, null);
  }

  onMouseMove(e: MouseEvent): void {
    if (!this.isDragging || !this.audioBuffer) return;
    const x = this.clientToLocalX(e);
    const dragDistance = Math.abs(x - this.dragStartX);

    if (dragDistance > 5) {
      this.hasDragged = true;
      this.selectionStart = this.dragStartSample;
      this.selectionEnd = this.pixelToSample(x);
      this.render();
      this.updateSelectionInfo();
      if (this.onSelectionUpdate) this.onSelectionUpdate(this.selectionStart, this.selectionEnd);
    }
  }

  onMouseUp(_e: MouseEvent): void {
    if (!this.isDragging) return;
    this.isDragging = false;

    if (this.hasDragged) {
      if (this.selectionStart !== null && this.selectionEnd !== null) {
        if (this.selectionStart > this.selectionEnd) {
          [this.selectionStart, this.selectionEnd] = [this.selectionEnd, this.selectionStart];
        }
        if (this.selectionEnd - this.selectionStart < 10) {
          this.selectionStart = null;
          this.selectionEnd = null;
        }
      }
      this.render();
      this.updateSelectionInfo();
      if (this.onSelectionUpdate) this.onSelectionUpdate(this.selectionStart, this.selectionEnd);
      if (this.onSelectionChange) this.onSelectionChange();
    } else {
      if (this.onSelectionChange) this.onSelectionChange();
    }
  }

  onWheel(e: WheelEvent): void {
    if (!this.audioBuffer) return;
    e.preventDefault();

    const hasHorizontalScroll = Math.abs(e.deltaX) > Math.abs(e.deltaY) * 0.5;

    if (hasHorizontalScroll) {
      const scrollAmount = e.deltaX * this.samplesPerPixel * 0.5;
      this.scrollOffset += scrollAmount;
      this.clampScroll();
      this.calculatePeaks();
      this.render();
      if (this.onScrollChange) this.onScrollChange();
    } else if (Math.abs(e.deltaY) > 0) {
      const zoomFactor = e.deltaY > 0 ? 1.1 : 0.9;
      const mouseX = this.clientToLocalX(e);
      const sampleAtMouse = this.pixelToSample(mouseX);

      this.samplesPerPixel = Math.max(1, Math.min(
        this.audioBuffer.length / 100,
        this.samplesPerPixel * zoomFactor
      ));

      this.scrollOffset = sampleAtMouse - mouseX * this.samplesPerPixel;
      this.clampScroll();
      this.calculatePeaks();
      this.render();
      if (this.onZoomChange) this.onZoomChange();
    }
  }

  setAudioBuffer(buffer: AudioBuffer | null): void {
    this.audioBuffer = buffer;
    this.selectionStart = null;
    this.selectionEnd = null;
    this.scrollOffset = 0;
    this.playheadPosition = 0;
    this.peakCache = null;
    this.peaks = [];
    if (this.onSelectionUpdate) this.onSelectionUpdate(null, null);
    if (buffer) {
      // Render empty waveform / loading state immediately
      this.render();
      // Build peak cache asynchronously, then finalize
      this.buildPeakCacheAsync(buffer).then(() => {
        // Only finalize if this buffer is still current
        if (this.audioBuffer === buffer) {
          this.zoomFit();
        }
      });
    } else {
      this.render();
    }
  }

  /**
   * Pre-compute a peak cache at fixed block size (async, non-blocking).
   * Yields to the main thread every 1000 blocks to prevent UI freezes
   * on large files (e.g. 86M samples).
   */
  private async buildPeakCacheAsync(buffer: AudioBuffer): Promise<void> {
    const buildId = ++this.peakCacheBuildId;
    const blockSize = WaveformRenderer.PEAK_CACHE_BLOCK_SIZE;
    const numChannels = buffer.numberOfChannels;
    const channelPeaks: Float32Array[] = [];

    for (let c = 0; c < numChannels; c++) {
      const data = buffer.getChannelData(c);
      const numBlocks = Math.ceil(data.length / blockSize);
      // Store min and max per block: [min0, max0, min1, max1, ...]
      const peaks = new Float32Array(numBlocks * 2);

      for (let b = 0; b < numBlocks; b++) {
        const start = b * blockSize;
        const end = Math.min(start + blockSize, data.length);
        let min = 0, max = 0;
        for (let j = start; j < end; j++) {
          const v = data[j];
          if (v < min) min = v;
          if (v > max) max = v;
        }
        peaks[b * 2] = min;
        peaks[b * 2 + 1] = max;

        // Yield every 1000 blocks to keep UI responsive
        if (b % 1000 === 999) {
          await new Promise<void>(r => setTimeout(r, 0));
          // Abort if a newer buffer has been set
          if (this.peakCacheBuildId !== buildId) return;
        }
      }
      channelPeaks.push(peaks);
    }

    // Final staleness check before writing cache
    if (this.peakCacheBuildId !== buildId) return;
    this.peakCache = { channelPeaks, blockSize };
  }

  zoomFit(): void {
    if (!this.audioBuffer) return;
    this.samplesPerPixel = this.audioBuffer.length / this.width;
    this.scrollOffset = 0;
    this.calculatePeaks();
    this.render();
    if (this.onZoomChange) this.onZoomChange();
  }

  zoomIn(): void {
    if (!this.audioBuffer) return;
    this.samplesPerPixel = Math.max(1, this.samplesPerPixel * 0.5);
    this.clampScroll();
    this.calculatePeaks();
    this.render();
    if (this.onZoomChange) this.onZoomChange();
  }

  zoomOut(): void {
    if (!this.audioBuffer) return;
    this.samplesPerPixel = Math.min(
      this.audioBuffer.length / 100,
      this.samplesPerPixel * 2
    );
    this.clampScroll();
    this.calculatePeaks();
    this.render();
    if (this.onZoomChange) this.onZoomChange();
  }

  clampScroll(): void {
    if (!this.audioBuffer) return;
    const maxScroll = Math.max(0, this.audioBuffer.length - this.width * this.samplesPerPixel);
    this.scrollOffset = Math.max(0, Math.min(maxScroll, this.scrollOffset));
  }

  pixelToSample(x: number): number {
    return Math.floor(this.scrollOffset + x * this.samplesPerPixel);
  }

  sampleToPixel(sample: number): number {
    return (sample - this.scrollOffset) / this.samplesPerPixel;
  }

  calculatePeaks(): void {
    if (!this.audioBuffer) return;

    const numChannels = this.audioBuffer.numberOfChannels;
    const numPeaks = Math.ceil(this.width);
    this.peaks = [];

    // Use peak cache when zoomed out enough (samplesPerPixel >= blockSize)
    const useCache = this.peakCache && this.samplesPerPixel >= this.peakCache.blockSize;

    for (let c = 0; c < numChannels; c++) {
      const peaks = new Float32Array(numPeaks * 2);

      if (useCache && this.peakCache) {
        const cache = this.peakCache.channelPeaks[c];
        const blockSize = this.peakCache.blockSize;

        for (let i = 0; i < numPeaks; i++) {
          const startSample = Math.floor(this.scrollOffset + i * this.samplesPerPixel);
          const endSample = Math.floor(startSample + this.samplesPerPixel);

          const startBlock = Math.max(0, Math.floor(startSample / blockSize));
          const endBlock = Math.min(Math.ceil(endSample / blockSize), cache.length / 2);

          let min = 0, max = 0;
          for (let b = startBlock; b < endBlock; b++) {
            const bMin = cache[b * 2];
            const bMax = cache[b * 2 + 1];
            if (bMin < min) min = bMin;
            if (bMax > max) max = bMax;
          }
          peaks[i * 2] = min;
          peaks[i * 2 + 1] = max;
        }
      } else {
        // Direct sample access for zoomed-in view
        const channelData = this.audioBuffer.getChannelData(c);
        for (let i = 0; i < numPeaks; i++) {
          const startSample = Math.floor(this.scrollOffset + i * this.samplesPerPixel);
          const endSample = Math.floor(startSample + this.samplesPerPixel);

          let min = 0, max = 0;
          for (let j = startSample; j < endSample && j < channelData.length; j++) {
            if (j >= 0) {
              const value = channelData[j];
              if (value < min) min = value;
              if (value > max) max = value;
            }
          }
          peaks[i * 2] = min;
          peaks[i * 2 + 1] = max;
        }
      }

      this.peaks.push(peaks);
    }
  }

  setPlayheadPosition(time: number): void {
    if (!this.audioBuffer) return;
    const sample = Math.floor(time * this.audioBuffer.sampleRate);
    this.playheadPosition = sample;
    this.render();
  }

  getSelection(): { start: number; end: number } | null {
    if (this.selectionStart === null || this.selectionEnd === null) return null;
    return {
      start: Math.min(this.selectionStart, this.selectionEnd),
      end: Math.max(this.selectionStart, this.selectionEnd),
    };
  }

  hasSelection(): boolean {
    return this.selectionStart !== null && this.selectionEnd !== null;
  }

  updateSelectionInfo(): void {
    const info = document.getElementById('selectionInfo');
    if (!info) return;
    const selection = this.getSelection();
    if (!selection || !this.audioBuffer) {
      info.classList.remove('visible');
      return;
    }

    const startTime = selection.start / this.audioBuffer.sampleRate;
    const endTime = selection.end / this.audioBuffer.sampleRate;
    const duration = endTime - startTime;

    info.textContent = `Selection: ${formatTime(startTime)} - ${formatTime(endTime)} (${formatTime(duration)})`;
    info.classList.add('visible');
  }

  setSoloViewChannel(channel: number): void {
    this.soloViewChannel = channel;
    this.render();
  }

  render(): void {
    const ctx = this.ctx;
    const width = this.width;
    const height = this.height;

    // Clear
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0, 0, width, height);

    if (!this.audioBuffer || this.peaks.length === 0) {
      ctx.fillStyle = '#444';
      ctx.font = '16px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Import audio files to begin editing', width / 2, height / 2 - 10);
      ctx.font = '12px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.fillStyle = '#666';
      ctx.fillText('Drag & drop WAV/AIF files or use File > Import', width / 2, height / 2 + 15);
      return;
    }

    const numChannels = this.audioBuffer.numberOfChannels;
    const displayChannels = this.soloViewChannel >= 0 ? 1 : numChannels;
    const channelHeight = height / displayChannels;
    const channelNames = CHANNEL_NAMES[numChannels] ||
      Array.from({ length: numChannels }, (_, i) => `Ch ${i + 1}`);

    // Draw selection background (full height)
    if (this.selectionStart !== null && this.selectionEnd !== null) {
      const startX = this.sampleToPixel(Math.min(this.selectionStart, this.selectionEnd));
      const endX = this.sampleToPixel(Math.max(this.selectionStart, this.selectionEnd));
      ctx.fillStyle = 'rgba(37, 99, 235, 0.2)';
      ctx.fillRect(startX, 0, endX - startX, height);
    }

    // Draw each channel
    for (let displayIdx = 0; displayIdx < displayChannels; displayIdx++) {
      const c = this.soloViewChannel >= 0 ? this.soloViewChannel : displayIdx;
      const yOffset = displayIdx * channelHeight;
      const centerY = yOffset + channelHeight / 2;
      const amplitude = channelHeight / 2 - 6;
      const color = CHANNEL_COLORS[c % CHANNEL_COLORS.length];

      // Channel separator
      if (displayIdx > 0) {
        ctx.strokeStyle = '#333';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, yOffset);
        ctx.lineTo(width, yOffset);
        ctx.stroke();
      }

      // Center line
      ctx.strokeStyle = '#2a2a2a';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, centerY);
      ctx.lineTo(width, centerY);
      ctx.stroke();

      // Channel label
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.6;
      ctx.font = 'bold 10px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(channelNames[c] || `Ch ${c + 1}`, 6, yOffset + 14);
      ctx.globalAlpha = 1.0;

      // Draw waveform
      if (c < this.peaks.length) {
        const peaks = this.peaks[c];
        ctx.fillStyle = color;

        for (let i = 0; i < peaks.length / 2; i++) {
          const min = peaks[i * 2];
          const max = peaks[i * 2 + 1];
          const y1 = centerY - max * amplitude;
          const y2 = centerY - min * amplitude;
          ctx.fillRect(i, y1, 1, Math.max(1, y2 - y1));
        }
      }
    }

    // Draw file end indicator
    const fileEndX = this.sampleToPixel(this.audioBuffer.length);
    if (fileEndX >= 0 && fileEndX <= width) {
      ctx.strokeStyle = '#f59e0b';
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(fileEndX, 0);
      ctx.lineTo(fileEndX, height);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Shade beyond file end
    if (fileEndX < width && fileEndX >= 0) {
      ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
      ctx.fillRect(fileEndX, 0, width - fileEndX, height);
    }

    // Draw playhead
    const playheadX = this.sampleToPixel(this.playheadPosition);
    if (playheadX >= 0 && playheadX <= width) {
      ctx.strokeStyle = '#ef4444';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(playheadX, 0);
      ctx.lineTo(playheadX, height);
      ctx.stroke();
    }
  }
}
