import { describe, it, expect } from 'vitest';
import {
  serializeSession,
  resolveRelativePath,
  resolveAbsolutePath,
  deserializeSession,
} from '../../src/core/SessionManager';
import type { Timeline, Track, Clip, SessionData } from '../../src/core/types';

function makeClip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'c-1',
    bufferIds: ['buf-1'],
    name: 'test.wav',
    timelineOffset: 0,
    sourceStart: 0,
    sourceEnd: 48000,
    duration: 48000,
    gainDb: 0,
    fadeInSamples: 0,
    fadeOutSamples: 0,
    muted: false,
    ...overrides,
  };
}

function makeTrack(overrides: Partial<Track> = {}): Track {
  return {
    id: 't-1',
    name: 'Track 1',
    color: '#4A90D9',
    channels: 1 as const,
    clips: [makeClip()],
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

function makeTimeline(overrides: Partial<Timeline> = {}): Timeline {
  return {
    sampleRate: 48000,
    totalLength: 48000,
    tracks: [makeTrack()],
    playheadSample: 0,
    selectionStart: null,
    selectionEnd: null,
    selectedClipIds: [],
    selectedTrackIds: [],
    samplesPerPixel: 100,
    scrollOffset: 0,
    ...overrides,
  };
}

describe('serializeSession', () => {
  it('serializes empty timeline', () => {
    const timeline = makeTimeline({ tracks: [] });
    const bufferSourceMap = new Map<string, { fileName: string; channelIndex: number }>();
    const result = serializeSession(timeline, bufferSourceMap, null, {}, null);
    expect(result.version).toBe(1);
    expect(result.app).toBe('FieldCorder');
    expect(result.sampleRate).toBe(48000);
    expect(result.tracks).toHaveLength(0);
    expect(result.audioFiles).toHaveLength(0);
  });

  it('serializes track with mono clip', () => {
    const timeline = makeTimeline();
    const bufferSourceMap = new Map([
      ['buf-1', { fileName: '/Users/x/audio.wav', channelIndex: 0 }],
    ]);
    const result = serializeSession(timeline, bufferSourceMap, null, {}, null);
    expect(result.audioFiles).toHaveLength(1);
    expect(result.audioFiles[0].absolutePath).toBe('/Users/x/audio.wav');
    expect(result.tracks).toHaveLength(1);
    expect(result.tracks[0].clips).toHaveLength(1);
    expect(result.tracks[0].clips[0].audioFileId).toBe(result.audioFiles[0].id);
    expect(result.tracks[0].clips[0].channelIndices).toEqual([0]);
  });

  it('serializes stereo clip with 2 bufferIds from same file', () => {
    const clip = makeClip({
      id: 'c-1',
      bufferIds: ['buf-L', 'buf-R'],
      name: 'stereo.wav',
    });
    const track = makeTrack({ channels: 2 as const, clips: [clip] });
    const timeline = makeTimeline({ tracks: [track] });
    const bufferSourceMap = new Map([
      ['buf-L', { fileName: '/Users/x/stereo.wav', channelIndex: 0 }],
      ['buf-R', { fileName: '/Users/x/stereo.wav', channelIndex: 1 }],
    ]);
    const result = serializeSession(timeline, bufferSourceMap, null, {}, null);
    // Same file → only 1 audioFile entry
    expect(result.audioFiles).toHaveLength(1);
    expect(result.tracks[0].clips[0].channelIndices).toEqual([0, 1]);
  });

  it('deduplicates audio files across tracks', () => {
    const clip1 = makeClip({ id: 'c-1', bufferIds: ['buf-1'] });
    const clip2 = makeClip({ id: 'c-2', bufferIds: ['buf-2'] });
    const track1 = makeTrack({ id: 't-1', clips: [clip1] });
    const track2 = makeTrack({ id: 't-2', clips: [clip2] });
    const timeline = makeTimeline({ tracks: [track1, track2] });
    const bufferSourceMap = new Map([
      ['buf-1', { fileName: '/Users/x/same.wav', channelIndex: 0 }],
      ['buf-2', { fileName: '/Users/x/same.wav', channelIndex: 0 }],
    ]);
    const result = serializeSession(timeline, bufferSourceMap, null, {}, null);
    expect(result.audioFiles).toHaveLength(1);
  });

  it('preserves track inserts', () => {
    const track = makeTrack({
      inserts: [{
        instanceId: 'inst-1',
        pluginId: 'builtin:eq7',
        parameters: [{ id: 0, name: 'band1Freq', value: 200, min: 20, max: 20000, defaultValue: 200 }],
        bypassed: false,
      }],
    });
    const timeline = makeTimeline({ tracks: [track] });
    const bufferSourceMap = new Map([
      ['buf-1', { fileName: '/Users/x/a.wav', channelIndex: 0 }],
    ]);
    const result = serializeSession(timeline, bufferSourceMap, null, {}, null);
    expect(result.tracks[0].inserts).toHaveLength(1);
    expect(result.tracks[0].inserts[0].pluginId).toBe('builtin:eq7');
  });

  it('preserves metadata', () => {
    const metadata = { project: 'MyProject', scene: '001' };
    const timeline = makeTimeline({ tracks: [] });
    const result = serializeSession(timeline, new Map(), null, metadata, null);
    expect(result.metadata).toEqual(metadata);
  });

  it('stores playhead position', () => {
    const timeline = makeTimeline({ playheadSample: 24000 });
    const result = serializeSession(timeline, new Map(), null, {}, null);
    expect(result.playheadSample).toBe(24000);
  });
});

describe('resolveRelativePath', () => {
  it('computes relative path from session dir to audio file', () => {
    const result = resolveRelativePath(
      '/Users/x/projects/session.fcs',
      '/Users/x/recordings/audio.wav'
    );
    expect(result).toBe('../recordings/audio.wav');
  });

  it('handles same directory', () => {
    const result = resolveRelativePath(
      '/Users/x/project/session.fcs',
      '/Users/x/project/audio.wav'
    );
    expect(result).toBe('audio.wav');
  });

  it('handles subdirectory', () => {
    const result = resolveRelativePath(
      '/Users/x/project/session.fcs',
      '/Users/x/project/audio/take1.wav'
    );
    expect(result).toBe('audio/take1.wav');
  });
});

function makeSessionData(overrides: Partial<SessionData> = {}): SessionData {
  return {
    version: 1,
    app: 'FieldCorder',
    savedAt: '2026-03-19T12:00:00Z',
    sampleRate: 48000,
    playheadSample: 0,
    fileBrowserPath: null,
    metadata: {},
    audioFiles: [],
    tracks: [],
    ...overrides,
  };
}

describe('deserializeSession', () => {
  it('returns empty timeline for empty session', () => {
    const session = makeSessionData();
    const result = deserializeSession(session);
    expect(result.timeline.tracks).toHaveLength(0);
    expect(result.timeline.sampleRate).toBe(48000);
    expect(result.audioFilesToLoad).toHaveLength(0);
  });

  it('reconstructs track with clip referencing audio file', () => {
    const session = makeSessionData({
      audioFiles: [{
        id: 'af-1',
        relativePath: 'audio.wav',
        absolutePath: '/Users/x/audio.wav',
        sampleRate: 48000,
        channels: 1,
        numSamples: 48000,
      }],
      tracks: [{
        id: 't-1', name: 'Track 1', color: '#4A90D9',
        channels: 1, volume: 0, pan: 0, mute: false, solo: false,
        channelIndex: 0, height: 80, inserts: [],
        clips: [{
          id: 'c-1', audioFileId: 'af-1', channelIndices: [0],
          name: 'audio.wav', timelineOffset: 0,
          sourceStart: 0, sourceEnd: 48000, duration: 48000,
          gainDb: 0, fadeInSamples: 0, fadeOutSamples: 0,
          fadeInCurve: 0, fadeOutCurve: 0,
          muted: false, reversed: false,
          crossfadeInSamples: 0, crossfadeOutSamples: 0,
          crossfadeType: 'equalPower',
        }],
      }],
    });
    const result = deserializeSession(session);
    expect(result.timeline.tracks).toHaveLength(1);
    expect(result.timeline.tracks[0].clips).toHaveLength(1);
    // Clip gets placeholder bufferIds (resolved during audio load)
    expect(result.timeline.tracks[0].clips[0].bufferIds).toEqual(['af-1:0']);
    expect(result.audioFilesToLoad).toHaveLength(1);
    expect(result.audioFilesToLoad[0].absolutePath).toBe('/Users/x/audio.wav');
  });

  it('preserves plugin inserts', () => {
    const session = makeSessionData({
      tracks: [{
        id: 't-1', name: 'T', color: '#fff', channels: 1,
        volume: 0, pan: 0, mute: false, solo: false,
        channelIndex: 0, height: 80, clips: [],
        inserts: [{
          pluginId: 'builtin:eq7',
          parameters: [{ id: 0, name: 'band1Freq', value: 300, min: 20, max: 20000, defaultValue: 200 }],
          bypassed: true,
        }],
      }],
    });
    const result = deserializeSession(session);
    expect(result.timeline.tracks[0].inserts).toHaveLength(1);
    expect(result.timeline.tracks[0].inserts[0].pluginId).toBe('builtin:eq7');
    expect(result.timeline.tracks[0].inserts[0].bypassed).toBe(true);
  });

  it('restores playhead position', () => {
    const session = makeSessionData({ playheadSample: 24000 });
    const result = deserializeSession(session);
    expect(result.timeline.playheadSample).toBe(24000);
  });
});

describe('resolveAbsolutePath', () => {
  it('resolves relative path against session directory', () => {
    const result = resolveAbsolutePath(
      '/Users/x/projects/session.fcs',
      '../recordings/audio.wav'
    );
    expect(result).toBe('/Users/x/recordings/audio.wav');
  });

  it('resolves same-directory file', () => {
    const result = resolveAbsolutePath(
      '/Users/x/project/session.fcs',
      'audio.wav'
    );
    expect(result).toBe('/Users/x/project/audio.wav');
  });
});
