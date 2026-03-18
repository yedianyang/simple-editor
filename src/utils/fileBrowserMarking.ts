/**
 * File Browser Marking Utilities
 *
 * Pure utility functions for the file browser marking system.
 * Handles state transitions and sidecar file serialization.
 */

/** The three fixed marking states for source files in the file browser. */
export type FileMarkingStatus = 'pending' | 'done' | 'skip';

/** Sidecar file suffix appended to the source file path. */
const SIDECAR_SUFFIX = '.fieldcorder-meta';

/**
 * Derive the sidecar file path from a source file path.
 * E.g. "/recordings/ambience.wav" → "/recordings/ambience.wav.fieldcorder-meta"
 */
export function getSidecarPath(filePath: string): string {
  return filePath + SIDECAR_SUFFIX;
}

/**
 * Serialize a marking status to a JSON string for sidecar file storage.
 */
export function serializeMarkingStatus(status: FileMarkingStatus): string {
  return JSON.stringify({ status });
}

const VALID_STATUSES: ReadonlySet<string> = new Set(['pending', 'done', 'skip']);

/**
 * Parse a marking status from sidecar file JSON content.
 * Returns 'pending' on any parse or validation error.
 */
export function deserializeMarkingStatus(json: string): FileMarkingStatus {
  try {
    const obj = JSON.parse(json) as unknown;
    if (obj !== null && typeof obj === 'object' && 'status' in obj) {
      const status = (obj as { status: unknown }).status;
      if (typeof status === 'string' && VALID_STATUSES.has(status)) {
        return status as FileMarkingStatus;
      }
    }
    return 'pending';
  } catch {
    return 'pending';
  }
}

/**
 * Cycle through marking states: pending → done → skip → pending.
 */
export function cycleMarkingStatus(current: FileMarkingStatus): FileMarkingStatus {
  if (current === 'pending') return 'done';
  if (current === 'done') return 'skip';
  return 'pending';
}
