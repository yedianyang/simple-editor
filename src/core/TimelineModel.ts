import { Timeline, Track, Clip, CHANNEL_NAMES, CHANNEL_COLORS } from './types';

let clipIdCounter = 0;
let trackIdCounter = 0;

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

  addTrack(name: string, color: string, channelIndex: number): Track {
    const track: Track = {
      id: genTrackId(),
      name,
      color,
      clips: [],
      volume: 0,
      pan: 0,
      mute: false,
      solo: false,
      channelIndex,
      inserts: [],
    };
    this.timeline.tracks.push(track);
    return track;
  }

  removeTrack(trackId: string): void {
    this.timeline.tracks = this.timeline.tracks.filter(t => t.id !== trackId);
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
   * Create N tracks (one per channel) from a multi-channel file import.
   * bufferIds: one ID per channel from BufferPool.importMultiChannel().
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

    this.timeline.sampleRate = sampleRate;
    this.recalcTotalLength();
  }

  addEmptyTrack(): Track {
    const idx = this.timeline.tracks.length;
    const color = CHANNEL_COLORS[idx % CHANNEL_COLORS.length];
    return this.addTrack(`Track ${idx + 1}`, color, idx);
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
