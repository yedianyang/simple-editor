import { contextBridge, ipcRenderer } from 'electron';

export interface ElectronAPI {
  // File system
  readFile: (path: string) => Promise<Buffer>;
  writeFile: (path: string, data: Buffer) => Promise<void>;
  readFileText: (path: string) => Promise<string>;

  // Dialogs
  showSaveDialog: (options: any) => Promise<any>;
  showOpenDialog: (options: any) => Promise<any>;

  // Plugin system
  scanPlugins: () => Promise<any>;
  loadPlugin: (pluginPath: string) => Promise<any>;
  processAudio: (pluginId: string, audioData: Float32Array[], sampleRate: number) => Promise<any>;
  getPluginParameters: (pluginId: string) => Promise<any>;
  setPluginParameter: (pluginId: string, paramId: number, value: number) => Promise<any>;
  unloadPlugin: (pluginId: string) => Promise<any>;

  // Audio devices
  getAudioDevices: () => Promise<any>;

  // Event listeners
  onImportFiles: (callback: (filePaths: string[]) => void) => void;
  onProjectLoad: (callback: (data: string) => void) => void;
  onPluginsScanResult: (callback: (plugins: any[]) => void) => void;
  onPluginsAddPath: (callback: (path: string) => void) => void;
  onMenuAction: (action: string, callback: (...args: any[]) => void) => void;

  // Platform info
  platform: string;
}

contextBridge.exposeInMainWorld('electronAPI', {
  // File system
  readFile: (path: string) => ipcRenderer.invoke('fs:read-file', path),
  writeFile: (path: string, data: Buffer) => ipcRenderer.invoke('fs:write-file', path, data),
  readFileText: (path: string) => ipcRenderer.invoke('fs:read-file-text', path),

  // Dialogs
  showSaveDialog: (options: any) => ipcRenderer.invoke('dialog:save-file', options),
  showOpenDialog: (options: any) => ipcRenderer.invoke('dialog:open-file', options),

  // Plugin system
  scanPlugins: () => ipcRenderer.invoke('plugin:scan'),
  loadPlugin: (pluginPath: string) => ipcRenderer.invoke('plugin:load', pluginPath),
  processAudio: (pluginId: string, audioData: Float32Array[], sampleRate: number) =>
    ipcRenderer.invoke('plugin:process', pluginId, audioData, sampleRate),
  getPluginParameters: (pluginId: string) => ipcRenderer.invoke('plugin:get-parameters', pluginId),
  setPluginParameter: (pluginId: string, paramId: number, value: number) =>
    ipcRenderer.invoke('plugin:set-parameter', pluginId, paramId, value),
  unloadPlugin: (pluginId: string) => ipcRenderer.invoke('plugin:unload', pluginId),

  // Audio devices
  getAudioDevices: () => ipcRenderer.invoke('audio:get-devices'),

  // Event listeners
  onImportFiles: (callback: (filePaths: string[]) => void) => {
    ipcRenderer.on('files:import', (_, filePaths) => callback(filePaths));
  },
  onProjectLoad: (callback: (data: string) => void) => {
    ipcRenderer.on('project:load', (_, data) => callback(data));
  },
  onPluginsScanResult: (callback: (plugins: any[]) => void) => {
    ipcRenderer.on('plugins:scan-result', (_, plugins) => callback(plugins));
  },
  onPluginsAddPath: (callback: (path: string) => void) => {
    ipcRenderer.on('plugins:add-path', (_, path) => callback(path));
  },
  onMenuAction: (action: string, callback: (...args: any[]) => void) => {
    ipcRenderer.on(`menu:${action}`, (_, ...args) => callback(...args));
  },

  // Platform info
  platform: process.platform,
} as ElectronAPI);
