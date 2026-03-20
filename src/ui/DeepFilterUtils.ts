export const FADER_MIN_DB = -56;
export const FADER_MAX_DB = 12;
export const FADER_DEFAULT_DB = 0;
export const FADER_LABELS = ['Dereverb', 'Denoise', 'Dialogue'] as const;
export const FADER_PARAM_KEYS = ['dereverb', 'denoise', 'dry'] as const;

/** Convert dB value (-56 to +12) to backend param (0.0 to 1.0) */
export function dbToParam(db: number): number {
  return (db - FADER_MIN_DB) / (FADER_MAX_DB - FADER_MIN_DB);
}

/** Convert backend param (0.0 to 1.0) to dB value */
export function paramToDb(param: number): number {
  return param * (FADER_MAX_DB - FADER_MIN_DB) + FADER_MIN_DB;
}
