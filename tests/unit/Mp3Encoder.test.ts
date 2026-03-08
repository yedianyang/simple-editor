import { describe, it, expect, vi } from 'vitest';
import { encodeMp3Async, Mp3EncodeOptions, downmixToStereo, softLimit } from '../../src/core/Mp3Encoder';

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

// ── ITU-R BS.775-3 downmix ─────────────────────────────────────────────

describe('downmixToStereo — ITU-R BS.775-3', () => {
  const COEF = Math.SQRT1_2; // 0.7071...

  it('mono passthrough: 1ch -> L=R=input', () => {
    const ch0 = new Float32Array([0.5, -0.3, 0.8]);
    const [L, R] = downmixToStereo([ch0]);
    expect(L).toBe(ch0);
    expect(R).toBe(ch0);
  });

  it('stereo passthrough: 2ch -> L=ch0, R=ch1', () => {
    const ch0 = new Float32Array([0.5, -0.3]);
    const ch1 = new Float32Array([0.2, 0.7]);
    const [L, R] = downmixToStereo([ch0, ch1]);
    expect(L).toBe(ch0);
    expect(R).toBe(ch1);
  });

  it('3.0 downmix (L,R,C): L_out = L + 0.707*C, R_out = R + 0.707*C', () => {
    const ch0 = new Float32Array([0.5]);  // L
    const ch1 = new Float32Array([0.3]);  // R
    const ch2 = new Float32Array([0.4]);  // C
    const [L, R] = downmixToStereo([ch0, ch1, ch2]);
    // After soft limiter, values below 0.95 pass through unchanged
    expect(L[0]).toBeCloseTo(0.5 + COEF * 0.4, 5);
    expect(R[0]).toBeCloseTo(0.3 + COEF * 0.4, 5);
  });

  it('4.0 downmix (L,R,Ls,Rs): L_out = L + 0.707*Ls, R_out = R + 0.707*Rs', () => {
    const ch0 = new Float32Array([0.5]);  // L
    const ch1 = new Float32Array([0.3]);  // R
    const ch2 = new Float32Array([0.4]);  // Ls
    const ch3 = new Float32Array([0.2]);  // Rs
    const [L, R] = downmixToStereo([ch0, ch1, ch2, ch3]);
    expect(L[0]).toBeCloseTo(0.5 + COEF * 0.4, 5);
    expect(R[0]).toBeCloseTo(0.3 + COEF * 0.2, 5);
  });

  it('5.0 downmix (L,R,C,Ls,Rs): L_out = L + 0.707*C + 0.707*Ls', () => {
    const ch0 = new Float32Array([0.3]);  // L
    const ch1 = new Float32Array([0.2]);  // R
    const ch2 = new Float32Array([0.4]);  // C
    const ch3 = new Float32Array([0.1]);  // Ls
    const ch4 = new Float32Array([0.15]); // Rs
    const [L, R] = downmixToStereo([ch0, ch1, ch2, ch3, ch4]);
    expect(L[0]).toBeCloseTo(0.3 + COEF * 0.4 + COEF * 0.1, 5);
    expect(R[0]).toBeCloseTo(0.2 + COEF * 0.4 + COEF * 0.15, 5);
  });

  it('5.1 downmix (L,R,C,LFE,Ls,Rs): includes LFE at -3dB', () => {
    const ch0 = new Float32Array([0.2]);  // L
    const ch1 = new Float32Array([0.15]); // R
    const ch2 = new Float32Array([0.3]);  // C
    const ch3 = new Float32Array([0.1]);  // LFE
    const ch4 = new Float32Array([0.05]); // Ls
    const ch5 = new Float32Array([0.08]); // Rs
    const [L, R] = downmixToStereo([ch0, ch1, ch2, ch3, ch4, ch5]);
    expect(L[0]).toBeCloseTo(0.2 + COEF * 0.3 + COEF * 0.05 + COEF * 0.1, 5);
    expect(R[0]).toBeCloseTo(0.15 + COEF * 0.3 + COEF * 0.08 + COEF * 0.1, 5);
  });

  it('7.1 downmix (L,R,C,LFE,Lss,Rss,Lsr,Rsr): surround at -6dB', () => {
    const ch0 = new Float32Array([0.3]);  // L
    const ch1 = new Float32Array([0.25]); // R
    const ch2 = new Float32Array([0.4]);  // C
    const ch3 = new Float32Array([0.1]);  // LFE
    const ch4 = new Float32Array([0.2]);  // Lss
    const ch5 = new Float32Array([0.15]); // Rss
    const ch6 = new Float32Array([0.12]); // Lsr
    const ch7 = new Float32Array([0.08]); // Rsr
    const [L, R] = downmixToStereo([ch0, ch1, ch2, ch3, ch4, ch5, ch6, ch7]);
    // No LFE in 7.1 ITU downmix per spec
    expect(L[0]).toBeCloseTo(0.3 + COEF * 0.4 + 0.5 * 0.2 + 0.5 * 0.12, 5);
    expect(R[0]).toBeCloseTo(0.25 + COEF * 0.4 + 0.5 * 0.15 + 0.5 * 0.08, 5);
  });

  it('unknown channel count (9ch) does not crash and uses fallback', () => {
    const channels = Array.from({ length: 9 }, () => new Float32Array([0.1]));
    expect(() => downmixToStereo(channels)).not.toThrow();
    const [L, R] = downmixToStereo(channels);
    expect(L.length).toBe(1);
    expect(R.length).toBe(1);
    // Should produce finite values
    expect(Number.isFinite(L[0])).toBe(true);
    expect(Number.isFinite(R[0])).toBe(true);
  });
});

// ── Soft limiter ────────────────────────────────────────────────────────

describe('softLimit', () => {
  it('sample below threshold passes through unchanged', () => {
    expect(softLimit(0.5)).toBe(0.5);
    expect(softLimit(0.0)).toBe(0.0);
    expect(softLimit(-0.5)).toBe(-0.5);
    expect(softLimit(0.94)).toBe(0.94);
  });

  it('sample at 1.5 is compressed below 1.0', () => {
    const result = softLimit(1.5);
    expect(result).toBeLessThan(1.0);
    expect(result).toBeGreaterThan(0.95);
  });

  it('sample at -1.5 is compressed above -1.0', () => {
    const result = softLimit(-1.5);
    expect(result).toBeGreaterThan(-1.0);
    expect(result).toBeLessThan(-0.95);
  });

  it('preserves sign: negative inputs stay negative', () => {
    expect(softLimit(-0.3)).toBeLessThan(0);
    expect(softLimit(-1.0)).toBeLessThan(0);
    expect(softLimit(-2.0)).toBeLessThan(0);
  });

  it('at threshold boundary, output equals input', () => {
    expect(softLimit(0.95)).toBeCloseTo(0.95, 5);
    expect(softLimit(-0.95)).toBeCloseTo(-0.95, 5);
  });
});
