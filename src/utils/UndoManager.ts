/**
 * Undo/redo manager that stores audio buffer states.
 */
export class UndoManager {
  audioContext: AudioContext | null;
  undoStack: AudioBuffer[] = [];
  redoStack: AudioBuffer[] = [];
  maxStates: number;

  constructor(audioContext: AudioContext | null, maxStates = 50) {
    this.audioContext = audioContext;
    this.maxStates = maxStates;
  }

  setAudioContext(ctx: AudioContext): void {
    this.audioContext = ctx;
  }

  saveState(audioBuffer: AudioBuffer): void {
    if (!audioBuffer) return;
    const clone = this.cloneBuffer(audioBuffer);
    this.undoStack.push(clone);
    this.redoStack = [];
    if (this.undoStack.length > this.maxStates) {
      this.undoStack.shift();
    }
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(currentBuffer: AudioBuffer): AudioBuffer | null {
    if (!this.canUndo()) return null;
    if (currentBuffer) {
      this.redoStack.push(this.cloneBuffer(currentBuffer));
    }
    return this.undoStack.pop()!;
  }

  redo(currentBuffer: AudioBuffer): AudioBuffer | null {
    if (!this.canRedo()) return null;
    if (currentBuffer) {
      this.undoStack.push(this.cloneBuffer(currentBuffer));
    }
    return this.redoStack.pop()!;
  }

  cloneBuffer(audioBuffer: AudioBuffer): AudioBuffer {
    if (!this.audioContext) {
      throw new Error('UndoManager: audioContext is null — call setAudioContext() before saving state');
    }
    const clone = this.audioContext.createBuffer(
      audioBuffer.numberOfChannels,
      audioBuffer.length,
      audioBuffer.sampleRate
    );
    for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
      clone.getChannelData(c).set(audioBuffer.getChannelData(c));
    }
    return clone;
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }
}
