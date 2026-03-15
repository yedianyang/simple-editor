import { describe, it, expect, beforeEach } from 'vitest';
import {
  ExportMetadata,
  createDefaultExportMetadata,
} from '../../src/core/types';

// ---- AudioFileMeta shape (mirrors TauriAPI.ts) ----
interface AudioFileMeta {
  path: string;
  name: string;
  extension: string;
  size: number;
  channels: number | null;
  sample_rate: number | null;
  bits_per_sample: number | null;
  duration_secs: number | null;
  bext_description: string | null;
  bext_originator: string | null;
  bext_originator_ref: string | null;
  bext_date: string | null;
  bext_time: string | null;
  bext_coding_history: string | null;
  ixml: string | null;
}

// ---- Helper: build a minimal AudioFileMeta ----
function makeFileMeta(overrides: Partial<AudioFileMeta> = {}): AudioFileMeta {
  return {
    path: '/test/file.wav',
    name: 'file.wav',
    extension: 'wav',
    size: 1024,
    channels: 2,
    sample_rate: 48000,
    bits_per_sample: 24,
    duration_secs: 10.0,
    bext_description: null,
    bext_originator: null,
    bext_originator_ref: null,
    bext_date: null,
    bext_time: null,
    bext_coding_history: null,
    ixml: null,
    ...overrides,
  };
}

// ---- Helper: iXML helper that mirrors App.ts logic ----
function getTag(ixml: string | null, tag: string): string {
  if (!ixml) return '';
  const match = ixml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'i'));
  return match ? match[1].trim() : '';
}

// ---- Helper: copy file metadata to ExportMetadata (session) ----
// This mirrors the logic that should be in App.copyFileMetaToSession()
function copyFileMetaToSession(
  file: AudioFileMeta,
  current: ExportMetadata,
): ExportMetadata {
  const result = { ...current };

  if (file.bext_description && !result.bpiDescription) {
    result.bpiDescription = file.bext_description;
  }
  if (file.bext_originator && !result.originator) {
    result.originator = file.bext_originator;
  }
  if (file.bext_originator_ref && !result.originatorRef) {
    result.originatorRef = file.bext_originator_ref;
  }
  if (file.bext_date && !result.date) {
    result.date = file.bext_date;
  }
  if (file.bext_time && !result.time) {
    result.time = file.bext_time;
  }

  // iXML fields
  const scene = getTag(file.ixml, 'SCENE');
  const take = getTag(file.ixml, 'TAKE');
  const tape = getTag(file.ixml, 'TAPE');
  const note = getTag(file.ixml, 'NOTE');

  if (scene && !result.scene) result.scene = scene;
  if (take && !result.take) result.take = take;
  if (tape && !result.tape) result.tape = tape;
  if (note && !result.note) result.note = note;

  return result;
}

// ---- Helper: copy file metadata to session (force-overwrite version) ----
function copyFileMetaToSessionForce(
  file: AudioFileMeta,
  current: ExportMetadata,
): ExportMetadata {
  const result = { ...current };

  result.bpiDescription = file.bext_description ?? result.bpiDescription;
  result.originator = file.bext_originator ?? result.originator;
  result.originatorRef = file.bext_originator_ref ?? result.originatorRef;
  result.date = file.bext_date ?? result.date;
  result.time = file.bext_time ?? result.time;

  const scene = getTag(file.ixml, 'SCENE');
  const take = getTag(file.ixml, 'TAKE');
  const tape = getTag(file.ixml, 'TAPE');
  const note = getTag(file.ixml, 'NOTE');

  if (scene) result.scene = scene;
  if (take) result.take = take;
  if (tape) result.tape = tape;
  if (note) result.note = note;

  return result;
}

// ---- Helper: build source metadata display rows ----
// Returns display pairs: [label, value]
interface SourceMetaRow {
  label: string;
  value: string;
}

function buildSourceMetaRows(file: AudioFileMeta): SourceMetaRow[] {
  const rows: SourceMetaRow[] = [];

  if (file.channels != null) {
    const ch =
      file.channels === 1 ? 'Mono' : file.channels === 2 ? 'Stereo' : `${file.channels}ch`;
    rows.push({ label: 'Channels', value: ch });
  }
  if (file.sample_rate != null) {
    const sr =
      (file.sample_rate / 1000).toFixed(file.sample_rate % 1000 === 0 ? 0 : 1) + ' kHz';
    rows.push({ label: 'Sample Rate', value: sr });
  }
  if (file.bits_per_sample != null) {
    rows.push({ label: 'Bit Depth', value: `${file.bits_per_sample}-bit` });
  }
  if (file.duration_secs != null) {
    const d = file.duration_secs;
    const value =
      d < 60
        ? d.toFixed(1) + 's'
        : `${Math.floor(d / 60)}:${Math.floor(d % 60).toString().padStart(2, '0')}`;
    rows.push({ label: 'Duration', value });
  }
  if (file.bext_description) rows.push({ label: 'Description', value: file.bext_description });
  if (file.bext_originator) rows.push({ label: 'Originator', value: file.bext_originator });
  if (file.bext_date) rows.push({ label: 'Date', value: file.bext_date });
  if (file.bext_time) rows.push({ label: 'Time', value: file.bext_time });

  const scene = getTag(file.ixml, 'SCENE');
  const take = getTag(file.ixml, 'TAKE');
  if (scene) rows.push({ label: 'Scene', value: scene });
  if (take) rows.push({ label: 'Take', value: take });

  return rows;
}

// ==============================
// Tests: Source metadata display
// ==============================

describe('buildSourceMetaRows — formats audio file metadata for display', () => {
  it('formats mono channel count', () => {
    const file = makeFileMeta({ channels: 1 });
    const rows = buildSourceMetaRows(file);
    const ch = rows.find(r => r.label === 'Channels');
    expect(ch?.value).toBe('Mono');
  });

  it('formats stereo channel count', () => {
    const file = makeFileMeta({ channels: 2 });
    const rows = buildSourceMetaRows(file);
    expect(rows.find(r => r.label === 'Channels')?.value).toBe('Stereo');
  });

  it('formats multichannel count as Nch', () => {
    const file = makeFileMeta({ channels: 6 });
    const rows = buildSourceMetaRows(file);
    expect(rows.find(r => r.label === 'Channels')?.value).toBe('6ch');
  });

  it('formats sample rate in kHz', () => {
    const file = makeFileMeta({ sample_rate: 48000 });
    const rows = buildSourceMetaRows(file);
    expect(rows.find(r => r.label === 'Sample Rate')?.value).toBe('48 kHz');
  });

  it('formats 44100 Hz sample rate', () => {
    const file = makeFileMeta({ sample_rate: 44100 });
    const rows = buildSourceMetaRows(file);
    expect(rows.find(r => r.label === 'Sample Rate')?.value).toBe('44.1 kHz');
  });

  it('formats bit depth', () => {
    const file = makeFileMeta({ bits_per_sample: 24 });
    const rows = buildSourceMetaRows(file);
    expect(rows.find(r => r.label === 'Bit Depth')?.value).toBe('24-bit');
  });

  it('formats short duration in seconds', () => {
    const file = makeFileMeta({ duration_secs: 5.3 });
    const rows = buildSourceMetaRows(file);
    expect(rows.find(r => r.label === 'Duration')?.value).toBe('5.3s');
  });

  it('formats long duration as M:SS', () => {
    const file = makeFileMeta({ duration_secs: 125.0 });
    const rows = buildSourceMetaRows(file);
    expect(rows.find(r => r.label === 'Duration')?.value).toBe('2:05');
  });

  it('includes BEXT description when present', () => {
    const file = makeFileMeta({ bext_description: 'Rain on leaves' });
    const rows = buildSourceMetaRows(file);
    expect(rows.find(r => r.label === 'Description')?.value).toBe('Rain on leaves');
  });

  it('omits BEXT fields when null', () => {
    const file = makeFileMeta({ bext_description: null, bext_originator: null });
    const rows = buildSourceMetaRows(file);
    expect(rows.find(r => r.label === 'Description')).toBeUndefined();
    expect(rows.find(r => r.label === 'Originator')).toBeUndefined();
  });

  it('includes iXML scene and take when present', () => {
    const file = makeFileMeta({
      ixml: '<SCENE>Forest01</SCENE><TAKE>3</TAKE>',
    });
    const rows = buildSourceMetaRows(file);
    expect(rows.find(r => r.label === 'Scene')?.value).toBe('Forest01');
    expect(rows.find(r => r.label === 'Take')?.value).toBe('3');
  });

  it('omits iXML fields when ixml is null', () => {
    const file = makeFileMeta({ ixml: null });
    const rows = buildSourceMetaRows(file);
    expect(rows.find(r => r.label === 'Scene')).toBeUndefined();
    expect(rows.find(r => r.label === 'Take')).toBeUndefined();
  });

  it('returns empty array for file with no metadata', () => {
    const file = makeFileMeta({
      channels: null,
      sample_rate: null,
      bits_per_sample: null,
      duration_secs: null,
    });
    const rows = buildSourceMetaRows(file);
    expect(rows).toHaveLength(0);
  });
});

// ==============================
// Tests: Copy to session (non-destructive — only fills empty fields)
// ==============================

describe('copyFileMetaToSession — populates empty session fields from file metadata', () => {
  let defaultSession: ExportMetadata;

  beforeEach(() => {
    defaultSession = createDefaultExportMetadata();
  });

  it('copies BEXT description to empty session', () => {
    const file = makeFileMeta({ bext_description: 'Forest ambience' });
    const session = copyFileMetaToSession(file, defaultSession);
    expect(session.bpiDescription).toBe('Forest ambience');
  });

  it('does not overwrite existing session description', () => {
    const file = makeFileMeta({ bext_description: 'Forest ambience' });
    defaultSession.bpiDescription = 'Existing description';
    const session = copyFileMetaToSession(file, defaultSession);
    expect(session.bpiDescription).toBe('Existing description');
  });

  it('copies originator to empty session', () => {
    const file = makeFileMeta({ bext_originator: 'Sound Devices' });
    // Reset default originator to empty to test the copy
    defaultSession.originator = '';
    const session = copyFileMetaToSession(file, defaultSession);
    expect(session.originator).toBe('Sound Devices');
  });

  it('does not overwrite existing session originator', () => {
    const file = makeFileMeta({ bext_originator: 'Sound Devices' });
    defaultSession.originator = 'My Recorder';
    const session = copyFileMetaToSession(file, defaultSession);
    expect(session.originator).toBe('My Recorder');
  });

  it('copies date and time from BEXT', () => {
    const file = makeFileMeta({
      bext_date: '2025-06-15',
      bext_time: '14:30:00',
    });
    const session = copyFileMetaToSession(file, defaultSession);
    expect(session.date).toBe('2025-06-15');
    expect(session.time).toBe('14:30:00');
  });

  it('copies scene and take from iXML', () => {
    const file = makeFileMeta({
      ixml: '<SCENE>Ext01</SCENE><TAKE>5</TAKE>',
    });
    const session = copyFileMetaToSession(file, defaultSession);
    expect(session.scene).toBe('Ext01');
    expect(session.take).toBe('5');
  });

  it('does not modify non-metadata fields', () => {
    const file = makeFileMeta({ bext_description: 'Test' });
    const session = copyFileMetaToSession(file, defaultSession);
    expect(session.ucsCategory).toBe('');
    expect(session.ucsSubCategory).toBe('');
    expect(session.circled).toBe(false);
  });
});

// ==============================
// Tests: Copy to session (force-overwrite — context menu "Copy metadata to session")
// ==============================

describe('copyFileMetaToSessionForce — overwrites session fields with file metadata', () => {
  let defaultSession: ExportMetadata;

  beforeEach(() => {
    defaultSession = createDefaultExportMetadata();
    defaultSession.bpiDescription = 'Existing';
    defaultSession.scene = 'OldScene';
  });

  it('overwrites existing session description', () => {
    const file = makeFileMeta({ bext_description: 'New description' });
    const session = copyFileMetaToSessionForce(file, defaultSession);
    expect(session.bpiDescription).toBe('New description');
  });

  it('overwrites existing session scene from iXML', () => {
    const file = makeFileMeta({ ixml: '<SCENE>NewScene</SCENE>' });
    const session = copyFileMetaToSessionForce(file, defaultSession);
    expect(session.scene).toBe('NewScene');
  });

  it('keeps existing value when file has null field', () => {
    const file = makeFileMeta({ bext_description: null });
    const session = copyFileMetaToSessionForce(file, defaultSession);
    expect(session.bpiDescription).toBe('Existing');
  });

  it('keeps existing ixml field when not present in file', () => {
    const file = makeFileMeta({ ixml: null });
    const session = copyFileMetaToSessionForce(file, defaultSession);
    // No ixml → scene remains unchanged (force only updates if tag found)
    expect(session.scene).toBe('OldScene');
  });
});

// ==============================
// Tests: Session metadata initialization
// ==============================

describe('session metadata state management', () => {
  it('starts as a valid ExportMetadata with default values', () => {
    const session = createDefaultExportMetadata();
    expect(session.bpiDescription).toBe('');
    expect(session.originator).toBe('FieldCorder');
    expect(session.trackNames).toEqual([]);
  });

  it('trackNames can be set per-channel', () => {
    const session = createDefaultExportMetadata();
    session.trackNames = ['Boom', 'Lav 1', 'Lav 2', 'Ambient'];
    expect(session.trackNames).toHaveLength(4);
    expect(session.trackNames[0]).toBe('Boom');
    expect(session.trackNames[3]).toBe('Ambient');
  });

  it('trackNames can be updated individually without affecting other fields', () => {
    const session: ExportMetadata = {
      ...createDefaultExportMetadata(),
      bpiDescription: 'Forest',
      trackNames: ['Ch1', 'Ch2'],
    };
    session.trackNames[1] = 'Boom';
    expect(session.bpiDescription).toBe('Forest');
    expect(session.trackNames[0]).toBe('Ch1');
    expect(session.trackNames[1]).toBe('Boom');
  });
});
