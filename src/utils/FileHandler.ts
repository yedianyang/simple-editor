import { ExportMetadata } from '../core/types';
import type { ParsedAudioData } from './TauriAPI';

/**
 * Multi-channel audio file import/export handler.
 * Supports WAV (up to 32-bit float) and AIF formats.
 * Supports BWF BEXT chunk (EBU Tech 3285) and iXML metadata.
 */
export class FileHandler {
  static async importFile(file: File): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target!.result as ArrayBuffer);
      reader.onerror = (e) => reject(e);
      reader.readAsArrayBuffer(file);
    });
  }

  /**
   * Import file from native file path via Rust WAV decoder.
   * Returns pre-parsed Float32 PCM data — skips decodeAudioData entirely.
   * Falls back to localfile:// protocol + ArrayBuffer for non-WAV formats.
   */
  static async importFilePath(filePath: string): Promise<ParsedAudioData | ArrayBuffer> {
    if (!window.appAPI) {
      throw new Error('Native API not available');
    }

    const ext = filePath.toLowerCase().split('.').pop();
    const isWav = ext === 'wav' || ext === 'wave';

    if (isWav) {
      // Use Rust WAV parser — returns parsed Float32 PCM directly
      return window.appAPI.readLargeAudioFile(filePath);
    }

    // Non-WAV formats: read raw bytes, let decodeAudioData handle it
    return window.appAPI.readLargeFile(filePath);
  }

  // TPDF Dithering
  static ditherTPDF(bitDepth: number): number {
    const lsb = 1.0 / (1 << (bitDepth - 1));
    return (Math.random() - Math.random()) * lsb;
  }

  // Noise shaped dithering
  static createNoiseShaper(numChannels: number) {
    const errorBuffer = new Array(numChannels).fill(0);
    return {
      process: (sample: number, channel: number, bitDepth: number): number => {
        const lsb = 1.0 / (1 << (bitDepth - 1));
        const shaped = sample + errorBuffer[channel] * 0.5;
        const dithered = shaped + (Math.random() - Math.random()) * lsb;
        const scale = (1 << (bitDepth - 1)) - 1;
        const quantized = Math.round(Math.max(-1, Math.min(1, dithered)) * scale) / scale;
        errorBuffer[channel] = shaped - quantized;
        return quantized;
      }
    };
  }

  static exportWAV(audioBuffer: AudioBuffer, bitDepth = 16, dither = 'none', metadata?: ExportMetadata): Blob {
    const numChannels = audioBuffer.numberOfChannels;
    const sampleRate = audioBuffer.sampleRate;
    const length = audioBuffer.length;

    let bytesPerSample: number;
    let formatCode: number;
    if (bitDepth === 32) {
      bytesPerSample = 4;
      formatCode = 3; // Float
    } else {
      bytesPerSample = bitDepth / 8;
      formatCode = 1; // PCM
    }

    // Build optional BEXT and iXML chunks
    const bextData = metadata ? this.buildBextChunk(metadata, sampleRate, numChannels, bitDepth) : null;
    const ixmlData = metadata ? this.buildIXMLChunk(metadata, numChannels) : null;

    const bextChunkSize = bextData ? 8 + bextData.byteLength : 0;
    const ixmlChunkSize = ixmlData ? 8 + ixmlData.byteLength : 0;

    const dataSize = length * numChannels * bytesPerSample;
    const totalSize = 44 + bextChunkSize + ixmlChunkSize + dataSize;
    const buffer = new ArrayBuffer(totalSize);
    const view = new DataView(buffer);

    // RIFF header
    this.writeString(view, 0, 'RIFF');
    view.setUint32(4, totalSize - 8, true);
    this.writeString(view, 8, 'WAVE');

    // fmt chunk
    this.writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, formatCode, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * numChannels * bytesPerSample, true);
    view.setUint16(32, numChannels * bytesPerSample, true);
    view.setUint16(34, bitDepth, true);

    let offset = 36;

    // BEXT chunk (BWF Broadcast Extension)
    if (bextData) {
      this.writeString(view, offset, 'bext');
      view.setUint32(offset + 4, bextData.byteLength, true);
      new Uint8Array(buffer, offset + 8, bextData.byteLength).set(new Uint8Array(bextData));
      offset += 8 + bextData.byteLength;
    }

    // iXML chunk
    if (ixmlData) {
      this.writeString(view, offset, 'iXML');
      view.setUint32(offset + 4, ixmlData.byteLength, true);
      new Uint8Array(buffer, offset + 8, ixmlData.byteLength).set(new Uint8Array(ixmlData));
      offset += 8 + ixmlData.byteLength;
    }

    // data chunk
    this.writeString(view, offset, 'data');
    view.setUint32(offset + 4, dataSize, true);
    offset += 8;

    const channels: Float32Array[] = [];
    for (let c = 0; c < numChannels; c++) {
      channels.push(audioBuffer.getChannelData(c));
    }

    const noiseShaper = dither === 'shaped' ? this.createNoiseShaper(numChannels) : null;

    for (let i = 0; i < length; i++) {
      for (let c = 0; c < numChannels; c++) {
        let sample = channels[c][i];

        if (bitDepth === 32) {
          view.setFloat32(offset, sample, true);
        } else if (bitDepth === 24) {
          if (dither === 'tpdf') sample += this.ditherTPDF(24);
          else if (dither === 'shaped' && noiseShaper) sample = noiseShaper.process(sample, c, 24);
          const intSample = Math.round(Math.max(-1, Math.min(1, sample)) * 0x7FFFFF);
          view.setUint8(offset, intSample & 0xFF);
          view.setUint8(offset + 1, (intSample >> 8) & 0xFF);
          view.setUint8(offset + 2, (intSample >> 16) & 0xFF);
        } else {
          if (dither === 'tpdf') sample += this.ditherTPDF(16);
          else if (dither === 'shaped' && noiseShaper) sample = noiseShaper.process(sample, c, 16);
          const intSample = Math.round(Math.max(-1, Math.min(1, sample)) * 0x7FFF);
          view.setInt16(offset, intSample, true);
        }
        offset += bytesPerSample;
      }
    }

    return new Blob([buffer], { type: 'audio/wav' });
  }

  /**
   * Build BWF BEXT chunk data (EBU Tech 3285).
   * Structure: Description(256) + Originator(32) + OriginatorRef(32) +
   *            Date(10) + Time(8) + TimeRefLow(4) + TimeRefHigh(4) +
   *            Version(2) + Reserved(190) + CodingHistory(variable)
   */
  private static buildBextChunk(metadata: ExportMetadata, sampleRate: number, numChannels: number, bitDepth: number): ArrayBuffer {
    const now = new Date();
    const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;

    // Build description: combine BWF description + UCS info + keywords
    let desc = metadata.bpiDescription || '';
    if (!desc && metadata.ucsFxName) {
      desc = metadata.ucsFxName;
      if (metadata.ucsCategory) desc = `${metadata.ucsCategory} - ${metadata.ucsSubCategory}: ${desc}`;
    }

    // Build coding history per EBU R98
    const codingHistory = `A=PCM,F=${sampleRate},W=${bitDepth},M=${numChannels > 1 ? 'stereo' : 'mono'},T=FieldCorder\r\n`;
    const codingHistoryBytes = new TextEncoder().encode(codingHistory);

    // BEXT v2: 602 fixed bytes + coding history
    const fixedSize = 602;
    const totalSize = fixedSize + codingHistoryBytes.byteLength;
    const buf = new ArrayBuffer(totalSize);
    const view = new DataView(buf);
    const bytes = new Uint8Array(buf);

    // Description (256 bytes)
    const descBytes = new TextEncoder().encode(desc.slice(0, 256));
    bytes.set(descBytes, 0);

    // Originator (32 bytes) at offset 256
    const origBytes = new TextEncoder().encode((metadata.originator || 'FieldCorder').slice(0, 32));
    bytes.set(origBytes, 256);

    // OriginatorReference (32 bytes) at offset 288
    const refBytes = new TextEncoder().encode((metadata.originatorRef || '').slice(0, 32));
    bytes.set(refBytes, 288);

    // OriginationDate (10 bytes) at offset 320
    const dateBytes = new TextEncoder().encode(date);
    bytes.set(dateBytes, 320);

    // OriginationTime (8 bytes) at offset 330
    const timeBytes = new TextEncoder().encode(time);
    bytes.set(timeBytes, 330);

    // TimeReference (8 bytes) at offset 338 - set to 0 (start of file)
    view.setUint32(338, 0, true); // low
    view.setUint32(342, 0, true); // high

    // Version (2 bytes) at offset 346
    view.setUint16(346, 2, true); // BWF version 2

    // UMID (64 bytes) at offset 348 - leave as zeros

    // Loudness values (10 bytes) at offset 412 - leave as zeros for now

    // Reserved (180 bytes) at offset 422 - already zeroed

    // CodingHistory at offset 602
    bytes.set(codingHistoryBytes, fixedSize);

    return buf;
  }

  /**
   * Build iXML chunk data.
   * XML-based metadata following iXML open standard.
   */
  private static buildIXMLChunk(metadata: ExportMetadata, numChannels: number): ArrayBuffer {
    const escXml = (s: string) => s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
    xml += '<BWFXML>\n';
    xml += '  <IXML_VERSION>2.0</IXML_VERSION>\n';

    if (metadata.project) xml += `  <PROJECT>${escXml(metadata.project)}</PROJECT>\n`;
    if (metadata.scene) xml += `  <SCENE>${escXml(metadata.scene)}</SCENE>\n`;
    if (metadata.take) xml += `  <TAKE>${escXml(metadata.take)}</TAKE>\n`;
    if (metadata.tape) xml += `  <TAPE>${escXml(metadata.tape)}</TAPE>\n`;
    if (metadata.note) xml += `  <NOTE>${escXml(metadata.note)}</NOTE>\n`;
    xml += `  <CIRCLED>${metadata.circled ? 'TRUE' : 'FALSE'}</CIRCLED>\n`;
    xml += `  <WILD_TRACK>${metadata.wildTrack ? 'TRUE' : 'FALSE'}</WILD_TRACK>\n`;

    // Track list
    if (metadata.trackNames && metadata.trackNames.length > 0) {
      xml += '  <TRACK_LIST>\n';
      xml += `    <TRACK_COUNT>${numChannels}</TRACK_COUNT>\n`;
      for (let i = 0; i < numChannels; i++) {
        xml += '    <TRACK>\n';
        xml += `      <CHANNEL_INDEX>${i + 1}</CHANNEL_INDEX>\n`;
        xml += `      <INTERLEAVE_INDEX>${i + 1}</INTERLEAVE_INDEX>\n`;
        const name = (metadata.trackNames[i] || '').trim();
        if (name) xml += `      <NAME>${escXml(name)}</NAME>\n`;
        xml += '    </TRACK>\n';
      }
      xml += '  </TRACK_LIST>\n';
    }

    // UCS fields as user-defined extensions
    if (metadata.ucsCatId) {
      xml += '  <USER>\n';
      if (metadata.ucsCategory) xml += `    <UCS_CATEGORY>${escXml(metadata.ucsCategory)}</UCS_CATEGORY>\n`;
      if (metadata.ucsSubCategory) xml += `    <UCS_SUBCATEGORY>${escXml(metadata.ucsSubCategory)}</UCS_SUBCATEGORY>\n`;
      xml += `    <UCS_CATID>${escXml(metadata.ucsCatId)}</UCS_CATID>\n`;
      if (metadata.ucsFxName) xml += `    <UCS_FXNAME>${escXml(metadata.ucsFxName)}</UCS_FXNAME>\n`;
      if (metadata.ucsCreatorId) xml += `    <UCS_CREATORID>${escXml(metadata.ucsCreatorId)}</UCS_CREATORID>\n`;
      if (metadata.ucsSourceId) xml += `    <UCS_SOURCEID>${escXml(metadata.ucsSourceId)}</UCS_SOURCEID>\n`;
      xml += '  </USER>\n';
    }

    // SFX library fields as additional user data
    if (metadata.recordist || metadata.microphone || metadata.location || metadata.library || metadata.keywords) {
      if (!metadata.ucsCatId) xml += '  <USER>\n';
      else {
        // Already inside USER block - reopen isn't needed; we'll add a second USER block
        // Actually let's merge them. Rewrite approach:
      }
    }

    // Close and re-add SFX fields in a clean way
    // Let's rebuild the USER section properly
    xml = this.buildIXMLClean(metadata, numChannels);

    const encoder = new TextEncoder();
    const xmlBytes = encoder.encode(xml);

    // iXML chunk must be even-length padded
    const paddedLen = xmlBytes.byteLength + (xmlBytes.byteLength % 2);
    const buf = new ArrayBuffer(paddedLen);
    new Uint8Array(buf).set(xmlBytes);

    return buf;
  }

  /**
   * Clean iXML builder that produces the full XML string.
   */
  private static buildIXMLClean(metadata: ExportMetadata, numChannels: number): string {
    const esc = (s: string) => s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
    xml += '<BWFXML>\n';
    xml += '  <IXML_VERSION>2.0</IXML_VERSION>\n';

    if (metadata.project) xml += `  <PROJECT>${esc(metadata.project)}</PROJECT>\n`;
    if (metadata.scene) xml += `  <SCENE>${esc(metadata.scene)}</SCENE>\n`;
    if (metadata.take) xml += `  <TAKE>${esc(metadata.take)}</TAKE>\n`;
    if (metadata.tape) xml += `  <TAPE>${esc(metadata.tape)}</TAPE>\n`;
    if (metadata.note) xml += `  <NOTE>${esc(metadata.note)}</NOTE>\n`;
    xml += `  <CIRCLED>${metadata.circled ? 'TRUE' : 'FALSE'}</CIRCLED>\n`;
    xml += `  <WILD_TRACK>${metadata.wildTrack ? 'TRUE' : 'FALSE'}</WILD_TRACK>\n`;

    // Track list
    if (metadata.trackNames && metadata.trackNames.some(n => n.trim())) {
      xml += '  <TRACK_LIST>\n';
      xml += `    <TRACK_COUNT>${numChannels}</TRACK_COUNT>\n`;
      for (let i = 0; i < numChannels; i++) {
        xml += '    <TRACK>\n';
        xml += `      <CHANNEL_INDEX>${i + 1}</CHANNEL_INDEX>\n`;
        xml += `      <INTERLEAVE_INDEX>${i + 1}</INTERLEAVE_INDEX>\n`;
        const name = (metadata.trackNames[i] || '').trim();
        if (name) xml += `      <NAME>${esc(name)}</NAME>\n`;
        xml += '    </TRACK>\n';
      }
      xml += '  </TRACK_LIST>\n';
    }

    // USER block: UCS + SFX library fields
    const hasUCS = !!metadata.ucsCatId;
    const hasSFX = !!(metadata.recordist || metadata.microphone || metadata.micPerspective ||
                      metadata.location || metadata.library || metadata.keywords);

    if (hasUCS || hasSFX) {
      xml += '  <USER>\n';
      if (metadata.ucsCategory) xml += `    <UCS_CATEGORY>${esc(metadata.ucsCategory)}</UCS_CATEGORY>\n`;
      if (metadata.ucsSubCategory) xml += `    <UCS_SUBCATEGORY>${esc(metadata.ucsSubCategory)}</UCS_SUBCATEGORY>\n`;
      if (metadata.ucsCatId) xml += `    <UCS_CATID>${esc(metadata.ucsCatId)}</UCS_CATID>\n`;
      if (metadata.ucsFxName) xml += `    <UCS_FXNAME>${esc(metadata.ucsFxName)}</UCS_FXNAME>\n`;
      if (metadata.ucsCreatorId) xml += `    <UCS_CREATORID>${esc(metadata.ucsCreatorId)}</UCS_CREATORID>\n`;
      if (metadata.ucsSourceId) xml += `    <UCS_SOURCEID>${esc(metadata.ucsSourceId)}</UCS_SOURCEID>\n`;
      if (metadata.recordist) xml += `    <RECORDIST>${esc(metadata.recordist)}</RECORDIST>\n`;
      if (metadata.microphone) xml += `    <MICROPHONE>${esc(metadata.microphone)}</MICROPHONE>\n`;
      if (metadata.micPerspective) xml += `    <MIC_PERSPECTIVE>${esc(metadata.micPerspective)}</MIC_PERSPECTIVE>\n`;
      if (metadata.location) xml += `    <LOCATION>${esc(metadata.location)}</LOCATION>\n`;
      if (metadata.library) xml += `    <LIBRARY>${esc(metadata.library)}</LIBRARY>\n`;
      if (metadata.keywords) xml += `    <KEYWORDS>${esc(metadata.keywords)}</KEYWORDS>\n`;
      xml += '  </USER>\n';
    }

    xml += '</BWFXML>\n';
    return xml;
  }

  static exportAIF(audioBuffer: AudioBuffer, bitDepth = 16, dither = 'none'): Blob {
    const numChannels = audioBuffer.numberOfChannels;
    const sampleRate = audioBuffer.sampleRate;
    const length = audioBuffer.length;
    const bytesPerSample = bitDepth / 8;

    const dataSize = length * numChannels * bytesPerSample;
    const commSize = 18;
    const ssndSize = 8 + dataSize;
    const formSize = 4 + 8 + commSize + 8 + ssndSize;

    const buffer = new ArrayBuffer(12 + 8 + commSize + 8 + ssndSize);
    const view = new DataView(buffer);

    this.writeString(view, 0, 'FORM');
    view.setUint32(4, formSize, false);
    this.writeString(view, 8, 'AIFF');

    this.writeString(view, 12, 'COMM');
    view.setUint32(16, commSize, false);
    view.setInt16(20, numChannels, false);
    view.setUint32(22, length, false);
    view.setInt16(26, bitDepth, false);
    this.writeExtendedFloat(view, 28, sampleRate);

    const ssndOffset = 12 + 8 + commSize;
    this.writeString(view, ssndOffset, 'SSND');
    view.setUint32(ssndOffset + 4, ssndSize, false);
    view.setUint32(ssndOffset + 8, 0, false);
    view.setUint32(ssndOffset + 12, 0, false);

    const channels: Float32Array[] = [];
    for (let c = 0; c < numChannels; c++) {
      channels.push(audioBuffer.getChannelData(c));
    }

    const noiseShaper = dither === 'shaped' ? this.createNoiseShaper(numChannels) : null;

    let offset = ssndOffset + 16;
    for (let i = 0; i < length; i++) {
      for (let c = 0; c < numChannels; c++) {
        let sample = channels[c][i];

        if (bitDepth === 24) {
          if (dither === 'tpdf') sample += this.ditherTPDF(24);
          else if (dither === 'shaped' && noiseShaper) sample = noiseShaper.process(sample, c, 24);
          const intSample = Math.round(Math.max(-1, Math.min(1, sample)) * 0x7FFFFF);
          view.setUint8(offset, (intSample >> 16) & 0xFF);
          view.setUint8(offset + 1, (intSample >> 8) & 0xFF);
          view.setUint8(offset + 2, intSample & 0xFF);
        } else if (bitDepth === 32) {
          const intSample = Math.round(Math.max(-1, Math.min(1, sample)) * 0x7FFFFFFF);
          view.setInt32(offset, intSample, false);
        } else {
          if (dither === 'tpdf') sample += this.ditherTPDF(16);
          else if (dither === 'shaped' && noiseShaper) sample = noiseShaper.process(sample, c, 16);
          const intSample = Math.round(Math.max(-1, Math.min(1, sample)) * 0x7FFF);
          view.setInt16(offset, intSample, false);
        }
        offset += bytesPerSample;
      }
    }

    return new Blob([buffer], { type: 'audio/aiff' });
  }

  /**
   * Export individual channels as separate WAV files.
   */
  static exportChannelWAVs(audioBuffer: AudioBuffer, bitDepth = 24, dither = 'none', metadata?: ExportMetadata): Blob[] {
    const blobs: Blob[] = [];
    const ctx = new OfflineAudioContext(1, audioBuffer.length, audioBuffer.sampleRate);

    for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
      const monoBuffer = ctx.createBuffer(1, audioBuffer.length, audioBuffer.sampleRate);
      monoBuffer.getChannelData(0).set(audioBuffer.getChannelData(c));
      blobs.push(this.exportWAV(monoBuffer, bitDepth, dither, metadata));
    }
    return blobs;
  }

  private static writeString(view: DataView, offset: number, string: string): void {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  }

  private static writeExtendedFloat(view: DataView, offset: number, value: number): void {
    let exponent = 16398;
    let mantissa = value;
    while (mantissa < 32768) {
      mantissa *= 2;
      exponent--;
    }
    view.setUint16(offset, exponent, false);
    view.setUint32(offset + 2, mantissa * 65536, false);
    view.setUint32(offset + 6, 0, false);
  }
}
