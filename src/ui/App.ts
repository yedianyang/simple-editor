import { AudioEngine } from '../core/AudioEngine';
import { formatTime, CHANNEL_NAMES, PluginInfo, ExportMetadata } from '../core/types';
import { AudioEditor } from '../editor/AudioEditor';
import { WaveformRenderer } from '../editor/WaveformRenderer';
import { SpectrogramRenderer } from '../editor/SpectrogramRenderer';
import { CuePointManager, CuePointRenderer } from '../editor/CuePointManager';
import { TimelineRenderer } from '../editor/TimelineRenderer';
import { SonogramRenderer } from '../editor/SonogramRenderer';
import { Mixer } from '../mixer/Mixer';
import { PluginHost } from '../plugins/PluginHost';
import { Metering } from './Metering';
import { MetadataManager } from './MetadataManager';
import { CollapsiblePanel } from './CollapsiblePanel';
import { AnalysisPanel } from './AnalysisPanel';
import { FileQueue } from './FileQueue';
import { ProjectManager } from './ProjectManager';
import { UndoManager } from '../utils/UndoManager';
import { FileHandler } from '../utils/FileHandler';
import { BufferPool } from '../core/BufferPool';
import { TimelineModel } from '../core/TimelineModel';
import {
  TimelineUndoManager,
  MoveClipCommand,
  SplitClipCommand,
  DeleteClipCommand,
  TrimClipCommand,
} from '../utils/TimelineUndoManager';
import type { AudioFileInfo, ParsedAudioData } from '../utils/TauriAPI';
import { generateUCSFilename } from '../core/ucs-data';
import { getCurrentWebview } from '@tauri-apps/api/webview';

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

  // ---- Timeline / Multi-track ----
  timelineModel: TimelineModel;
  bufferPool: BufferPool;
  timelineRenderer: TimelineRenderer | null = null;
  sonogramRenderer: SonogramRenderer | null = null;
  timelineUndoManager: TimelineUndoManager;
  /** true when operating in multi-track timeline mode (vs legacy single-buffer). */
  private useTimeline = false;

  // ---- Collapsible Panels ----
  private leftPanel: CollapsiblePanel | null = null;
  private rightPanel: CollapsiblePanel | null = null;
  private bottomPanel: CollapsiblePanel | null = null;
  private analysisPanel: AnalysisPanel | null = null;

  // ---- Cleanup ----
  private unlistenFns: Array<() => void> = [];
  private boundKeydown: (e: KeyboardEvent) => void;

  // ---- File Browser state ----
  private folderPath: string | null = null;
  private folderFiles: AudioFileInfo[] = [];
  /** Track per-file workflow status: 'pending' | 'done' | 'skip' */
  private fileStatuses: Map<string, 'pending' | 'done' | 'skip'> = new Map();
  private searchFilter = '';

  constructor() {
    this.audioEngine = new AudioEngine();
    this.waveformRenderer = new WaveformRenderer(document.getElementById('waveformCanvas') as HTMLCanvasElement);
    this.spectrogramRenderer = new SpectrogramRenderer(document.getElementById('spectrogramCanvas') as HTMLCanvasElement);
    this.undoManager = new UndoManager(null);
    this.metering = new Metering();
    this.boundKeydown = (e: KeyboardEvent) => this.handleKeyboard(e);
    this.fileQueue = new FileQueue();

    this.cuePointManager = new CuePointManager();
    this.cuePointRenderer = new CuePointRenderer(
      document.getElementById('cuepointCanvas') as HTMLCanvasElement,
      this.cuePointManager
    );

    this.mixer = new Mixer(
      document.getElementById('mixerContainer')!,
      this.audioEngine,
      null // Will be set after audio context init
    );

    this.metadataManager = new MetadataManager();

    // Timeline / multi-track
    this.timelineModel = new TimelineModel();
    this.bufferPool = new BufferPool();
    this.timelineUndoManager = new TimelineUndoManager();

    // Timeline renderer shares the waveform canvas (replaces waveform view in timeline mode)
    const waveformCanvas = document.getElementById('waveformCanvas') as HTMLCanvasElement | null;
    if (waveformCanvas) {
      this.timelineRenderer = new TimelineRenderer(waveformCanvas);
      this.setupTimelineCallbacks();
    }

    // Sonogram renderer (optional canvas)
    const sonogramCanvas = document.getElementById('sonogramCanvas') as HTMLCanvasElement | null;
    if (sonogramCanvas) {
      this.sonogramRenderer = new SonogramRenderer(sonogramCanvas);
    }

    this.setupEventListeners();
    this.setupCuePointCallbacks();
    this.setupDragAndDrop();
    this.setupNativeListeners();
    this.setupFileBrowser();
    this.setupInlineMetadata();
    this.setupExportSection();
    this.setupCollapsiblePanels();
    this.updateUI();
  }

  // ==================== Timeline Callbacks ====================

  private setupTimelineCallbacks(): void {
    if (!this.timelineRenderer) return;

    this.timelineRenderer.onPlayheadChange = (sample) => {
      this.timelineModel.timeline.playheadSample = sample;
      // Clear paused state so next play() starts from the new position
      if (this.audioEngine.isPaused) {
        this.audioEngine.isPaused = false;
      }
      if (this.sonogramRenderer) {
        this.sonogramRenderer.setPlayheadPosition(sample);
      }
      const sr = this.timelineModel.timeline.sampleRate;
      this.updatePositionInfo(sample / sr);
    };

    this.timelineRenderer.onClipSelect = (clipId, trackId) => {
      // Update sonogram to show the selected clip's audio
      if (this.sonogramRenderer && this.audioEngine.audioContext) {
        const track = this.timelineModel.timeline.tracks.find(t => t.id === trackId);
        const clip = track?.clips.find(c => c.id === clipId);
        if (clip) {
          const pooled = this.bufferPool.getBuffer(clip.bufferId);
          if (pooled) {
            const regionLen = clip.sourceEnd - clip.sourceStart;
            if (regionLen > 0) {
              const tmpBuf = this.audioEngine.audioContext.createBuffer(
                1, regionLen, pooled.sampleRate,
              );
              const src = pooled.buffer.getChannelData(0);
              tmpBuf.getChannelData(0).set(
                src.subarray(clip.sourceStart, clip.sourceEnd),
              );
              this.sonogramRenderer.setAudioBuffer(tmpBuf);
              this.sonogramRenderer.setSamplesPerPixel(this.timelineRenderer!.samplesPerPixel);
              this.sonogramRenderer.setScrollOffset(0);
            }
          }
        }
      }
      this.updateUI();
    };

    this.timelineRenderer.onClipMove = (clipId, trackId, newOffset) => {
      this.timelineUndoManager.push(
        new MoveClipCommand(this.timelineModel, trackId, clipId, newOffset),
      );
      this.timelineRenderer?.render();

      // Re-schedule playback to reflect move changes on already-playing sources
      if (this.audioEngine.isPlaying && this.useTimeline) {
        const currentSample = Math.floor(
          this.audioEngine.getCurrentTime() * this.timelineModel.timeline.sampleRate,
        );
        this.audioEngine.playTimeline(
          this.timelineModel.timeline, this.bufferPool, currentSample,
        );
      }
    };

    this.timelineRenderer.onClipTrim = (clipId, trackId, edge, newValue) => {
      // Clamp newValue to buffer bounds before applying
      const track = this.timelineModel.timeline.tracks.find(t => t.id === trackId);
      const clip = track?.clips.find(c => c.id === clipId);
      if (!clip) return;
      const pooled = this.bufferPool.getBuffer(clip.bufferId);
      const bufferLength = pooled?.length ?? clip.sourceEnd;

      let clamped = newValue;
      if (edge === 'start') {
        clamped = Math.max(0, Math.min(clip.sourceEnd - 1, newValue));
      } else {
        clamped = Math.max(clip.sourceStart + 1, Math.min(bufferLength, newValue));
      }

      this.timelineUndoManager.push(
        new TrimClipCommand(this.timelineModel, trackId, clipId, edge, clamped),
      );
      this.timelineRenderer?.clearPeakCaches();
      this.timelineRenderer?.render();

      // Re-schedule playback to reflect trim changes on already-playing sources
      if (this.audioEngine.isPlaying && this.useTimeline) {
        const currentSample = Math.floor(
          this.audioEngine.getCurrentTime() * this.timelineModel.timeline.sampleRate,
        );
        this.audioEngine.playTimeline(
          this.timelineModel.timeline, this.bufferPool, currentSample,
        );
      }
    };

    this.timelineRenderer.onClipSplit = (trackId, clipId, splitSample) => {
      this.timelineUndoManager.push(
        new SplitClipCommand(this.timelineModel, trackId, clipId, splitSample),
      );
      this.timelineRenderer?.render();
    };

    this.timelineRenderer.onClipDelete = (trackId, clipId) => {
      this.timelineUndoManager.push(
        new DeleteClipCommand(this.timelineModel, trackId, clipId),
      );
      this.timelineRenderer?.render();
    };

    this.timelineRenderer.onTrackMuteToggle = (trackId) => {
      const track = this.timelineModel.timeline.tracks.find(t => t.id === trackId);
      if (track) {
        track.mute = !track.mute;
        this.mixer.setTrackMute(trackId, track.mute);
      }
    };

    this.timelineRenderer.onTrackSoloToggle = (trackId) => {
      const track = this.timelineModel.timeline.tracks.find(t => t.id === trackId);
      if (track) {
        track.solo = !track.solo;
        this.mixer.setTrackSolo(trackId, track.solo);
      }
    };

    this.timelineRenderer.onZoomChange = () => {
      if (this.sonogramRenderer && this.timelineRenderer) {
        this.sonogramRenderer.setSamplesPerPixel(this.timelineRenderer.samplesPerPixel);
        this.sonogramRenderer.setScrollOffset(this.timelineRenderer.scrollOffsetX);
      }
      this.updateZoomInfo();
    };

    this.timelineRenderer.onScrollChange = () => {
      if (this.sonogramRenderer && this.timelineRenderer) {
        this.sonogramRenderer.setScrollOffset(this.timelineRenderer.scrollOffsetX);
      }
    };

    this.timelineRenderer.onSelectionChange = () => {
      const sel = this.timelineRenderer?.getSelection();
      this.spectrogramRenderer.setSelection(sel ? sel.start : null, sel ? sel.end : null);
      this.updateUI();
    };
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
    document.getElementById('zoomInBtn')!.addEventListener('click', () => this.zoomIn());
    document.getElementById('zoomOutBtn')!.addEventListener('click', () => this.zoomOut());
    document.getElementById('zoomFitBtn')!.addEventListener('click', () => this.zoomFit());

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
    document.addEventListener('keydown', this.boundKeydown);

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
      if (this.sonogramRenderer) {
        this.sonogramRenderer.setSamplesPerPixel(this.waveformRenderer.samplesPerPixel);
        this.sonogramRenderer.setScrollOffset(this.waveformRenderer.scrollOffset);
      }
    };
    this.waveformRenderer.onScrollChange = () => {
      this.spectrogramRenderer.setScrollOffset(this.waveformRenderer.scrollOffset);
      this.cuePointRenderer.setScrollOffset(this.waveformRenderer.scrollOffset);
      if (this.sonogramRenderer) {
        this.sonogramRenderer.setScrollOffset(this.waveformRenderer.scrollOffset);
      }
    };

    // Playback callbacks
    this.audioEngine.onPositionUpdate = (time) => {
      this.updatePositionInfo(time);
      if (this.useTimeline) {
        const sample = Math.floor(time * this.timelineModel.timeline.sampleRate);
        this.timelineRenderer?.setPlayheadPosition(sample);
        if (this.sonogramRenderer) this.sonogramRenderer.setPlayheadPosition(sample);
        this.metering.setPlaybackPosition(sample);
      } else {
        this.waveformRenderer.setPlayheadPosition(time);
        if (this.audioEngine.audioBuffer) {
          const sample = Math.floor(time * this.audioEngine.audioBuffer.sampleRate);
          this.spectrogramRenderer.setPlayheadPosition(sample);
          this.cuePointRenderer.setPlayheadPosition(sample);
          this.metering.setPlaybackPosition(sample);
          if (this.sonogramRenderer) this.sonogramRenderer.setPlayheadPosition(sample);
        }
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
    const dragOverlay = document.getElementById('dragOverlay');
    if (!dragOverlay) return;

    // Listen on the entire document body for broader drag coverage
    let dragCounter = 0;

    document.body.addEventListener('dragenter', (e) => {
      e.preventDefault();
      dragCounter++;
      dragOverlay.classList.add('visible');
    }, false);

    document.body.addEventListener('dragover', (e) => {
      e.preventDefault();
    }, false);

    document.body.addEventListener('dragleave', (e) => {
      e.preventDefault();
      dragCounter--;
      if (dragCounter <= 0) {
        dragCounter = 0;
        dragOverlay.classList.remove('visible');
      }
    }, false);

    document.body.addEventListener('drop', (e) => {
      e.preventDefault();
      dragCounter = 0;
      dragOverlay.classList.remove('visible');
      // In Tauri, file drops are handled by onDragDropEvent in setupNativeListeners
      // (WKWebView does not populate dataTransfer.files for native file drops)
      if (window.appAPI) return;
      const dt = (e as DragEvent).dataTransfer;
      if (!dt) return;
      const files = Array.from(dt.files).filter(f => {
        const ext = f.name.toLowerCase();
        return ext.endsWith('.wav') || ext.endsWith('.aif') || ext.endsWith('.aiff') ||
               ext.endsWith('.flac') || ext.endsWith('.mp3') || ext.endsWith('.ogg');
      });
      if (files.length > 0) {
        this.addFilesToQueue(files);
      }
    }, false);
  }

  setupNativeListeners(): void {
    if (!window.appAPI) return;

    const collect = (p: Promise<() => void>) => {
      p.then(fn => this.unlistenFns.push(fn))
        .catch(err => console.warn('[NativeListeners] setup error:', err));
    };

    collect(window.appAPI.onImportFiles(async (filePaths) => {
      for (const filePath of filePaths) {
        const name = filePath.split('/').pop() || filePath;
        const fileObj = { name, path: filePath };
        const id = this.fileQueue.addFile(fileObj);
        this.renderFileList();
        await this.loadFileFromPath(filePath, id);
      }
    }));

    collect(window.appAPI.onProjectLoad((data) => {
      this.loadProjectFromString(data);
    }));

    collect(window.appAPI.onPluginsScanResult((plugins) => {
      if (this.pluginHost) {
        this.pluginHost.addScannedPlugins(plugins);
      }
    }));

    // Tauri native drag-and-drop (WKWebView does not populate dataTransfer.files)
    try {
      const webview = getCurrentWebview();
      collect(webview.onDragDropEvent((event) => {
        const dragOverlay = document.getElementById('dragOverlay');
        if (event.payload.type === 'enter' || event.payload.type === 'over') {
          dragOverlay?.classList.add('visible');
        } else if (event.payload.type === 'leave') {
          dragOverlay?.classList.remove('visible');
        } else if (event.payload.type === 'drop') {
          dragOverlay?.classList.remove('visible');
          const paths = event.payload.paths.filter((p: string) => {
            const ext = p.toLowerCase();
            return ext.endsWith('.wav') || ext.endsWith('.aif') || ext.endsWith('.aiff') ||
                   ext.endsWith('.flac') || ext.endsWith('.mp3') || ext.endsWith('.ogg');
          });
          if (paths.length > 0) {
            this.handleDroppedPaths(paths);
          }
        }
      }));
    } catch (err) {
      console.warn('[NativeListeners] drag-drop setup failed:', err);
    }

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
      'zoom-in': () => this.zoomIn(),
      'zoom-out': () => this.zoomOut(),
      'zoom-fit': () => this.zoomFit(),
      'toggle-mixer': () => this.mixer.toggle(),
      'toggle-plugin-browser': () => this.togglePluginBrowser(),
      'import': async () => {
        const paths = await window.appAPI!.showOpenDialog({
          title: 'Import Audio',
          multiple: true,
          filters: [{ name: 'Audio Files', extensions: ['wav', 'aif', 'aiff', 'flac', 'mp3', 'ogg'] }],
        });
        if (paths) {
          for (const filePath of paths) {
            const name = filePath.split('/').pop() || filePath;
            const fileObj = { name, path: filePath };
            const id = this.fileQueue.addFile(fileObj);
            this.renderFileList();
            if (!this.audioEngine.audioBuffer) {
              await this.loadFileFromPath(filePath, id);
            }
          }
        }
      },
      'import-folder': async () => {
        const folderPath = await window.appAPI!.openFolderDialog();
        if (folderPath) {
          const audioFiles = await window.appAPI!.scanFolder(folderPath);
          for (const info of audioFiles) {
            const fileObj = { name: info.name, path: info.path };
            const id = this.fileQueue.addFile(fileObj);
            this.renderFileList();
            if (!this.audioEngine.audioBuffer) {
              await this.loadFileFromPath(info.path, id);
            }
          }
        }
      },
    };

    for (const [action, handler] of Object.entries(menuActions)) {
      collect(window.appAPI.onMenuAction(action, handler));
    }

    collect(window.appAPI.onMenuAction('channel-layout', (numChannels: number) => {
      this.changeChannelLayout(numChannels);
    }));
  }

  private async handleDroppedPaths(paths: string[]): Promise<void> {
    for (const filePath of paths) {
      const name = filePath.split('/').pop() || filePath;
      const fileObj = { name, path: filePath };
      const id = this.fileQueue.addFile(fileObj);
      this.renderFileList();
      await this.loadFileFromPath(filePath, id);
    }
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
        case '[':
          e.preventDefault();
          this.leftPanel?.toggle();
          return;
        case ']':
          e.preventDefault();
          this.rightPanel?.toggle();
          return;
        case '\\':
          e.preventDefault();
          this.bottomPanel?.toggle();
          return;
      }
    }

    switch (e.key) {
      case ' ':
        e.preventDefault();
        this.audioEngine.isPlaying ? this.pause() : this.play();
        break;
      case '+': case '=': this.zoomIn(); break;
      case '-': this.zoomOut(); break;
      case 'ArrowLeft':
        e.preventDefault();
        if (this.audioEngine.audioBuffer) this.movePlayhead(-1);
        break;
      case 'ArrowRight':
        e.preventDefault();
        if (this.audioEngine.audioBuffer) this.movePlayhead(1);
        break;
      case 's': case 'S':
        if (this.useTimeline) {
          // Split is handled by TimelineRenderer's own keydown handler
          // (when canvas is focused), but also allow from global keyboard
          const selected = this.timelineModel.timeline.selectedClipIds;
          if (selected.length > 0) {
            for (const track of this.timelineModel.timeline.tracks) {
              for (const clip of track.clips) {
                if (selected.includes(clip.id)) {
                  this.timelineUndoManager.push(
                    new SplitClipCommand(this.timelineModel, track.id, clip.id, this.timelineModel.timeline.playheadSample),
                  );
                  this.timelineRenderer?.render();
                  break;
                }
              }
            }
          }
        }
        break;
      case 'Delete': case 'Backspace':
        e.preventDefault();
        if (this.useTimeline) {
          const selected = this.timelineModel.timeline.selectedClipIds;
          if (selected.length > 0) {
            for (const track of this.timelineModel.timeline.tracks) {
              for (const clip of track.clips) {
                if (selected.includes(clip.id)) {
                  this.timelineUndoManager.push(
                    new DeleteClipCommand(this.timelineModel, track.id, clip.id),
                  );
                }
              }
            }
            this.timelineModel.timeline.selectedClipIds = [];
            this.timelineRenderer?.render();
          }
        } else {
          this.deleteSelection();
        }
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
      // Yield a frame so the loading indicator renders before heavy IPC work
      await new Promise<void>(r => requestAnimationFrame(() => r()));
      console.log('[IMPORT] Step 1: Reading file...');
      const result = await FileHandler.importFilePath(filePath);

      let audioBuffer: AudioBuffer;
      let parsedData: ParsedAudioData | null = null;
      if (result instanceof ArrayBuffer) {
        // Non-WAV: raw bytes need decodeAudioData
        console.log(`[IMPORT] Step 2: File read complete (${(result.byteLength / 1024 / 1024).toFixed(1)} MB). Decoding...`);
        audioBuffer = await this.audioEngine.loadAudio(result);
      } else {
        // WAV: already parsed by Rust — create AudioBuffer directly
        parsedData = result;
        const dataMB = (result.num_samples * result.channels * 4 / (1024 * 1024)).toFixed(1);
        console.log(`[IMPORT] Step 2: Rust WAV parse complete (${result.channels}ch, ${result.sample_rate}Hz, ${dataMB} MB). Loading...`);
        audioBuffer = await this.audioEngine.loadFromParsedData(result);
      }

      console.log('[IMPORT] Step 3: Audio loaded. Loading UI...');
      this.onAudioLoaded(audioBuffer, fileId, parsedData);
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

  private onAudioLoaded(audioBuffer: AudioBuffer, fileId: number | null, parsedData?: ParsedAudioData | null): void {
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

      // Legacy single-buffer renderers
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

      // ---- Timeline multi-track setup ----
      if (this.timelineRenderer) {
        this.useTimeline = true;
        this.waveformRenderer.disabled = true;
        this.waveformRenderer.detachListeners();
        this.bufferPool.clear();
        this.timelineModel.createTimeline(audioBuffer.sampleRate);
        this.timelineUndoManager.clear();

        // Import into buffer pool (splits into mono PooledBuffers)
        // When raw IPC data is available, use importFromRawChannels to skip the
        // intermediate multi-channel AudioBuffer copy (subarray view → copyToChannel)
        const bufferIds = parsedData
          ? this.bufferPool.importFromRawChannels(
              parsedData.samples,
              parsedData.channels,
              parsedData.num_samples,
              parsedData.sample_rate,
              this.fileName || 'audio',
            )
          : this.bufferPool.importMultiChannel(audioBuffer, this.fileName || 'audio');

        // Create tracks + clips in timeline model
        this.timelineModel.importMultiChannelFile(
          bufferIds,
          this.fileName || 'audio',
          audioBuffer.sampleRate,
          audioBuffer.length,
        );

        // Setup audio engine track routing
        this.audioEngine.setupTrackRouting(this.timelineModel.timeline.tracks);

        // Wire up mixer in track mode
        this.mixer.setupTracks(this.timelineModel.timeline.tracks);

        // Feed timeline to renderer
        this.timelineRenderer.setTimeline(this.timelineModel.timeline, this.bufferPool);
        this.timelineRenderer.zoomFit();

        // Sonogram: show first channel
        if (this.sonogramRenderer) {
          this.sonogramRenderer.setAudioBuffer(audioBuffer);
          this.sonogramRenderer.setSamplesPerPixel(this.timelineRenderer.samplesPerPixel);
          this.sonogramRenderer.setScrollOffset(this.timelineRenderer.scrollOffsetX);
        }
      } else {
        this.useTimeline = false;
        this.waveformRenderer.disabled = false;
        // Legacy channel-mode mixer
        this.mixer.setupChannels(audioBuffer.numberOfChannels);

        // Sonogram in legacy mode
        if (this.sonogramRenderer) {
          this.sonogramRenderer.setAudioBuffer(audioBuffer);
          this.sonogramRenderer.setSamplesPerPixel(this.waveformRenderer.samplesPerPixel);
          this.sonogramRenderer.setScrollOffset(this.waveformRenderer.scrollOffset);
        }
      }

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
      if (this.useTimeline) {
        this.audioEngine.stopTimeline();
      } else {
        this.audioEngine.stop();
      }
      this.audioEngine.audioBuffer = null;
      this.waveformRenderer.setAudioBuffer(null);
      this.spectrogramRenderer.setAudioBuffer(null);
      this.cuePointManager.clear();
      this.cuePointRenderer.setAudioBuffer(null);
      if (this.sonogramRenderer) this.sonogramRenderer.setAudioBuffer(null);
      if (this.timelineRenderer) {
        this.timelineRenderer.timeline = null;
        this.timelineRenderer.render();
      }
      this.bufferPool.clear();
      this.useTimeline = false;
      this.waveformRenderer.disabled = false;
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
    // Timeline mode: use playTimeline
    if (this.useTimeline) {
      const tl = this.timelineModel.timeline;
      if (tl.tracks.length === 0) return;
      this.audioEngine.init().then(() => {
        // Ensure spectrum analyser is connected (belt-and-suspenders)
        const analyser = this.audioEngine.getAnalyserNode();
        if (analyser) {
          this.spectrogramRenderer.setAnalyserNode(analyser);
        }
        // Resume from paused position, or start from playhead
        const startSample = this.audioEngine.isPaused
          ? Math.floor(this.audioEngine.getCurrentTime() * tl.sampleRate)
          : tl.playheadSample;
        this.audioEngine.playTimeline(tl, this.bufferPool, startSample);
        this.startRealtimeAnalysis();
        this.updateUI();
      });
      return;
    }

    // Legacy single-buffer mode
    if (!this.audioEngine.audioBuffer) return;

    const selection = this.waveformRenderer.getSelection();
    if (selection) {
      const startTime = selection.start / this.audioEngine.audioBuffer.sampleRate;
      const endTime = selection.end / this.audioEngine.audioBuffer.sampleRate;
      this.audioEngine.playSelection(startTime, endTime);
    } else if (this.audioEngine.isPaused) {
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
    if (this.useTimeline) {
      this.audioEngine.stopTimeline();
    } else {
      this.audioEngine.stop();
    }
    this.stopRealtimeAnalysis();
    this.waveformRenderer.setPlayheadPosition(0);
    this.spectrogramRenderer.setPlayheadPosition(0);
    if (this.timelineRenderer) this.timelineRenderer.setPlayheadPosition(0);
    if (this.sonogramRenderer) this.sonogramRenderer.setPlayheadPosition(0);
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

  // ==================== Zoom ====================

  zoomIn(): void {
    if (this.useTimeline && this.timelineRenderer) {
      this.timelineRenderer.zoomIn();
    } else {
      this.waveformRenderer.zoomIn();
    }
  }

  zoomOut(): void {
    if (this.useTimeline && this.timelineRenderer) {
      this.timelineRenderer.zoomOut();
    } else {
      this.waveformRenderer.zoomOut();
    }
  }

  zoomFit(): void {
    if (this.useTimeline && this.timelineRenderer) {
      this.timelineRenderer.zoomFit();
    } else {
      this.waveformRenderer.zoomFit();
    }
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
    if (this.useTimeline) {
      if (this.timelineUndoManager.canUndo()) {
        this.timelineUndoManager.undo();
        this.timelineRenderer?.render();
        this.updateUI();
      }
      return;
    }
    if (!this.undoManager.canUndo() || !this.audioEngine.audioBuffer) return;
    this.stop();
    const previousBuffer = this.undoManager.undo(this.audioEngine.audioBuffer);
    if (previousBuffer) this.applyBuffer(previousBuffer);
  }

  redo(): void {
    if (this.useTimeline) {
      if (this.timelineUndoManager.canRedo()) {
        this.timelineUndoManager.redo();
        this.timelineRenderer?.render();
        this.updateUI();
      }
      return;
    }
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

  // ==================== File Browser ====================

  private setupFileBrowser(): void {
    const openFolderBtn = document.getElementById('openFolderBtn');
    if (openFolderBtn) {
      openFolderBtn.addEventListener('click', () => this.openFolder());
    }

    const searchInput = document.getElementById('fileBrowserSearch') as HTMLInputElement | null;
    if (searchInput) {
      searchInput.addEventListener('input', () => {
        this.searchFilter = searchInput.value.toLowerCase();
        this.renderFileBrowser();
      });
    }

    const markAllBtn = document.getElementById('markAllDoneBtn');
    if (markAllBtn) {
      markAllBtn.addEventListener('click', () => {
        for (const f of this.folderFiles) {
          this.fileStatuses.set(f.path, 'done');
        }
        this.renderFileBrowser();
      });
    }

    const resetAllBtn = document.getElementById('resetAllBtn');
    if (resetAllBtn) {
      resetAllBtn.addEventListener('click', () => {
        this.fileStatuses.clear();
        this.renderFileBrowser();
      });
    }
  }

  private async openFolder(): Promise<void> {
    if (!window.appAPI) return;
    try {
      const folder = await window.appAPI.openFolderDialog();
      if (!folder) return;
      this.folderPath = folder;

      const pathEl = document.getElementById('folderPath');
      if (pathEl) {
        pathEl.textContent = folder.split('/').pop() || folder;
        pathEl.title = folder;
      }

      this.folderFiles = await window.appAPI.scanFolder(folder);
      this.fileStatuses.clear();
      this.renderFileBrowser();
    } catch (err: any) {
      console.error('[FileBrowser] openFolder error:', err);
    }
  }

  private renderFileBrowser(): void {
    const listEl = document.getElementById('fileBrowserList');
    const statsEl = document.getElementById('fileBrowserStats');
    if (!listEl) return;

    if (this.folderFiles.length === 0) {
      listEl.innerHTML = '<div class="file-list-empty">Open a folder to browse files</div>';
      if (statsEl) statsEl.textContent = '';
      return;
    }

    const filtered = this.searchFilter
      ? this.folderFiles.filter(f => f.name.toLowerCase().includes(this.searchFilter))
      : this.folderFiles;

    listEl.innerHTML = '';
    for (const f of filtered) {
      const status = this.fileStatuses.get(f.path) || 'pending';
      const item = document.createElement('div');
      item.className = `file-browser-item status-${status}`;
      item.dataset.path = f.path;

      const nameSpan = document.createElement('span');
      nameSpan.className = 'fb-name';
      nameSpan.textContent = f.name;
      nameSpan.title = f.path;

      const sizeSpan = document.createElement('span');
      sizeSpan.className = 'fb-size';
      sizeSpan.textContent = f.size > 1048576
        ? (f.size / 1048576).toFixed(1) + ' MB'
        : (f.size / 1024).toFixed(0) + ' KB';

      const statusBtn = document.createElement('button');
      statusBtn.className = 'fb-status-btn';
      statusBtn.textContent = status === 'done' ? '\u2713' : status === 'skip' ? '\u2212' : '\u25CB';
      statusBtn.title = `Status: ${status} (click to cycle)`;
      statusBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const cur = this.fileStatuses.get(f.path) || 'pending';
        const next = cur === 'pending' ? 'done' : cur === 'done' ? 'skip' : 'pending';
        this.fileStatuses.set(f.path, next);
        this.renderFileBrowser();
      });

      item.appendChild(statusBtn);
      item.appendChild(nameSpan);
      item.appendChild(sizeSpan);

      item.addEventListener('click', () => this.loadFileFromBrowser(f));
      listEl.appendChild(item);
    }

    // Update stats
    if (statsEl) {
      const total = this.folderFiles.length;
      const done = Array.from(this.fileStatuses.values()).filter(s => s === 'done').length;
      statsEl.textContent = `${done}/${total} done`;
    }
  }

  private async loadFileFromBrowser(file: AudioFileInfo): Promise<void> {
    const id = this.fileQueue.addFile({ name: file.name, path: file.path });
    this.renderFileList();
    await this.loadFileFromPath(file.path, id);
  }

  // ==================== Collapsible Panels ====================

  private setupCollapsiblePanels(): void {
    const leftSidebar = document.getElementById('leftSidebar');
    const rightSidebar = document.getElementById('rightSidebar');
    const analysisPanelEl = document.getElementById('analysisPanel');

    if (leftSidebar) {
      this.leftPanel = new CollapsiblePanel({
        container: leftSidebar,
        direction: 'horizontal',
        side: 'left',
        defaultSize: 220,
        minSize: 100,
        headerSelector: '.file-browser-header',
        storageKeyPrefix: 'panel.left',
        collapsedByDefault: false,
      });
    }

    if (rightSidebar) {
      this.rightPanel = new CollapsiblePanel({
        container: rightSidebar,
        direction: 'horizontal',
        side: 'right',
        defaultSize: 260,
        minSize: 120,
        headerSelector: '.panel-header',
        storageKeyPrefix: 'panel.right',
        collapsedByDefault: false,
      });
    }

    if (analysisPanelEl) {
      this.analysisPanel = new AnalysisPanel(analysisPanelEl);

      this.bottomPanel = new CollapsiblePanel({
        container: analysisPanelEl,
        direction: 'vertical',
        side: 'bottom',
        defaultSize: 200,
        minSize: 60,
        headerSelector: '.analysis-panel-header',
        storageKeyPrefix: 'panel.bottom',
        collapsedByDefault: true,
      });

      this.analysisPanel.onRequestExpand = () => {
        this.bottomPanel?.expand();
      };

      // Force analysis renderers to resize when bottom panel expands.
      // Double-rAF ensures the browser has fully computed layout after
      // display:none → visible transition.
      this.bottomPanel.onStateChange = (collapsed: boolean) => {
        if (!collapsed) {
          requestAnimationFrame(() => requestAnimationFrame(() => {
            this.spectrogramRenderer.resize();
            this.sonogramRenderer?.resize();
          }));
        }
      };

      // Force the newly-visible renderer to resize on tab switch
      this.analysisPanel.onTabChange = (tabId: string) => {
        requestAnimationFrame(() => requestAnimationFrame(() => {
          if (tabId === 'spectrum') {
            this.spectrogramRenderer.resize();
          } else if (tabId === 'sonogram') {
            this.sonogramRenderer?.resize();
          }
        }));
      };
    }
  }

  // ==================== Inline Metadata Tabs ====================

  private setupInlineMetadata(): void {
    const tabBtns = document.querySelectorAll('.metadata-tab-btn');
    tabBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const tabId = (btn as HTMLElement).dataset.tab;
        if (!tabId) return;

        // Toggle active tab button
        tabBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        // Toggle panels
        const panels = document.querySelectorAll('.metadata-tab-panel');
        panels.forEach(panel => {
          const panelTab = (panel as HTMLElement).dataset.tab;
          if (panelTab === tabId) {
            panel.classList.remove('hidden');
          } else {
            panel.classList.add('hidden');
          }
        });
      });
    });
  }

  // ==================== Export Section ====================

  private setupExportSection(): void {
    const exportPathBtn = document.getElementById('exportPathBtn');
    if (exportPathBtn) {
      exportPathBtn.addEventListener('click', async () => {
        if (!window.appAPI) return;
        try {
          const folder = await window.appAPI.openFolderDialog();
          if (!folder) return;
          const el = document.getElementById('exportPath');
          if (el) {
            el.textContent = folder.split('/').pop() || folder;
            el.title = folder;
            el.dataset.fullPath = folder;
          }
        } catch (err: any) {
          console.error('[Export] choose folder error:', err);
        }
      });
    }

    const exportActionBtn = document.getElementById('exportActionBtn');
    if (exportActionBtn) {
      exportActionBtn.addEventListener('click', async () => {
        const pathEl = document.getElementById('exportPath');
        const exportFolder = pathEl?.dataset.fullPath;
        if (!exportFolder) {
          // Fallback to the modal-based export
          this.showExportModal();
          return;
        }
        // Quick export to the chosen folder using current settings
        await this.quickExport(exportFolder);
      });
    }
  }

  private async quickExport(folder: string): Promise<void> {
    if (!this.audioEngine.audioBuffer || !window.appAPI) return;

    const btn = document.getElementById('exportActionBtn') as HTMLButtonElement | null;
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Exporting...';
    }

    try {
      const buffer = this.audioEngine.audioBuffer;
      const formatEl = document.getElementById('exportFilenameFormat') as HTMLInputElement | null;
      const pattern = formatEl?.value || '{filename}';

      // Build filename from pattern
      let baseName = pattern
        .replace('{filename}', (this.fileName || 'audio').replace(/\.[^/.]+$/, ''))
        .replace('{CatID}', (document.getElementById('inlineCatId') as HTMLInputElement)?.value || '')
        .replace('{FXName}', (document.getElementById('inlineFxName') as HTMLInputElement)?.value || '')
        .replace('{CreatorID}', (document.getElementById('inlineCreatorId') as HTMLInputElement)?.value || '')
        .replace('{SourceID}', (document.getElementById('inlineSourceId') as HTMLInputElement)?.value || '');

      // Remove trailing underscores/hyphens from empty tokens
      baseName = baseName.replace(/[_-]+$/, '').replace(/[_-]{2,}/g, '_');
      if (!baseName) baseName = this.fileName?.replace(/\.[^/.]+$/, '') || 'audio';

      // Async encoding — yields to main thread to keep UI responsive
      const blob = await FileHandler.exportWAVAsync(buffer, 24, 'none', undefined, (progress) => {
        if (btn) btn.textContent = `Exporting ${Math.round(progress * 100)}%...`;
      });
      const arrayBuf = await blob.arrayBuffer();
      const fullPath = `${folder}/${baseName}.wav`;

      if (btn) btn.textContent = 'Writing...';
      await window.appAPI.writeFile(fullPath, arrayBuf);
      console.log(`[Export] Written to ${fullPath}`);

      // Mark file as done in browser if it matches
      const activeId = this.fileQueue.getActive();
      if (activeId !== null) {
        const activeFile = this.fileQueue.getFile(activeId);
        if (activeFile && 'path' in activeFile) {
          this.fileStatuses.set((activeFile as any).path, 'done');
          this.renderFileBrowser();
        }
      }

      // Brief success flash
      if (btn) {
        btn.textContent = 'Done!';
        await new Promise<void>(r => setTimeout(r, 1200));
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[Export] error:', err);
      alert('Export failed: ' + msg);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Export';
      }
    }
  }

  // ==================== UI ====================

  showExportModal(): void {
    if (!this.audioEngine.audioBuffer) return;

    // Read metadata directly from the right sidebar inline fields (skip dialog)
    this.pendingExportMetadata = this.gatherInlineMetadata();

    // Build UCS filename from sidebar fields
    const catId = (document.getElementById('inlineCatId') as HTMLInputElement)?.value || '';
    const fxName = (document.getElementById('inlineFxName') as HTMLInputElement)?.value || '';
    const creatorId = (document.getElementById('inlineCreatorId') as HTMLInputElement)?.value || '';
    const sourceId = (document.getElementById('inlineSourceId') as HTMLInputElement)?.value || '';
    if (catId && fxName) {
      this.pendingUCSFilename = generateUCSFilename(catId, fxName, creatorId, sourceId);
    } else {
      this.pendingUCSFilename = null;
    }

    // Show export settings dialog directly
    const hasSelection = this.waveformRenderer.hasSelection();
    const checkbox = document.getElementById('exportSelection') as HTMLInputElement;
    checkbox.disabled = !hasSelection;
    checkbox.checked = hasSelection;
    this.showModal('exportModal');
  }

  /** Gather metadata from the inline sidebar fields. */
  private gatherInlineMetadata(): ExportMetadata {
    const val = (id: string) => (document.getElementById(id) as HTMLInputElement)?.value || '';
    return {
      bpiDescription: val('inlineDescription'),
      originator: 'FieldCorder',
      originatorRef: '',
      project: '',
      scene: val('inlineScene'),
      take: val('inlineTake'),
      tape: val('inlineTape'),
      note: val('inlineNote'),
      circled: false,
      wildTrack: false,
      trackNames: [],
      ucsCategory: val('inlineUcsCategory'),
      ucsSubCategory: val('inlineUcsSubCategory'),
      ucsCatId: val('inlineCatId'),
      ucsFxName: val('inlineFxName'),
      ucsCreatorId: val('inlineCreatorId'),
      ucsSourceId: val('inlineSourceId'),
      recordist: '',
      microphone: '',
      micPerspective: '',
      location: '',
      library: '',
      keywords: '',
    };
  }

  showNormalizeModal(): void { this.showModal('normalizeModal'); }
  showGainModal(): void { this.showModal('gainModal'); }

  showModal(id: string): void {
    document.getElementById(id)?.classList.add('visible');
  }

  hideModal(id: string): void {
    document.getElementById(id)?.classList.remove('visible');
  }

  async exportFile(): Promise<void> {
    const format = (document.getElementById('exportFormat') as HTMLSelectElement).value;
    const bitDepth = parseInt((document.getElementById('exportBitDepth') as HTMLSelectElement).value);
    const dither = (document.getElementById('exportDither') as HTMLSelectElement).value;
    const exportSelection = (document.getElementById('exportSelection') as HTMLInputElement).checked;

    const confirmBtn = document.getElementById('exportConfirmBtn') as HTMLButtonElement | null;
    if (confirmBtn) {
      confirmBtn.disabled = true;
      confirmBtn.textContent = 'Exporting...';
    }

    try {
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
        blob = await FileHandler.exportWAVAsync(bufferToExport, bitDepth, dither, metadata, (progress) => {
          if (confirmBtn) confirmBtn.textContent = `Exporting ${Math.round(progress * 100)}%...`;
        });
        extension = '.wav';
      } else {
        // AIF export — yield first so button text updates
        if (confirmBtn) confirmBtn.textContent = 'Exporting...';
        await new Promise<void>(resolve => setTimeout(resolve, 0));
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

      const defaultName = baseName + fileNameSuffix + extension;

      if (window.appAPI) {
        // Tauri: show native save dialog → write via fs plugin
        const savePath = await window.appAPI.showSaveDialog({
          title: 'Export Audio',
          defaultPath: defaultName,
          filters: [{ name: format === 'wav' ? 'WAV Audio' : 'AIFF Audio', extensions: [format === 'wav' ? 'wav' : 'aif'] }],
        });
        if (savePath) {
          if (confirmBtn) confirmBtn.textContent = 'Writing...';
          const arrayBuf = await blob.arrayBuffer();
          await window.appAPI.writeFile(savePath, arrayBuf);
          console.log(`[Export] Written to ${savePath}`);
        }
      } else {
        // Browser fallback
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = defaultName;
        a.click();
        URL.revokeObjectURL(url);
      }

      this.pendingExportMetadata = null;
      this.pendingUCSFilename = null;
      this.hideModal('exportModal');
    } finally {
      // Always clean up both modals and button state
      this.metadataManager.hide();
      this.hideModal('exportModal');
      if (confirmBtn) {
        confirmBtn.disabled = false;
        confirmBtn.textContent = 'Export';
      }
    }
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
    const canUndo = this.useTimeline ? this.timelineUndoManager.canUndo() : this.undoManager.canUndo();
    const canRedo = this.useTimeline ? this.timelineUndoManager.canRedo() : this.undoManager.canRedo();
    setDisabled('undoBtn', !canUndo);
    setDisabled('redoBtn', !canRedo);
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

    // Status bar (bottom)
    const el = document.getElementById('fileInfo');
    if (el) {
      if (!buffer) {
        el.textContent = 'No file loaded';
      } else {
        const duration = formatTime(buffer.duration);
        const sampleRate = (buffer.sampleRate / 1000).toFixed(1) + ' kHz';
        const channels = buffer.numberOfChannels;
        const channelLabel = channels === 1 ? 'Mono' : channels === 2 ? 'Stereo' :
          channels === 4 ? 'Quad' : channels === 6 ? '5.1' : `${channels}ch`;
        el.textContent = `${this.fileName} | ${duration} | ${sampleRate} | ${channelLabel}`;
      }
    }

    // Right sidebar File Info panel
    const nameEl = document.getElementById('currentFileName');
    const chEl = document.getElementById('fileChannels');
    const srEl = document.getElementById('fileSampleRate');
    const bdEl = document.getElementById('fileBitDepth');
    const durEl = document.getElementById('fileDuration');

    if (!buffer) {
      if (nameEl) nameEl.textContent = 'No file loaded';
      if (chEl) chEl.textContent = '-';
      if (srEl) srEl.textContent = '-';
      if (bdEl) bdEl.textContent = '-';
      if (durEl) durEl.textContent = '-';
      return;
    }

    const ch = buffer.numberOfChannels;
    if (nameEl) nameEl.textContent = this.fileName || 'Untitled';
    if (chEl) chEl.textContent = ch === 1 ? 'Mono' : ch === 2 ? 'Stereo' :
      ch === 4 ? 'Quad' : ch === 6 ? '5.1' : `${ch}ch`;
    if (srEl) srEl.textContent = (buffer.sampleRate / 1000).toFixed(1) + ' kHz';
    if (bdEl) bdEl.textContent = '32-bit float'; // Web Audio always uses 32-bit float internally
    if (durEl) durEl.textContent = formatTime(buffer.duration);
  }

  updatePositionInfo(time: number): void {
    const el = document.getElementById('positionInfo');
    if (el) el.textContent = formatTime(time);
  }

  updateZoomInfo(): void {
    const spp = this.useTimeline && this.timelineRenderer
      ? this.timelineRenderer.samplesPerPixel
      : this.waveformRenderer.samplesPerPixel;
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

  // ==================== Cleanup ====================

  async destroy(): Promise<void> {
    this.stopRealtimeAnalysis();
    cancelAnimationFrame(this.meterAnimationFrame);
    document.removeEventListener('keydown', this.boundKeydown);
    for (const unlisten of this.unlistenFns) {
      unlisten();
    }
    this.unlistenFns = [];
    this.leftPanel?.destroy();
    this.rightPanel?.destroy();
    this.bottomPanel?.destroy();
    this.analysisPanel?.destroy();
    this.waveformRenderer.destroy();
    this.spectrogramRenderer.destroy();
    await this.audioEngine.destroy();
  }
}
