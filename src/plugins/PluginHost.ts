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
    // Remove duplicates by path
    const existing = new Set(this.availablePlugins.map(p => p.path));
    for (const plugin of plugins) {
      if (!existing.has(plugin.path)) {
        this.availablePlugins.push(plugin);
        existing.add(plugin.path);
      }
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
    if (window.electronAPI) {
      const result = await window.electronAPI.loadPlugin(pluginInfo.path);
      if (result && !result.error) {
        const instance: PluginInstance = {
          id: instanceId,
          pluginInfo,
          parameters: result.parameters || [],
          bypassed: false,
        };
        this.instances.set(instanceId, instance);
        return instance;
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
        // Store reference to get output node
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
        const delay = this.audioContext.createDelay(5.0);
        delay.delayTime.value = 0.25;
        const feedback = this.audioContext.createGain();
        feedback.gain.value = 0.3;
        const wet = this.audioContext.createGain();
        wet.gain.value = 0.3;
        const dry = this.audioContext.createGain();
        dry.gain.value = 0.7;
        const merger = this.audioContext.createGain();

        // dry -> merger
        // delay -> wet -> merger
        // delay -> feedback -> delay
        delay.connect(wet);
        delay.connect(feedback);
        feedback.connect(delay);
        wet.connect(merger);
        dry.connect(merger);

        audioNode = dry; // Input goes to both dry and delay
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
        const convolver = this.audioContext.createConvolver();
        const wet = this.audioContext.createGain();
        wet.gain.value = 0.3;
        const dry = this.audioContext.createGain();
        dry.gain.value = 0.7;
        const merger = this.audioContext.createGain();

        convolver.connect(wet);
        wet.connect(merger);
        dry.connect(merger);

        // Generate impulse response
        this.generateReverbIR(convolver, 2.0, 0.5);

        audioNode = dry;
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
    if (instance.pluginInfo.format !== 'WebAudio' && window.electronAPI) {
      window.electronAPI.setPluginParameter(instanceId, paramId, value);
    }
  }

  private updateBuiltinParameter(instance: PluginInstance, paramId: number, value: number): void {
    const node = instance.audioNode as any;
    if (!node) return;

    switch (instance.pluginInfo.id) {
      case 'builtin:eq3': {
        // Low/Mid/High EQ
        const nodes = [node, node._midNode, node._outputNode];
        if (paramId === 0) node.frequency.value = value;
        else if (paramId === 1) node.gain.value = value;
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
          node.gain.value = 1 - value;
        }
        break;
      }
      case 'builtin:reverb': {
        if (paramId === 0 && node._convolverNode) {
          this.generateReverbIR(node._convolverNode, value, instance.parameters[2]?.value || 0.5);
        }
        else if (paramId === 1 && node._wetNode) {
          node._wetNode.gain.value = value;
          node.gain.value = 1 - value;
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

  removeInstance(instanceId: string): void {
    const instance = this.instances.get(instanceId);
    if (!instance) return;

    if (instance.audioNode) {
      try { instance.audioNode.disconnect(); } catch {}
    }

    if (instance.pluginInfo.format !== 'WebAudio' && window.electronAPI) {
      window.electronAPI.unloadPlugin(instanceId);
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
