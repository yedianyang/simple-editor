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

export type TrackChannelCount = 1 | 2 | 4 | 6;

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

export interface SerializedTrackInsert {
  pluginId: string;
  parameters: Array<{
    id: number;
    name: string;
    value: number;
    min: number;
    max: number;
    defaultValue: number;
    unit?: string;
  }>;
  bypassed: boolean;
}

export interface SerializedTrack {
  id: string;
  inserts: SerializedTrackInsert[];
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
  tracks?: SerializedTrack[];
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
}

// ==================== BWF / iXML Metadata ====================

/**
 * BWF BEXT chunk metadata (EBU Tech 3285).
 * Standard metadata embedded in Broadcast Wave Format files.
 */
export interface BextMetadata {
  description: string;          // 256 chars max - Description of the sound
  originator: string;           // 32 chars max - Creator/application name
  originatorReference: string;  // 32 chars max - Unique identifier (USID)
  originationDate: string;      // 10 chars: yyyy-mm-dd
  originationTime: string;      // 8 chars: hh:mm:ss
  codingHistory: string;        // Encoding history text
}

/**
 * iXML metadata fields (iXML open standard).
 * Location sound & field recording metadata.
 */
export interface IXMLMetadata {
  project: string;              // Project/production name
  scene: string;                // Scene or slate identifier
  take: string;                 // Take number
  tape: string;                 // Tape/sound roll identifier
  note: string;                 // Free text notes
  circled: boolean;             // Circled (preferred) take
  wildTrack: boolean;           // Wild track (no sync to picture)
  trackList: IXMLTrack[];       // Per-track metadata
}

export interface IXMLTrack {
  channelIndex: number;
  name: string;                 // Track name (e.g. mic assignment)
  function: string;             // Channel function (LEFT, RIGHT, MID, SIDE, etc.)
}

/**
 * UCS (Universal Category System) naming metadata.
 * Standard for sound effects categorization and filename structure.
 */
export interface UCSMetadata {
  category: string;             // Top-level category (e.g. "AMBIENCE")
  subCategory: string;          // Sub-category (e.g. "FOREST")
  catId: string;                // CatID code (e.g. "AMBForst")
  fxName: string;               // Descriptive FX name
  creatorId: string;            // Creator/recordist short ID
  sourceId: string;             // Source/library ID
}

/**
 * Sound Effects metadata fields (Soundminer / professional standard).
 * Used for sound library management and search.
 */
export interface SFXMetadata {
  description: string;          // Full description of the sound
  category: string;             // UCS category
  subCategory: string;          // UCS subcategory
  recordist: string;            // Person who recorded
  designer: string;             // Sound designer
  microphone: string;           // Microphone used
  micPerspective: string;       // INT, CU, MCU, MS, DIST, etc.
  location: string;             // Recording location
  library: string;              // Library name
  keywords: string;             // Search keywords
  notes: string;                // Additional notes
}

/**
 * Combined export metadata for the metadata dialog.
 */
export interface ExportMetadata {
  // BWF BEXT fields
  bpiDescription: string;
  originator: string;
  originatorRef: string;

  // iXML fields
  project: string;
  scene: string;
  take: string;
  tape: string;
  note: string;
  circled: boolean;
  wildTrack: boolean;
  trackNames: string[];         // Per-channel track names

  // UCS naming
  ucsCategory: string;
  ucsSubCategory: string;
  ucsCatId: string;
  ucsFxName: string;
  ucsCreatorId: string;
  ucsSourceId: string;

  // SFX library fields
  recordist: string;
  microphone: string;
  micPerspective: string;
  location: string;
  library: string;
  keywords: string;
}

export const MIC_PERSPECTIVES = ['INT', 'CU', 'MCU', 'MS', 'DIST', 'AERIAL'] as const;

export function createDefaultExportMetadata(): ExportMetadata {
  return {
    bpiDescription: '',
    originator: 'FieldCorder',
    originatorRef: '',
    project: '',
    scene: '',
    take: '',
    tape: '',
    note: '',
    circled: false,
    wildTrack: false,
    trackNames: [],
    ucsCategory: '',
    ucsSubCategory: '',
    ucsCatId: '',
    ucsFxName: '',
    ucsCreatorId: '',
    ucsSourceId: '',
    recordist: '',
    microphone: '',
    micPerspective: '',
    location: '',
    library: '',
    keywords: '',
  };
}

// Utility type for formatTime
export function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = (seconds % 60).toFixed(2);
  return `${mins}:${secs.padStart(5, '0')}`;
}

// ==================== Timeline / Multi-Track ====================

export interface PooledBuffer {
  id: string;
  buffer: AudioBuffer;
  sampleRate: number;
  length: number;
  sourceFileName: string;
  sourceChannelIndex: number;
  refCount: number;
}

export interface Clip {
  id: string;
  bufferId: string;
  name: string;
  timelineOffset: number;
  sourceStart: number;
  sourceEnd: number;
  duration: number;
  gainDb: number;
  fadeInSamples: number;
  fadeOutSamples: number;
  muted: boolean;
  reversed?: boolean;
  subChannel?: number;
  groupId?: string;
}

export interface TrackInsert {
  instanceId: string;       // PluginInstance.id
  pluginId: string;         // PluginInfo.id (e.g. 'builtin:eq7')
  parameters: PluginParameter[];
  bypassed: boolean;
}

export interface Track {
  id: string;
  name: string;
  color: string;
  channels: TrackChannelCount;
  clips: Clip[];
  volume: number;
  pan: number;
  mute: boolean;
  solo: boolean;
  channelIndex: number;
  inserts: TrackInsert[];
  height: number;
}

export interface Timeline {
  sampleRate: number;
  totalLength: number;
  tracks: Track[];
  playheadSample: number;
  selectionStart: number | null;
  selectionEnd: number | null;
  selectedClipIds: string[];
  selectedTrackIds: string[];
  samplesPerPixel: number;
  scrollOffset: number;
}

export type FaderLaw = 'equalPower' | 'equalGain';

// Declare app API on window (Tauri backend)
import type { AppAPI } from '../utils/TauriAPI';

declare global {
  interface Window {
    appAPI?: AppAPI;
  }
}
