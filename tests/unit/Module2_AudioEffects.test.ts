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
    it('lists 5 built-in plugins', () => {
      const plugins = pluginHost.getAvailablePlugins();
      expect(plugins).toHaveLength(5);

      const ids = plugins.map(p => p.id);
      expect(ids).toContain('builtin:eq7');
      expect(ids).toContain('builtin:compressor');
      expect(ids).toContain('builtin:gain');
      expect(ids).toContain('builtin:delay');
      expect(ids).toContain('builtin:reverb');
    });

    it('addScannedPlugins deduplicates by id', () => {
      const extra: PluginInfo[] = [{
        id: 'builtin:eq7', name: 'Duplicate EQ', path: '/dup',
        type: 'effect', format: 'WebAudio',
      }];
      pluginHost.addScannedPlugins(extra);
      expect(pluginHost.getAvailablePlugins()).toHaveLength(5);
    });

    it('addScannedPlugins deduplicates by path', () => {
      const extra: PluginInfo[] = [{
        id: 'new-id', name: 'Same Path', path: '',
        type: 'effect', format: 'WebAudio',
      }];
      pluginHost.addScannedPlugins(extra);
      // All builtin plugins have path='', so this should be deduped
      expect(pluginHost.getAvailablePlugins()).toHaveLength(5);
    });

    it('addScannedPlugins adds truly new plugins', () => {
      const extra: PluginInfo[] = [{
        id: 'custom:reverb', name: 'Custom Reverb', path: '/usr/local/lib/custom.vst3',
        type: 'effect', format: 'VST3',
      }];
      pluginHost.addScannedPlugins(extra);
      expect(pluginHost.getAvailablePlugins()).toHaveLength(6);
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

  // ==================== 2.3 EQ7 Plugin ====================

  describe('2.3 EQ7 Plugin', () => {
    const eq7Info: PluginInfo = {
      id: 'builtin:eq7', name: '7-Band EQ', path: '',
      type: 'effect', format: 'WebAudio',
    };

    it('2.3.1 - creates 9-node filter chain (HP + 7 bands + LP)', async () => {
      const instance = await pluginHost.createInstance(eq7Info);
      const node = instance.audioNode as any;

      expect(node._filters).toBeDefined();
      expect(node._filters).toHaveLength(9);
      expect(node._outputNode).toBeDefined();

      // HP is audioNode (first filter), LP is _outputNode (last filter)
      expect(node._filters[0]).toBe(instance.audioNode);
      expect(node._filters[8]).toBe(node._outputNode);
    });

    it('2.3.2 - has 32 parameters total', async () => {
      const instance = await pluginHost.createInstance(eq7Info);
      expect(instance.parameters).toHaveLength(32);

      // Verify param IDs are 0-31
      const ids = instance.parameters.map(p => p.id);
      for (let i = 0; i < 32; i++) {
        expect(ids).toContain(i);
      }
    });

    it('2.3.3 - Band 4 gain +12dB sets peaking filter gain', async () => {
      const instance = await pluginHost.createInstance(eq7Info);
      // Band 4: base = 2 + 3*4 = 14, gain = 14+2 = 16
      pluginHost.setParameter(instance.id, 16, 12);

      const filters = (instance.audioNode as any)._filters;
      // Band 4 = filters[4] (index 0=HP, 1-7=bands, 8=LP)
      expect(filters[4].gain.value).toBe(12);
    });

    it('2.3.4 - Band 2 freq 3000Hz updates filter frequency', async () => {
      const instance = await pluginHost.createInstance(eq7Info);
      // Band 2: base = 2 + 1*4 = 6, freq = 6+1 = 7
      pluginHost.setParameter(instance.id, 7, 3000);

      const filters = (instance.audioNode as any)._filters;
      expect(filters[2].frequency.value).toBe(3000);
    });

    it('2.3.5 - HP enabled sets frequency to stored value', async () => {
      const instance = await pluginHost.createInstance(eq7Info);
      const filters = (instance.audioNode as any)._filters;

      // HP starts disabled, freq at 10Hz (transparent)
      expect(filters[0].frequency.value).toBe(10);

      // Enable HP (id=0, value=1)
      pluginHost.setParameter(instance.id, 0, 1);
      // Should apply stored HP freq (default 80Hz)
      expect(filters[0].frequency.value).toBe(80);
    });

    it('2.3.6 - LP enabled sets frequency to stored value', async () => {
      const instance = await pluginHost.createInstance(eq7Info);
      const filters = (instance.audioNode as any)._filters;

      // LP starts disabled, freq at 22050Hz (transparent)
      expect(filters[8].frequency.value).toBe(22050);

      // Enable LP (id=30, value=1)
      pluginHost.setParameter(instance.id, 30, 1);
      // Should apply stored LP freq (default 8000Hz)
      expect(filters[8].frequency.value).toBe(8000);
    });

    it('2.3.7 - disabled band ignores gain changes', async () => {
      const instance = await pluginHost.createInstance(eq7Info);
      const filters = (instance.audioNode as any)._filters;

      // Disable Band 1 (id=2, value=0)
      pluginHost.setParameter(instance.id, 2, 0);
      expect(filters[1].gain.value).toBe(0);

      // Try to set Band 1 gain (id=4) — should be ignored since disabled
      pluginHost.setParameter(instance.id, 4, 12);
      expect(filters[1].gain.value).toBe(0);
    });

    it('2.3.8 - filter chain is connected HP → bands → LP', async () => {
      const instance = await pluginHost.createInstance(eq7Info);
      const filters = (instance.audioNode as any)._filters;

      // Verify each filter is connected to the next (via mock _connections)
      for (let i = 0; i < filters.length - 1; i++) {
        expect(filters[i]._connections).toContain(filters[i + 1]);
      }
    });

    it('2.3.9 - Band 1 is lowshelf, Band 7 is highshelf', async () => {
      const instance = await pluginHost.createInstance(eq7Info);
      const filters = (instance.audioNode as any)._filters;

      expect(filters[1].type).toBe('lowshelf');
      expect(filters[7].type).toBe('highshelf');
      // Bands 2-6 are peaking
      for (let i = 2; i <= 6; i++) {
        expect(filters[i].type).toBe('peaking');
      }
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

});
