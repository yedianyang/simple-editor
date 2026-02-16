import { ChannelStripState, CHANNEL_COLORS, CHANNEL_NAMES, PluginInstance } from '../core/types';
import { AudioEngine } from '../core/AudioEngine';
import { PluginHost } from '../plugins/PluginHost';

/**
 * Mixer with per-channel strips, plugin inserts, and master bus.
 * Provides both the data model and canvas-based rendering.
 */
export class Mixer {
  container: HTMLElement;
  audioEngine: AudioEngine;
  pluginHost: PluginHost;
  channels: ChannelStripState[] = [];
  masterVolume = 0; // dB
  visible = false;

  // Callbacks
  onPluginInsertRequest: ((channelIndex: number) => void) | null = null;

  constructor(container: HTMLElement, audioEngine: AudioEngine, pluginHost: PluginHost) {
    this.container = container;
    this.audioEngine = audioEngine;
    this.pluginHost = pluginHost;
  }

  /**
   * Initialize mixer channels based on the loaded audio buffer.
   */
  setupChannels(numChannels: number): void {
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

  setMasterVolume(db: number): void {
    this.masterVolume = db;
    this.audioEngine.setMasterVolume(db);
    const el = this.container.querySelector('.master-volume-value');
    if (el) el.textContent = `${db.toFixed(1)} dB`;
  }

  async addPlugin(channelIndex: number, pluginInfo: any): Promise<void> {
    if (channelIndex < 0 || channelIndex >= this.channels.length) return;

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
      this.pluginHost.removeInstance(pluginInstanceId);
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

  render(): void {
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
                <button class="mixer-plugin-remove" data-channel="${i}" data-plugin-id="${p.id}">×</button>
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
    html += `
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

    html += '</div>';
    this.container.innerHTML = html;

    // Attach event listeners
    this.attachEventListeners();
  }

  private attachEventListeners(): void {
    // Faders
    this.container.querySelectorAll('.mixer-fader:not(.mixer-master-fader)').forEach(el => {
      el.addEventListener('input', (e) => {
        const target = e.target as HTMLInputElement;
        const ch = parseInt(target.dataset.channel!);
        this.setChannelVolume(ch, parseFloat(target.value));
      });
    });

    // Master fader
    const masterFader = this.container.querySelector('.mixer-master-fader');
    if (masterFader) {
      masterFader.addEventListener('input', (e) => {
        this.setMasterVolume(parseFloat((e.target as HTMLInputElement).value));
      });
    }

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

  /**
   * Update meter displays with current audio levels.
   */
  updateMeters(): void {
    for (let i = 0; i < this.channels.length; i++) {
      const analyser = this.audioEngine.getChannelAnalyser(i);
      if (!analyser) continue;

      const data = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(data);

      let peak = 0;
      for (let j = 0; j < data.length; j++) {
        const abs = Math.abs(data[j]);
        if (abs > peak) peak = abs;
      }

      const db = peak > 0 ? 20 * Math.log10(peak) : -60;
      const percent = Math.max(0, Math.min(100, (db + 60) / 72 * 100));

      const meterBar = this.container.querySelector(`[data-channel="${i}"] .mixer-meter-bar`) as HTMLElement;
      if (meterBar) {
        meterBar.style.height = `${percent}%`;
        if (db >= -1) meterBar.style.backgroundColor = '#ef4444';
        else if (db >= -6) meterBar.style.backgroundColor = '#f59e0b';
        else meterBar.style.backgroundColor = '#10b981';
      }
    }
  }

  getState(): { channels: ChannelStripState[]; masterVolume: number } {
    return {
      channels: this.channels.map(ch => ({ ...ch, plugins: [] })), // Don't serialize plugin instances
      masterVolume: this.masterVolume,
    };
  }
}
