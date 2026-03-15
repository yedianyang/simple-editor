/**
 * Utility helpers for session sample-rate management.
 */

/**
 * Format a sample rate (in Hz) as a compact kHz string.
 *
 * Examples:
 *   48000 → "48kHz"
 *   44100 → "44.1kHz"
 *   96000 → "96kHz"
 */
export function formatSampleRate(hz: number): string {
  const khz = hz / 1000;
  const formatted = khz % 1 === 0 ? khz.toFixed(0) : khz.toFixed(1);
  return `${formatted}kHz`;
}

/**
 * Returns true when a file's sample rate differs from the session rate
 * AND the timeline already has content (i.e. this is not the first import).
 *
 * @param sessionRate  - `timeline.sampleRate` (already established)
 * @param fileRate     - sample rate of the file being imported
 * @param trackCount   - number of tracks currently on the timeline
 */
export function hasSampleRateMismatch(
  sessionRate: number,
  fileRate: number,
  trackCount: number,
): boolean {
  return trackCount > 0 && fileRate !== sessionRate;
}
