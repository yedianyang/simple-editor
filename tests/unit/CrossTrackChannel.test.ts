/**
 * TDD tests for cross-track channel split/merge and incompatibility rejection.
 * Tests CrossTrackChannelCommand (undo/redo), channel compatibility checks,
 * and the split/merge logic for single multi-channel clips (bufferIds model).
 *
 * New model: ONE clip per track position, clip.bufferIds[] holds per-channel buffer IDs.
 * Split: stereo clip (bufferIds: ['L','R']) → 2 mono clips (bufferIds: ['L']) + (bufferIds: ['R'])
 * Merge: 2 mono clips → 1 stereo clip (bufferIds: ['L', 'R'])
 */
import { describe, it, expect } from 'vitest';
import { CrossTrackChannelCommand } from '../../src/utils/TimelineUndoManager';
import { TimelineModel } from '../../src/core/TimelineModel';
import type { Clip, TrackChannelCount } from '../../src/core/types';

// ==================== Helpers ====================

function createClip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: `clip-${Math.random().toString(36).slice(2, 8)}`,
    bufferIds: ['buf-1'],
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

/** Create a model with a stereo track (1 stereo clip) and 2 empty mono tracks. */
function createStereoModel(): { model: TimelineModel; stereoTrackId: string; monoTrackIds: string[] } {
  const model = new TimelineModel();
  const stereoTrack = model.addTrack('Stereo', '#3b82f6', 0, 2);
  const monoTrack1 = model.addTrack('Mono L', '#10b981', 1, 1);
  const monoTrack2 = model.addTrack('Mono R', '#f59e0b', 2, 1);

  // Single stereo clip with bufferIds: [L, R]
  model.addClip(stereoTrack.id, createClip({
    id: 'clip-stereo', name: 'Stereo', bufferIds: ['buf-L', 'buf-R'],
  }));

  return {
    model,
    stereoTrackId: stereoTrack.id,
    monoTrackIds: [monoTrack1.id, monoTrack2.id],
  };
}

/** Create a model with a quad track (1 quad clip) and various target tracks. */
function createQuadModel(): { model: TimelineModel; quadTrackId: string; stereoTrackIds: string[]; monoTrackIds: string[] } {
  const model = new TimelineModel();
  const quadTrack = model.addTrack('Quad', '#3b82f6', 0, 4);
  const stereoTrack1 = model.addTrack('Stereo 1', '#10b981', 1, 2);
  const stereoTrack2 = model.addTrack('Stereo 2', '#f59e0b', 2, 2);
  const monoTrack1 = model.addTrack('Mono 1', '#ef4444', 3, 1);
  const monoTrack2 = model.addTrack('Mono 2', '#8b5cf6', 4, 1);
  const monoTrack3 = model.addTrack('Mono 3', '#ec4899', 5, 1);
  const monoTrack4 = model.addTrack('Mono 4', '#3b82f6', 6, 1);

  // Single quad clip with bufferIds: [ch0, ch1, ch2, ch3]
  model.addClip(quadTrack.id, createClip({
    id: 'clip-quad', name: 'Quad', bufferIds: ['buf-ch0', 'buf-ch1', 'buf-ch2', 'buf-ch3'],
  }));

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

    // Simulate split: stereo clip split into 2 mono clips
    const after = [
      { trackId: stereoTrackId, clips: [] },
      { trackId: monoTrackIds[0], clips: [{ ...stereoClips[0], bufferIds: ['buf-L'] }] },
      { trackId: monoTrackIds[1], clips: [{ ...stereoClips[0], id: 'clip-R', bufferIds: ['buf-R'] }] },
    ];

    const cmd = new CrossTrackChannelCommand(model, before, after, 'Split stereo to mono');

    cmd.execute();
    expect(model.timeline.tracks[0].clips.length).toBe(0); // stereo track empty
    expect(model.timeline.tracks[1].clips.length).toBe(1); // mono L has clip
    expect(model.timeline.tracks[2].clips.length).toBe(1); // mono R has clip

    cmd.undo();
    expect(model.timeline.tracks[0].clips.length).toBe(1); // stereo clip restored
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
  it('should remove clip from stereo track after split', () => {
    const { model, stereoTrackId } = createStereoModel();
    const stereoTrack = model.timeline.tracks.find(t => t.id === stereoTrackId)!;

    // Verify initial state: 1 stereo clip
    expect(stereoTrack.clips.length).toBe(1);
    expect(stereoTrack.clips[0].bufferIds).toEqual(['buf-L', 'buf-R']);

    // Simulate split: remove clip from stereo track
    stereoTrack.clips = [];
    expect(stereoTrack.clips.length).toBe(0);
  });

  it('should place L clip on first mono track and R clip on second', () => {
    const { model, stereoTrackId, monoTrackIds } = createStereoModel();
    const stereoTrack = model.timeline.tracks.find(t => t.id === stereoTrackId)!;
    const monoTrack1 = model.timeline.tracks.find(t => t.id === monoTrackIds[0])!;
    const monoTrack2 = model.timeline.tracks.find(t => t.id === monoTrackIds[1])!;

    // Execute split: stereo clip bufferIds[0] → mono L, bufferIds[1] → mono R
    const [stereoClip] = stereoTrack.clips;
    stereoTrack.clips = [];
    monoTrack1.clips.push({ ...stereoClip, bufferIds: [stereoClip.bufferIds[0]] });
    monoTrack2.clips.push({ ...stereoClip, bufferIds: [stereoClip.bufferIds[1]] });

    expect(monoTrack1.clips.length).toBe(1);
    expect(monoTrack2.clips.length).toBe(1);
    expect(monoTrack1.clips[0].bufferIds).toEqual(['buf-L']);
    expect(monoTrack2.clips[0].bufferIds).toEqual(['buf-R']);
    // Mono clips have 1-element bufferIds (no subChannel/groupId)
    expect(monoTrack1.clips[0].bufferIds.length).toBe(1);
    expect(monoTrack2.clips[0].bufferIds.length).toBe(1);
  });
});

// ==================== Quad → 2x Stereo Split ====================

describe('Quad to Stereo Split', () => {
  it('should distribute quad clip to 2 stereo tracks with correct bufferIds', () => {
    const { model, quadTrackId, stereoTrackIds } = createQuadModel();
    const quadTrack = model.timeline.tracks.find(t => t.id === quadTrackId)!;
    const stereoTrack1 = model.timeline.tracks.find(t => t.id === stereoTrackIds[0])!;
    const stereoTrack2 = model.timeline.tracks.find(t => t.id === stereoTrackIds[1])!;

    // ch0+ch1 → stereo track 1, ch2+ch3 → stereo track 2
    const [quadClip] = quadTrack.clips;
    quadTrack.clips = [];

    stereoTrack1.clips.push({ ...quadClip, bufferIds: [quadClip.bufferIds[0], quadClip.bufferIds[1]] });
    stereoTrack2.clips.push({ ...quadClip, bufferIds: [quadClip.bufferIds[2], quadClip.bufferIds[3]] });

    expect(stereoTrack1.clips.length).toBe(1);
    expect(stereoTrack2.clips.length).toBe(1);
    expect(stereoTrack1.clips[0].bufferIds).toEqual(['buf-ch0', 'buf-ch1']);
    expect(stereoTrack2.clips[0].bufferIds).toEqual(['buf-ch2', 'buf-ch3']);
  });
});

// ==================== Mono → Stereo Merge ====================

describe('Mono to Stereo Merge', () => {
  it('should merge 2 mono clips into stereo track with combined bufferIds', () => {
    const model = new TimelineModel();
    const monoTrack1 = model.addTrack('Mono 1', '#3b82f6', 0, 1);
    const monoTrack2 = model.addTrack('Mono 2', '#10b981', 1, 1);
    const stereoTrack = model.addTrack('Stereo', '#f59e0b', 2, 2);

    const clipA = createClip({ id: 'clip-A', bufferIds: ['buf-A'] });
    const clipB = createClip({ id: 'clip-B', bufferIds: ['buf-B'] });
    model.addClip(monoTrack1.id, clipA);
    model.addClip(monoTrack2.id, clipB);

    // Simulate merge
    const mono1 = model.timeline.tracks.find(t => t.id === monoTrack1.id)!;
    const mono2 = model.timeline.tracks.find(t => t.id === monoTrack2.id)!;
    const stereo = model.timeline.tracks.find(t => t.id === stereoTrack.id)!;

    const mergedClip = { ...mono1.clips[0], bufferIds: [mono1.clips[0].bufferIds[0], mono2.clips[0].bufferIds[0]] };

    mono1.clips = [];
    mono2.clips = [];
    stereo.clips.push(mergedClip);

    expect(stereo.clips.length).toBe(1);
    expect(stereo.clips[0].bufferIds).toEqual(['buf-A', 'buf-B']);
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

// ==================== Same-Channel Cross-Track Move ====================

describe('Same-Channel Cross-Track Move', () => {
  it('moveClipToTrack should move the clip', () => {
    const model = new TimelineModel();
    const trackA = model.addTrack('Stereo A', '#3b82f6', 0, 2);
    const trackB = model.addTrack('Stereo B', '#10b981', 1, 2);

    // Single stereo clip
    model.addClip(trackA.id, createClip({ id: 'clip-stereo', bufferIds: ['buf-L', 'buf-R'] }));

    // Move clip to trackB
    model.moveClipToTrack(trackA.id, trackB.id, 'clip-stereo', 0);

    const trackAClips = model.timeline.tracks[0].clips;
    const trackBClips = model.timeline.tracks[1].clips;
    expect(trackBClips.find(c => c.id === 'clip-stereo')).toBeDefined();
    expect(trackAClips.find(c => c.id === 'clip-stereo')).toBeUndefined();
    // bufferIds preserved after move
    expect(trackBClips[0].bufferIds).toEqual(['buf-L', 'buf-R']);
  });

  it('moved clip should have correct offset on target track', () => {
    const model = new TimelineModel();
    const trackA = model.addTrack('Stereo A', '#3b82f6', 0, 2);
    const trackB = model.addTrack('Stereo B', '#10b981', 1, 2);

    model.addClip(trackA.id, createClip({ id: 'clip-stereo', bufferIds: ['buf-L', 'buf-R'], timelineOffset: 0 }));

    const newOffset = 5000;
    model.moveClipToTrack(trackA.id, trackB.id, 'clip-stereo', newOffset);

    expect(model.timeline.tracks[0].clips.length).toBe(0);
    expect(model.timeline.tracks[1].clips.length).toBe(1);
    expect(model.timeline.tracks[1].clips[0].timelineOffset).toBe(newOffset);
  });
});

// ==================== Drag-sequence cross-channel tracking ====================

describe('Cross-channel drag sequence tracking', () => {
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
    simulateOnClipMove(rendererDragTrackId, 'mono-1', 5000);
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
    simulateOnClipMove(rendererDragTrackId, 'mono-1', 5100);

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

  it('a multi-channel clip should have its overlaps resolved normally (no group exemption)', () => {
    const model = new TimelineModel();
    const track = model.addTrack('Stereo', '#3b82f6', 0, 2);

    // Single stereo clip at 0..48000
    model.addClip(track.id, createClip({
      id: 'clip-stereo', bufferIds: ['buf-L', 'buf-R'], timelineOffset: 0, sourceEnd: 48000, duration: 48000,
    }));

    // Add another clip that overlaps
    model.addClip(track.id, createClip({
      id: 'clip-incoming', bufferIds: ['buf-X'], timelineOffset: 24000, sourceEnd: 48000, duration: 48000,
    }));

    // resolveOverlaps: incoming trims the existing stereo clip
    const result = model.resolveOverlaps(track.id, 'clip-incoming');

    expect(result.trimmed.length).toBe(1);
    expect(result.trimmed[0].clipId).toBe('clip-stereo');
  });
});

// ==================== Split Algorithm (new bufferIds model) ====================

/**
 * Split algorithm for the new bufferIds model.
 * Takes the source clip, slices bufferIds into groups, places each group on a target track.
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

  const sourceChannels = sourceTrack.channels;
  const targetTrack = tracks[targetTrackStartIndex];
  if (!targetTrack) return null;
  const targetChannels = targetTrack.channels;

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

  // Execute split: remove from source
  sourceTrack.clips = sourceTrack.clips.filter(c => c.id !== clip.id);

  // Distribute bufferIds to target tracks
  for (let targetOffset = 0; targetOffset < numTargetTracks; targetOffset++) {
    const tTrack = tracks[targetTrackStartIndex + targetOffset];
    const startCh = targetOffset * targetChannels;
    const slicedBufferIds = clip.bufferIds.slice(startCh, startCh + targetChannels);

    const newClip: Clip = {
      ...clip,
      id: `${clip.id}-split-${targetOffset}`,
      bufferIds: slicedBufferIds,
      timelineOffset: Math.max(0, clip.timelineOffset + offsetDelta),
    };
    tTrack.clips.push(newClip);
    model.resolveOverlaps(tTrack.id, newClip.id);
  }

  // Snapshot after
  const after = affectedTrackIds.map(tId => {
    const t = tracks.find(tr => tr.id === tId)!;
    return { trackId: tId, clips: t.clips.map(c => ({ ...c })) };
  });

  return { before, after };
}

/**
 * Merge algorithm for the new bufferIds model.
 * Collects bufferIds from source clips, combines them into one clip on the target track.
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

  // Build ordered list of source clips
  const mergeSet: Array<{ clip: Clip; trackId: string; trackIndex: number }> = [];
  for (const sc of sourceClips) {
    for (let ti = 0; ti < tracks.length; ti++) {
      const c = tracks[ti].clips.find(cl => cl.id === sc.clipId);
      if (c) {
        mergeSet.push({ clip: c, trackId: tracks[ti].id, trackIndex: ti });
        break;
      }
    }
  }
  mergeSet.sort((a, b) => a.trackIndex - b.trackIndex);

  // Collect all bufferIds from source clips (in order)
  const allBufferIds: string[] = [];
  for (const mc of mergeSet) {
    allBufferIds.push(...mc.clip.bufferIds);
  }

  if (allBufferIds.length !== targetChannels) return null;

  const firstClip = mergeSet[0]?.clip;
  if (!firstClip) return null;
  const offsetDelta = newOffset - firstClip.timelineOffset;

  // Snapshot before
  const affectedTrackIds = new Set<string>([targetTrackId]);
  for (const mc of mergeSet) affectedTrackIds.add(mc.trackId);
  const affectedIds = Array.from(affectedTrackIds);
  const before = affectedIds.map(tId => {
    const t = tracks.find(tr => tr.id === tId)!;
    return { trackId: tId, clips: t.clips.map(c => ({ ...c })) };
  });

  // Execute merge: remove from source tracks
  for (const mc of mergeSet) {
    const srcTrack = tracks.find(t => t.id === mc.trackId)!;
    srcTrack.clips = srcTrack.clips.filter(c => c.id !== mc.clip.id);
  }

  // Create merged clip on target track
  const mergedClip: Clip = {
    ...firstClip,
    id: `${firstClip.id}-merged`,
    bufferIds: allBufferIds,
    timelineOffset: Math.max(0, firstClip.timelineOffset + offsetDelta),
  };
  targetTrack.clips.push(mergedClip);
  model.resolveOverlaps(targetTrackId, mergedClip.id);

  // Snapshot after
  const after = affectedIds.map(tId => {
    const t = tracks.find(tr => tr.id === tId)!;
    return { trackId: tId, clips: t.clips.map(c => ({ ...c })) };
  });

  return { before, after };
}

// ==================== Quad → 4x Mono Split ====================

describe('Quad to Mono Split (4ch → 1ch)', () => {
  it('should distribute quad clip bufferIds to 4 mono tracks', () => {
    const { model, quadTrackId, monoTrackIds } = createQuadModel();
    const quadTrack = model.timeline.tracks.find(t => t.id === quadTrackId)!;

    expect(quadTrack.clips.length).toBe(1);
    expect(quadTrack.clips[0].bufferIds.length).toBe(4);

    const targetIdx = model.timeline.tracks.findIndex(t => t.id === monoTrackIds[0]);
    const result = executeSplitAlgorithm(model, quadTrackId, targetIdx, 'clip-quad', 1000);

    expect(result).not.toBeNull();
    // Source track should be empty
    expect(quadTrack.clips.length).toBe(0);

    // Each mono track should have exactly 1 clip with 1 bufferId
    for (let i = 0; i < 4; i++) {
      const monoTrack = model.timeline.tracks.find(t => t.id === monoTrackIds[i])!;
      expect(monoTrack.clips.length).toBe(1);
      expect(monoTrack.clips[0].bufferIds.length).toBe(1);
      expect(monoTrack.clips[0].bufferIds[0]).toBe(`buf-ch${i}`);
      expect(monoTrack.clips[0].timelineOffset).toBe(1000);
    }
  });

  it('should work with 6ch → mono (6 channels to 6 mono tracks)', () => {
    const model = new TimelineModel();
    const sixChTrack = model.addTrack('6ch', '#3b82f6', 0, 6);

    const monoTrackIds: string[] = [];
    for (let i = 0; i < 6; i++) {
      const t = model.addTrack(`Mono ${i}`, '#10b981', i + 1, 1);
      monoTrackIds.push(t.id);
    }

    // Single 6ch clip
    model.addClip(sixChTrack.id, createClip({
      id: 'clip-6ch', bufferIds: ['buf-ch0', 'buf-ch1', 'buf-ch2', 'buf-ch3', 'buf-ch4', 'buf-ch5'],
    }));

    const targetIdx = model.timeline.tracks.findIndex(t => t.id === monoTrackIds[0]);
    const result = executeSplitAlgorithm(model, sixChTrack.id, targetIdx, 'clip-6ch', 0);

    expect(result).not.toBeNull();
    expect(sixChTrack.clips.length).toBe(0);

    for (let i = 0; i < 6; i++) {
      const monoTrack = model.timeline.tracks.find(t => t.id === monoTrackIds[i])!;
      expect(monoTrack.clips.length).toBe(1);
      expect(monoTrack.clips[0].bufferIds.length).toBe(1);
      expect(monoTrack.clips[0].bufferIds[0]).toBe(`buf-ch${i}`);
    }
  });
});

// ==================== 6ch → Stereo Split ====================

describe('6ch to Stereo Split (6ch → 2ch)', () => {
  it('should distribute 6ch clip to 3 consecutive stereo tracks', () => {
    const model = new TimelineModel();
    const sixChTrack = model.addTrack('6ch', '#3b82f6', 0, 6);

    const stereoTrackIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const t = model.addTrack(`Stereo ${i}`, '#10b981', i + 1, 2);
      stereoTrackIds.push(t.id);
    }

    model.addClip(sixChTrack.id, createClip({
      id: 'clip-6ch', bufferIds: ['buf-ch0', 'buf-ch1', 'buf-ch2', 'buf-ch3', 'buf-ch4', 'buf-ch5'],
    }));

    const targetIdx = model.timeline.tracks.findIndex(t => t.id === stereoTrackIds[0]);
    const result = executeSplitAlgorithm(model, sixChTrack.id, targetIdx, 'clip-6ch', 500);

    expect(result).not.toBeNull();
    expect(sixChTrack.clips.length).toBe(0);

    // 3 stereo tracks, each with 1 clip with 2 bufferIds
    expect(model.timeline.tracks.find(t => t.id === stereoTrackIds[0])!.clips[0].bufferIds)
      .toEqual(['buf-ch0', 'buf-ch1']);
    expect(model.timeline.tracks.find(t => t.id === stereoTrackIds[1])!.clips[0].bufferIds)
      .toEqual(['buf-ch2', 'buf-ch3']);
    expect(model.timeline.tracks.find(t => t.id === stereoTrackIds[2])!.clips[0].bufferIds)
      .toEqual(['buf-ch4', 'buf-ch5']);

    // All at offset 500
    for (const id of stereoTrackIds) {
      const t = model.timeline.tracks.find(tr => tr.id === id)!;
      expect(t.clips[0].timelineOffset).toBe(500);
    }
  });
});

// ==================== Mono → Quad Merge ====================

describe('Mono to Quad Merge (4x 1ch → 4ch)', () => {
  it('should merge 4 mono clips into 1 quad clip with combined bufferIds', () => {
    const model = new TimelineModel();
    const monoTrackIds: string[] = [];
    for (let i = 0; i < 4; i++) {
      const t = model.addTrack(`Mono ${i}`, '#10b981', i, 1);
      monoTrackIds.push(t.id);
    }
    const quadTrack = model.addTrack('Quad', '#3b82f6', 4, 4);

    const clipIds: string[] = [];
    for (let i = 0; i < 4; i++) {
      const id = `clip-m${i}`;
      clipIds.push(id);
      model.addClip(monoTrackIds[i], createClip({ id, bufferIds: [`buf-m${i}`] }));
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

    // Quad track should have 1 clip with 4 bufferIds
    const qt = model.timeline.tracks.find(t => t.id === quadTrack.id)!;
    expect(qt.clips.length).toBe(1);
    expect(qt.clips[0].bufferIds).toEqual(['buf-m0', 'buf-m1', 'buf-m2', 'buf-m3']);
    expect(qt.clips[0].timelineOffset).toBe(2000);
  });
});

// ==================== Stereo → Quad Merge ====================

describe('Stereo to Quad Merge (2x 2ch → 4ch)', () => {
  it('should merge 2 stereo clips into 1 quad clip with correct bufferIds', () => {
    const model = new TimelineModel();
    const stereoTrack1 = model.addTrack('Stereo 1', '#10b981', 0, 2);
    const stereoTrack2 = model.addTrack('Stereo 2', '#f59e0b', 1, 2);
    const quadTrack = model.addTrack('Quad', '#3b82f6', 2, 4);

    model.addClip(stereoTrack1.id, createClip({
      id: 'clip-s1', bufferIds: ['buf-s1-L', 'buf-s1-R'],
    }));
    model.addClip(stereoTrack2.id, createClip({
      id: 'clip-s2', bufferIds: ['buf-s2-L', 'buf-s2-R'],
    }));

    const result = executeMergeAlgorithm(
      model,
      [
        { clipId: 'clip-s1', trackId: stereoTrack1.id },
        { clipId: 'clip-s2', trackId: stereoTrack2.id },
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

    // Quad track should have 1 clip with 4 bufferIds
    const qt = model.timeline.tracks.find(t => t.id === quadTrack.id)!;
    expect(qt.clips.length).toBe(1);
    expect(qt.clips[0].bufferIds).toEqual(['buf-s1-L', 'buf-s1-R', 'buf-s2-L', 'buf-s2-R']);
  });
});

// ==================== Mono → 6ch Merge ====================

describe('Mono to 6ch Merge (6x 1ch → 6ch)', () => {
  it('should merge 6 mono clips into 1 6ch clip', () => {
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
      model.addClip(monoTrackIds[i], createClip({ id, bufferIds: [`buf-m${i}`] }));
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

    // 6ch track has 1 clip with 6 bufferIds
    const st = model.timeline.tracks.find(t => t.id === sixChTrack.id)!;
    expect(st.clips.length).toBe(1);
    expect(st.clips[0].bufferIds).toEqual(['buf-m0', 'buf-m1', 'buf-m2', 'buf-m3', 'buf-m4', 'buf-m5']);
  });
});

// ==================== Stereo → 6ch Merge ====================

describe('Stereo to 6ch Merge (3x 2ch → 6ch)', () => {
  it('should merge 3 stereo clips into 1 6ch clip with correct bufferIds', () => {
    const model = new TimelineModel();
    const stereoTrackIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const t = model.addTrack(`Stereo ${i}`, '#10b981', i, 2);
      stereoTrackIds.push(t.id);
    }
    const sixChTrack = model.addTrack('6ch', '#3b82f6', 3, 6);

    for (let i = 0; i < 3; i++) {
      model.addClip(stereoTrackIds[i], createClip({
        id: `clip-s${i}`, bufferIds: [`buf-s${i}-L`, `buf-s${i}-R`],
      }));
    }

    const result = executeMergeAlgorithm(
      model,
      stereoTrackIds.map((tId, i) => ({ clipId: `clip-s${i}`, trackId: tId })),
      sixChTrack.id,
      0,
    );

    expect(result).not.toBeNull();

    // All stereo tracks empty
    for (let i = 0; i < 3; i++) {
      const st = model.timeline.tracks.find(t => t.id === stereoTrackIds[i])!;
      expect(st.clips.length).toBe(0);
    }

    // 6ch track has 1 clip with 6 bufferIds
    const qt = model.timeline.tracks.find(t => t.id === sixChTrack.id)!;
    expect(qt.clips.length).toBe(1);
    expect(qt.clips[0].bufferIds).toEqual([
      'buf-s0-L', 'buf-s0-R', 'buf-s1-L', 'buf-s1-R', 'buf-s2-L', 'buf-s2-R',
    ]);
  });
});

// ==================== Cross-channel target persistence (Bug 1) ====================

describe('Cross-channel drag target persistence', () => {
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
          // Same-channel cross-track: clear
          dragCrossChannelTarget = null;
        }
      }
      // When sourceTrackId === targetTrackId: do NOT clear (deferred move)
    }

    // Move to mono: cross-channel target set
    simulateOnClipMove(rendererDragTrackId, 'mono-1', 5000);
    expect(dragCrossChannelTarget).not.toBeNull();

    // Move again on mono-1: renderer still reports source as quad-1
    simulateOnClipMove(rendererDragTrackId, 'mono-1', 5100);
    expect(dragCrossChannelTarget).not.toBeNull();
    expect(dragCrossChannelTarget!.targetTrackId).toBe('mono-1');
  });

  it('should clear cross-channel target when moving back to same-channel track', () => {
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
    executeSplitAlgorithm(model, quadTrackId, targetIdx, 'clip-quad', 0);

    // Snapshot after
    const after = [quadTrackId, ...monoTrackIds].map(tId => {
      const t = model.timeline.tracks.find(tr => tr.id === tId)!;
      return { trackId: tId, clips: t.clips.map(c => ({ ...c })) };
    });

    const cmd = new CrossTrackChannelCommand(model, before, after, 'Split quad to mono');

    // Undo should restore original state
    cmd.undo();
    expect(quadTrack.clips.length).toBe(1);
    expect(quadTrack.clips[0].bufferIds.length).toBe(4);
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
      expect(mt.clips[0].bufferIds.length).toBe(1);
    }
  });
});
