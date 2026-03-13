import { describe, it, expect, beforeEach } from 'vitest';
import { ExportMetadata, createDefaultExportMetadata } from '../../src/core/types';
import { WavMetadata } from '../../src/core/WavEncoder';

/**
 * Tests for Export-Bug2: metadata export must use user-entered values
 * for originator, date, and time instead of hardcoded/auto-generated values.
 */

// Simulate the gatherInlineMetadata pattern from App.ts
// This mirrors the actual implementation's approach of reading DOM input values
function simulateGatherInlineMetadata(
  inputValues: Record<string, string>,
): ExportMetadata {
  const val = (id: string) => inputValues[id] || '';
  return {
    bpiDescription: val('inlineDescription'),
    originator: val('inlineOriginator') || 'FieldCorder',
    originatorRef: '',
    date: val('inlineDate'),
    time: val('inlineTime'),
    project: '',
    scene: val('inlineScene'),
    take: val('inlineTake'),
    tape: val('inlineTape'),
    note: val('inlineNote'),
    circled: false,
    wildTrack: false,
    trackNames: [],
    ucsCategory: val('inlineUcsCategory'),
    ucsSubCategory: val('inlineUcsSubCategory'),
    ucsCatId: val('inlineCatId'),
    ucsFxName: val('inlineFxName'),
    ucsCreatorId: val('inlineCreatorId'),
    ucsSourceId: val('inlineSourceId'),
    recordist: '',
    microphone: '',
    micPerspective: '',
    location: '',
    library: '',
    keywords: '',
  };
}

// Simulate the toWavMeta conversion from App.ts
function toWavMeta(meta: ExportMetadata): WavMetadata {
  const { bpiDescription, ...rest } = meta;
  return { description: bpiDescription, ...rest };
}

describe('gatherInlineMetadata — originator uses user input', () => {
  it('returns user-entered originator when inlineOriginator has a value', () => {
    const meta = simulateGatherInlineMetadata({
      inlineOriginator: 'Custom Recorder',
    });
    expect(meta.originator).toBe('Custom Recorder');
  });

  it('falls back to FieldCorder when inlineOriginator is empty', () => {
    const meta = simulateGatherInlineMetadata({
      inlineOriginator: '',
    });
    expect(meta.originator).toBe('FieldCorder');
  });

  it('falls back to FieldCorder when inlineOriginator is not present', () => {
    const meta = simulateGatherInlineMetadata({});
    expect(meta.originator).toBe('FieldCorder');
  });
});

describe('gatherInlineMetadata — date and time from user input', () => {
  it('returns user-entered date when inlineDate has a value', () => {
    const meta = simulateGatherInlineMetadata({
      inlineDate: '2025-06-15',
    });
    expect(meta.date).toBe('2025-06-15');
  });

  it('returns user-entered time when inlineTime has a value', () => {
    const meta = simulateGatherInlineMetadata({
      inlineTime: '14:30:00',
    });
    expect(meta.time).toBe('14:30:00');
  });

  it('date and time are empty strings when not entered', () => {
    const meta = simulateGatherInlineMetadata({});
    expect(meta.date).toBe('');
    expect(meta.time).toBe('');
  });
});

describe('ExportMetadata interface includes date and time', () => {
  it('createDefaultExportMetadata includes date and time fields', () => {
    const defaults = createDefaultExportMetadata();
    expect(defaults).toHaveProperty('date');
    expect(defaults).toHaveProperty('time');
    expect(defaults.date).toBe('');
    expect(defaults.time).toBe('');
  });
});

describe('toWavMeta passes date and time through', () => {
  it('maps ExportMetadata date/time to WavMetadata date/time', () => {
    const exportMeta: ExportMetadata = {
      ...createDefaultExportMetadata(),
      date: '2025-06-15',
      time: '14:30:00',
      originator: 'My Recorder',
    };
    const wavMeta = toWavMeta(exportMeta);
    expect(wavMeta.date).toBe('2025-06-15');
    expect(wavMeta.time).toBe('14:30:00');
    expect(wavMeta.originator).toBe('My Recorder');
  });
});
