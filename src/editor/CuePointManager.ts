import { CuePoint } from '../core/types';

/**
 * Cue point management and rendering.
 */
export class CuePointManager {
  cuePoints: CuePoint[] = [];
  nextId = 1;

  addCuePoint(sample: number, name = ''): CuePoint {
    const cuePoint: CuePoint = {
      id: this.nextId++,
      sample,
      number: this.cuePoints.length + 1,
      name,
    };
    this.cuePoints.push(cuePoint);
    this.sortCuePoints();
    this.renumberCuePoints();
    return cuePoint;
  }

  removeCuePoint(id: number): void {
    const index = this.cuePoints.findIndex(c => c.id === id);
    if (index !== -1) {
      this.cuePoints.splice(index, 1);
      this.renumberCuePoints();
    }
  }

  moveCuePoint(id: number, newSample: number): void {
    const cuePoint = this.cuePoints.find(c => c.id === id);
    if (cuePoint) {
      cuePoint.sample = Math.max(0, newSample);
      this.sortCuePoints();
      this.renumberCuePoints();
    }
  }

  renameCuePoint(id: number, newName: string): void {
    const cuePoint = this.cuePoints.find(c => c.id === id);
    if (cuePoint) {
      cuePoint.name = newName;
    }
  }

  getCuePointAtSample(sample: number, tolerance = 0): CuePoint | undefined {
    return this.cuePoints.find(c => Math.abs(c.sample - sample) <= tolerance);
  }

  getAdjacentCuePoints(sample: number): { prev: CuePoint | null; next: CuePoint | null } {
    let prev: CuePoint | null = null;
    let next: CuePoint | null = null;
    for (const cp of this.cuePoints) {
      if (cp.sample < sample) {
        prev = cp;
      } else if (cp.sample > sample && next === null) {
        next = cp;
        break;
      }
    }
    return { prev, next };
  }

  sortCuePoints(): void {
    this.cuePoints.sort((a, b) => a.sample - b.sample);
  }

  renumberCuePoints(): void {
    this.cuePoints.forEach((cp, index) => {
      cp.number = index + 1;
    });
  }

  getAllCuePoints(): CuePoint[] {
    return this.cuePoints;
  }

  clear(): void {
    this.cuePoints = [];
    this.nextId = 1;
  }

  adjustForDeletion(startSample: number, endSample: number): void {
    const deleteLength = endSample - startSample;
    this.cuePoints = this.cuePoints.filter(cp => cp.sample < startSample || cp.sample >= endSample);
    this.cuePoints.forEach(cp => {
      if (cp.sample >= endSample) {
        cp.sample -= deleteLength;
      }
    });
    this.renumberCuePoints();
  }

  adjustForTrim(startSample: number, endSample: number): void {
    this.cuePoints = this.cuePoints.filter(cp => cp.sample >= startSample && cp.sample < endSample);
    this.cuePoints.forEach(cp => {
      cp.sample -= startSample;
    });
    this.renumberCuePoints();
  }

  toJSON(): Array<{ sample: number; name: string }> {
    return this.cuePoints.map(cp => ({ sample: cp.sample, name: cp.name }));
  }

  fromJSON(data: Array<{ sample: number; name: string }>): void {
    this.clear();
    if (Array.isArray(data)) {
      data.forEach(cp => {
        this.addCuePoint(cp.sample, cp.name || '');
      });
    }
  }
}

/**
 * Cue point visual renderer on canvas.
 */
export class CuePointRenderer {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  cuePointManager: CuePointManager;
  audioBuffer: AudioBuffer | null = null;
  scrollOffset = 0;
  samplesPerPixel = 100;
  playheadPosition = 0;
  width = 0;
  height = 0;

  draggingCuePoint: CuePoint | null = null;
  dragStartX = 0;
  dragStartSample = 0;
  hasDragged = false;
  hoveredCuePoint: CuePoint | null = null;

  onCuePointClick: ((cp: CuePoint) => void) | null = null;
  onCuePointDoubleClick: ((cp: CuePoint) => void) | null = null;
  onCuePointMove: ((id: number, newSample: number) => void) | null = null;
  onCuePointRemove: ((id: number) => void) | null = null;
  onRegionSelect: ((start: number, end: number) => void) | null = null;
  onAddCuePoint: ((sample: number) => void) | null = null;

  constructor(canvas: HTMLCanvasElement, cuePointManager: CuePointManager) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.cuePointManager = cuePointManager;
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
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    this.ctx.scale(dpr, dpr);
    this.width = rect.width;
    this.height = rect.height;
    this.render();
  }

  setupInteraction(): void {
    this.canvas.addEventListener('mousedown', (e) => this.onMouseDown(e));
    this.canvas.addEventListener('mousemove', (e) => this.onMouseMove(e));
    this.canvas.addEventListener('mouseup', () => this.onMouseUp());
    this.canvas.addEventListener('mouseleave', () => this.onMouseLeave());
    this.canvas.addEventListener('dblclick', (e) => this.onDoubleClick(e));
  }

  pixelToSample(x: number): number {
    return Math.floor(this.scrollOffset + x * this.samplesPerPixel);
  }

  sampleToPixel(sample: number): number {
    return (sample - this.scrollOffset) / this.samplesPerPixel;
  }

  getCuePointAtPixel(x: number, tolerance = 10): CuePoint | null {
    const cuePoints = this.cuePointManager.getAllCuePoints();
    for (const cp of cuePoints) {
      const cpX = this.sampleToPixel(cp.sample);
      if (Math.abs(x - cpX) <= tolerance) {
        return cp;
      }
    }
    return null;
  }

  onMouseDown(e: MouseEvent): void {
    if (!this.audioBuffer) return;
    const x = e.offsetX;
    const cuePoint = this.getCuePointAtPixel(x);

    if ((e.metaKey || e.ctrlKey) && cuePoint) {
      if (this.onCuePointRemove) this.onCuePointRemove(cuePoint.id);
      return;
    }

    if (e.shiftKey) {
      const sample = this.pixelToSample(x);
      if (sample >= 0 && sample < this.audioBuffer.length) {
        if (this.onAddCuePoint) this.onAddCuePoint(sample);
      }
      return;
    }

    if (cuePoint) {
      this.draggingCuePoint = cuePoint;
      this.dragStartX = x;
      this.dragStartSample = cuePoint.sample;
      this.hasDragged = false;
      this.canvas.style.cursor = 'grabbing';
    }
  }

  onMouseMove(e: MouseEvent): void {
    if (!this.audioBuffer) return;
    const x = e.offsetX;

    if (this.draggingCuePoint) {
      if (Math.abs(x - this.dragStartX) > 5) {
        this.hasDragged = true;
      }
      if (this.hasDragged) {
        const newSample = Math.max(0, Math.min(this.audioBuffer.length, this.pixelToSample(x)));
        if (this.onCuePointMove) this.onCuePointMove(this.draggingCuePoint.id, newSample);
      }
    } else {
      const cuePoint = this.getCuePointAtPixel(x);
      if (cuePoint !== this.hoveredCuePoint) {
        this.hoveredCuePoint = cuePoint;
        this.canvas.style.cursor = cuePoint ? 'grab' : 'default';
        this.render();
      }
    }
  }

  onMouseUp(): void {
    if (this.draggingCuePoint) {
      if (!this.hasDragged) {
        if (this.onCuePointClick) this.onCuePointClick(this.draggingCuePoint);
      }
      this.draggingCuePoint = null;
      this.hasDragged = false;
      this.canvas.style.cursor = this.hoveredCuePoint ? 'grab' : 'default';
    }
  }

  onMouseLeave(): void {
    this.hoveredCuePoint = null;
    this.draggingCuePoint = null;
    this.canvas.style.cursor = 'default';
    this.render();
  }

  onDoubleClick(e: MouseEvent): void {
    if (!this.audioBuffer) return;
    const x = e.offsetX;
    const clickedCuePoint = this.getCuePointAtPixel(x);

    if (clickedCuePoint) {
      if (this.onCuePointDoubleClick) this.onCuePointDoubleClick(clickedCuePoint);
    } else {
      const clickSample = this.pixelToSample(x);
      const { prev, next } = this.cuePointManager.getAdjacentCuePoints(clickSample);
      const startSample = prev ? prev.sample : 0;
      const endSample = next ? next.sample : this.audioBuffer.length;
      if (this.onRegionSelect) this.onRegionSelect(startSample, endSample);
    }
  }

  setAudioBuffer(buffer: AudioBuffer | null): void {
    this.audioBuffer = buffer;
    this.render();
  }

  setScrollOffset(offset: number): void {
    this.scrollOffset = offset;
    this.render();
  }

  setSamplesPerPixel(spp: number): void {
    this.samplesPerPixel = spp;
    this.render();
  }

  setPlayheadPosition(sample: number): void {
    this.playheadPosition = sample;
    this.render();
  }

  render(): void {
    const ctx = this.ctx;
    const width = this.width;
    const height = this.height;

    ctx.fillStyle = '#252525';
    ctx.fillRect(0, 0, width, height);

    if (!this.audioBuffer) {
      ctx.fillStyle = '#444';
      ctx.font = '11px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Cue Points', width / 2, height / 2 + 4);
      return;
    }

    ctx.strokeStyle = '#333';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, height - 1);
    ctx.lineTo(width, height - 1);
    ctx.stroke();

    const fileEndX = this.sampleToPixel(this.audioBuffer.length);
    if (fileEndX >= 0 && fileEndX <= width) {
      ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
      ctx.fillRect(fileEndX, 0, width - fileEndX, height);
    }

    const cuePoints = this.cuePointManager.getAllCuePoints();
    for (const cp of cuePoints) {
      this.drawCuePoint(ctx, cp, cp === this.hoveredCuePoint || cp === this.draggingCuePoint);
    }

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

  drawCuePoint(ctx: CanvasRenderingContext2D, cuePoint: CuePoint, isHighlighted: boolean): void {
    const x = this.sampleToPixel(cuePoint.sample);
    if (x < -20 || x > this.width + 20) return;

    const flagHeight = 20;
    const flagWidth = 8;

    ctx.strokeStyle = isHighlighted ? '#fbbf24' : '#f59e0b';
    ctx.lineWidth = isHighlighted ? 2 : 1;
    ctx.beginPath();
    ctx.moveTo(x, flagHeight);
    ctx.lineTo(x, this.height);
    ctx.stroke();

    ctx.fillStyle = isHighlighted ? '#fbbf24' : '#f59e0b';
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x + flagWidth, flagHeight / 2);
    ctx.lineTo(x, flagHeight);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = '#000';
    ctx.font = 'bold 9px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(cuePoint.number.toString(), x + 1, flagHeight / 2 + 3);

    if (cuePoint.name) {
      ctx.fillStyle = isHighlighted ? '#fbbf24' : '#aaa';
      ctx.font = '10px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(cuePoint.name, x + flagWidth + 4, flagHeight / 2 + 3);
    }
  }
}
