/**
 * Standalone BWF/WAV encoder with BEXT + iXML metadata support.
 *
 * Produces RIFF-compliant WAV files:
 * - WAVE_FORMAT_EXTENSIBLE for >2 channels (with channel mask + SubFormat GUID)
 * - Standard PCM/Float format for mono/stereo
 * - Proper RIFF word-alignment (padding for odd-length chunks)
 * - BEXT chunk (EBU Tech 3285 v2)
 * - iXML chunk (iXML 2.0 open standard)
 *
 * Usage:
 *   const wav = encodeWav({ sampleRate: 96000, bitDepth: 24, channels: [...] });
 *   // or async with progress:
 *   const wav = await encodeWavAsync({ ... }, p => console.log(p));
 */

// ── Channel mask constants (WAV EXTENSIBLE speaker positions) ─────────────

const CHANNEL_MASKS: Record<number, number> = {
  1: 0x4,    // Front Center (mono)
  2: 0x3,    // FL + FR
  3: 0x7,    // FL + FR + FC
  4: 0x33,   // FL + FR + BL + BR (quad)
  5: 0x37,   // FL + FR + FC + BL + BR (5.0)
  6: 0x3F,   // FL + FR + FC + LFE + BL + BR (5.1)
  7: 0x13F,  // FL + FR + FC + LFE + BL + BR + BC (6.1)
  8: 0x63F,  // FL + FR + FC + LFE + BL + BR + SL + SR (7.1)
};

// SubFormat GUIDs per KSDATAFORMAT_SUBTYPE
// {00000001-0000-0010-8000-00AA00389B71}
const SUBFORMAT_PCM = new Uint8Array([
  0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00,
  0x80, 0x00, 0x00, 0xAA, 0x00, 0x38, 0x9B, 0x71,
]);
// {00000003-0000-0010-8000-00AA00389B71}
const SUBFORMAT_IEEE_FLOAT = new Uint8Array([
  0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00,
  0x80, 0x00, 0x00, 0xAA, 0x00, 0x38, 0x9B, 0x71,
]);

// ── Public types ──────────────────────────────────────────────────────────

export interface WavMetadata {
  // BEXT fields
  description?: string;
  originator?: string;
  originatorRef?: string;
  date?: string;          // Origination date (yyyy-mm-dd) — falls back to current date if empty
  time?: string;          // Origination time (hh:mm:ss) — falls back to current time if empty

  // iXML fields
  project?: string;
  scene?: string;
  take?: string;
  tape?: string;
  note?: string;
  circled?: boolean;
  wildTrack?: boolean;
  trackNames?: string[];

  // UCS/SFX fields (written in iXML <USER> block)
  ucsCategory?: string;
  ucsSubCategory?: string;
  ucsCatId?: string;
  ucsFxName?: string;
  ucsCreatorId?: string;
  ucsSourceId?: string;
  recordist?: string;
  microphone?: string;
  micPerspective?: string;
  location?: string;
  library?: string;
  keywords?: string;
}

export interface WavEncodeOptions {
  sampleRate: number;
  bitDepth: 16 | 24 | 32;
  channels: Float32Array[];
  dither?: 'none' | 'tpdf' | 'shaped';
  metadata?: WavMetadata;
  /** Custom channel mask (overrides default layout). */
  channelMask?: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function writeString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

/** Round up to next even number. */
function padToEven(n: number): number {
  return n + (n & 1);
}

function ditherTPDF(bitDepth: number): number {
  const lsb = 1.0 / (1 << (bitDepth - 1));
  return (Math.random() - Math.random()) * lsb;
}

function createNoiseShaper(numChannels: number) {
  const err = new Float64Array(numChannels);
  return {
    process(sample: number, ch: number, bitDepth: number): number {
      const lsb = 1.0 / (1 << (bitDepth - 1));
      const shaped = sample + err[ch] * 0.5;
      const dithered = shaped + (Math.random() - Math.random()) * lsb;
      const scale = (1 << (bitDepth - 1)) - 1;
      const quantized = Math.round(Math.max(-1, Math.min(1, dithered)) * scale) / scale;
      err[ch] = shaped - quantized;
      return quantized;
    },
  };
}

// ── BEXT chunk builder (EBU Tech 3285 v2) ─────────────────────────────────

function buildBextData(opts: WavEncodeOptions, meta: WavMetadata): Uint8Array {
  const { sampleRate, bitDepth, channels } = opts;
  const numCh = channels.length;
  const enc = new TextEncoder();

  // Use user-provided date/time if available, otherwise fall back to current
  const now = new Date();
  let date: string;
  let time: string;
  if (meta.date && meta.date.length > 0) {
    date = meta.date;
  } else {
    date = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0'),
    ].join('-');
  }
  if (meta.time && meta.time.length > 0) {
    time = meta.time;
  } else {
    time = [
      String(now.getHours()).padStart(2, '0'),
      String(now.getMinutes()).padStart(2, '0'),
      String(now.getSeconds()).padStart(2, '0'),
    ].join(':');
  }

  // Description
  let desc = meta.description || '';
  if (!desc && meta.ucsFxName) {
    desc = meta.ucsFxName;
    if (meta.ucsCategory) desc = `${meta.ucsCategory} - ${meta.ucsSubCategory || ''}: ${desc}`;
  }

  // Channel mode for coding history (EBU R98)
  let mode = 'mono';
  if (numCh === 2) mode = 'stereo';
  else if (numCh > 2) mode = 'surround';

  const codingHistory = enc.encode(
    `A=PCM,F=${sampleRate},W=${bitDepth},M=${mode},T=FieldCorder\r\n`,
  );

  // BEXT v2 fixed region = 602 bytes
  const FIXED = 602;
  const total = FIXED + codingHistory.byteLength;
  const buf = new ArrayBuffer(total);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);

  // Description (256 bytes @ 0)
  bytes.set(enc.encode(desc.slice(0, 256)), 0);
  // Originator (32 bytes @ 256)
  bytes.set(enc.encode((meta.originator || 'FieldCorder').slice(0, 32)), 256);
  // OriginatorReference (32 bytes @ 288)
  bytes.set(enc.encode((meta.originatorRef || '').slice(0, 32)), 288);
  // OriginationDate (10 bytes @ 320)
  bytes.set(enc.encode(date), 320);
  // OriginationTime (8 bytes @ 330)
  bytes.set(enc.encode(time), 330);
  // TimeReference low/high (8 bytes @ 338) — 0
  view.setUint32(338, 0, true);
  view.setUint32(342, 0, true);
  // Version (2 bytes @ 346)
  view.setUint16(346, 2, true);
  // UMID (64 bytes @ 348) — zeros
  // LoudnessValue..MaxShortTermLoudness (10 bytes @ 412) — zeros
  // Reserved (180 bytes @ 422) — zeros
  // CodingHistory @ 602
  bytes.set(codingHistory, FIXED);

  return bytes;
}

// ── iXML chunk builder (iXML 2.0) ─────────────────────────────────────────

function buildIXMLData(meta: WavMetadata, numChannels: number): Uint8Array {
  const esc = (s: string) => s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<BWFXML>\n';
  xml += '  <IXML_VERSION>2.0</IXML_VERSION>\n';

  if (meta.project) xml += `  <PROJECT>${esc(meta.project)}</PROJECT>\n`;
  if (meta.scene) xml += `  <SCENE>${esc(meta.scene)}</SCENE>\n`;
  if (meta.take) xml += `  <TAKE>${esc(meta.take)}</TAKE>\n`;
  if (meta.tape) xml += `  <TAPE>${esc(meta.tape)}</TAPE>\n`;
  if (meta.note) xml += `  <NOTE>${esc(meta.note)}</NOTE>\n`;
  xml += `  <CIRCLED>${meta.circled ? 'TRUE' : 'FALSE'}</CIRCLED>\n`;
  xml += `  <WILD_TRACK>${meta.wildTrack ? 'TRUE' : 'FALSE'}</WILD_TRACK>\n`;

  // Track list
  if (meta.trackNames?.some(n => n.trim())) {
    xml += '  <TRACK_LIST>\n';
    xml += `    <TRACK_COUNT>${numChannels}</TRACK_COUNT>\n`;
    for (let i = 0; i < numChannels; i++) {
      xml += '    <TRACK>\n';
      xml += `      <CHANNEL_INDEX>${i + 1}</CHANNEL_INDEX>\n`;
      xml += `      <INTERLEAVE_INDEX>${i + 1}</INTERLEAVE_INDEX>\n`;
      const name = (meta.trackNames?.[i] || '').trim();
      if (name) xml += `      <NAME>${esc(name)}</NAME>\n`;
      xml += '    </TRACK>\n';
    }
    xml += '  </TRACK_LIST>\n';
  }

  // USER block: UCS + SFX library fields
  const hasUCS = !!meta.ucsCatId;
  const hasSFX = !!(meta.recordist || meta.microphone || meta.micPerspective ||
                    meta.location || meta.library || meta.keywords);

  if (hasUCS || hasSFX) {
    xml += '  <USER>\n';
    if (meta.ucsCategory) xml += `    <UCS_CATEGORY>${esc(meta.ucsCategory)}</UCS_CATEGORY>\n`;
    if (meta.ucsSubCategory) xml += `    <UCS_SUBCATEGORY>${esc(meta.ucsSubCategory)}</UCS_SUBCATEGORY>\n`;
    if (meta.ucsCatId) xml += `    <UCS_CATID>${esc(meta.ucsCatId)}</UCS_CATID>\n`;
    if (meta.ucsFxName) xml += `    <UCS_FXNAME>${esc(meta.ucsFxName)}</UCS_FXNAME>\n`;
    if (meta.ucsCreatorId) xml += `    <UCS_CREATORID>${esc(meta.ucsCreatorId)}</UCS_CREATORID>\n`;
    if (meta.ucsSourceId) xml += `    <UCS_SOURCEID>${esc(meta.ucsSourceId)}</UCS_SOURCEID>\n`;
    if (meta.recordist) xml += `    <RECORDIST>${esc(meta.recordist)}</RECORDIST>\n`;
    if (meta.microphone) xml += `    <MICROPHONE>${esc(meta.microphone)}</MICROPHONE>\n`;
    if (meta.micPerspective) xml += `    <MIC_PERSPECTIVE>${esc(meta.micPerspective)}</MIC_PERSPECTIVE>\n`;
    if (meta.location) xml += `    <LOCATION>${esc(meta.location)}</LOCATION>\n`;
    if (meta.library) xml += `    <LIBRARY>${esc(meta.library)}</LIBRARY>\n`;
    if (meta.keywords) xml += `    <KEYWORDS>${esc(meta.keywords)}</KEYWORDS>\n`;
    xml += '  </USER>\n';
  }

  xml += '</BWFXML>\n';
  return new TextEncoder().encode(xml);
}

// ── Sample writing ────────────────────────────────────────────────────────

function writeSamples(
  view: DataView,
  offset: number,
  channels: Float32Array[],
  bitDepth: number,
  dither: string,
  startSample: number,
  endSample: number,
): number {
  const numCh = channels.length;
  const isFloat = bitDepth === 32;
  const bytesPerSample = isFloat ? 4 : bitDepth / 8;
  const noiseShaper = dither === 'shaped' ? createNoiseShaper(numCh) : null;

  let pos = offset;
  for (let i = startSample; i < endSample; i++) {
    for (let c = 0; c < numCh; c++) {
      let s = channels[c][i];

      if (isFloat) {
        view.setFloat32(pos, s, true);
      } else if (bitDepth === 24) {
        if (dither === 'tpdf') s += ditherTPDF(24);
        else if (noiseShaper) s = noiseShaper.process(s, c, 24);
        let v = Math.round(Math.max(-1, Math.min(1, s)) * 0x7FFFFF);
        if (v < 0) v += 0x1000000;
        view.setUint8(pos, v & 0xFF);
        view.setUint8(pos + 1, (v >> 8) & 0xFF);
        view.setUint8(pos + 2, (v >> 16) & 0xFF);
      } else {
        if (dither === 'tpdf') s += ditherTPDF(16);
        else if (noiseShaper) s = noiseShaper.process(s, c, 16);
        view.setInt16(pos, Math.round(Math.max(-1, Math.min(1, s)) * 0x7FFF), true);
      }
      pos += bytesPerSample;
    }
  }
  return pos;
}

// ── Header layout ─────────────────────────────────────────────────────────

function buildHeader(
  opts: WavEncodeOptions,
  bextData: Uint8Array | null,
  ixmlData: Uint8Array | null,
): { totalSize: number; fmtDataSize: number; bextPadded: number; ixmlPadded: number; dataSize: number } {
  const { sampleRate, bitDepth, channels } = opts;
  const numCh = channels.length;
  const numSamples = channels[0]?.length ?? 0;
  const bytesPerSample = bitDepth === 32 ? 4 : bitDepth / 8;
  const useExtensible = numCh > 2;
  const fmtDataSize = useExtensible ? 40 : 16;

  const bextPadded = bextData ? padToEven(bextData.byteLength) : 0;
  const ixmlPadded = ixmlData ? padToEven(ixmlData.byteLength) : 0;
  const dataSize = numSamples * numCh * bytesPerSample;

  // 12 (RIFF header) + 8+fmt + 8+bext(padded) + 8+ixml(padded) + 8+data
  const totalSize = 12
    + 8 + fmtDataSize
    + (bextData ? 8 + bextPadded : 0)
    + (ixmlData ? 8 + ixmlPadded : 0)
    + 8 + dataSize;

  return { totalSize, fmtDataSize, bextPadded, ixmlPadded, dataSize };
}

function writeFmtChunk(
  view: DataView, bytes: Uint8Array, offset: number,
  opts: WavEncodeOptions, fmtDataSize: number,
): number {
  const { sampleRate, bitDepth, channels, channelMask } = opts;
  const numCh = channels.length;
  const bytesPerSample = bitDepth === 32 ? 4 : bitDepth / 8;
  const useExtensible = numCh > 2;
  const isFloat = bitDepth === 32;
  const formatTag = useExtensible ? 0xFFFE : (isFloat ? 3 : 1);

  writeString(view, offset, 'fmt ');
  view.setUint32(offset + 4, fmtDataSize, true);
  view.setUint16(offset + 8, formatTag, true);
  view.setUint16(offset + 10, numCh, true);
  view.setUint32(offset + 12, sampleRate, true);
  view.setUint32(offset + 16, sampleRate * numCh * bytesPerSample, true);
  view.setUint16(offset + 20, numCh * bytesPerSample, true);
  view.setUint16(offset + 22, bitDepth, true);

  if (useExtensible) {
    view.setUint16(offset + 24, 22, true);           // cbSize
    view.setUint16(offset + 26, bitDepth, true);      // wValidBitsPerSample
    const mask = channelMask ?? CHANNEL_MASKS[numCh] ?? 0;
    view.setUint32(offset + 28, mask, true);           // dwChannelMask
    bytes.set(isFloat ? SUBFORMAT_IEEE_FLOAT : SUBFORMAT_PCM, offset + 32); // SubFormat GUID
  }

  return offset + 8 + fmtDataSize;
}

function writeChunk(
  view: DataView, bytes: Uint8Array, offset: number,
  id: string, data: Uint8Array, paddedSize: number,
): number {
  writeString(view, offset, id);
  view.setUint32(offset + 4, data.byteLength, true); // actual size (not padded)
  bytes.set(data, offset + 8);
  // Padding byte (if odd) is already 0 from ArrayBuffer init
  return offset + 8 + paddedSize;
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Encode audio channels to a BWF-compliant WAV file (synchronous).
 * Returns the complete WAV as a Uint8Array.
 */
export function encodeWav(opts: WavEncodeOptions): Uint8Array {
  const { channels, bitDepth, dither = 'none', metadata } = opts;
  const numSamples = channels[0]?.length ?? 0;

  const bextData = metadata ? buildBextData(opts, metadata) : null;
  const ixmlData = metadata ? buildIXMLData(metadata, channels.length) : null;
  const layout = buildHeader(opts, bextData, ixmlData);

  const buffer = new ArrayBuffer(layout.totalSize);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  // RIFF header
  writeString(view, 0, 'RIFF');
  view.setUint32(4, layout.totalSize - 8, true);
  writeString(view, 8, 'WAVE');

  let offset = 12;

  // fmt chunk
  offset = writeFmtChunk(view, bytes, offset, opts, layout.fmtDataSize);

  // bext chunk
  if (bextData) {
    offset = writeChunk(view, bytes, offset, 'bext', bextData, layout.bextPadded);
  }

  // iXML chunk
  if (ixmlData) {
    offset = writeChunk(view, bytes, offset, 'iXML', ixmlData, layout.ixmlPadded);
  }

  // data chunk
  writeString(view, offset, 'data');
  view.setUint32(offset + 4, layout.dataSize, true);
  offset += 8;

  writeSamples(view, offset, channels, bitDepth, dither, 0, numSamples);

  return bytes;
}

/**
 * Encode audio channels to a BWF-compliant WAV file (async, yields periodically).
 * Prevents UI freezes for large files.
 */
export async function encodeWavAsync(
  opts: WavEncodeOptions,
  onProgress?: (progress: number) => void,
): Promise<Uint8Array> {
  const { channels, bitDepth, dither = 'none', metadata } = opts;
  const numCh = channels.length;
  const numSamples = channels[0]?.length ?? 0;

  const bextData = metadata ? buildBextData(opts, metadata) : null;
  const ixmlData = metadata ? buildIXMLData(metadata, channels.length) : null;
  const layout = buildHeader(opts, bextData, ixmlData);

  const buffer = new ArrayBuffer(layout.totalSize);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  // RIFF header
  writeString(view, 0, 'RIFF');
  view.setUint32(4, layout.totalSize - 8, true);
  writeString(view, 8, 'WAVE');

  let offset = 12;
  offset = writeFmtChunk(view, bytes, offset, opts, layout.fmtDataSize);
  if (bextData) offset = writeChunk(view, bytes, offset, 'bext', bextData, layout.bextPadded);
  if (ixmlData) offset = writeChunk(view, bytes, offset, 'iXML', ixmlData, layout.ixmlPadded);

  // data chunk header
  writeString(view, offset, 'data');
  view.setUint32(offset + 4, layout.dataSize, true);
  offset += 8;

  // Write samples in chunks, yielding between them
  const CHUNK = 50000;
  const isFloat = bitDepth === 32;
  const bytesPerSample = isFloat ? 4 : bitDepth / 8;
  const noiseShaper = dither === 'shaped' ? createNoiseShaper(numCh) : null;

  for (let start = 0; start < numSamples; start += CHUNK) {
    const end = Math.min(start + CHUNK, numSamples);

    for (let i = start; i < end; i++) {
      for (let c = 0; c < numCh; c++) {
        let s = channels[c][i];

        if (isFloat) {
          view.setFloat32(offset, s, true);
        } else if (bitDepth === 24) {
          if (dither === 'tpdf') s += ditherTPDF(24);
          else if (noiseShaper) s = noiseShaper.process(s, c, 24);
          let v = Math.round(Math.max(-1, Math.min(1, s)) * 0x7FFFFF);
          if (v < 0) v += 0x1000000;
          view.setUint8(offset, v & 0xFF);
          view.setUint8(offset + 1, (v >> 8) & 0xFF);
          view.setUint8(offset + 2, (v >> 16) & 0xFF);
        } else {
          if (dither === 'tpdf') s += ditherTPDF(16);
          else if (noiseShaper) s = noiseShaper.process(s, c, 16);
          view.setInt16(offset, Math.round(Math.max(-1, Math.min(1, s)) * 0x7FFF), true);
        }
        offset += bytesPerSample;
      }
    }

    onProgress?.(end / numSamples);
    if (end < numSamples) {
      await new Promise<void>(r => setTimeout(r, 0));
    }
  }

  return bytes;
}
