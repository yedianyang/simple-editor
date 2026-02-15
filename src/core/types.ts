// Channel layout definitions for environmental/field recording
export enum ChannelLayout {
  MONO = 1,
  STEREO = 2,
  QUAD = 4,        // Front L, Front R, Rear L, Rear R
  SURROUND_51 = 6, // L, R, C, LFE, Ls, Rs
}

export const CHANNEL_NAMES: Record<number, string[]> = {
  1: ['Mono'],
  2: ['Left', 'Right'],
  4: ['Front L', 'Front R', 'Rear L', 'Rear R'],
  6: ['Left', 'Right', 'Center', 'LFE', 'Left Surr', 'Right Surr'],
};

// Channel weight for LUFS calculation per ITU-R BS.1770
export const CHANNEL_WEIGHTS: Record<number, number[]> = {
  1: [1.0],
  2: [1.0, 1.0],
  4: [1.0, 1.0, 1.41, 1.41],
  6: [1.0, 1.0, 1.0, 0.0, 1.41, 1.41],
};

// Channel colors for waveform display
export const CHANNEL_COLORS: string[] = [
  '#3b82f6', // Blue - Left / Front L
  '#10b981', // Green - Right / Front R
  '#f59e0b', // Amber - Center / Rear L
  '#ef4444', // Red - LFE / Rear R
  '#8b5cf6', // Purple - Left Surround
  '#ec4899', // Pink - Right Surround
];

export interface PluginInfo {
  id: string;
  name: string;
  path: string;
  type: 'effect' | 'instrument';
  format: 'VST3' | 'AudioUnit' | 'WebAudio';
  category?: string;
  vendor?: string;
  parameters?: PluginParameter[];
}

export interface PluginParameter {
  id: number;
  name: string;
  value: number;
  min: number;
  max: number;
  defaultValue: number;
  unit?: string;
}

export interface PluginInstance {
  id: string;
  pluginInfo: PluginInfo;
  parameters: PluginParameter[];
  bypassed: boolean;
  // For Web Audio API-based plugins
  audioNode?: AudioNode;
}

export interface ChannelStripState {
  channelIndex: number;
  name: string;
  volume: number;      // dB
  pan: number;         // -1 to 1
  mute: boolean;
  solo: boolean;
  plugins: PluginInstance[];
}

export interface MixerState {
  channels: ChannelStripState[];
  masterVolume: number;
  channelLayout: ChannelLayout;
}

export interface ProjectData {
  version: number;
  fileName: string;
  metadata: Record<string, any>;
  audio: {
    sampleRate: number;
    numberOfChannels: number;
    length: number;
    channels: string[]; // base64 encoded
  };
  cuePoints: Array<{ sample: number; name: string }>;
  mixer: MixerState;
}

export interface CuePoint {
  id: number;
  sample: number;
  number: number;
  name: string;
}

export interface Selection {
  start: number;
  end: number;
}

export interface FileQueueItem {
  id: number;
  file: File | { name: string; path: string };
  cuePoints: Array<{ sample: number; name: string }>;
  mixerState?: MixerState;
}

// Utility type for formatTime
export function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = (seconds % 60).toFixed(2);
  return `${mins}:${secs.padStart(5, '0')}`;
}

// Declare electron API on window
declare global {
  interface Window {
    electronAPI?: {
      readFile: (path: string) => Promise<Buffer>;
      writeFile: (path: string, data: Buffer) => Promise<void>;
      readFileText: (path: string) => Promise<string>;
      showSaveDialog: (options: any) => Promise<any>;
      showOpenDialog: (options: any) => Promise<any>;
      loadPlugin: (pluginPath: string) => Promise<any>;
      processAudio: (pluginId: string, audioData: Float32Array[], sampleRate: number) => Promise<any>;
      getPluginParameters: (pluginId: string) => Promise<any>;
      setPluginParameter: (pluginId: string, paramId: number, value: number) => Promise<any>;
      unloadPlugin: (pluginId: string) => Promise<any>;
      getAudioDevices: () => Promise<any>;
      onImportFiles: (callback: (filePaths: string[]) => void) => void;
      onProjectLoad: (callback: (data: string) => void) => void;
      onPluginsScanResult: (callback: (plugins: any[]) => void) => void;
      onPluginsAddPath: (callback: (path: string) => void) => void;
      onMenuAction: (action: string, callback: (...args: any[]) => void) => void;
      platform: string;
    };
  }
}
