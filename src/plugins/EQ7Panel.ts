import { PluginInstance } from '../core/types';
import { PluginHost } from './PluginHost';

const PANEL_WIDTH = 560;
const PANEL_HEIGHT = 480;
const GRAPH_LEFT = 40;
const GRAPH_TOP = 32;
const GRAPH_WIDTH = 480;
const GRAPH_HEIGHT = 304;
const GRAPH_RIGHT = GRAPH_LEFT + GRAPH_WIDTH;
const GRAPH_BOTTOM = GRAPH_TOP + GRAPH_HEIGHT;

const MIN_FREQ = 20;
const MAX_FREQ = 20000;
const MIN_DB = -24;
const MAX_DB = 24;
const DB_RANGE = MAX_DB - MIN_DB; // 48

const LOG_MIN = Math.log10(MIN_FREQ);
const LOG_MAX = Math.log10(MAX_FREQ);
const LOG_RANGE = LOG_MAX - LOG_MIN;

const NUM_POINTS = 512;

const BAND_COLORS = [
  '#8b5cf6', // HP
  '#ef4444', // 1
  '#f97316', // 2
  '#eab308', // 3
  '#22c55e', // 4
  '#06b6d4', // 5
  '#3b82f6', // 6
  '#ec4899', // 7
  '#a855f7', // LP
];

const BAND_LABELS = ['HP', '1', '2', '3', '4', '5', '6', '7', 'LP'];

// Pre-compute log-spaced frequency array
const freqArray = new Float32Array(NUM_POINTS);
for (let i = 0; i < NUM_POINTS; i++) {
  freqArray[i] = Math.pow(10, LOG_MIN + (i / (NUM_POINTS - 1)) * LOG_RANGE);
}

interface BandState {
  enabled: boolean;
  freq: number;
  gain: number;
  q: number;
}

/** Which value is being drag-adjusted in the band strip */
interface StripDrag {
  band: number;
  param: 'freq' | 'gain' | 'q';
  startY: number;
  startValue: number;
}

export class EQ7Panel {
  private container: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private bandControls: HTMLElement;

  private pluginHost: PluginHost | null = null;
  private instance: PluginInstance | null = null;
  private instanceId: string | null = null;

  private hoveredBand = -1;
  private draggedBand = -1;
  private panelDragging = false;
  private dragOffsetX = 0;
  private dragOffsetY = 0;

  /** Active click-drag on a band strip value */
  private stripDrag: StripDrag | null = null;

  private animFrameId = 0;

  constructor() {
    this.container = document.createElement('div');
    this.container.className = 'eq7-panel';
    this.container.style.display = 'none';
    this.container.style.width = PANEL_WIDTH + 'px';
    document.body.appendChild(this.container);

    // Header
    const header = document.createElement('div');
    header.className = 'eq7-header';
    header.innerHTML = '<span class="eq7-title">7-Band EQ</span><button class="eq7-close">&times;</button>';
    this.container.appendChild(header);

    // Canvas
    this.canvas = document.createElement('canvas');
    this.canvas.width = PANEL_WIDTH;
    this.canvas.height = GRAPH_BOTTOM + 8;
    this.canvas.className = 'eq7-canvas';
    this.container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;

    // Band controls strip
    this.bandControls = document.createElement('div');
    this.bandControls.className = 'eq7-band-strip';
    this.container.appendChild(this.bandControls);

    // Event listeners
    header.addEventListener('mousedown', (e) => {
      if ((e.target as HTMLElement).closest('.eq7-close')) return;
      this.panelDragging = true;
      const rect = this.container.getBoundingClientRect();
      this.dragOffsetX = e.clientX - rect.left;
      this.dragOffsetY = e.clientY - rect.top;
      e.preventDefault();
    });

    header.querySelector('.eq7-close')!.addEventListener('click', () => this.hide());

    this.canvas.addEventListener('mousedown', (e) => this.onCanvasMouseDown(e));
    this.canvas.addEventListener('mousemove', (e) => this.onCanvasMouseMove(e));
    this.canvas.addEventListener('wheel', (e) => this.onCanvasWheel(e), { passive: false });
    this.canvas.addEventListener('dblclick', (e) => this.onCanvasDblClick(e));
    this.canvas.addEventListener('mouseleave', () => { this.hoveredBand = -1; });

    document.addEventListener('mousemove', (e) => {
      if (this.panelDragging) {
        let left = e.clientX - this.dragOffsetX;
        let top = e.clientY - this.dragOffsetY;
        left = Math.max(0, Math.min(window.innerWidth - PANEL_WIDTH, left));
        top = Math.max(0, Math.min(window.innerHeight - 40, top));
        this.container.style.left = left + 'px';
        this.container.style.top = top + 'px';
      }
      if (this.draggedBand >= 0) {
        this.onDragMove(e);
      }
      if (this.stripDrag) {
        this.onStripDragMove(e);
      }
    });

    document.addEventListener('mouseup', () => {
      this.panelDragging = false;
      this.draggedBand = -1;
      this.stripDrag = null;
    });
  }

  setPluginHost(host: PluginHost): void {
    this.pluginHost = host;
  }

  show(instance: PluginInstance, instanceId: string, left: number, top: number): void {
    this.instance = instance;
    this.instanceId = instanceId;

    // Position
    if (left + PANEL_WIDTH > window.innerWidth) left = window.innerWidth - PANEL_WIDTH - 8;
    if (top + PANEL_HEIGHT > window.innerHeight) top = window.innerHeight - PANEL_HEIGHT - 8;
    if (left < 0) left = 8;
    if (top < 0) top = 8;
    this.container.style.left = left + 'px';
    this.container.style.top = top + 'px';
    this.container.style.display = 'block';

    this.renderBandControls();
    this.startAnimation();
  }

  hide(): void {
    this.container.style.display = 'none';
    this.instance = null;
    this.instanceId = null;
    if (this.animFrameId) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = 0;
    }
  }

  isVisible(): boolean {
    return this.container.style.display !== 'none';
  }

  containsElement(el: Node): boolean {
    return this.container.contains(el);
  }

  // ---- Band state helpers ----

  private getBandStates(): BandState[] {
    if (!this.instance) return [];
    const params = this.instance.parameters;
    const states: BandState[] = [];

    // HP (index 0): enabled=0, freq=1, Q=32
    states.push({
      enabled: (params.find(p => p.id === 0)?.value ?? 0) >= 0.5,
      freq: params.find(p => p.id === 1)?.value ?? 80,
      gain: 0,
      q: params.find(p => p.id === 32)?.value ?? 0.707,
    });

    // Bands 1-7 (index 1-7)
    for (let i = 0; i < 7; i++) {
      const base = 2 + i * 4;
      states.push({
        enabled: (params.find(p => p.id === base)?.value ?? 1) >= 0.5,
        freq: params.find(p => p.id === base + 1)?.value ?? 1000,
        gain: params.find(p => p.id === base + 2)?.value ?? 0,
        q: params.find(p => p.id === base + 3)?.value ?? 1.0,
      });
    }

    // LP (index 8): enabled=30, freq=31, Q=33
    states.push({
      enabled: (params.find(p => p.id === 30)?.value ?? 0) >= 0.5,
      freq: params.find(p => p.id === 31)?.value ?? 8000,
      gain: 0,
      q: params.find(p => p.id === 33)?.value ?? 0.707,
    });

    return states;
  }

  /** Get the plugin parameter ID for a given band and param type */
  private getParamId(band: number, param: 'freq' | 'gain' | 'q'): number {
    if (band === 0) {
      if (param === 'freq') return 1;
      if (param === 'q') return 32;
      return -1; // HP has no gain
    }
    if (band === 8) {
      if (param === 'freq') return 31;
      if (param === 'q') return 33;
      return -1; // LP has no gain
    }
    const base = 2 + (band - 1) * 4;
    if (param === 'freq') return base + 1;
    if (param === 'gain') return base + 2;
    if (param === 'q') return base + 3;
    return -1;
  }

  // ---- Coordinate mapping ----

  private freqToX(f: number): number {
    return GRAPH_LEFT + ((Math.log10(f) - LOG_MIN) / LOG_RANGE) * GRAPH_WIDTH;
  }

  private xToFreq(x: number): number {
    const ratio = (x - GRAPH_LEFT) / GRAPH_WIDTH;
    return Math.pow(10, LOG_MIN + ratio * LOG_RANGE);
  }

  private gainToY(db: number): number {
    return GRAPH_TOP + ((MAX_DB - db) / DB_RANGE) * GRAPH_HEIGHT;
  }

  private yToGain(y: number): number {
    return MAX_DB - ((y - GRAPH_TOP) / GRAPH_HEIGHT) * DB_RANGE;
  }

  // ---- Frequency response ----

  private getFilterResponses(): Float32Array[] {
    if (!this.instance?.audioNode) return [];
    const filters: BiquadFilterNode[] | undefined = (this.instance.audioNode as any)._filters;
    if (!filters) return [];

    const responses: Float32Array[] = [];
    for (const filter of filters) {
      const mag = new Float32Array(NUM_POINTS);
      const phase = new Float32Array(NUM_POINTS);
      filter.getFrequencyResponse(freqArray, mag, phase);
      responses.push(mag);
    }
    return responses;
  }

  // ---- Canvas rendering ----

  private startAnimation(): void {
    const draw = () => {
      if (!this.isVisible()) return;
      this.renderGraph();
      this.animFrameId = requestAnimationFrame(draw);
    };
    draw();
  }

  private renderGraph(): void {
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;

    // Background
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0, 0, w, h);

    this.renderGrid();

    const responses = this.getFilterResponses();
    if (responses.length === 0) return;
    const bandStates = this.getBandStates();

    // Per-band curves
    for (let b = 0; b < responses.length; b++) {
      ctx.strokeStyle = BAND_COLORS[b];
      ctx.globalAlpha = 0.38;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i < NUM_POINTS; i++) {
        const x = GRAPH_LEFT + (i / (NUM_POINTS - 1)) * GRAPH_WIDTH;
        const db = 20 * Math.log10(Math.max(responses[b][i], 0.0001));
        const y = this.gainToY(db);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // Combined response
    const combined = new Float32Array(NUM_POINTS);
    for (let i = 0; i < NUM_POINTS; i++) {
      let mag = 1;
      for (const resp of responses) mag *= resp[i];
      combined[i] = 20 * Math.log10(Math.max(mag, 0.0001));
    }

    // Fill under curve
    const zeroY = this.gainToY(0);
    ctx.beginPath();
    ctx.moveTo(GRAPH_LEFT, zeroY);
    for (let i = 0; i < NUM_POINTS; i++) {
      const x = GRAPH_LEFT + (i / (NUM_POINTS - 1)) * GRAPH_WIDTH;
      const y = this.gainToY(combined[i]);
      ctx.lineTo(x, y);
    }
    ctx.lineTo(GRAPH_RIGHT, zeroY);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, GRAPH_TOP, 0, GRAPH_BOTTOM);
    grad.addColorStop(0, 'rgba(59, 130, 246, 0.25)');
    grad.addColorStop(0.5, 'rgba(59, 130, 246, 0.08)');
    grad.addColorStop(1, 'rgba(59, 130, 246, 0.25)');
    ctx.fillStyle = grad;
    ctx.fill();

    // Combined stroke
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < NUM_POINTS; i++) {
      const x = GRAPH_LEFT + (i / (NUM_POINTS - 1)) * GRAPH_WIDTH;
      const y = this.gainToY(combined[i]);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Control points
    for (let b = 0; b < 9; b++) {
      const state = bandStates[b];
      const cx = this.freqToX(state.freq);
      // HP/LP: y at 0dB, bands: y at their gain
      const cy = (b === 0 || b === 8) ? zeroY : this.gainToY(state.gain);
      const r = (this.hoveredBand === b || this.draggedBand === b) ? 10 : 8;

      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      if (state.enabled) {
        ctx.fillStyle = BAND_COLORS[b];
        ctx.fill();
      } else {
        ctx.strokeStyle = BAND_COLORS[b];
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      // Label
      ctx.fillStyle = state.enabled ? '#fff' : BAND_COLORS[b];
      ctx.font = 'bold 8px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(BAND_LABELS[b], cx, cy);
    }
    ctx.textBaseline = 'alphabetic';
  }

  private renderGrid(): void {
    const ctx = this.ctx;

    // Frequency grid lines
    const freqLines = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
    const freqLabels = ['20', '50', '100', '200', '500', '1k', '2k', '5k', '10k', '20k'];
    ctx.strokeStyle = '#2a2a2a';
    ctx.lineWidth = 1;
    ctx.font = '9px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.fillStyle = '#555';
    ctx.textAlign = 'center';

    for (let i = 0; i < freqLines.length; i++) {
      const x = Math.round(this.freqToX(freqLines[i])) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, GRAPH_TOP);
      ctx.lineTo(x, GRAPH_BOTTOM);
      ctx.stroke();
      ctx.fillText(freqLabels[i], x, GRAPH_BOTTOM + 12);
    }

    // dB grid lines
    const dbLines = [-24, -18, -12, -6, 0, 6, 12, 18, 24];
    ctx.textAlign = 'right';
    for (const db of dbLines) {
      const y = Math.round(this.gainToY(db)) + 0.5;
      ctx.strokeStyle = db === 0 ? '#444' : '#2a2a2a';
      ctx.beginPath();
      ctx.moveTo(GRAPH_LEFT, y);
      ctx.lineTo(GRAPH_RIGHT, y);
      ctx.stroke();
      ctx.fillStyle = '#555';
      ctx.fillText(db === 0 ? '0' : (db > 0 ? `+${db}` : `${db}`), GRAPH_LEFT - 4, y + 3);
    }
  }

  // ---- Band controls strip ----

  private renderBandControls(): void {
    const states = this.getBandStates();
    let html = '';
    for (let b = 0; b < 9; b++) {
      const state = states[b];
      const isHPLP = b === 0 || b === 8;
      const color = BAND_COLORS[b];
      const label = BAND_LABELS[b];
      const enabledClass = state.enabled ? 'active' : '';

      html += `<div class="eq7-band-ctrl" data-band="${b}">
        <div class="eq7-band-label" style="color:${color}">${label}</div>
        <button class="eq7-band-enable ${enabledClass}" data-band="${b}"
          style="border-color:${color};${state.enabled ? `background:${color}` : ''}">${state.enabled ? 'ON' : 'OFF'}</button>
        <button class="eq7-band-val" data-band="${b}" data-param="freq">${this.formatFreq(state.freq)}</button>
        ${isHPLP
          ? `<button class="eq7-band-val" data-band="${b}" data-param="q">Q${state.q.toFixed(2)}</button>`
          : `<button class="eq7-band-val" data-band="${b}" data-param="gain">${state.gain >= 0 ? '+' : ''}${state.gain.toFixed(1)}dB</button>
        <button class="eq7-band-val" data-band="${b}" data-param="q">Q${state.q.toFixed(1)}</button>`}
      </div>`;
    }
    this.bandControls.innerHTML = html;

    // Enable button clicks
    this.bandControls.querySelectorAll('.eq7-band-enable').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const band = parseInt((e.currentTarget as HTMLElement).dataset.band!);
        this.toggleBandEnable(band);
      });
    });

    // Value button click-drag
    this.bandControls.querySelectorAll('.eq7-band-val').forEach(btn => {
      btn.addEventListener('mousedown', (e) => {
        const el = e.currentTarget as HTMLElement;
        const band = parseInt(el.dataset.band!);
        const param = el.dataset.param as 'freq' | 'gain' | 'q';
        const paramId = this.getParamId(band, param);
        if (paramId < 0) return;
        const currentParam = this.instance?.parameters.find(p => p.id === paramId);
        if (!currentParam) return;
        this.stripDrag = {
          band,
          param,
          startY: (e as MouseEvent).clientY,
          startValue: currentParam.value,
        };
        e.preventDefault();
      });
    });
  }

  private formatFreq(f: number): string {
    if (f >= 1000) return (f / 1000).toFixed(1) + 'kHz';
    return Math.round(f) + 'Hz';
  }

  // ---- Strip drag interaction ----

  private onStripDragMove(e: MouseEvent): void {
    const sd = this.stripDrag;
    if (!sd) return;
    const dy = sd.startY - e.clientY; // positive = dragging up = increase

    const paramId = this.getParamId(sd.band, sd.param);
    if (paramId < 0) return;
    const paramDef = this.instance?.parameters.find(p => p.id === paramId);
    if (!paramDef) return;

    let newValue: number;
    if (sd.param === 'freq') {
      // Log-scale: each pixel = small multiplier
      const factor = Math.pow(1.008, dy);
      newValue = Math.max(paramDef.min, Math.min(paramDef.max, sd.startValue * factor));
    } else if (sd.param === 'gain') {
      // Linear: ~0.2 dB per pixel
      newValue = Math.max(paramDef.min, Math.min(paramDef.max, sd.startValue + dy * 0.2));
    } else {
      // Q: log-scale
      const factor = Math.pow(1.01, dy);
      newValue = Math.max(paramDef.min, Math.min(paramDef.max, sd.startValue * factor));
    }

    this.setParam(paramId, newValue);
    this.renderBandControls();
  }

  // ---- Canvas interaction ----

  private hitTestBand(e: MouseEvent): number {
    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const states = this.getBandStates();
    const zeroY = this.gainToY(0);

    let closest = -1;
    let closestDist = Infinity;
    for (let b = 0; b < 9; b++) {
      const cx = this.freqToX(states[b].freq);
      const cy = (b === 0 || b === 8) ? zeroY : this.gainToY(states[b].gain);
      const dist = Math.hypot(mx - cx, my - cy);
      if (dist < 16 && dist < closestDist) {
        closest = b;
        closestDist = dist;
      }
    }
    return closest;
  }

  private onCanvasMouseDown(e: MouseEvent): void {
    const band = this.hitTestBand(e);
    if (band >= 0) {
      this.draggedBand = band;
      e.preventDefault();
    }
  }

  private onCanvasMouseMove(e: MouseEvent): void {
    if (this.draggedBand >= 0) return; // handled by document mousemove
    this.hoveredBand = this.hitTestBand(e);
  }

  private onDragMove(e: MouseEvent): void {
    if (!this.instance || !this.pluginHost || !this.instanceId) return;
    const band = this.draggedBand;
    if (band < 0) return;

    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    // Frequency from X
    const newFreq = Math.max(MIN_FREQ, Math.min(MAX_FREQ, this.xToFreq(mx)));

    if (band === 0) {
      // HP: freq only (param id 1)
      this.setParam(1, Math.min(newFreq, 1000));
    } else if (band === 8) {
      // LP: freq only (param id 31)
      this.setParam(31, Math.max(newFreq, 200));
    } else {
      // Band 1-7: freq + gain
      const base = 2 + (band - 1) * 4;
      this.setParam(base + 1, newFreq);
      const newGain = Math.max(MIN_DB, Math.min(MAX_DB, this.yToGain(my)));
      this.setParam(base + 2, newGain);
    }
    this.renderBandControls();
  }

  private onCanvasWheel(e: WheelEvent): void {
    const band = this.hitTestBand(e);
    if (band < 0) return;
    e.preventDefault();

    // Q adjustment for all bands (HP=32, LP=33, bands=base+3)
    let paramId: number;
    if (band === 0) paramId = 32;
    else if (band === 8) paramId = 33;
    else paramId = 2 + (band - 1) * 4 + 3;

    const param = this.instance?.parameters.find(p => p.id === paramId);
    if (!param) return;

    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    const newQ = Math.max(0.1, Math.min(10, param.value * factor));
    this.setParam(paramId, newQ);
    this.renderBandControls();
  }

  private onCanvasDblClick(e: MouseEvent): void {
    const band = this.hitTestBand(e);
    if (band >= 0) {
      this.toggleBandEnable(band);
    }
  }

  private toggleBandEnable(band: number): void {
    if (!this.instance) return;
    let paramId: number;
    if (band === 0) paramId = 0;
    else if (band === 8) paramId = 30;
    else paramId = 2 + (band - 1) * 4;

    const param = this.instance.parameters.find(p => p.id === paramId);
    if (!param) return;
    const newVal = param.value >= 0.5 ? 0 : 1;
    this.setParam(paramId, newVal);
    this.renderBandControls();
  }

  private setParam(paramId: number, value: number): void {
    if (!this.pluginHost || !this.instanceId) return;
    this.pluginHost.setParameter(this.instanceId, paramId, value);
    // Update local parameter cache
    const param = this.instance?.parameters.find(p => p.id === paramId);
    if (param) param.value = value;
  }
}
