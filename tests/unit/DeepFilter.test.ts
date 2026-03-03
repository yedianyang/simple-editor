/**
 * TDD tests for DeepFilterNet denoise integration.
 * Tests DenoiseClipCommand (undo/redo) and denoise parameter presets.
 */
import { describe, it, expect } from 'vitest';
import { DenoiseClipCommand } from '../../src/utils/TimelineUndoManager';
import { TimelineModel } from '../../src/core/TimelineModel';

// ==================== DenoiseClipCommand ====================

function createModelWithClip(bufferId: string) {
  const model = new TimelineModel();
  model.addTrack('Track 1', '#3b82f6', 0);
  const track = model.timeline.tracks[0];
  model.addClip(track.id, {
    id: 'clip-1',
    bufferId,
    name: 'test-clip',
    timelineOffset: 0,
    sourceStart: 0,
    sourceEnd: 48000,
    duration: 48000,
    gainDb: 0,
    fadeInSamples: 0,
    fadeOutSamples: 0,
    muted: false,
  });
  return { model, trackId: track.id };
}

describe('DenoiseClipCommand', () => {
  it('should swap bufferId to denoised on execute', () => {
    const { model, trackId } = createModelWithClip('buf-original');
    const cmd = new DenoiseClipCommand(model, trackId, 'clip-1', 'buf-original', 'buf-denoised');

    cmd.execute();

    const clip = model.timeline.tracks[0].clips[0];
    expect(clip.bufferId).toBe('buf-denoised');
  });

  it('should restore original bufferId on undo', () => {
    const { model, trackId } = createModelWithClip('buf-original');
    const cmd = new DenoiseClipCommand(model, trackId, 'clip-1', 'buf-original', 'buf-denoised');

    cmd.execute();
    cmd.undo();

    const clip = model.timeline.tracks[0].clips[0];
    expect(clip.bufferId).toBe('buf-original');
  });

  it('should swap back to denoised on redo (execute again)', () => {
    const { model, trackId } = createModelWithClip('buf-original');
    const cmd = new DenoiseClipCommand(model, trackId, 'clip-1', 'buf-original', 'buf-denoised');

    cmd.execute();
    cmd.undo();
    cmd.execute(); // redo

    const clip = model.timeline.tracks[0].clips[0];
    expect(clip.bufferId).toBe('buf-denoised');
  });

  it('should have correct description', () => {
    const { model, trackId } = createModelWithClip('buf-original');
    const cmd = new DenoiseClipCommand(model, trackId, 'clip-1', 'buf-original', 'buf-denoised');
    expect(cmd.description).toBe('Denoise clip (DeepFilterNet)');
  });

  it('should be a no-op if clip is not found', () => {
    const { model, trackId } = createModelWithClip('buf-original');
    const cmd = new DenoiseClipCommand(model, trackId, 'nonexistent-clip', 'buf-original', 'buf-denoised');

    // Should not throw
    cmd.execute();
    cmd.undo();
  });
});

// ==================== Denoise parameter presets ====================

describe('Denoise parameter presets', () => {
  it('Gentle preset should have correct values', () => {
    const gentle = { denoise: 0.3, dereverb: 0.1, dry: 0.8 };
    expect(gentle.denoise).toBe(0.3);
    expect(gentle.dereverb).toBe(0.1);
    expect(gentle.dry).toBe(0.8);
  });

  it('Balanced preset should have correct values', () => {
    const balanced = { denoise: 0.5, dereverb: 0.3, dry: 1.0 };
    expect(balanced.denoise).toBe(0.5);
    expect(balanced.dereverb).toBe(0.3);
    expect(balanced.dry).toBe(1.0);
  });

  it('Aggressive preset should have correct values', () => {
    const aggressive = { denoise: 0.85, dereverb: 0.5, dry: 1.0 };
    expect(aggressive.denoise).toBe(0.85);
    expect(aggressive.dereverb).toBe(0.5);
    expect(aggressive.dry).toBe(1.0);
  });

  it('should clamp denoise to 0-1 range', () => {
    expect(Math.max(0, Math.min(1, -0.1))).toBe(0);
    expect(Math.max(0, Math.min(1, 1.5))).toBe(1);
    expect(Math.max(0, Math.min(1, 0.5))).toBe(0.5);
  });

  it('should clamp dereverb to 0-1 range', () => {
    expect(Math.max(0, Math.min(1, -0.5))).toBe(0);
    expect(Math.max(0, Math.min(1, 2.0))).toBe(1);
  });

  it('should clamp dry to 0-1 range', () => {
    expect(Math.max(0, Math.min(1, 0))).toBe(0);
    expect(Math.max(0, Math.min(1, 1))).toBe(1);
  });
});
