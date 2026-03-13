/**
 * TDD tests for cross-track channel split/merge and incompatibility rejection.
 * Tests CrossTrackChannelCommand (undo/redo), channel compatibility checks,
 * and the split/merge logic for grouped clips.
 */
import { describe, it, expect } from 'vitest';
import { CrossTrackChannelCommand } from '../../src/utils/TimelineUndoManager';
import { TimelineModel, generateGroupId } from '../../src/core/TimelineModel';
import type { Clip, TrackChannelCount } from '../../src/core/types';

// ==================== Helpers ====================

function createClip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: `clip-${Math.random().toString(36).slice(2, 8)}`,
    bufferId: 'buf-1',
    name: 'test-clip',
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

function createStereoModel(): { model: TimelineModel; stereoTrackId: string; monoTrackIds: string[] } {
  const model = new TimelineModel();
  const stereoTrack = model.addTrack('Stereo', '#3b82f6', 0, 2);
  const monoTrack1 = model.addTrack('Mono L', '#10b981', 1, 1);
  const monoTrack2 = model.addTrack('Mono R', '#f59e0b', 2, 1);

  // Add grouped stereo clips to the stereo track
  const groupId = generateGroupId();
  model.addClip(stereoTrack.id, createClip({
    id: 'clip-L', name: 'Left', subChannel: 0, groupId, bufferId: 'buf-L',
  }));
  model.addClip(stereoTrack.id, createClip({
    id: 'clip-R', name: 'Right', subChannel: 1, groupId, bufferId: 'buf-R',
  }));

  return {
    model,
    stereoTrackId: stereoTrack.id,
    monoTrackIds: [monoTrack1.id, monoTrack2.id],
  };
}

function createQuadModel(): { model: TimelineModel; quadTrackId: string; stereoTrackIds: string[]; monoTrackIds: string[] } {
  const model = new TimelineModel();
  const quadTrack = model.addTrack('Quad', '#3b82f6', 0, 4);
  const stereoTrack1 = model.addTrack('Stereo 1', '#10b981', 1, 2);
  const stereoTrack2 = model.addTrack('Stereo 2', '#f59e0b', 2, 2);
  const monoTrack1 = model.addTrack('Mono 1', '#ef4444', 3, 1);
  const monoTrack2 = model.addTrack('Mono 2', '#8b5cf6', 4, 1);
  const monoTrack3 = model.addTrack('Mono 3', '#ec4899', 5, 1);
  const monoTrack4 = model.addTrack('Mono 4', '#3b82f6', 6, 1);

  const groupId = generateGroupId();
  for (let i = 0; i < 4; i++) {
    model.addClip(quadTrack.id, createClip({
      id: `clip-ch${i}`, name: `Ch ${i}`, subChannel: i, groupId, bufferId: `buf-ch${i}`,
    }));
  }

  return {
    model,
    quadTrackId: quadTrack.id,
    stereoTrackIds: [stereoTrack1.id, stereoTrack2.id],
    monoTrackIds: [monoTrack1.id, monoTrack2.id, monoTrack3.id, monoTrack4.id],
  };
}

// ==================== CrossTrackChannelCommand ====================

describe('CrossTrackChannelCommand', () => {
  it('should restore before state on undo', () => {
    const model = new TimelineModel();
    const track = model.addTrack('Track 1', '#3b82f6', 0);
    model.addClip(track.id, createClip({ id: 'clip-a' }));

    const before = [{ trackId: track.id, clips: [{ ...model.timeline.tracks[0].clips[0] }] }];

    // Simulate "after" state: clip moved
    const afterClip = createClip({ id: 'clip-a', timelineOffset: 10000 });
    const after = [{ trackId: track.id, clips: [afterClip] }];

    const cmd = new CrossTrackChannelCommand(model, before, after, 'Test split');
    cmd.execute();

    expect(model.timeline.tracks[0].clips[0].timelineOffset).toBe(10000);

    cmd.undo();
    expect(model.timeline.tracks[0].clips[0].timelineOffset).toBe(0);
  });

  it('should handle multi-track snapshots for redo', () => {
    const { model, stereoTrackId, monoTrackIds } = createStereoModel();
    const stereoClips = model.timeline.tracks[0].clips.map(c => ({ ...c }));

    const before = [
      { trackId: stereoTrackId, clips: [...stereoClips] },
      { trackId: monoTrackIds[0], clips: [] },
      { trackId: monoTrackIds[1], clips: [] },
    ];

    // Simulate split: clips moved to mono tracks
    const after = [
      { trackId: stereoTrackId, clips: [] },
      { trackId: monoTrackIds[0], clips: [{ ...stereoClips[0], subChannel: undefined, groupId: undefined }] },
      { trackId: monoTrackIds[1], clips: [{ ...stereoClips[1], subChannel: undefined, groupId: undefined }] },
    ];

    const cmd = new CrossTrackChannelCommand(model, before, after, 'Split stereo to mono');

    cmd.execute();
    expect(model.timeline.tracks[0].clips.length).toBe(0); // stereo track empty
    expect(model.timeline.tracks[1].clips.length).toBe(1); // mono L has clip
    expect(model.timeline.tracks[2].clips.length).toBe(1); // mono R has clip

    cmd.undo();
    expect(model.timeline.tracks[0].clips.length).toBe(2); // stereo track restored
    expect(model.timeline.tracks[1].clips.length).toBe(0);
    expect(model.timeline.tracks[2].clips.length).toBe(0);
  });
});

// ==================== Channel Compatibility ====================

describe('Channel Compatibility', () => {
  // Test the compatibility rules directly using a minimal implementation
  function isCompatible(sourceChannels: number, targetChannels: number): boolean {
    if (sourceChannels === targetChannels) return true;
    if (sourceChannels > targetChannels) return sourceChannels % targetChannels === 0;
    return targetChannels % sourceChannels === 0;
  }

  it('same channel count is always compatible', () => {
    expect(isCompatible(1, 1)).toBe(true);
    expect(isCompatible(2, 2)).toBe(true);
    expect(isCompatible(4, 4)).toBe(true);
  });

  it('stereo to mono is compatible (split)', () => {
    expect(isCompatible(2, 1)).toBe(true);
  });

  it('quad to stereo is compatible (split)', () => {
    expect(isCompatible(4, 2)).toBe(true);
  });

  it('quad to mono is compatible (split)', () => {
    expect(isCompatible(4, 1)).toBe(true);
  });

  it('mono to stereo is compatible (merge)', () => {
    expect(isCompatible(1, 2)).toBe(true);
  });

  it('stereo to quad is compatible (merge)', () => {
    expect(isCompatible(2, 4)).toBe(true);
  });

  it('mono to quad is compatible (merge)', () => {
    expect(isCompatible(1, 4)).toBe(true);
  });

  it('6ch to 4ch is not compatible (6 % 4 !== 0)', () => {
    expect(isCompatible(6, 4)).toBe(false);
  });
});

// ==================== Stereo → 2x Mono Split ====================

describe('Stereo to Mono Split', () => {
  it('should remove clips from stereo track', () => {
    const { model, stereoTrackId } = createStereoModel();
    const stereoTrack = model.timeline.tracks.find(t => t.id === stereoTrackId)!;

    // Verify initial state
    expect(stereoTrack.clips.length).toBe(2);

    // Simulate split: remove clips from stereo track
    const [clipL, clipR] = stereoTrack.clips;
    stereoTrack.clips = [];

    expect(stereoTrack.clips.length).toBe(0);
    expect(clipL.subChannel).toBe(0);
    expect(clipR.subChannel).toBe(1);
  });

  it('should place L clip on first mono track and R clip on second', () => {
    const { model, stereoTrackId, monoTrackIds } = createStereoModel();
    const stereoTrack = model.timeline.tracks.find(t => t.id === stereoTrackId)!;
    const monoTrack1 = model.timeline.tracks.find(t => t.id === monoTrackIds[0])!;
    const monoTrack2 = model.timeline.tracks.find(t => t.id === monoTrackIds[1])!;

    // Execute split
    const [clipL, clipR] = stereoTrack.clips.map(c => ({ ...c }));
    stereoTrack.clips = [];
    monoTrack1.clips.push({ ...clipL, subChannel: undefined, groupId: undefined });
    monoTrack2.clips.push({ ...clipR, subChannel: undefined, groupId: undefined });

    expect(monoTrack1.clips.length).toBe(1);
    expect(monoTrack2.clips.length).toBe(1);
    expect(monoTrack1.clips[0].bufferId).toBe('buf-L');
    expect(monoTrack2.clips[0].bufferId).toBe('buf-R');
    expect(monoTrack1.clips[0].subChannel).toBeUndefined();
    expect(monoTrack2.clips[0].subChannel).toBeUndefined();
    expect(monoTrack1.clips[0].groupId).toBeUndefined();
    expect(monoTrack2.clips[0].groupId).toBeUndefined();
  });
});

// ==================== Quad → 2x Stereo Split ====================

describe('Quad to Stereo Split', () => {
  it('should distribute 4 clips to 2 stereo tracks with new groupIds', () => {
    const { model, quadTrackId, stereoTrackIds } = createQuadModel();
    const quadTrack = model.timeline.tracks.find(t => t.id === quadTrackId)!;
    const stereoTrack1 = model.timeline.tracks.find(t => t.id === stereoTrackIds[0])!;
    const stereoTrack2 = model.timeline.tracks.find(t => t.id === stereoTrackIds[1])!;

    // ch0+ch1 → stereo track 1, ch2+ch3 → stereo track 2
    const clips = quadTrack.clips.map(c => ({ ...c }));
    quadTrack.clips = [];

    const groupA = generateGroupId();
    const groupB = generateGroupId();
    stereoTrack1.clips.push(
      { ...clips[0], subChannel: 0, groupId: groupA },
      { ...clips[1], subChannel: 1, groupId: groupA },
    );
    stereoTrack2.clips.push(
      { ...clips[2], subChannel: 0, groupId: groupB },
      { ...clips[3], subChannel: 1, groupId: groupB },
    );

    expect(stereoTrack1.clips.length).toBe(2);
    expect(stereoTrack2.clips.length).toBe(2);
    // Both clips in stereo track 1 share groupA
    expect(stereoTrack1.clips[0].groupId).toBe(stereoTrack1.clips[1].groupId);
    // Both clips in stereo track 2 share groupB
    expect(stereoTrack2.clips[0].groupId).toBe(stereoTrack2.clips[1].groupId);
    // Groups are different
    expect(stereoTrack1.clips[0].groupId).not.toBe(stereoTrack2.clips[0].groupId);
    // SubChannels are remapped to 0,1 within each stereo pair
    expect(stereoTrack1.clips[0].subChannel).toBe(0);
    expect(stereoTrack1.clips[1].subChannel).toBe(1);
    expect(stereoTrack2.clips[0].subChannel).toBe(0);
    expect(stereoTrack2.clips[1].subChannel).toBe(1);
  });
});

// ==================== Mono → Stereo Merge ====================

describe('Mono to Stereo Merge', () => {
  it('should merge 2 mono clips into stereo track with new groupId and subChannels', () => {
    const model = new TimelineModel();
    const monoTrack1 = model.addTrack('Mono 1', '#3b82f6', 0, 1);
    const monoTrack2 = model.addTrack('Mono 2', '#10b981', 1, 1);
    const stereoTrack = model.addTrack('Stereo', '#f59e0b', 2, 2);

    const clipA = createClip({ id: 'clip-A', bufferId: 'buf-A' });
    const clipB = createClip({ id: 'clip-B', bufferId: 'buf-B' });
    model.addClip(monoTrack1.id, clipA);
    model.addClip(monoTrack2.id, clipB);

    // Simulate merge
    const mono1 = model.timeline.tracks.find(t => t.id === monoTrack1.id)!;
    const mono2 = model.timeline.tracks.find(t => t.id === monoTrack2.id)!;
    const stereo = model.timeline.tracks.find(t => t.id === stereoTrack.id)!;

    const newGroupId = generateGroupId();
    const mergedA = { ...mono1.clips[0], subChannel: 0, groupId: newGroupId };
    const mergedB = { ...mono2.clips[0], subChannel: 1, groupId: newGroupId };

    mono1.clips = [];
    mono2.clips = [];
    stereo.clips.push(mergedA, mergedB);

    expect(stereo.clips.length).toBe(2);
    expect(stereo.clips[0].subChannel).toBe(0);
    expect(stereo.clips[1].subChannel).toBe(1);
    expect(stereo.clips[0].groupId).toBe(stereo.clips[1].groupId);
    expect(mono1.clips.length).toBe(0);
    expect(mono2.clips.length).toBe(0);
  });
});

// ==================== Source Track Preserved ====================

describe('Source Track Preservation', () => {
  it('source track should remain (empty) after split', () => {
    const { model, stereoTrackId } = createStereoModel();
    const stereoTrack = model.timeline.tracks.find(t => t.id === stereoTrackId)!;

    // After split, track still exists but is empty
    stereoTrack.clips = [];

    expect(model.timeline.tracks.find(t => t.id === stereoTrackId)).toBeDefined();
    expect(stereoTrack.clips.length).toBe(0);
    expect(stereoTrack.channels).toBe(2); // channel config preserved
  });
});

// ==================== Same-Channel Cross-Track Group Move ====================

describe('Same-Channel Cross-Track Group Move', () => {
  it('moveClipToTrack should move only the specified clip, not siblings', () => {
    // This tests the model-level behavior: moveClipToTrack is a single-clip operation
    const model = new TimelineModel();
    const trackA = model.addTrack('Stereo A', '#3b82f6', 0, 2);
    const trackB = model.addTrack('Stereo B', '#10b981', 1, 2);

    const groupId = generateGroupId();
    model.addClip(trackA.id, createClip({ id: 'clip-L', subChannel: 0, groupId }));
    model.addClip(trackA.id, createClip({ id: 'clip-R', subChannel: 1, groupId }));

    // Move only clip-L to trackB
    model.moveClipToTrack(trackA.id, trackB.id, 'clip-L', 0);

    // clip-L moved to trackB
    const trackAClips = model.timeline.tracks[0].clips;
    const trackBClips = model.timeline.tracks[1].clips;
    expect(trackBClips.find(c => c.id === 'clip-L')).toBeDefined();
    // clip-R stays on trackA — this is the model's correct single-clip behavior
    expect(trackAClips.find(c => c.id === 'clip-R')).toBeDefined();
  });

  it('all grouped clips must end up on the same target track after cross-track drag', () => {
    // This tests the expected outcome: after a cross-track drag of a grouped clip,
    // ALL siblings should be on the target track, not split across tracks
    const model = new TimelineModel();
    const trackA = model.addTrack('Stereo A', '#3b82f6', 0, 2);
    const trackB = model.addTrack('Stereo B', '#10b981', 1, 2);

    const groupId = generateGroupId();
    model.addClip(trackA.id, createClip({ id: 'clip-L', subChannel: 0, groupId }));
    model.addClip(trackA.id, createClip({ id: 'clip-R', subChannel: 1, groupId }));

    // Simulate what App.ts onClipMove SHOULD do: move ALL grouped clips together
    const clip = model.timeline.tracks[0].clips.find(c => c.id === 'clip-L')!;
    const siblings = model.getSiblingClips(trackA.id, 'clip-L');

    // Move primary clip
    model.moveClipToTrack(trackA.id, trackB.id, 'clip-L', 1000);
    // Move all siblings too (this is what the fix should ensure)
    for (const sib of siblings) {
      model.moveClipToTrack(trackA.id, trackB.id, sib.id, 1000);
    }

    const trackAClips = model.timeline.tracks[0].clips;
    const trackBClips = model.timeline.tracks[1].clips;
    expect(trackAClips.length).toBe(0);
    expect(trackBClips.length).toBe(2);
    expect(trackBClips.find(c => c.id === 'clip-L')).toBeDefined();
    expect(trackBClips.find(c => c.id === 'clip-R')).toBeDefined();
    // Both should have the same offset
    expect(trackBClips[0].timelineOffset).toBe(1000);
    expect(trackBClips[1].timelineOffset).toBe(1000);
  });

  it('batch-moved siblings should track to target track, not stay on source', () => {
    // Regression test: previously batch loop did moveClipToTrack(t.id, t.id, ...)
    // which kept siblings on the source track
    const model = new TimelineModel();
    const trackA = model.addTrack('Stereo A', '#3b82f6', 0, 2);
    const trackB = model.addTrack('Stereo B', '#10b981', 1, 2);

    const groupId = generateGroupId();
    model.addClip(trackA.id, createClip({ id: 'clip-L', subChannel: 0, groupId, timelineOffset: 0 }));
    model.addClip(trackA.id, createClip({ id: 'clip-R', subChannel: 1, groupId, timelineOffset: 0 }));

    const newOffset = 5000;
    // Move primary
    model.moveClipToTrack(trackA.id, trackB.id, 'clip-L', newOffset);
    // Move sibling to SAME target track (not keeping on source)
    model.moveClipToTrack(trackA.id, trackB.id, 'clip-R', newOffset);

    expect(model.timeline.tracks[0].clips.length).toBe(0);
    expect(model.timeline.tracks[1].clips.length).toBe(2);
    expect(model.timeline.tracks[1].clips.every(c => c.timelineOffset === newOffset)).toBe(true);
  });
});

// ==================== Drag-sequence cross-channel tracking ====================

describe('Cross-channel drag sequence tracking', () => {
  /**
   * Regression test for: stereo→mono split leaves L clip on source track.
   *
   * Root cause: during drag, the renderer updates drag.trackId to the target
   * track even when the clip was NOT actually moved (cross-channel moves are
   * deferred to dragEnd). On the next mouse-move, sourceTrackId === targetTrackId,
   * so the cross-channel target flag gets cleared. By dragEnd it's null, so
   * executeCrossTrackSplit is never called.
   *
   * This test simulates the sequence of onClipMove calls that occur during
   * a stereo→mono drag and verifies the cross-channel target is preserved.
   */
  it('cross-channel target should survive subsequent same-track move events', () => {
    // Simulate the _dragCrossChannelTarget tracking logic from App.ts onClipMove
    let dragCrossChannelTarget: { targetTrackId: string; newOffset: number } | null = null;

    const tracks = [
      { id: 'stereo-1', channels: 2 },
      { id: 'mono-1', channels: 1 },
      { id: 'mono-2', channels: 1 },
    ];

    function simulateOnClipMove(
      sourceTrackId: string,
      targetTrackId: string,
      newOffset: number,
    ): string /* effectiveTargetTrackId */ {
      let effectiveTargetTrackId = targetTrackId;
      if (sourceTrackId !== targetTrackId) {
        const sourceTrack = tracks.find(t => t.id === sourceTrackId);
        const targetTrack = tracks.find(t => t.id === targetTrackId);
        if (sourceTrack && targetTrack && sourceTrack.channels !== targetTrack.channels) {
          effectiveTargetTrackId = sourceTrackId;
          dragCrossChannelTarget = { targetTrackId, newOffset };
        } else {
          dragCrossChannelTarget = null;
        }
      } else {
        // BUG: this clears the cross-channel target even though clip is still
        // on the original track and the user hasn't moved back.
        dragCrossChannelTarget = null;
      }
      return effectiveTargetTrackId;
    }

    // Simulate renderer's drag.trackId behavior
    // FIX: renderer should NOT update drag.trackId when channel counts differ
    let rendererDragTrackId = 'stereo-1';

    // Move 1: user drags from stereo track to mono-1
    const target1 = simulateOnClipMove(rendererDragTrackId, 'mono-1', 5000);
    // With fix: renderer keeps drag.trackId as source because channels differ
    const source1 = tracks.find(t => t.id === rendererDragTrackId)!;
    const dest1 = tracks.find(t => t.id === 'mono-1')!;
    if (source1.channels === dest1.channels) {
      rendererDragTrackId = 'mono-1';
    }
    // drag.trackId stays 'stereo-1' because channels differ (2 !== 1)

    expect(rendererDragTrackId).toBe('stereo-1');
    expect(dragCrossChannelTarget).not.toBeNull();
    expect(dragCrossChannelTarget!.targetTrackId).toBe('mono-1');

    // Move 2: mouse still on mono-1, renderer correctly reports source as stereo-1
    const target2 = simulateOnClipMove(rendererDragTrackId, 'mono-1', 5100);

    // With fix: cross-channel target is preserved because sourceTrackId !== targetTrackId
    expect(dragCrossChannelTarget).not.toBeNull();
    expect(dragCrossChannelTarget!.targetTrackId).toBe('mono-1');
  });
});

// ==================== Overlap Resolution ====================

describe('Cross-track Overlap Resolution', () => {
  it('should trim existing clip when new clip overlaps', () => {
    const model = new TimelineModel();
    const track = model.addTrack('Mono', '#3b82f6', 0, 1);

    // Existing clip: 0..48000
    model.addClip(track.id, createClip({ id: 'existing', timelineOffset: 0 }));
    // New clip placed at 24000..72000
    model.addClip(track.id, createClip({ id: 'incoming', timelineOffset: 24000 }));

    const result = model.resolveOverlaps(track.id, 'incoming');

    // Existing clip should be trimmed to 0..24000
    expect(result.trimmed.length).toBe(1);
    expect(result.trimmed[0].clipId).toBe('existing');
    const existing = model.timeline.tracks[0].clips.find(c => c.id === 'existing')!;
    expect(existing.duration).toBe(24000);
  });

  it('should remove existing clip when fully covered', () => {
    const model = new TimelineModel();
    const track = model.addTrack('Mono', '#3b82f6', 0, 1);

    // Small existing clip
    model.addClip(track.id, createClip({ id: 'small', timelineOffset: 10000, sourceEnd: 20000, duration: 10000 }));
    // Large clip covering it completely
    model.addClip(track.id, createClip({ id: 'large', timelineOffset: 0, sourceEnd: 96000, duration: 96000 }));

    const result = model.resolveOverlaps(track.id, 'large');

    expect(result.removed.length).toBe(1);
    expect(result.removed[0].id).toBe('small');
    expect(model.timeline.tracks[0].clips.find(c => c.id === 'small')).toBeUndefined();
  });

  it('should NOT remove sibling clips in the same group during resolveOverlaps', () => {
    const model = new TimelineModel();
    const track = model.addTrack('Stereo', '#3b82f6', 0, 2);

    const groupId = generateGroupId();
    // Two grouped sub-channel clips at the same position (stereo pair)
    model.addClip(track.id, createClip({
      id: 'clip-L', subChannel: 0, groupId, timelineOffset: 0, sourceEnd: 48000, duration: 48000,
    }));
    model.addClip(track.id, createClip({
      id: 'clip-R', subChannel: 1, groupId, timelineOffset: 0, sourceEnd: 48000, duration: 48000,
    }));

    // resolveOverlaps on the L clip should leave the R clip intact
    const result = model.resolveOverlaps(track.id, 'clip-L');

    expect(result.removed.length).toBe(0);
    expect(result.trimmed.length).toBe(0);
    const trackClips = model.timeline.tracks[0].clips;
    expect(trackClips.find(c => c.id === 'clip-L')).toBeDefined();
    expect(trackClips.find(c => c.id === 'clip-R')).toBeDefined();
  });
});

// ==================== 4ch+ Split/Merge Algorithm Tests ====================

/**
 * Reusable split algorithm that mirrors App.ts executeCrossTrackSplit.
 * Takes a model, source track, target track start index, clip ID, and new offset.
 * Returns before/after snapshots or null on failure.
 */
function executeSplitAlgorithm(
  model: TimelineModel,
  sourceTrackId: string,
  targetTrackStartIndex: number,
  clipId: string,
  newOffset: number,
): { before: Array<{ trackId: string; clips: Clip[] }>; after: Array<{ trackId: string; clips: Clip[] }> } | null {
  const tracks = model.timeline.tracks;
  const sourceTrack = tracks.find(t => t.id === sourceTrackId);
  if (!sourceTrack) return null;

  const clip = sourceTrack.clips.find(c => c.id === clipId);
  if (!clip) return null;

  const groupClips = clip.groupId
    ? sourceTrack.clips.filter(c => c.groupId === clip.groupId).sort((a, b) => (a.subChannel ?? 0) - (b.subChannel ?? 0))
    : [clip];

  const sourceChannels = sourceTrack.channels;
  const targetTrack = tracks[targetTrackStartIndex];
  if (!targetTrack) return null;
  const targetChannels = targetTrack.channels;

  const clipsPerTarget = targetChannels;
  const numTargetTracks = sourceChannels / targetChannels;

  // Verify consecutive target tracks
  for (let i = 0; i < numTargetTracks; i++) {
    const idx = targetTrackStartIndex + i;
    if (idx >= tracks.length || tracks[idx].channels !== targetChannels) return null;
  }

  const offsetDelta = newOffset - clip.timelineOffset;

  // Snapshot before
  const affectedTrackIds = [sourceTrackId];
  for (let i = 0; i < numTargetTracks; i++) {
    const tId = tracks[targetTrackStartIndex + i].id;
    if (!affectedTrackIds.includes(tId)) affectedTrackIds.push(tId);
  }
  const before = affectedTrackIds.map(tId => {
    const t = tracks.find(tr => tr.id === tId)!;
    return { trackId: tId, clips: t.clips.map(c => ({ ...c })) };
  });

  // Execute split
  sourceTrack.clips = sourceTrack.clips.filter(c => !groupClips.some(gc => gc.id === c.id));

  for (let targetOffset = 0; targetOffset < numTargetTracks; targetOffset++) {
    const tTrack = tracks[targetTrackStartIndex + targetOffset];
    const startSubCh = targetOffset * clipsPerTarget;
    const endSubCh = startSubCh + clipsPerTarget;
    const clipsForThisTrack = groupClips.filter(c => {
      const sub = c.subChannel ?? 0;
      return sub >= startSubCh && sub < endSubCh;
    });

    const newGroupId = clipsForThisTrack.length > 1 ? generateGroupId() : undefined;

    for (const gc of clipsForThisTrack) {
      const newClip: Clip = {
        ...gc,
        timelineOffset: Math.max(0, gc.timelineOffset + offsetDelta),
        subChannel: clipsPerTarget > 1 ? (gc.subChannel ?? 0) - startSubCh : undefined,
        groupId: newGroupId,
      };
      tTrack.clips.push(newClip);
      model.resolveOverlaps(tTrack.id, newClip.id);
    }
  }

  // Snapshot after
  const after = affectedTrackIds.map(tId => {
    const t = tracks.find(tr => tr.id === tId)!;
    return { trackId: tId, clips: t.clips.map(c => ({ ...c })) };
  });

  return { before, after };
}

/**
 * Reusable merge algorithm that mirrors App.ts executeCrossTrackMerge.
 * Takes a model, ordered list of source clip/track pairs, target track ID, and new offset.
 */
function executeMergeAlgorithm(
  model: TimelineModel,
  sourceClips: Array<{ clipId: string; trackId: string }>,
  targetTrackId: string,
  newOffset: number,
): { before: Array<{ trackId: string; clips: Clip[] }>; after: Array<{ trackId: string; clips: Clip[] }> } | null {
  const tracks = model.timeline.tracks;
  const targetTrack = tracks.find(t => t.id === targetTrackId);
  if (!targetTrack) return null;

  const targetChannels = targetTrack.channels;

  // Build merge set from source clips sorted by track index
  const mergeSet: Array<{ clip: Clip; trackId: string; trackIndex: number; siblings: Clip[] }> = [];
  for (const sc of sourceClips) {
    for (let ti = 0; ti < tracks.length; ti++) {
      const c = tracks[ti].clips.find(cl => cl.id === sc.clipId);
      if (c) {
        // Collect siblings (other clips in same group on same track)
        const siblings = c.groupId
          ? tracks[ti].clips.filter(cl => cl.groupId === c.groupId && cl.id !== c.id)
          : [];
        mergeSet.push({ clip: c, trackId: tracks[ti].id, trackIndex: ti, siblings });
        break;
      }
    }
  }
  mergeSet.sort((a, b) => a.trackIndex - b.trackIndex);

  const firstSourceTrack = tracks.find(t => t.id === mergeSet[0]?.trackId);
  if (!firstSourceTrack) return null;
  const sourceChannels = firstSourceTrack.channels;
  const clipsNeeded = targetChannels / sourceChannels;
  if (mergeSet.length < clipsNeeded) return null;

  const finalMergeSet = mergeSet.slice(0, clipsNeeded);
  const offsetDelta = newOffset - finalMergeSet[0].clip.timelineOffset;

  // Snapshot before
  const affectedTrackIds = new Set<string>([targetTrackId]);
  for (const mc of finalMergeSet) {
    affectedTrackIds.add(mc.trackId);
  }
  const affectedIds = Array.from(affectedTrackIds);
  const before = affectedIds.map(tId => {
    const t = tracks.find(tr => tr.id === tId)!;
    return { trackId: tId, clips: t.clips.map(c => ({ ...c })) };
  });

  // Execute merge
  const newGroupId = generateGroupId();
  for (let i = 0; i < finalMergeSet.length; i++) {
    const mc = finalMergeSet[i];
    const srcTrack = tracks.find(t => t.id === mc.trackId)!;

    // Collect all clips to move from this source track (primary + siblings)
    const allClipsFromTrack = [mc.clip, ...mc.siblings];
    // Remove all from source
    for (const cl of allClipsFromTrack) {
      srcTrack.clips = srcTrack.clips.filter(c => c.id !== cl.id);
    }

    const baseSubChannel = i * sourceChannels;
    // Place each sub-channel clip on the target
    for (let ch = 0; ch < sourceChannels; ch++) {
      // Find the clip for this sub-channel
      const subClip = allClipsFromTrack.find(c => (c.subChannel ?? 0) === ch) ?? allClipsFromTrack[0];
      if (!subClip) continue;
      const newClip: Clip = {
        ...subClip,
        id: subClip.id, // keep original ID for overlap resolution
        timelineOffset: Math.max(0, subClip.timelineOffset + offsetDelta),
        subChannel: baseSubChannel + ch,
        groupId: newGroupId,
      };
      targetTrack.clips.push(newClip);
      model.resolveOverlaps(targetTrackId, newClip.id);
    }
  }

  // Snapshot after
  const after = affectedIds.map(tId => {
    const t = tracks.find(tr => tr.id === tId)!;
    return { trackId: tId, clips: t.clips.map(c => ({ ...c })) };
  });

  return { before, after };
}

// ==================== Quad → 4x Mono Split ====================

describe('Quad to Mono Split (4ch → 1ch)', () => {
  it('should distribute 4 sub-channel clips to 4 consecutive mono tracks', () => {
    const { model, quadTrackId, monoTrackIds } = createQuadModel();
    const quadTrack = model.timeline.tracks.find(t => t.id === quadTrackId)!;

    expect(quadTrack.clips.length).toBe(4);

    const targetIdx = model.timeline.tracks.findIndex(t => t.id === monoTrackIds[0]);
    const result = executeSplitAlgorithm(model, quadTrackId, targetIdx, 'clip-ch0', 1000);

    expect(result).not.toBeNull();
    // Source track should be empty
    expect(quadTrack.clips.length).toBe(0);

    // Each mono track should have exactly 1 clip
    for (let i = 0; i < 4; i++) {
      const monoTrack = model.timeline.tracks.find(t => t.id === monoTrackIds[i])!;
      expect(monoTrack.clips.length).toBe(1);
      // Mono clips should have no subChannel or groupId
      expect(monoTrack.clips[0].subChannel).toBeUndefined();
      expect(monoTrack.clips[0].groupId).toBeUndefined();
      // Offset should be applied
      expect(monoTrack.clips[0].timelineOffset).toBe(1000);
    }
  });

  it('should work with 6ch → mono (6 clips to 6 mono tracks)', () => {
    const model = new TimelineModel();
    const sixChTrack = model.addTrack('6ch', '#3b82f6', 0, 6);

    // Create 6 mono tracks
    const monoTrackIds: string[] = [];
    for (let i = 0; i < 6; i++) {
      const t = model.addTrack(`Mono ${i}`, '#10b981', i + 1, 1);
      monoTrackIds.push(t.id);
    }

    // Add 6 grouped clips
    const groupId = generateGroupId();
    for (let i = 0; i < 6; i++) {
      model.addClip(sixChTrack.id, createClip({
        id: `clip-ch${i}`, name: `Ch ${i}`, subChannel: i, groupId, bufferId: `buf-ch${i}`,
      }));
    }

    const targetIdx = model.timeline.tracks.findIndex(t => t.id === monoTrackIds[0]);
    const result = executeSplitAlgorithm(model, sixChTrack.id, targetIdx, 'clip-ch0', 0);

    expect(result).not.toBeNull();
    expect(sixChTrack.clips.length).toBe(0);

    for (let i = 0; i < 6; i++) {
      const monoTrack = model.timeline.tracks.find(t => t.id === monoTrackIds[i])!;
      expect(monoTrack.clips.length).toBe(1);
      expect(monoTrack.clips[0].subChannel).toBeUndefined();
      expect(monoTrack.clips[0].groupId).toBeUndefined();
    }
  });
});

// ==================== 6ch → Stereo Split ====================

describe('6ch to Stereo Split (6ch → 2ch)', () => {
  it('should distribute 6 clips to 3 consecutive stereo tracks', () => {
    const model = new TimelineModel();
    const sixChTrack = model.addTrack('6ch', '#3b82f6', 0, 6);

    const stereoTrackIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const t = model.addTrack(`Stereo ${i}`, '#10b981', i + 1, 2);
      stereoTrackIds.push(t.id);
    }

    const groupId = generateGroupId();
    for (let i = 0; i < 6; i++) {
      model.addClip(sixChTrack.id, createClip({
        id: `clip-ch${i}`, name: `Ch ${i}`, subChannel: i, groupId, bufferId: `buf-ch${i}`,
      }));
    }

    const targetIdx = model.timeline.tracks.findIndex(t => t.id === stereoTrackIds[0]);
    const result = executeSplitAlgorithm(model, sixChTrack.id, targetIdx, 'clip-ch0', 500);

    expect(result).not.toBeNull();
    expect(sixChTrack.clips.length).toBe(0);

    // 3 stereo tracks, each with 2 clips
    for (let i = 0; i < 3; i++) {
      const stereoTrack = model.timeline.tracks.find(t => t.id === stereoTrackIds[i])!;
      expect(stereoTrack.clips.length).toBe(2);
      // Each pair should share a groupId
      expect(stereoTrack.clips[0].groupId).toBe(stereoTrack.clips[1].groupId);
      // SubChannels should be remapped to 0,1
      expect(stereoTrack.clips[0].subChannel).toBe(0);
      expect(stereoTrack.clips[1].subChannel).toBe(1);
      expect(stereoTrack.clips[0].timelineOffset).toBe(500);
    }

    // Groups across different stereo tracks should be different
    const groups = stereoTrackIds.map(id => {
      const t = model.timeline.tracks.find(tr => tr.id === id)!;
      return t.clips[0].groupId;
    });
    expect(new Set(groups).size).toBe(3);
  });
});

// ==================== Mono → Quad Merge ====================

describe('Mono to Quad Merge (4x 1ch → 4ch)', () => {
  it('should merge 4 mono clips into 1 quad track with correct subChannels', () => {
    const model = new TimelineModel();
    const monoTrackIds: string[] = [];
    for (let i = 0; i < 4; i++) {
      const t = model.addTrack(`Mono ${i}`, '#10b981', i, 1);
      monoTrackIds.push(t.id);
    }
    const quadTrack = model.addTrack('Quad', '#3b82f6', 4, 4);

    // Add a clip to each mono track
    const clipIds: string[] = [];
    for (let i = 0; i < 4; i++) {
      const id = `clip-m${i}`;
      clipIds.push(id);
      model.addClip(monoTrackIds[i], createClip({ id, bufferId: `buf-m${i}` }));
    }

    const result = executeMergeAlgorithm(
      model,
      clipIds.map((id, i) => ({ clipId: id, trackId: monoTrackIds[i] })),
      quadTrack.id,
      2000,
    );

    expect(result).not.toBeNull();

    // All mono tracks should be empty
    for (let i = 0; i < 4; i++) {
      const mt = model.timeline.tracks.find(t => t.id === monoTrackIds[i])!;
      expect(mt.clips.length).toBe(0);
    }

    // Quad track should have 4 clips with subChannels 0-3
    const qt = model.timeline.tracks.find(t => t.id === quadTrack.id)!;
    expect(qt.clips.length).toBe(4);
    for (let i = 0; i < 4; i++) {
      expect(qt.clips.find(c => c.subChannel === i)).toBeDefined();
    }
    // All should share the same groupId
    const groupIds = new Set(qt.clips.map(c => c.groupId));
    expect(groupIds.size).toBe(1);
    expect(qt.clips[0].timelineOffset).toBe(2000);
  });
});

// ==================== Stereo → Quad Merge ====================

describe('Stereo to Quad Merge (2x 2ch → 4ch)', () => {
  it('should merge 2 stereo tracks into 1 quad track with correct subChannels', () => {
    const model = new TimelineModel();
    const stereoTrack1 = model.addTrack('Stereo 1', '#10b981', 0, 2);
    const stereoTrack2 = model.addTrack('Stereo 2', '#f59e0b', 1, 2);
    const quadTrack = model.addTrack('Quad', '#3b82f6', 2, 4);

    // Add grouped stereo clips to each stereo track
    const groupId1 = generateGroupId();
    model.addClip(stereoTrack1.id, createClip({
      id: 'clip-s1-L', subChannel: 0, groupId: groupId1, bufferId: 'buf-s1-L',
    }));
    model.addClip(stereoTrack1.id, createClip({
      id: 'clip-s1-R', subChannel: 1, groupId: groupId1, bufferId: 'buf-s1-R',
    }));

    const groupId2 = generateGroupId();
    model.addClip(stereoTrack2.id, createClip({
      id: 'clip-s2-L', subChannel: 0, groupId: groupId2, bufferId: 'buf-s2-L',
    }));
    model.addClip(stereoTrack2.id, createClip({
      id: 'clip-s2-R', subChannel: 1, groupId: groupId2, bufferId: 'buf-s2-R',
    }));

    // Merge using one clip from each stereo track as the representative
    const result = executeMergeAlgorithm(
      model,
      [
        { clipId: 'clip-s1-L', trackId: stereoTrack1.id },
        { clipId: 'clip-s2-L', trackId: stereoTrack2.id },
      ],
      quadTrack.id,
      0,
    );

    expect(result).not.toBeNull();

    // Stereo tracks should be empty
    const st1 = model.timeline.tracks.find(t => t.id === stereoTrack1.id)!;
    const st2 = model.timeline.tracks.find(t => t.id === stereoTrack2.id)!;
    expect(st1.clips.length).toBe(0);
    expect(st2.clips.length).toBe(0);

    // Quad track should have 4 clips with subChannels 0,1,2,3
    const qt = model.timeline.tracks.find(t => t.id === quadTrack.id)!;
    expect(qt.clips.length).toBe(4);
    for (let i = 0; i < 4; i++) {
      expect(qt.clips.find(c => c.subChannel === i)).toBeDefined();
    }
    // All should share the same groupId
    const groupIds = new Set(qt.clips.map(c => c.groupId));
    expect(groupIds.size).toBe(1);
  });
});

// ==================== Mono → 6ch Merge ====================

describe('Mono to 6ch Merge (6x 1ch → 6ch)', () => {
  it('should merge 6 mono clips into 1 6ch track', () => {
    const model = new TimelineModel();
    const monoTrackIds: string[] = [];
    for (let i = 0; i < 6; i++) {
      const t = model.addTrack(`Mono ${i}`, '#10b981', i, 1);
      monoTrackIds.push(t.id);
    }
    const sixChTrack = model.addTrack('6ch', '#3b82f6', 6, 6);

    const clipIds: string[] = [];
    for (let i = 0; i < 6; i++) {
      const id = `clip-m${i}`;
      clipIds.push(id);
      model.addClip(monoTrackIds[i], createClip({ id, bufferId: `buf-m${i}` }));
    }

    const result = executeMergeAlgorithm(
      model,
      clipIds.map((id, i) => ({ clipId: id, trackId: monoTrackIds[i] })),
      sixChTrack.id,
      0,
    );

    expect(result).not.toBeNull();

    // All mono tracks empty
    for (let i = 0; i < 6; i++) {
      const mt = model.timeline.tracks.find(t => t.id === monoTrackIds[i])!;
      expect(mt.clips.length).toBe(0);
    }

    // 6ch track has 6 clips with subChannels 0-5
    const st = model.timeline.tracks.find(t => t.id === sixChTrack.id)!;
    expect(st.clips.length).toBe(6);
    for (let i = 0; i < 6; i++) {
      expect(st.clips.find(c => c.subChannel === i)).toBeDefined();
    }
    const groupIds = new Set(st.clips.map(c => c.groupId));
    expect(groupIds.size).toBe(1);
  });
});

// ==================== Stereo → 6ch Merge ====================

describe('Stereo to 6ch Merge (3x 2ch → 6ch)', () => {
  it('should merge 3 stereo tracks into 1 6ch track with correct subChannels', () => {
    const model = new TimelineModel();
    const stereoTrackIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const t = model.addTrack(`Stereo ${i}`, '#10b981', i, 2);
      stereoTrackIds.push(t.id);
    }
    const sixChTrack = model.addTrack('6ch', '#3b82f6', 3, 6);

    // Add grouped stereo clips to each stereo track
    for (let i = 0; i < 3; i++) {
      const gid = generateGroupId();
      model.addClip(stereoTrackIds[i], createClip({
        id: `clip-s${i}-L`, subChannel: 0, groupId: gid, bufferId: `buf-s${i}-L`,
      }));
      model.addClip(stereoTrackIds[i], createClip({
        id: `clip-s${i}-R`, subChannel: 1, groupId: gid, bufferId: `buf-s${i}-R`,
      }));
    }

    const result = executeMergeAlgorithm(
      model,
      stereoTrackIds.map((tId, i) => ({ clipId: `clip-s${i}-L`, trackId: tId })),
      sixChTrack.id,
      0,
    );

    expect(result).not.toBeNull();

    // All stereo tracks empty
    for (let i = 0; i < 3; i++) {
      const st = model.timeline.tracks.find(t => t.id === stereoTrackIds[i])!;
      expect(st.clips.length).toBe(0);
    }

    // 6ch track has 6 clips with subChannels 0-5
    const qt = model.timeline.tracks.find(t => t.id === sixChTrack.id)!;
    expect(qt.clips.length).toBe(6);
    for (let i = 0; i < 6; i++) {
      expect(qt.clips.find(c => c.subChannel === i)).toBeDefined();
    }
    const groupIds = new Set(qt.clips.map(c => c.groupId));
    expect(groupIds.size).toBe(1);
  });
});

// ==================== Cross-channel target persistence (Bug 1) ====================

describe('Cross-channel drag target persistence', () => {
  /**
   * Bug 1: When _dragCrossChannelTarget is set and the renderer keeps drag.trackId
   * as source (because channels differ), the next onClipMove call has
   * sourceTrackId === targetTrackId (both source), which clears the target.
   *
   * Fix: once _dragCrossChannelTarget is set, don't clear it when
   * sourceTrackId === targetTrackId (the clip hasn't actually moved back).
   */
  it('should NOT clear cross-channel target when source === target due to deferred move', () => {
    // Simulate the fixed _dragCrossChannelTarget tracking logic
    let dragCrossChannelTarget: { targetTrackId: string; newOffset: number } | null = null;

    const tracks = [
      { id: 'quad-1', channels: 4 },
      { id: 'mono-1', channels: 1 },
      { id: 'mono-2', channels: 1 },
      { id: 'mono-3', channels: 1 },
      { id: 'mono-4', channels: 1 },
    ];

    // Simulated renderer drag.trackId (stays on source when channels differ)
    let rendererDragTrackId = 'quad-1';

    function simulateOnClipMove(
      sourceTrackId: string,
      targetTrackId: string,
      newOffset: number,
    ): void {
      if (sourceTrackId !== targetTrackId) {
        const sourceTrack = tracks.find(t => t.id === sourceTrackId);
        const targetTrack = tracks.find(t => t.id === targetTrackId);
        if (sourceTrack && targetTrack && sourceTrack.channels !== targetTrack.channels) {
          // Compatible cross-channel: set target
          dragCrossChannelTarget = { targetTrackId, newOffset };
        } else {
          dragCrossChannelTarget = null;
        }
      }
      // FIX: when sourceTrackId === targetTrackId, do NOT clear the target.
      // The clip is still on the source track because cross-channel moves are deferred.
    }

    // Move 1: quad→mono-1
    simulateOnClipMove(rendererDragTrackId, 'mono-1', 5000);
    expect(dragCrossChannelTarget).not.toBeNull();
    expect(dragCrossChannelTarget!.targetTrackId).toBe('mono-1');

    // Move 2: renderer reports source=quad-1 (unchanged), target=mono-1
    // But App sees source === target = quad-1 because renderer didn't update drag.trackId
    // With the fix, cross-channel target should persist
    simulateOnClipMove(rendererDragTrackId, 'mono-1', 5100);
    expect(dragCrossChannelTarget).not.toBeNull();
    expect(dragCrossChannelTarget!.targetTrackId).toBe('mono-1');

    // Move 3: user moves to a different mono track
    simulateOnClipMove(rendererDragTrackId, 'mono-3', 5200);
    expect(dragCrossChannelTarget).not.toBeNull();
    expect(dragCrossChannelTarget!.targetTrackId).toBe('mono-3');
  });

  it('should clear cross-channel target when user moves back to same channel count track', () => {
    let dragCrossChannelTarget: { targetTrackId: string; newOffset: number } | null = null;

    const tracks = [
      { id: 'stereo-1', channels: 2 },
      { id: 'mono-1', channels: 1 },
      { id: 'stereo-2', channels: 2 },
    ];

    let rendererDragTrackId = 'stereo-1';

    function simulateOnClipMove(
      sourceTrackId: string,
      targetTrackId: string,
      newOffset: number,
    ): void {
      if (sourceTrackId !== targetTrackId) {
        const sourceTrack = tracks.find(t => t.id === sourceTrackId);
        const targetTrack = tracks.find(t => t.id === targetTrackId);
        if (sourceTrack && targetTrack && sourceTrack.channels !== targetTrack.channels) {
          dragCrossChannelTarget = { targetTrackId, newOffset };
        } else {
          // Same channel count cross-track: clear
          dragCrossChannelTarget = null;
        }
      }
    }

    // Move to mono: cross-channel target set
    simulateOnClipMove(rendererDragTrackId, 'mono-1', 5000);
    expect(dragCrossChannelTarget).not.toBeNull();

    // Move to stereo-2: same channel count, should clear cross-channel target
    // Renderer updates drag.trackId because channels match
    rendererDragTrackId = 'stereo-2';
    simulateOnClipMove('stereo-1', 'stereo-2', 5100);
    expect(dragCrossChannelTarget).toBeNull();
  });
});

// ==================== Undo/Redo for 4ch+ operations ====================

describe('CrossTrackChannelCommand for 4ch+ operations', () => {
  it('should undo/redo quad→mono split correctly', () => {
    const { model, quadTrackId, monoTrackIds } = createQuadModel();

    const quadTrack = model.timeline.tracks.find(t => t.id === quadTrackId)!;
    const originalClips = quadTrack.clips.map(c => ({ ...c }));

    // Snapshot before
    const before = [
      { trackId: quadTrackId, clips: [...originalClips] },
      ...monoTrackIds.map(id => ({ trackId: id, clips: [] as Clip[] })),
    ];

    // Execute split
    const targetIdx = model.timeline.tracks.findIndex(t => t.id === monoTrackIds[0]);
    executeSplitAlgorithm(model, quadTrackId, targetIdx, 'clip-ch0', 0);

    // Snapshot after
    const after = [quadTrackId, ...monoTrackIds].map(tId => {
      const t = model.timeline.tracks.find(tr => tr.id === tId)!;
      return { trackId: tId, clips: t.clips.map(c => ({ ...c })) };
    });

    const cmd = new CrossTrackChannelCommand(model, before, after, 'Split quad to mono');

    // Undo should restore original state
    cmd.undo();
    expect(quadTrack.clips.length).toBe(4);
    for (const id of monoTrackIds) {
      const mt = model.timeline.tracks.find(t => t.id === id)!;
      expect(mt.clips.length).toBe(0);
    }

    // Redo should re-apply split
    cmd.execute();
    expect(quadTrack.clips.length).toBe(0);
    for (const id of monoTrackIds) {
      const mt = model.timeline.tracks.find(t => t.id === id)!;
      expect(mt.clips.length).toBe(1);
    }
  });
});
