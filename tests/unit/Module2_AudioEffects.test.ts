import { describe, it, expect, beforeEach } from 'vitest';
import { PluginHost } from '../../src/plugins/PluginHost';
import { PluginInfo } from '../../src/core/types';
import { MockGainNode } from '../setup';

describe('PluginHost — Audio Effects', () => {
  let audioContext: AudioContext;
  let pluginHost: PluginHost;

  beforeEach(() => {
    audioContext = new AudioContext();
    pluginHost = new PluginHost(audioContext);
  });

  // ==================== Plugin Registry ====================

  describe('Plugin Registry', () => {
    it('lists 7 built-in plugins', () => {
      const plugins = pluginHost.getAvailablePlugins();
      expect(plugins).toHaveLength(7);

      const ids = plugins.map(p => p.id);
      expect(ids).toContain('builtin:eq3');
      expect(ids).toContain('builtin:hpf');
      expect(ids).toContain('builtin:lpf');
      expect(ids).toContain('builtin:compressor');
      expect(ids).toContain('builtin:gain');
      expect(ids).toContain('builtin:delay');
      expect(ids).toContain('builtin:reverb');
    });

    it('addScannedPlugins deduplicates by id', () => {
      const extra: PluginInfo[] = [{
        id: 'builtin:eq3', name: 'Duplicate EQ', path: '/dup',
        type: 'effect', format: 'WebAudio',
      }];
      pluginHost.addScannedPlugins(extra);
      expect(pluginHost.getAvailablePlugins()).toHaveLength(7);
    });

    it('addScannedPlugins deduplicates by path', () => {
      const extra: PluginInfo[] = [{
        id: 'new-id', name: 'Same Path', path: '',
        type: 'effect', format: 'WebAudio',
      }];
      pluginHost.addScannedPlugins(extra);
      // All builtin plugins have path='', so this should be deduped
      expect(pluginHost.getAvailablePlugins()).toHaveLength(7);
    });

    it('addScannedPlugins adds truly new plugins', () => {
      const extra: PluginInfo[] = [{
        id: 'custom:reverb', name: 'Custom Reverb', path: '/usr/local/lib/custom.vst3',
        type: 'effect', format: 'VST3',
      }];
      pluginHost.addScannedPlugins(extra);
      expect(pluginHost.getAvailablePlugins()).toHaveLength(8);
    });
  });

  // ==================== 2.1 Delay Plugin ====================

  describe('2.1 Delay Plugin', () => {
    const delayInfo: PluginInfo = {
      id: 'builtin:delay', name: 'Delay', path: '',
      type: 'effect', format: 'WebAudio',
    };

    it('2.1.1 - creates node with dry+wet signal paths', async () => {
      const instance = await pluginHost.createInstance(delayInfo);

      expect(instance.audioNode).toBeDefined();
      const node = instance.audioNode as any;

      expect(node._dryNode).toBeDefined();
      expect(node._wetNode).toBeDefined();
      expect(node._delayNode).toBeDefined();
      expect(node._feedbackNode).toBeDefined();
      expect(node._outputNode).toBeDefined();
    });

    it('2.1.2 - Mix=0 sets wet=0, dry=1 (dry only)', async () => {
      const instance = await pluginHost.createInstance(delayInfo);
      pluginHost.setParameter(instance.id, 2, 0); // Mix = 0

      const node = instance.audioNode as any;
      expect(node._wetNode.gain.value).toBe(0);
      expect(node._dryNode.gain.value).toBe(1);
    });

    it('2.1.3 - Mix=1 sets wet=1, dry=0 (wet only)', async () => {
      const instance = await pluginHost.createInstance(delayInfo);
      pluginHost.setParameter(instance.id, 2, 1); // Mix = 1

      const node = instance.audioNode as any;
      expect(node._wetNode.gain.value).toBe(1);
      expect(node._dryNode.gain.value).toBe(0);
    });

    it('2.1.4 - Feedback parameter max is 0.95', async () => {
      const instance = await pluginHost.createInstance(delayInfo);
      const feedbackParam = instance.parameters.find(p => p.name === 'Feedback')!;
      expect(feedbackParam.max).toBe(0.95);
    });

    it('delay time parameter updates delayTime AudioParam', async () => {
      const instance = await pluginHost.createInstance(delayInfo);
      pluginHost.setParameter(instance.id, 0, 0.5); // Time = 0.5s

      const node = instance.audioNode as any;
      expect(node._delayNode.delayTime.value).toBe(0.5);
    });
  });

  // ==================== 2.2 Reverb Plugin ====================

  describe('2.2 Reverb Plugin', () => {
    const reverbInfo: PluginInfo = {
      id: 'builtin:reverb', name: 'Reverb', path: '',
      type: 'effect', format: 'WebAudio',
    };

    it('2.2.1 - creates node with dry+wet+convolver paths', async () => {
      const instance = await pluginHost.createInstance(reverbInfo);

      expect(instance.audioNode).toBeDefined();
      const node = instance.audioNode as any;

      expect(node._dryNode).toBeDefined();
      expect(node._wetNode).toBeDefined();
      expect(node._convolverNode).toBeDefined();
      expect(node._outputNode).toBeDefined();
    });

    it('2.2.2 - Mix=0 sets wet=0, dry=1', async () => {
      const instance = await pluginHost.createInstance(reverbInfo);
      pluginHost.setParameter(instance.id, 1, 0); // Mix = 0

      const node = instance.audioNode as any;
      expect(node._wetNode.gain.value).toBe(0);
      expect(node._dryNode.gain.value).toBe(1);
    });

    it('2.2.3 - Mix=1 sets wet=1, dry=0', async () => {
      const instance = await pluginHost.createInstance(reverbInfo);
      pluginHost.setParameter(instance.id, 1, 1); // Mix = 1

      const node = instance.audioNode as any;
      expect(node._wetNode.gain.value).toBe(1);
      expect(node._dryNode.gain.value).toBe(0);
    });

    it('2.2.4 - Decay change regenerates impulse response', async () => {
      const instance = await pluginHost.createInstance(reverbInfo);
      const node = instance.audioNode as any;

      const bufferBefore = node._convolverNode.buffer;
      expect(bufferBefore).not.toBeNull();

      // Change decay
      pluginHost.setParameter(instance.id, 0, 5.0);
      const bufferAfter = node._convolverNode.buffer;

      // Buffer should be regenerated (different object)
      expect(bufferAfter).not.toBeNull();
      expect(bufferAfter).not.toBe(bufferBefore);
    });

    it('2.2.5 - Damping change regenerates impulse response', async () => {
      const instance = await pluginHost.createInstance(reverbInfo);
      const node = instance.audioNode as any;

      const bufferBefore = node._convolverNode.buffer;

      // Change damping
      pluginHost.setParameter(instance.id, 2, 0.8);
      const bufferAfter = node._convolverNode.buffer;

      expect(bufferAfter).not.toBeNull();
      expect(bufferAfter).not.toBe(bufferBefore);
    });
  });

  // ==================== 2.3 EQ3 Plugin ====================

  describe('2.3 EQ3 Plugin', () => {
    const eq3Info: PluginInfo = {
      id: 'builtin:eq3', name: '3-Band EQ', path: '',
      type: 'effect', format: 'WebAudio',
    };

    it('2.3.1 - Mid Gain +12dB sets mid node gain', async () => {
      const instance = await pluginHost.createInstance(eq3Info);
      pluginHost.setParameter(instance.id, 3, 12); // Mid Gain = +12dB

      const node = instance.audioNode as any;
      expect(node._midNode.gain.value).toBe(12);
    });

    it('2.3.2 - Mid Freq 2000Hz sets mid node frequency', async () => {
      const instance = await pluginHost.createInstance(eq3Info);
      pluginHost.setParameter(instance.id, 2, 2000); // Mid Freq = 2000Hz

      const node = instance.audioNode as any;
      expect(node._midNode.frequency.value).toBe(2000);
    });

    it('2.3.3 - High Gain +12dB sets high node gain', async () => {
      const instance = await pluginHost.createInstance(eq3Info);
      pluginHost.setParameter(instance.id, 6, 12); // High Gain = +12dB

      const node = instance.audioNode as any;
      expect(node._outputNode.gain.value).toBe(12);
    });

    it('2.3.4 - High Freq 8000Hz sets high node frequency', async () => {
      const instance = await pluginHost.createInstance(eq3Info);
      pluginHost.setParameter(instance.id, 5, 8000); // High Freq = 8000Hz

      const node = instance.audioNode as any;
      expect(node._outputNode.frequency.value).toBe(8000);
    });

    it('2.3.5 - Low Gain -24dB sets low node gain', async () => {
      const instance = await pluginHost.createInstance(eq3Info);
      pluginHost.setParameter(instance.id, 1, -24); // Low Gain = -24dB

      // Low node is the audioNode itself (first biquad in chain)
      const node = instance.audioNode as any;
      expect(node.gain.value).toBe(-24);
    });

    it('EQ3 chain: low → mid → high (3 connected biquad filters)', async () => {
      const instance = await pluginHost.createInstance(eq3Info);
      const node = instance.audioNode as any;

      // low = audioNode, mid = _midNode, high = _outputNode
      expect(node).toBeDefined();
      expect(node._midNode).toBeDefined();
      expect(node._outputNode).toBeDefined();

      // Verify low is connected to mid (via mock _connections array)
      expect(node._connections).toContain(node._midNode);
      // mid connected to high
      expect(node._midNode._connections).toContain(node._outputNode);
    });
  });

  // ==================== Instance Management ====================

  describe('Instance Management', () => {
    const gainInfo: PluginInfo = {
      id: 'builtin:gain', name: 'Gain', path: '',
      type: 'effect', format: 'WebAudio',
    };

    it('createInstance assigns unique incremental IDs', async () => {
      const inst1 = await pluginHost.createInstance(gainInfo);
      const inst2 = await pluginHost.createInstance(gainInfo);

      expect(inst1.id).not.toBe(inst2.id);
      // IDs should be inst_N format
      expect(inst1.id).toMatch(/^inst_\d+$/);
      expect(inst2.id).toMatch(/^inst_\d+$/);
    });

    it('removeInstance disconnects and deletes from map', async () => {
      const inst = await pluginHost.createInstance(gainInfo);
      const id = inst.id;

      expect(pluginHost.getInstance(id)).toBeDefined();
      pluginHost.removeInstance(id);
      expect(pluginHost.getInstance(id)).toBeUndefined();
    });

    it('getInstance returns instance by ID', async () => {
      const inst = await pluginHost.createInstance(gainInfo);
      const found = pluginHost.getInstance(inst.id);
      expect(found).toBe(inst);
    });

    it('getAllInstances returns all active instances', async () => {
      await pluginHost.createInstance(gainInfo);
      await pluginHost.createInstance(gainInfo);
      await pluginHost.createInstance(gainInfo);

      expect(pluginHost.getAllInstances()).toHaveLength(3);
    });
  });

  // ==================== Insert Routing ====================

  describe('Insert Routing', () => {
    const gainInfo: PluginInfo = {
      id: 'builtin:gain', name: 'Gain', path: '',
      type: 'effect', format: 'WebAudio',
    };

    it('connectToInsert routes input → plugin → output', async () => {
      const inst = await pluginHost.createInstance(gainInfo);
      const input = audioContext.createGain() as unknown as GainNode;
      const output = audioContext.createGain() as unknown as GainNode;

      // Initially connect input -> output
      input.connect(output);

      pluginHost.connectToInsert(inst.id, input, output);

      // input should now be connected to plugin audioNode
      const inputMock = input as unknown as MockGainNode;
      expect(inputMock._connections).toContain(inst.audioNode);
    });

    it('disconnectFromInsert restores input → output', async () => {
      const inst = await pluginHost.createInstance(gainInfo);
      const input = audioContext.createGain() as unknown as GainNode;
      const output = audioContext.createGain() as unknown as GainNode;

      // Connect through plugin
      pluginHost.connectToInsert(inst.id, input, output);
      // Then disconnect
      pluginHost.disconnectFromInsert(inst.id, input, output);

      // input should be connected back to output directly
      const inputMock = input as unknown as MockGainNode;
      expect(inputMock._connections).toContain(output as any);
    });

    it('multi-stage plugins use _outputNode for output', async () => {
      const delayInfo: PluginInfo = {
        id: 'builtin:delay', name: 'Delay', path: '',
        type: 'effect', format: 'WebAudio',
      };
      const inst = await pluginHost.createInstance(delayInfo);
      const input = audioContext.createGain() as unknown as GainNode;
      const output = audioContext.createGain() as unknown as GainNode;

      pluginHost.connectToInsert(inst.id, input, output);

      // The _outputNode (merger) should be connected to output
      const outputNode = (inst.audioNode as any)._outputNode;
      expect(outputNode._connections).toContain(output as any);
    });
  });

  // ==================== Other Plugins ====================

  describe('Compressor Plugin', () => {
    it('creates DynamicsCompressorNode with correct defaults', async () => {
      const info: PluginInfo = {
        id: 'builtin:compressor', name: 'Compressor', path: '',
        type: 'effect', format: 'WebAudio',
      };
      const inst = await pluginHost.createInstance(info);
      const node = inst.audioNode as any;

      expect(node.threshold.value).toBe(-24);
      expect(node.knee.value).toBe(12);
      expect(node.ratio.value).toBe(4);
      expect(node.attack.value).toBe(0.003);
      expect(node.release.value).toBe(0.25);
    });

    it('setParameter updates compressor values', async () => {
      const info: PluginInfo = {
        id: 'builtin:compressor', name: 'Compressor', path: '',
        type: 'effect', format: 'WebAudio',
      };
      const inst = await pluginHost.createInstance(info);

      pluginHost.setParameter(inst.id, 0, -40); // Threshold
      pluginHost.setParameter(inst.id, 2, 8);   // Ratio

      const node = inst.audioNode as any;
      expect(node.threshold.value).toBe(-40);
      expect(node.ratio.value).toBe(8);
    });
  });

  describe('HPF / LPF Plugins', () => {
    it('HPF creates highpass filter with correct defaults', async () => {
      const info: PluginInfo = {
        id: 'builtin:hpf', name: 'High Pass Filter', path: '',
        type: 'effect', format: 'WebAudio',
      };
      const inst = await pluginHost.createInstance(info);
      const node = inst.audioNode as any;

      expect(node.type).toBe('highpass');
      expect(node.frequency.value).toBe(80);
      expect(node.Q.value).toBe(0.707);
    });

    it('LPF creates lowpass filter with correct defaults', async () => {
      const info: PluginInfo = {
        id: 'builtin:lpf', name: 'Low Pass Filter', path: '',
        type: 'effect', format: 'WebAudio',
      };
      const inst = await pluginHost.createInstance(info);
      const node = inst.audioNode as any;

      expect(node.type).toBe('lowpass');
      expect(node.frequency.value).toBe(8000);
    });

    it('setParameter updates filter frequency', async () => {
      const info: PluginInfo = {
        id: 'builtin:hpf', name: 'High Pass Filter', path: '',
        type: 'effect', format: 'WebAudio',
      };
      const inst = await pluginHost.createInstance(info);
      pluginHost.setParameter(inst.id, 0, 200);

      const node = inst.audioNode as any;
      expect(node.frequency.value).toBe(200);
    });
  });
});
