import { CuePointManager } from '../editor/CuePointManager';

/**
 * Project save/load manager with multi-channel support.
 */
export class ProjectManager {
  static async saveProject(
    audioBuffer: AudioBuffer,
    cuePointManager: CuePointManager,
    fileName: string,
    metadata: Record<string, any> = {}
  ): Promise<string> {
    const project = {
      version: 2,
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

    for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
      const channelData = audioBuffer.getChannelData(c);
      const buffer = new ArrayBuffer(channelData.length * 4);
      new Float32Array(buffer).set(channelData);
      project.audio.channels.push(this.arrayBufferToBase64(buffer));
    }

    return JSON.stringify(project);
  }

  static async loadProject(jsonString: string, audioContext: AudioContext): Promise<{
    audioBuffer: AudioBuffer;
    cuePoints: Array<{ sample: number; name: string }>;
    fileName: string;
    metadata: Record<string, any>;
  }> {
    const project = JSON.parse(jsonString);

    if (!project.version || project.version > 2) {
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
