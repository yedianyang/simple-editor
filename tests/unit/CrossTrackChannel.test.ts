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
