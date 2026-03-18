import { AudioEngine } from '../core/AudioEngine';
import { formatTime, CHANNEL_NAMES, CHANNEL_COLORS, PluginInfo, TrackInsert, ExportMetadata, Clip, TrackChannelCount, createDefaultExportMetadata, SessionData } from '../core/types';
import { serializeSession, deserializeSession, resolveAbsolutePath } from '../core/SessionManager';
import { formatSampleRate, hasSampleRateMismatch } from '../utils/sampleRateUtils';
import { PluginParameterPanel } from './PluginParameterPanel';
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
import { FileHandler } from '../utils/FileHandler';
import { BufferPool } from '../core/BufferPool';
import { encodeWavAsync, WavMetadata } from '../core/WavEncoder';
import { encodeMp3Async, Mp3Metadata } from '../core/Mp3Encoder';
import { TimelineModel } from '../core/TimelineModel';
import { renderTimelineOffline } from '../core/OfflineRender';
import {
  TimelineUndoManager,
  CompoundCommand,
  SplitClipCommand,
  DeleteClipCommand,
  ClipDragCommand,
  EditClipGainCommand,
  EditClipFadeCommand,
  AddCuePointCommand,
  RemoveCuePointCommand,
  MoveCuePointCommand,
  DeleteTimeRangeCommand,
  ReverseClipCommand,
  NormalizeClipCommand,
  DenoiseClipCommand,
  DeleteTrackCommand,
  ImportFileAtPositionCommand,
  ImportAudioToNewTrackCommand,
  CrossTrackChannelCommand,
  CrossfadeCommand,
  MergeToStereoCommand,
} from '../utils/TimelineUndoManager';
import type { AudioFileInfo, AudioFileMeta, ParsedAudioData } from '../utils/TauriAPI';
import {
  getSidecarPath,
  serializeMarkingStatus,
  deserializeMarkingStatus,
  cycleMarkingStatus,
  type FileMarkingStatus,
} from '../utils/fileBrowserMarking';
import { generateUCSFilename, parseUCSFilename } from '../core/ucs-data';
import { getCurrentWebview } from '@tauri-apps/api/webview';

/**
 * Main application controller for FieldCorder DAW.
 * Orchestrates all components and handles user interactions.
 */
export class App {
  audioEngine: AudioEngine;
  waveformRenderer: WaveformRenderer;
  spectrogramRenderer: SpectrogramRenderer;
  metering: Metering;
  audioEditor: AudioEditor | null = null;
  fileName: string | null = null;
  private originalBitDepth: number | null = null;
  fileQueue: FileQueue;
  cuePointManager: CuePointManager;
  cuePointRenderer: CuePointRenderer;
  mixer: Mixer;
  pluginHost: PluginHost | null = null;
  pluginParameterPanel: PluginParameterPanel;
  metadataManager: MetadataManager;
  pendingCuePointSample: number | undefined;
  meterAnimationFrame = 0;
  private pendingExportMetadata: ExportMetadata | null = null;
  private pendingUCSFilename: string | null = null;
  private filenameLocked = false;
  private pluginInsertTargetTrackId: string | null = null;

  // ---- Timeline / Multi-track ----
  timelineModel: TimelineModel;
  bufferPool: BufferPool;
  timelineRenderer: TimelineRenderer | null = null;
  sonogramRenderer: SonogramRenderer | null = null;
  timelineUndoManager: TimelineUndoManager;
  /** Set during clip drag when playback was active; cleared on drag end to resume. */
  private _pendingPlaybackResume = false;
  /** Captures clip state at the start of a drag (move or trim) for single-undo. */
  private _dragStartSnapshot: { clipId: string; trackId: string; clip: Clip } | null = null;
  /** Snapshots of other selected clips for batch-move undo. */
  private _dragBatchSnapshots: Array<{ clipId: string; trackId: string; clip: Clip }> | null = null;
  /** Tracks the current track of the dragged clip (updates during cross-track moves). */
  private _dragCurrentTrackId: string | null = null;
  private _dragGainOriginal: number | null = null;
  private _dragFadeOriginal: { fadeIn: number; fadeOut: number } | null = null;
  private _dragFadeCurveOriginal: { clipId: string; trackId: string; edge: 'in' | 'out'; curve: number } | null = null;
  /** When dragging over a compatible cross-channel track, stores target track ID for split/merge on drag end. */
  private _dragCrossChannelTarget: { targetTrackId: string; newOffset: number } | null = null;

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
  private folderFiles: AudioFileMeta[] = [];
  /** Track per-file workflow status. */
  private fileStatuses: Map<string, FileMarkingStatus> = new Map();
  private searchFilter = '';
  private selectedBrowserFile: AudioFileMeta | null = null;
  /** True after the first file import has pre-filled the inline metadata fields. */
  private metadataPreFilled = false;

  // ---- Session file state ----
  /** Path to the currently open .fcs session file, or null for unsaved. */
  private _sessionFilePath: string | null = null;
  /** True when there are unsaved changes since the last save. */
  private _sessionDirty: boolean = false;

  // ---- Session metadata ----
  /** Editable metadata for the current session, pre-filled from the first imported file. */
  private sessionMetadata: ExportMetadata = createDefaultExportMetadata();
  /** Custom mouse drag state for file browser → timeline drag (replaces HTML5 drag/drop for WKWebView). */
  private fileDragState: {
    file: AudioFileMeta;
    active: boolean;
    startX: number;
    startY: number;
  } | null = null;
  /** Suppress the next click event after a drag completes (prevent click firing on drag-end). */
  private suppressNextClick = false;

  constructor() {
    this.audioEngine = new AudioEngine();
    this.waveformRenderer = new WaveformRenderer(document.getElementById('waveformCanvas') as HTMLCanvasElement);
    this.spectrogramRenderer = new SpectrogramRenderer(document.getElementById('spectrogramCanvas') as HTMLCanvasElement);
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

    this.pluginParameterPanel = new PluginParameterPanel();
    this.metadataManager = new MetadataManager();

    // Timeline / multi-track
    this.timelineModel = new TimelineModel();
    this.bufferPool = new BufferPool();
    this.timelineUndoManager = new TimelineUndoManager();
    this.timelineUndoManager.onChange = () => this.markDirty();

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

    // Start with a blank project so the timeline is visible immediately
    this.newBlankProject();
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
      // Auto-add parent track to selectedTrackIds
      if (!this.timelineModel.timeline.selectedTrackIds.includes(trackId)) {
        this.timelineModel.timeline.selectedTrackIds.push(trackId);
      }
      // Update sonogram to show the selected clip's audio
      if (this.sonogramRenderer && this.audioEngine.audioContext) {
        const track = this.timelineModel.timeline.tracks.find(t => t.id === trackId);
        const clip = track?.clips.find(c => c.id === clipId);
        if (clip) {
          const pooled = this.bufferPool.getBuffer(clip.bufferIds[0]);
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

    this.timelineRenderer.onClipMove = (clipId, sourceTrackId, targetTrackId, newOffset) => {
      // Snapshot original state on first move of this drag
      if (!this._dragStartSnapshot) {
        const track = this.timelineModel.timeline.tracks.find(t => t.id === sourceTrackId);
        const clip = track?.clips.find(c => c.id === clipId);
        if (clip) this._dragStartSnapshot = { clipId, trackId: sourceTrackId, clip: { ...clip } };
        // Also snapshot other selected clips for batch move
        this._dragBatchSnapshots = [];
        for (const selId of this.timelineModel.timeline.selectedClipIds) {
          if (selId === clipId) continue;
          for (const t of this.timelineModel.timeline.tracks) {
            const c = t.clips.find(cl => cl.id === selId);
            if (c) {
              this._dragBatchSnapshots.push({ clipId: selId, trackId: t.id, clip: { ...c } });
              break;
            }
          }
        }
      }

      // Channel compatibility check for cross-track moves
      let effectiveTargetTrackId = targetTrackId;
      if (sourceTrackId !== targetTrackId) {
        const sourceTrack = this.timelineModel.timeline.tracks.find(t => t.id === sourceTrackId);
        const targetTrack = this.timelineModel.timeline.tracks.find(t => t.id === targetTrackId);
        if (sourceTrack && targetTrack && sourceTrack.channels !== targetTrack.channels) {
          // Different channel count: block move during drag, handle on drag end
          effectiveTargetTrackId = sourceTrackId;
          const compatible = this.isChannelMoveCompatible(sourceTrack, targetTrack);
          if (compatible) {
            // Track intended target for split/merge on drag end
            this._dragCrossChannelTarget = { targetTrackId, newOffset };
          } else {
            this._dragCrossChannelTarget = null;
          }
        } else {
          // Same channel count or same track: clear cross-channel target
          this._dragCrossChannelTarget = null;
        }
      }
      // When sourceTrackId === targetTrackId: do NOT clear _dragCrossChannelTarget.
      // The renderer keeps drag.trackId as the source when channels differ (cross-channel
      // moves are deferred to dragEnd), so the next mouse-move reports source === target.
      // Clearing here would lose the cross-channel target before dragEnd fires.

      // Apply move directly (single undo entry created on drag end)
      this.timelineModel.moveClipToTrack(sourceTrackId, effectiveTargetTrackId, clipId, newOffset);
      this._dragCurrentTrackId = effectiveTargetTrackId;

      // Batch-move other selected clips by the same delta
      if (this._dragBatchSnapshots && this._dragBatchSnapshots.length > 0 && this._dragStartSnapshot) {
        const delta = newOffset - this._dragStartSnapshot.clip.timelineOffset;
        const originalPrimaryTrackId = this._dragStartSnapshot.trackId;
        for (const snap of this._dragBatchSnapshots) {
          const otherOffset = Math.max(0, snap.clip.timelineOffset + delta);
          // Find current track of this clip (may differ if previously cross-track moved)
          for (const t of this.timelineModel.timeline.tracks) {
            const c = t.clips.find(cl => cl.id === snap.clipId);
            if (c) {
              // If this sibling was originally on the same track as the primary clip,
              // move it to the same target track (cross-track group move)
              const siblingTarget = snap.trackId === originalPrimaryTrackId
                ? effectiveTargetTrackId : t.id;
              this.timelineModel.moveClipToTrack(t.id, siblingTarget, snap.clipId, otherOffset);
              break;
            }
          }
        }
      }

      this.timelineRenderer?.render();

      // Pro Tools style: don't stop playback during drag, just mark for re-schedule on mouseup
      if (this.audioEngine.isPlaying) {
        this._pendingPlaybackResume = true;
      }
    };

    this.timelineRenderer.onClipTrim = (clipId, trackId, edge, newValue) => {
      // Clamp newValue to buffer bounds before applying
      const track = this.timelineModel.timeline.tracks.find(t => t.id === trackId);
      const clip = track?.clips.find(c => c.id === clipId);
      if (!clip) return;
      const pooled = this.bufferPool.getBuffer(clip.bufferIds[0]);
      const bufferLength = pooled?.length ?? clip.sourceEnd;

      let clamped = newValue;
      if (edge === 'start') {
        clamped = Math.max(0, Math.min(clip.sourceEnd - 1, newValue));
      } else {
        clamped = Math.max(clip.sourceStart + 1, Math.min(bufferLength, newValue));
      }

      // Snapshot original state on first trim of this drag
      if (!this._dragStartSnapshot) {
        this._dragStartSnapshot = { clipId, trackId, clip: { ...clip } };
        this._dragBatchSnapshots = [];
      }
      // Apply trim directly (single undo entry created on drag end)
      if (edge === 'start') {
        this.timelineModel.trimClipStart(trackId, clipId, clamped);
      } else {
        this.timelineModel.trimClipEnd(trackId, clipId, clamped);
      }
      this._dragCurrentTrackId = trackId;
      this.timelineRenderer?.clearPeakCaches();
      this.timelineRenderer?.render();

      // Pro Tools style: don't stop playback during drag, just mark for re-schedule on mouseup
      if (this.audioEngine.isPlaying) {
        this._pendingPlaybackResume = true;
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

    this.timelineRenderer.onDragEnd = () => {
      // Create undo entries for all moved clips (primary + batch)
      if (this._dragStartSnapshot) {
        const { clipId, trackId: originalTrackId, clip: originalState } = this._dragStartSnapshot;
        const finalTrackId = this._dragCurrentTrackId ?? originalTrackId;

        // Check for cross-channel split/merge operation
        if (this._dragCrossChannelTarget) {
          const { targetTrackId: crossTargetId, newOffset: crossOffset } = this._dragCrossChannelTarget;
          this._dragCrossChannelTarget = null;

          const sourceTrack = this.timelineModel.timeline.tracks.find(t => t.id === originalTrackId);
          const targetTrack = this.timelineModel.timeline.tracks.find(t => t.id === crossTargetId);
          if (sourceTrack && targetTrack) {
            // Revert the dragged clip back to original offset before snapshotting
            const draggedClip = sourceTrack.clips.find(c => c.id === clipId);
            if (draggedClip) {
              draggedClip.timelineOffset = originalState.timelineOffset;
            }

            // Also revert batch-moved clips
            if (this._dragBatchSnapshots) {
              for (const snap of this._dragBatchSnapshots) {
                const t = this.timelineModel.timeline.tracks.find(tr => tr.id === snap.trackId);
                const c = t?.clips.find(cl => cl.id === snap.clipId);
                if (c) c.timelineOffset = snap.clip.timelineOffset;
              }
            }

            const targetIndex = this.timelineModel.timeline.tracks.indexOf(targetTrack);
            let result: ReturnType<typeof this.executeCrossTrackSplit> = null;

            if (sourceTrack.channels > targetTrack.channels) {
              // Split: e.g. stereo → 2x mono
              result = this.executeCrossTrackSplit(originalTrackId, targetIndex, clipId, crossOffset);
            } else {
              // Merge: e.g. 2x mono → stereo
              result = this.executeCrossTrackMerge(originalTrackId, crossTargetId, clipId, crossOffset);
            }

            if (result) {
              const desc = sourceTrack.channels > targetTrack.channels
                ? `Split ${sourceTrack.channels}ch to ${targetTrack.channels}ch tracks`
                : `Merge ${sourceTrack.channels}ch clips to ${targetTrack.channels}ch track`;
              this.timelineUndoManager.pushExecuted(
                new CrossTrackChannelCommand(this.timelineModel, result.before, result.after, desc),
              );
              this.timelineRenderer?.render();
            }
          }

          this._dragStartSnapshot = null;
          this._dragBatchSnapshots = null;
          this._dragCurrentTrackId = null;
        } else {
          // Normal drag (same channel count or same track)
          const commands: ClipDragCommand[] = [];

          // Primary clip
          const track = this.timelineModel.timeline.tracks.find(t => t.id === finalTrackId);
          const clip = track?.clips.find(c => c.id === clipId);
          if (clip) {
            const changed = originalState.timelineOffset !== clip.timelineOffset
              || originalState.sourceStart !== clip.sourceStart
              || originalState.sourceEnd !== clip.sourceEnd
              || originalTrackId !== finalTrackId;
            if (changed) {
              const overlapResult = this.timelineModel.resolveOverlaps(finalTrackId, clipId);
              const hasOverlaps = overlapResult.removed.length > 0 || overlapResult.trimmed.length > 0;
              commands.push(new ClipDragCommand(
                this.timelineModel, clipId, originalTrackId, finalTrackId,
                originalState, { ...clip }, hasOverlaps ? overlapResult : null,
              ));
            }
          }

          // Batch clips (other selected clips moved together)
          if (this._dragBatchSnapshots) {
            for (const snap of this._dragBatchSnapshots) {
              // Find the clip on its current track (may have moved cross-track with group)
              let currentTrackId = snap.trackId;
              let c: Clip | undefined;
              for (const tr of this.timelineModel.timeline.tracks) {
                c = tr.clips.find(cl => cl.id === snap.clipId);
                if (c) { currentTrackId = tr.id; break; }
              }
              if (c && (snap.clip.timelineOffset !== c.timelineOffset
                || snap.clip.sourceStart !== c.sourceStart
                || snap.clip.sourceEnd !== c.sourceEnd
                || snap.trackId !== currentTrackId)) {
                const overlapResult = this.timelineModel.resolveOverlaps(currentTrackId, snap.clipId);
                const hasOverlaps = overlapResult.removed.length > 0 || overlapResult.trimmed.length > 0;
                commands.push(new ClipDragCommand(
                  this.timelineModel, snap.clipId, snap.trackId, currentTrackId,
                  snap.clip, { ...c }, hasOverlaps ? overlapResult : null,
                ));
              }
            }
          }

          // Push as single compound undo entry
          if (commands.length === 1) {
            this.timelineUndoManager.pushExecuted(commands[0]);
          } else if (commands.length > 1) {
            this.timelineUndoManager.pushExecuted(new CompoundCommand(commands, 'Drag clips'));
          }
          if (commands.length > 0) {
            this.timelineRenderer?.render();
          }

          this._dragStartSnapshot = null;
          this._dragBatchSnapshots = null;
          this._dragCurrentTrackId = null;
        }
      }

      if (this._pendingPlaybackResume) {
        this._pendingPlaybackResume = false;
        // Re-schedule from current playback position (playback never stopped)
        const currentSample = Math.floor(
          this.audioEngine.getCurrentTime() * this.timelineModel.timeline.sampleRate,
        );
        this.audioEngine.stopTimeline();
        this.audioEngine.playTimeline(
          this.timelineModel.timeline, this.bufferPool, currentSample,
        );
      }
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

    // Insert rack callbacks (timeline track headers)
    this.timelineRenderer.onInsertAdd = (trackId) => {
      this.pluginInsertTargetTrackId = trackId;
      this.showPluginBrowser(trackId);
    };
    this.timelineRenderer.onInsertClick = (_trackId, instanceId, screenX, screenY) => {
      this.pluginParameterPanel.show(instanceId, undefined, { x: screenX, y: screenY });
    };
    this.timelineRenderer.onInsertBypass = (trackId, instanceId) => {
      this.togglePluginBypass(trackId, instanceId);
      this.timelineRenderer?.render();
    };
    this.timelineRenderer.onInsertRemove = (trackId, instanceId) => {
      this.removePluginFromTrack(trackId, instanceId);
      this.timelineRenderer?.render();
    };

    this.timelineRenderer.onSelectionChange = () => {
      const sel = this.timelineRenderer?.getSelection();
      this.spectrogramRenderer.setSelection(sel ? sel.start : null, sel ? sel.end : null);
      this.updateUI();
    };

    this.timelineRenderer.onTrackSelect = (trackIds) => {
      this.timelineModel.timeline.selectedTrackIds = trackIds;
      this.timelineRenderer?.render();
    };

    this.timelineRenderer.onTrackHeaderContextMenu = (trackId, clientX, clientY) => {
      this.showTrackContextMenu(trackId, clientX, clientY);
    };

    this.timelineRenderer.onClipContentContextMenu = (clientX, clientY) => {
      this.showClipContentContextMenu(clientX, clientY);
    };

    // ---- Clip gain callback ----
    this.timelineRenderer.onClipGainChange = (clipId, trackId, gainDb) => {
      const track = this.timelineModel.timeline.tracks.find(t => t.id === trackId);
      const clip = track?.clips.find(c => c.id === clipId);
      if (clip) {
        // Snapshot original on first change of this drag
        if (this._dragGainOriginal == null) {
          this._dragGainOriginal = clip.gainDb;
        }
        clip.gainDb = Math.round(gainDb * 10) / 10; // 0.1 dB precision
      }
    };

    // ---- Clip fade callback ----
    this.timelineRenderer.onClipFadeChange = (clipId, trackId, edge, samples) => {
      const track = this.timelineModel.timeline.tracks.find(t => t.id === trackId);
      const clip = track?.clips.find(c => c.id === clipId);
      if (clip) {
        if (this._dragFadeOriginal == null) {
          this._dragFadeOriginal = { fadeIn: clip.fadeInSamples, fadeOut: clip.fadeOutSamples };
        }
        if (edge === 'in') clip.fadeInSamples = samples;
        else clip.fadeOutSamples = samples;
      }
    };

    // ---- Clip fade curve callback ----
    this.timelineRenderer.onClipFadeCurveChange = (clipId, trackId, edge, curve) => {
      const track = this.timelineModel.timeline.tracks.find(t => t.id === trackId);
      const clip = track?.clips.find(c => c.id === clipId);
      if (clip) {
        if (this._dragFadeCurveOriginal == null) {
          const originalCurve = edge === 'in' ? (clip.fadeInCurve ?? 0) : (clip.fadeOutCurve ?? 0);
          this._dragFadeCurveOriginal = { clipId, trackId, edge, curve: originalCurve };
        }
        if (edge === 'in') clip.fadeInCurve = curve;
        else clip.fadeOutCurve = curve;
        this.invalidatePlayback();
      }
    };

    // ---- Extend onDragEnd for gain/fade ----
    const existingDragEnd = this.timelineRenderer.onDragEnd!;
    this.timelineRenderer.onDragEnd = () => {
      // Check for clip gain drag undo
      if (this._dragGainOriginal != null) {
        const selected = this.timelineModel.timeline.selectedClipIds;
        if (selected.length === 1) {
          for (const track of this.timelineModel.timeline.tracks) {
            const clip = track.clips.find(c => c.id === selected[0]);
            if (clip && clip.gainDb !== this._dragGainOriginal) {
              this.timelineUndoManager.pushExecuted(
                new EditClipGainCommand(this.timelineModel, track.id, clip.id, this._dragGainOriginal, clip.gainDb),
              );
              break;
            }
          }
        }
        this._dragGainOriginal = null;
        return;
      }

      // Check for fade curve drag undo
      if (this._dragFadeCurveOriginal != null) {
        const { clipId, trackId, edge, curve: prevCurve } = this._dragFadeCurveOriginal;
        for (const track of this.timelineModel.timeline.tracks) {
          const clip = track.clips.find(c => c.id === clipId);
          if (clip) {
            const newCurve = edge === 'in' ? (clip.fadeInCurve ?? 0) : (clip.fadeOutCurve ?? 0);
            if (newCurve !== prevCurve) {
              const cmd = new EditClipFadeCommand(
                this.timelineModel, track.id, clip.id,
                clip.fadeInSamples, clip.fadeOutSamples,
                clip.fadeInSamples, clip.fadeOutSamples,
                edge === 'in' ? prevCurve : clip.fadeInCurve,
                edge === 'out' ? prevCurve : clip.fadeOutCurve,
                edge === 'in' ? newCurve : clip.fadeInCurve,
                edge === 'out' ? newCurve : clip.fadeOutCurve,
              );
              this.timelineUndoManager.pushExecuted(cmd);
            }
            break;
          }
        }
        this._dragFadeCurveOriginal = null;
        return;
      }

      // Check for fade drag undo
      if (this._dragFadeOriginal != null) {
        const selected = this.timelineModel.timeline.selectedClipIds;
        const { fadeIn: prevIn, fadeOut: prevOut } = this._dragFadeOriginal;
        const fadeCommands: EditClipFadeCommand[] = [];
        for (const selId of selected) {
          for (const track of this.timelineModel.timeline.tracks) {
            const clip = track.clips.find(c => c.id === selId);
            if (clip) {
              if (clip.fadeInSamples !== prevIn || clip.fadeOutSamples !== prevOut) {
                fadeCommands.push(
                  new EditClipFadeCommand(this.timelineModel, track.id, clip.id, prevIn, prevOut, clip.fadeInSamples, clip.fadeOutSamples),
                );
              }
              break;
            }
          }
        }
        if (fadeCommands.length === 1) {
          this.timelineUndoManager.pushExecuted(fadeCommands[0]);
        } else if (fadeCommands.length > 1) {
          this.timelineUndoManager.pushExecuted(new CompoundCommand(fadeCommands, 'Edit grouped clip fades'));
        }
        this._dragFadeOriginal = null;
        return;
      }

      // Existing clip move/trim drag end handler
      existingDragEnd();
    };

    // ---- Cue point callbacks ----
    this.timelineRenderer.cuePointManager = this.cuePointManager;

    this.timelineRenderer.onCuePointAdd = (sample) => {
      this.timelineUndoManager.push(
        new AddCuePointCommand(this.cuePointManager, sample, ''),
      );
      this.timelineRenderer?.render();
    };

    this.timelineRenderer.onCuePointRemove = (id) => {
      const cue = this.cuePointManager.getAllCuePoints().find(c => c.id === id);
      if (cue) {
        this.timelineUndoManager.push(
          new RemoveCuePointCommand(this.cuePointManager, { ...cue }),
        );
        this.timelineRenderer?.render();
      }
    };

    this.timelineRenderer.onCuePointMoveEnd = (id, prevSample, newSample) => {
      this.timelineUndoManager.pushExecuted(
        new MoveCuePointCommand(this.cuePointManager, id, prevSample, newSample),
      );
      this.timelineRenderer?.render();
    };

    // ---- External file drop callback (OS-level drag only; file browser uses custom mouse drag) ----
    this.timelineRenderer.onExternalFileDrop = (filePath, trackIndex, sampleOffset) => {
      if (filePath) {
        this.importFileAtPosition(filePath, trackIndex, sampleOffset);
      }
    };

    this.timelineRenderer.onTrackNameChange = (trackId, newName) => {
      const track = this.timelineModel.timeline.tracks.find(t => t.id === trackId);
      if (track) {
        track.name = newName;
        // Also update mixer channel strip label
        this.mixer.setupTracks(this.timelineModel.timeline.tracks);
      }
      this.timelineRenderer?.render();
    };

    // ---- Crossfade callbacks ----
    this.timelineRenderer.onCrossfadeDragEnd = (trackId, clipAId, clipBId, prevOut, prevIn, newOut, newIn, type) => {
      if (prevOut !== newOut || prevIn !== newIn) {
        this.timelineUndoManager.pushExecuted(
          new CrossfadeCommand(this.timelineModel, trackId, clipAId, clipBId, prevOut, prevIn, newOut, newIn, type),
        );
        this.invalidatePlayback();
      }
    };

    this.timelineRenderer.onCrossfadeTypeChange = (_trackId, _clipAId, _clipBId, _type) => {
      this.invalidatePlayback();
      this.timelineRenderer?.render();
    };
  }

  setupEventListeners(): void {
    // File operations
    document.getElementById('importBtn')!.addEventListener('click', () => {
      this.openImportDialog();
    });
    document.getElementById('fileInput')!.addEventListener('change', (e) => {
      const input = e.target as HTMLInputElement;
      if (input.files && input.files.length > 0) {
        // File objects from the HTML input: check if they have a native path (Tauri)
        const files = Array.from(input.files);
        const paths = files.map(f => (f as unknown as { path?: string }).path).filter((p): p is string => !!p);
        if (paths.length > 0) {
          this.importAudioToTimeline(paths);
        } else {
          // Pure browser fallback — use old queue-based import for File objects
          this.addFilesToQueue(files);
        }
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
    document.getElementById('denoiseBtn')!.addEventListener('click', () => this.showDenoiseModal());

    // Modal buttons
    document.getElementById('exportCancelBtn')!.addEventListener('click', () => this.hideModal('exportModal'));
    document.getElementById('exportConfirmBtn')!.addEventListener('click', () => this.exportFile());
    document.getElementById('exportFormat')!.addEventListener('change', () => this.onExportFormatChange());
    document.getElementById('normalizeCancelBtn')!.addEventListener('click', () => this.hideModal('normalizeModal'));
    document.getElementById('normalizeConfirmBtn')!.addEventListener('click', () => this.normalize());
    document.getElementById('gainCancelBtn')!.addEventListener('click', () => this.hideModal('gainModal'));
    document.getElementById('gainConfirmBtn')!.addEventListener('click', () => this.applyGain());
    document.getElementById('denoiseCancelBtn')!.addEventListener('click', () => this.hideModal('denoiseModal'));
    document.getElementById('denoiseApplyBtn')!.addEventListener('click', () => this.applyDenoise());

    // Denoise preset/slider wiring
    this.initDenoiseSliders();

    // Plugin browser
    document.getElementById('pluginBrowserCancelBtn')!.addEventListener('click', () => this.hideModal('pluginBrowserModal'));

    // Keyboard
    document.addEventListener('keydown', this.boundKeydown);

    // Custom mouse drag for file browser → timeline (replaces HTML5 drag/drop)
    document.addEventListener('mousemove', (e) => {
      if (!this.fileDragState) return;
      if (!this.fileDragState.active) {
        const dx = e.clientX - this.fileDragState.startX;
        const dy = e.clientY - this.fileDragState.startY;
        if (dx * dx + dy * dy < 25) return; // 5px threshold
        this.fileDragState.active = true;
        this.suppressNextClick = true;
        document.body.style.cursor = 'grabbing';
        if (this.timelineRenderer) {
          const f = this.fileDragState.file;
          this.timelineRenderer.externalDragChannelCount = f.channels ?? 1;
          this.timelineRenderer.externalDragDuration = f.duration_secs ?? 0;
          this.timelineRenderer.externalDragFileName = f.name;
        }
      }
      if (this.fileDragState.active && this.timelineRenderer) {
        this.timelineRenderer.updateExternalDrag(e.clientX, e.clientY);
      }
    });

    document.addEventListener('mouseup', (e) => {
      if (!this.fileDragState) return;
      const wasActive = this.fileDragState.active;
      if (wasActive) {
        document.body.style.cursor = '';
        if (this.timelineRenderer?.isPointInCanvas(e.clientX, e.clientY)) {
          const pos = this.timelineRenderer.getDropPosition(e.clientX, e.clientY);
          this.importFileAtPosition(this.fileDragState.file.path, pos.trackIndex, pos.sampleOffset, this.fileDragState.file);
        }
        this.timelineRenderer?.clearExternalDrag();
      }
      this.fileDragState = null;
    });

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
      const sample = Math.floor(time * this.timelineModel.timeline.sampleRate);
      this.timelineRenderer?.setPlayheadPosition(sample);
      if (this.sonogramRenderer) this.sonogramRenderer.setPlayheadPosition(sample);
      this.metering.setPlaybackPosition(sample);
    };
    this.audioEngine.onPlaybackEnd = () => {
      this.timelineRenderer?.setPlaybackState(false);
      this.updateUI();
      this.stopRealtimeAnalysis();
    };

    // Mixer plugin callbacks
    this.mixer.onPluginAdd = (trackId) => {
      this.pluginInsertTargetTrackId = trackId;
      this.showPluginBrowser(trackId);
    };
    this.mixer.onPluginRemove = (trackId, instanceId) => {
      this.removePluginFromTrack(trackId, instanceId);
    };
    this.mixer.onPluginBypass = (trackId, instanceId) => {
      this.togglePluginBypass(trackId, instanceId);
    };
    this.mixer.onPluginReorder = (trackId, fromIndex, toIndex) => {
      this.reorderTrackPlugins(trackId, fromIndex, toIndex);
    };
    this.mixer.onPluginSelect = (_trackId, instanceId) => {
      const slot = document.querySelector(
        `.mixer-plugin-slot[data-instance-id="${instanceId}"]`
      ) as HTMLElement | null;
      this.pluginParameterPanel.show(instanceId, slot ?? undefined);
    };
  }

  setupCuePointCallbacks(): void {
    this.cuePointRenderer.onCuePointClick = (cuePoint) => {
      if (!this.audioEngine.audioBuffer) return;
      this.stop();
      if (this.timelineRenderer) {
        this.timelineModel.timeline.playheadSample = cuePoint.sample;
        this.timelineRenderer.setPlayheadPosition(cuePoint.sample);
      }
      this.waveformRenderer.playheadPosition = cuePoint.sample;
      this.waveformRenderer.selectionStart = null;
      this.waveformRenderer.selectionEnd = null;
      this.waveformRenderer.render();
      this.waveformRenderer.updateSelectionInfo();
      this.spectrogramRenderer.setSelection(null, null);
      this.updateUI();
    };

    this.cuePointRenderer.onCuePointDoubleClick = (cuePoint) => {
      if (!this.audioEngine.audioBuffer) return;
      this.stop();
      if (this.timelineRenderer) {
        this.timelineModel.timeline.playheadSample = cuePoint.sample;
        this.timelineRenderer.setPlayheadPosition(cuePoint.sample);
      }
      this.waveformRenderer.playheadPosition = cuePoint.sample;
      this.waveformRenderer.render();
      this.play();
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

    // Listen on the entire document body for OS-level file drag (not internal file browser)
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
      await this.importAudioToTimeline(filePaths);
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
      'new-project': () => this.confirmNewProject(),
      'export': () => this.showExportModal(),
      'save-project': () => this.saveProject(),
      'undo': () => this.undo(),
      'redo': () => this.redo(),
      'select-all': () => this.waveformRenderer.selectAll(),
      'delete': () => this.deleteSelection(),
      'trim': () => this.trim(),
      'normalize': () => this.showNormalizeModal(),
      'new-track': () => this.showCreateTrackDialog(),
      'fade-in': () => this.fadeIn(),
      'fade-out': () => this.fadeOut(),
      'gain': () => this.showGainModal(),
      'reverse': () => this.reverse(),
      'denoise': () => this.showDenoiseModal(),
      'play-pause': () => this.audioEngine.isPlaying ? this.pause() : this.play(),
      'stop': () => this.stop(),
      'toggle-loop': () => this.toggleLoop(),
      'zoom-in': () => this.zoomIn(),
      'zoom-out': () => this.zoomOut(),
      'zoom-fit': () => this.zoomFit(),
      'toggle-mixer': () => this.mixer.toggle(),
      'toggle-plugin-browser': () => this.togglePluginBrowser(),
      'import': () => this.openImportDialog(),
      'open-session': () => { void this.openSession(); },
      'save-session': () => { void this.saveSession(); },
      'save-session-as': () => { void this.saveSessionAs(); },
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
    await this.importAudioToTimeline(paths);
  }

  /**
   * Check if a cross-track channel move is compatible.
   * Returns true for same channels, valid split (higher→lower), or valid merge (lower→higher).
   * Returns false for incompatible scenarios (e.g. mono→stereo without partner).
   */
  private isChannelMoveCompatible(
    sourceTrack: { channels: number },
    targetTrack: { channels: number },
  ): boolean {
    const src = sourceTrack.channels;
    const tgt = targetTrack.channels;
    if (src === tgt) return true;

    // Split: higher channel count → lower (e.g. stereo→mono, quad→stereo, quad→mono)
    if (src > tgt) {
      return src % tgt === 0;
    }

    // Merge: lower → higher (e.g. mono→stereo, stereo→quad)
    // Only allowed if the target channels is a multiple of source channels
    return tgt % src === 0;
  }

  /**
   * Execute cross-track channel split operation.
   * Splits a multi-channel clip (bufferIds.length > 1) into individual mono/lower-channel clips
   * placed on consecutive target tracks.
   *
   * E.g. stereo clip (bufferIds=[L,R]) on a stereo track → 2 mono clips on 2 mono tracks.
   *
   * Returns before/after snapshots for undo, or null if the operation failed.
   */
  private executeCrossTrackSplit(
    sourceTrackId: string,
    targetTrackStartIndex: number,
    clipId: string,
    newOffset: number,
  ): { before: Array<{ trackId: string; clips: Clip[] }>; after: Array<{ trackId: string; clips: Clip[] }> } | null {
    const tracks = this.timelineModel.timeline.tracks;
    const sourceTrack = tracks.find(t => t.id === sourceTrackId);
    if (!sourceTrack) return null;

    const clip = sourceTrack.clips.find(c => c.id === clipId);
    if (!clip) return null;

    const sourceChannels = sourceTrack.channels;
    const targetTrack = tracks[targetTrackStartIndex];
    if (!targetTrack) return null;
    const targetChannels = targetTrack.channels;

    // Each target track receives (targetChannels) buffer IDs from the source clip
    const numTargetTracks = sourceChannels / targetChannels;
    if (!Number.isInteger(numTargetTracks)) return null;

    // Verify we have enough consecutive target tracks of matching channel count
    for (let i = 0; i < numTargetTracks; i++) {
      const idx = targetTrackStartIndex + i;
      if (idx >= tracks.length || tracks[idx].channels !== targetChannels) return null;
    }

    // Compute offset delta
    const offsetDelta = newOffset - clip.timelineOffset;

    // Snapshot before state
    const affectedTrackIds = [sourceTrackId];
    for (let i = 0; i < numTargetTracks; i++) {
      const tId = tracks[targetTrackStartIndex + i].id;
      if (!affectedTrackIds.includes(tId)) affectedTrackIds.push(tId);
    }
    const before = affectedTrackIds.map(tId => {
      const t = tracks.find(tr => tr.id === tId)!;
      return { trackId: tId, clips: t.clips.map(c => ({ ...c })) };
    });

    // Remove clip from source track
    sourceTrack.clips = sourceTrack.clips.filter(c => c.id !== clipId);

    // Distribute buffer IDs across target tracks
    for (let ti = 0; ti < numTargetTracks; ti++) {
      const tTrack = tracks[targetTrackStartIndex + ti];
      const startCh = ti * targetChannels;
      const slicedBufferIds = clip.bufferIds.slice(startCh, startCh + targetChannels);
      const newClip: Clip = {
        ...clip,
        id: `${clip.id}_split_${ti}`,
        bufferIds: slicedBufferIds,
        timelineOffset: Math.max(0, clip.timelineOffset + offsetDelta),
      };
      tTrack.clips.push(newClip);
      this.timelineModel.resolveOverlaps(tTrack.id, newClip.id);
    }

    // Snapshot after state
    const after = affectedTrackIds.map(tId => {
      const t = tracks.find(tr => tr.id === tId)!;
      return { trackId: tId, clips: t.clips.map(c => ({ ...c })) };
    });

    return { before, after };
  }

  /**
   * Execute cross-track channel merge operation.
   * Combines multiple mono/lower-channel clips into a single higher-channel clip
   * by merging their bufferIds arrays.
   *
   * E.g. 2 mono clips (bufferIds=[L], bufferIds=[R]) → 1 stereo clip (bufferIds=[L,R]).
   *
   * Returns before/after snapshots for undo, or null if the operation failed.
   */
  private executeCrossTrackMerge(
    sourceTrackId: string,
    targetTrackId: string,
    clipId: string,
    newOffset: number,
  ): { before: Array<{ trackId: string; clips: Clip[] }>; after: Array<{ trackId: string; clips: Clip[] }> } | null {
    const tracks = this.timelineModel.timeline.tracks;
    const sourceTrack = tracks.find(t => t.id === sourceTrackId);
    const targetTrack = tracks.find(t => t.id === targetTrackId);
    if (!sourceTrack || !targetTrack) return null;

    const clip = sourceTrack.clips.find(c => c.id === clipId);
    if (!clip) return null;

    const sourceChannels = sourceTrack.channels;
    const targetChannels = targetTrack.channels;

    // How many source clips are needed to fill target track channels
    const clipsNeeded = targetChannels / sourceChannels;
    if (!Number.isInteger(clipsNeeded)) return null;

    // Collect selected clips from source-channel-count tracks, sorted by track index
    const selectedClipIds = this.timelineModel.timeline.selectedClipIds;
    const candidateClips: Array<{ clip: Clip; trackId: string; trackIndex: number }> = [];
    for (const selId of selectedClipIds) {
      for (let ti = 0; ti < tracks.length; ti++) {
        const c = tracks[ti].clips.find(cl => cl.id === selId);
        if (c && tracks[ti].channels === sourceChannels) {
          candidateClips.push({ clip: c, trackId: tracks[ti].id, trackIndex: ti });
          break;
        }
      }
    }

    if (candidateClips.length < clipsNeeded) return null;
    candidateClips.sort((a, b) => a.trackIndex - b.trackIndex);
    const mergeSet = candidateClips.slice(0, clipsNeeded);

    // Compute offset delta
    const offsetDelta = newOffset - clip.timelineOffset;

    // Snapshot before state
    const affectedTrackIds = new Set<string>([targetTrackId]);
    for (const mc of mergeSet) affectedTrackIds.add(mc.trackId);
    const affectedIds = Array.from(affectedTrackIds);
    const before = affectedIds.map(tId => {
      const t = tracks.find(tr => tr.id === tId)!;
      return { trackId: tId, clips: t.clips.map(c => ({ ...c })) };
    });

    // Merge buffer IDs from all source clips in track order
    const mergedBufferIds: string[] = [];
    for (const mc of mergeSet) {
      mergedBufferIds.push(...mc.clip.bufferIds);
    }

    // Remove source clips from their tracks
    for (const mc of mergeSet) {
      const srcTrack = tracks.find(t => t.id === mc.trackId)!;
      srcTrack.clips = srcTrack.clips.filter(c => c.id !== mc.clip.id);
    }

    // Add merged clip to target track
    const primaryClip = mergeSet[0].clip;
    const newClip: Clip = {
      ...primaryClip,
      id: `${primaryClip.id}_merged`,
      bufferIds: mergedBufferIds,
      timelineOffset: Math.max(0, primaryClip.timelineOffset + offsetDelta),
    };
    targetTrack.clips.push(newClip);
    this.timelineModel.resolveOverlaps(targetTrackId, newClip.id);

    // Snapshot after state
    const after = affectedIds.map(tId => {
      const t = tracks.find(tr => tr.id === tId)!;
      return { trackId: tId, clips: t.clips.map(c => ({ ...c })) };
    });

    return { before, after };
  }

  handleKeyboard(e: KeyboardEvent): void {
    if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'SELECT') return;

    if (e.metaKey || e.ctrlKey) {
      switch (e.key) {
        case 'a':
          e.preventDefault();
          if (this.timelineModel.timeline.tracks.length > 0) {
            // Timeline mode: select all tracks + all clips
            this.timelineModel.selectAllTracks();
            this.timelineModel.timeline.selectedClipIds = this.timelineModel.timeline.tracks
              .flatMap(t => t.clips.map(c => c.id));
            this.timelineRenderer?.render();
          } else {
            this.waveformRenderer.selectAll();
          }
          return;
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
          if (e.shiftKey) this.showCreateTrackDialog();
          else this.confirmNewProject();
          return;
        case 'i':
          if (e.shiftKey) {
            e.preventDefault();
            this.openImportDialog();
          }
          return;
        case 's':
          e.preventDefault();
          if (e.shiftKey) {
            void this.saveSessionAs();
          } else {
            void this.saveSession();
          }
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
      case 's': case 'S': {
        // Split all selected clips (including group siblings via selection sync)
        const selected = this.timelineModel.timeline.selectedClipIds;
        if (selected.length > 0) {
          const splitSample = this.timelineModel.timeline.playheadSample;
          const commands: SplitClipCommand[] = [];
          for (const track of this.timelineModel.timeline.tracks) {
            for (const clip of track.clips) {
              if (selected.includes(clip.id)) {
                commands.push(new SplitClipCommand(this.timelineModel, track.id, clip.id, splitSample));
              }
            }
          }
          if (commands.length === 1) {
            this.timelineUndoManager.push(commands[0]);
          } else if (commands.length > 1) {
            this.timelineUndoManager.push(new CompoundCommand(commands, 'Split clips'));
          }
          if (commands.length > 0) {
            this.timelineRenderer?.render();
          }
        }
        break;
      }
      case 'Delete': case 'Backspace': {
        e.preventDefault();
        // Time-range deletion takes priority over clip deletion
        const timeSelection = this.timelineRenderer?.getSelection();
        if (timeSelection && this.timelineModel.timeline.tracks.length > 0) {
          const trackIds = this.timelineModel.timeline.selectedTrackIds.length > 0
            ? this.timelineModel.timeline.selectedTrackIds
            : this.timelineModel.timeline.tracks.map(t => t.id);
          this.timelineUndoManager.push(
            new DeleteTimeRangeCommand(this.timelineModel, trackIds, timeSelection.start, timeSelection.end),
          );
          // Clear selection
          if (this.timelineRenderer) {
            this.timelineRenderer.selectionStartSample = null;
            this.timelineRenderer.selectionEndSample = null;
          }
          this.timelineRenderer?.clearPeakCaches();
          this.timelineRenderer?.render();
          break;
        }
        const selectedClips = this.timelineModel.timeline.selectedClipIds;
        if (selectedClips.length > 0) {
          for (const track of this.timelineModel.timeline.tracks) {
            for (const clip of track.clips) {
              if (selectedClips.includes(clip.id)) {
                this.timelineUndoManager.push(
                  new DeleteClipCommand(this.timelineModel, track.id, clip.id),
                );
              }
            }
          }
          this.timelineModel.timeline.selectedClipIds = [];
          this.timelineRenderer?.render();
        }
        break;
      }
      case 'l': case 'L':
        if (this.audioEngine.audioBuffer) this.toggleLoop();
        break;
      case 'r': case 'R':
        if (this.audioEngine.audioBuffer) this.reverse();
        break;
      case 'm': case 'M':
        if (this.timelineModel.timeline.tracks.length > 0) {
          // Timeline mode: add cue at timeline playhead
          const sample = this.timelineModel.timeline.playheadSample;
          this.timelineUndoManager.push(new AddCuePointCommand(this.cuePointManager, sample, ''));
          this.timelineRenderer?.render();
        } else if (this.audioEngine.audioBuffer) {
          this.addCuePointAtPlayhead();
        }
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
        this.originalBitDepth = null; // Non-WAV: no original bit depth info
      } else {
        // WAV: already parsed by Rust — create AudioBuffer directly
        parsedData = result;
        this.originalBitDepth = result.bits_per_sample;
        const dataMB = (result.num_samples * result.channels * 4 / (1024 * 1024)).toFixed(1);
        console.log(`[IMPORT] Step 2: Rust WAV parse complete (${result.channels}ch, ${result.sample_rate}Hz, ${result.bits_per_sample}bit, ${dataMB} MB). Loading...`);
        audioBuffer = await this.audioEngine.loadFromParsedData(result);
      }

      console.log('[IMPORT] Step 3: Audio loaded. Loading UI...');
      this.onAudioLoaded(audioBuffer, fileId, parsedData);
      console.log('[IMPORT] Step 4: Done.');

      // Pre-fill inline metadata from the first imported file
      if (!this.metadataPreFilled) {
        this.metadataPreFilled = true;
        try {
          const meta = await window.appAPI!.readFileMetadata(filePath);
          this.prefillInlineMetadata(meta);
        } catch (metaErr) {
          console.warn('[Metadata] Could not pre-fill from first import:', metaErr);
        }
      }
    } catch (err: any) {
      console.error('Import error:', err);
      this.hideLoadingIndicator();
      alert('Error loading audio file: ' + err.message);
    }
  }

  private showLoadingIndicator(fileName: string): void {
    const el = document.getElementById('fileInfo');
    if (el) el.textContent = `Loading ${fileName}...`;
    const overlay = document.getElementById('loadingOverlay');
    if (overlay) {
      const text = overlay.querySelector('.loading-text');
      if (text) text.textContent = `Loading ${fileName}...`;
      overlay.style.display = 'flex';
    }
  }

  private hideLoadingIndicator(): void {
    const el = document.getElementById('fileInfo');
    if (el) el.textContent = this.fileName || 'No file loaded';
    const overlay = document.getElementById('loadingOverlay');
    if (overlay) overlay.style.display = 'none';
  }

  private onAudioLoaded(audioBuffer: AudioBuffer, fileId: number | null, parsedData?: ParsedAudioData | null): void {
    try {
      if (!this.audioEditor) {
        this.audioEditor = new AudioEditor(this.audioEngine.audioContext!);
      }
      if (!this.pluginHost) {
        this.pluginHost = new PluginHost(this.audioEngine.audioContext!);
        this.mixer.pluginHost = this.pluginHost;
        this.pluginParameterPanel.setPluginHost(this.pluginHost);
      }

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
        this.waveformRenderer.disabled = true;
        this.waveformRenderer.detachListeners();
        this.bufferPool.clear();
        this.timelineModel.createTimeline(audioBuffer.sampleRate);
        this.timelineUndoManager.clear();
        this.metadataPreFilled = false;

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

      this.buildInlineTrackNames();
      this.updateUI();
      this.updateFileInfo();
      this.updateZoomInfo();
      this.updateChannelInfo();
      this.hideLoadingIndicator();
    } catch (err: any) {
      console.error('Error in onAudioLoaded:', err);
      this.hideLoadingIndicator();
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
      this.audioEngine.stopTimeline();
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
      this.waveformRenderer.disabled = false;
      this.fileName = null;
      this.originalBitDepth = null;
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
      this.timelineRenderer?.setPlaybackState(true);
      this.startRealtimeAnalysis();
      this.updateUI();
    });
  }

  pause(): void {
    this.audioEngine.pause();
    this.timelineRenderer?.setPlaybackState(false);
    this.stopRealtimeAnalysis();
    this.updateUI();
  }

  stop(): void {
    this.audioEngine.stopTimeline();
    this.timelineRenderer?.setPlaybackState(false);
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
    if (this.timelineRenderer) {
      this.timelineRenderer.zoomIn();
    } else {
      this.waveformRenderer.zoomIn();
    }
  }

  zoomOut(): void {
    if (this.timelineRenderer) {
      this.timelineRenderer.zoomOut();
    } else {
      this.waveformRenderer.zoomOut();
    }
  }

  zoomFit(): void {
    if (this.timelineRenderer) {
      this.timelineRenderer.zoomFit();
    } else {
      this.waveformRenderer.zoomFit();
    }
  }

  // ==================== Edit Operations ====================

  /**
   * Re-schedule playback from the current position.
   * Called after buffer swaps (denoise, undo/redo) so scheduled
   * AudioBufferSourceNode instances are replaced with ones referencing
   * the updated buffers.
   * - Playing  → stop + restart from current sample
   * - Paused   → stop only (no restart; user must press play)
   * - Stopped  → no-op
   */
  private invalidatePlayback(): void {
    if (!this.audioEngine.isPlaying && !this.audioEngine.isPaused) return;
    const sr = this.timelineModel.timeline.sampleRate;
    const currentSample = this.audioEngine.getPlaybackPositionSamples(sr);
    const wasPlaying = this.audioEngine.isPlaying;
    this.audioEngine.stopTimeline();
    if (wasPlaying) {
      this.audioEngine.playTimeline(this.timelineModel.timeline, this.bufferPool, currentSample);
    }
  }

  applyBuffer(buffer: AudioBuffer): void {
    this.audioEngine.setBuffer(buffer);
    this.waveformRenderer.setAudioBuffer(buffer);
    this.spectrogramRenderer.setAudioBuffer(buffer);
    this.metering.setAudioBuffer(buffer);
    this.updateFileInfo();
    this.updateChannelInfo();
    this.updateUI();
  }

  undo(): void {
    if (this.timelineUndoManager.canUndo()) {
      this.timelineUndoManager.undo();
      this.invalidatePlayback();
      this.mixer.updateStripsUI(this.timelineModel.timeline.tracks);
      this.timelineRenderer?.render();
      this.updateUI();
    }
  }

  redo(): void {
    if (this.timelineUndoManager.canRedo()) {
      this.timelineUndoManager.redo();
      this.invalidatePlayback();
      this.mixer.updateStripsUI(this.timelineModel.timeline.tracks);
      this.timelineRenderer?.render();
      this.updateUI();
    }
  }

  trim(): void {
    const selection = this.waveformRenderer.getSelection();
    if (!selection || !this.audioEditor) return;
    this.stop();
    const newBuffer = this.audioEditor.trim(this.audioEngine.audioBuffer!, selection.start, selection.end);
    this.cuePointManager.adjustForTrim(selection.start, selection.end);
    this.applyBuffer(newBuffer);
    this.cuePointRenderer.render();
  }

  deleteSelection(): void {
    const selection = this.waveformRenderer.getSelection();
    if (!selection || !this.audioEditor) return;
    this.stop();
    const newBuffer = this.audioEditor.deleteSelection(this.audioEngine.audioBuffer!, selection.start, selection.end);
    if (newBuffer) {
      this.cuePointManager.adjustForDeletion(selection.start, selection.end);
      this.applyBuffer(newBuffer);
      this.cuePointRenderer.render();
    }
  }

  normalize(): void {
    const level = parseFloat((document.getElementById('normalizeLevel') as HTMLInputElement).value);

    // Timeline mode: normalize selected clips (AudioSuite-style pre-render)
    if (this.timelineModel.timeline.tracks.length > 0) {
      const selected = this.timelineModel.timeline.selectedClipIds;
      if (selected.length === 0) { this.hideModal('normalizeModal'); return; }
      for (const track of this.timelineModel.timeline.tracks) {
        for (const clip of track.clips) {
          if (selected.includes(clip.id)) {
            const newBufferId = this.bufferPool.createNormalizedBuffer(
              clip.bufferIds[0], clip.sourceStart, clip.sourceEnd, level,
            );
            if (newBufferId) {
              const originalBufferId = clip.bufferIds[0];
              clip.bufferIds = [newBufferId];
              this.timelineUndoManager.pushExecuted(
                new NormalizeClipCommand(this.timelineModel, track.id, clip.id, originalBufferId, newBufferId),
              );
            }
          }
        }
      }
      this.timelineRenderer?.clearPeakCaches();
      this.timelineRenderer?.render();
      this.hideModal('normalizeModal');
      return;
    }

    // Legacy single-buffer mode
    const selection = this.waveformRenderer.getSelection();
    if (!this.audioEditor) return;
    this.stop();
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
    this.audioEditor.fadeIn(this.audioEngine.audioBuffer!, selection.start, selection.end);
    this.refreshWaveform();
  }

  fadeOut(): void {
    const selection = this.waveformRenderer.getSelection();
    if (!selection || !this.audioEditor) return;
    this.stop();
    this.audioEditor.fadeOut(this.audioEngine.audioBuffer!, selection.start, selection.end);
    this.refreshWaveform();
  }

  reverse(): void {
    // Timeline mode: reverse selected clips (AudioSuite-style pre-render)
    if (this.timelineModel.timeline.tracks.length > 0) {
      const selected = this.timelineModel.timeline.selectedClipIds;
      if (selected.length === 0) return;
      for (const track of this.timelineModel.timeline.tracks) {
        for (const clip of track.clips) {
          if (selected.includes(clip.id)) {
            const newBufferId = this.bufferPool.createReversedBuffer(clip.bufferIds[0]);
            if (newBufferId) {
              const originalBufferId = clip.bufferIds[0];
              clip.bufferIds = [newBufferId];
              clip.reversed = !clip.reversed;
              this.timelineUndoManager.pushExecuted(
                new ReverseClipCommand(this.timelineModel, track.id, clip.id, originalBufferId, newBufferId),
              );
            }
          }
        }
      }
      this.timelineRenderer?.clearPeakCaches();
      this.timelineRenderer?.render();
      return;
    }
    // Legacy single-buffer mode
    const selection = this.waveformRenderer.getSelection();
    if (!this.audioEditor) return;
    this.stop();
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
      this.updateTimelineMeters();
      this.meterAnimationFrame = requestAnimationFrame(updateMeters);
    };
    updateMeters();
  }

  private updateTimelineMeters(): void {
    if (!this.timelineRenderer || !this.timelineModel.timeline) return;
    const data = new Float32Array(1024);
    let needsRender = false;
    for (const track of this.timelineModel.timeline.tracks) {
      const analyser = this.audioEngine.getTrackAnalyser(track.id);
      const prevDb = this.timelineRenderer.trackMeterLevels.get(track.id) ?? -60;
      if (!analyser) {
        if (prevDb > -60) {
          this.timelineRenderer.trackMeterLevels.set(track.id, -60);
          needsRender = true;
        }
        continue;
      }
      analyser.getFloatTimeDomainData(data);
      let peak = 0;
      for (let j = 0; j < data.length; j++) {
        const abs = Math.abs(data[j]);
        if (abs > peak) peak = abs;
      }
      const db = peak > 0 ? 20 * Math.log10(peak) : -60;
      // Only flag render if level changed by > 0.5 dB
      if (Math.abs(db - prevDb) > 0.5) needsRender = true;
      this.timelineRenderer.trackMeterLevels.set(track.id, db);
    }
    if (needsRender) this.timelineRenderer.render();
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
      this.pluginInsertTargetTrackId = null;
      this.showPluginBrowser(null);
    }
  }

  showPluginBrowser(trackId: string | null): void {
    const modal = document.getElementById('pluginBrowserModal');
    if (!modal) return;

    if (trackId) this.pluginInsertTargetTrackId = trackId;

    // Ensure pluginHost exists for browsing
    if (!this.pluginHost && this.audioEngine.audioContext) {
      this.pluginHost = new PluginHost(this.audioEngine.audioContext);
      this.mixer.pluginHost = this.pluginHost;
      this.pluginParameterPanel.setPluginHost(this.pluginHost);
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
        item.addEventListener('click', () => {
          this.insertPluginToTrack(plugin);
        });
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

  private async insertPluginToTrack(pluginInfo: PluginInfo): Promise<void> {
    const trackId = this.pluginInsertTargetTrackId;
    if (!trackId || !this.pluginHost) {
      this.hideModal('pluginBrowserModal');
      return;
    }

    const track = this.timelineModel.timeline.tracks.find(t => t.id === trackId);
    if (!track) {
      this.hideModal('pluginBrowserModal');
      return;
    }

    try {
      const instance = await this.pluginHost.createInstance(pluginInfo);
      const insert: TrackInsert = {
        instanceId: instance.id,
        pluginId: pluginInfo.id,
        parameters: instance.parameters,
        bypassed: false,
      };
      track.inserts.push(insert);
      this.audioEngine.rebuildInsertChain(trackId, track.inserts, this.pluginHost);
      this.invalidatePlayback();
      this.mixer.updateStripsUI(this.timelineModel.timeline.tracks);
      this.timelineRenderer?.render();
    } catch (err) {
      console.error('Failed to insert plugin:', err);
    }

    this.hideModal('pluginBrowserModal');
    this.pluginInsertTargetTrackId = null;
  }

  private removePluginFromTrack(trackId: string, instanceId: string): void {
    const track = this.timelineModel.timeline.tracks.find(t => t.id === trackId);
    if (!track || !this.pluginHost) return;

    const idx = track.inserts.findIndex(ins => ins.instanceId === instanceId);
    if (idx < 0) return;

    track.inserts.splice(idx, 1);
    this.pluginHost.removeInstance(instanceId);
    this.audioEngine.rebuildInsertChain(trackId, track.inserts, this.pluginHost);
    this.invalidatePlayback();
    this.mixer.updateStripsUI(this.timelineModel.timeline.tracks);
    this.timelineRenderer?.render();

    // Hide parameter panel if it was showing this instance
    if (this.pluginParameterPanel.getCurrentInstanceId() === instanceId) {
      this.pluginParameterPanel.hide();
    }
  }

  private togglePluginBypass(trackId: string, instanceId: string): void {
    const track = this.timelineModel.timeline.tracks.find(t => t.id === trackId);
    if (!track || !this.pluginHost) return;

    const insert = track.inserts.find(ins => ins.instanceId === instanceId);
    if (!insert) return;

    insert.bypassed = !insert.bypassed;
    this.audioEngine.rebuildInsertChain(trackId, track.inserts, this.pluginHost);
    this.invalidatePlayback();
    this.mixer.updateStripsUI(this.timelineModel.timeline.tracks);
    this.timelineRenderer?.render();
  }

  private reorderTrackPlugins(trackId: string, fromIndex: number, toIndex: number): void {
    const track = this.timelineModel.timeline.tracks.find(t => t.id === trackId);
    if (!track || !this.pluginHost) return;

    const inserts = track.inserts;
    if (fromIndex < 0 || fromIndex >= inserts.length || toIndex < 0 || toIndex >= inserts.length) return;

    const [moved] = inserts.splice(fromIndex, 1);
    inserts.splice(toIndex, 0, moved);
    this.audioEngine.rebuildInsertChain(trackId, inserts, this.pluginHost);
    this.invalidatePlayback();
    this.mixer.updateStripsUI(this.timelineModel.timeline.tracks);
    this.timelineRenderer?.render();
  }

  // ==================== Track Context Menu ====================

  private activeContextMenu: HTMLElement | null = null;
  private contextMenuCleanup: (() => void) | null = null;

  private showTrackContextMenu(trackId: string, clientX: number, clientY: number): void {
    this.dismissContextMenu();

    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.style.left = `${clientX}px`;
    menu.style.top = `${clientY}px`;

    const newTrackItem = document.createElement('div');
    newTrackItem.className = 'context-menu-item';
    newTrackItem.textContent = 'New Track...';
    newTrackItem.addEventListener('click', () => {
      this.dismissContextMenu();
      this.showCreateTrackDialog();
    });
    menu.appendChild(newTrackItem);

    const deleteItem = document.createElement('div');
    deleteItem.className = 'context-menu-item';
    deleteItem.textContent = 'Delete Track';
    deleteItem.addEventListener('click', () => {
      this.dismissContextMenu();
      this.deleteTrack(trackId);
    });
    menu.appendChild(deleteItem);

    document.body.appendChild(menu);
    this.activeContextMenu = menu;

    // Auto-close handlers
    const onClickOutside = (e: MouseEvent) => {
      if (!menu.contains(e.target as Node)) this.dismissContextMenu();
    };
    const onEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') this.dismissContextMenu();
    };
    const onBlur = () => this.dismissContextMenu();

    // Delay to avoid immediate dismiss from the same right-click event
    requestAnimationFrame(() => {
      document.addEventListener('mousedown', onClickOutside);
      document.addEventListener('keydown', onEscape);
      window.addEventListener('blur', onBlur);
    });

    this.contextMenuCleanup = () => {
      document.removeEventListener('mousedown', onClickOutside);
      document.removeEventListener('keydown', onEscape);
      window.removeEventListener('blur', onBlur);
    };
  }

  private dismissContextMenu(): void {
    if (this.activeContextMenu) {
      this.activeContextMenu.remove();
      this.activeContextMenu = null;
    }
    if (this.contextMenuCleanup) {
      this.contextMenuCleanup();
      this.contextMenuCleanup = null;
    }
  }

  /**
   * Show context menu in the timeline content area.
   * Shows "Merge to stereo track" when exactly 2 mono clips are selected.
   */
  private showClipContentContextMenu(clientX: number, clientY: number): void {
    const tracks = this.timelineModel.timeline.tracks;
    const selectedIds = this.timelineModel.timeline.selectedClipIds;

    // Check if exactly 2 mono clips are selected
    const selectedMonoClips: Array<{ clip: Clip; trackId: string; trackIndex: number }> = [];
    for (let ti = 0; ti < tracks.length; ti++) {
      const track = tracks[ti];
      if (track.channels !== 1) continue;
      for (const clip of track.clips) {
        if (selectedIds.includes(clip.id) && clip.bufferIds.length === 1) {
          selectedMonoClips.push({ clip, trackId: track.id, trackIndex: ti });
        }
      }
    }

    const canMerge = selectedMonoClips.length === 2 && selectedIds.length === 2;
    if (!canMerge) return; // No items to show — skip menu

    this.dismissContextMenu();

    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.style.left = `${clientX}px`;
    menu.style.top = `${clientY}px`;

    const mergeItem = document.createElement('div');
    mergeItem.className = 'context-menu-item';
    mergeItem.textContent = 'Merge to stereo track';
    mergeItem.addEventListener('click', () => {
      this.dismissContextMenu();
      this.mergeSelectedMonoToStereo(selectedMonoClips);
    });
    menu.appendChild(mergeItem);

    document.body.appendChild(menu);
    this.activeContextMenu = menu;

    const onClickOutside = (e: MouseEvent) => {
      if (!menu.contains(e.target as Node)) this.dismissContextMenu();
    };
    const onEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') this.dismissContextMenu();
    };
    const onBlur = () => this.dismissContextMenu();

    requestAnimationFrame(() => {
      document.addEventListener('mousedown', onClickOutside);
      document.addEventListener('keydown', onEscape);
      window.addEventListener('blur', onBlur);
    });

    this.contextMenuCleanup = () => {
      document.removeEventListener('mousedown', onClickOutside);
      document.removeEventListener('keydown', onEscape);
      window.removeEventListener('blur', onBlur);
    };
  }

  /**
   * Merge two selected mono clips into a new stereo track.
   * The new track is inserted immediately after the higher-indexed source track.
   */
  private mergeSelectedMonoToStereo(
    clips: Array<{ clip: Clip; trackId: string; trackIndex: number }>,
  ): void {
    // Sort by track index so top track becomes L channel, bottom becomes R
    const sorted = [...clips].sort((a, b) => a.trackIndex - b.trackIndex);
    const [first, second] = sorted;

    const insertAfterIdx = second.trackIndex;
    const newTrackName = `${first.clip.name ?? 'Clip'} (Stereo)`;
    const newTrackColor = CHANNEL_COLORS[insertAfterIdx % CHANNEL_COLORS.length];

    this.timelineUndoManager.push(
      new MergeToStereoCommand(
        this.timelineModel,
        first.clip,
        first.trackId,
        second.clip,
        second.trackId,
        newTrackName,
        newTrackColor,
        insertAfterIdx,
      ),
    );

    this.mixer.updateStripsUI(this.timelineModel.timeline.tracks);
    this.timelineRenderer?.render();
    this.invalidatePlayback();
  }

  private showFileBrowserContextMenu(file: AudioFileMeta, clientX: number, clientY: number): void {
    this.dismissContextMenu();

    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.style.left = `${clientX}px`;
    menu.style.top = `${clientY}px`;

    // Marking options
    const markingStates: Array<{ label: string; status: FileMarkingStatus }> = [
      { label: 'Mark as Unprocessed', status: 'pending' },
      { label: 'Mark as Processing', status: 'skip' },
      { label: 'Mark as Finished', status: 'done' },
    ];
    for (const { label, status } of markingStates) {
      const item = document.createElement('div');
      item.className = 'context-menu-item';
      item.textContent = label;
      const currentStatus = this.fileStatuses.get(file.path) || 'pending';
      if (currentStatus === status) {
        item.style.opacity = '0.5';
        item.style.cursor = 'default';
      } else {
        item.addEventListener('click', () => {
          this.dismissContextMenu();
          this.setFileStatus(file.path, status);
        });
      }
      menu.appendChild(item);
    }

    const separator = document.createElement('div');
    separator.className = 'context-menu-separator';
    menu.appendChild(separator);

    const copyItem = document.createElement('div');
    copyItem.className = 'context-menu-item';
    copyItem.textContent = 'Copy metadata to session';
    copyItem.addEventListener('click', () => {
      this.dismissContextMenu();
      this.copyFileMetaToSession(file);
    });
    menu.appendChild(copyItem);

    const importItem = document.createElement('div');
    importItem.className = 'context-menu-item';
    importItem.textContent = 'Import into timeline';
    importItem.addEventListener('click', () => {
      this.dismissContextMenu();
      void this.importFromBrowser(file);
    });
    menu.appendChild(importItem);

    document.body.appendChild(menu);
    this.activeContextMenu = menu;

    const onClickOutside = (e: MouseEvent) => {
      if (!menu.contains(e.target as Node)) this.dismissContextMenu();
    };
    const onEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') this.dismissContextMenu();
    };
    const onBlur = () => this.dismissContextMenu();

    requestAnimationFrame(() => {
      document.addEventListener('mousedown', onClickOutside);
      document.addEventListener('keydown', onEscape);
      window.addEventListener('blur', onBlur);
    });

    this.contextMenuCleanup = () => {
      document.removeEventListener('mousedown', onClickOutside);
      document.removeEventListener('keydown', onEscape);
      window.removeEventListener('blur', onBlur);
    };
  }

  private deleteTrack(trackId: string): void {
    this.timelineUndoManager.push(
      new DeleteTrackCommand(this.timelineModel, trackId),
    );
    this.mixer.updateStripsUI(this.timelineModel.timeline.tracks);
    this.timelineRenderer?.render();
    this.updateUI();
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

    const copyMetaBtn = document.getElementById('copyMetaToSessionBtn');
    if (copyMetaBtn) {
      copyMetaBtn.addEventListener('click', () => {
        if (this.selectedBrowserFile) {
          this.copyFileMetaToSession(this.selectedBrowserFile);
        }
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

      // Use metadata-aware scanner if available, fall back to basic scan
      if (window.appAPI.scanAudioFolder) {
        this.folderFiles = await window.appAPI.scanAudioFolder(folder);
      } else {
        const basic = await window.appAPI.scanFolder(folder);
        this.folderFiles = basic.map(f => ({
          ...f,
          channels: null,
          sample_rate: null,
          bits_per_sample: null,
          duration_secs: null,
          bext_description: null,
          bext_originator: null,
          bext_originator_ref: null,
          bext_date: null,
          bext_time: null,
          bext_coding_history: null,
          ixml: null,
        }));
      }
      this.fileStatuses.clear();
      this.selectedBrowserFile = null;
      // Load persisted sidecar statuses before rendering
      await this.loadSidecarStatuses(this.folderFiles);
      this.renderFileBrowser();
      this.updateSourceMetadataPanel(null);
    } catch (err: unknown) {
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
      const isSelected = this.selectedBrowserFile?.path === f.path;
      const item = document.createElement('div');
      item.className = `file-browser-item status-${status}${isSelected ? ' active' : ''}`;
      item.dataset.path = f.path;

      const nameSpan = document.createElement('span');
      nameSpan.className = 'fb-name';
      nameSpan.textContent = f.name;
      nameSpan.title = f.path;

      const statusBtn = document.createElement('button');
      statusBtn.className = 'fb-status-btn';
      statusBtn.textContent = status === 'done' ? '\u2713' : status === 'skip' ? '\u2212' : '\u25CB';
      statusBtn.title = `Status: ${status} (click to cycle)`;
      statusBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const cur = this.fileStatuses.get(f.path) || 'pending';
        this.setFileStatus(f.path, cycleMarkingStatus(cur));
      });
      // Prevent rapid double-click on the marker circle from triggering the
      // item-level dblclick handler that imports the file.
      statusBtn.addEventListener('dblclick', (e) => {
        e.stopPropagation();
      });

      item.appendChild(statusBtn);
      item.appendChild(nameSpan);

      // Show audio metadata if available
      if (f.channels != null && f.sample_rate != null) {
        const metaSpan = document.createElement('span');
        metaSpan.className = 'fb-meta';
        const ch = f.channels === 1 ? 'M' : f.channels === 2 ? 'St' : `${f.channels}ch`;
        const sr = (f.sample_rate / 1000).toFixed(f.sample_rate % 1000 === 0 ? 0 : 1) + 'k';
        const dur = f.duration_secs != null ? this.formatDurationShort(f.duration_secs) : '';
        metaSpan.textContent = `${ch} ${sr}${dur ? ' ' + dur : ''}`;
        item.appendChild(metaSpan);
      } else {
        const sizeSpan = document.createElement('span');
        sizeSpan.className = 'fb-size';
        sizeSpan.textContent = f.size > 1048576
          ? (f.size / 1048576).toFixed(1) + ' MB'
          : (f.size / 1024).toFixed(0) + ' KB';
        item.appendChild(sizeSpan);
      }

      // Custom mouse drag → drop onto timeline (replaces HTML5 drag/drop for WKWebView)
      item.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        this.fileDragState = { file: f, active: false, startX: e.clientX, startY: e.clientY };
      });

      // Single click → select + show metadata (suppressed after drag)
      item.addEventListener('click', () => {
        if (this.suppressNextClick) {
          this.suppressNextClick = false;
          return;
        }
        this.selectBrowserFile(f);
      });
      // Double click → import into timeline
      item.addEventListener('dblclick', () => this.importFromBrowser(f));
      // Right-click → context menu
      item.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this.selectBrowserFile(f);
        this.showFileBrowserContextMenu(f, e.clientX, e.clientY);
      });
      listEl.appendChild(item);
    }

    // Update stats
    if (statsEl) {
      const total = this.folderFiles.length;
      const done = Array.from(this.fileStatuses.values()).filter(s => s === 'done').length;
      statsEl.textContent = `${done}/${total} done`;
    }
  }

  private formatDurationShort(secs: number): string {
    if (secs < 60) return secs.toFixed(1) + 's';
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  private selectBrowserFile(file: AudioFileMeta): void {
    this.selectedBrowserFile = file;
    this.renderFileBrowser();
    this.updateSourceMetadataPanel(file);
  }

  /**
   * Set the marking status for a file and persist it to a sidecar file.
   * Falls back gracefully if the write fails (e.g. read-only location).
   */
  private setFileStatus(filePath: string, status: FileMarkingStatus): void {
    this.fileStatuses.set(filePath, status);
    this.renderFileBrowser();
    // Persist asynchronously — don't block UI
    void this.saveSidecar(filePath, status);
  }

  private async saveSidecar(filePath: string, status: FileMarkingStatus): Promise<void> {
    if (!window.appAPI?.writeFileText) return;
    const sidecarPath = getSidecarPath(filePath);
    try {
      await window.appAPI.writeFileText(sidecarPath, serializeMarkingStatus(status));
    } catch (err) {
      // Read-only or sandboxed location — sidecar write failed, in-memory state is preserved
      console.warn('[FileBrowser] sidecar write failed (read-only?):', sidecarPath, err);
    }
  }

  /**
   * Load sidecar marking files for all files in the folder.
   * Silently ignores files that have no sidecar (they default to 'pending').
   */
  private async loadSidecarStatuses(files: AudioFileMeta[]): Promise<void> {
    const api = window.appAPI;
    if (!api?.readFileText) return;
    await Promise.all(files.map(async (f) => {
      const sidecarPath = getSidecarPath(f.path);
      try {
        const text = await api.readFileText(sidecarPath);
        const status = deserializeMarkingStatus(text);
        if (status !== 'pending') {
          this.fileStatuses.set(f.path, status);
        }
      } catch {
        // No sidecar — default remains 'pending'
      }
    }));
  }

  private async importFromBrowser(file: AudioFileMeta): Promise<void> {
    // .fcs files open as sessions, not audio imports
    if (file.name.toLowerCase().endsWith('.fcs')) {
      await this._loadSession(file.path);
      return;
    }
    const id = this.fileQueue.addFile({ name: file.name, path: file.path });
    this.renderFileList();
    await this.loadFileFromPath(file.path, id);
  }

  /**
   * Import a file at a specific track + time position (drag-and-drop from file browser).
   * Unlike loadFileFromPath(), this does NOT clear existing tracks.
   */
  private async importFileAtPosition(filePath: string, targetTrackIndex: number, sampleOffset: number, fileMeta?: AudioFileMeta): Promise<void> {
    try {
      const name = filePath.split('/').pop() || 'Untitled';
      this.showLoadingIndicator(name);
      await new Promise<void>(r => requestAnimationFrame(() => r()));

      const result = await FileHandler.importFilePath(filePath);

      let audioBuffer: AudioBuffer;
      let parsedData: ParsedAudioData | null = null;
      if (result instanceof ArrayBuffer) {
        audioBuffer = await this.audioEngine.loadAudio(result);
        this.originalBitDepth = null;
      } else {
        parsedData = result;
        this.originalBitDepth = result.bits_per_sample;
        audioBuffer = await this.audioEngine.loadFromParsedData(result);
      }

      // Ensure audioContext and timeline are initialized for empty timelines
      if (this.timelineModel.timeline.tracks.length === 0) {
        this.timelineModel.timeline.sampleRate = audioBuffer.sampleRate;
        if (!this.audioEditor) {
          this.audioEditor = new AudioEditor(this.audioEngine.audioContext!);
        }
        if (!this.pluginHost) {
          this.pluginHost = new PluginHost(this.audioEngine.audioContext!);
          this.mixer.pluginHost = this.pluginHost;
          this.pluginParameterPanel.setPluginHost(this.pluginHost);
        }
      }

      // Sample rate mismatch warning — let user cancel before importing
      if (hasSampleRateMismatch(
            this.timelineModel.timeline.sampleRate,
            audioBuffer.sampleRate,
            this.timelineModel.timeline.tracks.length)) {
        const filekHz = formatSampleRate(audioBuffer.sampleRate);
        const sessionkHz = formatSampleRate(this.timelineModel.timeline.sampleRate);
        const ok = await this.showConfirmDialog(
          'Sample Rate Mismatch',
          `File is ${filekHz}, session is ${sessionkHz}. ` +
          `Audio will be resampled to match session.`,
        );
        if (!ok) {
          this.hideLoadingIndicator();
          return;
        }
      }

      // Import into buffer pool
      const bufferIds = parsedData
        ? this.bufferPool.importFromRawChannels(
            parsedData.samples, parsedData.channels,
            parsedData.num_samples, parsedData.sample_rate, name)
        : this.bufferPool.importMultiChannel(audioBuffer, name);

      // Use ImportFileAtPositionCommand for undo support
      const cmd = new ImportFileAtPositionCommand(
        this.timelineModel, bufferIds, name,
        audioBuffer.sampleRate, audioBuffer.length,
        targetTrackIndex, sampleOffset,
      );
      this.timelineUndoManager.push(cmd);

      // Update routing and UI
      this.audioEngine.setupTrackRouting(this.timelineModel.timeline.tracks);
      this.mixer.setupTracks(this.timelineModel.timeline.tracks);
      if (this.timelineRenderer) {
        this.timelineRenderer.setTimeline(this.timelineModel.timeline, this.bufferPool);
        this.timelineRenderer.render();
      }

      this.updateUI();

      // Pre-fill inline metadata from the first imported file
      if (!this.metadataPreFilled) {
        this.metadataPreFilled = true;
        try {
          const meta = fileMeta ?? await window.appAPI!.readFileMetadata(filePath);
          this.prefillInlineMetadata(meta);
        } catch (metaErr) {
          console.warn('[Metadata] Could not pre-fill from first import:', metaErr);
        }
      }

      this.hideLoadingIndicator();
    } catch (err: unknown) {
      console.error('Import at position error:', err);
      this.hideLoadingIndicator();
      const msg = err instanceof Error ? err.message : String(err);
      alert('Error importing file: ' + msg);
    }
  }

  /**
   * Import audio file(s) to NEW tracks at playhead position (Cmd+O / Pro Tools Cmd+Shift+I workflow).
   * For EACH file: decode audio, create a new track matching channel count,
   * insert after the currently selected track (or at end), place clip at playhead.
   * Does NOT use the file queue or clear existing tracks.
   */
  async importAudioToTimeline(filePaths: string[]): Promise<void> {
    this.showLoadingIndicator(`Importing ${filePaths.length} file(s)…`);
    await new Promise<void>(r => requestAnimationFrame(() => r()));

    let firstFilePath: string | null = null;

    for (const filePath of filePaths) {
      try {
        const name = filePath.split('/').pop() || 'Untitled';

        const result = await FileHandler.importFilePath(filePath);

        let audioBuffer: AudioBuffer;
        let parsedData: ParsedAudioData | null = null;
        if (result instanceof ArrayBuffer) {
          audioBuffer = await this.audioEngine.loadAudio(result);
        } else {
          parsedData = result;
          audioBuffer = await this.audioEngine.loadFromParsedData(result);
        }

        // Ensure audioContext and helpers are initialized
        if (!this.audioEditor) {
          this.audioEditor = new AudioEditor(this.audioEngine.audioContext!);
        }
        if (!this.pluginHost) {
          this.pluginHost = new PluginHost(this.audioEngine.audioContext!);
          this.mixer.pluginHost = this.pluginHost;
          this.pluginParameterPanel.setPluginHost(this.pluginHost);
        }

        // Ensure timeline sampleRate is set for empty timelines
        if (this.timelineModel.timeline.tracks.length === 0) {
          this.timelineModel.timeline.sampleRate = audioBuffer.sampleRate;
        }

        // Sample rate mismatch warning — let user cancel before importing
        if (hasSampleRateMismatch(
              this.timelineModel.timeline.sampleRate,
              audioBuffer.sampleRate,
              this.timelineModel.timeline.tracks.length)) {
          const filekHz = formatSampleRate(audioBuffer.sampleRate);
          const sessionkHz = formatSampleRate(this.timelineModel.timeline.sampleRate);
          const ok = await this.showConfirmDialog(
            'Sample Rate Mismatch',
            `File is ${filekHz}, session is ${sessionkHz}. ` +
            `Audio will be resampled to match session.`,
          );
          if (!ok) continue;
        }

        // Import into buffer pool
        const bufferIds = parsedData
          ? this.bufferPool.importFromRawChannels(
              parsedData.samples, parsedData.channels,
              parsedData.num_samples, parsedData.sample_rate, name)
          : this.bufferPool.importMultiChannel(audioBuffer, name);

        // Determine insert position: after selected track, or at end
        const selectedTrackIds = this.timelineModel.timeline.selectedTrackIds;
        let insertAfterIndex = -1; // -1 = append at end
        if (selectedTrackIds.length > 0) {
          const lastSelectedId = selectedTrackIds[selectedTrackIds.length - 1];
          insertAfterIndex = this.timelineModel.timeline.tracks.findIndex(t => t.id === lastSelectedId);
        }

        // Use the playhead position as clip offset
        const sampleOffset = this.timelineModel.timeline.playheadSample;

        // Execute via undo-able command
        const cmd = new ImportAudioToNewTrackCommand(
          this.timelineModel, bufferIds, name,
          audioBuffer.sampleRate, audioBuffer.length,
          insertAfterIndex, sampleOffset,
        );
        this.timelineUndoManager.push(cmd);

        if (!firstFilePath) firstFilePath = filePath;
      } catch (err: unknown) {
        console.error('Import to timeline error:', err);
        const msg = err instanceof Error ? err.message : String(err);
        alert('Error importing file: ' + msg);
      }
    }

    // Rebuild routing and UI once after all files are imported
    this.audioEngine.setupTrackRouting(this.timelineModel.timeline.tracks);
    this.mixer.setupTracks(this.timelineModel.timeline.tracks);
    if (this.timelineRenderer) {
      this.timelineRenderer.setTimeline(this.timelineModel.timeline, this.bufferPool);
      this.timelineRenderer.render();
    }
    this.updateUI();

    // Pre-fill inline metadata from the first imported file
    if (firstFilePath && !this.metadataPreFilled) {
      this.metadataPreFilled = true;
      try {
        const meta = await window.appAPI!.readFileMetadata(firstFilePath);
        this.prefillInlineMetadata(meta);
      } catch (metaErr) {
        console.warn('[Metadata] Could not pre-fill from first import:', metaErr);
      }
    }

    this.hideLoadingIndicator();
  }

  /**
   * Open the import dialog (Cmd+O). Uses native Tauri dialog if available,
   * otherwise falls back to the HTML file input element.
   */
  private async openImportDialog(): Promise<void> {
    if (window.appAPI) {
      const paths = await window.appAPI.showOpenDialog({
        title: 'Import Audio',
        multiple: true,
        filters: [{ name: 'Audio Files', extensions: ['wav', 'aif', 'aiff', 'flac', 'mp3', 'ogg'] }],
      });
      if (paths && paths.length > 0) {
        await this.importAudioToTimeline(paths);
      }
    } else {
      // Browser fallback: trigger the existing file input
      document.getElementById('fileInput')!.click();
    }
  }

  /**
   * Pre-fill inline metadata fields from the first imported file's BEXT/iXML data.
   * Only fills empty fields -- never overwrites user-entered values.
   */
  private prefillInlineMetadata(file: AudioFileMeta): void {
    const setIfEmpty = (id: string, value: string | null | undefined) => {
      if (!value) return;
      const el = document.getElementById(id) as HTMLInputElement | null;
      if (el && !el.value) el.value = value;
    };

    // Helper to extract iXML tags
    const getTag = (tag: string): string => {
      if (!file.ixml) return '';
      const match = file.ixml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'i'));
      return match ? match[1].trim() : '';
    };

    // BWF fields: BEXT first, iXML as fallback
    setIfEmpty('inlineDescription', file.bext_description || getTag('NOTE'));
    setIfEmpty('inlineOriginator', file.bext_originator);
    setIfEmpty('inlineDate', file.bext_date);
    setIfEmpty('inlineTime', file.bext_time);
    setIfEmpty('inlineScene', getTag('SCENE'));
    setIfEmpty('inlineTake', getTag('TAKE'));
    setIfEmpty('inlineTape', getTag('TAPE'));
    setIfEmpty('inlineNote', getTag('NOTE'));

    // UCS fields from filename parsing
    const ucs = parseUCSFilename(file.name);
    if (ucs) {
      const catSelect = document.getElementById('inlineUcsCategory') as HTMLSelectElement | null;
      const subCatSelect = document.getElementById('inlineUcsSubCategory') as HTMLSelectElement | null;
      if (catSelect && !catSelect.value && ucs.category) {
        for (const opt of Array.from(catSelect.options)) {
          if (opt.value === ucs.category) { catSelect.value = ucs.category; break; }
        }
      }
      if (subCatSelect && !subCatSelect.value && ucs.subCategory) {
        for (const opt of Array.from(subCatSelect.options)) {
          if (opt.value === ucs.subCategory) { subCatSelect.value = ucs.subCategory; break; }
        }
      }
      setIfEmpty('inlineCatId', ucs.catId);
      setIfEmpty('inlineFxName', ucs.fxName);
      setIfEmpty('inlineCreatorId', ucs.creatorId);
      setIfEmpty('inlineSourceId', ucs.sourceId);
    }
  }

  private updateSourceMetadataPanel(file: AudioFileMeta | null): void {
    const panel = document.getElementById('sourceMetaPanel');
    const rowsEl = document.getElementById('sourceMetaRows');

    if (!file) {
      if (panel) panel.style.display = 'none';
      return;
    }

    // ---- Build read-only source metadata rows ----
    const getTag = (tag: string): string => {
      if (!file.ixml) return '';
      const match = file.ixml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'i'));
      return match ? match[1].trim() : '';
    };

    if (rowsEl) {
      rowsEl.innerHTML = '';
      const addRow = (label: string, value: string) => {
        const row = document.createElement('div');
        row.className = 'source-meta-row';
        const labelEl = document.createElement('span');
        labelEl.className = 'source-meta-label';
        labelEl.textContent = label;
        const valueEl = document.createElement('span');
        valueEl.className = 'source-meta-value';
        valueEl.textContent = value;
        valueEl.title = value;
        row.appendChild(labelEl);
        row.appendChild(valueEl);
        rowsEl.appendChild(row);
      };

      if (file.channels != null) {
        const ch = file.channels === 1 ? 'Mono' : file.channels === 2 ? 'Stereo' : `${file.channels}ch`;
        addRow('Channels', ch);
      }
      if (file.sample_rate != null) {
        const sr = (file.sample_rate / 1000).toFixed(file.sample_rate % 1000 === 0 ? 0 : 1) + ' kHz';
        addRow('Sample Rate', sr);
      }
      if (file.bits_per_sample != null) {
        addRow('Bit Depth', `${file.bits_per_sample}-bit`);
      }
      if (file.duration_secs != null) {
        const d = file.duration_secs;
        const durStr = d < 60
          ? d.toFixed(1) + 's'
          : `${Math.floor(d / 60)}:${Math.floor(d % 60).toString().padStart(2, '0')}`;
        addRow('Duration', durStr);
      }
      if (file.bext_description) addRow('Description', file.bext_description);
      if (file.bext_originator) addRow('Originator', file.bext_originator);
      if (file.bext_date) addRow('Date', file.bext_date);
      if (file.bext_time) addRow('Time', file.bext_time);
      const scene = getTag('SCENE');
      const take = getTag('TAKE');
      const tape = getTag('TAPE');
      if (scene) addRow('Scene', scene);
      if (take) addRow('Take', take);
      if (tape) addRow('Tape', tape);

      if (rowsEl.children.length === 0) {
        const empty = document.createElement('div');
        empty.style.cssText = 'font-size:10px;color:var(--text-muted);padding:4px 0;font-style:italic;';
        empty.textContent = 'No embedded metadata';
        rowsEl.appendChild(empty);
      }
    }

    if (panel) panel.style.display = 'block';
  }

  /**
   * Copy embedded metadata from a browser file to the session metadata fields.
   * Overwrites existing session field values (force mode — used by context menu).
   */
  private copyFileMetaToSession(file: AudioFileMeta): void {
    const getTag = (tag: string): string => {
      if (!file.ixml) return '';
      const match = file.ixml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'i'));
      return match ? match[1].trim() : '';
    };

    const setInput = (id: string, value: string | null | undefined) => {
      if (!value) return;
      const el = document.getElementById(id) as HTMLInputElement | null;
      if (el) el.value = value;
    };

    setInput('inlineDescription', file.bext_description);
    setInput('inlineOriginator', file.bext_originator);
    setInput('inlineDate', file.bext_date);
    setInput('inlineTime', file.bext_time);

    const scene = getTag('SCENE');
    const take = getTag('TAKE');
    const tape = getTag('TAPE');
    const note = getTag('NOTE');
    if (scene) setInput('inlineScene', scene);
    if (take) setInput('inlineTake', take);
    if (tape) setInput('inlineTape', tape);
    if (note) setInput('inlineNote', note);

    // Update sessionMetadata to stay in sync
    this.sessionMetadata = this.gatherInlineMetadata();
  }

  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
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

  /**
   * Build per-channel name text inputs in the BWF inline tab.
   * Called when tracks are loaded or track count changes.
   */
  private buildInlineTrackNames(): void {
    const container = document.getElementById('inlineTrackNamesContainer');
    if (!container) return;

    const tracks = this.timelineModel.timeline.tracks;

    // Preserve existing values before rebuilding
    const existing: string[] = Array.from(
      container.querySelectorAll('input[data-track-idx]'),
    ).map(el => (el as HTMLInputElement).value);

    container.innerHTML = '';

    // When no tracks are loaded yet, show 2 default stereo inputs so users
    // can pre-fill channel names before loading audio.
    const count = tracks.length > 0 ? tracks.length : 2;
    const channelNames = CHANNEL_NAMES[count] ||
      Array.from({ length: count }, (_, i) => `Ch ${i + 1}`);

    for (let i = 0; i < count; i++) {
      const row = document.createElement('div');
      row.className = 'metadata-inline-field';

      const label = document.createElement('label');
      label.textContent = channelNames[i] ?? `Ch ${i + 1}`;

      const input = document.createElement('input');
      input.type = 'text';
      input.placeholder = channelNames[i] ?? `Ch ${i + 1}`;
      input.dataset.trackIdx = String(i);
      // Use preserved value, then track name (if track exists), then empty
      const trackName = tracks[i]?.name ?? '';
      input.value = existing[i] ?? trackName;
      input.addEventListener('input', () => {
        // Keep sessionMetadata.trackNames in sync
        if (!this.sessionMetadata.trackNames) this.sessionMetadata.trackNames = [];
        this.sessionMetadata.trackNames[i] = input.value;
      });

      row.appendChild(label);
      row.appendChild(input);
      container.appendChild(row);
    }
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
      exportActionBtn.addEventListener('click', () => {
        this.showExportModal();
      });
    }

    // Auto-fill export filename from UCS fields
    for (const id of ['inlineCatId', 'inlineFxName', 'inlineCreatorId']) {
      const el = document.getElementById(id);
      if (el) {
        el.addEventListener('input', () => {
          this.filenameLocked = false;
          this.updateExportFilename();
        });
      }
    }

    // Manual edit of filename locks auto-fill
    const filenameEl = document.getElementById('exportFilename');
    if (filenameEl) {
      filenameEl.addEventListener('input', () => {
        this.filenameLocked = true;
      });
    }
  }

  private updateExportFilename(): void {
    if (this.filenameLocked) return;
    const catId = (document.getElementById('inlineCatId') as HTMLInputElement)?.value || '';
    const fxName = (document.getElementById('inlineFxName') as HTMLInputElement)?.value || '';
    const creatorId = (document.getElementById('inlineCreatorId') as HTMLInputElement)?.value || '';

    let name = [catId, fxName, creatorId].filter(Boolean).join('_');
    if (!name) name = this.fileName?.replace(/\.[^/.]+$/, '') || 'audio';

    const el = document.getElementById('exportFilename') as HTMLInputElement;
    if (el) el.value = name;
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
      const filenameEl = document.getElementById('exportFilename') as HTMLInputElement | null;
      let baseName = filenameEl?.value || '';

      // Strip any extension the user may have typed
      baseName = baseName.replace(/\.[^/.]+$/, '');
      if (!baseName) baseName = this.fileName?.replace(/\.[^/.]+$/, '') || 'audio';

      // Gather inline metadata for quick export
      const exportMeta = this.gatherInlineMetadata();
      const chans: Float32Array[] = [];
      for (let c = 0; c < buffer.numberOfChannels; c++) {
        chans.push(buffer.getChannelData(c));
      }
      // Async encoding — yields to main thread to keep UI responsive
      const wavBytes = await encodeWavAsync(
        { sampleRate: buffer.sampleRate, bitDepth: 24, channels: chans, dither: 'none', metadata: this.toWavMeta(exportMeta) },
        (progress) => { if (btn) btn.textContent = `Exporting ${Math.round(progress * 100)}%...`; },
      );
      const arrayBuf = wavBytes.buffer as ArrayBuffer;
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

    // Gather per-channel names from inline track name inputs (if present),
    // falling back to timeline model track names.
    const container = document.getElementById('inlineTrackNamesContainer');
    const trackNameInputs = container
      ? Array.from(container.querySelectorAll('input[data-track-idx]'))
      : [];
    const trackNames: string[] = trackNameInputs.length > 0
      ? trackNameInputs.map(el => (el as HTMLInputElement).value)
      : this.timelineModel.timeline.tracks.map(t => t.name);

    return {
      bpiDescription: val('inlineDescription'),
      originator: val('inlineOriginator') || 'FieldCorder',
      originatorRef: '',
      date: val('inlineDate'),
      time: val('inlineTime'),
      project: '',
      scene: val('inlineScene'),
      take: val('inlineTake'),
      tape: val('inlineTape'),
      note: val('inlineNote'),
      circled: false,
      wildTrack: false,
      trackNames,
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

  /** Convert ExportMetadata to WavMetadata (renames bpiDescription -> description). */
  private toWavMeta(meta: ExportMetadata): WavMetadata {
    const { bpiDescription, ...rest } = meta;
    return { description: bpiDescription, ...rest };
  }

  async confirmNewProject(): Promise<void> {
    // Skip confirmation on initial startup (no tracks, no audio)
    const hasWork = this.timelineModel.timeline.tracks.length > 0 ||
      this.audioEngine.audioBuffer !== null;
    if (hasWork) {
      if (this._sessionDirty) {
        const choice = await this._showThreeWayDialog(
          'Save Changes?',
          'The current session has unsaved changes.',
          'Save', "Don't Save", 'Cancel',
        );
        if (choice === 'cancel') return;
        if (choice === 'save') await this.saveSession();
      } else {
        const confirmed = await this.showConfirmDialog(
          'Create New Project?',
          'Unsaved changes will be lost. Save your project first if needed.',
        );
        if (!confirmed) return;
      }
    }
    this._sessionFilePath = null;
    this._sessionDirty = false;
    this.updateTitleBar();
    this.newBlankProject();
  }

  // ==================== Session Dirty State ====================

  private markDirty(): void {
    this._sessionDirty = true;
    this.updateTitleBar();
  }

  private markClean(): void {
    this._sessionDirty = false;
    this.updateTitleBar();
  }

  private updateTitleBar(): void {
    const name = this._sessionFilePath
      ? this._sessionFilePath.split('/').pop()!.replace(/\.fcs$/i, '')
      : 'Untitled';
    const dirty = this._sessionDirty ? ' *' : '';
    document.title = `${name}${dirty} — FieldCorder`;
  }

  // ==================== Session Save ====================

  async saveSession(): Promise<void> {
    if (!this._sessionFilePath) {
      await this.saveSessionAs();
      return;
    }
    await this._writeSession(this._sessionFilePath);
  }

  async saveSessionAs(): Promise<void> {
    if (!window.appAPI) return;
    const path = await window.appAPI.showSaveDialog({
      title: 'Save Session',
      filters: [{ name: 'FieldCorder Session', extensions: ['fcs'] }],
    });
    if (!path) return;
    await this._writeSession(path);
  }

  private async _writeSession(path: string): Promise<void> {
    const sessionData = serializeSession(
      this.timelineModel.timeline,
      this._buildBufferSourceMap(),
      path,
      this._getSessionMetadata(),
      this.folderPath,
    );
    const json = JSON.stringify(sessionData, null, 2);
    await window.appAPI!.writeFileText(path, json);
    this._sessionFilePath = path;
    this.markClean();
  }

  private _buildBufferSourceMap(): Map<string, { fileName: string; channelIndex: number }> {
    const map = new Map<string, { fileName: string; channelIndex: number }>();
    for (const [id, pooled] of this.bufferPool.entries()) {
      map.set(id, {
        fileName: pooled.sourceFileName,
        channelIndex: pooled.sourceChannelIndex,
      });
    }
    return map;
  }

  private _getSessionMetadata(): Record<string, unknown> {
    const meta = this.gatherInlineMetadata();
    return meta as unknown as Record<string, unknown>;
  }

  // ==================== Session Load ====================

  async openSession(): Promise<void> {
    if (this._sessionDirty) {
      const choice = await this._showThreeWayDialog(
        'Save Changes?',
        'The current session has unsaved changes.',
        'Save', "Don't Save", 'Cancel',
      );
      if (choice === 'cancel') return;
      if (choice === 'save') await this.saveSession();
    }

    if (!window.appAPI) return;
    const paths = await window.appAPI.showOpenDialog({
      title: 'Open Session',
      filters: [{ name: 'FieldCorder Session', extensions: ['fcs'] }],
      multiple: false,
    });
    if (!paths || paths.length === 0) return;
    await this._loadSession(paths[0]);
  }

  private async _loadSession(path: string): Promise<void> {
    try {
      const json = await window.appAPI!.readFileText(path);
      const sessionData: SessionData = JSON.parse(json) as SessionData;

      // Validate
      if (sessionData.version !== 1 || sessionData.app !== 'FieldCorder') {
        alert('Invalid session file.');
        return;
      }

      // Deserialize to timeline skeleton with placeholder bufferIds
      const { timeline, metadata, fileBrowserPath, audioFilesToLoad } = deserializeSession(sessionData);

      // Clear current state (reset everything)
      this.newBlankProject();

      // Load audio files and build placeholder → real bufferId mapping
      const bufferIdMapping = new Map<string, string>();

      for (const af of audioFilesToLoad) {
        // Try relative path first (resolved against session file location)
        const resolvedRelative = resolveAbsolutePath(path, af.relativePath);
        let loaded = false;

        try {
          const bufferIds = await this._loadAudioFileToPool(resolvedRelative, af.channels);
          this._mapPlaceholderBufferIds(af.id, bufferIds, bufferIdMapping);
          loaded = true;
        } catch {
          // Try absolute path as fallback
          try {
            const bufferIds = await this._loadAudioFileToPool(af.absolutePath, af.channels);
            this._mapPlaceholderBufferIds(af.id, bufferIds, bufferIdMapping);
            loaded = true;
          } catch {
            // Both paths failed — prompt user to locate
          }
        }

        if (!loaded && window.appAPI) {
          const newPaths = await window.appAPI.showOpenDialog({
            title: `Locate missing file: ${af.relativePath.split('/').pop() ?? af.relativePath}`,
            filters: [{ name: 'Audio Files', extensions: ['wav', 'aif', 'aiff', 'mp3'] }],
            multiple: false,
          });
          if (newPaths && newPaths.length > 0) {
            try {
              const bufferIds = await this._loadAudioFileToPool(newPaths[0], af.channels);
              this._mapPlaceholderBufferIds(af.id, bufferIds, bufferIdMapping);
            } catch (err) {
              console.error('[Session] Could not load relocated file:', err);
            }
          }
        }
      }

      // Replace placeholder bufferIds with real pool IDs
      for (const track of timeline.tracks) {
        for (const clip of track.clips) {
          clip.bufferIds = clip.bufferIds.map(placeholder => bufferIdMapping.get(placeholder) ?? placeholder);
        }
      }

      // Apply the deserialized timeline
      this.timelineModel.timeline = timeline;

      // Restore metadata into inline fields
      this._applySessionMetadata(metadata);

      // Restore file browser path
      if (fileBrowserPath) {
        this.folderPath = fileBrowserPath;
        const pathEl = document.getElementById('folderPath');
        if (pathEl) {
          pathEl.textContent = fileBrowserPath.split('/').pop() || fileBrowserPath;
          pathEl.title = fileBrowserPath;
        }
      }

      // Rebuild audio routing and mixer
      await this.audioEngine.init();
      this.audioEngine.setupTrackRouting(timeline.tracks);
      this.mixer.setupTracks(timeline.tracks);

      // Feed timeline to renderer
      if (this.timelineRenderer) {
        this.timelineRenderer.setTimeline(this.timelineModel.timeline, this.bufferPool);
        this.timelineRenderer.zoomFit();
      }

      // Update session state
      this._sessionFilePath = path;
      this.timelineUndoManager.clear();
      this.markClean();

      this.buildInlineTrackNames();
      this.updateUI();
      this.updateFileInfo();
    } catch (err) {
      console.error('[Session] Load error:', err);
      const msg = err instanceof Error ? err.message : String(err);
      alert('Error loading session: ' + msg);
    }
  }

  /**
   * Load a single audio file into the buffer pool.
   * Returns the array of buffer IDs (one per channel).
   */
  private async _loadAudioFileToPool(filePath: string, _expectedChannels: number): Promise<string[]> {
    const name = filePath.split('/').pop() || 'audio';

    await this.audioEngine.init();
    const result = await FileHandler.importFilePath(filePath);

    let bufferIds: string[];
    if (result instanceof ArrayBuffer) {
      // Non-WAV: decode via Web Audio
      const audioBuffer = await this.audioEngine.loadAudio(result);
      bufferIds = this.bufferPool.importMultiChannel(audioBuffer, name);
    } else {
      // WAV: raw PCM from Rust parser
      bufferIds = this.bufferPool.importFromRawChannels(
        result.samples, result.channels, result.num_samples, result.sample_rate, name,
      );
    }

    // Ensure helpers exist for subsequent plugin/audio use
    if (!this.audioEditor) {
      this.audioEditor = new AudioEditor(this.audioEngine.audioContext!);
    }
    if (!this.pluginHost) {
      this.pluginHost = new PluginHost(this.audioEngine.audioContext!);
      this.mixer.pluginHost = this.pluginHost;
      this.pluginParameterPanel.setPluginHost(this.pluginHost);
    }

    return bufferIds;
  }

  private _mapPlaceholderBufferIds(
    audioFileId: string,
    realBufferIds: string[],
    mapping: Map<string, string>,
  ): void {
    for (let ch = 0; ch < realBufferIds.length; ch++) {
      mapping.set(`${audioFileId}:${ch}`, realBufferIds[ch]);
    }
  }

  private _applySessionMetadata(metadata: Record<string, unknown>): void {
    // Apply metadata fields back to inline sidebar inputs
    const setField = (id: string, value: unknown) => {
      if (typeof value !== 'string') return;
      const el = document.getElementById(id) as HTMLInputElement | null;
      if (el) el.value = value;
    };
    setField('inlineDescription', metadata['bpiDescription']);
    setField('inlineOriginator', metadata['originator']);
    setField('inlineDate', metadata['date']);
    setField('inlineTime', metadata['time']);
    setField('inlineScene', metadata['scene']);
    setField('inlineTake', metadata['take']);
    setField('inlineTape', metadata['tape']);
    setField('inlineNote', metadata['note']);
  }

  // ==================== Three-Way Dialog ====================

  /**
   * Show a 3-option dialog (Save / Don't Save / Cancel).
   * Returns 'save', 'nosave', or 'cancel'.
   */
  private async _showThreeWayDialog(
    title: string,
    message: string,
    saveLabel: string,
    noSaveLabel: string,
    cancelLabel: string,
  ): Promise<'save' | 'nosave' | 'cancel'> {
    // Build a simple modal since Tauri dialog API doesn't support 3-way
    return new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:9999';

      const dialog = document.createElement('div');
      dialog.style.cssText = 'background:#2d2d2d;border-radius:8px;padding:24px;min-width:320px;max-width:400px;color:#fff;font-family:-apple-system,BlinkMacSystemFont,sans-serif;box-shadow:0 16px 48px rgba(0,0,0,0.6)';

      const titleEl = document.createElement('div');
      titleEl.textContent = title;
      titleEl.style.cssText = 'font-size:15px;font-weight:600;margin-bottom:8px';

      const msgEl = document.createElement('div');
      msgEl.textContent = message;
      msgEl.style.cssText = 'font-size:13px;color:#aaa;margin-bottom:20px;line-height:1.4';

      const btnRow = document.createElement('div');
      btnRow.style.cssText = 'display:flex;gap:8px;justify-content:flex-end';

      const makeBtn = (label: string, primary: boolean) => {
        const btn = document.createElement('button');
        btn.textContent = label;
        btn.style.cssText = `height:28px;padding:0 14px;border-radius:4px;border:1px solid rgba(255,255,255,0.15);cursor:pointer;font-size:12px;font-weight:${primary ? '600' : '400'};background:${primary ? '#2563eb' : 'transparent'};color:${primary ? '#fff' : '#ccc'}`;
        return btn;
      };

      const cancelBtn = makeBtn(cancelLabel, false);
      const noSaveBtn = makeBtn(noSaveLabel, false);
      const saveBtn = makeBtn(saveLabel, true);

      const cleanup = (result: 'save' | 'nosave' | 'cancel') => {
        overlay.remove();
        resolve(result);
      };

      cancelBtn.addEventListener('click', () => cleanup('cancel'));
      noSaveBtn.addEventListener('click', () => cleanup('nosave'));
      saveBtn.addEventListener('click', () => cleanup('save'));

      btnRow.appendChild(cancelBtn);
      btnRow.appendChild(noSaveBtn);
      btnRow.appendChild(saveBtn);

      dialog.appendChild(titleEl);
      dialog.appendChild(msgEl);
      dialog.appendChild(btnRow);
      overlay.appendChild(dialog);
      document.body.appendChild(overlay);
    });
  }

  private showConfirmDialog(title: string, message: string): Promise<boolean> {
    return new Promise(resolve => {
      // Use native confirm dialog via Tauri if available, otherwise browser confirm
      if (window.appAPI?.showConfirmDialog) {
        window.appAPI.showConfirmDialog(title, message).then(resolve);
      } else {
        resolve(window.confirm(`${title}\n\n${message}`));
      }
    });
  }

  newBlankProject(): void {
    this.audioEngine.stop();
    this.audioEngine.stopTimeline();
    this.audioEngine.audioBuffer = null;
    this.bufferPool.clear();
    this.timelineModel.createTimeline(48000);
    this.timelineUndoManager.clear();
    this.metadataPreFilled = false;
    this.sessionMetadata = createDefaultExportMetadata();
    this.waveformRenderer.disabled = true;
    this.waveformRenderer.detachListeners();
    if (this.timelineRenderer) {
      this.timelineRenderer.setTimeline(this.timelineModel.timeline, this.bufferPool);
      this.timelineRenderer.render();
    }
    this.mixer.setupTracks([]);
    this.audioEngine.cleanupTrackNodes();
    this.fileName = null;
    this.originalBitDepth = null;
    this.buildInlineTrackNames();
    this.updateUI();
    this.updateFileInfo();
    this.updatePositionInfo(0);
  }

  addEmptyTrack(channels: TrackChannelCount = 1): void {
    if (!this.timelineModel.timeline) return;
    this.timelineModel.addEmptyTrack(channels);
    this.audioEngine.setupTrackRouting(this.timelineModel.timeline.tracks);
    this.mixer.setupTracks(this.timelineModel.timeline.tracks);
    this.timelineRenderer?.render();
  }

  private showCreateTrackDialog(): void {
    // Remove any existing dialog
    document.getElementById('createTrackDialog')?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'createTrackDialog';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:1000';

    const dialog = document.createElement('div');
    dialog.style.cssText = 'background:#2d2d2d;border-radius:8px;padding:20px;min-width:280px;color:#fff;font-family:-apple-system,BlinkMacSystemFont,sans-serif;box-shadow:0 8px 32px rgba(0,0,0,0.5)';

    const title = document.createElement('div');
    title.textContent = 'New Track';
    title.style.cssText = 'font-size:15px;font-weight:600;margin-bottom:16px';
    dialog.appendChild(title);

    // Name input
    const nameLabel = document.createElement('label');
    nameLabel.textContent = 'Name';
    nameLabel.style.cssText = 'display:block;font-size:11px;color:#aaa;margin-bottom:4px';
    dialog.appendChild(nameLabel);

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    const nextIdx = this.timelineModel.timeline.tracks.length + 1;
    nameInput.value = `Track ${nextIdx}`;
    nameInput.style.cssText = 'width:100%;box-sizing:border-box;height:24px;border-radius:4px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.08);color:#fff;padding:0 8px;font-size:13px;margin-bottom:12px;outline:none';
    dialog.appendChild(nameInput);

    // Type select
    const typeLabel = document.createElement('label');
    typeLabel.textContent = 'Type';
    typeLabel.style.cssText = 'display:block;font-size:11px;color:#aaa;margin-bottom:4px';
    dialog.appendChild(typeLabel);

    const typeSelect = document.createElement('select');
    typeSelect.style.cssText = 'width:100%;height:24px;border-radius:4px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.08);color:#fff;font-size:13px;margin-bottom:20px;outline:none';
    const options: [string, TrackChannelCount][] = [
      ['Mono', 1], ['Stereo', 2], ['Quad (4.0)', 4], ['5.0 Surround', 5], ['5.1 Surround', 6],
    ];
    for (const [label, value] of options) {
      const opt = document.createElement('option');
      opt.value = String(value);
      opt.textContent = label;
      typeSelect.appendChild(opt);
    }
    dialog.appendChild(typeSelect);

    // Buttons
    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:8px;justify-content:flex-end';

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.style.cssText = 'height:24px;padding:0 12px;border-radius:4px;border:1px solid rgba(255,255,255,0.15);background:transparent;color:#ccc;cursor:pointer;font-size:12px';

    const createBtn = document.createElement('button');
    createBtn.textContent = 'Create';
    createBtn.style.cssText = 'height:24px;padding:0 12px;border-radius:4px;border:none;background:#2563eb;color:#fff;cursor:pointer;font-size:12px;font-weight:500';

    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(createBtn);
    dialog.appendChild(btnRow);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    // Focus name input and select all text
    nameInput.focus();
    nameInput.select();

    const close = () => overlay.remove();

    const doCreate = () => {
      const channels = Number(typeSelect.value) as TrackChannelCount;
      const name = nameInput.value.trim() || `Track ${nextIdx}`;

      // Use addTrack directly for custom name
      const idx = this.timelineModel.timeline.tracks.length;
      this.timelineModel.addTrack(name, CHANNEL_COLORS[idx % CHANNEL_COLORS.length], idx, channels);
      this.audioEngine.setupTrackRouting(this.timelineModel.timeline.tracks);
      this.mixer.setupTracks(this.timelineModel.timeline.tracks);
      this.timelineRenderer?.render();
      close();
    };

    cancelBtn.addEventListener('click', close);
    createBtn.addEventListener('click', doCreate);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doCreate();
      if (e.key === 'Escape') close();
    });
    typeSelect.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') close();
    });
  }

  showNormalizeModal(): void { this.showModal('normalizeModal'); }
  showGainModal(): void { this.showModal('gainModal'); }

  showDenoiseModal(): void {
    // Reset progress
    document.getElementById('denoiseProgressRow')!.style.display = 'none';
    (document.getElementById('denoiseProgressFill') as HTMLElement).style.width = '0%';
    document.getElementById('denoiseProgressLabel')!.textContent = '0%';
    (document.getElementById('denoiseApplyBtn') as HTMLButtonElement).disabled = false;
    this.showModal('denoiseModal');
  }

  private initDenoiseSliders(): void {
    const presets: Record<string, [number, number, number]> = {
      gentle: [30, 10, 80],
      balanced: [50, 30, 30],
      aggressive: [85, 50, 0],
    };

    const presetSelect = document.getElementById('denoisePreset') as HTMLSelectElement;
    const denoiseSlider = document.getElementById('denoiseAmount') as HTMLInputElement;
    const dereverbSlider = document.getElementById('dereverbAmount') as HTMLInputElement;
    const drySlider = document.getElementById('drySoundAmount') as HTMLInputElement;
    const denoiseLabel = document.getElementById('denoiseAmountLabel')!;
    const dereverbLabel = document.getElementById('dereverbAmountLabel')!;
    const dryLabel = document.getElementById('drySoundAmountLabel')!;

    const updateLabels = () => {
      denoiseLabel.textContent = `${denoiseSlider.value}%`;
      dereverbLabel.textContent = `${dereverbSlider.value}%`;
      dryLabel.textContent = `${drySlider.value}%`;
    };

    presetSelect.addEventListener('change', () => {
      const vals = presets[presetSelect.value];
      if (vals) {
        denoiseSlider.value = String(vals[0]);
        dereverbSlider.value = String(vals[1]);
        drySlider.value = String(vals[2]);
        updateLabels();
      }
    });

    const onSliderChange = () => {
      updateLabels();
      // Check if current values match a preset, otherwise set to Custom
      const d = parseInt(denoiseSlider.value);
      const r = parseInt(dereverbSlider.value);
      const dry = parseInt(drySlider.value);
      let matched = 'custom';
      for (const [name, vals] of Object.entries(presets)) {
        if (d === vals[0] && r === vals[1] && dry === vals[2]) { matched = name; break; }
      }
      presetSelect.value = matched;
    };

    denoiseSlider.addEventListener('input', onSliderChange);
    dereverbSlider.addEventListener('input', onSliderChange);
    drySlider.addEventListener('input', onSliderChange);
  }

  async applyDenoise(): Promise<void> {
    const denoise = parseInt((document.getElementById('denoiseAmount') as HTMLInputElement).value) / 100;
    const dereverb = parseInt((document.getElementById('dereverbAmount') as HTMLInputElement).value) / 100;
    const dry = parseInt((document.getElementById('drySoundAmount') as HTMLInputElement).value) / 100;
    const useGpu = (document.getElementById('denoiseUseGpu') as HTMLInputElement).checked;

    if (this.timelineModel.timeline.tracks.length === 0) {
      this.hideModal('denoiseModal');
      return;
    }

    const selected = this.timelineModel.timeline.selectedClipIds;
    if (selected.length === 0) { this.hideModal('denoiseModal'); return; }

    // Show progress
    const progressRow = document.getElementById('denoiseProgressRow')!;
    const progressFill = document.getElementById('denoiseProgressFill') as HTMLElement;
    const progressLabel = document.getElementById('denoiseProgressLabel')!;
    const applyBtn = document.getElementById('denoiseApplyBtn') as HTMLButtonElement;
    progressRow.style.display = 'block';
    applyBtn.disabled = true;

    // Count total clips for unified progress
    let totalClips = 0;
    for (const track of this.timelineModel.timeline.tracks) {
      for (const clip of track.clips) {
        if (selected.includes(clip.id) && this.bufferPool.getBuffer(clip.bufferIds[0])) {
          totalClips++;
        }
      }
    }
    let completedClips = 0;

    // Listen for progress events from Rust
    const { listen } = await import('@tauri-apps/api/event');
    const unlisten = await listen<number>('denoise:progress', (e) => {
      const clipPct = Math.round(e.payload);
      const overallPct = Math.round(((completedClips + clipPct / 100) / totalClips) * 100);
      progressFill.style.width = `${overallPct}%`;
      progressLabel.textContent = `${overallPct}% (${completedClips + 1}/${totalClips})`;
    });

    try {
      for (const track of this.timelineModel.timeline.tracks) {
        for (const clip of track.clips) {
          if (!selected.includes(clip.id)) continue;
          const pooled = this.bufferPool.getBuffer(clip.bufferIds[0]);
          if (!pooled) continue;

          const srcData = pooled.buffer.getChannelData(0);
          const sampleRate = pooled.buffer.sampleRate;
          const numSamples = srcData.length;

          // Call Rust backend
          const resultBuf = await window.appAPI!.denoiseDeepFilter(
            srcData,
            { denoise, dereverb, dry, sample_rate: sampleRate, num_samples: numSamples, use_gpu: useGpu },
          );

          // Parse response (same format as readLargeAudioFile)
          const header = new DataView(resultBuf, 0, 16);
          const outSampleRate = header.getUint32(0, true);
          const outNumSamples = Number(header.getBigUint64(8, true));
          const outSamples = new Float32Array(resultBuf, 16);

          // Create new AudioBuffer in pool
          const ctx = new OfflineAudioContext(1, outNumSamples, outSampleRate);
          const newBuffer = ctx.createBuffer(1, outNumSamples, outSampleRate);
          newBuffer.copyToChannel(outSamples, 0);
          const newBufferId = this.bufferPool.addBuffer(
            newBuffer, pooled.sourceFileName + ' [denoised]', pooled.sourceChannelIndex,
          );

          // Swap buffer + push undo (only handles single-channel clips for now)
          const originalBufferId = clip.bufferIds[0];
          clip.bufferIds = [newBufferId];
          this.timelineUndoManager.pushExecuted(
            new DenoiseClipCommand(this.timelineModel, track.id, clip.id, originalBufferId, newBufferId),
          );
          completedClips++;
        }
      }
      this.invalidatePlayback();
      this.timelineRenderer?.clearPeakCaches();
      this.timelineRenderer?.render();
      this.hideModal('denoiseModal');
    } catch (err) {
      console.error('[Denoise] Error:', err);
      progressLabel.textContent = err instanceof Error ? err.message : String(err);
      progressFill.style.width = '0%';
    } finally {
      applyBtn.disabled = false;
      unlisten();
    }
  }

  showModal(id: string): void {
    document.getElementById(id)?.classList.add('visible');
  }

  hideModal(id: string): void {
    document.getElementById(id)?.classList.remove('visible');
  }

  onExportFormatChange(): void {
    const format = (document.getElementById('exportFormat') as HTMLSelectElement).value;
    const isMp3 = format === 'mp3';
    const bitDepthRow = document.getElementById('exportBitDepthRow');
    const ditherRow = document.getElementById('exportDitherRow');
    const bitrateRow = document.getElementById('exportBitrateRow');
    if (bitDepthRow) bitDepthRow.style.display = isMp3 ? 'none' : '';
    if (ditherRow) ditherRow.style.display = isMp3 ? 'none' : '';
    if (bitrateRow) bitrateRow.style.display = isMp3 ? '' : 'none';
  }

  async exportFile(): Promise<void> {
    const format = (document.getElementById('exportFormat') as HTMLSelectElement).value;
    const bitDepth = parseInt((document.getElementById('exportBitDepth') as HTMLSelectElement).value);
    const bitrate = parseInt((document.getElementById('exportBitrate') as HTMLSelectElement).value) as 128 | 192 | 256 | 320;
    const dither = (document.getElementById('exportDither') as HTMLSelectElement).value;
    const exportSelection = (document.getElementById('exportSelection') as HTMLInputElement).checked;

    const confirmBtn = document.getElementById('exportConfirmBtn') as HTMLButtonElement | null;
    if (confirmBtn) {
      confirmBtn.disabled = true;
      confirmBtn.textContent = 'Exporting...';
    }

    try {
      let fileNameSuffix = '';

      // Render timeline edits (clips, gain, fades, mute/solo) into raw channels
      const rendered = await renderTimelineOffline(this.timelineModel.timeline, this.bufferPool, this.pluginHost ?? undefined);
      const exportSampleRate = rendered.channels.length > 0
        ? rendered.sampleRate
        : (this.audioEngine.audioBuffer?.sampleRate ?? this.timelineModel.timeline.sampleRate);

      let chans: Float32Array[];

      if (rendered.channels.length > 0) {
        chans = rendered.channels;
      } else if (this.audioEngine.audioBuffer) {
        // Fallback: no timeline clips — export the raw loaded buffer
        chans = [];
        for (let c = 0; c < this.audioEngine.audioBuffer.numberOfChannels; c++) {
          chans.push(this.audioEngine.audioBuffer.getChannelData(c));
        }
      } else {
        throw new Error('No audio to export');
      }

      if (exportSelection && this.waveformRenderer.hasSelection()) {
        const selection = this.waveformRenderer.getSelection()!;
        // Trim rendered channels to selection range
        chans = chans.map(ch => ch.slice(selection.start, selection.end));
        fileNameSuffix = '_selection';
      }

      const exportMeta = this.pendingExportMetadata || undefined;

      let blob: Blob;
      let extension: string;

      if (format === 'wav') {
        const wavMeta = exportMeta ? this.toWavMeta(exportMeta) : undefined;
        const wavBytes = await encodeWavAsync(
          { sampleRate: exportSampleRate, bitDepth: bitDepth as 16 | 24 | 32, channels: chans, dither: dither as 'none' | 'tpdf' | 'shaped', metadata: wavMeta },
          (progress) => { if (confirmBtn) confirmBtn.textContent = `Exporting ${Math.round(progress * 100)}%...`; },
        );
        blob = new Blob([wavBytes.buffer as ArrayBuffer], { type: 'audio/wav' });
        extension = '.wav';
      } else if (format === 'mp3') {
        const mp3Meta: Mp3Metadata | undefined = exportMeta ? {
          title: exportMeta.bpiDescription || undefined,
          artist: exportMeta.originator || undefined,
          comment: exportMeta.note || undefined,
          date: undefined,
        } : undefined;
        const mp3Bytes = await encodeMp3Async(
          { sampleRate: exportSampleRate, channels: chans, bitrate, metadata: mp3Meta },
          (progress) => { if (confirmBtn) confirmBtn.textContent = `Exporting ${Math.round(progress * 100)}%...`; },
        );
        blob = new Blob([mp3Bytes.buffer as ArrayBuffer], { type: 'audio/mpeg' });
        extension = '.mp3';
      } else {
        // AIF export — yield first so button text updates
        if (confirmBtn) confirmBtn.textContent = 'Exporting...';
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        const aifBitDepth = bitDepth === 32 ? 24 : bitDepth;
        // FileHandler.exportAIF expects an AudioBuffer, so build one from rendered channels
        const aifBuffer = this.audioEngine.audioContext!.createBuffer(
          chans.length, chans[0].length, exportSampleRate,
        );
        for (let c = 0; c < chans.length; c++) {
          aifBuffer.copyToChannel(chans[c] as Float32Array<ArrayBuffer>, c);
        }
        blob = FileHandler.exportAIF(aifBuffer, aifBitDepth, dither);
        extension = '.aif';
      }

      // Use sidebar exportFilename if filled, else UCS filename, else original filename
      const sidebarFilename = (document.getElementById('exportFilename') as HTMLInputElement)?.value?.replace(/\.[^/.]+$/, '') || '';
      let baseName: string;
      if (sidebarFilename) {
        baseName = sidebarFilename;
      } else if (this.pendingUCSFilename) {
        baseName = this.pendingUCSFilename;
      } else {
        baseName = this.fileName ? this.fileName.replace(/\.[^/.]+$/, '') : 'audio';
      }

      const defaultName = baseName + fileNameSuffix + extension;

      if (window.appAPI) {
        // Check if sidebar already has a preselected export folder
        const preselectedFolder = document.getElementById('exportPath')?.dataset?.fullPath;
        let savePath: string | null = null;

        if (preselectedFolder) {
          // Direct export to preselected folder without Finder dialog
          savePath = `${preselectedFolder}/${defaultName}`;
        } else {
          // Show native save dialog
          savePath = await window.appAPI.showSaveDialog({
            title: 'Export Audio',
            defaultPath: defaultName,
            filters: [{ name: format === 'wav' ? 'WAV Audio' : format === 'mp3' ? 'MP3 Audio' : 'AIFF Audio', extensions: [format === 'wav' ? 'wav' : format === 'mp3' ? 'mp3' : 'aif'] }],
          });
        }
        if (savePath) {
          if (confirmBtn) confirmBtn.textContent = 'Writing...';
          const arrayBuf = await blob.arrayBuffer();
          await window.appAPI.writeFile(savePath, arrayBuf);
          console.log(`[Export] Written to ${savePath}`);

          // Mark file as done in browser if it matches
          const activeId = this.fileQueue.getActive();
          if (activeId !== null) {
            const activeFile = this.fileQueue.getFile(activeId);
            if (activeFile && 'path' in activeFile) {
              this.fileStatuses.set((activeFile as { path: string }).path, 'done');
              this.renderFileBrowser();
            }
          }
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
    const hasTimeline = this.timelineModel.timeline.tracks.length > 0;
    const hasSelection = this.waveformRenderer.hasSelection();
    const isPlaying = this.audioEngine.isPlaying;

    const setDisabled = (id: string, disabled: boolean) => {
      const el = document.getElementById(id);
      if (el) (el as HTMLButtonElement).disabled = disabled;
    };

    setDisabled('exportBtn', !hasAudio);
    setDisabled('saveProjectBtn', !hasAudio);
    setDisabled('addCueBtn', !hasAudio);
    setDisabled('playBtn', !hasAudio && !hasTimeline);
    setDisabled('pauseBtn', !isPlaying);
    setDisabled('stopBtn', !hasAudio && !hasTimeline);
    setDisabled('loopBtn', !hasAudio);
    setDisabled('zoomInBtn', !hasAudio);
    setDisabled('zoomOutBtn', !hasAudio);
    setDisabled('zoomFitBtn', !hasAudio);
    const canUndo = this.timelineUndoManager.canUndo();
    const canRedo = this.timelineUndoManager.canRedo();
    setDisabled('undoBtn', !canUndo);
    setDisabled('redoBtn', !canRedo);
    setDisabled('trimBtn', !hasSelection);
    setDisabled('normalizeBtn', !hasAudio);
    setDisabled('fadeInBtn', !hasSelection);
    setDisabled('fadeOutBtn', !hasSelection);
    setDisabled('gainBtn', !hasAudio);
    setDisabled('reverseBtn', !hasAudio);
    setDisabled('denoiseBtn', !hasAudio);

    document.getElementById('playBtn')?.classList.toggle('playing', isPlaying);
  }

  updateFileInfo(): void {
    const buffer = this.audioEngine.audioBuffer;

    // Session sample rate in status bar
    const sessionSrEl = document.getElementById('sessionSampleRate');
    if (sessionSrEl) {
      const sessionRate = this.timelineModel.timeline.sampleRate;
      sessionSrEl.textContent = sessionRate > 0 ? formatSampleRate(sessionRate) : '';
    }

    // Status bar (bottom)
    const el = document.getElementById('fileInfo');
    if (el) {
      if (!buffer) {
        el.textContent = 'No file loaded';
      } else {
        const duration = formatTime(buffer.duration);
        const sampleRate = formatSampleRate(buffer.sampleRate);
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
    if (srEl) srEl.textContent = formatSampleRate(buffer.sampleRate);
    if (bdEl) {
      const bps = this.originalBitDepth;
      if (bps === 32 || bps === null) {
        bdEl.textContent = '32-bit float';
      } else {
        bdEl.textContent = `${bps}-bit`;
      }
    }
    if (durEl) durEl.textContent = formatTime(buffer.duration);
  }

  updatePositionInfo(time: number): void {
    const el = document.getElementById('positionInfo');
    if (el) el.textContent = formatTime(time);
  }

  updateZoomInfo(): void {
    const spp = this.timelineRenderer
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
