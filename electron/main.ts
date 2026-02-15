import { app, BrowserWindow, Menu, dialog, ipcMain, shell } from 'electron';
import * as path from 'path';
import * as fs from 'fs';

let mainWindow: BrowserWindow | null = null;
let pluginHostNative: any = null;

// Try to load native plugin host module
function loadNativeModule() {
  const possiblePaths = [
    path.join(__dirname, '..', 'native', 'build', 'Release', 'fieldcorder_native.node'),
    path.join(process.resourcesPath || '', 'native', 'fieldcorder_native.node'),
  ];

  for (const modulePath of possiblePaths) {
    try {
      if (fs.existsSync(modulePath)) {
        pluginHostNative = require(modulePath);
        console.log('Native plugin host loaded from:', modulePath);
        return;
      }
    } catch (e) {
      console.warn('Failed to load native module from:', modulePath, e);
    }
  }
  console.log('Native plugin host not available - VST/AU plugins will use Web Audio API fallback');
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 12, y: 12 },
    backgroundColor: '#1a1a1a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // Load the app
  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  setupMenu();
}

function setupMenu() {
  const isMac = process.platform === 'darwin';

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' as const },
        { type: 'separator' as const },
        {
          label: 'Preferences...',
          accelerator: 'CmdOrCtrl+,',
          click: () => mainWindow?.webContents.send('menu:preferences'),
        },
        { type: 'separator' as const },
        { role: 'services' as const },
        { type: 'separator' as const },
        { role: 'hide' as const },
        { role: 'hideOthers' as const },
        { role: 'unhide' as const },
        { type: 'separator' as const },
        { role: 'quit' as const },
      ],
    }] : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Import Audio...',
          accelerator: 'CmdOrCtrl+O',
          click: () => handleImportAudio(),
        },
        {
          label: 'Import Folder...',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: () => handleImportFolder(),
        },
        { type: 'separator' },
        {
          label: 'Export...',
          accelerator: 'CmdOrCtrl+E',
          click: () => mainWindow?.webContents.send('menu:export'),
        },
        {
          label: 'Export All Channels...',
          accelerator: 'CmdOrCtrl+Shift+E',
          click: () => mainWindow?.webContents.send('menu:export-all-channels'),
        },
        { type: 'separator' },
        {
          label: 'Save Project',
          accelerator: 'CmdOrCtrl+S',
          click: () => mainWindow?.webContents.send('menu:save-project'),
        },
        {
          label: 'Load Project...',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => handleLoadProject(),
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        {
          label: 'Undo',
          accelerator: 'CmdOrCtrl+Z',
          click: () => mainWindow?.webContents.send('menu:undo'),
        },
        {
          label: 'Redo',
          accelerator: 'CmdOrCtrl+Shift+Z',
          click: () => mainWindow?.webContents.send('menu:redo'),
        },
        { type: 'separator' },
        {
          label: 'Select All',
          accelerator: 'CmdOrCtrl+A',
          click: () => mainWindow?.webContents.send('menu:select-all'),
        },
        {
          label: 'Delete Selection',
          accelerator: 'Delete',
          click: () => mainWindow?.webContents.send('menu:delete'),
        },
        { type: 'separator' },
        {
          label: 'Trim to Selection',
          accelerator: 'CmdOrCtrl+T',
          click: () => mainWindow?.webContents.send('menu:trim'),
        },
        {
          label: 'Normalize...',
          accelerator: 'CmdOrCtrl+Shift+N',
          click: () => mainWindow?.webContents.send('menu:normalize'),
        },
        {
          label: 'Fade In',
          accelerator: 'CmdOrCtrl+F',
          click: () => mainWindow?.webContents.send('menu:fade-in'),
        },
        {
          label: 'Fade Out',
          accelerator: 'CmdOrCtrl+Shift+F',
          click: () => mainWindow?.webContents.send('menu:fade-out'),
        },
        {
          label: 'Apply Gain...',
          accelerator: 'CmdOrCtrl+G',
          click: () => mainWindow?.webContents.send('menu:gain'),
        },
        {
          label: 'Reverse',
          accelerator: 'CmdOrCtrl+R',
          click: () => mainWindow?.webContents.send('menu:reverse'),
        },
      ],
    },
    {
      label: 'Transport',
      submenu: [
        {
          label: 'Play / Pause',
          accelerator: 'Space',
          click: () => mainWindow?.webContents.send('menu:play-pause'),
        },
        {
          label: 'Stop',
          accelerator: 'Escape',
          click: () => mainWindow?.webContents.send('menu:stop'),
        },
        { type: 'separator' },
        {
          label: 'Toggle Loop',
          accelerator: 'L',
          click: () => mainWindow?.webContents.send('menu:toggle-loop'),
        },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Zoom In',
          accelerator: 'CmdOrCtrl+=',
          click: () => mainWindow?.webContents.send('menu:zoom-in'),
        },
        {
          label: 'Zoom Out',
          accelerator: 'CmdOrCtrl+-',
          click: () => mainWindow?.webContents.send('menu:zoom-out'),
        },
        {
          label: 'Zoom to Fit',
          accelerator: 'CmdOrCtrl+0',
          click: () => mainWindow?.webContents.send('menu:zoom-fit'),
        },
        { type: 'separator' },
        {
          label: 'Toggle Mixer',
          accelerator: 'CmdOrCtrl+M',
          click: () => mainWindow?.webContents.send('menu:toggle-mixer'),
        },
        {
          label: 'Toggle Plugin Browser',
          accelerator: 'CmdOrCtrl+B',
          click: () => mainWindow?.webContents.send('menu:toggle-plugin-browser'),
        },
        { type: 'separator' },
        {
          label: 'Channel Layout',
          submenu: [
            {
              label: 'Stereo (2ch)',
              click: () => mainWindow?.webContents.send('menu:channel-layout', 2),
            },
            {
              label: 'Quad (4ch)',
              click: () => mainWindow?.webContents.send('menu:channel-layout', 4),
            },
            {
              label: '5.1 Surround (6ch)',
              click: () => mainWindow?.webContents.send('menu:channel-layout', 6),
            },
          ],
        },
        { type: 'separator' },
        { role: 'toggleDevTools' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Plugins',
      submenu: [
        {
          label: 'Scan for Plugins...',
          click: () => handleScanPlugins(),
        },
        {
          label: 'Plugin Manager...',
          click: () => mainWindow?.webContents.send('menu:plugin-manager'),
        },
        { type: 'separator' },
        {
          label: 'VST3 Plugin Paths',
          submenu: [
            {
              label: '~/Library/Audio/Plug-Ins/VST3',
              enabled: false,
            },
            {
              label: '/Library/Audio/Plug-Ins/VST3',
              enabled: false,
            },
            {
              label: 'Add Custom Path...',
              click: () => handleAddPluginPath(),
            },
          ],
        },
        {
          label: 'AudioUnit Plugins',
          submenu: [
            {
              label: '~/Library/Audio/Plug-Ins/Components',
              enabled: false,
            },
            {
              label: '/Library/Audio/Plug-Ins/Components',
              enabled: false,
            },
          ],
        },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac ? [
          { type: 'separator' as const },
          { role: 'front' as const },
        ] : []),
      ],
    },
    {
      role: 'help',
      submenu: [
        {
          label: 'Keyboard Shortcuts',
          click: () => mainWindow?.webContents.send('menu:shortcuts'),
        },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

async function handleImportAudio() {
  if (!mainWindow) return;

  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Import Audio Files',
    filters: [
      { name: 'Audio Files', extensions: ['wav', 'aif', 'aiff', 'flac', 'mp3', 'ogg'] },
      { name: 'WAV', extensions: ['wav'] },
      { name: 'AIFF', extensions: ['aif', 'aiff'] },
      { name: 'All Files', extensions: ['*'] },
    ],
    properties: ['openFile', 'multiSelections'],
  });

  if (!result.canceled && result.filePaths.length > 0) {
    mainWindow.webContents.send('files:import', result.filePaths);
  }
}

async function handleImportFolder() {
  if (!mainWindow) return;

  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Import Audio Folder',
    properties: ['openDirectory'],
  });

  if (!result.canceled && result.filePaths.length > 0) {
    const folderPath = result.filePaths[0];
    const audioExtensions = ['.wav', '.aif', '.aiff', '.flac', '.mp3', '.ogg'];
    const files = fs.readdirSync(folderPath)
      .filter(f => audioExtensions.includes(path.extname(f).toLowerCase()))
      .map(f => path.join(folderPath, f))
      .sort();

    if (files.length > 0) {
      mainWindow.webContents.send('files:import', files);
    }
  }
}

async function handleLoadProject() {
  if (!mainWindow) return;

  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Load Project',
    filters: [
      { name: 'FieldCorder Project', extensions: ['fcproj'] },
    ],
    properties: ['openFile'],
  });

  if (!result.canceled && result.filePaths.length > 0) {
    const data = fs.readFileSync(result.filePaths[0], 'utf-8');
    mainWindow.webContents.send('project:load', data);
  }
}

async function handleScanPlugins() {
  if (!mainWindow) return;

  const vstPaths = [
    path.join(app.getPath('home'), 'Library', 'Audio', 'Plug-Ins', 'VST3'),
    '/Library/Audio/Plug-Ins/VST3',
  ];

  const auPaths = [
    path.join(app.getPath('home'), 'Library', 'Audio', 'Plug-Ins', 'Components'),
    '/Library/Audio/Plug-Ins/Components',
  ];

  const plugins: Array<{ name: string; path: string; type: string; format: string }> = [];

  // Scan VST3 plugins
  for (const vstPath of vstPaths) {
    try {
      if (fs.existsSync(vstPath)) {
        const entries = fs.readdirSync(vstPath);
        for (const entry of entries) {
          if (entry.endsWith('.vst3')) {
            plugins.push({
              name: entry.replace('.vst3', ''),
              path: path.join(vstPath, entry),
              type: 'effect',
              format: 'VST3',
            });
          }
        }
      }
    } catch (e) {
      console.warn('Error scanning VST3 path:', vstPath, e);
    }
  }

  // Scan AU plugins
  for (const auPath of auPaths) {
    try {
      if (fs.existsSync(auPath)) {
        const entries = fs.readdirSync(auPath);
        for (const entry of entries) {
          if (entry.endsWith('.component')) {
            plugins.push({
              name: entry.replace('.component', ''),
              path: path.join(auPath, entry),
              type: 'effect',
              format: 'AudioUnit',
            });
          }
        }
      }
    } catch (e) {
      console.warn('Error scanning AU path:', auPath, e);
    }
  }

  mainWindow.webContents.send('plugins:scan-result', plugins);
}

async function handleAddPluginPath() {
  if (!mainWindow) return;

  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Plugin Directory',
    properties: ['openDirectory'],
  });

  if (!result.canceled && result.filePaths.length > 0) {
    mainWindow.webContents.send('plugins:add-path', result.filePaths[0]);
  }
}

// IPC Handlers
ipcMain.handle('dialog:save-file', async (_, options) => {
  if (!mainWindow) return null;
  return dialog.showSaveDialog(mainWindow, options);
});

ipcMain.handle('dialog:open-file', async (_, options) => {
  if (!mainWindow) return null;
  return dialog.showOpenDialog(mainWindow, options);
});

ipcMain.handle('fs:read-file', async (_, filePath: string) => {
  return fs.readFileSync(filePath);
});

ipcMain.handle('fs:write-file', async (_, filePath: string, data: Buffer) => {
  fs.writeFileSync(filePath, data);
});

ipcMain.handle('fs:read-file-text', async (_, filePath: string) => {
  return fs.readFileSync(filePath, 'utf-8');
});

ipcMain.handle('plugin:load', async (_, pluginPath: string) => {
  if (pluginHostNative) {
    try {
      return pluginHostNative.loadPlugin(pluginPath);
    } catch (e: any) {
      return { error: e.message };
    }
  }
  return { error: 'Native plugin host not available' };
});

ipcMain.handle('plugin:process', async (_, pluginId: string, audioData: Float32Array[], sampleRate: number) => {
  if (pluginHostNative) {
    try {
      return pluginHostNative.processAudio(pluginId, audioData, sampleRate);
    } catch (e: any) {
      return { error: e.message };
    }
  }
  return { error: 'Native plugin host not available' };
});

ipcMain.handle('plugin:get-parameters', async (_, pluginId: string) => {
  if (pluginHostNative) {
    try {
      return pluginHostNative.getParameters(pluginId);
    } catch (e: any) {
      return { error: e.message };
    }
  }
  return { error: 'Native plugin host not available' };
});

ipcMain.handle('plugin:set-parameter', async (_, pluginId: string, paramId: number, value: number) => {
  if (pluginHostNative) {
    try {
      return pluginHostNative.setParameter(pluginId, paramId, value);
    } catch (e: any) {
      return { error: e.message };
    }
  }
  return { error: 'Native plugin host not available' };
});

ipcMain.handle('plugin:unload', async (_, pluginId: string) => {
  if (pluginHostNative) {
    try {
      return pluginHostNative.unloadPlugin(pluginId);
    } catch (e: any) {
      return { error: e.message };
    }
  }
  return { error: 'Native plugin host not available' };
});

ipcMain.handle('audio:get-devices', async () => {
  if (pluginHostNative && pluginHostNative.getAudioDevices) {
    try {
      return pluginHostNative.getAudioDevices();
    } catch (e: any) {
      return { error: e.message };
    }
  }
  return { devices: [], error: 'Native audio device enumeration not available' };
});

// App lifecycle
app.whenReady().then(() => {
  loadNativeModule();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
