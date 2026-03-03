import { PluginInfo, PluginInstance, PluginParameter } from '../core/types';

/**
 * VST3/AudioUnit Plugin Host.
 *
 * Two modes of operation:
 * 1. Native mode: Uses the C++ native addon via Electron IPC for real VST3/AU hosting
 * 2. Web Audio mode: Uses built-in Web Audio API effects as fallback
 *
 * Built-in Web Audio effects include:
 * - 7-Band Parametric EQ (HP + 7 peaking bands + LP)
 * - Compressor
 * - Gain
 * - Delay
 * - Reverb (convolution)
 */
export class PluginHost {
  private audioContext: AudioContext;
  private instances: Map<string, PluginInstance> = new Map();
  private availablePlugins: PluginInfo[] = [];
  private nextInstanceId = 1;
  private wienerModuleLoaded = false;

  // Built-in Web Audio plugins
  private static readonly BUILTIN_PLUGINS: PluginInfo[] = [
    {
      id: 'builtin:eq7',
      name: '7-Band EQ',
      path: '',
      type: 'effect',
      format: 'WebAudio',
      category: 'EQ',
      vendor: 'FieldCorder',
    },
    {
      id: 'builtin:compressor',
      name: 'Compressor',
      path: '',
      type: 'effect',
      format: 'WebAudio',
      category: 'Dynamics',
      vendor: 'FieldCorder',
    },
    {
      id: 'builtin:gain',
      name: 'Gain',
      path: '',
      type: 'effect',
      format: 'WebAudio',
      category: 'Utility',
      vendor: 'FieldCorder',
    },
    {
      id: 'builtin:delay',
      name: 'Delay',
      path: '',
      type: 'effect',
      format: 'WebAudio',
      category: 'Time',
      vendor: 'FieldCorder',
    },
    {
      id: 'builtin:reverb',
      name: 'Reverb',
      path: '',
      type: 'effect',
      format: 'WebAudio',
      category: 'Reverb',
      vendor: 'FieldCorder',
    },
    {
      id: 'builtin:wiener-filter',
      name: 'Noise Reduction',
      path: '',
      type: 'effect',
      format: 'WebAudio',
      category: 'Restoration',
      vendor: 'FieldCorder',
    },
  ];

  constructor(audioContext: AudioContext) {
    this.audioContext = audioContext;
    this.availablePlugins = [...PluginHost.BUILTIN_PLUGINS];
  }

  getAvailablePlugins(): PluginInfo[] {
    return this.availablePlugins;
  }

  addScannedPlugins(plugins: PluginInfo[]): void {
    // Remove duplicates by id or path
    const existingIds = new Set(this.availablePlugins.map(p => p.id));
    const existingPaths = new Set(this.availablePlugins.map(p => p.path));
    for (const plugin of plugins) {
      if (!existingIds.has(plugin.id) && !existingPaths.has(plugin.path)) {
        this.availablePlugins.push(plugin);
        existingIds.add(plugin.id);
        existingPaths.add(plugin.path);
      }
    }
  }

  /**
   * Scan for native AU plugins using the native addon.
   * Falls back to filesystem scanning via Electron menu handler.
   */
  async scanNativePlugins(): Promise<void> {
    if (!window.appAPI) return;

    try {
      const result = await window.appAPI.scanPlugins();
      if (Array.isArray(result) && result.length > 0) {
        const plugins: PluginInfo[] = result.map((p: any) => ({
          id: p.id,
          name: p.name,
          path: p.id,  // AU identifier used as path
          type: (p.category === 'instrument' ? 'instrument' : 'effect') as 'effect' | 'instrument',
          format: p.format as 'AudioUnit',
          category: p.category,
          vendor: p.vendor,
        }));
        this.addScannedPlugins(plugins);
      }
    } catch (err) {
      console.warn('Native plugin scan failed:', err);
    }
  }

  /**
   * Instantiate a plugin and return a connected Web Audio node chain.
   */
  async createInstance(pluginInfo: PluginInfo): Promise<PluginInstance> {
    const instanceId = `inst_${this.nextInstanceId++}`;

    if (pluginInfo.format === 'WebAudio') {
      return await this.createBuiltinInstance(instanceId, pluginInfo);
    }

    // For VST3/AU, try native loading via Electron
    if (window.appAPI) {
      // Use plugin id (AU identifier) or path for loading
      const loadId = pluginInfo.id || pluginInfo.path;
      const result = await window.appAPI.loadPlugin(loadId);
      if (result && !result.error) {
        const parameters: PluginParameter[] = (result.parameters || []).map((p: any) => ({
          id: p.id,
          name: p.name,
          value: p.value,
          min: p.min,
          max: p.max,
          defaultValue: p.defaultValue,
          unit: p.unit || '',
        }));

        const instance: PluginInstance = {
          id: instanceId,
          pluginInfo: {
            ...pluginInfo,
            parameters,
          },
          parameters,
          bypassed: false,
        };

        // Store the native plugin ID for parameter/process calls
        (instance as any)._nativeId = result.id;

        this.instances.set(instanceId, instance);
        return instance;
      }
      if (result?.error) {
        throw new Error(`Plugin load error: ${result.error}`);
      }
    }

    throw new Error(`Cannot load plugin: ${pluginInfo.name}`);
  }

  private async createBuiltinInstance(instanceId: string, pluginInfo: PluginInfo): Promise<PluginInstance> {
    let audioNode: AudioNode;
    let parameters: PluginParameter[] = [];

    switch (pluginInfo.id) {
      case 'builtin:eq7': {
        // 7-band parametric EQ with cascaded HP/LP for variable slope
        // HP(4 stages) → Band1(LS) → Band2-6(PK) → Band7(HS) → LP(4 stages)
        const bandDefaults: { type: BiquadFilterType; freq: number }[] = [
          { type: 'lowshelf', freq: 80 },
          { type: 'peaking', freq: 200 },
          { type: 'peaking', freq: 500 },
          { type: 'peaking', freq: 1000 },
          { type: 'peaking', freq: 2500 },
          { type: 'peaking', freq: 6300 },
          { type: 'highshelf', freq: 12000 },
        ];

        // HP: 4 cascaded highpass filters (disabled = 1Hz passthrough)
        const hpFilters: BiquadFilterNode[] = [];
        for (let i = 0; i < 4; i++) {
          const hp = this.audioContext.createBiquadFilter();
          hp.type = 'highpass';
          hp.frequency.value = 1;
          hp.Q.value = 0.707;
          hpFilters.push(hp);
        }

        // 7 band filters
        const bands: BiquadFilterNode[] = [];
        for (const def of bandDefaults) {
          const band = this.audioContext.createBiquadFilter();
          band.type = def.type;
          band.frequency.value = def.freq;
          band.gain.value = 0;
          band.Q.value = 1.0;
          bands.push(band);
        }

        // LP: 4 cascaded lowpass filters (disabled = 22050Hz passthrough)
        const lpFilters: BiquadFilterNode[] = [];
        for (let i = 0; i < 4; i++) {
          const lp = this.audioContext.createBiquadFilter();
          lp.type = 'lowpass';
          lp.frequency.value = 22050;
          lp.Q.value = 0.707;
          lpFilters.push(lp);
        }

        // Chain: hp0→hp1→hp2→hp3→b1→...→b7→lp0→lp1→lp2→lp3
        const allFilters = [...hpFilters, ...bands, ...lpFilters];
        for (let i = 0; i < allFilters.length - 1; i++) {
          allFilters[i].connect(allFilters[i + 1]);
        }

        audioNode = hpFilters[0];
        (audioNode as any)._hpFilters = hpFilters;
        (audioNode as any)._bandFilters = bands;
        (audioNode as any)._lpFilters = lpFilters;
        (audioNode as any)._allFilters = allFilters;
        (audioNode as any)._outputNode = lpFilters[3];

        // 36 params: HP(enabled,freq) + 7×Band(enabled,freq,gain,Q) + LP(enabled,freq) + HP Q + LP Q + HP Slope + LP Slope
        parameters = [
          { id: 0, name: 'HP Enabled', value: 0, min: 0, max: 1, defaultValue: 0 },
          { id: 1, name: 'HP Freq', value: 20, min: 20, max: 1000, defaultValue: 20, unit: 'Hz' },
        ];
        const bandNames = ['Band 1', 'Band 2', 'Band 3', 'Band 4', 'Band 5', 'Band 6', 'Band 7'];
        for (let i = 0; i < 7; i++) {
          const base = 2 + i * 4;
          parameters.push(
            { id: base, name: `${bandNames[i]} Enabled`, value: 1, min: 0, max: 1, defaultValue: 1 },
            { id: base + 1, name: `${bandNames[i]} Freq`, value: bandDefaults[i].freq, min: 20, max: 20000, defaultValue: bandDefaults[i].freq, unit: 'Hz' },
            { id: base + 2, name: `${bandNames[i]} Gain`, value: 0, min: -24, max: 24, defaultValue: 0, unit: 'dB' },
            { id: base + 3, name: `${bandNames[i]} Q`, value: 1.0, min: 0.1, max: 10, defaultValue: 1.0 },
          );
        }
        parameters.push(
          { id: 30, name: 'LP Enabled', value: 0, min: 0, max: 1, defaultValue: 0 },
          { id: 31, name: 'LP Freq', value: 20000, min: 200, max: 20000, defaultValue: 20000, unit: 'Hz' },
          { id: 32, name: 'HP Q', value: 0.707, min: 0.1, max: 10, defaultValue: 0.707 },
          { id: 33, name: 'LP Q', value: 0.707, min: 0.1, max: 10, defaultValue: 0.707 },
          { id: 34, name: 'HP Slope', value: 12, min: 12, max: 48, defaultValue: 12 },
          { id: 35, name: 'LP Slope', value: 12, min: 12, max: 48, defaultValue: 12 },
        );
        break;
      }

      case 'builtin:compressor': {
        const comp = this.audioContext.createDynamicsCompressor();
        comp.threshold.value = -24;
        comp.knee.value = 12;
        comp.ratio.value = 4;
        comp.attack.value = 0.003;
        comp.release.value = 0.25;
        audioNode = comp;
        parameters = [
          { id: 0, name: 'Threshold', value: -24, min: -60, max: 0, defaultValue: -24, unit: 'dB' },
          { id: 1, name: 'Knee', value: 12, min: 0, max: 40, defaultValue: 12, unit: 'dB' },
          { id: 2, name: 'Ratio', value: 4, min: 1, max: 20, defaultValue: 4 },
          { id: 3, name: 'Attack', value: 0.003, min: 0, max: 1, defaultValue: 0.003, unit: 's' },
          { id: 4, name: 'Release', value: 0.25, min: 0, max: 1, defaultValue: 0.25, unit: 's' },
        ];
        break;
      }

      case 'builtin:gain': {
        const gain = this.audioContext.createGain();
        gain.gain.value = 1.0;
        audioNode = gain;
        parameters = [
          { id: 0, name: 'Gain', value: 0, min: -60, max: 24, defaultValue: 0, unit: 'dB' },
        ];
        break;
      }

      case 'builtin:delay': {
        const input = this.audioContext.createGain();
        const delay = this.audioContext.createDelay(5.0);
        delay.delayTime.value = 0.25;
        const feedback = this.audioContext.createGain();
        feedback.gain.value = 0.3;
        const wet = this.audioContext.createGain();
        wet.gain.value = 0.3;
        const dry = this.audioContext.createGain();
        dry.gain.value = 0.7;
        const merger = this.audioContext.createGain();

        // input -> dry -> merger
        // input -> delay -> wet -> merger
        // delay -> feedback -> delay
        input.connect(dry);
        input.connect(delay);
        delay.connect(wet);
        delay.connect(feedback);
        feedback.connect(delay);
        wet.connect(merger);
        dry.connect(merger);

        audioNode = input;
        (audioNode as any)._dryNode = dry;
        (audioNode as any)._delayNode = delay;
        (audioNode as any)._feedbackNode = feedback;
        (audioNode as any)._wetNode = wet;
        (audioNode as any)._outputNode = merger;

        parameters = [
          { id: 0, name: 'Time', value: 0.25, min: 0.01, max: 5.0, defaultValue: 0.25, unit: 's' },
          { id: 1, name: 'Feedback', value: 0.3, min: 0, max: 0.95, defaultValue: 0.3 },
          { id: 2, name: 'Mix', value: 0.3, min: 0, max: 1, defaultValue: 0.3 },
        ];
        break;
      }

      case 'builtin:reverb': {
        // Simple reverb using convolution
        const input = this.audioContext.createGain();
        const convolver = this.audioContext.createConvolver();
        const wet = this.audioContext.createGain();
        wet.gain.value = 0.3;
        const dry = this.audioContext.createGain();
        dry.gain.value = 0.7;
        const merger = this.audioContext.createGain();

        // input -> dry -> merger
        // input -> convolver -> wet -> merger
        input.connect(dry);
        input.connect(convolver);
        convolver.connect(wet);
        wet.connect(merger);
        dry.connect(merger);

        // Generate impulse response
        this.generateReverbIR(convolver, 2.0, 0.5);

        audioNode = input;
        (audioNode as any)._dryNode = dry;
        (audioNode as any)._convolverNode = convolver;
        (audioNode as any)._wetNode = wet;
        (audioNode as any)._outputNode = merger;

        parameters = [
          { id: 0, name: 'Decay', value: 2.0, min: 0.1, max: 10, defaultValue: 2.0, unit: 's' },
          { id: 1, name: 'Mix', value: 0.3, min: 0, max: 1, defaultValue: 0.3 },
          { id: 2, name: 'Damping', value: 0.5, min: 0, max: 1, defaultValue: 0.5 },
        ];
        break;
      }

      case 'builtin:wiener-filter': {
        // Load AudioWorklet module once
        if (!this.wienerModuleLoaded) {
          await this.audioContext.audioWorklet.addModule('/wiener-filter-processor.js');
          this.wienerModuleLoaded = true;
        }

        const workletNode = new AudioWorkletNode(this.audioContext, 'wiener-filter-processor', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [2],
        });

        audioNode = workletNode;
        // Store port reference for parameter updates and noise learning
        (audioNode as any)._workletPort = workletNode.port;

        parameters = [
          { id: 0, name: 'Reduction', value: 0.5, min: 0, max: 1, defaultValue: 0.5 },
          { id: 1, name: 'Smoothing', value: 0.98, min: 0.5, max: 0.999, defaultValue: 0.98 },
          // id 2 is a trigger parameter for Learn Noise (value: 0=idle, 1=learning)
          { id: 2, name: 'Learn Noise', value: 0, min: 0, max: 1, defaultValue: 0 },
        ];
        break;
      }

      default:
        throw new Error(`Unknown builtin plugin: ${pluginInfo.id}`);
    }

    const instance: PluginInstance = {
      id: instanceId,
      pluginInfo,
      parameters,
      bypassed: false,
      audioNode,
    };

    this.instances.set(instanceId, instance);
    return instance;
  }

  private generateReverbIR(convolver: ConvolverNode, decay: number, damping: number): void {
    const sampleRate = this.audioContext.sampleRate;
    const length = Math.floor(sampleRate * decay);
    const impulse = this.audioContext.createBuffer(2, length, sampleRate);

    for (let c = 0; c < 2; c++) {
      const channel = impulse.getChannelData(c);
      for (let i = 0; i < length; i++) {
        const t = i / sampleRate;
        const envelope = Math.exp(-t / (decay * 0.3)) * Math.pow(1 - damping, t * 2);
        channel[i] = (Math.random() * 2 - 1) * envelope;
      }
    }

    convolver.buffer = impulse;
  }

  setParameter(instanceId: string, paramId: number, value: number): void {
    const instance = this.instances.get(instanceId);
    if (!instance) return;

    const param = instance.parameters.find(p => p.id === paramId);
    if (param) {
      param.value = value;
    }

    // Update Web Audio node
    if (instance.audioNode && instance.pluginInfo.format === 'WebAudio') {
      this.updateBuiltinParameter(instance, paramId, value);
    }

    // Update native plugin
    if (instance.pluginInfo.format !== 'WebAudio' && window.appAPI) {
      const nativeId = (instance as any)._nativeId || instanceId;
      window.appAPI.setPluginParameter(nativeId, paramId, value);
    }
  }

  private updateBuiltinParameter(instance: PluginInstance, paramId: number, value: number): void {
    const node = instance.audioNode as any;
    if (!node) return;

    switch (instance.pluginInfo.id) {
      case 'builtin:eq7': {
        const hpFilters: BiquadFilterNode[] | undefined = node._hpFilters;
        const bandFilters: BiquadFilterNode[] | undefined = node._bandFilters;
        const lpFilters: BiquadFilterNode[] | undefined = node._lpFilters;
        if (!hpFilters || !bandFilters || !lpFilters) break;

        const getVal = (id: number, fallback: number) =>
          instance.parameters.find(p => p.id === id)?.value ?? fallback;

        // HP: id 0=enabled, id 1=freq, id 32=Q, id 34=slope
        if (paramId === 0) {
          const hpFreq = getVal(1, 20);
          const activeCount = Math.round(getVal(34, 12) / 12);
          for (let i = 0; i < 4; i++) {
            hpFilters[i].frequency.value = (value >= 0.5 && i < activeCount) ? hpFreq : 1;
          }
        } else if (paramId === 1) {
          if (getVal(0, 0) >= 0.5) {
            const activeCount = Math.round(getVal(34, 12) / 12);
            for (let i = 0; i < activeCount; i++) hpFilters[i].frequency.value = value;
          }
        } else if (paramId === 32) {
          for (const f of hpFilters) f.Q.value = value;
        } else if (paramId === 34) {
          const hpEnabled = getVal(0, 0) >= 0.5;
          const hpFreq = getVal(1, 20);
          const activeCount = Math.round(value / 12);
          for (let i = 0; i < 4; i++) {
            hpFilters[i].frequency.value = (hpEnabled && i < activeCount) ? hpFreq : 1;
          }
        }
        // Bands 1-7: ids 2-29, groups of 4 (enabled, freq, gain, Q)
        else if (paramId >= 2 && paramId <= 29) {
          const bandIndex = Math.floor((paramId - 2) / 4);
          const bandParam = (paramId - 2) % 4;
          const filter = bandFilters[bandIndex];
          if (filter) {
            if (bandParam === 0) {
              if (value < 0.5) filter.gain.value = 0;
              else {
                const gainParam = instance.parameters.find(p => p.id === 2 + bandIndex * 4 + 2);
                filter.gain.value = gainParam?.value ?? 0;
              }
            } else if (bandParam === 1) filter.frequency.value = value;
            else if (bandParam === 2) {
              const enabledParam = instance.parameters.find(p => p.id === 2 + bandIndex * 4);
              if ((enabledParam?.value ?? 1) >= 0.5) filter.gain.value = value;
            }
            else if (bandParam === 3) filter.Q.value = value;
          }
        }
        // LP: id 30=enabled, id 31=freq, id 33=Q, id 35=slope
        else if (paramId === 30) {
          const lpFreq = getVal(31, 20000);
          const activeCount = Math.round(getVal(35, 12) / 12);
          for (let i = 0; i < 4; i++) {
            lpFilters[i].frequency.value = (value >= 0.5 && i < activeCount) ? lpFreq : 22050;
          }
        } else if (paramId === 31) {
          if (getVal(30, 0) >= 0.5) {
            const activeCount = Math.round(getVal(35, 12) / 12);
            for (let i = 0; i < activeCount; i++) lpFilters[i].frequency.value = value;
          }
        } else if (paramId === 33) {
          for (const f of lpFilters) f.Q.value = value;
        } else if (paramId === 35) {
          const lpEnabled = getVal(30, 0) >= 0.5;
          const lpFreq = getVal(31, 20000);
          const activeCount = Math.round(value / 12);
          for (let i = 0; i < 4; i++) {
            lpFilters[i].frequency.value = (lpEnabled && i < activeCount) ? lpFreq : 22050;
          }
        }
        break;
      }
      case 'builtin:compressor': {
        const comp = node as DynamicsCompressorNode;
        if (paramId === 0) comp.threshold.value = value;
        else if (paramId === 1) comp.knee.value = value;
        else if (paramId === 2) comp.ratio.value = value;
        else if (paramId === 3) comp.attack.value = value;
        else if (paramId === 4) comp.release.value = value;
        break;
      }
      case 'builtin:gain': {
        const gain = node as GainNode;
        if (paramId === 0) gain.gain.value = Math.pow(10, value / 20);
        break;
      }
      case 'builtin:delay': {
        if (paramId === 0 && node._delayNode) node._delayNode.delayTime.value = value;
        else if (paramId === 1 && node._feedbackNode) node._feedbackNode.gain.value = value;
        else if (paramId === 2 && node._wetNode) {
          node._wetNode.gain.value = value;
          if (node._dryNode) node._dryNode.gain.value = 1 - value;
        }
        break;
      }
      case 'builtin:reverb': {
        if (paramId === 0 && node._convolverNode) {
          this.generateReverbIR(node._convolverNode, value, instance.parameters[2]?.value || 0.5);
        }
        else if (paramId === 1 && node._wetNode) {
          node._wetNode.gain.value = value;
          if (node._dryNode) node._dryNode.gain.value = 1 - value;
        }
        else if (paramId === 2 && node._convolverNode) {
          this.generateReverbIR(node._convolverNode, instance.parameters[0]?.value || 2.0, value);
        }
        break;
      }
      case 'builtin:wiener-filter': {
        const port = node._workletPort as MessagePort | undefined;
        if (!port) break;
        if (paramId === 0) {
          port.postMessage({ type: 'setReductionStrength', value });
        } else if (paramId === 1) {
          port.postMessage({ type: 'setSmoothingFactor', value });
        }
        // paramId 2 (Learn Noise) is handled via sendNoiseProfile() / clearNoiseProfile()
        break;
      }
    }
  }

  /**
   * Connect a plugin instance into a channel's insert chain.
   * input -> pluginIn ... pluginOut -> output
   */
  connectToInsert(instanceId: string, input: GainNode, output: GainNode): void {
    const instance = this.instances.get(instanceId);
    if (!instance || !instance.audioNode) return;

    // Disconnect direct path
    try { input.disconnect(output); } catch {}

    // Connect: input -> plugin -> output
    const pluginIn = instance.audioNode;
    const pluginOut = (pluginIn as any)._outputNode || pluginIn;

    input.connect(pluginIn);
    pluginOut.connect(output);
  }

  /**
   * Disconnect a plugin from the insert chain and restore direct connection.
   */
  disconnectFromInsert(instanceId: string, input: GainNode, output: GainNode): void {
    const instance = this.instances.get(instanceId);
    if (!instance || !instance.audioNode) return;

    const pluginIn = instance.audioNode;
    const pluginOut = (pluginIn as any)._outputNode || pluginIn;

    try { input.disconnect(pluginIn); } catch {}
    try { pluginOut.disconnect(output); } catch {}

    input.connect(output);
  }

  /**
   * Wire a list of plugin instances in series between insertIn and insertOut.
   * If no instances, connects insertIn directly to insertOut (bypass).
   */
  connectChain(instances: PluginInstance[], insertIn: GainNode, insertOut: GainNode): void {
    // Disconnect insertIn from all destinations
    try { insertIn.disconnect(); } catch { /* nothing connected */ }

    if (instances.length === 0) {
      insertIn.connect(insertOut);
      return;
    }

    // Chain: insertIn → inst1_in, inst1_out → inst2_in, ..., instN_out → insertOut
    let prev: AudioNode = insertIn;
    for (const inst of instances) {
      const pluginIn = inst.audioNode!;
      const pluginOut = (pluginIn as any)._outputNode || pluginIn;
      prev.connect(pluginIn);
      prev = pluginOut;
    }
    prev.connect(insertOut);
  }

  /**
   * Send a noise-only audio segment to a Wiener filter instance for learning.
   * The worklet will compute the noise PSD from this segment.
   */
  sendNoiseProfile(instanceId: string, samples: Float32Array): void {
    const instance = this.instances.get(instanceId);
    if (!instance?.audioNode) return;
    const port = (instance.audioNode as any)._workletPort as MessagePort | undefined;
    if (!port) return;
    // Transfer the buffer for zero-copy
    const copy = new Float32Array(samples);
    port.postMessage({ type: 'learnNoise', samples: copy.buffer }, [copy.buffer]);
  }

  /**
   * Clear the noise profile from a Wiener filter instance.
   */
  clearNoiseProfile(instanceId: string): void {
    const instance = this.instances.get(instanceId);
    if (!instance?.audioNode) return;
    const port = (instance.audioNode as any)._workletPort as MessagePort | undefined;
    if (!port) return;
    port.postMessage({ type: 'clearNoise' });
  }

  removeInstance(instanceId: string): void {
    const instance = this.instances.get(instanceId);
    if (!instance) return;

    if (instance.audioNode) {
      try { instance.audioNode.disconnect(); } catch {}
    }

    if (instance.pluginInfo.format !== 'WebAudio' && window.appAPI) {
      const nativeId = (instance as any)._nativeId || instanceId;
      window.appAPI.unloadPlugin(nativeId);
    }

    this.instances.delete(instanceId);
  }

  getInstance(instanceId: string): PluginInstance | undefined {
    return this.instances.get(instanceId);
  }

  getAllInstances(): PluginInstance[] {
    return Array.from(this.instances.values());
  }
}
