/**
 * TDD tests for Import-Bug1: Cmd+O should import audio to a new track at playhead position.
 *
 * Tests the new importAudioToNewTrack() method on TimelineModel:
 * - Creates a NEW track (never reuses existing)
 * - Inserts after the specified index
 * - Places clip at given sample offset (playhead position)
 * - Matches channel count from the audio file
 * - Works with mono, stereo, quad, and 5.1 files
 * - Works on empty timeline
 * - Works when tracks already exist
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { TimelineModel } from '../../src/core/TimelineModel';
import type { TrackChannelCount } from '../../src/core/types';

describe('TimelineModel.importAudioToNewTrack', () => {
  let model: TimelineModel;

  beforeEach(() => {
    model = new TimelineModel();
    model.createTimeline(48000);
  });

  // ==================== Mono file ====================

  it('should create a mono track for a mono file on empty timeline', () => {
    const result = model.importAudioToNewTrack(
      ['buf-1'],
      'field-recording.wav',
      48000,
      96000, // 2 seconds at 48kHz
      0,     // insertAfterIndex: insert at start
      0,     // sampleOffset: playhead at 0
    );

    expect(result.newTrackIds).toHaveLength(1);
    expect(result.clipIds).toHaveLength(1);

    const tracks = model.timeline.tracks;
    expect(tracks).toHaveLength(1);
    expect(tracks[0].channels).toBe(1);
    expect(tracks[0].name).toBe('field-recording.wav');
    expect(tracks[0].clips).toHaveLength(1);
    expect(tracks[0].clips[0].timelineOffset).toBe(0);
    expect(tracks[0].clips[0].duration).toBe(96000);
    expect(tracks[0].clips[0].bufferIds).toEqual(['buf-1']);
  });

  it('should place clip at the playhead position (sample offset)', () => {
    const playheadSample = 24000; // 0.5 seconds

    model.importAudioToNewTrack(
      ['buf-1'],
      'audio.wav',
      48000,
      48000,
      0,
      playheadSample,
    );

    const clip = model.timeline.tracks[0].clips[0];
    expect(clip.timelineOffset).toBe(24000);
  });

  // ==================== Stereo file ====================

  it('should create a stereo track for a stereo file with a single clip', () => {
    const result = model.importAudioToNewTrack(
      ['buf-L', 'buf-R'],
      'stereo-ambience.wav',
      48000,
      48000,
      0,
      0,
    );

    expect(result.newTrackIds).toHaveLength(1);
    // New model: 1 clip with bufferIds = ['buf-L', 'buf-R']
    expect(result.clipIds).toHaveLength(1);

    const tracks = model.timeline.tracks;
    expect(tracks).toHaveLength(1);
    expect(tracks[0].channels).toBe(2);
    expect(tracks[0].clips).toHaveLength(1);
    // Single clip holds both channel buffers
    expect(tracks[0].clips[0].bufferIds).toEqual(['buf-L', 'buf-R']);
    // Clip name is just the file name (no channel suffix)
    expect(tracks[0].clips[0].name).toBe('stereo-ambience.wav');
  });

  // ==================== Quad file ====================

  it('should create a quad track for a 4-channel file with a single clip', () => {
    const result = model.importAudioToNewTrack(
      ['buf-0', 'buf-1', 'buf-2', 'buf-3'],
      'quad-ambience.wav',
      48000,
      48000,
      0,
      0,
    );

    expect(result.newTrackIds).toHaveLength(1);
    // New model: 1 clip with bufferIds = ['buf-0', 'buf-1', 'buf-2', 'buf-3']
    expect(result.clipIds).toHaveLength(1);

    const track = model.timeline.tracks[0];
    expect(track.channels).toBe(4);
    expect(track.clips).toHaveLength(1);
    expect(track.clips[0].bufferIds).toEqual(['buf-0', 'buf-1', 'buf-2', 'buf-3']);
  });

  // ==================== 5.1 surround file ====================

  it('should create a 5.1 track for a 6-channel file with a single clip', () => {
    const bufferIds = ['b0', 'b1', 'b2', 'b3', 'b4', 'b5'];
    const result = model.importAudioToNewTrack(
      bufferIds,
      'surround.wav',
      48000,
      48000,
      0,
      0,
    );

    expect(result.newTrackIds).toHaveLength(1);
    // New model: 1 clip with all 6 bufferIds
    expect(result.clipIds).toHaveLength(1);

    const track = model.timeline.tracks[0];
    expect(track.channels).toBe(6);
    expect(track.clips).toHaveLength(1);
    expect(track.clips[0].bufferIds).toEqual(bufferIds);
  });

  // ==================== 5-channel file ====================

  it('should create a 5-channel track for a 5-channel file with a single clip', () => {
    const bufferIds = ['b0', 'b1', 'b2', 'b3', 'b4'];
    const result = model.importAudioToNewTrack(
      bufferIds,
      '5ch.wav',
      48000,
      48000,
      0,
      0,
    );

    expect(result.newTrackIds).toHaveLength(1);
    // New model: 1 clip with all 5 bufferIds
    expect(result.clipIds).toHaveLength(1);

    const track = model.timeline.tracks[0];
    expect(track.channels).toBe(5);
    expect(track.clips).toHaveLength(1);
    expect(track.clips[0].bufferIds).toEqual(bufferIds);
  });

  // ==================== Unsupported channel count (3 or 7+) ====================

  it('should create separate mono tracks for unsupported channel count (3-channel)', () => {
    const result = model.importAudioToNewTrack(
      ['b0', 'b1', 'b2'],
      '3ch.wav',
      48000,
      48000,
      0,
      0,
    );

    // 3 channels = 3 mono tracks (unsupported multi-ch count)
    expect(result.newTrackIds).toHaveLength(3);
    expect(result.clipIds).toHaveLength(3);

    const tracks = model.timeline.tracks;
    expect(tracks).toHaveLength(3);
    for (const track of tracks) {
      expect(track.channels).toBe(1);
      expect(track.clips).toHaveLength(1);
    }
  });

  // ==================== Insert position ====================

  it('should insert new track AFTER the specified index', () => {
    // Create 3 existing tracks
    model.addTrack('Track A', '#aaa', 0, 1);
    model.addTrack('Track B', '#bbb', 1, 1);
    model.addTrack('Track C', '#ccc', 2, 1);

    expect(model.timeline.tracks).toHaveLength(3);

    // Import after index 1 (after "Track B")
    model.importAudioToNewTrack(
      ['buf-new'],
      'new-audio.wav',
      48000,
      48000,
      1, // insertAfterIndex
      0,
    );

    expect(model.timeline.tracks).toHaveLength(4);
    // New track should be at index 2 (after Track B, before Track C)
    expect(model.timeline.tracks[0].name).toBe('Track A');
    expect(model.timeline.tracks[1].name).toBe('Track B');
    expect(model.timeline.tracks[2].name).toBe('new-audio.wav');
    expect(model.timeline.tracks[3].name).toBe('Track C');
  });

  it('should insert at the end when insertAfterIndex equals last track index', () => {
    model.addTrack('Track A', '#aaa', 0, 1);
    model.addTrack('Track B', '#bbb', 1, 1);

    model.importAudioToNewTrack(
      ['buf-new'],
      'end-audio.wav',
      48000,
      48000,
      1, // insertAfterIndex = last track
      0,
    );

    expect(model.timeline.tracks).toHaveLength(3);
    expect(model.timeline.tracks[2].name).toBe('end-audio.wav');
  });

  it('should insert at the end when insertAfterIndex is -1 (no track selected)', () => {
    model.addTrack('Track A', '#aaa', 0, 1);

    model.importAudioToNewTrack(
      ['buf-new'],
      'appended.wav',
      48000,
      48000,
      -1, // no track selected
      0,
    );

    expect(model.timeline.tracks).toHaveLength(2);
    expect(model.timeline.tracks[1].name).toBe('appended.wav');
  });

  it('should insert stereo track after specified index preserving order', () => {
    model.addTrack('Track A', '#aaa', 0, 1);
    model.addTrack('Track B', '#bbb', 1, 1);
    model.addTrack('Track C', '#ccc', 2, 1);

    model.importAudioToNewTrack(
      ['buf-L', 'buf-R'],
      'stereo.wav',
      48000,
      48000,
      0, // insert after Track A
      0,
    );

    expect(model.timeline.tracks).toHaveLength(4);
    expect(model.timeline.tracks[0].name).toBe('Track A');
    expect(model.timeline.tracks[1].name).toBe('stereo.wav');
    expect(model.timeline.tracks[1].channels).toBe(2);
    expect(model.timeline.tracks[2].name).toBe('Track B');
    expect(model.timeline.tracks[3].name).toBe('Track C');
  });

  // ==================== Multiple imports ====================

  it('should allow importing multiple files sequentially (each gets its own track)', () => {
    model.importAudioToNewTrack(['buf-1'], 'file1.wav', 48000, 48000, -1, 0);
    model.importAudioToNewTrack(['buf-2'], 'file2.wav', 48000, 48000, 0, 24000);
    model.importAudioToNewTrack(['buf-3'], 'file3.wav', 48000, 48000, 1, 48000);

    expect(model.timeline.tracks).toHaveLength(3);
    expect(model.timeline.tracks[0].name).toBe('file1.wav');
    expect(model.timeline.tracks[1].name).toBe('file2.wav');
    // file3 inserted after index 1, so it goes between file2 and whatever was at index 2
    expect(model.timeline.tracks[2].name).toBe('file3.wav');
  });

  // ==================== Total length recalculation ====================

  it('should update totalLength after import', () => {
    expect(model.timeline.totalLength).toBe(0);

    model.importAudioToNewTrack(
      ['buf-1'],
      'audio.wav',
      48000,
      96000,
      -1,
      24000, // offset + duration = 24000 + 96000 = 120000
    );

    expect(model.timeline.totalLength).toBe(120000);
  });

  // ==================== Unsupported channel count inserts after index correctly ====================

  it('should insert multiple mono tracks for unsupported channel count at correct position', () => {
    model.addTrack('Existing', '#aaa', 0, 1);

    model.importAudioToNewTrack(
      ['b0', 'b1', 'b2'],
      '3ch.wav',
      48000,
      48000,
      0, // insert after first track
      0,
    );

    expect(model.timeline.tracks).toHaveLength(4);
    expect(model.timeline.tracks[0].name).toBe('Existing');
    // 3 new mono tracks inserted at indices 1, 2, 3
    expect(model.timeline.tracks[1].channels).toBe(1);
    expect(model.timeline.tracks[2].channels).toBe(1);
    expect(model.timeline.tracks[3].channels).toBe(1);
  });
});
