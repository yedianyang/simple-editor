import { Timeline, Track, Clip, CHANNEL_NAMES, CHANNEL_COLORS, TrackChannelCount } from './types';

export interface OverlapResult {
  removed: Clip[];
  trimmed: { clipId: string; before: Clip; after: Clip }[];
  added: Clip[];
}

let clipIdCounter = 0;
let trackIdCounter = 0;

/** Generate a unique group ID for linking related clips (e.g. multi-channel sub-channels). */
export function generateGroupId(): string {
  return `g-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function genClipId(): string {
  clipIdCounter++;
  return `clip_${clipIdCounter}_${Math.random().toString(36).substring(2, 8)}`;
}

function genTrackId(): string {
  trackIdCounter++;
  return `trk_${trackIdCounter}_${Math.random().toString(36).substring(2, 8)}`;
}

/**
 * CRUD operations on Timeline, Track, and Clip state.
 */
export class TimelineModel {
  timeline: Timeline = {
    sampleRate: 48000,
    totalLength: 0,
    tracks: [],
    playheadSample: 0,
    selectionStart: null,
    selectionEnd: null,
    selectedClipIds: [],
    selectedTrackIds: [],
    samplesPerPixel: 256,
    scrollOffset: 0,
  };

  createTimeline(sampleRate: number): void {
    this.timeline = {
      sampleRate,
      totalLength: 0,
      tracks: [],
      playheadSample: 0,
      selectionStart: null,
      selectionEnd: null,
      selectedClipIds: [],
      selectedTrackIds: [],
      samplesPerPixel: 256,
      scrollOffset: 0,
    };
  }

  addTrack(name: string, color: string, channelIndex: number, channels: TrackChannelCount = 1): Track {
    const track: Track = {
      id: genTrackId(),
      name,
      color,
      channels,
      clips: [],
      volume: 0,
      pan: 0,
      mute: false,
      solo: false,
      channelIndex,
      inserts: [],
      height: 80,
    };
    this.timeline.tracks.push(track);
    return track;
  }

  removeTrack(trackId: string): void {
    this.timeline.tracks = this.timeline.tracks.filter(t => t.id !== trackId);
    this.recalcTotalLength();
  }

  /** Insert a track at a specific index (used for undo restoration). */
  insertTrackAt(track: Track, index: number): void {
    const clamped = Math.max(0, Math.min(this.timeline.tracks.length, index));
    this.timeline.tracks.splice(clamped, 0, track);
    this.recalcTotalLength();
  }

  private findTrack(trackId: string): Track | undefined {
    return this.timeline.tracks.find(t => t.id === trackId);
  }

  addClip(trackId: string, clip: Clip): void {
    const track = this.findTrack(trackId);
    if (!track) return;
    track.clips.push(clip);
    this.recalcTotalLength();
  }

  removeClip(trackId: string, clipId: string): void {
    const track = this.findTrack(trackId);
    if (!track) return;
    track.clips = track.clips.filter(c => c.id !== clipId);
    this.timeline.selectedClipIds = this.timeline.selectedClipIds.filter(id => id !== clipId);
    this.recalcTotalLength();
  }

  moveClip(trackId: string, clipId: string, newOffset: number): void {
    const track = this.findTrack(trackId);
    if (!track) return;
    const clip = track.clips.find(c => c.id === clipId);
    if (!clip) return;
    clip.timelineOffset = Math.max(0, newOffset);
    this.recalcTotalLength();
  }

  moveClipToTrack(sourceTrackId: string, targetTrackId: string, clipId: string, newOffset: number): void {
    if (sourceTrackId === targetTrackId) {
      this.moveClip(sourceTrackId, clipId, newOffset);
      return;
    }
    const srcTrack = this.findTrack(sourceTrackId);
    const dstTrack = this.findTrack(targetTrackId);
    if (!srcTrack || !dstTrack) return;
    const clipIdx = srcTrack.clips.findIndex(c => c.id === clipId);
    if (clipIdx === -1) return;
    const clip = srcTrack.clips[clipIdx];
    srcTrack.clips.splice(clipIdx, 1);
    clip.timelineOffset = Math.max(0, newOffset);
    dstTrack.clips.push(clip);
    this.recalcTotalLength();
  }

  splitClip(trackId: string, clipId: string, splitSample: number): [Clip, Clip] | null {
    const track = this.findTrack(trackId);
    if (!track) return null;
    const idx = track.clips.findIndex(c => c.id === clipId);
    if (idx === -1) return null;

    const original = track.clips[idx];
    const relSplit = splitSample - original.timelineOffset;
    if (relSplit <= 0 || relSplit >= original.duration) return null;

    const clipA: Clip = {
      ...original,
      id: genClipId(),
      sourceEnd: original.sourceStart + relSplit,
      duration: relSplit,
      fadeOutSamples: 0,
    };

    const clipB: Clip = {
      ...original,
      id: genClipId(),
      timelineOffset: splitSample,
      sourceStart: original.sourceStart + relSplit,
      duration: original.duration - relSplit,
      fadeInSamples: 0,
    };

    track.clips.splice(idx, 1, clipA, clipB);
    return [clipA, clipB];
  }

  trimClipStart(trackId: string, clipId: string, newSourceStart: number): void {
    const track = this.findTrack(trackId);
    if (!track) return;
    const clip = track.clips.find(c => c.id === clipId);
    if (!clip) return;
    // Clamp to [0, sourceEnd - 1] — allows extending back towards 0
    const clamped = Math.max(0, Math.min(clip.sourceEnd - 1, newSourceStart));
    const delta = clamped - clip.sourceStart;
    if (delta === 0) return;
    clip.sourceStart = clamped;
    clip.timelineOffset += delta;
    clip.duration -= delta;
  }

  trimClipEnd(trackId: string, clipId: string, newSourceEnd: number): void {
    const track = this.findTrack(trackId);
    if (!track) return;
    const clip = track.clips.find(c => c.id === clipId);
    if (!clip) return;
    // Must be > sourceStart (caller clamps upper bound to buffer length)
    if (newSourceEnd <= clip.sourceStart) return;
    clip.sourceEnd = newSourceEnd;
    clip.duration = newSourceEnd - clip.sourceStart;
    this.recalcTotalLength();
  }

  /**
   * Import a multi-channel file.
   * For supported channel counts (1,2,4,6): creates 1 multi-channel track with N clips (each with subChannel).
   * For unsupported channel counts: falls back to N mono tracks.
   */
  importMultiChannelFile(
    bufferIds: string[],
    fileName: string,
    sampleRate: number,
    numSamples: number,
  ): void {
    const numChannels = bufferIds.length;
    const names = CHANNEL_NAMES[numChannels] ??
      Array.from({ length: numChannels }, (_, i) => `Ch ${i + 1}`);

    // Supported multi-channel counts -> single multi-ch track
    if (numChannels === 1 || numChannels === 2 || numChannels === 4 || numChannels === 5 || numChannels === 6) {
      const chCount = numChannels as TrackChannelCount;
      const track = this.addTrack(
        fileName,
        CHANNEL_COLORS[0],
        0,
        chCount,
      );

      // Multi-channel files share a groupId so sub-channel clips stay linked
      const groupId = numChannels > 1 ? generateGroupId() : undefined;

      for (let i = 0; i < numChannels; i++) {
        const clip: Clip = {
          id: genClipId(),
          bufferId: bufferIds[i],
          name: `${fileName} — ${names[i]}`,
          timelineOffset: 0,
          sourceStart: 0,
          sourceEnd: numSamples,
          duration: numSamples,
          gainDb: 0,
          fadeInSamples: 0,
          fadeOutSamples: 0,
          muted: false,
          subChannel: i,
          ...(groupId ? { groupId } : {}),
        };
        track.clips.push(clip);
      }
    } else {
      // Unsupported channel count -- fall back to N mono tracks
      for (let i = 0; i < numChannels; i++) {
        const track = this.addTrack(
          names[i],
          CHANNEL_COLORS[i % CHANNEL_COLORS.length],
          i,
        );
        const clip: Clip = {
          id: genClipId(),
          bufferId: bufferIds[i],
          name: `${fileName} — ${names[i]}`,
          timelineOffset: 0,
          sourceStart: 0,
          sourceEnd: numSamples,
          duration: numSamples,
          gainDb: 0,
          fadeInSamples: 0,
          fadeOutSamples: 0,
          muted: false,
        };
        track.clips.push(clip);
      }
    }

    this.timeline.sampleRate = sampleRate;
    this.recalcTotalLength();
  }

  /**
   * Import a multi-channel file at a specific track + time position.
   * Unlike importMultiChannelFile(), this does NOT clear existing tracks.
   * For supported multi-ch counts (2,4,5,6): creates 1 multi-ch track with N sub-channel clips.
   * For mono or unsupported counts: one track per channel (existing behavior).
   * Returns the IDs of created clips and newly created tracks (for undo).
   */
  importFileAtPosition(
    bufferIds: string[],
    fileName: string,
    sampleRate: number,
    numSamples: number,
    targetTrackIndex: number,
    sampleOffset: number,
  ): { clipIds: string[]; newTrackIds: string[] } {
    const numChannels = bufferIds.length;
    const names = CHANNEL_NAMES[numChannels] ??
      Array.from({ length: numChannels }, (_, i) => `Ch ${i + 1}`);
    const clipIds: string[] = [];
    const newTrackIds: string[] = [];

    // Supported multi-ch -> create 1 multi-ch track or reuse existing
    if ((numChannels === 2 || numChannels === 4 || numChannels === 5 || numChannels === 6)) {
      const chCount = numChannels as TrackChannelCount;
      let track: Track;

      if (targetTrackIndex < this.timeline.tracks.length) {
        track = this.timeline.tracks[targetTrackIndex];
      } else {
        track = this.addTrack(fileName, CHANNEL_COLORS[targetTrackIndex % CHANNEL_COLORS.length], targetTrackIndex, chCount);
        newTrackIds.push(track.id);
      }

      // Multi-channel files share a groupId so sub-channel clips stay linked
      const groupId = generateGroupId();

      for (let i = 0; i < numChannels; i++) {
        const clip: Clip = {
          id: genClipId(),
          bufferId: bufferIds[i],
          name: `${fileName} — ${names[i]}`,
          timelineOffset: sampleOffset,
          sourceStart: 0,
          sourceEnd: numSamples,
          duration: numSamples,
          gainDb: 0,
          fadeInSamples: 0,
          fadeOutSamples: 0,
          muted: false,
          subChannel: i,
          groupId,
        };
        track.clips.push(clip);
        clipIds.push(clip.id);
      }
    } else {
      // Mono or unsupported -- one track per channel (existing behavior)
      for (let i = 0; i < numChannels; i++) {
        const trackIndex = targetTrackIndex + i;
        let track: Track;
        if (trackIndex < this.timeline.tracks.length) {
          track = this.timeline.tracks[trackIndex];
        } else {
          track = this.addTrack(
            names[i],
            CHANNEL_COLORS[trackIndex % CHANNEL_COLORS.length],
            trackIndex,
          );
          newTrackIds.push(track.id);
        }
        const clip: Clip = {
          id: genClipId(),
          bufferId: bufferIds[i],
          name: `${fileName} — ${names[i]}`,
          timelineOffset: sampleOffset,
          sourceStart: 0,
          sourceEnd: numSamples,
          duration: numSamples,
          gainDb: 0,
          fadeInSamples: 0,
          fadeOutSamples: 0,
          muted: false,
        };
        track.clips.push(clip);
        clipIds.push(clip.id);
      }
    }

    this.recalcTotalLength();
    return { clipIds, newTrackIds };
  }

  addEmptyTrack(channels: TrackChannelCount = 1): Track {
    const idx = this.timeline.tracks.length;
    const color = CHANNEL_COLORS[idx % CHANNEL_COLORS.length];
    const typeName = channels === 1 ? '' : channels === 2 ? ' (St)' : channels === 4 ? ' (Quad)' : ' (5.1)';
    return this.addTrack(`Track ${idx + 1}${typeName}`, color, idx, channels);
  }

  getTotalLength(): number {
    return this.timeline.totalLength;
  }

  getClipsInRange(trackId: string, startSample: number, endSample: number): Clip[] {
    const track = this.findTrack(trackId);
    if (!track) return [];
    return track.clips.filter(c => {
      const clipEnd = c.timelineOffset + c.duration;
      return clipEnd > startSample && c.timelineOffset < endSample;
    });
  }

  selectClip(clipId: string): void {
    if (!this.timeline.selectedClipIds.includes(clipId)) {
      this.timeline.selectedClipIds.push(clipId);
    }
  }

  deselectAll(): void {
    this.timeline.selectedClipIds = [];
  }

  getSelectedClips(): Clip[] {
    const selected: Clip[] = [];
    for (const track of this.timeline.tracks) {
      for (const clip of track.clips) {
        if (this.timeline.selectedClipIds.includes(clip.id)) {
          selected.push(clip);
        }
      }
    }
    return selected;
  }

  toggleTrackSelection(trackId: string): void {
    const idx = this.timeline.selectedTrackIds.indexOf(trackId);
    if (idx >= 0) {
      this.timeline.selectedTrackIds.splice(idx, 1);
    } else {
      this.timeline.selectedTrackIds.push(trackId);
    }
  }

  selectAllTracks(): void {
    this.timeline.selectedTrackIds = this.timeline.tracks.map(t => t.id);
  }

  deselectAllTracks(): void {
    this.timeline.selectedTrackIds = [];
  }

  /**
   * Resolve overlaps on a track after a clip has been moved/dropped.
   * The protectedClipId takes priority — overlapping portions of other clips get trimmed or removed.
   * Returns a snapshot of all changes for undo/redo support.
   */
  resolveOverlaps(trackId: string, protectedClipId: string): OverlapResult {
    const result: OverlapResult = { removed: [], trimmed: [], added: [] };

    const track = this.findTrack(trackId);
    if (!track) return result;

    const moved = track.clips.find(c => c.id === protectedClipId);
    if (!moved) return result;

    const movedStart = moved.timelineOffset;
    const movedEnd = moved.timelineOffset + moved.duration;

    // Snapshot the clip list — we'll modify the array during iteration
    const others = track.clips.filter(c => c.id !== protectedClipId && !(moved.groupId && c.groupId === moved.groupId));

    for (const existing of others) {
      const existStart = existing.timelineOffset;
      const existEnd = existing.timelineOffset + existing.duration;

      // No overlap — skip
      if (existEnd <= movedStart || existStart >= movedEnd) continue;

      // Case 1: Fully covered — remove
      if (existStart >= movedStart && existEnd <= movedEnd) {
        result.removed.push({ ...existing });
        track.clips = track.clips.filter(c => c.id !== existing.id);
        continue;
      }

      // Case 4: Split — existing envelops the moved clip
      if (existStart < movedStart && existEnd > movedEnd) {
        const before = { ...existing };

        // Trim existing to left part
        existing.sourceEnd = existing.sourceStart + (movedStart - existStart);
        existing.duration = movedStart - existStart;
        existing.fadeOutSamples = 0;

        // Create right part
        const rightSkip = movedEnd - existStart;
        const rightClip: Clip = {
          ...before,
          id: genClipId(),
          timelineOffset: movedEnd,
          sourceStart: before.sourceStart + rightSkip,
          sourceEnd: before.sourceStart + rightSkip + (existEnd - movedEnd),
          duration: existEnd - movedEnd,
          fadeInSamples: 0,
        };
        track.clips.push(rightClip);

        result.trimmed.push({ clipId: existing.id, before, after: { ...existing } });
        result.added.push({ ...rightClip });
        continue;
      }

      // Case 2: Right overlap — existing starts before, ends inside moved range
      if (existStart < movedStart) {
        const before = { ...existing };
        existing.sourceEnd = existing.sourceStart + (movedStart - existStart);
        existing.duration = movedStart - existStart;
        existing.fadeOutSamples = 0;
        result.trimmed.push({ clipId: existing.id, before, after: { ...existing } });
        continue;
      }

      // Case 3: Left overlap — existing starts inside moved range, ends after
      if (existEnd > movedEnd) {
        const before = { ...existing };
        const samplesToTrim = movedEnd - existStart;
        existing.sourceStart += samplesToTrim;
        existing.timelineOffset = movedEnd;
        existing.duration = existEnd - movedEnd;
        existing.fadeInSamples = 0;
        result.trimmed.push({ clipId: existing.id, before, after: { ...existing } });
        continue;
      }
    }

    this.recalcTotalLength();
    return result;
  }

  /**
   * Delete a time range [startSample, endSample) from a track.
   * Clips fully inside the range are removed. Clips partially overlapping are trimmed.
   * Clips that span the entire range are split and trimmed.
   * Returns OverlapResult for undo support.
   */
  deleteTimeRange(trackId: string, startSample: number, endSample: number): OverlapResult {
    const result: OverlapResult = { removed: [], trimmed: [], added: [] };
    const track = this.findTrack(trackId);
    if (!track) return result;

    // Snapshot clips to iterate safely
    const clips = [...track.clips];

    for (const clip of clips) {
      const clipStart = clip.timelineOffset;
      const clipEnd = clip.timelineOffset + clip.duration;

      // No overlap — skip
      if (clipEnd <= startSample || clipStart >= endSample) continue;

      // Fully inside — remove
      if (clipStart >= startSample && clipEnd <= endSample) {
        result.removed.push({ ...clip });
        track.clips = track.clips.filter(c => c.id !== clip.id);
        continue;
      }

      // Spans entire range — split into left and right parts
      if (clipStart < startSample && clipEnd > endSample) {
        const before = { ...clip };

        // Trim existing clip to left part
        clip.sourceEnd = clip.sourceStart + (startSample - clipStart);
        clip.duration = startSample - clipStart;
        clip.fadeOutSamples = 0;

        // Create right part
        const rightSkip = endSample - clipStart;
        const rightClip: Clip = {
          ...before,
          id: genClipId(),
          timelineOffset: endSample,
          sourceStart: before.sourceStart + rightSkip,
          sourceEnd: before.sourceStart + rightSkip + (clipEnd - endSample),
          duration: clipEnd - endSample,
          fadeInSamples: 0,
        };
        track.clips.push(rightClip);

        result.trimmed.push({ clipId: clip.id, before, after: { ...clip } });
        result.added.push({ ...rightClip });
        continue;
      }

      // Left overlap — clip starts before range, ends inside
      if (clipStart < startSample) {
        const before = { ...clip };
        clip.sourceEnd = clip.sourceStart + (startSample - clipStart);
        clip.duration = startSample - clipStart;
        clip.fadeOutSamples = 0;
        result.trimmed.push({ clipId: clip.id, before, after: { ...clip } });
        continue;
      }

      // Right overlap — clip starts inside range, ends after
      if (clipEnd > endSample) {
        const before = { ...clip };
        const samplesToTrim = endSample - clipStart;
        clip.sourceStart += samplesToTrim;
        clip.timelineOffset = endSample;
        clip.duration = clipEnd - endSample;
        clip.fadeInSamples = 0;
        result.trimmed.push({ clipId: clip.id, before, after: { ...clip } });
        continue;
      }
    }

    this.recalcTotalLength();
    return result;
  }

  /**
   * Swap a clip's buffer to a new one (e.g. reversed or normalized version)
   * and toggle the reversed flag.
   */
  reverseClip(trackId: string, clipId: string, newBufferId: string): void {
    const track = this.findTrack(trackId);
    if (!track) return;
    const clip = track.clips.find(c => c.id === clipId);
    if (!clip) return;
    clip.bufferId = newBufferId;
    clip.reversed = !clip.reversed;
  }

  /**
   * Get sibling clips within the same track that share the same groupId.
   * Returns clips that belong to the same group, excluding the queried clip itself.
   */
  getSiblingClips(trackId: string, clipId: string): Clip[] {
    const track = this.findTrack(trackId);
    if (!track) return [];
    const clip = track.clips.find(c => c.id === clipId);
    if (!clip?.groupId) return [];
    return track.clips.filter(c => c.groupId === clip.groupId && c.id !== clipId);
  }

  /**
   * Get all clips across all tracks that share a given groupId.
   * Returns track + clip pairs for cross-track group operations.
   */
  getAllGroupClips(groupId: string): { track: Track; clip: Clip }[] {
    const results: { track: Track; clip: Clip }[] = [];
    for (const track of this.timeline.tracks) {
      for (const clip of track.clips) {
        if (clip.groupId === groupId) {
          results.push({ track, clip });
        }
      }
    }
    return results;
  }

  private recalcTotalLength(): void {
    let max = 0;
    for (const track of this.timeline.tracks) {
      for (const clip of track.clips) {
        const end = clip.timelineOffset + clip.duration;
        if (end > max) max = end;
      }
    }
    this.timeline.totalLength = max;
  }
}
