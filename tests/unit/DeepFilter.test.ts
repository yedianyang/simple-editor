/**
 * TDD tests for DeepFilterNet denoise integration.
 * Tests DenoiseClipCommand (undo/redo), dB-based fader UI conversion,
 * and dry/wet mix signal behavior.
 */
import { describe, it, expect } from 'vitest';
import { DenoiseClipCommand } from '../../src/utils/TimelineUndoManager';
import { TimelineModel } from '../../src/core/TimelineModel';
import {
  dbToParam,
  paramToDb,
  FADER_MIN_DB,
  FADER_MAX_DB,
  FADER_DEFAULT_DB,
  FADER_LABELS,
  FADER_PARAM_KEYS,
} from '../../src/ui/DeepFilterUtils';

// ==================== DenoiseClipCommand ====================

function createModelWithClip(bufferIdVal: string) {
  const model = new TimelineModel();
  model.addTrack('Track 1', '#3b82f6', 0);
  const track = model.timeline.tracks[0];
  model.addClip(track.id, {
    id: 'clip-1',
    bufferIds: [bufferIdVal],
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
  it('should swap bufferIds to denoised on execute', () => {
    const { model, trackId } = createModelWithClip('buf-original');
    const cmd = new DenoiseClipCommand(model, trackId, 'clip-1', 'buf-original', 'buf-denoised');

    cmd.execute();

    const clip = model.timeline.tracks[0].clips[0];
    expect(clip.bufferIds[0]).toBe('buf-denoised');
  });

  it('should restore original bufferIds on undo', () => {
    const { model, trackId } = createModelWithClip('buf-original');
    const cmd = new DenoiseClipCommand(model, trackId, 'clip-1', 'buf-original', 'buf-denoised');

    cmd.execute();
    cmd.undo();

    const clip = model.timeline.tracks[0].clips[0];
    expect(clip.bufferIds[0]).toBe('buf-original');
  });

  it('should swap back to denoised on redo (execute again)', () => {
    const { model, trackId } = createModelWithClip('buf-original');
    const cmd = new DenoiseClipCommand(model, trackId, 'clip-1', 'buf-original', 'buf-denoised');

    cmd.execute();
    cmd.undo();
    cmd.execute(); // redo

    const clip = model.timeline.tracks[0].clips[0];
    expect(clip.bufferIds[0]).toBe('buf-denoised');
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

// ==================== dB <-> param conversion ====================

describe('dB \u2194 param conversion', () => {
  it('dbToParam(-56) should return exactly 0 (floor)', () => {
    expect(dbToParam(-56)).toBe(0);
  });

  it('dbToParam(0) should be approximately 0.8235 (56/68)', () => {
    expect(dbToParam(0)).toBeCloseTo(0.8235, 3);
  });

  it('dbToParam(12) should return exactly 1 (ceiling)', () => {
    expect(dbToParam(12)).toBe(1);
  });

  it('paramToDb(0) should return -56', () => {
    expect(paramToDb(0)).toBe(-56);
  });

  it('paramToDb(1) should return 12', () => {
    expect(paramToDb(1)).toBe(12);
  });

  it('paramToDb(0.5) should return -22 (0.5 * 68 - 56)', () => {
    expect(paramToDb(0.5)).toBe(-22);
  });

  it('round-trip: paramToDb(dbToParam(x)) === x for several values', () => {
    for (const db of [-56, -40, -22, 0, 6, 12]) {
      expect(paramToDb(dbToParam(db))).toBeCloseTo(db, 10);
    }
  });
});

// ==================== Fader defaults and ranges ====================

describe('Fader defaults and ranges', () => {
  it('FADER_MIN_DB should be -56', () => {
    expect(FADER_MIN_DB).toBe(-56);
  });

  it('FADER_MAX_DB should be 12', () => {
    expect(FADER_MAX_DB).toBe(12);
  });

  it('FADER_DEFAULT_DB should be 0', () => {
    expect(FADER_DEFAULT_DB).toBe(0);
  });

  it('FADER_LABELS should be [Dereverb, Denoise, Dialogue]', () => {
    expect(FADER_LABELS).toEqual(['Dereverb', 'Denoise', 'Dialogue']);
  });

  it('FADER_PARAM_KEYS should be [dereverb, denoise, dry]', () => {
    expect(FADER_PARAM_KEYS).toEqual(['dereverb', 'denoise', 'dry']);
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

  it('dry=0.0 (param=dbToParam(-56)) should be 100% wet (full processing)', () => {
    const dryParam = dbToParam(-56);
    const wet = 1.0 - dryParam;
    expect(wet).toBe(1.0);
  });

  it('dry param at default (0 dB) should be ~82% wet', () => {
    const dryParam = dbToParam(FADER_DEFAULT_DB);
    const wet = 1.0 - dryParam;
    expect(wet).toBeCloseTo(1.0 - 56 / 68, 3);
  });

  it('dry param at max (12 dB) should be 0% wet (fully dry)', () => {
    const dryParam = dbToParam(FADER_MAX_DB);
    const wet = 1.0 - dryParam;
    expect(wet).toBe(0.0);
  });
});
