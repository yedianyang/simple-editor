import { Clip, CuePoint, Track } from '../core/types';
import { TimelineModel, OverlapResult } from '../core/TimelineModel';
import { CuePointManager } from '../editor/CuePointManager';

export interface TimelineCommand {
  execute(): void;
  undo(): void;
  description: string;
}

/**
 * Command-pattern undo/redo manager for timeline operations.
 */
export class TimelineUndoManager {
  private undoStack: TimelineCommand[] = [];
  private redoStack: TimelineCommand[] = [];
  private maxSize = 50;

  push(command: TimelineCommand): void {
    command.execute();
    this.undoStack.push(command);
    if (this.undoStack.length > this.maxSize) {
      this.undoStack.shift();
    }
    this.redoStack = [];
  }

  undo(): void {
    const command = this.undoStack.pop();
    if (!command) return;
    command.undo();
    this.redoStack.push(command);
  }

  redo(): void {
    const command = this.redoStack.pop();
    if (!command) return;
    command.execute();
    this.undoStack.push(command);
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Push a command that has already been executed (no execute() call). */
  pushExecuted(command: TimelineCommand): void {
    this.undoStack.push(command);
    if (this.undoStack.length > this.maxSize) {
      this.undoStack.shift();
    }
    this.redoStack = [];
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }
}

// ==================== Concrete Commands ====================

export class MoveClipCommand implements TimelineCommand {
  description: string;
  private prevOffset: number;

  constructor(
    private model: TimelineModel,
    private trackId: string,
    private clipId: string,
    private newOffset: number,
  ) {
    this.prevOffset = 0;
    this.description = `Move clip to ${newOffset}`;
  }

  execute(): void {
    const clip = this.findClip();
    if (clip) this.prevOffset = clip.timelineOffset;
    this.model.moveClip(this.trackId, this.clipId, this.newOffset);
  }

  undo(): void {
    this.model.moveClip(this.trackId, this.clipId, this.prevOffset);
  }

  private findClip(): Clip | undefined {
    const track = this.model.timeline.tracks.find(t => t.id === this.trackId);
    return track?.clips.find(c => c.id === this.clipId);
  }
}

export class MoveClipToTrackCommand implements TimelineCommand {
  description: string;
  private prevTrackId: string;
  private prevOffset: number;

  constructor(
    private model: TimelineModel,
    private sourceTrackId: string,
    private targetTrackId: string,
    private clipId: string,
    private newOffset: number,
  ) {
    this.prevTrackId = sourceTrackId;
    this.prevOffset = 0;
    this.description = `Move clip to track`;
  }

  execute(): void {
    const clip = this.findClip(this.prevTrackId);
    if (clip) this.prevOffset = clip.timelineOffset;
    this.model.moveClipToTrack(this.prevTrackId, this.targetTrackId, this.clipId, this.newOffset);
    this.prevTrackId = this.sourceTrackId;
  }

  undo(): void {
    this.model.moveClipToTrack(this.targetTrackId, this.sourceTrackId, this.clipId, this.prevOffset);
  }

  private findClip(trackId: string): Clip | undefined {
    const track = this.model.timeline.tracks.find(t => t.id === trackId);
    return track?.clips.find(c => c.id === this.clipId);
  }
}

export class SplitClipCommand implements TimelineCommand {
  description: string;
  private originalClip: Clip | null = null;
  private resultClips: [Clip, Clip] | null = null;

  constructor(
    private model: TimelineModel,
    private trackId: string,
    private clipId: string,
    private splitSample: number,
  ) {
    this.description = `Split clip at ${splitSample}`;
  }

  execute(): void {
    if (this.originalClip && this.resultClips) {
      // Re-execute: remove the original, add the two halves back
      const track = this.model.timeline.tracks.find(t => t.id === this.trackId);
      if (!track) return;
      track.clips = track.clips.filter(c => c.id !== this.originalClip!.id);
      track.clips.push({ ...this.resultClips[0] }, { ...this.resultClips[1] });
      return;
    }
    // First execute
    const track = this.model.timeline.tracks.find(t => t.id === this.trackId);
    const clip = track?.clips.find(c => c.id === this.clipId);
    if (clip) this.originalClip = { ...clip };
    this.resultClips = this.model.splitClip(this.trackId, this.clipId, this.splitSample);
  }

  undo(): void {
    if (!this.originalClip || !this.resultClips) return;
    const track = this.model.timeline.tracks.find(t => t.id === this.trackId);
    if (!track) return;
    track.clips = track.clips.filter(
      c => c.id !== this.resultClips![0].id && c.id !== this.resultClips![1].id,
    );
    track.clips.push({ ...this.originalClip });
  }
}

export class DeleteClipCommand implements TimelineCommand {
  description: string;
  private deletedClip: Clip | null = null;

  constructor(
    private model: TimelineModel,
    private trackId: string,
    private clipId: string,
  ) {
    this.description = `Delete clip`;
  }

  execute(): void {
    const track = this.model.timeline.tracks.find(t => t.id === this.trackId);
    const clip = track?.clips.find(c => c.id === this.clipId);
    if (clip) this.deletedClip = { ...clip };
    this.model.removeClip(this.trackId, this.clipId);
  }

  undo(): void {
    if (!this.deletedClip) return;
    this.model.addClip(this.trackId, { ...this.deletedClip });
  }
}

export class TrimClipCommand implements TimelineCommand {
  description: string;
  private prevSourceStart: number = 0;
  private prevSourceEnd: number = 0;
  private prevOffset: number = 0;
  private prevDuration: number = 0;

  constructor(
    private model: TimelineModel,
    private trackId: string,
    private clipId: string,
    private side: 'start' | 'end',
    private newValue: number,
  ) {
    this.description = `Trim clip ${side}`;
  }

  execute(): void {
    const clip = this.findClip();
    if (clip) {
      this.prevSourceStart = clip.sourceStart;
      this.prevSourceEnd = clip.sourceEnd;
      this.prevOffset = clip.timelineOffset;
      this.prevDuration = clip.duration;
    }
    if (this.side === 'start') {
      this.model.trimClipStart(this.trackId, this.clipId, this.newValue);
    } else {
      this.model.trimClipEnd(this.trackId, this.clipId, this.newValue);
    }
  }

  undo(): void {
    const clip = this.findClip();
    if (!clip) return;
    clip.sourceStart = this.prevSourceStart;
    clip.sourceEnd = this.prevSourceEnd;
    clip.timelineOffset = this.prevOffset;
    clip.duration = this.prevDuration;
  }

  private findClip(): Clip | undefined {
    const track = this.model.timeline.tracks.find(t => t.id === this.trackId);
    return track?.clips.find(c => c.id === this.clipId);
  }
}

export class ResolveOverlapsCommand implements TimelineCommand {
  description = 'Resolve clip overlaps';
  private result: {
    removed: Clip[];
    trimmed: { clipId: string; before: Clip; after: Clip }[];
    added: Clip[];
  } | null = null;

  constructor(
    private model: TimelineModel,
    private trackId: string,
    private protectedClipId: string,
  ) {}

  execute(): void {
    if (this.result) {
      // Redo: replay stored changes
      const track = this.model.timeline.tracks.find(t => t.id === this.trackId);
      if (!track) return;

      for (const removed of this.result.removed) {
        track.clips = track.clips.filter(c => c.id !== removed.id);
      }
      for (const { clipId, after } of this.result.trimmed) {
        const clip = track.clips.find(c => c.id === clipId);
        if (clip) {
          clip.sourceStart = after.sourceStart;
          clip.sourceEnd = after.sourceEnd;
          clip.timelineOffset = after.timelineOffset;
          clip.duration = after.duration;
          clip.fadeInSamples = after.fadeInSamples;
          clip.fadeOutSamples = after.fadeOutSamples;
        }
      }
      for (const added of this.result.added) {
        track.clips.push({ ...added });
      }
      return;
    }
    // First execute
    this.result = this.model.resolveOverlaps(this.trackId, this.protectedClipId);
  }

  undo(): void {
    if (!this.result) return;
    const track = this.model.timeline.tracks.find(t => t.id === this.trackId);
    if (!track) return;

    // Remove added clips (from splits)
    for (const added of this.result.added) {
      track.clips = track.clips.filter(c => c.id !== added.id);
    }

    // Restore trimmed clips to original state
    for (const { clipId, before } of this.result.trimmed) {
      const clip = track.clips.find(c => c.id === clipId);
      if (clip) {
        clip.sourceStart = before.sourceStart;
        clip.sourceEnd = before.sourceEnd;
        clip.timelineOffset = before.timelineOffset;
        clip.duration = before.duration;
        clip.fadeInSamples = before.fadeInSamples;
        clip.fadeOutSamples = before.fadeOutSamples;
      }
    }

    // Restore removed clips
    for (const removed of this.result.removed) {
      track.clips.push({ ...removed });
    }
  }
}

/**
 * Single undoable command for an entire clip drag operation (move, trim, or both).
 * Combines the clip state change + overlap resolution into one undo step.
 * Created AFTER the drag is applied — use pushExecuted() to add to the undo stack.
 */
export class ClipDragCommand implements TimelineCommand {
  description: string;

  constructor(
    private model: TimelineModel,
    private clipId: string,
    private originalTrackId: string,
    private finalTrackId: string,
    private originalState: Clip,
    private finalState: Clip,
    private overlapResult: OverlapResult | null,
  ) {
    this.description = originalTrackId === finalTrackId ? 'Drag clip' : 'Drag clip to track';
  }

  execute(): void {
    // Redo: restore to final state
    if (this.originalTrackId !== this.finalTrackId) {
      // Cross-track: move clip from original track to final track
      const src = this.model.timeline.tracks.find(t => t.id === this.originalTrackId);
      const dst = this.model.timeline.tracks.find(t => t.id === this.finalTrackId);
      if (src && dst) {
        src.clips = src.clips.filter(c => c.id !== this.clipId);
        dst.clips.push({ ...this.finalState });
      }
    } else {
      const track = this.model.timeline.tracks.find(t => t.id === this.finalTrackId);
      const clip = track?.clips.find(c => c.id === this.clipId);
      if (clip) this.applyClipState(clip, this.finalState);
    }

    // Re-apply overlap resolution
    if (this.overlapResult) {
      const track = this.model.timeline.tracks.find(t => t.id === this.finalTrackId);
      if (track) this.applyOverlaps(track);
    }
  }

  undo(): void {
    // Undo overlap resolution first (reverse order)
    if (this.overlapResult) {
      const track = this.model.timeline.tracks.find(t => t.id === this.finalTrackId);
      if (track) this.revertOverlaps(track);
    }

    // Undo clip move/trim
    if (this.originalTrackId !== this.finalTrackId) {
      // Cross-track: move clip back from final track to original track
      const src = this.model.timeline.tracks.find(t => t.id === this.finalTrackId);
      const dst = this.model.timeline.tracks.find(t => t.id === this.originalTrackId);
      if (src && dst) {
        src.clips = src.clips.filter(c => c.id !== this.clipId);
        dst.clips.push({ ...this.originalState });
      }
    } else {
      const track = this.model.timeline.tracks.find(t => t.id === this.originalTrackId);
      const clip = track?.clips.find(c => c.id === this.clipId);
      if (clip) this.applyClipState(clip, this.originalState);
    }
  }

  private applyClipState(clip: Clip, state: Clip): void {
    clip.timelineOffset = state.timelineOffset;
    clip.sourceStart = state.sourceStart;
    clip.sourceEnd = state.sourceEnd;
    clip.duration = state.duration;
    clip.fadeInSamples = state.fadeInSamples;
    clip.fadeOutSamples = state.fadeOutSamples;
  }

  private applyOverlaps(track: { clips: Clip[] }): void {
    const r = this.overlapResult!;
    for (const removed of r.removed) {
      track.clips = track.clips.filter(c => c.id !== removed.id);
    }
    for (const { clipId, after } of r.trimmed) {
      const c = track.clips.find(c => c.id === clipId);
      if (c) this.applyClipState(c, after);
    }
    for (const added of r.added) {
      track.clips.push({ ...added });
    }
  }

  private revertOverlaps(track: { clips: Clip[] }): void {
    const r = this.overlapResult!;
    for (const added of r.added) {
      track.clips = track.clips.filter(c => c.id !== added.id);
    }
    for (const { clipId, before } of r.trimmed) {
      const c = track.clips.find(c => c.id === clipId);
      if (c) this.applyClipState(c, before);
    }
    for (const removed of r.removed) {
      track.clips.push({ ...removed });
    }
  }
}

export class AddClipCommand implements TimelineCommand {
  description: string;

  constructor(
    private model: TimelineModel,
    private trackId: string,
    private clip: Clip,
  ) {
    this.description = `Add clip "${clip.name}"`;
  }

  execute(): void {
    this.model.addClip(this.trackId, { ...this.clip });
  }

  undo(): void {
    this.model.removeClip(this.trackId, this.clip.id);
  }
}

/**
 * Undo/redo for per-clip gain changes.
 * Use pushExecuted() — gain is already applied via UI interaction.
 */
export class EditClipGainCommand implements TimelineCommand {
  description: string;

  constructor(
    private model: TimelineModel,
    private trackId: string,
    private clipId: string,
    private prevGainDb: number,
    private newGainDb: number,
  ) {
    this.description = `Set clip gain to ${newGainDb.toFixed(1)} dB`;
  }

  execute(): void {
    const clip = this.findClip();
    if (clip) clip.gainDb = this.newGainDb;
  }

  undo(): void {
    const clip = this.findClip();
    if (clip) clip.gainDb = this.prevGainDb;
  }

  private findClip(): Clip | undefined {
    const track = this.model.timeline.tracks.find(t => t.id === this.trackId);
    return track?.clips.find(c => c.id === this.clipId);
  }
}

/**
 * Undo/redo for per-clip fade in/out changes.
 * Use pushExecuted() — fades are already applied via UI interaction.
 */
export class EditClipFadeCommand implements TimelineCommand {
  description: string;

  constructor(
    private model: TimelineModel,
    private trackId: string,
    private clipId: string,
    private prevFadeIn: number,
    private prevFadeOut: number,
    private newFadeIn: number,
    private newFadeOut: number,
  ) {
    this.description = 'Edit clip fade';
  }

  execute(): void {
    const clip = this.findClip();
    if (clip) {
      clip.fadeInSamples = this.newFadeIn;
      clip.fadeOutSamples = this.newFadeOut;
    }
  }

  undo(): void {
    const clip = this.findClip();
    if (clip) {
      clip.fadeInSamples = this.prevFadeIn;
      clip.fadeOutSamples = this.prevFadeOut;
    }
  }

  private findClip(): Clip | undefined {
    const track = this.model.timeline.tracks.find(t => t.id === this.trackId);
    return track?.clips.find(c => c.id === this.clipId);
  }
}

/**
 * Undo/redo for adding a cue point.
 */
export class AddCuePointCommand implements TimelineCommand {
  description: string;
  private addedId = -1;

  constructor(
    private manager: CuePointManager,
    private sample: number,
    private name: string,
  ) {
    this.description = `Add cue point at ${sample}`;
  }

  execute(): void {
    const cp = this.manager.addCuePoint(this.sample, this.name);
    this.addedId = cp.id;
  }

  undo(): void {
    if (this.addedId >= 0) {
      this.manager.removeCuePoint(this.addedId);
    }
  }
}

/**
 * Undo/redo for removing a cue point.
 * Stores a snapshot so it can be re-added on undo.
 */
export class RemoveCuePointCommand implements TimelineCommand {
  description: string;

  constructor(
    private manager: CuePointManager,
    private cuePoint: CuePoint,
  ) {
    this.description = `Remove cue point #${cuePoint.number}`;
  }

  execute(): void {
    this.manager.removeCuePoint(this.cuePoint.id);
  }

  undo(): void {
    // Re-add with the same data
    const cp = this.manager.addCuePoint(this.cuePoint.sample, this.cuePoint.name);
    // Overwrite the auto-assigned id with the original so references stay consistent
    cp.id = this.cuePoint.id;
    // Ensure nextId stays ahead of restored ids
    if (this.manager.nextId <= this.cuePoint.id) {
      this.manager.nextId = this.cuePoint.id + 1;
    }
  }
}

/**
 * Undo/redo for moving a cue point.
 */
export class MoveCuePointCommand implements TimelineCommand {
  description: string;

  constructor(
    private manager: CuePointManager,
    private id: number,
    private prevSample: number,
    private newSample: number,
  ) {
    this.description = `Move cue point to ${newSample}`;
  }

  execute(): void {
    this.manager.moveCuePoint(this.id, this.newSample);
  }

  undo(): void {
    this.manager.moveCuePoint(this.id, this.prevSample);
  }
}

/**
 * Undo/redo for deleting a time range across multiple tracks.
 * Stores per-track overlap results from the first execution for replay.
 */
export class DeleteTimeRangeCommand implements TimelineCommand {
  description: string;
  private results: Map<string, OverlapResult> | null = null;

  constructor(
    private model: TimelineModel,
    private trackIds: string[],
    private startSample: number,
    private endSample: number,
  ) {
    this.description = `Delete time range [${startSample}–${endSample}]`;
  }

  execute(): void {
    if (this.results) {
      // Redo: replay stored changes
      for (const trackId of this.trackIds) {
        const result = this.results.get(trackId);
        if (!result) continue;
        const track = this.model.timeline.tracks.find(t => t.id === trackId);
        if (!track) continue;

        for (const removed of result.removed) {
          track.clips = track.clips.filter(c => c.id !== removed.id);
        }
        for (const { clipId, after } of result.trimmed) {
          const clip = track.clips.find(c => c.id === clipId);
          if (clip) {
            clip.sourceStart = after.sourceStart;
            clip.sourceEnd = after.sourceEnd;
            clip.timelineOffset = after.timelineOffset;
            clip.duration = after.duration;
            clip.fadeInSamples = after.fadeInSamples;
            clip.fadeOutSamples = after.fadeOutSamples;
          }
        }
        for (const added of result.added) {
          track.clips.push({ ...added });
        }
      }
      return;
    }

    // First execute
    this.results = new Map();
    for (const trackId of this.trackIds) {
      const result = this.model.deleteTimeRange(trackId, this.startSample, this.endSample);
      this.results.set(trackId, result);
    }
  }

  undo(): void {
    if (!this.results) return;

    for (const trackId of this.trackIds) {
      const result = this.results.get(trackId);
      if (!result) continue;
      const track = this.model.timeline.tracks.find(t => t.id === trackId);
      if (!track) continue;

      // Reverse: remove added, restore trimmed, restore removed
      for (const added of result.added) {
        track.clips = track.clips.filter(c => c.id !== added.id);
      }
      for (const { clipId, before } of result.trimmed) {
        const clip = track.clips.find(c => c.id === clipId);
        if (clip) {
          clip.sourceStart = before.sourceStart;
          clip.sourceEnd = before.sourceEnd;
          clip.timelineOffset = before.timelineOffset;
          clip.duration = before.duration;
          clip.fadeInSamples = before.fadeInSamples;
          clip.fadeOutSamples = before.fadeOutSamples;
        }
      }
      for (const removed of result.removed) {
        track.clips.push({ ...removed });
      }
    }
  }
}

/**
 * Undo/redo for reversing a clip's audio.
 * Swaps between original and reversed buffer IDs and toggles the reversed flag.
 */
export class ReverseClipCommand implements TimelineCommand {
  description: string;

  constructor(
    private model: TimelineModel,
    private trackId: string,
    private clipId: string,
    private originalBufferId: string,
    private reversedBufferId: string,
  ) {
    this.description = 'Reverse clip';
  }

  execute(): void {
    const clip = this.findClip();
    if (clip) {
      clip.bufferId = this.reversedBufferId;
      clip.reversed = true;
    }
  }

  undo(): void {
    const clip = this.findClip();
    if (clip) {
      clip.bufferId = this.originalBufferId;
      clip.reversed = false;
    }
  }

  private findClip(): Clip | undefined {
    const track = this.model.timeline.tracks.find(t => t.id === this.trackId);
    return track?.clips.find(c => c.id === this.clipId);
  }
}

/**
 * Undo/redo for normalizing a clip's audio.
 * Swaps between original and normalized buffer IDs.
 */
export class NormalizeClipCommand implements TimelineCommand {
  description: string;

  constructor(
    private model: TimelineModel,
    private trackId: string,
    private clipId: string,
    private originalBufferId: string,
    private normalizedBufferId: string,
  ) {
    this.description = 'Normalize clip';
  }

  execute(): void {
    const clip = this.findClip();
    if (clip) {
      clip.bufferId = this.normalizedBufferId;
    }
  }

  undo(): void {
    const clip = this.findClip();
    if (clip) {
      clip.bufferId = this.originalBufferId;
    }
  }

  private findClip(): Clip | undefined {
    const track = this.model.timeline.tracks.find(t => t.id === this.trackId);
    return track?.clips.find(c => c.id === this.clipId);
  }
}

/**
 * Undo/redo for denoising a clip's audio (DeepFilterNet).
 * Swaps between original and denoised buffer IDs.
 */
export class DenoiseClipCommand implements TimelineCommand {
  description = 'Denoise clip (DeepFilterNet)';

  constructor(
    private model: TimelineModel,
    private trackId: string,
    private clipId: string,
    private originalBufferId: string,
    private denoisedBufferId: string,
  ) {}

  execute(): void {
    const clip = this.findClip();
    if (clip) clip.bufferId = this.denoisedBufferId;
  }

  undo(): void {
    const clip = this.findClip();
    if (clip) clip.bufferId = this.originalBufferId;
  }

  private findClip(): Clip | undefined {
    const track = this.model.timeline.tracks.find(t => t.id === this.trackId);
    return track?.clips.find(c => c.id === this.clipId);
  }
}

/**
 * Undo/redo for importing a file at a specific track + time position.
 * Removes created clips and newly added tracks on undo.
 */
export class ImportFileAtPositionCommand implements TimelineCommand {
  description = 'Import file at position';
  private clipIds: string[] = [];
  private newTrackIds: string[] = [];

  constructor(
    private model: TimelineModel,
    private bufferIds: string[],
    private fileName: string,
    private sampleRate: number,
    private numSamples: number,
    private targetTrackIndex: number,
    private sampleOffset: number,
  ) {}

  execute(): void {
    const result = this.model.importFileAtPosition(
      this.bufferIds, this.fileName, this.sampleRate, this.numSamples,
      this.targetTrackIndex, this.sampleOffset,
    );
    this.clipIds = result.clipIds;
    this.newTrackIds = result.newTrackIds;
  }

  undo(): void {
    // Remove clips by ID from their tracks
    for (const track of this.model.timeline.tracks) {
      track.clips = track.clips.filter(c => !this.clipIds.includes(c.id));
    }
    // Remove newly created tracks (reverse order to preserve indices)
    for (const trackId of [...this.newTrackIds].reverse()) {
      this.model.removeTrack(trackId);
    }
  }
}

/**
 * Undo/redo for deleting an entire track.
 * Deep-copies the track data (including clips) so undo can restore it at the original index.
 */
export class DeleteTrackCommand implements TimelineCommand {
  description: string;
  private savedTrack: Track | null = null;
  private savedIndex = -1;

  constructor(
    private model: TimelineModel,
    private trackId: string,
  ) {
    this.description = 'Delete track';
  }

  execute(): void {
    const tracks = this.model.timeline.tracks;
    const idx = tracks.findIndex(t => t.id === this.trackId);
    if (idx < 0) return;

    // Deep-copy track with all clips
    this.savedTrack = JSON.parse(JSON.stringify(tracks[idx])) as Track;
    this.savedIndex = idx;

    // Clean up selection state
    this.model.timeline.selectedTrackIds =
      this.model.timeline.selectedTrackIds.filter(id => id !== this.trackId);
    const clipIds = new Set(tracks[idx].clips.map(c => c.id));
    this.model.timeline.selectedClipIds =
      this.model.timeline.selectedClipIds.filter(id => !clipIds.has(id));

    this.model.removeTrack(this.trackId);
  }

  undo(): void {
    if (!this.savedTrack || this.savedIndex < 0) return;
    this.model.insertTrackAt(
      JSON.parse(JSON.stringify(this.savedTrack)) as Track,
      this.savedIndex,
    );
  }
}
