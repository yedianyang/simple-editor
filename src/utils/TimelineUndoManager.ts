import { Clip } from '../core/types';
import { TimelineModel } from '../core/TimelineModel';

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
