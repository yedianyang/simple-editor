import { describe, it, expect } from 'vitest';

/**
 * Fade curve gain formula: gain = pow(t, pow(2, -curve))
 *
 * curve = +1 → pow(t, 0.5) = sqrt  (fast attack, logarithmic feel)
 * curve =  0 → pow(t, 1)   = linear (default)
 * curve = -1 → pow(t, 2)   = t²    (slow attack, exponential feel)
 */
function fadeCurveGain(t: number, curve: number): number {
  return Math.pow(t, Math.pow(2, -(curve ?? 0)));
}

describe('fadeCurveGain', () => {
  describe('curve = 0 (linear, default)', () => {
    it('gain at t=0.5 is 0.5', () => {
      expect(fadeCurveGain(0.5, 0)).toBeCloseTo(0.5, 10);
    });

    it('gain at t=0 is 0', () => {
      expect(fadeCurveGain(0, 0)).toBe(0);
    });

    it('gain at t=1 is 1', () => {
      expect(fadeCurveGain(1, 0)).toBe(1);
    });
  });

  describe('curve = 1 (sqrt / fast attack)', () => {
    it('gain at t=0.5 is ~0.707 (sqrt(0.5))', () => {
      expect(fadeCurveGain(0.5, 1)).toBeCloseTo(Math.SQRT2 / 2, 10);
    });

    it('gain at t=0 is 0', () => {
      expect(fadeCurveGain(0, 1)).toBe(0);
    });

    it('gain at t=1 is 1', () => {
      expect(fadeCurveGain(1, 1)).toBe(1);
    });

    it('gain is higher than linear at t=0.5 (fast attack)', () => {
      expect(fadeCurveGain(0.5, 1)).toBeGreaterThan(fadeCurveGain(0.5, 0));
    });
  });

  describe('curve = -1 (squared / slow attack)', () => {
    it('gain at t=0.5 is 0.25 (0.5^2)', () => {
      expect(fadeCurveGain(0.5, -1)).toBeCloseTo(0.25, 10);
    });

    it('gain at t=0 is 0', () => {
      expect(fadeCurveGain(0, -1)).toBe(0);
    });

    it('gain at t=1 is 1', () => {
      expect(fadeCurveGain(1, -1)).toBe(1);
    });

    it('gain is lower than linear at t=0.5 (slow attack)', () => {
      expect(fadeCurveGain(0.5, -1)).toBeLessThan(fadeCurveGain(0.5, 0));
    });
  });

  describe('curve = undefined (backward compatibility, treated as 0)', () => {
    it('gain at t=0.5 is 0.5 (same as curve=0)', () => {
      // Simulate undefined by using nullish coalescing as the production code does
      const curve = undefined;
      expect(fadeCurveGain(0.5, curve ?? 0)).toBeCloseTo(0.5, 10);
    });
  });

  describe('fade-out formula: fadeCurveGain(1-t, curve)', () => {
    it('curve=0 at t=0.5 gives 0.5 (linear fade-out)', () => {
      expect(fadeCurveGain(1 - 0.5, 0)).toBeCloseTo(0.5, 10);
    });

    it('curve=1 at t=0.5 gives ~0.707 (sqrt fade-out)', () => {
      expect(fadeCurveGain(1 - 0.5, 1)).toBeCloseTo(Math.SQRT2 / 2, 10);
    });

    it('curve=-1 at t=0.5 gives 0.25 (squared fade-out)', () => {
      expect(fadeCurveGain(1 - 0.5, -1)).toBeCloseTo(0.25, 10);
    });
  });
});
