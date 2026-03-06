/**
 * MP3 encoder with resampling, multi-channel downmix, and ID3v2.3 tags.
 *
 * Uses @breezystack/lamejs (LGPL-3.0) for MPEG Layer III encoding.
 * Supports bitrates 128/192/256/320 kbps.
 *
 * Features:
 * - Automatic resampling to nearest MP3-supported sample rate
 * - Multi-channel (>2) downmix to stereo via L/R interleave summing
 * - ID3v2.3 metadata tags (TIT2, TPE1, COMM, TDRC)
 * - Async chunked encoding with progress callback (non-blocking)
 *
 * Usage:
 *   const mp3 = await encodeMp3Async({
 *     sampleRate: 96000,
 *     channels: [leftFloat32, rightFloat32],
 *     bitrate: 320,
 *     metadata: { title: 'Rain_Forest', artist: 'FieldCorder' },
 *   }, p => console.log(p));
 */

import { Mp3Encoder as LameMp3Encoder } from '@breezystack/lamejs';

// ── Public types ──────────────────────────────────────────────────────────

export interface Mp3Metadata {
  /** Song/file title -> ID3v2 TIT2 frame */
  title?: string;
  /** Artist/originator -> ID3v2 TPE1 frame */
  artist?: string;
  /** Comment/description -> ID3v2 COMM frame */
  comment?: string;
  /** Recording date -> ID3v2 TDRC frame */
  date?: string;
}

export interface Mp3EncodeOptions {
  /** Source sample rate in Hz */
  sampleRate: number;
  /** Audio channel data (Float32, normalized to [-1, 1]) */
  channels: Float32Array[];
  /** MP3 bitrate in kbps */
  bitrate: 128 | 192 | 256 | 320;
  /** Optional ID3v2.3 metadata */
  metadata?: Mp3Metadata;
}

// ── Supported MP3 sample rates ────────────────────────────────────────────

const MP3_SAMPLE_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];

/**
 * Find the nearest MP3-supported sample rate.
 * If the source rate is already supported, returns it unchanged.
 */
function findNearestSampleRate(sourceSampleRate: number): number {
  let best = MP3_SAMPLE_RATES[0];
  let bestDist = Math.abs(sourceSampleRate - best);

  for (let i = 1; i < MP3_SAMPLE_RATES.length; i++) {
    const dist = Math.abs(sourceSampleRate - MP3_SAMPLE_RATES[i]);
    if (dist < bestDist) {
      bestDist = dist;
      best = MP3_SAMPLE_RATES[i];
    }
  }

  return best;
}

// ── Resampling (linear interpolation) ─────────────────────────────────────

/**
 * Resample a Float32Array from one sample rate to another using linear interpolation.
 * Returns the original array if rates match.
 */
function resampleLinear(
  input: Float32Array,
  fromRate: number,
  toRate: number,
): Float32Array {
  if (fromRate === toRate) return input;

  const ratio = fromRate / toRate;
  const outputLength = Math.round(input.length / ratio);
  const output = new Float32Array(outputLength);

  for (let i = 0; i < outputLength; i++) {
    const srcPos = i * ratio;
    const srcIndex = Math.floor(srcPos);
    const frac = srcPos - srcIndex;

    const s0 = input[srcIndex];
    const s1 = srcIndex + 1 < input.length ? input[srcIndex + 1] : s0;
    output[i] = s0 + (s1 - s0) * frac;
  }

  return output;
}

// ── Multi-channel downmix ─────────────────────────────────────────────────

/**
 * Downmix >2 channels to stereo.
 * L_out = (ch0 + ch2 + ch4 + ...) / sqrt(N/2)
 * R_out = (ch1 + ch3 + ch5 + ...) / sqrt(N/2)
 *
 * For mono input, duplicates to both channels.
 * For stereo input, returns as-is.
 */
function downmixToStereo(channels: Float32Array[]): [Float32Array, Float32Array] {
  const numChannels = channels.length;
  const numSamples = channels[0].length;

  if (numChannels === 1) {
    // Mono: duplicate to L and R
    return [channels[0], channels[0]];
  }

  if (numChannels === 2) {
    return [channels[0], channels[1]];
  }

  // >2 channels: interleave-sum with sqrt(N/2) normalization
  const left = new Float32Array(numSamples);
  const right = new Float32Array(numSamples);
  const halfN = numChannels / 2;
  const scale = 1.0 / Math.sqrt(halfN);

  for (let i = 0; i < numSamples; i++) {
    let lSum = 0;
    let rSum = 0;
    for (let c = 0; c < numChannels; c++) {
      if (c % 2 === 0) {
        lSum += channels[c][i];
      } else {
        rSum += channels[c][i];
      }
    }
    left[i] = lSum * scale;
    right[i] = rSum * scale;
  }

  return [left, right];
}

// ── Float32 to Int16 conversion ───────────────────────────────────────────

/**
 * Convert Float32Array [-1, 1] to Int16Array [-32768, 32767].
 */
function floatToInt16(input: Float32Array): Int16Array {
  const output = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    output[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7FFF);
  }
  return output;
}

// ── ID3v2.3 tag builder ───────────────────────────────────────────────────

/**
 * Encode a string as ISO-8859-1 bytes (ID3v2 default encoding).
 */
function encodeISO8859(str: string): Uint8Array {
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) {
    bytes[i] = str.charCodeAt(i) & 0xFF;
  }
  return bytes;
}

/**
 * Build an ID3v2.3 text frame (TIT2, TPE1, TDRC, etc.).
 * Frame layout: [ID(4)] [Size(4)] [Flags(2)] [Encoding(1)] [Text]
 */
function buildTextFrame(frameId: string, text: string): Uint8Array {
  const textBytes = encodeISO8859(text);
  // Size = 1 (encoding byte) + text length
  const frameSize = 1 + textBytes.length;
  const frame = new Uint8Array(10 + frameSize);
  const view = new DataView(frame.buffer);

  // Frame ID (4 bytes, ASCII)
  for (let i = 0; i < 4; i++) {
    frame[i] = frameId.charCodeAt(i);
  }

  // Frame size (4 bytes, big-endian, excludes header)
  view.setUint32(4, frameSize, false);

  // Flags (2 bytes, all zero)
  frame[8] = 0;
  frame[9] = 0;

  // Encoding: 0 = ISO-8859-1
  frame[10] = 0;

  // Text data
  frame.set(textBytes, 11);

  return frame;
}

/**
 * Build an ID3v2.3 COMM (comment) frame.
 * Frame layout: [ID(4)] [Size(4)] [Flags(2)] [Encoding(1)] [Language(3)] [ShortDesc(NUL)] [Text]
 */
function buildCommentFrame(comment: string): Uint8Array {
  const textBytes = encodeISO8859(comment);
  // Size = 1 (encoding) + 3 (language) + 1 (NUL short description terminator) + text length
  const frameSize = 1 + 3 + 1 + textBytes.length;
  const frame = new Uint8Array(10 + frameSize);
  const view = new DataView(frame.buffer);

  // Frame ID
  frame[0] = 0x43; // C
  frame[1] = 0x4F; // O
  frame[2] = 0x4D; // M
  frame[3] = 0x4D; // M

  // Frame size (big-endian)
  view.setUint32(4, frameSize, false);

  // Flags
  frame[8] = 0;
  frame[9] = 0;

  // Encoding: ISO-8859-1
  frame[10] = 0;

  // Language: "eng"
  frame[11] = 0x65; // e
  frame[12] = 0x6E; // n
  frame[13] = 0x67; // g

  // Short description: empty (NUL terminated)
  frame[14] = 0;

  // Comment text
  frame.set(textBytes, 15);

  return frame;
}

/**
 * Build a complete ID3v2.3 tag from metadata.
 * Returns null if no metadata fields are set.
 *
 * ID3v2.3 header layout:
 * [ID3(3)] [Version(2)] [Flags(1)] [Size(4, syncsafe)]
 */
function buildID3v2Tag(metadata: Mp3Metadata): Uint8Array | null {
  const frames: Uint8Array[] = [];

  if (metadata.title) {
    frames.push(buildTextFrame('TIT2', metadata.title));
  }
  if (metadata.artist) {
    frames.push(buildTextFrame('TPE1', metadata.artist));
  }
  if (metadata.comment) {
    frames.push(buildCommentFrame(metadata.comment));
  }
  if (metadata.date) {
    frames.push(buildTextFrame('TDRC', metadata.date));
  }

  if (frames.length === 0) return null;

  // Calculate total frames size
  let framesSize = 0;
  for (const f of frames) {
    framesSize += f.length;
  }

  // ID3v2.3 header = 10 bytes
  const tag = new Uint8Array(10 + framesSize);
  const view = new DataView(tag.buffer);

  // "ID3"
  tag[0] = 0x49; // I
  tag[1] = 0x44; // D
  tag[2] = 0x33; // 3

  // Version: ID3v2.3.0
  tag[3] = 3; // major version
  tag[4] = 0; // revision

  // Flags: none
  tag[5] = 0;

  // Size: syncsafe integer (28 bits, each byte uses 7 bits)
  const size = framesSize;
  tag[6] = (size >> 21) & 0x7F;
  tag[7] = (size >> 14) & 0x7F;
  tag[8] = (size >> 7) & 0x7F;
  tag[9] = size & 0x7F;

  // Write frames
  let offset = 10;
  for (const f of frames) {
    tag.set(f, offset);
    offset += f.length;
  }

  return tag;
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Encode audio channels to MP3 asynchronously with progress reporting.
 *
 * Handles resampling (if source rate is unsupported), multi-channel downmix
 * (>2 channels to stereo), and optional ID3v2.3 metadata tagging.
 *
 * @param opts - Encoding options (sample rate, channels, bitrate, metadata)
 * @param onProgress - Optional callback receiving progress 0..1
 * @returns Complete MP3 file as Uint8Array (with ID3v2 tag prepended if metadata given)
 */
export async function encodeMp3Async(
  opts: Mp3EncodeOptions,
  onProgress?: (progress: number) => void,
): Promise<Uint8Array> {
  const { sampleRate, channels, bitrate, metadata } = opts;

  if (channels.length === 0 || channels[0].length === 0) {
    return new Uint8Array(0);
  }

  // 1. Downmix to stereo if needed
  const [leftRaw, rightRaw] = downmixToStereo(channels);

  // 2. Resample to nearest MP3-supported rate if needed
  const targetRate = findNearestSampleRate(sampleRate);
  const leftResampled = resampleLinear(leftRaw, sampleRate, targetRate);
  const rightResampled = resampleLinear(rightRaw, sampleRate, targetRate);

  // 3. Convert Float32 -> Int16 for lamejs
  const leftInt16 = floatToInt16(leftResampled);
  const rightInt16 = floatToInt16(rightResampled);

  // 4. Encode MP3 in chunks (yield to main thread between chunks)
  const numChannels = channels.length === 1 ? 1 : 2;
  const encoder = new LameMp3Encoder(numChannels, targetRate, bitrate);

  const CHUNK_SIZE = 1152 * 8; // Process 8 MPEG frames at a time
  const totalSamples = leftInt16.length;
  const mp3Chunks: Uint8Array[] = [];

  for (let offset = 0; offset < totalSamples; offset += CHUNK_SIZE) {
    const end = Math.min(offset + CHUNK_SIZE, totalSamples);
    const leftSlice = leftInt16.subarray(offset, end);

    let mp3Buf: Uint8Array;
    if (numChannels === 1) {
      mp3Buf = encoder.encodeBuffer(leftSlice);
    } else {
      const rightSlice = rightInt16.subarray(offset, end);
      mp3Buf = encoder.encodeBuffer(leftSlice, rightSlice);
    }

    if (mp3Buf.length > 0) {
      mp3Chunks.push(mp3Buf);
    }

    onProgress?.(end / totalSamples);

    // Yield to main thread periodically
    if (end < totalSamples) {
      await new Promise<void>(r => setTimeout(r, 0));
    }
  }

  // Flush remaining MP3 data
  const flushBuf = encoder.flush();
  if (flushBuf.length > 0) {
    mp3Chunks.push(flushBuf);
  }

  // 5. Build ID3v2.3 tag if metadata provided
  const id3Tag = metadata ? buildID3v2Tag(metadata) : null;

  // 6. Concatenate all parts: [ID3v2 tag] + [MP3 frames]
  let totalLength = 0;
  if (id3Tag) totalLength += id3Tag.length;
  for (const chunk of mp3Chunks) {
    totalLength += chunk.length;
  }

  const result = new Uint8Array(totalLength);
  let writeOffset = 0;

  if (id3Tag) {
    result.set(id3Tag, writeOffset);
    writeOffset += id3Tag.length;
  }

  for (const chunk of mp3Chunks) {
    result.set(chunk, writeOffset);
    writeOffset += chunk.length;
  }

  return result;
}
