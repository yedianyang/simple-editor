import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Mixer } from '../../src/mixer/Mixer';
import { AudioEngine } from '../../src/core/AudioEngine';
import { PluginHost } from '../../src/plugins/PluginHost';
import { Track } from '../../src/core/types';

function makeTrack(id: string, overrides: Partial<Track> = {}): Track {
  return {
    id,
    name: `Track ${id}`,
    color: '#3b82f6',
    clips: [],
    volume: 0,
    pan: 0,
    mute: false,
    solo: false,
    channelIndex: 0,
    ...overrides,
  };
}

describe('Mixer', () => {
  let container: HTMLElement;
  let engine: AudioEngine;
  let mixer: Mixer;

  beforeEach(async () => {
    container = document.createElement('div');
    document.body.appendChild(container);

    engine = new AudioEngine();
    await engine.init();

    mixer = new Mixer(container, engine, null);
  });

  // ==================== 4.1 PluginHost Null Safety ====================

  describe('4.1 PluginHost Null Safety', () => {
    it('4.1.1 - renders without crash when pluginHost is null', () => {
      expect(mixer.pluginHost).toBeNull();
      expect(() => mixer.setupChannels(2)).not.toThrow();
      expect(container.innerHTML).not.toBe('');
    });

    it('4.1.2 - mixer controls work with no audio loaded', () => {
      mixer.setupChannels(2);
      expect(() => mixer.setChannelVolume(0, -6)).not.toThrow();
      expect(() => mixer.setChannelMute(0, true)).not.toThrow();
      expect(() => mixer.setChannelSolo(0, true)).not.toThrow();
    });

    it('4.1.3 - plugin insertion works after pluginHost is set', async () => {
      mixer.setupChannels(2);
      engine.setupChannelRouting(2);

      // Set pluginHost after construction
      const pluginHost = new PluginHost(engine.audioContext!);
      mixer.pluginHost = pluginHost;

      const plugins = pluginHost.getAvailablePlugins();
      const gainPlugin = plugins.find(p => p.id === 'builtin:gain')!;

      // Should not throw
      await mixer.addPlugin(0, gainPlugin);
      expect(mixer.channels[0].plugins).toHaveLength(1);
    });
  });

  // ==================== 4.2 Crossfader Independence ====================

  describe('4.2 Crossfader Independence', () => {
    let trackA: Track;
    let trackB: Track;

    beforeEach(() => {
      trackA = makeTrack('tA', { volume: -6 });
      trackB = makeTrack('tB', { volume: -12 });
      mixer.setupTracks([trackA, trackB]);
    });

    it('4.2.1 - track volumes set correctly (-6dB, -12dB)', () => {
      const gainA = engine.trackGainNodes.get('tA')!.gain.value;
      const gainB = engine.trackGainNodes.get('tB')!.gain.value;
      expect(gainA).toBeCloseTo(Math.pow(10, -6 / 20), 4);
      expect(gainB).toBeCloseTo(Math.pow(10, -12 / 20), 4);
    });

    it('4.2.2 - crossfader changes do not affect volume fader values', () => {
      // Record initial gain values
      const initialGainA = engine.trackGainNodes.get('tA')!.gain.value;
      const initialGainB = engine.trackGainNodes.get('tB')!.gain.value;

      // Move crossfader (via audioEngine directly since Mixer.setCrossfaderPosition is private)
      engine.setCrossfader('tA', 'tB');
      engine.setCrossfaderPosition(0.5);

      // Volume fader gain nodes should be unchanged
      expect(engine.trackGainNodes.get('tA')!.gain.value).toBeCloseTo(initialGainA, 4);
      expect(engine.trackGainNodes.get('tB')!.gain.value).toBeCloseTo(initialGainB, 4);
    });

    it('4.2.3 - volume changes do not affect crossfader position', () => {
      engine.setCrossfader('tA', 'tB');
      engine.setCrossfaderPosition(0.3);

      const cfGainA = engine.trackCrossfaderNodes.get('tA')!.gain.value;
      const cfGainB = engine.trackCrossfaderNodes.get('tB')!.gain.value;

      // Change track volume
      mixer.setTrackVolume('tA', -3);

      // Crossfader gain nodes should be unchanged
      expect(engine.trackCrossfaderNodes.get('tA')!.gain.value).toBeCloseTo(cfGainA, 4);
      expect(engine.trackCrossfaderNodes.get('tB')!.gain.value).toBeCloseTo(cfGainB, 4);
    });
  });

  // ==================== Channel Mode ====================

  describe('Channel Mode', () => {
    it('setupChannels(1) creates mono strip', () => {
      mixer.setupChannels(1);
      expect(mixer.channels).toHaveLength(1);
      expect(mixer.channels[0].name).toBe('Mono');
    });

    it('setupChannels(2) creates stereo strips', () => {
      mixer.setupChannels(2);
      expect(mixer.channels).toHaveLength(2);
      expect(mixer.channels[0].name).toBe('Left');
      expect(mixer.channels[1].name).toBe('Right');
    });

    it('setupChannels(6) creates 5.1 strips', () => {
      mixer.setupChannels(6);
      expect(mixer.channels).toHaveLength(6);
      expect(mixer.channels[2].name).toBe('Center');
      expect(mixer.channels[3].name).toBe('LFE');
    });

    it('setChannelVolume calls audioEngine.setChannelVolume', () => {
      mixer.setupChannels(2);
      engine.setupChannelRouting(2);

      const spy = vi.spyOn(engine, 'setChannelVolume');
      mixer.setChannelVolume(0, -10);

      expect(spy).toHaveBeenCalledWith(0, -10);
      expect(mixer.channels[0].volume).toBe(-10);
    });

    it('setChannelMute updates state + calls audioEngine', () => {
      mixer.setupChannels(2);
      const spy = vi.spyOn(engine, 'setChannelMute');
      mixer.setChannelMute(1, true);

      expect(spy).toHaveBeenCalledWith(1, true);
      expect(mixer.channels[1].mute).toBe(true);
    });

    it('setChannelSolo updates state + calls audioEngine', () => {
      mixer.setupChannels(2);
      const spy = vi.spyOn(engine, 'setChannelSolo');
      mixer.setChannelSolo(0, true);

      expect(spy).toHaveBeenCalledWith(0, true);
      expect(mixer.channels[0].solo).toBe(true);
    });
  });

  // ==================== Track Mode ====================

  describe('Track Mode', () => {
    it('setupTracks creates strips from Track[]', () => {
      const tracks = [makeTrack('t1'), makeTrack('t2'), makeTrack('t3')];
      mixer.setupTracks(tracks);
      expect(mixer.getMode()).toBe('track');
    });

    it('setTrackVolume calls audioEngine.setTrackVolume', () => {
      const tracks = [makeTrack('t1')];
      mixer.setupTracks(tracks);

      const spy = vi.spyOn(engine, 'setTrackVolume');
      mixer.setTrackVolume('t1', -8);

      expect(spy).toHaveBeenCalledWith('t1', -8);
    });

    it('setTrackPan clamps [-1,1] and calls audioEngine', () => {
      const tracks = [makeTrack('t1')];
      mixer.setupTracks(tracks);

      const spy = vi.spyOn(engine, 'setTrackPan');
      mixer.setTrackPan('t1', 2.0); // Should clamp to 1

      expect(spy).toHaveBeenCalledWith('t1', 1);
    });

    it('setTrackMute updates strip + audioEngine', () => {
      const tracks = [makeTrack('t1')];
      mixer.setupTracks(tracks);

      const spy = vi.spyOn(engine, 'setTrackMute');
      mixer.setTrackMute('t1', true);

      expect(spy).toHaveBeenCalledWith('t1', true);
    });

    it('setTrackSolo updates strip + audioEngine', () => {
      const tracks = [makeTrack('t1')];
      mixer.setupTracks(tracks);

      const spy = vi.spyOn(engine, 'setTrackSolo');
      mixer.setTrackSolo('t1', true);

      expect(spy).toHaveBeenCalledWith('t1', true);
    });
  });

  // ==================== Master Bus ====================

  describe('Master Bus', () => {
    it('setMasterVolume updates state + audioEngine.setMasterVolume', () => {
      const spy = vi.spyOn(engine, 'setMasterVolume');
      mixer.setMasterVolume(-6);

      expect(spy).toHaveBeenCalledWith(-6);
      expect(mixer.masterVolume).toBe(-6);
    });
  });

  // ==================== Visibility ====================

  describe('Visibility', () => {
    it('toggle() flips visible and container display style', () => {
      expect(mixer.visible).toBe(false);

      mixer.toggle();
      expect(mixer.visible).toBe(true);
      expect(container.style.display).toBe('flex');

      mixer.toggle();
      expect(mixer.visible).toBe(false);
      expect(container.style.display).toBe('none');
    });

    it('show()/hide() set correct states', () => {
      mixer.show();
      expect(mixer.visible).toBe(true);
      expect(container.style.display).toBe('flex');

      mixer.hide();
      expect(mixer.visible).toBe(false);
      expect(container.style.display).toBe('none');
    });
  });

  // ==================== State Export ====================

  describe('State Export', () => {
    it('getState() returns channels and masterVolume', () => {
      mixer.setupChannels(2);
      mixer.setMasterVolume(-3);

      const state = mixer.getState();
      expect(state.channels).toHaveLength(2);
      expect(state.masterVolume).toBe(-3);
      // Plugins should not be serialized
      expect(state.channels[0].plugins).toHaveLength(0);
    });

    it('getTrackState() returns tracks and masterVolume', () => {
      const tracks = [makeTrack('t1', { volume: -6 }), makeTrack('t2', { volume: -12 })];
      mixer.setupTracks(tracks);
      mixer.setMasterVolume(-2);

      const state = mixer.getTrackState();
      expect(state.tracks).toHaveLength(2);
      expect(state.masterVolume).toBe(-2);
      expect(state.tracks[0].volume).toBe(-6);
    });
  });
});
