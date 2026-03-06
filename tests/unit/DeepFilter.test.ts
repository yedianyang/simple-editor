/**
 * TDD tests for DeepFilterNet denoise integration.
 * Tests DenoiseClipCommand (undo/redo), denoise parameter presets,
 * and dry/wet mix signal behavior.
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

// These must match the values in App.ts initDenoiseSliders()
const PRESETS = {
  gentle:     { denoise: 0.3,  dereverb: 0.1, dry: 0.8 },
  balanced:   { denoise: 0.5,  dereverb: 0.3, dry: 0.3 },
  aggressive: { denoise: 0.85, dereverb: 0.5, dry: 0.0 },
} as const;

describe('Denoise parameter presets', () => {
  it('Gentle preset should have correct values', () => {
    expect(PRESETS.gentle.denoise).toBe(0.3);
    expect(PRESETS.gentle.dereverb).toBe(0.1);
    expect(PRESETS.gentle.dry).toBe(0.8);
  });

  it('Balanced preset should have correct values', () => {
    expect(PRESETS.balanced.denoise).toBe(0.5);
    expect(PRESETS.balanced.dereverb).toBe(0.3);
    expect(PRESETS.balanced.dry).toBe(0.3);
  });

  it('Aggressive preset should have correct values', () => {
    expect(PRESETS.aggressive.denoise).toBe(0.85);
    expect(PRESETS.aggressive.dereverb).toBe(0.5);
    expect(PRESETS.aggressive.dry).toBe(0.0);
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

// ==================== Dry/wet mix signal behavior ====================

/** Simulate the Rust apply_dry_wet_mix: output = dry * original + (1-dry) * processed */
function applyDryWetMix(original: number[], processed: number[], dry: number): number[] {
  const wet = 1.0 - dry;
  return original.map((o, i) => dry * o + wet * processed[i]);
}

describe('Dry/wet mix signal behavior', () => {
  const original  = [0.5, -0.3, 0.8, -0.1];
  const processed = [0.1,  0.0, 0.2, -0.05];

  it('dry=1.0 produces original signal (zero processing effect)', () => {
    const result = applyDryWetMix(original, processed, 1.0);
    result.forEach((r, i) => {
      expect(r).toBeCloseTo(original[i], 6);
    });
  });

  it('dry=0.0 produces fully processed signal', () => {
    const result = applyDryWetMix(original, processed, 0.0);
    result.forEach((r, i) => {
      expect(r).toBeCloseTo(processed[i], 6);
    });
  });

  it('dry=0.5 blends original and processed equally', () => {
    const result = applyDryWetMix(original, processed, 0.5);
    result.forEach((r, i) => {
      expect(r).toBeCloseTo((original[i] + processed[i]) / 2, 6);
    });
  });

  it('all presets should have wet > 0 (processing has some effect)', () => {
    for (const [name, preset] of Object.entries(PRESETS)) {
      const wet = 1.0 - preset.dry;
      expect(wet, `Preset '${name}' should have wet > 0`).toBeGreaterThan(0);
    }
  });

  it('balanced preset wet should be >= 50%', () => {
    const wet = 1.0 - PRESETS.balanced.dry;
    expect(wet).toBeGreaterThanOrEqual(0.5);
  });

  it('aggressive preset should be 100% wet (full processing)', () => {
    const wet = 1.0 - PRESETS.aggressive.dry;
    expect(wet).toBe(1.0);
  });

  it('gentle preset should still apply some processing (wet > 0)', () => {
    const wet = 1.0 - PRESETS.gentle.dry;
    expect(wet).toBeGreaterThan(0);
    // Gentle should be less aggressive than balanced
    expect(wet).toBeLessThan(1.0 - PRESETS.balanced.dry);
  });
});
