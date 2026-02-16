import { AudioEngine } from '../core/AudioEngine';
import { formatTime, CHANNEL_NAMES, PluginInfo, ExportMetadata } from '../core/types';
import { AudioEditor } from '../editor/AudioEditor';
import { WaveformRenderer } from '../editor/WaveformRenderer';
import { SpectrogramRenderer } from '../editor/SpectrogramRenderer';
import { CuePointManager, CuePointRenderer } from '../editor/CuePointManager';
import { Mixer } from '../mixer/Mixer';
import { PluginHost } from '../plugins/PluginHost';
import { Metering } from './Metering';
import { MetadataManager } from './MetadataManager';
import { FileQueue } from './FileQueue';
import { ProjectManager } from './ProjectManager';
import { UndoManager } from '../utils/UndoManager';
import { FileHandler } from '../utils/FileHandler';

/**
 * Main application controller for FieldCorder DAW.
 * Orchestrates all components and handles user interactions.
 */
export class App {
  audioEngine: AudioEngine;
  waveformRenderer: WaveformRenderer;
  spectrogramRenderer: SpectrogramRenderer;
  undoManager: UndoManager;
  metering: Metering;
  audioEditor: AudioEditor | null = null;
  fileName: string | null = null;
  fileQueue: FileQueue;
  cuePointManager: CuePointManager;
  cuePointRenderer: CuePointRenderer;
  mixer: Mixer;
  pluginHost: PluginHost | null = null;
  metadataManager: MetadataManager;
  pendingCuePointSample: number | undefined;
  meterAnimationFrame = 0;
  private pendingExportMetadata: ExportMetadata | null = null;
  private pendingUCSFilename: string | null = null;

  constructor() {
    this.audioEngine = new AudioEngine();
    this.waveformRenderer = new WaveformRenderer(document.getElementById('waveformCanvas') as HTMLCanvasElement);
    this.spectrogramRenderer = new SpectrogramRenderer(document.getElementById('spectrogramCanvas') as HTMLCanvasElement);
    this.undoManager = new UndoManager(null);
    this.metering = new Metering();
    this.fileQueue = new FileQueue();

    this.cuePointManager = new CuePointManager();
    this.cuePointRenderer = new CuePointRenderer(
      document.getElementById('cuepointCanvas') as HTMLCanvasElement,
      this.cuePointManager
    );

    this.mixer = new Mixer(
      document.getElementById('mixerContainer')!,
      this.audioEngine,
      null as any // Will be set after audio context init
    );

    this.metadataManager = new MetadataManager();

    this.setupEventListeners();
    this.setupCuePointCallbacks();
    this.setupDragAndDrop();
    this.setupNativeListeners();
    this.updateUI();
  }

  setupEventListeners(): void {
    // File operations
    document.getElementById('importBtn')!.addEventListener('click', () => {
      document.getElementById('fileInput')!.click();
    });
    document.getElementById('fileInput')!.addEventListener('change', (e) => {
      const input = e.target as HTMLInputElement;
      if (input.files && input.files.length > 0) {
        this.addFilesToQueue(Array.from(input.files));
      }
      input.value = '';
    });
    document.getElementById('exportBtn')!.addEventListener('click', () => this.showExportModal());
    document.getElementById('saveProjectBtn')!.addEventListener('click', () => this.saveProject());
    document.getElementById('loadProjectBtn')!.addEventListener('click', () => {
      document.getElementById('projectInput')!.click();
    });
    document.getElementById('projectInput')!.addEventListener('change', (e) => {
      const input = e.target as HTMLInputElement;
      if (input.files && input.files.length > 0) {
        this.loadProject(input.files[0]);
      }
      input.value = '';
    });
    document.getElementById('addCueBtn')!.addEventListener('click', () => this.addCuePointAtPlayhead());

    // Transport
    document.getElementById('playBtn')!.addEventListener('click', () => this.play());
    document.getElementById('pauseBtn')!.addEventListener('click', () => this.pause());
    document.getElementById('stopBtn')!.addEventListener('click', () => this.stop());
    document.getElementById('loopBtn')!.addEventListener('click', () => this.toggleLoop());

    // Zoom
    document.getElementById('zoomInBtn')!.addEventListener('click', () => this.waveformRenderer.zoomIn());
    document.getElementById('zoomOutBtn')!.addEventListener('click', () => this.waveformRenderer.zoomOut());
    document.getElementById('zoomFitBtn')!.addEventListener('click', () => this.waveformRenderer.zoomFit());

    // Edit
    document.getElementById('undoBtn')!.addEventListener('click', () => this.undo());
    document.getElementById('redoBtn')!.addEventListener('click', () => this.redo());
    document.getElementById('trimBtn')!.addEventListener('click', () => this.trim());
    document.getElementById('normalizeBtn')!.addEventListener('click', () => this.showNormalizeModal());
    document.getElementById('fadeInBtn')!.addEventListener('click', () => this.fadeIn());
    document.getElementById('fadeOutBtn')!.addEventListener('click', () => this.fadeOut());
    document.getElementById('gainBtn')!.addEventListener('click', () => this.showGainModal());
    document.getElementById('reverseBtn')!.addEventListener('click', () => this.reverse());

    // Modal buttons
    document.getElementById('exportCancelBtn')!.addEventListener('click', () => this.hideModal('exportModal'));
    document.getElementById('exportConfirmBtn')!.addEventListener('click', () => this.exportFile());
    document.getElementById('normalizeCancelBtn')!.addEventListener('click', () => this.hideModal('normalizeModal'));
    document.getElementById('normalizeConfirmBtn')!.addEventListener('click', () => this.normalize());
    document.getElementById('gainCancelBtn')!.addEventListener('click', () => this.hideModal('gainModal'));
    document.getElementById('gainConfirmBtn')!.addEventListener('click', () => this.applyGain());

    // Plugin browser
    document.getElementById('pluginBrowserCancelBtn')!.addEventListener('click', () => this.hideModal('pluginBrowserModal'));

    // Keyboard
    document.addEventListener('keydown', (e) => this.handleKeyboard(e));

    // FFT size
    document.getElementById('fftSize')!.addEventListener('change', (e) => {
      const size = parseInt((e.target as HTMLSelectElement).value);
      this.audioEngine.setFFTSize(size);
      this.spectrogramRenderer.setFFTSize(size);
      this.spectrogramRenderer.render();
    });

    // Volume slider
    document.getElementById('volumeSlider')!.addEventListener('input', (e) => {
      const db = parseFloat((e.target as HTMLInputElement).value);
      this.audioEngine.setMasterVolume(db);
      document.getElementById('volumeValue')!.textContent = db.toFixed(1) + ' dB';
    });

    // Waveform callbacks
    this.waveformRenderer.onPlayheadChange = (sample) => {
      this.spectrogramRenderer.setPlayheadPosition(sample);
      if (this.audioEngine.audioBuffer) {
        const time = sample / this.audioEngine.audioBuffer.sampleRate;
        this.updatePositionInfo(time);
      }
    };
    this.waveformRenderer.onSelectionUpdate = (start, end) => {
      this.spectrogramRenderer.setSelection(start, end);
    };
    this.waveformRenderer.onSelectionChange = () => {
      this.updateUI();
    };
    this.waveformRenderer.onZoomChange = () => {
      this.updateZoomInfo();
      this.spectrogramRenderer.setSamplesPerPixel(this.waveformRenderer.samplesPerPixel);
      this.spectrogramRenderer.setScrollOffset(this.waveformRenderer.scrollOffset);
      this.cuePointRenderer.setSamplesPerPixel(this.waveformRenderer.samplesPerPixel);
      this.cuePointRenderer.setScrollOffset(this.waveformRenderer.scrollOffset);
    };
    this.waveformRenderer.onScrollChange = () => {
      this.spectrogramRenderer.setScrollOffset(this.waveformRenderer.scrollOffset);
      this.cuePointRenderer.setScrollOffset(this.waveformRenderer.scrollOffset);
    };

    // Playback callbacks
    this.audioEngine.onPositionUpdate = (time) => {
      this.waveformRenderer.setPlayheadPosition(time);
      this.updatePositionInfo(time);
      if (this.audioEngine.audioBuffer) {
        const sample = Math.floor(time * this.audioEngine.audioBuffer.sampleRate);
        this.spectrogramRenderer.setPlayheadPosition(sample);
        this.cuePointRenderer.setPlayheadPosition(sample);
        this.metering.setPlaybackPosition(sample);
      }
    };
    this.audioEngine.onPlaybackEnd = () => {
      this.updateUI();
      this.stopRealtimeAnalysis();
    };

    // Mixer plugin insert request
    this.mixer.onPluginInsertRequest = (channelIndex) => {
      this.showPluginBrowser(channelIndex);
    };
  }

  setupCuePointCallbacks(): void {
    this.cuePointRenderer.onCuePointClick = (cuePoint) => {
      if (!this.audioEngine.audioBuffer) return;
      const time = cuePoint.sample / this.audioEngine.audioBuffer.sampleRate;
      this.stop();
      this.waveformRenderer.playheadPosition = cuePoint.sample;
      this.waveformRenderer.selectionStart = null;
      this.waveformRenderer.selectionEnd = null;
      this.waveformRenderer.render();
      this.waveformRenderer.updateSelectionInfo();
      this.spectrogramRenderer.setSelection(null, null);
      this.audioEngine.play(time);
      this.startRealtimeAnalysis();
      this.updateUI();
    };

    this.cuePointRenderer.onCuePointDoubleClick = (cuePoint) => {
      if (!this.audioEngine.audioBuffer) return;
      const time = cuePoint.sample / this.audioEngine.audioBuffer.sampleRate;
      this.stop();
      this.waveformRenderer.playheadPosition = cuePoint.sample;
      this.waveformRenderer.render();
      this.audioEngine.play(time);
      this.startRealtimeAnalysis();
      this.updateUI();
    };

    this.cuePointRenderer.onCuePointMove = (id, newSample) => {
      this.cuePointManager.moveCuePoint(id, newSample);
      this.cuePointRenderer.render();
    };

    this.cuePointRenderer.onCuePointRemove = (id) => {
      this.cuePointManager.removeCuePoint(id);
      this.cuePointRenderer.render();
    };

    this.cuePointRenderer.onAddCuePoint = (sample) => {
      this.showCuePointInput(sample);
    };

    this.cuePointRenderer.onRegionSelect = (startSample, endSample) => {
      this.waveformRenderer.selectionStart = startSample;
      this.waveformRenderer.selectionEnd = endSample;
      this.waveformRenderer.render();
      this.waveformRenderer.updateSelectionInfo();
      this.spectrogramRenderer.setSelection(startSample, endSample);
      this.updateUI();
    };

    // Cue point name input
    const cuepointNameInput = document.getElementById('cuepointNameInput') as HTMLInputElement;
    const cuepointInput = document.getElementById('cuepointInput')!;

    cuepointNameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const name = cuepointNameInput.value.trim();
        if (this.pendingCuePointSample !== undefined) {
          this.cuePointManager.addCuePoint(this.pendingCuePointSample, name);
          this.cuePointRenderer.render();
          this.pendingCuePointSample = undefined;
        }
        cuepointInput.classList.remove('visible');
        cuepointNameInput.value = '';
      } else if (e.key === 'Escape') {
        cuepointInput.classList.remove('visible');
        cuepointNameInput.value = '';
        this.pendingCuePointSample = undefined;
      }
    });

    cuepointNameInput.addEventListener('blur', () => {
      const name = cuepointNameInput.value.trim();
      if (this.pendingCuePointSample !== undefined) {
        this.cuePointManager.addCuePoint(this.pendingCuePointSample, name);
        this.cuePointRenderer.render();
        this.pendingCuePointSample = undefined;
      }
      cuepointInput.classList.remove('visible');
      cuepointNameInput.value = '';
    });
  }

  setupDragAndDrop(): void {
    const waveformContainer = document.querySelector('.waveform-container') || document.querySelector('.editor-area');
    const dragOverlay = document.getElementById('dragOverlay');
    if (!waveformContainer || !dragOverlay) return;

    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
      waveformContainer.addEventListener(eventName, (e) => {
        e.preventDefault();
        e.stopPropagation();
      }, false);
    });

    ['dragenter', 'dragover'].forEach(eventName => {
      waveformContainer.addEventListener(eventName, () => {
        dragOverlay.classList.add('visible');
      }, false);
    });

    waveformContainer.addEventListener('dragleave', (e) => {
      if (e.target === waveformContainer) {
        dragOverlay.classList.remove('visible');
      }
    }, false);

    waveformContainer.addEventListener('drop', (e) => {
      console.log('[DROP] Drop event received');
      dragOverlay.classList.remove('visible');
      const dt = (e as DragEvent).dataTransfer;
      if (!dt) { console.log('[DROP] No dataTransfer'); return; }
      const files = Array.from(dt.files).filter(f => {
        const ext = f.name.toLowerCase();
        return ext.endsWith('.wav') || ext.endsWith('.aif') || ext.endsWith('.aiff') ||
               ext.endsWith('.flac') || ext.endsWith('.mp3') || ext.endsWith('.ogg');
      });
      console.log(`[DROP] ${files.length} audio files found, sizes: ${files.map(f => (f.size/1024/1024).toFixed(1) + 'MB').join(', ')}`);
      if (files.length > 0) {
        this.addFilesToQueue(files);
      }
    }, false);
  }

  setupNativeListeners(): void {
    if (!window.appAPI) return;

    window.appAPI.onImportFiles(async (filePaths) => {
      for (const filePath of filePaths) {
        const name = filePath.split('/').pop() || filePath;
        const fileObj = { name, path: filePath };
        const id = this.fileQueue.addFile(fileObj);
        this.renderFileList();
        if (!this.audioEngine.audioBuffer) {
          await this.loadFileFromPath(filePath, id);
        }
      }
    });

    window.appAPI.onProjectLoad((data) => {
      this.loadProjectFromString(data);
    });

    window.appAPI.onPluginsScanResult((plugins) => {
      if (this.pluginHost) {
        this.pluginHost.addScannedPlugins(plugins);
      }
    });

    // Menu actions
    const menuActions: Record<string, () => void> = {
      'export': () => this.showExportModal(),
      'save-project': () => this.saveProject(),
      'undo': () => this.undo(),
      'redo': () => this.redo(),
      'select-all': () => this.waveformRenderer.selectAll(),
      'delete': () => this.deleteSelection(),
      'trim': () => this.trim(),
      'normalize': () => this.showNormalizeModal(),
      'fade-in': () => this.fadeIn(),
      'fade-out': () => this.fadeOut(),
      'gain': () => this.showGainModal(),
      'reverse': () => this.reverse(),
      'play-pause': () => this.audioEngine.isPlaying ? this.pause() : this.play(),
      'stop': () => this.stop(),
      'toggle-loop': () => this.toggleLoop(),
      'zoom-in': () => this.waveformRenderer.zoomIn(),
      'zoom-out': () => this.waveformRenderer.zoomOut(),
      'zoom-fit': () => this.waveformRenderer.zoomFit(),
      'toggle-mixer': () => this.mixer.toggle(),
      'toggle-plugin-browser': () => this.togglePluginBrowser(),
    };

    for (const [action, handler] of Object.entries(menuActions)) {
      window.appAPI.onMenuAction(action, handler);
    }

    window.appAPI.onMenuAction('channel-layout', (numChannels: number) => {
      this.changeChannelLayout(numChannels);
    });
  }

  handleKeyboard(e: KeyboardEvent): void {
    if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'SELECT') return;

    if (e.metaKey || e.ctrlKey) {
      switch (e.key) {
        case 'a': e.preventDefault(); this.waveformRenderer.selectAll(); return;
        case 'z':
          e.preventDefault();
          e.shiftKey ? this.redo() : this.undo();
          return;
        case 'y': e.preventDefault(); this.redo(); return;
        case 't': e.preventDefault(); if (this.waveformRenderer.hasSelection()) this.trim(); return;
        case 'f':
          e.preventDefault();
          if (this.waveformRenderer.hasSelection()) {
            e.shiftKey ? this.fadeOut() : this.fadeIn();
          }
          return;
        case 'n':
          e.preventDefault();
          if (e.shiftKey && this.audioEngine.audioBuffer) this.showNormalizeModal();
          return;
        case 'b':
          e.preventDefault();
          this.togglePluginBrowser();
          return;
      }
    }

    switch (e.key) {
      case ' ':
        e.preventDefault();
        this.audioEngine.isPlaying ? this.pause() : this.play();
        break;
      case '+': case '=': this.waveformRenderer.zoomIn(); break;
      case '-': this.waveformRenderer.zoomOut(); break;
      case 'ArrowLeft':
        e.preventDefault();
        if (this.audioEngine.audioBuffer) this.movePlayhead(-1);
        break;
      case 'ArrowRight':
        e.preventDefault();
        if (this.audioEngine.audioBuffer) this.movePlayhead(1);
        break;
      case 'Delete': case 'Backspace':
        e.preventDefault();
        this.deleteSelection();
        break;
      case 'l': case 'L':
        if (this.audioEngine.audioBuffer) this.toggleLoop();
        break;
      case 'r': case 'R':
        if (this.audioEngine.audioBuffer) this.reverse();
        break;
      case 'm': case 'M':
        if (this.audioEngine.audioBuffer) this.addCuePointAtPlayhead();
        break;
    }
  }

  // ==================== File Operations ====================

  async importFile(file: File, fileId: number | null = null): Promise<void> {
    try {
      this.showLoadingIndicator(file.name);
      this.fileName = file.name;
      console.log(`[IMPORT-FILE] Step 1: Reading File object (${(file.size / 1024 / 1024).toFixed(1)} MB)...`);
      const arrayBuffer = await FileHandler.importFile(file);
      console.log(`[IMPORT-FILE] Step 2: File read complete. Decoding...`);
      const audioBuffer = await this.audioEngine.loadAudio(arrayBuffer);
      console.log('[IMPORT-FILE] Step 3: Decode complete. Loading UI...');
      this.onAudioLoaded(audioBuffer, fileId);
      console.log('[IMPORT-FILE] Step 4: Done.');
    } catch (err: any) {
      console.error('Import error:', err);
      this.hideLoadingIndicator();
      alert('Error loading audio file: ' + err.message);
    }
  }

  async loadFileFromPath(filePath: string, fileId: number): Promise<void> {
    try {
      const name = filePath.split('/').pop() || 'Untitled';
      this.showLoadingIndicator(name);
      this.fileName = name;
      console.log('[IMPORT] Step 1: Reading file...');
      const result = await FileHandler.importFilePath(filePath);

      let audioBuffer: AudioBuffer;
      if (result instanceof ArrayBuffer) {
        // Non-WAV: raw bytes need decodeAudioData
        console.log(`[IMPORT] Step 2: File read complete (${(result.byteLength / 1024 / 1024).toFixed(1)} MB). Decoding...`);
        audioBuffer = await this.audioEngine.loadAudio(result);
      } else {
        // WAV: already parsed by Rust — create AudioBuffer directly
        const dataMB = (result.num_samples * result.channels * 4 / (1024 * 1024)).toFixed(1);
        console.log(`[IMPORT] Step 2: Rust WAV parse complete (${result.channels}ch, ${result.sample_rate}Hz, ${dataMB} MB). Loading...`);
        audioBuffer = await this.audioEngine.loadFromParsedData(result);
      }

      console.log('[IMPORT] Step 3: Audio loaded. Loading UI...');
      this.onAudioLoaded(audioBuffer, fileId);
      console.log('[IMPORT] Step 4: Done.');
    } catch (err: any) {
      console.error('Import error:', err);
      this.hideLoadingIndicator();
      alert('Error loading audio file: ' + err.message);
    }
  }

  private showLoadingIndicator(fileName: string): void {
    const el = document.getElementById('fileInfo');
    if (el) el.textContent = `Loading ${fileName}...`;
  }

  private hideLoadingIndicator(): void {
    const el = document.getElementById('fileInfo');
    if (el) el.textContent = this.fileName || 'No file loaded';
  }

  private onAudioLoaded(audioBuffer: AudioBuffer, fileId: number | null): void {
    try {
      if (!this.audioEditor) {
        this.audioEditor = new AudioEditor(this.audioEngine.audioContext!);
      }
      if (!this.pluginHost) {
        this.pluginHost = new PluginHost(this.audioEngine.audioContext!);
        this.mixer.pluginHost = this.pluginHost;
      }

      this.undoManager.setAudioContext(this.audioEngine.audioContext!);
      this.undoManager.clear();

      this.waveformRenderer.setAudioBuffer(audioBuffer);
      this.spectrogramRenderer.setAudioBuffer(audioBuffer);
      this.spectrogramRenderer.setAnalyserNode(this.audioEngine.getAnalyserNode());
      this.spectrogramRenderer.setSamplesPerPixel(this.waveformRenderer.samplesPerPixel);
      this.metering.setAudioBuffer(audioBuffer);
      this.metering.setAnalyserNode(this.audioEngine.getAnalyserNode());

      this.cuePointManager.clear();
      this.cuePointRenderer.setAudioBuffer(audioBuffer);
      this.cuePointRenderer.setSamplesPerPixel(this.waveformRenderer.samplesPerPixel);
      this.cuePointRenderer.setScrollOffset(this.waveformRenderer.scrollOffset);

      // Setup mixer for channel count
      this.mixer.setupChannels(audioBuffer.numberOfChannels);

      if (fileId) {
        const savedCuePoints = this.fileQueue.getCuePoints(fileId);
        if (savedCuePoints && savedCuePoints.length > 0) {
          this.cuePointManager.fromJSON(savedCuePoints);
          this.cuePointRenderer.render();
        }
        this.fileQueue.setActive(fileId);
        this.renderFileList();
      }

      this.updateUI();
      this.updateFileInfo();
      this.updateZoomInfo();
      this.updateChannelInfo();
    } catch (err: any) {
      console.error('Error in onAudioLoaded:', err);
      alert('Error displaying audio: ' + err.message);
    }
  }

  addFilesToQueue(files: Array<File | { name: string; path: string }>): void {
    const ids = this.fileQueue.addFiles(files);
    this.renderFileList();

    if (!this.audioEngine.audioBuffer && files.length > 0) {
      const firstFile = files[0];
      this.loadQueuedFile(firstFile, ids[0]);
    }
  }

  /**
   * Load a file using the best available method.
   * Tauri File objects have a `.path` property — use Rust parser for WAV files.
   */
  private loadQueuedFile(file: File | { name: string; path: string }, fileId: number): void {
    const nativePath = (file as any).path as string | undefined;

    if (nativePath) {
      // Native path available (Tauri/Electron) — use Rust WAV parser path
      this.loadFileFromPath(nativePath, fileId);
    } else if (file instanceof File) {
      // Pure browser fallback — FileReader + decodeAudioData
      this.importFile(file, fileId);
    }
  }

  loadFileFromQueue(fileId: number): void {
    const currentFileId = this.fileQueue.getActive();
    if (currentFileId) {
      this.fileQueue.setCuePoints(currentFileId, this.cuePointManager.toJSON());
    }

    const file = this.fileQueue.getFile(fileId);
    if (file) {
      this.loadQueuedFile(file, fileId);
    }
  }

  removeFileFromQueue(fileId: number): void {
    const wasActive = this.fileQueue.getActive() === fileId;
    this.fileQueue.removeFile(fileId);
    this.renderFileList();

    if (wasActive) {
      this.audioEngine.stop();
      this.audioEngine.audioBuffer = null;
      this.waveformRenderer.setAudioBuffer(null);
      this.spectrogramRenderer.setAudioBuffer(null);
      this.cuePointManager.clear();
      this.cuePointRenderer.setAudioBuffer(null);
      this.fileName = null;
      this.updateUI();
      this.updateFileInfo();

      const files = this.fileQueue.getAll();
      if (files.length > 0) {
        this.loadFileFromQueue(files[0].id);
      }
    }
  }

  renderFileList(): void {
    const fileListContainer = document.getElementById('fileList');
    if (!fileListContainer) return;

    const activeId = this.fileQueue.getActive();
    const files = this.fileQueue.getAll();

    fileListContainer.innerHTML = '';

    files.forEach(({ id, file }) => {
      const item = document.createElement('div');
      item.className = 'file-item';
      if (id === activeId) item.classList.add('active');

      const nameSpan = document.createElement('span');
      nameSpan.className = 'file-name';
      nameSpan.textContent = file instanceof File ? file.name : file.name;
      nameSpan.title = nameSpan.textContent;

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'file-delete';
      deleteBtn.innerHTML = '×';
      deleteBtn.onclick = (e) => {
        e.stopPropagation();
        this.removeFileFromQueue(id);
      };

      item.onclick = () => {
        if (id !== activeId) this.loadFileFromQueue(id);
      };

      item.appendChild(nameSpan);
      item.appendChild(deleteBtn);
      fileListContainer.appendChild(item);
    });
  }

  // ==================== Transport ====================

  play(): void {
    if (!this.audioEngine.audioBuffer) return;

    const selection = this.waveformRenderer.getSelection();
    if (selection) {
      const startTime = selection.start / this.audioEngine.audioBuffer.sampleRate;
      const endTime = selection.end / this.audioEngine.audioBuffer.sampleRate;
      this.audioEngine.playSelection(startTime, endTime);
    } else if (this.audioEngine.isPaused) {
      // If user clicked to move playhead while paused, play from new position
      const pausedSample = Math.floor(this.audioEngine.getCurrentTime() * this.audioEngine.audioBuffer.sampleRate);
      if (Math.abs(this.waveformRenderer.playheadPosition - pausedSample) > 1) {
        this.audioEngine.stop();
        const startTime = this.waveformRenderer.playheadPosition / this.audioEngine.audioBuffer.sampleRate;
        this.audioEngine.play(startTime);
      } else {
        this.audioEngine.resume();
      }
    } else {
      let startSample = this.waveformRenderer.playheadPosition;
      const totalSamples = this.audioEngine.audioBuffer.length;
      if (startSample >= totalSamples * 0.99) {
        startSample = 0;
        this.waveformRenderer.playheadPosition = 0;
        this.waveformRenderer.render();
      }
      const startTime = startSample / this.audioEngine.audioBuffer.sampleRate;
      this.audioEngine.play(startTime);
    }
    this.startRealtimeAnalysis();
    this.updateUI();
  }

  pause(): void {
    this.audioEngine.pause();
    this.stopRealtimeAnalysis();
    this.updateUI();
  }

  stop(): void {
    this.audioEngine.stop();
    this.stopRealtimeAnalysis();
    this.waveformRenderer.setPlayheadPosition(0);
    this.spectrogramRenderer.setPlayheadPosition(0);
    this.updatePositionInfo(0);
    this.updateUI();
  }

  toggleLoop(): void {
    const isLooping = !this.audioEngine.isLooping();
    this.audioEngine.setLooping(isLooping);
    document.getElementById('loopBtn')!.classList.toggle('loop-active', isLooping);
  }

  movePlayhead(milliseconds: number): void {
    if (!this.audioEngine.audioBuffer) return;
    const sampleRate = this.audioEngine.audioBuffer.sampleRate;
    const totalSamples = this.audioEngine.audioBuffer.length;
    const sampleIncrement = Math.round((sampleRate / 1000) * milliseconds);
    let newSample = this.waveformRenderer.playheadPosition + sampleIncrement;
    newSample = Math.max(0, Math.min(totalSamples - 1, newSample));
    this.waveformRenderer.playheadPosition = newSample;
    this.waveformRenderer.render();
    this.spectrogramRenderer.setPlayheadPosition(newSample);
    this.updatePositionInfo(newSample / sampleRate);
  }

  // ==================== Edit Operations ====================

  saveStateForUndo(): void {
    if (this.audioEngine.audioBuffer) {
      this.undoManager.saveState(this.audioEngine.audioBuffer);
    }
  }

  applyBuffer(buffer: AudioBuffer): void {
    this.audioEngine.setBuffer(buffer);
    this.waveformRenderer.setAudioBuffer(buffer);
    this.spectrogramRenderer.setAudioBuffer(buffer);
    this.metering.setAudioBuffer(buffer);
    this.mixer.setupChannels(buffer.numberOfChannels);
    this.updateFileInfo();
    this.updateChannelInfo();
    this.updateUI();
  }

  undo(): void {
    if (!this.undoManager.canUndo() || !this.audioEngine.audioBuffer) return;
    this.stop();
    const previousBuffer = this.undoManager.undo(this.audioEngine.audioBuffer);
    if (previousBuffer) this.applyBuffer(previousBuffer);
  }

  redo(): void {
    if (!this.undoManager.canRedo() || !this.audioEngine.audioBuffer) return;
    this.stop();
    const nextBuffer = this.undoManager.redo(this.audioEngine.audioBuffer);
    if (nextBuffer) this.applyBuffer(nextBuffer);
  }

  trim(): void {
    const selection = this.waveformRenderer.getSelection();
    if (!selection || !this.audioEditor) return;
    this.stop();
    this.saveStateForUndo();
    const newBuffer = this.audioEditor.trim(this.audioEngine.audioBuffer!, selection.start, selection.end);
    this.cuePointManager.adjustForTrim(selection.start, selection.end);
    this.applyBuffer(newBuffer);
    this.cuePointRenderer.render();
  }

  deleteSelection(): void {
    const selection = this.waveformRenderer.getSelection();
    if (!selection || !this.audioEditor) return;
    this.stop();
    this.saveStateForUndo();
    const newBuffer = this.audioEditor.deleteSelection(this.audioEngine.audioBuffer!, selection.start, selection.end);
    if (newBuffer) {
      this.cuePointManager.adjustForDeletion(selection.start, selection.end);
      this.applyBuffer(newBuffer);
      this.cuePointRenderer.render();
    }
  }

  normalize(): void {
    const level = parseFloat((document.getElementById('normalizeLevel') as HTMLInputElement).value);
    const selection = this.waveformRenderer.getSelection();
    if (!this.audioEditor) return;
    this.stop();
    this.saveStateForUndo();
    if (selection) {
      this.audioEditor.normalize(this.audioEngine.audioBuffer!, level, selection.start, selection.end);
    } else {
      this.audioEditor.normalize(this.audioEngine.audioBuffer!, level);
    }
    this.refreshWaveform();
    this.hideModal('normalizeModal');
  }

  fadeIn(): void {
    const selection = this.waveformRenderer.getSelection();
    if (!selection || !this.audioEditor) return;
    this.stop();
    this.saveStateForUndo();
    this.audioEditor.fadeIn(this.audioEngine.audioBuffer!, selection.start, selection.end);
    this.refreshWaveform();
  }

  fadeOut(): void {
    const selection = this.waveformRenderer.getSelection();
    if (!selection || !this.audioEditor) return;
    this.stop();
    this.saveStateForUndo();
    this.audioEditor.fadeOut(this.audioEngine.audioBuffer!, selection.start, selection.end);
    this.refreshWaveform();
  }

  reverse(): void {
    const selection = this.waveformRenderer.getSelection();
    if (!this.audioEditor) return;
    this.stop();
    this.saveStateForUndo();
    if (selection) {
      this.audioEditor.reverse(this.audioEngine.audioBuffer!, selection.start, selection.end);
    } else {
      this.audioEditor.reverse(this.audioEngine.audioBuffer!);
    }
    this.refreshWaveform();
  }

  applyGain(): void {
    const gainDb = parseFloat((document.getElementById('gainAmount') as HTMLInputElement).value);
    const selection = this.waveformRenderer.getSelection();
    if (!this.audioEditor) return;
    this.stop();
    this.saveStateForUndo();
    if (selection) {
      this.audioEditor.applyGain(this.audioEngine.audioBuffer!, gainDb, selection.start, selection.end);
    } else {
      this.audioEditor.applyGain(this.audioEngine.audioBuffer!, gainDb);
    }
    this.refreshWaveform();
    this.hideModal('gainModal');
  }

  changeChannelLayout(targetChannels: number): void {
    if (!this.audioEditor || !this.audioEngine.audioBuffer) return;
    this.stop();
    this.saveStateForUndo();
    const newBuffer = this.audioEditor.changeChannelCount(this.audioEngine.audioBuffer, targetChannels);
    this.applyBuffer(newBuffer);
  }

  private refreshWaveform(): void {
    this.waveformRenderer.calculatePeaks();
    this.waveformRenderer.render();
    this.spectrogramRenderer.render();
    this.metering.setAudioBuffer(this.audioEngine.audioBuffer);
    this.updateUI();
  }

  // ==================== Analysis ====================

  startRealtimeAnalysis(): void {
    this.spectrogramRenderer.startRealtime();
    this.metering.startRealtime();
    this.startMixerMeters();
  }

  stopRealtimeAnalysis(): void {
    this.spectrogramRenderer.stopRealtime();
    this.metering.stopRealtime();
    this.stopMixerMeters();
  }

  startMixerMeters(): void {
    const updateMeters = () => {
      this.mixer.updateMeters();
      this.meterAnimationFrame = requestAnimationFrame(updateMeters);
    };
    updateMeters();
  }

  stopMixerMeters(): void {
    cancelAnimationFrame(this.meterAnimationFrame);
  }

  // ==================== Cue Points ====================

  addCuePointAtPlayhead(): void {
    if (!this.audioEngine.audioBuffer) return;
    const sample = this.waveformRenderer.playheadPosition;
    this.showCuePointInput(sample);
  }

  showCuePointInput(sample: number): void {
    const cuepointInput = document.getElementById('cuepointInput')!;
    const cuepointNameInput = document.getElementById('cuepointNameInput') as HTMLInputElement;
    const playheadX = this.cuePointRenderer.sampleToPixel(sample);
    cuepointInput.style.left = Math.max(10, Math.min(playheadX, this.cuePointRenderer.width - 150)) + 'px';
    cuepointInput.style.top = '4px';
    this.pendingCuePointSample = sample;
    cuepointInput.classList.add('visible');
    cuepointNameInput.focus();
  }

  // ==================== Project ====================

  async saveProject(): Promise<void> {
    if (!this.audioEngine.audioBuffer) return;
    try {
      const jsonString = await ProjectManager.saveProject(
        this.audioEngine.audioBuffer,
        this.cuePointManager,
        this.fileName || 'Untitled',
        this.mixer.getState() as any,
      );
      ProjectManager.downloadProject(jsonString, this.fileName || 'Untitled');
    } catch (err: any) {
      alert('Error saving project: ' + err.message);
    }
  }

  async loadProject(file: File): Promise<void> {
    const text = await file.text();
    await this.loadProjectFromString(text);
  }

  async loadProjectFromString(text: string): Promise<void> {
    try {
      await this.audioEngine.init();
      const project = await ProjectManager.loadProject(text, this.audioEngine.audioContext!);

      if (!this.audioEditor) {
        this.audioEditor = new AudioEditor(this.audioEngine.audioContext!);
      }
      this.undoManager.setAudioContext(this.audioEngine.audioContext!);
      this.undoManager.clear();

      this.audioEngine.setBuffer(project.audioBuffer);
      this.fileName = project.fileName || 'Untitled';

      this.waveformRenderer.setAudioBuffer(project.audioBuffer);
      this.spectrogramRenderer.setAudioBuffer(project.audioBuffer);
      this.spectrogramRenderer.setAnalyserNode(this.audioEngine.getAnalyserNode());
      this.spectrogramRenderer.setSamplesPerPixel(this.waveformRenderer.samplesPerPixel);
      this.metering.setAudioBuffer(project.audioBuffer);
      this.metering.setAnalyserNode(this.audioEngine.getAnalyserNode());

      this.cuePointManager.fromJSON(project.cuePoints);
      this.cuePointRenderer.setAudioBuffer(project.audioBuffer);
      this.cuePointRenderer.setSamplesPerPixel(this.waveformRenderer.samplesPerPixel);
      this.cuePointRenderer.setScrollOffset(this.waveformRenderer.scrollOffset);

      this.mixer.setupChannels(project.audioBuffer.numberOfChannels);

      this.updateUI();
      this.updateFileInfo();
      this.updateZoomInfo();
      this.updateChannelInfo();
    } catch (err: any) {
      alert('Error loading project: ' + err.message);
    }
  }

  // ==================== Plugins ====================

  togglePluginBrowser(): void {
    const modal = document.getElementById('pluginBrowserModal');
    if (!modal) return;
    if (modal.classList.contains('visible')) {
      this.hideModal('pluginBrowserModal');
    } else {
      this.showPluginBrowser(null);
    }
  }

  showPluginBrowser(channelIndex: number | null): void {
    const modal = document.getElementById('pluginBrowserModal');
    if (!modal) return;

    // Ensure pluginHost exists for browsing (create with a temporary context if needed)
    if (!this.pluginHost && this.audioEngine.audioContext) {
      this.pluginHost = new PluginHost(this.audioEngine.audioContext);
      this.mixer.pluginHost = this.pluginHost;
    }

    const pluginList = document.getElementById('pluginList')!;
    const insertBtn = document.getElementById('pluginBrowserInsertBtn') as HTMLButtonElement;
    const plugins = this.pluginHost ? this.pluginHost.getAvailablePlugins() : [];

    pluginList.innerHTML = '';

    if (plugins.length === 0) {
      pluginList.innerHTML = '<div style="padding: 24px; text-align: center; color: #666; font-style: italic;">No plugins available. Load an audio file to use built-in effects.</div>';
      if (insertBtn) insertBtn.disabled = true;
    } else {
      plugins.forEach(plugin => {
        const item = document.createElement('div');
        item.className = 'plugin-item';
        item.innerHTML = `
          <span class="plugin-item-name">${plugin.name}</span>
          <span class="plugin-item-format">${plugin.format}</span>
          <span class="plugin-item-category">${plugin.category || ''}</span>
        `;
        if (channelIndex !== null) {
          item.addEventListener('click', async () => {
            try {
              await this.mixer.addPlugin(channelIndex, plugin);
              this.hideModal('pluginBrowserModal');
            } catch (err: any) {
              alert('Error loading plugin: ' + err.message);
            }
          });
        }
        pluginList.appendChild(item);
      });
    }

    // Search filter
    const searchInput = document.getElementById('pluginSearch') as HTMLInputElement;
    if (searchInput) {
      searchInput.value = '';
      searchInput.oninput = () => {
        const query = searchInput.value.toLowerCase();
        pluginList.querySelectorAll('.plugin-item').forEach(item => {
          const name = item.querySelector('.plugin-item-name')?.textContent?.toLowerCase() || '';
          (item as HTMLElement).style.display = name.includes(query) ? '' : 'none';
        });
      };
    }

    modal.classList.add('visible');
  }

  // ==================== UI ====================

  showExportModal(): void {
    if (!this.audioEngine.audioBuffer) return;

    // Show metadata dialog first, then export settings
    this.metadataManager.show(
      this.audioEngine.audioBuffer.numberOfChannels,
      (metadata, ucsFilename) => {
        this.pendingExportMetadata = metadata;

        // If UCS filename was generated, update the filename
        if (ucsFilename) {
          this.pendingUCSFilename = ucsFilename;
        } else {
          this.pendingUCSFilename = null;
        }

        // Now show export settings dialog
        const hasSelection = this.waveformRenderer.hasSelection();
        const checkbox = document.getElementById('exportSelection') as HTMLInputElement;
        checkbox.disabled = !hasSelection;
        checkbox.checked = hasSelection;
        this.showModal('exportModal');
      }
    );
  }

  showNormalizeModal(): void { this.showModal('normalizeModal'); }
  showGainModal(): void { this.showModal('gainModal'); }

  showModal(id: string): void {
    document.getElementById(id)?.classList.add('visible');
  }

  hideModal(id: string): void {
    document.getElementById(id)?.classList.remove('visible');
  }

  exportFile(): void {
    const format = (document.getElementById('exportFormat') as HTMLSelectElement).value;
    const bitDepth = parseInt((document.getElementById('exportBitDepth') as HTMLSelectElement).value);
    const dither = (document.getElementById('exportDither') as HTMLSelectElement).value;
    const exportSelection = (document.getElementById('exportSelection') as HTMLInputElement).checked;

    let bufferToExport = this.audioEngine.audioBuffer!;
    let fileNameSuffix = '';

    if (exportSelection && this.waveformRenderer.hasSelection()) {
      const selection = this.waveformRenderer.getSelection()!;
      bufferToExport = this.audioEditor!.trim(this.audioEngine.audioBuffer!, selection.start, selection.end);
      fileNameSuffix = '_selection';
    }

    const metadata = this.pendingExportMetadata || undefined;

    let blob: Blob;
    let extension: string;

    if (format === 'wav') {
      blob = FileHandler.exportWAV(bufferToExport, bitDepth, dither, metadata);
      extension = '.wav';
    } else {
      const aifBitDepth = bitDepth === 32 ? 24 : bitDepth;
      blob = FileHandler.exportAIF(bufferToExport, aifBitDepth, dither);
      extension = '.aif';
    }

    // Use UCS filename if available, otherwise use original filename
    let baseName: string;
    if (this.pendingUCSFilename) {
      baseName = this.pendingUCSFilename;
    } else {
      baseName = this.fileName ? this.fileName.replace(/\.[^/.]+$/, '') : 'audio';
    }

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = baseName + fileNameSuffix + extension;
    a.click();
    URL.revokeObjectURL(url);

    this.pendingExportMetadata = null;
    this.pendingUCSFilename = null;
    this.hideModal('exportModal');
  }

  updateUI(): void {
    const hasAudio = !!this.audioEngine.audioBuffer;
    const hasSelection = this.waveformRenderer.hasSelection();
    const isPlaying = this.audioEngine.isPlaying;

    const setDisabled = (id: string, disabled: boolean) => {
      const el = document.getElementById(id);
      if (el) (el as HTMLButtonElement).disabled = disabled;
    };

    setDisabled('exportBtn', !hasAudio);
    setDisabled('saveProjectBtn', !hasAudio);
    setDisabled('addCueBtn', !hasAudio);
    setDisabled('playBtn', !hasAudio);
    setDisabled('pauseBtn', !isPlaying);
    setDisabled('stopBtn', !hasAudio);
    setDisabled('loopBtn', !hasAudio);
    setDisabled('zoomInBtn', !hasAudio);
    setDisabled('zoomOutBtn', !hasAudio);
    setDisabled('zoomFitBtn', !hasAudio);
    setDisabled('undoBtn', !this.undoManager.canUndo());
    setDisabled('redoBtn', !this.undoManager.canRedo());
    setDisabled('trimBtn', !hasSelection);
    setDisabled('normalizeBtn', !hasAudio);
    setDisabled('fadeInBtn', !hasSelection);
    setDisabled('fadeOutBtn', !hasSelection);
    setDisabled('gainBtn', !hasAudio);
    setDisabled('reverseBtn', !hasAudio);

    document.getElementById('playBtn')?.classList.toggle('playing', isPlaying);
  }

  updateFileInfo(): void {
    const buffer = this.audioEngine.audioBuffer;
    const el = document.getElementById('fileInfo');
    if (!el) return;

    if (!buffer) {
      el.textContent = 'No file loaded';
      return;
    }

    const duration = formatTime(buffer.duration);
    const sampleRate = (buffer.sampleRate / 1000).toFixed(1) + ' kHz';
    const channels = buffer.numberOfChannels;
    const channelLabel = channels === 1 ? 'Mono' : channels === 2 ? 'Stereo' :
      channels === 4 ? 'Quad' : channels === 6 ? '5.1' : `${channels}ch`;

    el.textContent = `${this.fileName} | ${duration} | ${sampleRate} | ${channelLabel}`;
  }

  updatePositionInfo(time: number): void {
    const el = document.getElementById('positionInfo');
    if (el) el.textContent = formatTime(time);
  }

  updateZoomInfo(): void {
    const spp = this.waveformRenderer.samplesPerPixel;
    const el = document.getElementById('zoomInfo');
    if (!el) return;
    el.textContent = spp >= 1000 ? (spp / 1000).toFixed(1) + 'k spp' : spp.toFixed(0) + ' spp';
  }

  updateChannelInfo(): void {
    const buffer = this.audioEngine.audioBuffer;
    const el = document.getElementById('channelLayoutInfo');
    if (!el) return;

    if (!buffer) {
      el.textContent = '';
      return;
    }

    const n = buffer.numberOfChannels;
    const labels: Record<number, string> = { 1: 'Mono', 2: 'Stereo', 4: 'Quad', 6: '5.1 Surround' };
    el.textContent = labels[n] || `${n} channels`;

    // Update channel info panel
    const channelInfo = document.getElementById('channelInfo');
    if (channelInfo) {
      const names = CHANNEL_NAMES[n] || Array.from({ length: n }, (_, i) => `Ch ${i + 1}`);
      channelInfo.innerHTML = names.map((name, i) =>
        `<div class="channel-info-item"><span style="color: ${['#3b82f6','#10b981','#f59e0b','#ef4444','#8b5cf6','#ec4899'][i]}">\u25CF</span> ${name}</div>`
      ).join('');
    }
  }
}
