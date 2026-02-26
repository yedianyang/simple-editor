import { describe, it, expect, vi } from 'vitest';
import { encodeWav, encodeWavAsync, WavEncodeOptions, WavMetadata } from '../../src/core/WavEncoder';

// ── Helpers ──────────────────────────────────────────────────────────────

/** Parse a RIFF/WAV buffer and return chunk map. */
function parseChunks(data: Uint8Array): Map<string, { offset: number; size: number }> {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const chunks = new Map<string, { offset: number; size: number }>();

  // Skip RIFF header (12 bytes: "RIFF" + size + "WAVE")
  let pos = 12;
  while (pos + 8 <= data.byteLength) {
    const id = String.fromCharCode(data[pos], data[pos + 1], data[pos + 2], data[pos + 3]);
    const size = view.getUint32(pos + 4, true);
    chunks.set(id, { offset: pos + 8, size });
    // Advance past chunk header + padded data
    pos += 8 + size + (size & 1);
  }
  return chunks;
}

function readString(data: Uint8Array, offset: number, len: number): string {
  return String.fromCharCode(...data.slice(offset, offset + len));
}

/** Create a simple sine wave in Float32Array. */
function makeSine(length: number, freq = 440, sampleRate = 44100): Float32Array {
  const buf = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    buf[i] = Math.sin(2 * Math.PI * freq * i / sampleRate);
  }
  return buf;
}

/** Build minimal encode options. */
function makeOpts(overrides: Partial<WavEncodeOptions> = {}): WavEncodeOptions {
  const length = 100;
  return {
    sampleRate: 44100,
    bitDepth: 16,
    channels: [makeSine(length)],
    ...overrides,
  };
}

// ── RIFF Container ───────────────────────────────────────────────────────

describe('WavEncoder — RIFF container', () => {
  it('starts with RIFF header and WAVE format tag', () => {
    const wav = encodeWav(makeOpts());
    expect(readString(wav, 0, 4)).toBe('RIFF');
    expect(readString(wav, 8, 4)).toBe('WAVE');
  });

  it('RIFF size equals total file size minus 8', () => {
    const wav = encodeWav(makeOpts());
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    const riffSize = view.getUint32(4, true);
    expect(riffSize).toBe(wav.byteLength - 8);
  });

  it('contains fmt and data chunks', () => {
    const wav = encodeWav(makeOpts());
    const chunks = parseChunks(wav);
    expect(chunks.has('fmt ')).toBe(true);
    expect(chunks.has('data')).toBe(true);
  });

  it('omits bext and iXML when no metadata', () => {
    const wav = encodeWav(makeOpts());
    const chunks = parseChunks(wav);
    expect(chunks.has('bext')).toBe(false);
    expect(chunks.has('iXML')).toBe(false);
  });

  it('includes bext and iXML when metadata provided', () => {
    const wav = encodeWav(makeOpts({ metadata: { description: 'Test' } }));
    const chunks = parseChunks(wav);
    expect(chunks.has('bext')).toBe(true);
    expect(chunks.has('iXML')).toBe(true);
  });
});

// ── fmt Chunk — Standard PCM (mono/stereo) ───────────────────────────────

describe('WavEncoder — fmt chunk (standard)', () => {
  it('16-bit mono PCM: format tag 1, correct block align and byte rate', () => {
    const wav = encodeWav(makeOpts({ bitDepth: 16, channels: [makeSine(100)] }));
    const chunks = parseChunks(wav);
    const fmt = chunks.get('fmt ')!;
    expect(fmt.size).toBe(16);

    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    const off = fmt.offset;
    expect(view.getUint16(off, true)).toBe(1);       // WAVE_FORMAT_PCM
    expect(view.getUint16(off + 2, true)).toBe(1);    // numChannels
    expect(view.getUint32(off + 4, true)).toBe(44100); // sampleRate
    expect(view.getUint32(off + 8, true)).toBe(44100 * 1 * 2); // byteRate
    expect(view.getUint16(off + 12, true)).toBe(2);   // blockAlign = 1ch * 2bytes
    expect(view.getUint16(off + 14, true)).toBe(16);   // bitsPerSample
  });

  it('16-bit stereo PCM: 2 channels, correct byte rate', () => {
    const wav = encodeWav(makeOpts({ bitDepth: 16, channels: [makeSine(100), makeSine(100)] }));
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    const chunks = parseChunks(wav);
    const off = chunks.get('fmt ')!.offset;
    expect(view.getUint16(off + 2, true)).toBe(2);          // numChannels
    expect(view.getUint32(off + 8, true)).toBe(44100 * 2 * 2); // byteRate
    expect(view.getUint16(off + 12, true)).toBe(4);          // blockAlign
  });

  it('24-bit mono PCM: 3 bytes per sample', () => {
    const wav = encodeWav(makeOpts({ bitDepth: 24 }));
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    const chunks = parseChunks(wav);
    const off = chunks.get('fmt ')!.offset;
    expect(view.getUint16(off, true)).toBe(1);           // PCM
    expect(view.getUint32(off + 8, true)).toBe(44100 * 1 * 3);
    expect(view.getUint16(off + 12, true)).toBe(3);      // blockAlign
    expect(view.getUint16(off + 14, true)).toBe(24);
  });

  it('32-bit float: format tag 3 (IEEE_FLOAT)', () => {
    const wav = encodeWav(makeOpts({ bitDepth: 32 }));
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    const chunks = parseChunks(wav);
    const off = chunks.get('fmt ')!.offset;
    expect(view.getUint16(off, true)).toBe(3);           // IEEE_FLOAT
    expect(view.getUint16(off + 14, true)).toBe(32);
    expect(view.getUint16(off + 12, true)).toBe(4);      // blockAlign 1ch * 4bytes
  });
});

// ── fmt Chunk — WAVE_FORMAT_EXTENSIBLE (>2 channels) ─────────────────────

describe('WavEncoder — fmt chunk (extensible)', () => {
  function make4chOpts(bitDepth: 16 | 24 | 32 = 16): WavEncodeOptions {
    const ch = [makeSine(50), makeSine(50), makeSine(50), makeSine(50)];
    return { sampleRate: 48000, bitDepth, channels: ch };
  }

  it('uses format tag 0xFFFE for >2 channels', () => {
    const wav = encodeWav(make4chOpts());
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    const chunks = parseChunks(wav);
    const off = chunks.get('fmt ')!.offset;
    expect(view.getUint16(off, true)).toBe(0xFFFE);
  });

  it('fmt data size is 40 bytes for extensible', () => {
    const wav = encodeWav(make4chOpts());
    const chunks = parseChunks(wav);
    expect(chunks.get('fmt ')!.size).toBe(40);
  });

  it('cbSize is 22', () => {
    const wav = encodeWav(make4chOpts());
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    const off = parseChunks(wav).get('fmt ')!.offset;
    expect(view.getUint16(off + 16, true)).toBe(22); // cbSize at byte 16 of fmt data
  });

  it('sets quad channel mask (0x33) for 4 channels', () => {
    const wav = encodeWav(make4chOpts());
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    const off = parseChunks(wav).get('fmt ')!.offset;
    expect(view.getUint32(off + 20, true)).toBe(0x33); // dwChannelMask at +20
  });

  it('respects custom channelMask', () => {
    const opts = { ...make4chOpts(), channelMask: 0xFF };
    const wav = encodeWav(opts);
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    const off = parseChunks(wav).get('fmt ')!.offset;
    expect(view.getUint32(off + 20, true)).toBe(0xFF);
  });

  it('writes PCM SubFormat GUID for 16/24-bit', () => {
    const wav = encodeWav(make4chOpts(24));
    const chunks = parseChunks(wav);
    const off = chunks.get('fmt ')!.offset + 24; // SubFormat at +24
    // First byte of PCM GUID is 0x01
    expect(wav[off]).toBe(0x01);
    expect(wav[off + 1]).toBe(0x00);
  });

  it('writes IEEE_FLOAT SubFormat GUID for 32-bit', () => {
    const wav = encodeWav(make4chOpts(32));
    const chunks = parseChunks(wav);
    const off = chunks.get('fmt ')!.offset + 24;
    // First byte of FLOAT GUID is 0x03
    expect(wav[off]).toBe(0x03);
  });

  it('6-channel (5.1) uses mask 0x3F', () => {
    const ch = Array.from({ length: 6 }, () => makeSine(50));
    const wav = encodeWav({ sampleRate: 48000, bitDepth: 16, channels: ch });
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    const off = parseChunks(wav).get('fmt ')!.offset;
    expect(view.getUint32(off + 20, true)).toBe(0x3F);
  });

  it('8-channel (7.1) uses mask 0x63F', () => {
    const ch = Array.from({ length: 8 }, () => makeSine(50));
    const wav = encodeWav({ sampleRate: 48000, bitDepth: 16, channels: ch });
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    const off = parseChunks(wav).get('fmt ')!.offset;
    expect(view.getUint32(off + 20, true)).toBe(0x63F);
  });
});

// ── data chunk — sample accuracy ─────────────────────────────────────────

describe('WavEncoder — sample data', () => {
  it('data chunk size matches expected byte count (16-bit mono)', () => {
    const length = 200;
    const wav = encodeWav(makeOpts({ channels: [makeSine(length)], bitDepth: 16 }));
    const chunks = parseChunks(wav);
    expect(chunks.get('data')!.size).toBe(length * 1 * 2);
  });

  it('data chunk size for 24-bit stereo', () => {
    const length = 100;
    const ch = [makeSine(length), makeSine(length)];
    const wav = encodeWav(makeOpts({ channels: ch, bitDepth: 24 }));
    const chunks = parseChunks(wav);
    expect(chunks.get('data')!.size).toBe(length * 2 * 3);
  });

  it('32-bit float roundtrips known values exactly', () => {
    const samples = new Float32Array([0.0, 0.5, -0.5, 1.0, -1.0]);
    const wav = encodeWav({ sampleRate: 44100, bitDepth: 32, channels: [samples] });
    const chunks = parseChunks(wav);
    const dataOff = chunks.get('data')!.offset;
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);

    for (let i = 0; i < samples.length; i++) {
      expect(view.getFloat32(dataOff + i * 4, true)).toBeCloseTo(samples[i], 6);
    }
  });

  it('16-bit PCM encodes silence as 0', () => {
    const silence = new Float32Array(10); // all zeros
    const wav = encodeWav({ sampleRate: 44100, bitDepth: 16, channels: [silence] });
    const chunks = parseChunks(wav);
    const dataOff = chunks.get('data')!.offset;
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);

    for (let i = 0; i < 10; i++) {
      expect(view.getInt16(dataOff + i * 2, true)).toBe(0);
    }
  });

  it('16-bit PCM clips at +1.0 to 0x7FFF', () => {
    const loud = new Float32Array([1.0]);
    const wav = encodeWav({ sampleRate: 44100, bitDepth: 16, channels: [loud] });
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    const dataOff = parseChunks(wav).get('data')!.offset;
    expect(view.getInt16(dataOff, true)).toBe(0x7FFF);
  });

  it('16-bit PCM clips at -1.0 to -0x7FFF (or close)', () => {
    const loud = new Float32Array([-1.0]);
    const wav = encodeWav({ sampleRate: 44100, bitDepth: 16, channels: [loud] });
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    const dataOff = parseChunks(wav).get('data')!.offset;
    const val = view.getInt16(dataOff, true);
    // -1.0 * 0x7FFF = -32767
    expect(val).toBe(-32767);
  });

  it('24-bit encodes full-scale positive correctly', () => {
    const loud = new Float32Array([1.0]);
    const wav = encodeWav({ sampleRate: 44100, bitDepth: 24, channels: [loud] });
    const dataOff = parseChunks(wav).get('data')!.offset;
    // 24-bit max positive = 0x7FFFFF, stored little-endian
    const b0 = wav[dataOff];
    const b1 = wav[dataOff + 1];
    const b2 = wav[dataOff + 2];
    const val = b0 | (b1 << 8) | (b2 << 16);
    expect(val).toBe(0x7FFFFF);
  });

  it('interleaves stereo samples correctly (32-bit float)', () => {
    const L = new Float32Array([0.25, 0.75]);
    const R = new Float32Array([-0.25, -0.75]);
    const wav = encodeWav({ sampleRate: 44100, bitDepth: 32, channels: [L, R] });
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    const dataOff = parseChunks(wav).get('data')!.offset;

    // sample 0: L then R
    expect(view.getFloat32(dataOff + 0, true)).toBeCloseTo(0.25, 5);
    expect(view.getFloat32(dataOff + 4, true)).toBeCloseTo(-0.25, 5);
    // sample 1: L then R
    expect(view.getFloat32(dataOff + 8, true)).toBeCloseTo(0.75, 5);
    expect(view.getFloat32(dataOff + 12, true)).toBeCloseTo(-0.75, 5);
  });
});

// ── Dither modes ─────────────────────────────────────────────────────────

describe('WavEncoder — dither', () => {
  it('tpdf dither produces valid 16-bit values (no overflow)', () => {
    const sine = makeSine(1000);
    const wav = encodeWav({ sampleRate: 44100, bitDepth: 16, channels: [sine], dither: 'tpdf' });
    const chunks = parseChunks(wav);
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    const dataOff = chunks.get('data')!.offset;

    for (let i = 0; i < 1000; i++) {
      const val = view.getInt16(dataOff + i * 2, true);
      expect(val).toBeGreaterThanOrEqual(-32768);
      expect(val).toBeLessThanOrEqual(32767);
    }
  });

  it('shaped dither produces valid 16-bit values', () => {
    const sine = makeSine(1000);
    const wav = encodeWav({ sampleRate: 44100, bitDepth: 16, channels: [sine], dither: 'shaped' });
    const chunks = parseChunks(wav);
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    const dataOff = chunks.get('data')!.offset;

    for (let i = 0; i < 1000; i++) {
      const val = view.getInt16(dataOff + i * 2, true);
      expect(val).toBeGreaterThanOrEqual(-32768);
      expect(val).toBeLessThanOrEqual(32767);
    }
  });

  it('tpdf dither adds noise (output differs from no-dither)', () => {
    // Seed Math.random for reproducibility isn't possible, but statistically
    // with 1000 samples, at least one should differ
    const sine = makeSine(1000);
    const noDither = encodeWav({ sampleRate: 44100, bitDepth: 16, channels: [sine], dither: 'none' });
    const withDither = encodeWav({ sampleRate: 44100, bitDepth: 16, channels: [sine], dither: 'tpdf' });

    const ndChunks = parseChunks(noDither);
    const wdChunks = parseChunks(withDither);
    const ndOff = ndChunks.get('data')!.offset;
    const wdOff = wdChunks.get('data')!.offset;

    let diffCount = 0;
    const ndView = new DataView(noDither.buffer, noDither.byteOffset, noDither.byteLength);
    const wdView = new DataView(withDither.buffer, withDither.byteOffset, withDither.byteLength);
    for (let i = 0; i < 1000; i++) {
      if (ndView.getInt16(ndOff + i * 2, true) !== wdView.getInt16(wdOff + i * 2, true)) {
        diffCount++;
      }
    }
    // Statistically, at least some samples should differ
    expect(diffCount).toBeGreaterThan(0);
  });

  it('32-bit float ignores dither (lossless)', () => {
    const samples = new Float32Array([0.1, 0.5, -0.3]);
    const noDither = encodeWav({ sampleRate: 44100, bitDepth: 32, channels: [samples], dither: 'none' });
    const withDither = encodeWav({ sampleRate: 44100, bitDepth: 32, channels: [samples], dither: 'tpdf' });

    const ndOff = parseChunks(noDither).get('data')!.offset;
    const wdOff = parseChunks(withDither).get('data')!.offset;
    const ndView = new DataView(noDither.buffer, noDither.byteOffset, noDither.byteLength);
    const wdView = new DataView(withDither.buffer, withDither.byteOffset, withDither.byteLength);

    for (let i = 0; i < 3; i++) {
      expect(ndView.getFloat32(ndOff + i * 4, true)).toBe(wdView.getFloat32(wdOff + i * 4, true));
    }
  });
});

// ── BEXT chunk ───────────────────────────────────────────────────────────

describe('WavEncoder — BEXT chunk', () => {
  const meta: WavMetadata = {
    description: 'Rain on tin roof',
    originator: 'TestRecorder',
    originatorRef: 'REF001',
  };

  it('chunk id is "bext" and size >= 602', () => {
    const wav = encodeWav(makeOpts({ metadata: meta }));
    const chunks = parseChunks(wav);
    const bext = chunks.get('bext')!;
    expect(bext).toBeDefined();
    // Minimum: 602 bytes fixed + coding history
    expect(bext.size).toBeGreaterThanOrEqual(602);
  });

  it('description field at offset 0 (256 bytes)', () => {
    const wav = encodeWav(makeOpts({ metadata: meta }));
    const bextOff = parseChunks(wav).get('bext')!.offset;
    const desc = readString(wav, bextOff, meta.description!.length);
    expect(desc).toBe('Rain on tin roof');
  });

  it('originator field at offset 256 (32 bytes)', () => {
    const wav = encodeWav(makeOpts({ metadata: meta }));
    const bextOff = parseChunks(wav).get('bext')!.offset;
    const orig = readString(wav, bextOff + 256, meta.originator!.length);
    expect(orig).toBe('TestRecorder');
  });

  it('version is 2 at offset 346', () => {
    const wav = encodeWav(makeOpts({ metadata: meta }));
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    const bextOff = parseChunks(wav).get('bext')!.offset;
    expect(view.getUint16(bextOff + 346, true)).toBe(2);
  });

  it('coding history contains PCM, sample rate, bit depth', () => {
    const wav = encodeWav(makeOpts({ metadata: meta, sampleRate: 96000, bitDepth: 24 }));
    const bext = parseChunks(wav).get('bext')!;
    const codingStart = bext.offset + 602;
    const codingLen = bext.size - 602;
    const history = readString(wav, codingStart, codingLen);
    expect(history).toContain('A=PCM');
    expect(history).toContain('F=96000');
    expect(history).toContain('W=24');
    expect(history).toContain('T=FieldCorder');
  });

  it('coding history mode=stereo for 2 channels', () => {
    const ch = [makeSine(50), makeSine(50)];
    const wav = encodeWav({ sampleRate: 44100, bitDepth: 16, channels: ch, metadata: meta });
    const bext = parseChunks(wav).get('bext')!;
    const history = readString(wav, bext.offset + 602, bext.size - 602);
    expect(history).toContain('M=stereo');
  });

  it('coding history mode=surround for >2 channels', () => {
    const ch = Array.from({ length: 6 }, () => makeSine(50));
    const wav = encodeWav({ sampleRate: 48000, bitDepth: 24, channels: ch, metadata: meta });
    const bext = parseChunks(wav).get('bext')!;
    const history = readString(wav, bext.offset + 602, bext.size - 602);
    expect(history).toContain('M=surround');
  });

  it('auto-fills description from UCS fields when no explicit description', () => {
    const ucsMeta: WavMetadata = {
      ucsFxName: 'Thunder Crack',
      ucsCategory: 'WEATHER',
      ucsSubCategory: 'Storm',
    };
    const wav = encodeWav(makeOpts({ metadata: ucsMeta }));
    const bextOff = parseChunks(wav).get('bext')!.offset;
    // Should contain "WEATHER - Storm: Thunder Crack"
    const desc = readString(wav, bextOff, 40);
    expect(desc).toContain('WEATHER');
    expect(desc).toContain('Thunder Crack');
  });

  it('defaults originator to FieldCorder', () => {
    const wav = encodeWav(makeOpts({ metadata: {} }));
    const bextOff = parseChunks(wav).get('bext')!.offset;
    const orig = readString(wav, bextOff + 256, 11);
    expect(orig).toBe('FieldCorder');
  });
});

// ── iXML chunk ───────────────────────────────────────────────────────────

describe('WavEncoder — iXML chunk', () => {
  function getIXMLString(wav: Uint8Array): string {
    const chunks = parseChunks(wav);
    const ixml = chunks.get('iXML')!;
    return new TextDecoder().decode(wav.slice(ixml.offset, ixml.offset + ixml.size));
  }

  it('contains XML header and BWFXML root', () => {
    const wav = encodeWav(makeOpts({ metadata: { project: 'TestProj' } }));
    const xml = getIXMLString(wav);
    expect(xml).toContain('<?xml version="1.0"');
    expect(xml).toContain('<BWFXML>');
    expect(xml).toContain('</BWFXML>');
  });

  it('version is 2.0', () => {
    const wav = encodeWav(makeOpts({ metadata: {} }));
    const xml = getIXMLString(wav);
    expect(xml).toContain('<IXML_VERSION>2.0</IXML_VERSION>');
  });

  it('includes project, scene, take, tape, note', () => {
    const meta: WavMetadata = {
      project: 'MyFilm',
      scene: '42A',
      take: '3',
      tape: 'R001',
      note: 'Wind pickup on boom',
    };
    const wav = encodeWav(makeOpts({ metadata: meta }));
    const xml = getIXMLString(wav);
    expect(xml).toContain('<PROJECT>MyFilm</PROJECT>');
    expect(xml).toContain('<SCENE>42A</SCENE>');
    expect(xml).toContain('<TAKE>3</TAKE>');
    expect(xml).toContain('<TAPE>R001</TAPE>');
    expect(xml).toContain('<NOTE>Wind pickup on boom</NOTE>');
  });

  it('circled and wildTrack default to FALSE', () => {
    const wav = encodeWav(makeOpts({ metadata: {} }));
    const xml = getIXMLString(wav);
    expect(xml).toContain('<CIRCLED>FALSE</CIRCLED>');
    expect(xml).toContain('<WILD_TRACK>FALSE</WILD_TRACK>');
  });

  it('circled=true emits TRUE', () => {
    const wav = encodeWav(makeOpts({ metadata: { circled: true } }));
    const xml = getIXMLString(wav);
    expect(xml).toContain('<CIRCLED>TRUE</CIRCLED>');
  });

  it('track names produce TRACK_LIST', () => {
    const meta: WavMetadata = { trackNames: ['Boom', 'Lav1'] };
    const ch = [makeSine(50), makeSine(50)];
    const wav = encodeWav({ sampleRate: 44100, bitDepth: 16, channels: ch, metadata: meta });
    const xml = getIXMLString(wav);
    expect(xml).toContain('<TRACK_LIST>');
    expect(xml).toContain('<TRACK_COUNT>2</TRACK_COUNT>');
    expect(xml).toContain('<CHANNEL_INDEX>1</CHANNEL_INDEX>');
    expect(xml).toContain('<NAME>Boom</NAME>');
    expect(xml).toContain('<CHANNEL_INDEX>2</CHANNEL_INDEX>');
    expect(xml).toContain('<NAME>Lav1</NAME>');
  });

  it('empty trackNames array skips TRACK_LIST', () => {
    const wav = encodeWav(makeOpts({ metadata: { trackNames: [] } }));
    const xml = getIXMLString(wav);
    expect(xml).not.toContain('<TRACK_LIST>');
  });

  it('trackNames with only blank entries skips TRACK_LIST', () => {
    const wav = encodeWav(makeOpts({ metadata: { trackNames: ['', '  '] } }));
    const xml = getIXMLString(wav);
    expect(xml).not.toContain('<TRACK_LIST>');
  });

  it('UCS fields written in USER block', () => {
    const meta: WavMetadata = {
      ucsCatId: 'AMBInt',
      ucsCategory: 'AMBIENCE',
      ucsSubCategory: 'Interior',
      ucsFxName: 'Office Hum',
      ucsCreatorId: 'FC',
      ucsSourceId: 'SRC001',
    };
    const wav = encodeWav(makeOpts({ metadata: meta }));
    const xml = getIXMLString(wav);
    expect(xml).toContain('<USER>');
    expect(xml).toContain('<UCS_CATID>AMBInt</UCS_CATID>');
    expect(xml).toContain('<UCS_CATEGORY>AMBIENCE</UCS_CATEGORY>');
    expect(xml).toContain('<UCS_FXNAME>Office Hum</UCS_FXNAME>');
    expect(xml).toContain('</USER>');
  });

  it('SFX library fields written in USER block', () => {
    const meta: WavMetadata = {
      recordist: 'John Doe',
      microphone: 'Sennheiser MKH 416',
      micPerspective: 'Close',
      location: 'Studio A',
      library: 'FieldCorderLib',
      keywords: 'ambience, wind',
    };
    const wav = encodeWav(makeOpts({ metadata: meta }));
    const xml = getIXMLString(wav);
    expect(xml).toContain('<RECORDIST>John Doe</RECORDIST>');
    expect(xml).toContain('<MICROPHONE>Sennheiser MKH 416</MICROPHONE>');
    expect(xml).toContain('<MIC_PERSPECTIVE>Close</MIC_PERSPECTIVE>');
    expect(xml).toContain('<LOCATION>Studio A</LOCATION>');
    expect(xml).toContain('<LIBRARY>FieldCorderLib</LIBRARY>');
    expect(xml).toContain('<KEYWORDS>ambience, wind</KEYWORDS>');
  });

  it('XML-escapes special characters', () => {
    const meta: WavMetadata = {
      project: 'A & B <"test">',
    };
    const wav = encodeWav(makeOpts({ metadata: meta }));
    const xml = getIXMLString(wav);
    expect(xml).toContain('A &amp; B &lt;&quot;test&quot;&gt;');
  });

  it('no USER block when no UCS/SFX fields', () => {
    const wav = encodeWav(makeOpts({ metadata: { project: 'X' } }));
    const xml = getIXMLString(wav);
    expect(xml).not.toContain('<USER>');
  });
});

// ── RIFF word alignment ──────────────────────────────────────────────────

describe('WavEncoder — RIFF alignment', () => {
  it('total file size is consistent (all chunks accounted for)', () => {
    const meta: WavMetadata = { description: 'Pad test', project: 'Align' };
    const wav = encodeWav(makeOpts({ metadata: meta }));
    const chunks = parseChunks(wav);

    let computed = 12; // RIFF header
    for (const [, chunk] of chunks) {
      computed += 8 + chunk.size + (chunk.size & 1); // header + data + padding
    }
    expect(computed).toBe(wav.byteLength);
  });

  it('chunk data after odd-sized bext starts at even boundary', () => {
    // Fabricate metadata that yields odd-length bext
    const meta: WavMetadata = { description: 'x' };
    const wav = encodeWav(makeOpts({ metadata: meta }));
    const chunks = parseChunks(wav);
    const bext = chunks.get('bext')!;
    const bextEnd = bext.offset + bext.size;
    const nextChunkStart = bext.offset - 8 + 8 + bext.size + (bext.size & 1);
    // Next chunk should start at even offset
    expect(nextChunkStart % 2).toBe(0);
  });
});

// ── Edge cases ───────────────────────────────────────────────────────────

describe('WavEncoder — edge cases', () => {
  it('zero-length channels produce valid WAV with 0-byte data', () => {
    const wav = encodeWav({ sampleRate: 44100, bitDepth: 16, channels: [new Float32Array(0)] });
    const chunks = parseChunks(wav);
    expect(chunks.get('data')!.size).toBe(0);
    // Still has valid RIFF header
    expect(readString(wav, 0, 4)).toBe('RIFF');
  });

  it('single-sample mono 16-bit produces 2-byte data chunk', () => {
    const wav = encodeWav({ sampleRate: 44100, bitDepth: 16, channels: [new Float32Array([0.5])] });
    const chunks = parseChunks(wav);
    expect(chunks.get('data')!.size).toBe(2);
  });

  it('high sample rate (192kHz) written correctly', () => {
    const wav = encodeWav({ sampleRate: 192000, bitDepth: 24, channels: [makeSine(10, 440, 192000)] });
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    const off = parseChunks(wav).get('fmt ')!.offset;
    expect(view.getUint32(off + 4, true)).toBe(192000);
  });
});

// ── Async version ────────────────────────────────────────────────────────

describe('encodeWavAsync', () => {
  it('produces identical output to sync encodeWav (32-bit, no dither)', async () => {
    const opts: WavEncodeOptions = {
      sampleRate: 44100,
      bitDepth: 32,
      channels: [makeSine(500)],
    };

    const syncResult = encodeWav(opts);
    const asyncResult = await encodeWavAsync(opts);

    expect(asyncResult.byteLength).toBe(syncResult.byteLength);
    // Byte-for-byte identical (32-bit float, no dither randomness)
    for (let i = 0; i < syncResult.byteLength; i++) {
      expect(asyncResult[i]).toBe(syncResult[i]);
    }
  });

  it('calls progress callback with values between 0 and 1', async () => {
    const progressValues: number[] = [];
    await encodeWavAsync(
      { sampleRate: 44100, bitDepth: 16, channels: [makeSine(200)] },
      (p) => progressValues.push(p),
    );

    expect(progressValues.length).toBeGreaterThan(0);
    expect(progressValues[progressValues.length - 1]).toBe(1);
    for (const v of progressValues) {
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('progress reaches 1.0 for large data (multiple chunks)', async () => {
    const progressValues: number[] = [];
    // 100k samples > CHUNK=50000 → at least 2 progress updates
    await encodeWavAsync(
      { sampleRate: 44100, bitDepth: 16, channels: [makeSine(100000)] },
      (p) => progressValues.push(p),
    );

    expect(progressValues.length).toBeGreaterThanOrEqual(2);
    expect(progressValues[progressValues.length - 1]).toBe(1);
    // Values should be monotonically increasing
    for (let i = 1; i < progressValues.length; i++) {
      expect(progressValues[i]).toBeGreaterThanOrEqual(progressValues[i - 1]);
    }
  });

  it('includes metadata chunks in async output', async () => {
    const opts: WavEncodeOptions = {
      sampleRate: 44100,
      bitDepth: 16,
      channels: [makeSine(100)],
      metadata: { project: 'AsyncTest', scene: '1' },
    };
    const wav = await encodeWavAsync(opts);
    const chunks = parseChunks(wav);
    expect(chunks.has('bext')).toBe(true);
    expect(chunks.has('iXML')).toBe(true);

    const ixmlOff = chunks.get('iXML')!.offset;
    const ixmlSize = chunks.get('iXML')!.size;
    const xml = new TextDecoder().decode(wav.slice(ixmlOff, ixmlOff + ixmlSize));
    expect(xml).toContain('<PROJECT>AsyncTest</PROJECT>');
  });

  it('async 16-bit sample values match sync (no dither)', async () => {
    const samples = new Float32Array([0.0, 0.5, -0.5, 1.0, -1.0]);
    const opts: WavEncodeOptions = {
      sampleRate: 44100,
      bitDepth: 16,
      channels: [samples],
      dither: 'none',
    };

    const syncWav = encodeWav(opts);
    const asyncWav = await encodeWavAsync(opts);

    const syncOff = parseChunks(syncWav).get('data')!.offset;
    const asyncOff = parseChunks(asyncWav).get('data')!.offset;
    const syncView = new DataView(syncWav.buffer, syncWav.byteOffset, syncWav.byteLength);
    const asyncView = new DataView(asyncWav.buffer, asyncWav.byteOffset, asyncWav.byteLength);

    for (let i = 0; i < samples.length; i++) {
      expect(asyncView.getInt16(asyncOff + i * 2, true)).toBe(
        syncView.getInt16(syncOff + i * 2, true),
      );
    }
  });
});
