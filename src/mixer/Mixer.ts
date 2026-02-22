import { ChannelStripState, CHANNEL_COLORS, CHANNEL_NAMES, Track, FaderLaw } from '../core/types';
import { AudioEngine } from '../core/AudioEngine';
import { PluginHost } from '../plugins/PluginHost';

/**
 * Track-mode strip state, mirroring Track data for the mixer UI.
 */
interface TrackStrip {
  trackId: string;
  name: string;
  color: string;
  volume: number;
  pan: number;
  mute: boolean;
  solo: boolean;
}

/**
 * Mixer with per-channel strips, plugin inserts, and master bus.
 * Supports two modes:
 *   - channel: classic per-channel routing (single-buffer playback)
 *   - track:   per-track routing (timeline playback) with Fader Law + Crossfader
 */
export class Mixer {
  container: HTMLElement;
  audioEngine: AudioEngine;
  pluginHost: PluginHost | null;
  channels: ChannelStripState[] = [];
  masterVolume = 0; // dB
  visible = false;

  // Mode
  private mode: 'channel' | 'track' = 'channel';

  // Track-mode state
  private trackStrips: TrackStrip[] = [];

  // Fader law
  private faderLaw: FaderLaw = 'equalPower';

  // Crossfader
  private crossfaderTrackA: string | null = null;
  private crossfaderTrackB: string | null = null;
  private crossfaderPosition = 0; // -1 to 1
  private crossfaderLaw: FaderLaw = 'equalPower';

  // Callbacks
  onPluginInsertRequest: ((channelIndex: number) => void) | null = null;

  constructor(container: HTMLElement, audioEngine: AudioEngine, pluginHost: PluginHost | null) {
    this.container = container;
    this.audioEngine = audioEngine;
    this.pluginHost = pluginHost;
  }

  // ==================== Channel Mode (existing) ====================

  /**
   * Initialize mixer channels based on the loaded audio buffer.
   */
  setupChannels(numChannels: number): void {
    this.mode = 'channel';
    this.channels = [];
    const names = CHANNEL_NAMES[numChannels] || Array.from({ length: numChannels }, (_, i) => `Ch ${i + 1}`);

    for (let i = 0; i < numChannels; i++) {
      this.channels.push({
        channelIndex: i,
        name: names[i],
        volume: 0,
        pan: 0,
        mute: false,
        solo: false,
        plugins: [],
      });
    }

    this.render();
  }

  setChannelVolume(index: number, db: number): void {
    if (index < 0 || index >= this.channels.length) return;
    this.channels[index].volume = db;
    this.audioEngine.setChannelVolume(index, db);
    this.updateChannelStripDisplay(index);
  }

  setChannelMute(index: number, mute: boolean): void {
    if (index < 0 || index >= this.channels.length) return;
    this.channels[index].mute = mute;
    this.audioEngine.setChannelMute(index, mute);
    this.updateChannelStripDisplay(index);
  }

  setChannelSolo(index: number, solo: boolean): void {
    if (index < 0 || index >= this.channels.length) return;
    this.channels[index].solo = solo;
    this.audioEngine.setChannelSolo(index, solo);
    // Update all strips since solo affects others
    this.channels.forEach((_, i) => this.updateChannelStripDisplay(i));
  }

  // ==================== Track Mode (new) ====================

  /**
   * Initialize mixer strips from Track objects for timeline playback.
   * Builds one channel strip per track, sets up audio routing via AudioEngine.
   */
  setupTracks(tracks: Track[]): void {
    this.mode = 'track';
    this.trackStrips = tracks.map(t => ({
      trackId: t.id,
      name: t.name,
      color: t.color,
      volume: t.volume,
      pan: t.pan,
      mute: t.mute,
      solo: t.solo,
    }));

    // Reset crossfader if assigned tracks no longer exist
    const ids = new Set(tracks.map(t => t.id));
    if (this.crossfaderTrackA && !ids.has(this.crossfaderTrackA)) this.crossfaderTrackA = null;
    if (this.crossfaderTrackB && !ids.has(this.crossfaderTrackB)) this.crossfaderTrackB = null;

    this.audioEngine.setupTrackRouting(tracks);
    this.render();
  }

  setTrackVolume(trackId: string, db: number): void {
    const strip = this.trackStrips.find(s => s.trackId === trackId);
    if (!strip) return;
    strip.volume = db;
    this.audioEngine.setTrackVolume(trackId, db);
    this.updateTrackStripDisplay(trackId);
  }

  setTrackPan(trackId: string, pan: number): void {
    const strip = this.trackStrips.find(s => s.trackId === trackId);
    if (!strip) return;
    strip.pan = Math.max(-1, Math.min(1, pan));
    this.audioEngine.setTrackPan(trackId, strip.pan);
    this.updateTrackStripDisplay(trackId);
  }

  setTrackMute(trackId: string, mute: boolean): void {
    const strip = this.trackStrips.find(s => s.trackId === trackId);
    if (!strip) return;
    strip.mute = mute;
    this.audioEngine.setTrackMute(trackId, mute);
    this.updateTrackStripDisplay(trackId);
  }

  setTrackSolo(trackId: string, solo: boolean): void {
    const strip = this.trackStrips.find(s => s.trackId === trackId);
    if (!strip) return;
    strip.solo = solo;
    this.audioEngine.setTrackSolo(trackId, solo);
    // Update all strips since solo affects others
    this.trackStrips.forEach(s => this.updateTrackStripDisplay(s.trackId));
  }

  private updateTrackStripDisplay(trackId: string): void {
    const el = this.container.querySelector(`[data-track-id="${trackId}"]`);
    if (!el) return;

    const strip = this.trackStrips.find(s => s.trackId === trackId);
    if (!strip) return;

    const muteBtn = el.querySelector('.mixer-mute') as HTMLButtonElement;
    const soloBtn = el.querySelector('.mixer-solo') as HTMLButtonElement;
    const volValue = el.querySelector('.mixer-vol-value');
    const panValue = el.querySelector('.mixer-pan-value');

    if (muteBtn) muteBtn.classList.toggle('active', strip.mute);
    if (soloBtn) soloBtn.classList.toggle('active', strip.solo);
    if (volValue) volValue.textContent = `${strip.volume.toFixed(1)}`;
    if (panValue) panValue.textContent = this.formatPan(strip.pan);
  }

  private formatPan(pan: number): string {
    if (pan === 0) return 'C';
    return pan < 0 ? `L${Math.abs(Math.round(pan * 100))}` : `R${Math.round(pan * 100)}`;
  }

  // ==================== Shared ====================

  setMasterVolume(db: number): void {
    this.masterVolume = db;
    this.audioEngine.setMasterVolume(db);
    const el = this.container.querySelector('.master-volume-value');
    if (el) el.textContent = `${db.toFixed(1)} dB`;
  }

  setFaderLaw(law: FaderLaw): void {
    this.faderLaw = law;
    this.audioEngine.setFaderLaw(law);
    // Update UI toggle states
    const epBtn = this.container.querySelector('.fader-law-ep') as HTMLElement;
    const egBtn = this.container.querySelector('.fader-law-eg') as HTMLElement;
    if (epBtn) epBtn.classList.toggle('active', law === 'equalPower');
    if (egBtn) egBtn.classList.toggle('active', law === 'equalGain');
  }

  private setCrossfaderPosition(position: number): void {
    this.crossfaderPosition = Math.max(-1, Math.min(1, position));
    this.audioEngine.setCrossfaderPosition(this.crossfaderPosition);
    const label = this.container.querySelector('.crossfader-pos-label');
    if (label) label.textContent = this.crossfaderPosition.toFixed(2);
  }

  private setCrossfaderLaw(law: FaderLaw): void {
    this.crossfaderLaw = law;
    this.audioEngine.setCrossfaderLaw(law);
    const epBtn = this.container.querySelector('.xfade-law-ep') as HTMLElement;
    const egBtn = this.container.querySelector('.xfade-law-eg') as HTMLElement;
    if (epBtn) epBtn.classList.toggle('active', law === 'equalPower');
    if (egBtn) egBtn.classList.toggle('active', law === 'equalGain');
  }

  private applyCrossfaderAssignment(): void {
    if (this.crossfaderTrackA && this.crossfaderTrackB) {
      this.audioEngine.setCrossfader(this.crossfaderTrackA, this.crossfaderTrackB);
      this.audioEngine.setCrossfaderPosition(this.crossfaderPosition);
    }
  }

  async addPlugin(channelIndex: number, pluginInfo: any): Promise<void> {
    if (channelIndex < 0 || channelIndex >= this.channels.length) return;

    if (!this.pluginHost) return;
    const instance = await this.pluginHost.createInstance(pluginInfo);
    this.channels[channelIndex].plugins.push(instance);

    // Connect plugin to channel insert
    this.rebuildPluginChain(channelIndex);
    this.render();
  }

  removePlugin(channelIndex: number, pluginInstanceId: string): void {
    if (channelIndex < 0 || channelIndex >= this.channels.length) return;

    const idx = this.channels[channelIndex].plugins.findIndex(p => p.id === pluginInstanceId);
    if (idx !== -1) {
      this.pluginHost?.removeInstance(pluginInstanceId);
      this.channels[channelIndex].plugins.splice(idx, 1);
      this.rebuildPluginChain(channelIndex);
      this.render();
    }
  }

  private rebuildPluginChain(channelIndex: number): void {
    const insertPoint = this.audioEngine.getChannelInsertPoint(channelIndex);
    if (!insertPoint) return;

    const { input, output } = insertPoint;

    // Disconnect all
    try { input.disconnect(); } catch {}

    const plugins = this.channels[channelIndex].plugins.filter(p => !p.bypassed && p.audioNode);

    if (plugins.length === 0) {
      input.connect(output);
      return;
    }

    // Chain: input -> plugin1 -> plugin2 -> ... -> output
    let currentNode: AudioNode = input;
    for (const plugin of plugins) {
      const pluginIn = plugin.audioNode!;
      const pluginOut = (pluginIn as any)._outputNode || pluginIn;
      currentNode.connect(pluginIn);
      currentNode = pluginOut;
    }
    currentNode.connect(output);
  }

  toggle(): void {
    this.visible = !this.visible;
    this.container.style.display = this.visible ? 'flex' : 'none';
  }

  show(): void {
    this.visible = true;
    this.container.style.display = 'flex';
  }

  hide(): void {
    this.visible = false;
    this.container.style.display = 'none';
  }

  getMode(): 'channel' | 'track' {
    return this.mode;
  }

  private updateChannelStripDisplay(index: number): void {
    const strip = this.container.querySelector(`[data-channel="${index}"]`);
    if (!strip) return;

    const ch = this.channels[index];
    const muteBtn = strip.querySelector('.mixer-mute') as HTMLButtonElement;
    const soloBtn = strip.querySelector('.mixer-solo') as HTMLButtonElement;
    const volValue = strip.querySelector('.mixer-vol-value');

    if (muteBtn) muteBtn.classList.toggle('active', ch.mute);
    if (soloBtn) soloBtn.classList.toggle('active', ch.solo);
    if (volValue) volValue.textContent = `${ch.volume.toFixed(1)}`;
  }

  // ==================== Render ====================

  render(): void {
    if (this.mode === 'track') {
      this.renderTrackMode();
    } else {
      this.renderChannelMode();
    }
  }

  private renderChannelMode(): void {
    const numChannels = this.channels.length;
    if (numChannels === 0) {
      this.container.innerHTML = '<div class="mixer-empty">No audio loaded</div>';
      return;
    }

    let html = '<div class="mixer-channels">';

    // Channel strips
    for (let i = 0; i < numChannels; i++) {
      const ch = this.channels[i];
      const color = CHANNEL_COLORS[i % CHANNEL_COLORS.length];

      html += `
        <div class="mixer-strip" data-channel="${i}">
          <div class="mixer-strip-header" style="border-top: 3px solid ${color}">
            <span class="mixer-strip-name">${ch.name}</span>
          </div>
          <div class="mixer-strip-plugins">
            ${ch.plugins.map(p => `
              <div class="mixer-plugin-slot" data-plugin="${p.id}">
                <span class="mixer-plugin-name">${p.pluginInfo.name}</span>
                <button class="mixer-plugin-remove" data-channel="${i}" data-plugin-id="${p.id}">\u00d7</button>
              </div>
            `).join('')}
            <button class="mixer-plugin-add" data-channel="${i}">+ Insert</button>
          </div>
          <div class="mixer-strip-fader">
            <input type="range" class="mixer-fader" orient="vertical"
                   min="-60" max="12" step="0.1" value="${ch.volume}"
                   data-channel="${i}">
            <span class="mixer-vol-value">${ch.volume.toFixed(1)}</span>
          </div>
          <div class="mixer-strip-buttons">
            <button class="mixer-mute ${ch.mute ? 'active' : ''}" data-channel="${i}">M</button>
            <button class="mixer-solo ${ch.solo ? 'active' : ''}" data-channel="${i}">S</button>
          </div>
          <div class="mixer-strip-meter" data-channel="${i}">
            <div class="mixer-meter-bar"></div>
          </div>
        </div>
      `;
    }

    // Master strip
    html += this.renderMasterStrip();
    html += '</div>';

    this.container.innerHTML = html;
    this.attachChannelEventListeners();
  }

  private renderTrackMode(): void {
    if (this.trackStrips.length === 0) {
      this.container.innerHTML = '<div class="mixer-empty">No tracks</div>';
      return;
    }

    let html = '';

    // Header with title + Fader Law buttons
    html += `
      <div class="mixer-header">
        <span class="mixer-header-title">Mixer</span>
        <div class="mixer-fader-law-group">
          <button class="mixer-law-btn fader-law-ep ${this.faderLaw === 'equalPower' ? 'active' : ''}" title="Equal Power">EP</button>
          <button class="mixer-law-btn fader-law-eg ${this.faderLaw === 'equalGain' ? 'active' : ''}" title="Equal Gain">EG</button>
        </div>
      </div>
    `;

    // Channel strips area
    html += '<div class="mixer-channels">';

    for (const strip of this.trackStrips) {
      const panLabel = this.formatPan(strip.pan);

      html += `
        <div class="mixer-strip" data-track-id="${strip.trackId}">
          <div class="mixer-strip-header" style="border-top: 3px solid ${strip.color}">
            <span class="mixer-strip-name">${strip.name}</span>
          </div>
          <div class="mixer-strip-pan">
            <input type="range" class="mixer-pan-knob" min="-100" max="100" step="1"
                   value="${Math.round(strip.pan * 100)}" data-track-id="${strip.trackId}">
            <span class="mixer-pan-value">${panLabel}</span>
          </div>
          <div class="mixer-strip-fader">
            <input type="range" class="mixer-fader" orient="vertical"
                   min="-60" max="12" step="0.1" value="${strip.volume}"
                   data-track-id="${strip.trackId}">
            <span class="mixer-vol-value">${strip.volume.toFixed(1)}</span>
          </div>
          <div class="mixer-strip-buttons">
            <button class="mixer-mute ${strip.mute ? 'active' : ''}" data-track-id="${strip.trackId}">M</button>
            <button class="mixer-solo ${strip.solo ? 'active' : ''}" data-track-id="${strip.trackId}">S</button>
          </div>
          <div class="mixer-strip-meter" data-track-id="${strip.trackId}">
            <div class="mixer-meter-bar"></div>
          </div>
        </div>
      `;
    }

    // Master strip
    html += this.renderMasterStrip();
    html += '</div>';

    // Crossfader section (only when >= 2 tracks)
    if (this.trackStrips.length >= 2) {
      html += this.renderCrossfader();
    }

    this.container.innerHTML = html;
    this.attachTrackEventListeners();
  }

  private renderMasterStrip(): string {
    return `
      <div class="mixer-strip mixer-master">
        <div class="mixer-strip-header" style="border-top: 3px solid #fff">
          <span class="mixer-strip-name">Master</span>
        </div>
        <div class="mixer-strip-plugins"></div>
        <div class="mixer-strip-fader">
          <input type="range" class="mixer-fader mixer-master-fader" orient="vertical"
                 min="-60" max="12" step="0.1" value="${this.masterVolume}">
          <span class="master-volume-value">${this.masterVolume.toFixed(1)}</span>
        </div>
        <div class="mixer-strip-buttons"></div>
        <div class="mixer-strip-meter">
          <div class="mixer-meter-bar master-meter-bar"></div>
        </div>
      </div>
    `;
  }

  private renderCrossfader(): string {
    const options = this.trackStrips.map(s =>
      `<option value="${s.trackId}">${s.name}</option>`
    ).join('');

    return `
      <div class="mixer-crossfader">
        <div class="crossfader-header">
          <span class="crossfader-label">X-Fade</span>
          <div class="mixer-fader-law-group">
            <button class="mixer-law-btn xfade-law-ep ${this.crossfaderLaw === 'equalPower' ? 'active' : ''}" title="Equal Power">EP</button>
            <button class="mixer-law-btn xfade-law-eg ${this.crossfaderLaw === 'equalGain' ? 'active' : ''}" title="Equal Gain">EG</button>
          </div>
        </div>
        <div class="crossfader-controls">
          <select class="crossfader-select crossfader-select-a" title="Track A">
            <option value="">A: --</option>
            ${options}
          </select>
          <span class="crossfader-endpoint-label">A</span>
          <input type="range" class="crossfader-slider" min="-100" max="100" step="1"
                 value="${Math.round(this.crossfaderPosition * 100)}">
          <span class="crossfader-endpoint-label">B</span>
          <span class="crossfader-pos-label">${this.crossfaderPosition.toFixed(2)}</span>
          <select class="crossfader-select crossfader-select-b" title="Track B">
            <option value="">B: --</option>
            ${options}
          </select>
        </div>
      </div>
    `;
  }

  // ==================== Event Listeners ====================

  private attachChannelEventListeners(): void {
    // Master fader (shared)
    this.attachMasterFaderListener();

    // Channel faders
    this.container.querySelectorAll('.mixer-fader:not(.mixer-master-fader)').forEach(el => {
      el.addEventListener('input', (e) => {
        const target = e.target as HTMLInputElement;
        const ch = parseInt(target.dataset.channel!);
        this.setChannelVolume(ch, parseFloat(target.value));
      });
    });

    // Mute buttons
    this.container.querySelectorAll('.mixer-mute').forEach(el => {
      el.addEventListener('click', (e) => {
        const ch = parseInt((e.target as HTMLElement).dataset.channel!);
        this.setChannelMute(ch, !this.channels[ch].mute);
      });
    });

    // Solo buttons
    this.container.querySelectorAll('.mixer-solo').forEach(el => {
      el.addEventListener('click', (e) => {
        const ch = parseInt((e.target as HTMLElement).dataset.channel!);
        this.setChannelSolo(ch, !this.channels[ch].solo);
      });
    });

    // Plugin add buttons
    this.container.querySelectorAll('.mixer-plugin-add').forEach(el => {
      el.addEventListener('click', (e) => {
        const ch = parseInt((e.target as HTMLElement).dataset.channel!);
        if (this.onPluginInsertRequest) this.onPluginInsertRequest(ch);
      });
    });

    // Plugin remove buttons
    this.container.querySelectorAll('.mixer-plugin-remove').forEach(el => {
      el.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        const ch = parseInt(target.dataset.channel!);
        const pluginId = target.dataset.pluginId!;
        this.removePlugin(ch, pluginId);
      });
    });
  }

  private attachTrackEventListeners(): void {
    // Master fader (shared)
    this.attachMasterFaderListener();

    // Track faders
    this.container.querySelectorAll('.mixer-fader:not(.mixer-master-fader)').forEach(el => {
      el.addEventListener('input', (e) => {
        const target = e.target as HTMLInputElement;
        const trackId = target.dataset.trackId!;
        this.setTrackVolume(trackId, parseFloat(target.value));
      });
    });

    // Pan knobs
    this.container.querySelectorAll('.mixer-pan-knob').forEach(el => {
      el.addEventListener('input', (e) => {
        const target = e.target as HTMLInputElement;
        const trackId = target.dataset.trackId!;
        this.setTrackPan(trackId, parseInt(target.value) / 100);
      });
    });

    // Mute buttons
    this.container.querySelectorAll('.mixer-mute').forEach(el => {
      el.addEventListener('click', (e) => {
        const trackId = (e.target as HTMLElement).dataset.trackId!;
        const strip = this.trackStrips.find(s => s.trackId === trackId);
        if (strip) this.setTrackMute(trackId, !strip.mute);
      });
    });

    // Solo buttons
    this.container.querySelectorAll('.mixer-solo').forEach(el => {
      el.addEventListener('click', (e) => {
        const trackId = (e.target as HTMLElement).dataset.trackId!;
        const strip = this.trackStrips.find(s => s.trackId === trackId);
        if (strip) this.setTrackSolo(trackId, !strip.solo);
      });
    });

    // Fader law EP/EG toggle
    const epBtn = this.container.querySelector('.fader-law-ep');
    const egBtn = this.container.querySelector('.fader-law-eg');
    if (epBtn) {
      epBtn.addEventListener('click', () => this.setFaderLaw('equalPower'));
    }
    if (egBtn) {
      egBtn.addEventListener('click', () => this.setFaderLaw('equalGain'));
    }

    // Crossfader controls
    this.attachCrossfaderListeners();
  }

  private attachMasterFaderListener(): void {
    const masterFader = this.container.querySelector('.mixer-master-fader');
    if (masterFader) {
      masterFader.addEventListener('input', (e) => {
        this.setMasterVolume(parseFloat((e.target as HTMLInputElement).value));
      });
    }
  }

  private attachCrossfaderListeners(): void {
    // Crossfader slider
    const cfSlider = this.container.querySelector('.crossfader-slider');
    if (cfSlider) {
      cfSlider.addEventListener('input', (e) => {
        this.setCrossfaderPosition(parseInt((e.target as HTMLInputElement).value) / 100);
      });
    }

    // Track selectors
    const selectA = this.container.querySelector('.crossfader-select-a') as HTMLSelectElement;
    const selectB = this.container.querySelector('.crossfader-select-b') as HTMLSelectElement;

    if (selectA) {
      if (this.crossfaderTrackA) selectA.value = this.crossfaderTrackA;
      selectA.addEventListener('change', () => {
        this.crossfaderTrackA = selectA.value || null;
        this.applyCrossfaderAssignment();
      });
    }
    if (selectB) {
      if (this.crossfaderTrackB) selectB.value = this.crossfaderTrackB;
      selectB.addEventListener('change', () => {
        this.crossfaderTrackB = selectB.value || null;
        this.applyCrossfaderAssignment();
      });
    }

    // Crossfader law EP/EG
    const xEpBtn = this.container.querySelector('.xfade-law-ep');
    const xEgBtn = this.container.querySelector('.xfade-law-eg');
    if (xEpBtn) {
      xEpBtn.addEventListener('click', () => this.setCrossfaderLaw('equalPower'));
    }
    if (xEgBtn) {
      xEgBtn.addEventListener('click', () => this.setCrossfaderLaw('equalGain'));
    }
  }

  // ==================== Metering ====================

  /**
   * Update meter displays with current audio levels.
   * Works for both channel and track modes.
   */
  updateMeters(): void {
    if (this.mode === 'track') {
      this.updateTrackMeters();
    } else {
      this.updateChannelMeters();
    }
  }

  private updateChannelMeters(): void {
    for (let i = 0; i < this.channels.length; i++) {
      const analyser = this.audioEngine.getChannelAnalyser(i);
      if (!analyser) continue;
      this.updateMeterBar(
        this.container.querySelector(`[data-channel="${i}"] .mixer-meter-bar`) as HTMLElement,
        analyser,
      );
    }
  }

  private updateTrackMeters(): void {
    for (const strip of this.trackStrips) {
      const analyser = this.audioEngine.getTrackAnalyser(strip.trackId);
      if (!analyser) continue;
      this.updateMeterBar(
        this.container.querySelector(`[data-track-id="${strip.trackId}"] .mixer-meter-bar`) as HTMLElement,
        analyser,
      );
    }
  }

  private updateMeterBar(meterBar: HTMLElement | null, analyser: AnalyserNode): void {
    if (!meterBar) return;

    const data = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(data);

    let peak = 0;
    for (let j = 0; j < data.length; j++) {
      const abs = Math.abs(data[j]);
      if (abs > peak) peak = abs;
    }

    const db = peak > 0 ? 20 * Math.log10(peak) : -60;
    const percent = Math.max(0, Math.min(100, (db + 60) / 72 * 100));

    meterBar.style.height = `${percent}%`;
    if (db >= -1) meterBar.style.backgroundColor = '#ef4444';
    else if (db >= -6) meterBar.style.backgroundColor = '#f59e0b';
    else meterBar.style.backgroundColor = '#10b981';
  }

  // ==================== State ====================

  getState(): { channels: ChannelStripState[]; masterVolume: number } {
    return {
      channels: this.channels.map(ch => ({ ...ch, plugins: [] })), // Don't serialize plugin instances
      masterVolume: this.masterVolume,
    };
  }

  getTrackState(): { tracks: Track[]; masterVolume: number } {
    return {
      tracks: this.trackStrips.map(s => ({
        id: s.trackId,
        name: s.name,
        color: s.color,
        volume: s.volume,
        pan: s.pan,
        mute: s.mute,
        solo: s.solo,
        clips: [],
        channelIndex: 0,
      })),
      masterVolume: this.masterVolume,
    };
  }
}
