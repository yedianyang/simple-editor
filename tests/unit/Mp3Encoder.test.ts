import { describe, it, expect, vi } from 'vitest';
import { encodeMp3Async, Mp3EncodeOptions } from '../../src/core/Mp3Encoder';

// ── Helpers ──────────────────────────────────────────────────────────────

/** Create a sine wave in Float32Array. */
function makeSine(length: number, freq = 440, sampleRate = 44100): Float32Array {
  const buf = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    buf[i] = Math.sin(2 * Math.PI * freq * i / sampleRate);
  }
  return buf;
}

/** Build minimal encode options with sensible defaults. */
function makeOpts(overrides: Partial<Mp3EncodeOptions> = {}): Mp3EncodeOptions {
  const length = 44100; // 1 second at 44.1kHz
  return {
    sampleRate: 44100,
    bitrate: 128,
    channels: [makeSine(length), makeSine(length, 880)],
    ...overrides,
  };
}

/**
 * Check if output starts with a valid MP3 frame sync word.
 * MP3 frame sync: first 11 bits are all 1s → first byte is 0xFF,
 * second byte has upper 3 bits set (0xE0 mask).
 */
function hasMp3FrameSync(data: Uint8Array, offset = 0): boolean {
  if (data.length < offset + 2) return false;
  return data[offset] === 0xFF && (data[offset + 1] & 0xE0) === 0xE0;
}

/** Check if output starts with an ID3v2 header ("ID3"). */
function hasID3Header(data: Uint8Array): boolean {
  if (data.length < 3) return false;
  return data[0] === 0x49 && data[1] === 0x44 && data[2] === 0x33; // "ID3"
}

/**
 * Find the first MP3 frame sync after an ID3v2 tag.
 * Reads the syncsafe size from the ID3v2 header to skip past it.
 */
function getID3Size(data: Uint8Array): number {
  if (!hasID3Header(data) || data.length < 10) return 0;
  // Syncsafe integer at bytes 6-9
  return (
    ((data[6] & 0x7F) << 21) |
    ((data[7] & 0x7F) << 14) |
    ((data[8] & 0x7F) << 7) |
    (data[9] & 0x7F)
  ) + 10; // +10 for the header itself
}

/** Search for a string (ISO-8859-1) within a Uint8Array. */
function containsString(data: Uint8Array, str: string): boolean {
  const needle = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) {
    needle[i] = str.charCodeAt(i) & 0xFF;
  }
  outer:
  for (let i = 0; i <= data.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (data[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

// ── Basic encoding ───────────────────────────────────────────────────────

describe('Mp3Encoder — basic encoding', () => {
  it('encodes stereo 44.1kHz sine to valid MP3 output', async () => {
    const result = await encodeMp3Async(makeOpts());
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBeGreaterThan(0);
    // Without metadata, output should start with MP3 frame sync
    expect(hasMp3FrameSync(result)).toBe(true);
  });

  it('output size is reasonable for 1 second of 128kbps audio', async () => {
    const result = await encodeMp3Async(makeOpts());
    // 128kbps * 1s = 16KB. Allow some variance for framing overhead.
    const expectedBytes = (128 * 1000) / 8; // 16000 bytes
    expect(result.length).toBeGreaterThan(expectedBytes * 0.5);
    expect(result.length).toBeLessThan(expectedBytes * 2);
  });
});

// ── Bitrate variations ──────────────────────────────────────────────────

describe('Mp3Encoder — bitrate variations', () => {
  it('higher bitrates produce larger files (320 > 256 > 192 > 128)', async () => {
    const bitrates = [128, 192, 256, 320] as const;
    const sizes: number[] = [];

    for (const bitrate of bitrates) {
      const result = await encodeMp3Async(makeOpts({ bitrate }));
      sizes.push(result.length);
      // Each output must be valid MP3
      expect(hasMp3FrameSync(result)).toBe(true);
    }

    // Strict ordering: each higher bitrate produces strictly larger output
    for (let i = 1; i < sizes.length; i++) {
      expect(sizes[i]).toBeGreaterThan(sizes[i - 1]);
    }
  });
});

// ── Multi-channel downmix ───────────────────────────────────────────────

describe('Mp3Encoder — multi-channel downmix', () => {
  it('4-channel input encodes without error and produces valid MP3', async () => {
    const length = 44100;
    const channels = [
      makeSine(length, 440),
      makeSine(length, 550),
      makeSine(length, 660),
      makeSine(length, 770),
    ];
    const result = await encodeMp3Async(makeOpts({ channels }));
    expect(result.length).toBeGreaterThan(0);
    expect(hasMp3FrameSync(result)).toBe(true);
  });
});

// ── Resampling ──────────────────────────────────────────────────────────

describe('Mp3Encoder — resampling', () => {
  it('96kHz input encodes successfully and produces valid MP3', async () => {
    const length = 96000; // 1 second at 96kHz
    const channels = [makeSine(length, 440, 96000), makeSine(length, 880, 96000)];
    const result = await encodeMp3Async(makeOpts({ sampleRate: 96000, channels }));
    expect(result.length).toBeGreaterThan(0);
    expect(hasMp3FrameSync(result)).toBe(true);
  });
});

// ── ID3v2 metadata tags ─────────────────────────────────────────────────

describe('Mp3Encoder — ID3v2 tags', () => {
  it('output starts with "ID3" header when metadata is provided', async () => {
    const result = await encodeMp3Async(makeOpts({
      metadata: { title: 'Rain_Forest', artist: 'FieldCorder', comment: 'Field recording', date: '2026-03-06' },
    }));
    expect(hasID3Header(result)).toBe(true);
  });

  it('ID3 tag contains the title string', async () => {
    const result = await encodeMp3Async(makeOpts({
      metadata: { title: 'Rain_Forest' },
    }));
    expect(containsString(result, 'Rain_Forest')).toBe(true);
  });

  it('ID3 tag contains artist, comment, and date strings', async () => {
    const meta = {
      title: 'TestTitle',
      artist: 'TestArtist',
      comment: 'TestComment',
      date: '2026-03-06',
    };
    const result = await encodeMp3Async(makeOpts({ metadata: meta }));
    expect(containsString(result, 'TestArtist')).toBe(true);
    expect(containsString(result, 'TestComment')).toBe(true);
    expect(containsString(result, '2026-03-06')).toBe(true);
  });

  it('MP3 frames follow the ID3 tag (frame sync after tag)', async () => {
    const result = await encodeMp3Async(makeOpts({
      metadata: { title: 'Test' },
    }));
    const id3Size = getID3Size(result);
    expect(id3Size).toBeGreaterThan(10);
    expect(hasMp3FrameSync(result, id3Size)).toBe(true);
  });
});

// ── No metadata ─────────────────────────────────────────────────────────

describe('Mp3Encoder — no metadata', () => {
  it('output has no ID3 header and starts with 0xFF (frame sync)', async () => {
    const result = await encodeMp3Async(makeOpts());
    expect(hasID3Header(result)).toBe(false);
    expect(result[0]).toBe(0xFF);
  });

  it('empty metadata object produces no ID3 header', async () => {
    const result = await encodeMp3Async(makeOpts({ metadata: {} }));
    expect(hasID3Header(result)).toBe(false);
  });
});

// ── Progress callback ───────────────────────────────────────────────────

describe('Mp3Encoder — progress callback', () => {
  it('onProgress is called and final value is 1.0', async () => {
    const progressValues: number[] = [];
    await encodeMp3Async(makeOpts(), (p) => progressValues.push(p));

    expect(progressValues.length).toBeGreaterThan(0);
    expect(progressValues[progressValues.length - 1]).toBe(1);
  });

  it('progress values are monotonically non-decreasing', async () => {
    const progressValues: number[] = [];
    await encodeMp3Async(makeOpts(), (p) => progressValues.push(p));

    for (let i = 1; i < progressValues.length; i++) {
      expect(progressValues[i]).toBeGreaterThanOrEqual(progressValues[i - 1]);
    }
  });

  it('all progress values are in range (0, 1]', async () => {
    const progressValues: number[] = [];
    await encodeMp3Async(makeOpts(), (p) => progressValues.push(p));

    for (const v of progressValues) {
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

// ── Mono input ──────────────────────────────────────────────────────────

describe('Mp3Encoder — mono input', () => {
  it('1-channel input encodes successfully', async () => {
    const result = await encodeMp3Async(makeOpts({
      channels: [makeSine(44100)],
    }));
    expect(result.length).toBeGreaterThan(0);
    expect(hasMp3FrameSync(result)).toBe(true);
  });
});

// ── Edge cases ──────────────────────────────────────────────────────────

describe('Mp3Encoder — edge cases', () => {
  it('very short audio (100 samples) does not crash', async () => {
    const result = await encodeMp3Async(makeOpts({
      channels: [makeSine(100), makeSine(100)],
    }));
    // May produce empty or very small output, but should not throw
    expect(result).toBeInstanceOf(Uint8Array);
  });

  it('empty channels array returns empty Uint8Array', async () => {
    const result = await encodeMp3Async({
      sampleRate: 44100,
      bitrate: 128,
      channels: [],
    });
    expect(result.length).toBe(0);
  });

  it('zero-length channel data returns empty Uint8Array', async () => {
    const result = await encodeMp3Async({
      sampleRate: 44100,
      bitrate: 128,
      channels: [new Float32Array(0)],
    });
    expect(result.length).toBe(0);
  });
});
