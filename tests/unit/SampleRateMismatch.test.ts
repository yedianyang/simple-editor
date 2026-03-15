/**
 * TDD tests for I1 — Session Sample Rate Management
 *
 * Tests the pure formatting helper `formatSampleRate` and the
 * mismatch detection logic extracted from App.ts.
 */
import { describe, it, expect } from 'vitest';
import { formatSampleRate, hasSampleRateMismatch } from '../../src/utils/sampleRateUtils';

describe('formatSampleRate', () => {
  it('formats 48000 as "48kHz"', () => {
    expect(formatSampleRate(48000)).toBe('48kHz');
  });

  it('formats 44100 as "44.1kHz"', () => {
    expect(formatSampleRate(44100)).toBe('44.1kHz');
  });

  it('formats 96000 as "96kHz"', () => {
    expect(formatSampleRate(96000)).toBe('96kHz');
  });

  it('formats 88200 as "88.2kHz"', () => {
    expect(formatSampleRate(88200)).toBe('88.2kHz');
  });

  it('formats 192000 as "192kHz"', () => {
    expect(formatSampleRate(192000)).toBe('192kHz');
  });

  it('formats 22050 as "22.1kHz"', () => {
    expect(formatSampleRate(22050)).toBe('22.1kHz');
  });

  it('formats 32000 as "32kHz"', () => {
    expect(formatSampleRate(32000)).toBe('32kHz');
  });
});

describe('hasSampleRateMismatch', () => {
  it('returns false when session has no tracks yet', () => {
    expect(hasSampleRateMismatch(44100, 48000, 0)).toBe(false);
  });

  it('returns false when rates match and tracks exist', () => {
    expect(hasSampleRateMismatch(48000, 48000, 2)).toBe(false);
  });

  it('returns true when rates differ and tracks exist', () => {
    expect(hasSampleRateMismatch(44100, 48000, 1)).toBe(true);
  });

  it('returns false when rates differ but no tracks yet (first import)', () => {
    expect(hasSampleRateMismatch(44100, 48000, 0)).toBe(false);
  });

  it('returns true for 96kHz vs 48kHz session with existing tracks', () => {
    expect(hasSampleRateMismatch(48000, 96000, 3)).toBe(true);
  });
});
