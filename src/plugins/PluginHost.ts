import { PluginInfo, PluginInstance, PluginParameter } from '../core/types';

/**
 * VST3/AudioUnit Plugin Host.
 *
 * Two modes of operation:
 * 1. Native mode: Uses the C++ native addon via Electron IPC for real VST3/AU hosting
 * 2. Web Audio mode: Uses built-in Web Audio API effects as fallback
 *
 * Built-in Web Audio effects include:
 * - Parametric EQ (3-band)
 * - High/Low Pass Filter
 * - Compressor
 * - Reverb (convolution)
 * - Gain
 * - Delay
 */
export class PluginHost {
  private audioContext: AudioContext;
  private instances: Map<string, PluginInstance> = new Map();
  private availablePlugins: PluginInfo[] = [];
  private nextInstanceId = 1;

  // Built-in Web Audio plugins
  private static readonly BUILTIN_PLUGINS: PluginInfo[] = [
    {
      id: 'builtin:eq3',
      name: '3-Band EQ',
      path: '',
      type: 'effect',
      format: 'WebAudio',
      category: 'EQ',
      vendor: 'FieldCorder',
    },
    {
      id: 'builtin:hpf',
      name: 'High Pass Filter',
      path: '',
      type: 'effect',
      format: 'WebAudio',
      category: 'Filter',
      vendor: 'FieldCorder',
    },
    {
      id: 'builtin:lpf',
      name: 'Low Pass Filter',
      path: '',
      type: 'effect',
      format: 'WebAudio',
      category: 'Filter',
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
      return this.createBuiltinInstance(instanceId, pluginInfo);
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

  private createBuiltinInstance(instanceId: string, pluginInfo: PluginInfo): PluginInstance {
    let audioNode: AudioNode;
    let parameters: PluginParameter[] = [];

    switch (pluginInfo.id) {
      case 'builtin:eq3': {
        // 3-band EQ using biquad filters
        const low = this.audioContext.createBiquadFilter();
        low.type = 'lowshelf';
        low.frequency.value = 250;
        low.gain.value = 0;

        const mid = this.audioContext.createBiquadFilter();
        mid.type = 'peaking';
        mid.frequency.value = 1000;
        mid.Q.value = 1.0;
        mid.gain.value = 0;

        const high = this.audioContext.createBiquadFilter();
        high.type = 'highshelf';
        high.frequency.value = 4000;
        high.gain.value = 0;

        low.connect(mid);
        mid.connect(high);

        audioNode = low;
        (audioNode as any)._midNode = mid;
        (audioNode as any)._outputNode = high;

        parameters = [
          { id: 0, name: 'Low Freq', value: 250, min: 20, max: 500, defaultValue: 250, unit: 'Hz' },
          { id: 1, name: 'Low Gain', value: 0, min: -24, max: 24, defaultValue: 0, unit: 'dB' },
          { id: 2, name: 'Mid Freq', value: 1000, min: 200, max: 5000, defaultValue: 1000, unit: 'Hz' },
          { id: 3, name: 'Mid Gain', value: 0, min: -24, max: 24, defaultValue: 0, unit: 'dB' },
          { id: 4, name: 'Mid Q', value: 1.0, min: 0.1, max: 10, defaultValue: 1.0 },
          { id: 5, name: 'High Freq', value: 4000, min: 2000, max: 16000, defaultValue: 4000, unit: 'Hz' },
          { id: 6, name: 'High Gain', value: 0, min: -24, max: 24, defaultValue: 0, unit: 'dB' },
        ];
        break;
      }

      case 'builtin:hpf': {
        const filter = this.audioContext.createBiquadFilter();
        filter.type = 'highpass';
        filter.frequency.value = 80;
        filter.Q.value = 0.707;
        audioNode = filter;
        parameters = [
          { id: 0, name: 'Frequency', value: 80, min: 20, max: 2000, defaultValue: 80, unit: 'Hz' },
          { id: 1, name: 'Q', value: 0.707, min: 0.1, max: 10, defaultValue: 0.707 },
        ];
        break;
      }

      case 'builtin:lpf': {
        const filter = this.audioContext.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 8000;
        filter.Q.value = 0.707;
        audioNode = filter;
        parameters = [
          { id: 0, name: 'Frequency', value: 8000, min: 200, max: 20000, defaultValue: 8000, unit: 'Hz' },
          { id: 1, name: 'Q', value: 0.707, min: 0.1, max: 10, defaultValue: 0.707 },
        ];
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
      case 'builtin:eq3': {
        // node = low, _midNode = mid, _outputNode = high
        if (paramId === 0) node.frequency.value = value;
        else if (paramId === 1) node.gain.value = value;
        else if (paramId === 2 && node._midNode) node._midNode.frequency.value = value;
        else if (paramId === 3 && node._midNode) node._midNode.gain.value = value;
        else if (paramId === 4 && node._midNode) node._midNode.Q.value = value;
        else if (paramId === 5 && node._outputNode) node._outputNode.frequency.value = value;
        else if (paramId === 6 && node._outputNode) node._outputNode.gain.value = value;
        break;
      }
      case 'builtin:hpf':
      case 'builtin:lpf': {
        const filter = node as BiquadFilterNode;
        if (paramId === 0) filter.frequency.value = value;
        else if (paramId === 1) filter.Q.value = value;
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
