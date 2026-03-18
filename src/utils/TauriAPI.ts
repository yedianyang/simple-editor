import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { open, save, confirm } from '@tauri-apps/plugin-dialog';
import { writeFile as fsWriteFile } from '@tauri-apps/plugin-fs';

/**
 * Unified application API that wraps Tauri IPC calls.
 * Provides the same interface shape as the old electronAPI so
 * existing UI code can migrate with minimal changes.
 */
/**
 * Parsed audio data returned by the Rust WAV parser.
 * Samples are flattened: [ch0_all_samples, ch1_all_samples, ...]
 */
export interface ParsedAudioData {
  sample_rate: number;
  channels: number;
  num_samples: number;
  bits_per_sample: number;
  samples: Float32Array;
}

export interface AudioFileInfo {
  path: string;
  name: string;
  size: number;
  extension: string;
}

/** Metadata from WAV file header chunks (BEXT, iXML, fmt). */
export interface AudioFileMeta {
  path: string;
  name: string;
  extension: string;
  size: number;
  // WAV-specific (null for non-WAV)
  channels: number | null;
  sample_rate: number | null;
  bits_per_sample: number | null;
  duration_secs: number | null;
  // BWF BEXT metadata
  bext_description: string | null;
  bext_originator: string | null;
  bext_originator_ref: string | null;
  bext_date: string | null;
  bext_time: string | null;
  bext_coding_history: string | null;
  // iXML raw content
  ixml: string | null;
}

export interface AppAPI {
  // File system
  /** @deprecated Use readLargeFile() or readLargeAudioFile() for large files. */
  readFile(path: string): Promise<ArrayBuffer>;
  writeFile(path: string, data: ArrayBuffer): Promise<void>;
  writeFileText(path: string, text: string): Promise<void>;
  readFileText(path: string): Promise<string>;

  // Audio file parsing (Rust WAV decoder — returns Float32 PCM directly)
  readLargeAudioFile(path: string): Promise<ParsedAudioData>;

  // Dialogs
  showSaveDialog(options: SaveDialogOptions): Promise<string | null>;
  showOpenDialog(options: OpenDialogOptions): Promise<string[] | null>;
  showConfirmDialog(title: string, message: string): Promise<boolean>;

  // Plugin system (stubs — no native VST/AU in Tauri yet)
  scanPlugins(): Promise<any[]>;
  loadPlugin(pluginPath: string): Promise<any>;
  processAudio(pluginId: string, audioData: Float32Array[], sampleRate: number): Promise<any>;
  getPluginParameters(pluginId: string): Promise<any>;
  setPluginParameter(pluginId: string, paramId: number, value: number): Promise<any>;
  unloadPlugin(pluginId: string): Promise<any>;

  // Audio devices
  getAudioDevices(): Promise<any>;

  // Event listeners — return unlisten functions
  onImportFiles(callback: (filePaths: string[]) => void): Promise<UnlistenFn>;
  onProjectLoad(callback: (data: string) => void): Promise<UnlistenFn>;
  onPluginsScanResult(callback: (plugins: any[]) => void): Promise<UnlistenFn>;
  onPluginsAddPath(callback: (path: string) => void): Promise<UnlistenFn>;
  onMenuAction(action: string, callback: (...args: any[]) => void): Promise<UnlistenFn>;

  // Folder scanning
  scanFolder(path: string): Promise<AudioFileInfo[]>;
  openFolderDialog(): Promise<string>;

  // Audio metadata (header-only, no PCM loading)
  readFileMetadata(path: string): Promise<AudioFileMeta>;
  scanAudioFolder(path: string): Promise<AudioFileMeta[]>;

  // DeepFilterNet noise reduction (binary IPC)
  denoiseDeepFilter(samples: Float32Array, params: {
    denoise: number;    // 0.0-1.0
    dereverb: number;   // 0.0-1.0
    dry: number;        // 0.0-1.0
    sample_rate: number;
    num_samples: number;
    use_gpu: boolean;
  }): Promise<ArrayBuffer>;

  // Large file reading via custom protocol (raw bytes)
  readLargeFile(path: string): Promise<ArrayBuffer>;

  // Platform info
  platform: string;
}

export interface SaveDialogOptions {
  title?: string;
  defaultPath?: string;
  filters?: Array<{ name: string; extensions: string[] }>;
}

export interface OpenDialogOptions {
  title?: string;
  defaultPath?: string;
  filters?: Array<{ name: string; extensions: string[] }>;
  multiple?: boolean;
  directory?: boolean;
}

/**
 * Create the Tauri-backed AppAPI implementation.
 */
export function createTauriAPI(): AppAPI {
  return {
    // ── File system ───────────────────────────────────────────────
    /** @deprecated For large audio files, use readLargeFile() (localfile:// protocol) or readLargeAudioFile() (Rust WAV parser) instead. This method serializes bytes as JSON array and is unsuitable for files > ~50MB. */
    async readFile(path: string): Promise<ArrayBuffer> {
      const bytes: number[] = await invoke('read_file_bytes', { path });
      return new Uint8Array(bytes).buffer;
    },

    async writeFile(path: string, data: ArrayBuffer): Promise<void> {
      const bytes = new Uint8Array(data);
      const expectedSize = bytes.byteLength;

      try {
        await fsWriteFile(path, bytes);
      } catch (e) {
        // Fallback: raw binary IPC — sends bytes directly without JSON serialization
        console.warn('[writeFile] plugin-fs failed, using binary IPC fallback:', e);
        const writtenSize = await invoke<number>(
          'write_binary_file',
          bytes,
          { headers: { 'x-file-path': path } }
        );
        if (writtenSize !== expectedSize) {
          throw new Error(
            `Binary write size mismatch: expected ${expectedSize}, got ${writtenSize}`
          );
        }
      }

      // Verify written file size matches expected
      const info = await invoke<{ exists: boolean; size: number; is_dir: boolean }>(
        'file_info', { path }
      );
      if (!info.exists) {
        throw new Error(`File verification failed: ${path} not found after write`);
      }
      console.log(`[writeFile] verified: expected=${expectedSize}, actual=${info.size}`);
      if (info.size !== expectedSize) {
        throw new Error(
          `File size verification failed: expected ${expectedSize} bytes, wrote ${info.size}`
        );
      }
    },

    async readFileText(path: string): Promise<string> {
      return invoke('read_file_text', { path });
    },

    async writeFileText(path: string, text: string): Promise<void> {
      const bytes = new TextEncoder().encode(text);
      await invoke('write_file', { path, contents: Array.from(bytes) });
    },

    // ── Audio file parsing (Rust WAV decoder — binary IPC) ─────────
    async readLargeAudioFile(path: string): Promise<ParsedAudioData> {
      // Rust returns tauri::ipc::Response (raw bytes) → JS receives ArrayBuffer.
      // Binary layout:
      //   [0..4]   sample_rate: u32 LE
      //   [4..6]   num_channels: u16 LE
      //   [6..8]   bits_per_sample: u16 LE
      //   [8..16]  num_samples: u64 LE
      //   [16..]   raw f32 PCM, channel-sequential
      const buf: ArrayBuffer = await invoke('read_audio_file_binary', { path });
      const header = new DataView(buf, 0, 16);
      const sample_rate = header.getUint32(0, true);
      const channels = header.getUint16(4, true);
      const bits_per_sample = header.getUint16(6, true);
      const num_samples = Number(header.getBigUint64(8, true));

      // Zero-copy Float32Array view over the PCM data (starts at byte 16)
      const samples = new Float32Array(buf, 16);

      return { sample_rate, channels, num_samples, bits_per_sample, samples };
    },

    // ── Dialogs ───────────────────────────────────────────────────
    async showSaveDialog(options: SaveDialogOptions): Promise<string | null> {
      const result = await save({
        title: options.title,
        defaultPath: options.defaultPath,
        filters: options.filters?.map(f => ({
          name: f.name,
          extensions: f.extensions,
        })),
      });
      return result ?? null;
    },

    async showConfirmDialog(title: string, message: string): Promise<boolean> {
      return confirm(message, { title, kind: 'warning' });
    },

    async showOpenDialog(options: OpenDialogOptions): Promise<string[] | null> {
      const result = await open({
        title: options.title,
        defaultPath: options.defaultPath,
        multiple: options.multiple ?? false,
        directory: options.directory ?? false,
        filters: options.filters?.map(f => ({
          name: f.name,
          extensions: f.extensions,
        })),
      });

      if (result === null) return null;
      // open() returns string | string[] depending on `multiple`
      if (Array.isArray(result)) return result;
      return [result];
    },

    // ── Plugin system (Web Audio fallback — no native hosting) ────
    async scanPlugins(): Promise<any[]> {
      console.warn('[TauriAPI] scanPlugins: native plugin scanning not available');
      return [];
    },

    async loadPlugin(_pluginPath: string): Promise<any> {
      return { error: 'Native plugin hosting not available in Tauri build' };
    },

    async processAudio(_pluginId: string, _audioData: Float32Array[], _sampleRate: number): Promise<any> {
      return { error: 'Native audio processing not available' };
    },

    async getPluginParameters(_pluginId: string): Promise<any> {
      return { error: 'Not available' };
    },

    async setPluginParameter(_pluginId: string, _paramId: number, _value: number): Promise<any> {
      return { error: 'Not available' };
    },

    async unloadPlugin(_pluginId: string): Promise<any> {
      return { error: 'Not available' };
    },

    // ── Audio devices ─────────────────────────────────────────────
    async getAudioDevices(): Promise<any> {
      // Web Audio API manages devices directly; no native enumeration needed
      return [];
    },

    // ── Event listeners ───────────────────────────────────────────
    async onImportFiles(callback: (filePaths: string[]) => void): Promise<UnlistenFn> {
      return listen<string[]>('files:import', (event) => callback(event.payload));
    },

    async onProjectLoad(callback: (data: string) => void): Promise<UnlistenFn> {
      return listen<string>('project:load', (event) => callback(event.payload));
    },

    async onPluginsScanResult(callback: (plugins: any[]) => void): Promise<UnlistenFn> {
      return listen<any[]>('plugins:scan-result', (event) => callback(event.payload));
    },

    async onPluginsAddPath(callback: (path: string) => void): Promise<UnlistenFn> {
      return listen<string>('plugins:add-path', (event) => callback(event.payload));
    },

    async onMenuAction(action: string, callback: (...args: any[]) => void): Promise<UnlistenFn> {
      return listen<any[]>(`menu:${action}`, (event) => {
        const args = Array.isArray(event.payload) ? event.payload : [event.payload];
        callback(...args);
      });
    },

    // ── Folder scanning ──────────────────────────────────────────────
    async scanFolder(path: string): Promise<AudioFileInfo[]> {
      return invoke<AudioFileInfo[]>('scan_folder', { path });
    },

    async openFolderDialog(): Promise<string> {
      return invoke<string>('open_folder_dialog');
    },

    // ── Audio metadata (header-only) ──────────────────────────────
    async readFileMetadata(path: string): Promise<AudioFileMeta> {
      return invoke<AudioFileMeta>('read_file_metadata', { path });
    },

    async scanAudioFolder(path: string): Promise<AudioFileMeta[]> {
      return invoke<AudioFileMeta[]>('scan_audio_folder', { path });
    },

    // ── DeepFilterNet noise reduction (binary IPC) ───────────────
    async denoiseDeepFilter(samples: Float32Array, params: {
      denoise: number;
      dereverb: number;
      dry: number;
      sample_rate: number;
      num_samples: number;
    }): Promise<ArrayBuffer> {
      const paramsJson = JSON.stringify(params);
      return invoke<ArrayBuffer>('denoise_deepfilter', new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength), {
        headers: { 'x-denoise-params': paramsJson },
      });
    },

    // ── Large file via custom protocol ────────────────────────────
    async readLargeFile(path: string): Promise<ArrayBuffer> {
      const encoded = path.split('/').map(encodeURIComponent).join('/');
      const response = await fetch(`localfile://localhost${encoded}`);
      if (!response.ok) {
        throw new Error(`Failed to read file (${response.status}): ${path}`);
      }
      return response.arrayBuffer();
    },

    // ── Platform ──────────────────────────────────────────────────
    // Hardcoded: FieldCorder targets macOS only (MAS distribution).
    // If cross-platform is needed, use @tauri-apps/plugin-os instead.
    platform: 'darwin',
  };
}
