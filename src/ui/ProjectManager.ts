import { CuePointManager } from '../editor/CuePointManager';
import type { Track, SerializedTrack } from '../core/types';

/**
 * Project save/load manager with multi-channel support.
 */
export class ProjectManager {
  static async saveProject(
    audioBuffer: AudioBuffer,
    cuePointManager: CuePointManager,
    fileName: string,
    metadata: Record<string, any> = {},
    tracks?: Track[]
  ): Promise<string> {
    const hasInserts = tracks?.some(t => t.inserts.length > 0) ?? false;
    const version = hasInserts ? 3 : 2;

    const project: Record<string, unknown> = {
      version,
      appName: 'FieldCorder',
      fileName,
      metadata: { ...metadata, savedAt: new Date().toISOString() },
      audio: {
        sampleRate: audioBuffer.sampleRate,
        numberOfChannels: audioBuffer.numberOfChannels,
        length: audioBuffer.length,
        channels: [] as string[],
      },
      cuePoints: cuePointManager.toJSON(),
    };

    const audio = project.audio as { channels: string[] };
    for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
      const channelData = audioBuffer.getChannelData(c);
      const buffer = new ArrayBuffer(channelData.length * 4);
      new Float32Array(buffer).set(channelData);
      audio.channels.push(this.arrayBufferToBase64(buffer));
    }

    if (hasInserts && tracks) {
      project.tracks = tracks.map(t => ({
        id: t.id,
        inserts: t.inserts.map(ins => ({
          pluginId: ins.pluginId,
          parameters: ins.parameters.map(p => ({
            id: p.id,
            name: p.name,
            value: p.value,
            min: p.min,
            max: p.max,
            defaultValue: p.defaultValue,
            unit: p.unit,
          })),
          bypassed: ins.bypassed,
        })),
      }));
    }

    return JSON.stringify(project);
  }

  static async loadProject(jsonString: string, audioContext: AudioContext): Promise<{
    audioBuffer: AudioBuffer;
    cuePoints: Array<{ sample: number; name: string }>;
    fileName: string;
    metadata: Record<string, any>;
    tracks?: SerializedTrack[];
  }> {
    const project = JSON.parse(jsonString);

    if (!project.version || project.version > 3) {
      throw new Error('Unsupported project version');
    }

    const audioBuffer = audioContext.createBuffer(
      project.audio.numberOfChannels,
      project.audio.length,
      project.audio.sampleRate
    );

    for (let c = 0; c < project.audio.numberOfChannels; c++) {
      const buffer = this.base64ToArrayBuffer(project.audio.channels[c]);
      audioBuffer.getChannelData(c).set(new Float32Array(buffer));
    }

    return {
      audioBuffer,
      cuePoints: project.cuePoints,
      fileName: project.fileName,
      metadata: project.metadata || {},
      tracks: project.tracks || undefined,
    };
  }

  static arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    const chunkSize = 8192;
    const chunks: string[] = [];
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const slice = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
      chunks.push(String.fromCharCode(...slice));
    }
    return btoa(chunks.join(''));
  }

  static base64ToArrayBuffer(base64: string): ArrayBuffer {
    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes.buffer;
  }

  static downloadProject(jsonString: string, fileName: string): void {
    const baseName = fileName ? fileName.replace(/\.[^/.]+$/, '') : 'project';
    const blob = new Blob([jsonString], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = baseName + '.fcproj';
    a.click();
    URL.revokeObjectURL(url);
  }
}
