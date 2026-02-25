import { CHANNEL_COLORS, Track, TrackInsert, FaderLaw } from '../core/types';
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
  inserts: TrackInsert[];
}

/**
 * Mixer with per-track strips, plugin inserts, and master bus.
 * Operates in track mode (timeline playback) with Fader Law + Crossfader.
 */
export class Mixer {
  container: HTMLElement;
  audioEngine: AudioEngine;
  pluginHost: PluginHost | null;
  masterVolume = 0; // dB
  visible = false;

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
  onPluginAdd: ((trackId: string) => void) | null = null;
  onPluginRemove: ((trackId: string, instanceId: string) => void) | null = null;
  onPluginBypass: ((trackId: string, instanceId: string) => void) | null = null;
  onPluginReorder: ((trackId: string, fromIndex: number, toIndex: number) => void) | null = null;
  onPluginSelect: ((trackId: string, instanceId: string) => void) | null = null;

  constructor(container: HTMLElement, audioEngine: AudioEngine, pluginHost: PluginHost | null) {
    this.container = container;
    this.audioEngine = audioEngine;
    this.pluginHost = pluginHost;
  }

  // ==================== Track Mode ====================

  /**
   * Initialize mixer strips from Track objects for timeline playback.
   * Builds one channel strip per track, sets up audio routing via AudioEngine.
   */
  setupTracks(tracks: Track[]): void {
    this.trackStrips = tracks.map(t => ({
      trackId: t.id,
      name: t.name,
      color: t.color,
      volume: t.volume,
      pan: t.pan,
      mute: t.mute,
      solo: t.solo,
      inserts: t.inserts,
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

  getMode(): 'track' {
    return 'track';
  }

  // ==================== Render ====================
  // TODO: Replace innerHTML-based rendering with DOM diffing or incremental updates
  // to avoid destroying/recreating event listeners on every render call.

  render(): void {
    this.renderTrackMode();
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
          <div class="mixer-strip-plugins" data-track-id="${strip.trackId}">
            ${strip.inserts.map((insert, i) => `
              <div class="mixer-plugin-slot ${insert.bypassed ? 'bypassed' : ''}"
                   data-instance-id="${insert.instanceId}" data-slot-index="${i}"
                   draggable="true">
                <span class="mixer-plugin-name" data-instance-id="${insert.instanceId}">${this.getPluginDisplayName(insert.pluginId)}</span>
                <button class="mixer-plugin-bypass ${insert.bypassed ? 'active' : ''}" data-instance-id="${insert.instanceId}" data-track-id="${strip.trackId}" title="Bypass">B</button>
                <button class="mixer-plugin-remove" data-instance-id="${insert.instanceId}" data-track-id="${strip.trackId}" title="Remove">&times;</button>
              </div>
            `).join('')}
            <button class="mixer-plugin-add" data-track-id="${strip.trackId}">+ Insert</button>
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

    // Plugin insert slots
    this.attachPluginListeners();

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

  // ==================== Plugin Helpers ====================

  private getPluginDisplayName(pluginId: string): string {
    // 'builtin:eq7' → 'EQ7', 'builtin:compressor' → 'Comp', etc.
    const shortNames: Record<string, string> = {
      'builtin:eq7': 'EQ7',
      'builtin:compressor': 'Comp',
      'builtin:gain': 'Gain',
      'builtin:delay': 'Delay',
      'builtin:reverb': 'Reverb',
    };
    if (shortNames[pluginId]) return shortNames[pluginId];
    // For external plugins, take the last segment
    const parts = pluginId.split(':');
    return parts[parts.length - 1].substring(0, 8);
  }

  private attachPluginListeners(): void {
    // Add plugin button
    this.container.querySelectorAll('.mixer-plugin-add').forEach(el => {
      el.addEventListener('click', (e) => {
        const trackId = (e.target as HTMLElement).dataset.trackId!;
        if (this.onPluginAdd) this.onPluginAdd(trackId);
      });
    });

    // Remove plugin button
    this.container.querySelectorAll('.mixer-plugin-remove').forEach(el => {
      el.addEventListener('click', (e) => {
        const btn = e.target as HTMLElement;
        const instanceId = btn.dataset.instanceId!;
        const trackId = btn.dataset.trackId!;
        if (this.onPluginRemove) this.onPluginRemove(trackId, instanceId);
      });
    });

    // Bypass plugin button
    this.container.querySelectorAll('.mixer-plugin-bypass').forEach(el => {
      el.addEventListener('click', (e) => {
        const btn = e.target as HTMLElement;
        const instanceId = btn.dataset.instanceId!;
        const trackId = btn.dataset.trackId!;
        if (this.onPluginBypass) this.onPluginBypass(trackId, instanceId);
      });
    });

    // Click plugin name → open parameter panel
    this.container.querySelectorAll('.mixer-plugin-name').forEach(el => {
      el.addEventListener('click', (e) => {
        const span = e.target as HTMLElement;
        const instanceId = span.dataset.instanceId!;
        const slot = span.closest('.mixer-plugin-slot') as HTMLElement;
        const trackId = slot?.closest('.mixer-strip-plugins')?.getAttribute('data-track-id');
        if (trackId && this.onPluginSelect) this.onPluginSelect(trackId, instanceId);
      });
    });

    // Drag-to-reorder
    this.container.querySelectorAll('.mixer-plugin-slot').forEach(el => {
      const slot = el as HTMLElement;

      slot.addEventListener('dragstart', (e) => {
        const de = e as DragEvent;
        if (de.dataTransfer) {
          de.dataTransfer.effectAllowed = 'move';
          de.dataTransfer.setData('text/plain', slot.dataset.slotIndex || '');
        }
        slot.classList.add('dragging');
      });

      slot.addEventListener('dragend', () => {
        slot.classList.remove('dragging');
        // Clean up all drag-over indicators
        this.container.querySelectorAll('.drag-over').forEach(el2 =>
          el2.classList.remove('drag-over'));
      });

      slot.addEventListener('dragover', (e) => {
        e.preventDefault();
        (e as DragEvent).dataTransfer!.dropEffect = 'move';
        slot.classList.add('drag-over');
      });

      slot.addEventListener('dragleave', () => {
        slot.classList.remove('drag-over');
      });

      slot.addEventListener('drop', (e) => {
        e.preventDefault();
        slot.classList.remove('drag-over');
        const de = e as DragEvent;
        const fromIndex = parseInt(de.dataTransfer?.getData('text/plain') || '-1');
        const toIndex = parseInt(slot.dataset.slotIndex || '-1');
        if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return;

        const trackId = slot.closest('.mixer-strip-plugins')?.getAttribute('data-track-id');
        if (trackId && this.onPluginReorder) {
          this.onPluginReorder(trackId, fromIndex, toIndex);
        }
      });
    });
  }

  // ==================== Metering ====================

  updateMeters(): void {
    this.updateTrackMeters();
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
        inserts: s.inserts,
      })),
      masterVolume: this.masterVolume,
    };
  }
}
