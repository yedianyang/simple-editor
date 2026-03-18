/**
 * File Browser Marking System Tests (B4, B5)
 *
 * Tests for:
 * - Sidecar path derivation
 * - Sidecar JSON serialization / deserialization
 * - Status cycling logic
 * - Marking state utilities
 */
import { describe, it, expect } from 'vitest';
import {
  getSidecarPath,
  serializeMarkingStatus,
  deserializeMarkingStatus,
  cycleMarkingStatus,
  type FileMarkingStatus,
} from '../../src/utils/fileBrowserMarking';

// ==================== 11.2 Sidecar path derivation ====================

describe('11.2 Sidecar path derivation', () => {
  it('11.2.1 - appends .fieldcorder-meta to file path', () => {
    const path = '/Volumes/Audio/session/ambience.wav';
    expect(getSidecarPath(path)).toBe('/Volumes/Audio/session/ambience.wav.fieldcorder-meta');
  });

  it('11.2.2 - works with paths without extension', () => {
    const path = '/home/user/recordings/take1';
    expect(getSidecarPath(path)).toBe('/home/user/recordings/take1.fieldcorder-meta');
  });

  it('11.2.3 - preserves paths with spaces', () => {
    const path = '/Volumes/My Drive/project files/take 01.wav';
    expect(getSidecarPath(path)).toBe('/Volumes/My Drive/project files/take 01.wav.fieldcorder-meta');
  });
});

// ==================== 11.3 Sidecar JSON serialization ====================

describe('11.3 Sidecar JSON serialization', () => {
  it('11.3.1 - serializes pending status to JSON', () => {
    const json = serializeMarkingStatus('pending');
    const obj = JSON.parse(json) as { status: string };
    expect(obj.status).toBe('pending');
  });

  it('11.3.2 - serializes done status to JSON', () => {
    const json = serializeMarkingStatus('done');
    const obj = JSON.parse(json) as { status: string };
    expect(obj.status).toBe('done');
  });

  it('11.3.3 - serializes skip status to JSON', () => {
    const json = serializeMarkingStatus('skip');
    const obj = JSON.parse(json) as { status: string };
    expect(obj.status).toBe('skip');
  });

  it('11.3.4 - deserializes valid JSON to status', () => {
    expect(deserializeMarkingStatus('{"status":"done"}')).toBe('done');
    expect(deserializeMarkingStatus('{"status":"pending"}')).toBe('pending');
    expect(deserializeMarkingStatus('{"status":"skip"}')).toBe('skip');
  });

  it('11.3.5 - returns pending for invalid JSON', () => {
    expect(deserializeMarkingStatus('not json')).toBe('pending');
  });

  it('11.3.6 - returns pending for unknown status value', () => {
    expect(deserializeMarkingStatus('{"status":"unknown"}')).toBe('pending');
  });

  it('11.3.7 - returns pending for missing status field', () => {
    expect(deserializeMarkingStatus('{}')).toBe('pending');
  });
});

// ==================== 11.4 Status cycling logic ====================

describe('11.4 Status cycling logic', () => {
  it('11.4.1 - pending cycles to done', () => {
    expect(cycleMarkingStatus('pending')).toBe('done');
  });

  it('11.4.2 - done cycles to skip', () => {
    expect(cycleMarkingStatus('done')).toBe('skip');
  });

  it('11.4.3 - skip cycles back to pending', () => {
    expect(cycleMarkingStatus('skip')).toBe('pending');
  });
});
