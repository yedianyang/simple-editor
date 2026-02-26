import { Clip } from '../core/types';
import { TimelineModel, OverlapResult } from '../core/TimelineModel';

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
