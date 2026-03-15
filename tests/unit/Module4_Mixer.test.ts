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
    channels: 1,
    clips: [],
    volume: 0,
    pan: 0,
    mute: false,
    solo: false,
    channelIndex: 0,
    inserts: [],
    height: 80,
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
      const tracks = [makeTrack('t1'), makeTrack('t2')];
      expect(() => mixer.setupTracks(tracks)).not.toThrow();
      expect(container.innerHTML).not.toBe('');
    });

    it('4.1.2 - mixer controls work with no audio loaded', () => {
      const tracks = [makeTrack('t1'), makeTrack('t2')];
      mixer.setupTracks(tracks);
      expect(() => mixer.setTrackVolume('t1', -6)).not.toThrow();
      expect(() => mixer.setTrackMute('t1', true)).not.toThrow();
      expect(() => mixer.setTrackSolo('t1', true)).not.toThrow();
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

      const spy = vi.spyOn(engine, 'updateMuteSoloState');
      mixer.setTrackMute('t1', true);

      expect(spy).toHaveBeenCalledWith([{ id: 't1', solo: false, mute: true }]);
    });

    it('setTrackSolo updates strip + audioEngine', () => {
      const tracks = [makeTrack('t1')];
      mixer.setupTracks(tracks);

      const spy = vi.spyOn(engine, 'updateMuteSoloState');
      mixer.setTrackSolo('t1', true);

      expect(spy).toHaveBeenCalledWith([{ id: 't1', solo: true, mute: false }]);
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
