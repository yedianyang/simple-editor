import { Timeline, Track, Clip, CHANNEL_COLORS, formatTime } from '../core/types';
import { BufferPool } from '../core/BufferPool';
import { CuePointManager } from './CuePointManager';

// ---- Layout constants ----
const TRACK_HEADER_WIDTH = 140;
const TRACK_HEIGHT = 80;
const RULER_HEIGHT = 24;
const TRIM_HANDLE_WIDTH = 5;
const CLIP_BORDER_RADIUS = 4;
const MUTE_SOLO_BTN_SIZE = 14;
const MUTE_SOLO_BTN_GAP = 2;

// ---- Insert rack constants ----
const INSERT_PILL_HEIGHT = 14;
const INSERT_PILL_GAP = 1;
const INSERT_PILL_X = 50;
const INSERT_PILL_WIDTH = 76;
const METER_X = 130;      // vertical meter strip X position
const METER_WIDTH = 6;    // meter strip width
const INSERT_ADD_HEIGHT = 12;
const MAX_INSERT_PILLS = 5;

// ---- Color constants ----
const COLOR_BG = '#1a1a1a';
const COLOR_HEADER_BG = '#222222';
const COLOR_TRACK_EVEN = '#1a1a1a';
const COLOR_TRACK_ODD = '#1e1e1e';
const COLOR_RULER_TEXT = '#888888';
const COLOR_PLAYHEAD = 'rgba(255, 255, 255, 0.85)';
const COLOR_PLAYHEAD_DIM = 'rgba(255, 255, 255, 0.3)';
const BLINK_INTERVAL_MS = 530;
const COLOR_SELECTED_BORDER = '#2563eb';
const COLOR_TRACK_BORDER = '#2a2a2a';

// ---- Peak cache block size ----
const PEAK_BLOCK_SIZE = 256;

// ---- Clip gain / fade / cue constants ----
const GAIN_HANDLE_SIZE = 8;
const FADE_ZONE_WIDTH = 10;
const CUE_FLAG_HEIGHT = 14;
const CUE_FLAG_WIDTH = 8;

type DragMode = 'none' | 'selection' | 'clipMove' | 'trimStart' | 'trimEnd' | 'marquee'
  | 'clipGain' | 'fadeIn' | 'fadeOut' | 'cuePoint' | 'trackResize';

interface DragState {
  mode: DragMode;
  clipId: string;
  trackId: string;
  /** Sample offset from the clip's timelineOffset to the initial mouse position. */
  grabOffsetSamples: number;
  /** Original value to compute deltas against (timelineOffset, sourceStart, or sourceEnd). */
  originalValue: number;
  startMouseX: number;
  startMouseY: number;
  /** Whether the mouse has moved > threshold since mousedown. */
  hasDragged: boolean;
  /** Whether shift was held at mousedown (for additive marquee). */
  shiftHeld: boolean;
  /** Original clip gain in dB at drag start (for clipGain mode). */
  originalGainDb?: number;
  /** Original fade-in samples at drag start (for fadeIn/fadeOut modes). */
  originalFadeIn?: number;
  /** Original fade-out samples at drag start (for fadeIn/fadeOut modes). */
  originalFadeOut?: number;
  /** Cue point ID being dragged (for cuePoint mode). */
  dragCuePointId?: number;
  /** Original cue point sample position at drag start. */
  originalCuePointSample?: number;
  /** Track index being resized (for trackResize mode). */
  resizeTrackIndex?: number;
  /** Original track height at drag start (for trackResize mode). */
  resizeOriginalHeight?: number;
}

interface ClipPeakEntry {
  bufferId: string;
  sourceStart: number;
  sourceEnd: number;
  samplesPerPixel: number;
  widthPx: number;
  /** Interleaved [min0, max0, min1, max1, ...]. */
  peaks: Float32Array;
}

/**
 * Multi-track timeline renderer for FieldCorder DAW.
 *
 * Renders track headers (left column), time ruler (top), clip waveforms
 * inside track lanes, and a white playhead line -- all on a single canvas.
 * Interactions are communicated to the host through callbacks.
 */
export class TimelineRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private width = 0;
  private height = 0;

  // ---- External data ----
  timeline: Timeline | null = null;
  bufferPool: BufferPool | null = null;

  // ---- View state ----
  samplesPerPixel = 256;
  scrollOffsetX = 0;  // horizontal scroll in samples
  scrollOffsetY = 0;  // vertical scroll in pixels

  // ---- Variable track height layout ----
  private trackTops: number[] = [];
  private totalTrackHeight = 0;

  private playheadSample = 0;

  // ---- Playback state (set by App.ts) ----
  isPlaying = false;
  private blinkTimer: ReturnType<typeof setInterval> | null = null;
  private blinkVisible = true;

  // ---- Time selection ----
  selectionStartSample: number | null = null;
  selectionEndSample: number | null = null;

  // ---- Peak caches ----
  /** Per-buffer peak cache at fixed PEAK_BLOCK_SIZE. bufferId -> Float32Array */
  private bufferPeakCaches = new Map<string, Float32Array>();
  /** Per-clip rendered peak cache, invalidated when zoom / trim changes. */
  private clipPeakCaches = new Map<string, ClipPeakEntry>();

  // ---- Drag state ----
  private drag: DragState = {
    mode: 'none',
    clipId: '',
    trackId: '',
    grabOffsetSamples: 0,
    originalValue: 0,
    startMouseX: 0,
    startMouseY: 0,
    hasDragged: false,
    shiftHeld: false,
  };

  /** Index of the track the clip is being dragged over (-1 = none). */
  private dropTargetTrackIndex = -1;

  // ---- Marquee selection state ----
  private marqueeStartX = 0;
  private marqueeStartY = 0;
  private marqueeEndX = 0;
  private marqueeEndY = 0;
  private marqueeOriginalClipIds: string[] = [];
  private marqueeOriginalTrackIds: string[] = [];

  /** External file drop target state (set during drag-over from file browser). */
  private externalDropTarget: { trackIndex: number; sampleOffset: number } | null = null;
  /** Number of channels in the file being dragged (set by App.ts on dragstart). */
  externalDragChannelCount = 1;

  /** Per-track meter levels in dB, updated externally from the animation loop. */
  trackMeterLevels: Map<string, number> = new Map();

  /** Cue point manager — set by App.ts to render cue markers on the ruler. */
  cuePointManager: CuePointManager | null = null;

  // ---- Callbacks ----
  onPlayheadChange: ((sample: number) => void) | null = null;
  onClipSelect: ((clipId: string, trackId: string) => void) | null = null;
  onClipMove: ((clipId: string, sourceTrackId: string, targetTrackId: string, newOffset: number) => void) | null = null;
  onClipTrim: ((clipId: string, trackId: string, edge: 'start' | 'end', newValue: number) => void) | null = null;
  onTrackMuteToggle: ((trackId: string) => void) | null = null;
  onTrackSoloToggle: ((trackId: string) => void) | null = null;
  onZoomChange: (() => void) | null = null;
  onScrollChange: (() => void) | null = null;

  onSelectionChange: (() => void) | null = null;
  onDragEnd: (() => void) | null = null;

  // Also expose split/delete for keyboard shortcuts
  onClipSplit: ((trackId: string, clipId: string, splitSample: number) => void) | null = null;
  onClipDelete: ((trackId: string, clipId: string) => void) | null = null;

  // Track selection callback
  onTrackSelect: ((trackIds: string[]) => void) | null = null;

  // Clip gain / fade callbacks
  onClipGainChange: ((clipId: string, trackId: string, gainDb: number) => void) | null = null;
  onClipFadeChange: ((clipId: string, trackId: string, edge: 'in' | 'out', samples: number) => void) | null = null;

  // Cue point callbacks
  onCuePointAdd: ((sample: number) => void) | null = null;
  onCuePointRemove: ((id: number) => void) | null = null;
  onCuePointMoveEnd: ((id: number, prevSample: number, newSample: number) => void) | null = null;

  // Track header context menu callback
  onTrackHeaderContextMenu: ((trackId: string, clientX: number, clientY: number) => void) | null = null;

  // Insert rack callbacks
  onInsertAdd: ((trackId: string) => void) | null = null;
  onInsertClick: ((trackId: string, instanceId: string, screenX: number, screenY: number) => void) | null = null;
  onInsertBypass: ((trackId: string, instanceId: string) => void) | null = null;
  onInsertRemove: ((trackId: string, instanceId: string) => void) | null = null;

  /** Called when a file is dropped from the file browser onto the timeline. */
  onExternalFileDrop: ((filePath: string, trackIndex: number, sampleOffset: number) => void) | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.setupResize();
    this.setupInteraction();
  }

  // ==================================================================
  // Public API
  // ==================================================================

  /** Call when playback starts/stops to toggle blink cursor. */
  setPlaybackState(playing: boolean): void {
    this.isPlaying = playing;
    if (playing) {
      this.stopBlink();
      this.blinkVisible = true;
    } else {
      this.startBlink();
    }
    this.render();
  }

  private startBlink(): void {
    if (this.blinkTimer) return;
    this.blinkVisible = true;
    this.blinkTimer = setInterval(() => {
      this.blinkVisible = !this.blinkVisible;
      this.render();
    }, BLINK_INTERVAL_MS);
  }

  private stopBlink(): void {
    if (this.blinkTimer) {
      clearInterval(this.blinkTimer);
      this.blinkTimer = null;
    }
    this.blinkVisible = true;
  }

  setTimeline(timeline: Timeline, bufferPool: BufferPool): void {
    this.timeline = timeline;
    this.bufferPool = bufferPool;
    this.bufferPeakCaches.clear();
    this.clipPeakCaches.clear();
    this.selectionStartSample = null;
    this.selectionEndSample = null;
    this.render();
  }

  /** Returns the normalized selection range, or null if no selection. */
  getSelection(): { start: number; end: number } | null {
    if (this.selectionStartSample === null || this.selectionEndSample === null) return null;
    return {
      start: Math.min(this.selectionStartSample, this.selectionEndSample),
      end: Math.max(this.selectionStartSample, this.selectionEndSample),
    };
  }

  setPlayheadPosition(sample: number): void {
    this.playheadSample = Math.max(0, sample);
    this.render();
  }

  resize(): void {
    const parent = this.canvas.parentElement;
    if (!parent) return;
    const rect = parent.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.width = rect.width;
    this.height = rect.height;
    this.canvas.width = Math.round(rect.width * dpr);
    this.canvas.height = Math.round(rect.height * dpr);
    this.canvas.style.width = rect.width + 'px';
    this.canvas.style.height = rect.height + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.render();
  }

  pixelToSample(x: number): number {
    const contentX = x - TRACK_HEADER_WIDTH;
    return Math.floor(this.scrollOffsetX + contentX * this.samplesPerPixel);
  }

  sampleToPixel(sample: number): number {
    return TRACK_HEADER_WIDTH + (sample - this.scrollOffsetX) / this.samplesPerPixel;
  }

  zoomFit(): void {
    if (!this.timeline || this.timeline.totalLength === 0) return;
    const contentWidth = this.width - TRACK_HEADER_WIDTH;
    if (contentWidth <= 0) return;
    this.samplesPerPixel = this.timeline.totalLength / contentWidth;
    this.scrollOffsetX = 0;
    this.clipPeakCaches.clear();
    this.render();
    if (this.onZoomChange) this.onZoomChange();
  }

  zoomIn(): void {
    this.samplesPerPixel = Math.max(1, this.samplesPerPixel * 0.5);
    this.clampScroll();
    this.clipPeakCaches.clear();
    this.render();
    if (this.onZoomChange) this.onZoomChange();
  }

  zoomOut(): void {
    const maxSPP = this.timeline ? this.timeline.totalLength / 100 : 100000;
    this.samplesPerPixel = Math.min(maxSPP, this.samplesPerPixel * 2);
    this.clampScroll();
    this.clipPeakCaches.clear();
    this.render();
    if (this.onZoomChange) this.onZoomChange();
  }

  /** Clear all cached peaks (call when buffers change). */
  clearPeakCaches(): void {
    this.bufferPeakCaches.clear();
    this.clipPeakCaches.clear();
  }

  destroy(): void {
    this.timeline = null;
    this.bufferPool = null;
    this.bufferPeakCaches.clear();
    this.clipPeakCaches.clear();
  }

  // ==================================================================
  // Resize
  // ==================================================================

  private setupResize(): void {
    const parent = this.canvas.parentElement;
    if (parent) {
      const observer = new ResizeObserver(() => this.resize());
      observer.observe(parent);
    }
    this.resize();
  }

  // ==================================================================
  // Scroll helpers
  // ==================================================================

  private get contentWidth(): number {
    return this.width - TRACK_HEADER_WIDTH;
  }

  private clampScroll(): void {
    if (!this.timeline) return;
    // Horizontal
    const maxScrollX = Math.max(0, this.timeline.totalLength - this.contentWidth * this.samplesPerPixel);
    this.scrollOffsetX = Math.max(0, Math.min(maxScrollX, this.scrollOffsetX));
    // Vertical
    const totalTrackHeight = this.totalTrackHeight;
    const visibleHeight = this.height - RULER_HEIGHT;
    const maxScrollY = Math.max(0, totalTrackHeight - visibleHeight);
    this.scrollOffsetY = Math.max(0, Math.min(maxScrollY, this.scrollOffsetY));
  }

  // ==================================================================
  // Variable track height layout
  // ==================================================================

  private recomputeTrackLayout(): void {
    if (!this.timeline) { this.trackTops = []; this.totalTrackHeight = 0; return; }
    this.trackTops = [];
    let y = 0;
    for (const track of this.timeline.tracks) {
      this.trackTops.push(y);
      y += track.height;
    }
    this.totalTrackHeight = y;
  }

  // ==================================================================
  // Interaction setup
  // ==================================================================

  private setupInteraction(): void {
    this.canvas.addEventListener('mousedown', (e) => this.onMouseDown(e));
    this.canvas.addEventListener('mousemove', (e) => this.onMouseMove(e));
    this.canvas.addEventListener('mouseup', () => this.onMouseUp());
    this.canvas.addEventListener('mouseleave', () => this.onMouseUp());
    this.canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.canvas.addEventListener('keydown', (e) => this.onKeyDown(e));
    this.canvas.addEventListener('contextmenu', (e) => this.onContextMenu(e));
    this.canvas.addEventListener('dragover', (e) => this.onCanvasDragOver(e));
    this.canvas.addEventListener('dragleave', () => this.onCanvasDragLeave());
    this.canvas.addEventListener('drop', (e) => this.onCanvasDrop(e));
    // Make canvas focusable for keyboard events
    this.canvas.tabIndex = 0;
  }

  private onContextMenu(e: MouseEvent): void {
    e.preventDefault();
    if (!this.timeline) return;
    const { x, y } = this.clientToLocal(e);
    // Only fire for track header area
    if (x >= TRACK_HEADER_WIDTH || y < RULER_HEIGHT) return;
    const trackIdx = this.yToTrackIndex(y);
    if (trackIdx < 0 || trackIdx >= this.timeline.tracks.length) return;
    const trackId = this.timeline.tracks[trackIdx].id;
    // Select the track if not already selected
    if (!this.timeline.selectedTrackIds.includes(trackId)) {
      this.timeline.selectedTrackIds = [trackId];
      this.onTrackSelect?.(this.timeline.selectedTrackIds);
      this.render();
    }
    this.onTrackHeaderContextMenu?.(trackId, e.clientX, e.clientY);
  }

  private onCanvasDragOver(e: DragEvent): void {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    const { x, y } = this.clientToLocal(e);
    const trackIndex = Math.max(0, this.yToTrackIndex(y));
    const sampleOffset = Math.max(0, this.pixelToSample(x));
    this.externalDropTarget = { trackIndex, sampleOffset };
    this.render();
  }

  private onCanvasDragLeave(): void {
    this.externalDropTarget = null;
    this.render();
  }

  private onCanvasDrop(e: DragEvent): void {
    e.preventDefault();
    const filePath = e.dataTransfer?.getData('application/x-fieldcorder-file') || '';
    // WKWebView may return empty from getData() — fall back to checking types
    const hasFieldcorderDrag = filePath || e.dataTransfer?.types.includes('application/x-fieldcorder-file');
    if (hasFieldcorderDrag && this.onExternalFileDrop) {
      const { x, y } = this.clientToLocal(e);
      const trackIndex = Math.max(0, this.yToTrackIndex(y));
      const sampleOffset = Math.max(0, this.pixelToSample(x));
      this.onExternalFileDrop(filePath, trackIndex, sampleOffset);
    }
    this.externalDropTarget = null;
    this.render();
  }

  private clientToLocal(e: MouseEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  // ==================================================================
  // Hit testing
  // ==================================================================

  /**
   * Given a canvas-local Y, return the track index (0-based).
   * Returns -1 if the coordinate is in the ruler area.
   */
  private yToTrackIndex(y: number): number {
    if (y < RULER_HEIGHT) return -1;
    const localY = y - RULER_HEIGHT + this.scrollOffsetY;
    for (let i = 0; i < this.trackTops.length; i++) {
      const top = this.trackTops[i];
      const h = this.timeline!.tracks[i].height;
      if (localY >= top && localY < top + h) return i;
    }
    return this.trackTops.length; // below all tracks
  }

  private yToSubChannel(y: number, trackIndex: number): number {
    if (!this.timeline || trackIndex < 0 || trackIndex >= this.timeline.tracks.length) return 0;
    const track = this.timeline.tracks[trackIndex];
    if (track.channels <= 1) return 0;
    const trackTopY = RULER_HEIGHT + this.trackTops[trackIndex] - this.scrollOffsetY;
    const relativeY = y - trackTopY;
    const laneHeight = track.height / track.channels;
    return Math.min(track.channels - 1, Math.max(0, Math.floor(relativeY / laneHeight)));
  }

  /**
   * Hit-test a clip at the given canvas-local coordinate.
   * Returns the clip, its track, and the interaction zone -- or null.
   */
  /**
   * Pro Tools-style "Smart Tool" hit test.
   *   - Clip edges → trim
   *   - Upper half of track → select (time selection)
   *   - Lower half of track → move (clip drag)
   */
  private hitTestClip(x: number, y: number): {
    clip: Clip; track: Track; zone: 'trimStart' | 'trimEnd' | 'select' | 'move' | 'clipGain' | 'fadeIn' | 'fadeOut';
  } | null {
    if (!this.timeline || x < TRACK_HEADER_WIDTH) return null;
    const trackIndex = this.yToTrackIndex(y);
    if (trackIndex < 0 || trackIndex >= this.timeline.tracks.length) return null;
    const track = this.timeline.tracks[trackIndex];

    for (const clip of track.clips) {
      const clipStartPx = this.sampleToPixel(clip.timelineOffset);
      const clipEndPx = this.sampleToPixel(clip.timelineOffset + clip.duration);

      if (x >= clipStartPx && x <= clipEndPx) {
        // Clip gain handle: bottom-left corner (highest priority in that region)
        const trackH = track.height;
        const trackTopY = RULER_HEIGHT + this.trackTops[trackIndex] - this.scrollOffsetY;
        const clipY = trackTopY + 4;
        const clipH = trackH - 8;
        const handleX = clipStartPx + 4;
        const handleY = clipY + clipH - GAIN_HANDLE_SIZE - 4;
        if (x >= handleX && x <= handleX + GAIN_HANDLE_SIZE + 4 &&
            y >= handleY - 2 && y <= handleY + GAIN_HANDLE_SIZE + 4) {
          return { clip, track, zone: 'clipGain' };
        }

        // Edges take priority regardless of Y (outermost 5px)
        if (x - clipStartPx <= TRIM_HANDLE_WIDTH) return { clip, track, zone: 'trimStart' };
        if (clipEndPx - x <= TRIM_HANDLE_WIDTH) return { clip, track, zone: 'trimEnd' };

        // Fade zones: when a fade exists, the handle is at the fade's edge;
        // when no fade, the handle is just inside the clip edge (after trim zone).
        const fadeInPx = clip.fadeInSamples > 0 ? clip.fadeInSamples / this.samplesPerPixel : 0;
        const fadeOutPx = clip.fadeOutSamples > 0 ? clip.fadeOutSamples / this.samplesPerPixel : 0;

        if (clip.fadeInSamples > 0) {
          // Handle at fade-in end edge
          const fadeEndPx = clipStartPx + fadeInPx;
          if (Math.abs(x - fadeEndPx) <= FADE_ZONE_WIDTH) {
            return { clip, track, zone: 'fadeIn' };
          }
        } else {
          // No fade yet: activation zone just inside left edge
          if (x - clipStartPx > TRIM_HANDLE_WIDTH && x - clipStartPx <= TRIM_HANDLE_WIDTH + FADE_ZONE_WIDTH) {
            return { clip, track, zone: 'fadeIn' };
          }
        }

        if (clip.fadeOutSamples > 0) {
          // Handle at fade-out start edge
          const fadeStartPx = clipEndPx - fadeOutPx;
          if (Math.abs(x - fadeStartPx) <= FADE_ZONE_WIDTH) {
            return { clip, track, zone: 'fadeOut' };
          }
        } else {
          // No fade yet: activation zone just inside right edge
          if (clipEndPx - x > TRIM_HANDLE_WIDTH && clipEndPx - x <= TRIM_HANDLE_WIDTH + FADE_ZONE_WIDTH) {
            return { clip, track, zone: 'fadeOut' };
          }
        }

        // Split body by Y: upper half = select, lower half = move
        const midY = trackTopY + trackH / 2;
        const zone = y < midY ? 'select' : 'move';
        return { clip, track, zone };
      }
    }
    return null;
  }

  /**
   * Hit-test the mute/solo buttons in a track header.
   * Returns the track id and which button was hit, or null.
   */
  private hitTestTrackButton(x: number, y: number): { trackId: string; button: 'mute' | 'solo' } | null {
    if (!this.timeline || x >= TRACK_HEADER_WIDTH) return null;
    const trackIndex = this.yToTrackIndex(y);
    if (trackIndex < 0 || trackIndex >= this.timeline.tracks.length) return null;
    const track = this.timeline.tracks[trackIndex];

    const trackTopY = RULER_HEIGHT + this.trackTops[trackIndex] - this.scrollOffsetY;
    const btnY = trackTopY + Math.min(60, track.height - MUTE_SOLO_BTN_SIZE - 4);
    const muteX = 6;
    const soloX = muteX + MUTE_SOLO_BTN_SIZE + MUTE_SOLO_BTN_GAP;

    if (y >= btnY && y <= btnY + MUTE_SOLO_BTN_SIZE && x < INSERT_PILL_X) {
      if (x >= muteX && x <= muteX + MUTE_SOLO_BTN_SIZE) {
        return { trackId: track.id, button: 'mute' };
      }
      if (x >= soloX && x <= soloX + MUTE_SOLO_BTN_SIZE) {
        return { trackId: track.id, button: 'solo' };
      }
    }
    return null;
  }

  /**
   * Hit-test the insert rack area in a track header.
   * Returns the action to take, or null.
   */
  private hitTestInsertRack(x: number, y: number): {
    trackId: string; action: 'add' | 'click' | 'bypass' | 'remove'; instanceId?: string;
  } | null {
    if (!this.timeline || x < INSERT_PILL_X || x >= INSERT_PILL_X + INSERT_PILL_WIDTH) return null;
    const trackIndex = this.yToTrackIndex(y);
    if (trackIndex < 0 || trackIndex >= this.timeline.tracks.length) return null;
    const track = this.timeline.tracks[trackIndex];

    const trackTopY = RULER_HEIGHT + this.trackTops[trackIndex] - this.scrollOffsetY;
    const rackStartY = trackTopY + 6;

    const visibleCount = Math.min(track.inserts.length, MAX_INSERT_PILLS);
    for (let i = 0; i < visibleCount; i++) {
      const pillY = rackStartY + i * (INSERT_PILL_HEIGHT + INSERT_PILL_GAP);
      if (y >= pillY && y <= pillY + INSERT_PILL_HEIGHT) {
        const insert = track.inserts[i];
        // Bypass zone: last 14px of pill
        if (x >= INSERT_PILL_X + INSERT_PILL_WIDTH - 14) {
          return { trackId: track.id, action: 'bypass', instanceId: insert.instanceId };
        }
        // Rest of pill: click to open params
        return { trackId: track.id, action: 'click', instanceId: insert.instanceId };
      }
    }

    // [+] button after last pill (only if under limit)
    if (visibleCount < MAX_INSERT_PILLS) {
      const addY = rackStartY + visibleCount * (INSERT_PILL_HEIGHT + INSERT_PILL_GAP);
      if (y >= addY && y <= addY + INSERT_ADD_HEIGHT && x <= INSERT_PILL_X + 30) {
        return { trackId: track.id, action: 'add' };
      }
    }

    return null;
  }

  // ==================================================================
  // Mouse handlers
  // ==================================================================

  private onMouseDown(e: MouseEvent): void {
    if (!this.timeline) return;
    const { x, y } = this.clientToLocal(e);

    // 1. Check insert rack in track headers
    const insertHit = this.hitTestInsertRack(x, y);
    if (insertHit) {
      if (insertHit.action === 'add' && this.onInsertAdd) {
        this.onInsertAdd(insertHit.trackId);
      } else if (insertHit.action === 'click' && insertHit.instanceId && this.onInsertClick) {
        this.onInsertClick(insertHit.trackId, insertHit.instanceId, e.clientX, e.clientY);
      } else if (insertHit.action === 'bypass' && insertHit.instanceId && this.onInsertBypass) {
        this.onInsertBypass(insertHit.trackId, insertHit.instanceId);
      } else if (insertHit.action === 'remove' && insertHit.instanceId && this.onInsertRemove) {
        this.onInsertRemove(insertHit.trackId, insertHit.instanceId);
      }
      this.render();
      return;
    }

    // 2. Check mute/solo header buttons
    const btnHit = this.hitTestTrackButton(x, y);
    if (btnHit) {
      if (btnHit.button === 'mute' && this.onTrackMuteToggle) {
        this.onTrackMuteToggle(btnHit.trackId);
      } else if (btnHit.button === 'solo' && this.onTrackSoloToggle) {
        this.onTrackSoloToggle(btnHit.trackId);
      }
      this.render();
      return;
    }

    // 2b. Check for track resize handle (bottom edge of track header, within 3px)
    if (x < TRACK_HEADER_WIDTH && y >= RULER_HEIGHT) {
      const trackIdx = this.yToTrackIndex(y);
      const tracks = this.timeline.tracks;
      if (trackIdx >= 0 && trackIdx < tracks.length) {
        const trackBottom = RULER_HEIGHT + this.trackTops[trackIdx] + tracks[trackIdx].height - this.scrollOffsetY;
        if (Math.abs(y - trackBottom) <= 3) {
          this.drag = {
            mode: 'trackResize', clipId: '', trackId: tracks[trackIdx].id,
            grabOffsetSamples: 0, originalValue: 0,
            startMouseX: x, startMouseY: y, hasDragged: false, shiftHeld: false,
            resizeTrackIndex: trackIdx, resizeOriginalHeight: tracks[trackIdx].height,
          };
          this.canvas.style.cursor = 'ns-resize';
          return;
        }
      }
    }

    // 3. Track header click (missed buttons/inserts → select track)
    if (x < TRACK_HEADER_WIDTH) {
      const trackIdx = this.yToTrackIndex(y);
      if (trackIdx < 0 || trackIdx >= this.timeline.tracks.length) return;
      const trackId = this.timeline.tracks[trackIdx].id;
      if (e.shiftKey) {
        // Toggle track in selection
        const idx = this.timeline.selectedTrackIds.indexOf(trackId);
        if (idx >= 0) {
          this.timeline.selectedTrackIds.splice(idx, 1);
        } else {
          this.timeline.selectedTrackIds.push(trackId);
        }
      } else {
        this.timeline.selectedTrackIds = [trackId];
      }
      this.onTrackSelect?.(this.timeline.selectedTrackIds);
      this.render();
      return;
    }

    // 4. Ruler click — cue point interaction, then fall through to playhead/selection
    if (y < RULER_HEIGHT) {
      // Cue point interactions in ruler area
      if (this.cuePointManager) {
        const cuePoints = this.cuePointManager.getAllCuePoints();
        let hitCue: { id: number; sample: number } | null = null;
        for (const cp of cuePoints) {
          const cpX = this.sampleToPixel(cp.sample);
          if (Math.abs(x - cpX) <= 8) {
            hitCue = { id: cp.id, sample: cp.sample };
            break;
          }
        }

        if (e.altKey && hitCue) {
          // Option+Click on cue → delete
          if (this.onCuePointRemove) this.onCuePointRemove(hitCue.id);
          this.render();
          return;
        }
        if (e.shiftKey && !hitCue) {
          // Shift+Click on empty ruler → add cue point
          const sample = Math.max(0, this.pixelToSample(x));
          if (this.onCuePointAdd) this.onCuePointAdd(sample);
          this.render();
          return;
        }
        if (hitCue && !e.shiftKey && !e.altKey) {
          // Plain click on cue → drag
          this.drag = {
            mode: 'cuePoint', clipId: '', trackId: '',
            grabOffsetSamples: 0, originalValue: hitCue.sample,
            startMouseX: x, startMouseY: y, hasDragged: false, shiftHeld: false,
            dragCuePointId: hitCue.id, originalCuePointSample: hitCue.sample,
          };
          this.render();
          return;
        }
      }

      // Select all tracks on ruler click
      this.timeline.selectedTrackIds = this.timeline.tracks.map(t => t.id);
      this.onTrackSelect?.(this.timeline.selectedTrackIds);
    }

    // 5. Hit-test clips (Smart Tool: zone depends on Y position)
    const hit = this.hitTestClip(x, y);
    if (hit) {
      const { clip, track, zone } = hit;

      if (zone === 'trimStart') {
        this.timeline.selectedClipIds = [clip.id];
        if (this.onClipSelect) this.onClipSelect(clip.id, track.id);
        this.drag = {
          mode: 'trimStart', clipId: clip.id, trackId: track.id,
          grabOffsetSamples: 0, originalValue: clip.sourceStart,
          startMouseX: x, startMouseY: y, hasDragged: false, shiftHeld: false,
        };
        this.render();
        return;
      }

      if (zone === 'trimEnd') {
        this.timeline.selectedClipIds = [clip.id];
        if (this.onClipSelect) this.onClipSelect(clip.id, track.id);
        this.drag = {
          mode: 'trimEnd', clipId: clip.id, trackId: track.id,
          grabOffsetSamples: 0, originalValue: clip.sourceEnd,
          startMouseX: x, startMouseY: y, hasDragged: false, shiftHeld: false,
        };
        this.render();
        return;
      }

      if (zone === 'clipGain') {
        this.timeline.selectedClipIds = [clip.id];
        if (this.onClipSelect) this.onClipSelect(clip.id, track.id);
        this.drag = {
          mode: 'clipGain', clipId: clip.id, trackId: track.id,
          grabOffsetSamples: 0, originalValue: 0,
          startMouseX: x, startMouseY: y, hasDragged: false, shiftHeld: false,
          originalGainDb: clip.gainDb,
        };
        this.render();
        return;
      }

      if (zone === 'fadeIn') {
        this.timeline.selectedClipIds = [clip.id];
        if (this.onClipSelect) this.onClipSelect(clip.id, track.id);
        this.drag = {
          mode: 'fadeIn', clipId: clip.id, trackId: track.id,
          grabOffsetSamples: 0, originalValue: clip.fadeInSamples,
          startMouseX: x, startMouseY: y, hasDragged: false, shiftHeld: false,
          originalFadeIn: clip.fadeInSamples, originalFadeOut: clip.fadeOutSamples,
        };
        this.render();
        return;
      }

      if (zone === 'fadeOut') {
        this.timeline.selectedClipIds = [clip.id];
        if (this.onClipSelect) this.onClipSelect(clip.id, track.id);
        this.drag = {
          mode: 'fadeOut', clipId: clip.id, trackId: track.id,
          grabOffsetSamples: 0, originalValue: clip.fadeOutSamples,
          startMouseX: x, startMouseY: y, hasDragged: false, shiftHeld: false,
          originalFadeIn: clip.fadeInSamples, originalFadeOut: clip.fadeOutSamples,
        };
        this.render();
        return;
      }

      if (zone === 'move') {
        // Lower half of track → move clip
        if (e.shiftKey) {
          // Shift: toggle clip in selection
          const idx = this.timeline.selectedClipIds.indexOf(clip.id);
          if (idx >= 0) {
            this.timeline.selectedClipIds.splice(idx, 1);
          } else {
            this.timeline.selectedClipIds.push(clip.id);
          }
        } else {
          // Without shift: replace selection only if clip not already selected
          if (!this.timeline.selectedClipIds.includes(clip.id)) {
            this.timeline.selectedClipIds = [clip.id];
          }
        }
        // Auto-add parent track to selectedTrackIds
        if (!this.timeline.selectedTrackIds.includes(track.id)) {
          this.timeline.selectedTrackIds.push(track.id);
        }
        if (this.onClipSelect) this.onClipSelect(clip.id, track.id);
        const sampleAtMouse = this.pixelToSample(x);
        this.drag = {
          mode: 'clipMove', clipId: clip.id, trackId: track.id,
          grabOffsetSamples: sampleAtMouse - clip.timelineOffset,
          originalValue: clip.timelineOffset,
          startMouseX: x, startMouseY: y, hasDragged: false, shiftHeld: false,
        };
        this.render();
        return;
      }

      // zone === 'select' → select clip, then fall through to time selection
      if (e.shiftKey) {
        const idx = this.timeline.selectedClipIds.indexOf(clip.id);
        if (idx >= 0) {
          this.timeline.selectedClipIds.splice(idx, 1);
        } else {
          this.timeline.selectedClipIds.push(clip.id);
        }
      } else {
        this.timeline.selectedClipIds = [clip.id];
      }
    }

    // 6. Empty space or select zone → time selection or marquee
    const sample = Math.max(0, this.pixelToSample(x));
    this.playheadSample = sample;
    this.timeline.playheadSample = sample;
    this.selectionStartSample = null;
    this.selectionEndSample = null;

    if (hit) {
      // Came from 'select' zone — start time selection
      this.drag = {
        mode: 'selection', clipId: '', trackId: '',
        grabOffsetSamples: 0, originalValue: sample,
        startMouseX: x, startMouseY: y, hasDragged: false, shiftHeld: false,
      };
    } else if (y >= RULER_HEIGHT) {
      // Empty space in content area → marquee
      if (!e.shiftKey) {
        this.timeline.selectedClipIds = [];
      }
      this.marqueeOriginalClipIds = [...this.timeline.selectedClipIds];
      this.marqueeOriginalTrackIds = [...this.timeline.selectedTrackIds];
      this.marqueeStartX = x;
      this.marqueeStartY = y;
      this.marqueeEndX = x;
      this.marqueeEndY = y;
      this.drag = {
        mode: 'marquee', clipId: '', trackId: '',
        grabOffsetSamples: 0, originalValue: sample,
        startMouseX: x, startMouseY: y, hasDragged: false, shiftHeld: e.shiftKey,
      };
    } else {
      // Ruler area → time selection
      this.drag = {
        mode: 'selection', clipId: '', trackId: '',
        grabOffsetSamples: 0, originalValue: sample,
        startMouseX: x, startMouseY: y, hasDragged: false, shiftHeld: false,
      };
    }

    if (this.onPlayheadChange) this.onPlayheadChange(sample);
    this.render();
  }

  private onMouseMove(e: MouseEvent): void {
    if (!this.timeline) return;
    const { x, y } = this.clientToLocal(e);

    // Update cursor when not dragging (Smart Tool cursor)
    if (this.drag.mode === 'none') {
      if (x < TRACK_HEADER_WIDTH && y >= RULER_HEIGHT) {
        // Check for track resize handle (bottom edge within 3px)
        let isResizeHandle = false;
        const hoverTrackIdx = this.yToTrackIndex(y);
        if (hoverTrackIdx >= 0 && hoverTrackIdx < this.timeline.tracks.length) {
          const trackBottom = RULER_HEIGHT + this.trackTops[hoverTrackIdx] + this.timeline.tracks[hoverTrackIdx].height - this.scrollOffsetY;
          if (Math.abs(y - trackBottom) <= 3) {
            isResizeHandle = true;
          }
        }
        this.canvas.style.cursor = isResizeHandle ? 'ns-resize' : 'pointer';
      } else if (x < TRACK_HEADER_WIDTH) {
        this.canvas.style.cursor = 'default';
      } else {
        const hit = this.hitTestClip(x, y);
        if (hit) {
          if (hit.zone === 'clipGain') {
            this.canvas.style.cursor = 'ns-resize';
          } else if (hit.zone === 'fadeIn' || hit.zone === 'fadeOut') {
            this.canvas.style.cursor = 'col-resize';
          } else if (hit.zone === 'trimStart' || hit.zone === 'trimEnd') {
            this.canvas.style.cursor = 'col-resize';
          } else if (hit.zone === 'move') {
            this.canvas.style.cursor = 'grab';
          } else {
            // 'select' — upper half
            this.canvas.style.cursor = 'text';
          }
        } else {
          // Empty space → selection tool
          this.canvas.style.cursor = 'text';
        }
      }
      return;
    }

    const deltaPixels = x - this.drag.startMouseX;
    const deltaSamples = Math.round(deltaPixels * this.samplesPerPixel);

    if (this.drag.mode === 'selection') {
      const currentSample = Math.max(0, this.pixelToSample(x));
      this.playheadSample = currentSample;
      this.timeline.playheadSample = currentSample;
      if (this.onPlayheadChange) this.onPlayheadChange(currentSample);

      // Start creating selection after > 5px movement
      if (Math.abs(deltaPixels) > 5) {
        this.drag.hasDragged = true;
        this.selectionStartSample = this.drag.originalValue;
        this.selectionEndSample = currentSample;
      }

      // Update selectedTrackIds based on vertical drag range
      if (this.drag.hasDragged) {
        const startIdx = this.yToTrackIndex(this.drag.startMouseY);
        const endIdx = this.yToTrackIndex(y);
        const minIdx = Math.max(0, Math.min(startIdx, endIdx));
        const maxIdx = Math.min(this.timeline.tracks.length - 1, Math.max(startIdx, endIdx));
        const newTrackIds: string[] = [];
        for (let i = minIdx; i <= maxIdx; i++) {
          newTrackIds.push(this.timeline.tracks[i].id);
        }
        this.timeline.selectedTrackIds = newTrackIds;
      }

      this.render();
      return;
    }

    if (this.drag.mode === 'clipMove') {
      this.canvas.style.cursor = 'grabbing';
      const newOffset = Math.max(0, this.drag.originalValue + deltaSamples);
      // Detect target track from Y position
      const targetIdx = this.yToTrackIndex(y);
      const tracks = this.timeline!.tracks;
      const validTarget = targetIdx >= 0 && targetIdx < tracks.length;
      this.dropTargetTrackIndex = validTarget ? targetIdx : -1;
      const targetTrackId = validTarget ? tracks[targetIdx].id : this.drag.trackId;
      if (this.onClipMove) {
        this.onClipMove(this.drag.clipId, this.drag.trackId, targetTrackId, newOffset);
      }
      // After cross-track move, the clip now lives in the target track
      this.drag.trackId = targetTrackId;
      this.render();
      return;
    }

    if (this.drag.mode === 'trimStart') {
      this.canvas.style.cursor = 'col-resize';
      const newSourceStart = this.drag.originalValue + deltaSamples;
      if (this.onClipTrim) {
        this.onClipTrim(this.drag.clipId, this.drag.trackId, 'start', newSourceStart);
      }
      this.render();
      return;
    }

    if (this.drag.mode === 'trimEnd') {
      this.canvas.style.cursor = 'col-resize';
      const newSourceEnd = this.drag.originalValue + deltaSamples;
      if (this.onClipTrim) {
        this.onClipTrim(this.drag.clipId, this.drag.trackId, 'end', newSourceEnd);
      }
      this.render();
      return;
    }

    if (this.drag.mode === 'clipGain') {
      this.canvas.style.cursor = 'ns-resize';
      const deltaY = y - this.drag.startMouseY;
      const gainDelta = deltaY * -0.5; // 2px = 1dB, up = louder
      const newGainDb = Math.max(-96, Math.min(12, (this.drag.originalGainDb ?? 0) + gainDelta));
      if (this.onClipGainChange) {
        this.onClipGainChange(this.drag.clipId, this.drag.trackId, newGainDb);
      }
      this.render();
      return;
    }

    if (this.drag.mode === 'fadeIn') {
      this.canvas.style.cursor = 'col-resize';
      const track = this.timeline!.tracks.find(t => t.id === this.drag.trackId);
      const clip = track?.clips.find(c => c.id === this.drag.clipId);
      if (clip) {
        const maxFade = clip.duration - (this.drag.originalFadeOut ?? 0);
        const newFadeIn = Math.max(0, Math.min(maxFade, (this.drag.originalFadeIn ?? 0) + deltaSamples));
        if (this.onClipFadeChange) {
          this.onClipFadeChange(this.drag.clipId, this.drag.trackId, 'in', newFadeIn);
        }
      }
      this.render();
      return;
    }

    if (this.drag.mode === 'fadeOut') {
      this.canvas.style.cursor = 'col-resize';
      const track = this.timeline!.tracks.find(t => t.id === this.drag.trackId);
      const clip = track?.clips.find(c => c.id === this.drag.clipId);
      if (clip) {
        const maxFade = clip.duration - (this.drag.originalFadeIn ?? 0);
        // Dragging right = reduce fade out
        const newFadeOut = Math.max(0, Math.min(maxFade, (this.drag.originalFadeOut ?? 0) - deltaSamples));
        if (this.onClipFadeChange) {
          this.onClipFadeChange(this.drag.clipId, this.drag.trackId, 'out', newFadeOut);
        }
      }
      this.render();
      return;
    }

    if (this.drag.mode === 'cuePoint') {
      this.canvas.style.cursor = 'grabbing';
      const newSample = Math.max(0, this.pixelToSample(x));
      if (this.cuePointManager && this.drag.dragCuePointId != null) {
        this.cuePointManager.moveCuePoint(this.drag.dragCuePointId, newSample);
        this.drag.hasDragged = true;
      }
      this.render();
      return;
    }

    if (this.drag.mode === 'trackResize') {
      this.canvas.style.cursor = 'ns-resize';
      const trackIdx = this.drag.resizeTrackIndex ?? 0;
      const track = this.timeline.tracks[trackIdx];
      if (track) {
        const deltaY = y - this.drag.startMouseY;
        const minHeight = track.channels * 24;
        const newHeight = Math.max(minHeight, (this.drag.resizeOriginalHeight ?? TRACK_HEIGHT) + deltaY);
        track.height = Math.round(newHeight);
        this.recomputeTrackLayout();
        this.render();
      }
      return;
    }

    if (this.drag.mode === 'marquee') {
      this.marqueeEndX = x;
      this.marqueeEndY = y;
      if (!this.drag.hasDragged) {
        const dx = x - this.drag.startMouseX;
        const dy = y - this.drag.startMouseY;
        if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
          this.drag.hasDragged = true;
        }
      }
      if (this.drag.hasDragged) {
        this.updateMarqueeSelection();
      }
      this.render();
      return;
    }
  }

  private onMouseUp(): void {
    if (this.drag.mode === 'trackResize') {
      this.recomputeTrackLayout();
      this.drag.mode = 'none';
      this.canvas.style.cursor = 'default';
      this.render();
      return;
    }

    if (this.drag.mode === 'selection') {
      if (this.drag.hasDragged) {
        // Normalize selection range
        if (this.selectionStartSample !== null && this.selectionEndSample !== null) {
          if (this.selectionStartSample > this.selectionEndSample) {
            [this.selectionStartSample, this.selectionEndSample] =
              [this.selectionEndSample, this.selectionStartSample];
          }
          // Too small? Clear it
          if (this.selectionEndSample - this.selectionStartSample < 10) {
            this.selectionStartSample = null;
            this.selectionEndSample = null;
          }
        }
        this.onTrackSelect?.(this.timeline!.selectedTrackIds);
        if (this.onSelectionChange) this.onSelectionChange();
        this.render();
      } else {
        // Click without drag: just set playhead, clear selection
        if (this.onSelectionChange) this.onSelectionChange();
      }
    }
    if (this.drag.mode === 'marquee') {
      if (this.drag.hasDragged) {
        this.onTrackSelect?.(this.timeline!.selectedTrackIds);
      }
      // Clear marquee visual
      this.marqueeStartX = this.marqueeStartY = this.marqueeEndX = this.marqueeEndY = 0;
      this.drag.mode = 'none';
      this.render();
      return;
    }

    // Clip gain / fade drags → fire onDragEnd for App.ts to create undo command
    if (this.drag.mode === 'clipGain' || this.drag.mode === 'fadeIn' || this.drag.mode === 'fadeOut') {
      this.drag.mode = 'none';
      if (this.onDragEnd) this.onDragEnd();
      return;
    }

    // Cue point drag → fire onCuePointMoveEnd
    if (this.drag.mode === 'cuePoint') {
      if (this.drag.hasDragged && this.drag.dragCuePointId != null && this.drag.originalCuePointSample != null) {
        const cue = this.cuePointManager?.getAllCuePoints().find(c => c.id === this.drag.dragCuePointId);
        if (cue && this.onCuePointMoveEnd) {
          this.onCuePointMoveEnd(this.drag.dragCuePointId, this.drag.originalCuePointSample, cue.sample);
        }
      }
      this.drag.mode = 'none';
      this.render();
      return;
    }

    // Fire onDragEnd for clip move / trim drags (not selection)
    const wasClipDrag = this.drag.mode === 'clipMove' ||
      this.drag.mode === 'trimStart' || this.drag.mode === 'trimEnd';
    this.dropTargetTrackIndex = -1;
    this.drag.mode = 'none';
    if (wasClipDrag && this.onDragEnd) {
      this.onDragEnd();
    }
  }

  // ==================================================================
  // Marquee selection
  // ==================================================================

  private updateMarqueeSelection(): void {
    if (!this.timeline) return;
    const tracks = this.timeline.tracks;

    const minX = Math.min(this.marqueeStartX, this.marqueeEndX);
    const maxX = Math.max(this.marqueeStartX, this.marqueeEndX);
    const minY = Math.min(this.marqueeStartY, this.marqueeEndY);
    const maxY = Math.max(this.marqueeStartY, this.marqueeEndY);

    // Convert x range to sample range
    const sampleStart = (minX - TRACK_HEADER_WIDTH) * this.samplesPerPixel + this.scrollOffsetX;
    const sampleEnd = (maxX - TRACK_HEADER_WIDTH) * this.samplesPerPixel + this.scrollOffsetX;

    // Convert y range to track indices using variable track heights
    const localMinY = minY - RULER_HEIGHT + this.scrollOffsetY;
    const localMaxY = maxY - RULER_HEIGHT + this.scrollOffsetY;
    let startTrackIdx = tracks.length;
    let endTrackIdx = -1;
    for (let i = 0; i < tracks.length; i++) {
      const top = this.trackTops[i];
      const bottom = top + tracks[i].height;
      if (bottom > localMinY && top < localMaxY) {
        if (i < startTrackIdx) startTrackIdx = i;
        if (i > endTrackIdx) endTrackIdx = i;
      }
    }
    if (startTrackIdx > endTrackIdx) { startTrackIdx = 0; endTrackIdx = -1; }

    // Build new selectedTrackIds from range
    const newTrackIds: string[] = [];
    const newClipIds: string[] = [];

    for (let i = startTrackIdx; i <= endTrackIdx; i++) {
      if (i < 0 || i >= tracks.length) continue;
      const track = tracks[i];
      newTrackIds.push(track.id);
      for (const clip of track.clips) {
        const clipEnd = clip.timelineOffset + clip.duration;
        if (clip.timelineOffset < sampleEnd && clipEnd > sampleStart) {
          newClipIds.push(clip.id);
        }
      }
    }

    if (this.drag.shiftHeld) {
      // Union with original selection (no duplicates)
      const trackSet = new Set([...this.marqueeOriginalTrackIds, ...newTrackIds]);
      const clipSet = new Set([...this.marqueeOriginalClipIds, ...newClipIds]);
      this.timeline.selectedTrackIds = [...trackSet];
      this.timeline.selectedClipIds = [...clipSet];
    } else {
      this.timeline.selectedTrackIds = newTrackIds;
      this.timeline.selectedClipIds = newClipIds;
    }
  }

  // ==================================================================
  // Wheel: scroll + zoom
  // ==================================================================

  private onWheel(e: WheelEvent): void {
    if (!this.timeline) return;
    e.preventDefault();

    const { x } = this.clientToLocal(e);
    const isCmdHeld = e.metaKey || e.ctrlKey;
    const isShiftHeld = e.shiftKey;

    // Cmd + wheel = zoom
    if (isCmdHeld) {
      const zoomFactor = e.deltaY > 0 ? 1.15 : 1 / 1.15;
      const contentX = x - TRACK_HEADER_WIDTH;
      const sampleAtMouse = this.scrollOffsetX + contentX * this.samplesPerPixel;

      const maxSPP = this.timeline.totalLength / 50;
      this.samplesPerPixel = Math.max(1, Math.min(maxSPP, this.samplesPerPixel * zoomFactor));

      this.scrollOffsetX = sampleAtMouse - contentX * this.samplesPerPixel;
      this.clampScroll();
      this.clipPeakCaches.clear();
      this.render();
      if (this.onZoomChange) this.onZoomChange();
      return;
    }

    // Native horizontal scroll (trackpad two-finger swipe) or Shift+wheel
    const isNativeHorizontal = Math.abs(e.deltaX) > Math.abs(e.deltaY) * 0.5;

    if (isNativeHorizontal || isShiftHeld) {
      // Horizontal time-axis scroll
      const delta = isNativeHorizontal ? e.deltaX : e.deltaY;
      this.scrollOffsetX += delta * this.samplesPerPixel * 0.5;
      this.clampScroll();
      this.render();
      if (this.onScrollChange) this.onScrollChange();
    } else {
      // Vertical scroll (multi-track)
      this.scrollOffsetY += e.deltaY;
      this.clampScroll();
      this.render();
      if (this.onScrollChange) this.onScrollChange();
    }
  }

  // ==================================================================
  // Keyboard
  // ==================================================================

  private onKeyDown(_e: KeyboardEvent): void {
    // Split (S) and Delete/Backspace are handled by App.ts handleKeyboard()
    // to avoid duplicate execution and ensure correct time-selection priority.
  }

  // ==================================================================
  // Peak cache (per buffer, block-level)
  // ==================================================================

  /**
   * Build or retrieve a block-level peak cache for a PooledBuffer.
   * Returns interleaved [min0, max0, min1, max1, ...] at PEAK_BLOCK_SIZE.
   */
  private getBufferPeakCache(bufferId: string): Float32Array | null {
    if (this.bufferPeakCaches.has(bufferId)) {
      return this.bufferPeakCaches.get(bufferId)!;
    }
    if (!this.bufferPool) return null;
    const pooled = this.bufferPool.getBuffer(bufferId);
    if (!pooled) return null;

    const data = pooled.buffer.getChannelData(0); // mono buffers
    const numBlocks = Math.ceil(data.length / PEAK_BLOCK_SIZE);
    const peaks = new Float32Array(numBlocks * 2);

    for (let b = 0; b < numBlocks; b++) {
      const start = b * PEAK_BLOCK_SIZE;
      const end = Math.min(start + PEAK_BLOCK_SIZE, data.length);
      let min = 0, max = 0;
      for (let j = start; j < end; j++) {
        const v = data[j];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      peaks[b * 2] = min;
      peaks[b * 2 + 1] = max;
    }

    this.bufferPeakCaches.set(bufferId, peaks);
    return peaks;
  }

  /**
   * Get per-pixel peaks for a clip, with caching.
   * Uses the buffer-level peak cache for zoomed-out views,
   * or direct sample access when zoomed in past the block size.
   */
  private getClipPeaks(clip: Clip, widthPx: number): Float32Array {
    const cached = this.clipPeakCaches.get(clip.id);
    if (
      cached &&
      cached.bufferId === clip.bufferId &&
      cached.sourceStart === clip.sourceStart &&
      cached.sourceEnd === clip.sourceEnd &&
      cached.samplesPerPixel === this.samplesPerPixel &&
      cached.widthPx === widthPx
    ) {
      return cached.peaks;
    }

    const peaks = new Float32Array(widthPx * 2);
    if (!this.bufferPool) return peaks;

    const pooled = this.bufferPool.getBuffer(clip.bufferId);
    if (!pooled) return peaks;

    const clipSourceLength = clip.sourceEnd - clip.sourceStart;
    const samplesPerPeak = clipSourceLength / widthPx;

    // Decide whether to use block cache or direct samples
    const bufferCache = this.getBufferPeakCache(clip.bufferId);
    const useBlockCache = bufferCache && samplesPerPeak >= PEAK_BLOCK_SIZE;

    if (useBlockCache && bufferCache) {
      for (let i = 0; i < widthPx; i++) {
        const srcStart = clip.sourceStart + i * samplesPerPeak;
        const srcEnd = clip.sourceStart + (i + 1) * samplesPerPeak;
        const blockStart = Math.max(0, Math.floor(srcStart / PEAK_BLOCK_SIZE));
        const blockEnd = Math.min(Math.ceil(srcEnd / PEAK_BLOCK_SIZE), bufferCache.length / 2);

        let min = 0, max = 0;
        for (let b = blockStart; b < blockEnd; b++) {
          const bMin = bufferCache[b * 2];
          const bMax = bufferCache[b * 2 + 1];
          if (bMin < min) min = bMin;
          if (bMax > max) max = bMax;
        }
        peaks[i * 2] = min;
        peaks[i * 2 + 1] = max;
      }
    } else {
      // Direct sample access for zoomed-in views
      const channelData = pooled.buffer.getChannelData(0);
      for (let i = 0; i < widthPx; i++) {
        const startSample = clip.sourceStart + Math.floor(i * samplesPerPeak);
        const endSample = clip.sourceStart + Math.floor((i + 1) * samplesPerPeak);

        let min = 0, max = 0;
        for (let j = Math.max(0, startSample); j < endSample && j < channelData.length; j++) {
          const v = channelData[j];
          if (v < min) min = v;
          if (v > max) max = v;
        }
        peaks[i * 2] = min;
        peaks[i * 2 + 1] = max;
      }
    }

    this.clipPeakCaches.set(clip.id, {
      bufferId: clip.bufferId,
      sourceStart: clip.sourceStart,
      sourceEnd: clip.sourceEnd,
      samplesPerPixel: this.samplesPerPixel,
      widthPx,
      peaks,
    });

    return peaks;
  }

  // ==================================================================
  // Render entry point
  // ==================================================================

  render(): void {
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;

    // Clear
    ctx.fillStyle = COLOR_BG;
    ctx.fillRect(0, 0, w, h);

    if (!this.timeline || !this.bufferPool) {
      this.renderPlaceholder();
      return;
    }

    if (this.timeline.tracks.length === 0) {
      this.renderPlaceholder();
      return;
    }

    this.recomputeTrackLayout();

    this.renderRuler();
    this.renderCueMarkers();

    // Clip rendering to the area below the ruler
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, RULER_HEIGHT, w, h - RULER_HEIGHT);
    ctx.clip();
    this.renderTrackLanes();
    ctx.restore();

    // Time selection overlay — Pro Tools style: only highlight selected tracks
    if (this.selectionStartSample !== null && this.selectionEndSample !== null) {
      const selStart = Math.min(this.selectionStartSample, this.selectionEndSample);
      const selEnd = Math.max(this.selectionStartSample, this.selectionEndSample);
      const leftPx = Math.max(TRACK_HEADER_WIDTH, this.sampleToPixel(selStart));
      const rightPx = Math.min(w, this.sampleToPixel(selEnd));
      const selWidth = rightPx - leftPx;
      if (selWidth > 0 && this.timeline) {
        const selected = this.timeline.selectedTrackIds;
        const tracks = this.timeline.tracks;
        ctx.fillStyle = 'rgba(37, 99, 235, 0.2)';
        for (let i = 0; i < tracks.length; i++) {
          // If no tracks selected, highlight all (fallback matches Delete behavior)
          if (selected.length > 0 && !selected.includes(tracks[i].id)) continue;
          const topY = RULER_HEIGHT + this.trackTops[i] - this.scrollOffsetY;
          const bottomY = topY + tracks[i].height;
          // Skip off-screen tracks, clamp to ruler boundary
          if (bottomY <= RULER_HEIGHT || topY >= h) continue;
          const clampedTop = Math.max(RULER_HEIGHT, topY);
          const clampedBottom = Math.min(h, bottomY);
          ctx.fillRect(leftPx, clampedTop, selWidth, clampedBottom - clampedTop);
        }
      }
    }

    // Track headers on top (so they cover any clip overflow on the left)
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, RULER_HEIGHT, TRACK_HEADER_WIDTH, h - RULER_HEIGHT);
    ctx.clip();
    this.renderTrackHeaders();
    ctx.restore();

    // Playhead across full height
    this.renderPlayhead();

    // Marquee rectangle overlay
    if (this.drag.mode === 'marquee' && this.drag.hasDragged) {
      const minX = Math.max(TRACK_HEADER_WIDTH, Math.min(this.marqueeStartX, this.marqueeEndX));
      const maxX = Math.max(this.marqueeStartX, this.marqueeEndX);
      const minY = Math.max(RULER_HEIGHT, Math.min(this.marqueeStartY, this.marqueeEndY));
      const maxY = Math.max(this.marqueeStartY, this.marqueeEndY);

      ctx.fillStyle = 'rgba(37, 99, 235, 0.1)';
      ctx.fillRect(minX, minY, maxX - minX, maxY - minY);
      ctx.strokeStyle = 'rgba(37, 99, 235, 0.6)';
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1;
      ctx.strokeRect(minX, minY, maxX - minX, maxY - minY);
      ctx.setLineDash([]);
    }

    // External drop target preview
    if (this.externalDropTarget) {
      const { trackIndex, sampleOffset } = this.externalDropTarget;
      const channelCount = this.externalDragChannelCount;
      const dropX = this.sampleToPixel(sampleOffset);

      ctx.save();
      // Blue semi-transparent highlight over target tracks
      ctx.fillStyle = 'rgba(37, 99, 235, 0.15)';
      for (let i = 0; i < channelCount; i++) {
        const ti = trackIndex + i;
        if (ti >= this.trackTops.length) continue;
        const topY = RULER_HEIGHT + this.trackTops[ti] - this.scrollOffsetY;
        const trackH = this.timeline!.tracks[ti].height;
        const clampedTop = Math.max(RULER_HEIGHT, topY);
        const clampedBottom = Math.min(h, topY + trackH);
        if (clampedBottom <= RULER_HEIGHT || clampedTop >= h) continue;
        ctx.fillRect(TRACK_HEADER_WIDTH, clampedTop, w - TRACK_HEADER_WIDTH, clampedBottom - clampedTop);
      }

      // Dashed vertical line at drop position
      if (dropX >= TRACK_HEADER_WIDTH && dropX <= w) {
        ctx.strokeStyle = 'rgba(37, 99, 235, 0.8)';
        ctx.setLineDash([4, 4]);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(dropX, RULER_HEIGHT);
        ctx.lineTo(dropX, h);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.restore();
    }
  }

  private renderPlaceholder(): void {
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;

    ctx.fillStyle = '#444';
    ctx.font = '14px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Import audio to create tracks', w / 2, h / 2 - 6);
    ctx.font = '11px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.fillStyle = '#666';
    ctx.fillText('Drag & drop WAV/AIF files or use File > Import', w / 2, h / 2 + 14);
  }

  // ==================================================================
  // Time ruler
  // ==================================================================

  private renderRuler(): void {
    const ctx = this.ctx;
    const w = this.width;
    const sr = this.timeline!.sampleRate;

    // Background
    ctx.fillStyle = COLOR_HEADER_BG;
    ctx.fillRect(0, 0, w, RULER_HEIGHT);

    // Bottom border
    ctx.strokeStyle = COLOR_TRACK_BORDER;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, RULER_HEIGHT - 0.5);
    ctx.lineTo(w, RULER_HEIGHT - 0.5);
    ctx.stroke();

    const cw = this.contentWidth;
    if (cw <= 0) return;

    // Determine a nice tick interval based on zoom
    const pixelsPerSecond = sr / this.samplesPerPixel;
    let tickInterval = 600;
    const intervals = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    for (const iv of intervals) {
      if (iv * pixelsPerSecond >= 60) {
        tickInterval = iv;
        break;
      }
    }

    const startTime = this.scrollOffsetX / sr;
    const endTime = (this.scrollOffsetX + cw * this.samplesPerPixel) / sr;
    const firstTick = Math.ceil(startTime / tickInterval) * tickInterval;

    ctx.fillStyle = COLOR_RULER_TEXT;
    ctx.font = '10px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textAlign = 'center';

    for (let t = firstTick; t <= endTime + tickInterval; t += tickInterval) {
      const sample = Math.round(t * sr);
      const px = this.sampleToPixel(sample);
      if (px < TRACK_HEADER_WIDTH || px > w) continue;

      // Major tick
      ctx.strokeStyle = '#555';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(px, RULER_HEIGHT - 8);
      ctx.lineTo(px, RULER_HEIGHT - 1);
      ctx.stroke();

      // Label
      ctx.fillStyle = COLOR_RULER_TEXT;
      const label = t >= 60
        ? formatTime(Math.max(0, t))
        : t.toFixed(tickInterval < 1 ? 2 : (tickInterval < 10 ? 1 : 0)) + 's';
      ctx.fillText(label, px, RULER_HEIGHT - 10);
    }

    // Minor ticks
    const minorInterval = tickInterval / 4;
    if (minorInterval > 0) {
      ctx.strokeStyle = '#3a3a3a';
      ctx.lineWidth = 1;
      for (let t = firstTick - tickInterval; t <= endTime + tickInterval; t += minorInterval) {
        const sample = Math.round(t * sr);
        const px = this.sampleToPixel(sample);
        if (px < TRACK_HEADER_WIDTH || px > w) continue;

        // Skip positions that coincide with major ticks
        const remainder = Math.abs(t % tickInterval);
        if (remainder < minorInterval * 0.1 || remainder > tickInterval - minorInterval * 0.1) continue;

        ctx.beginPath();
        ctx.moveTo(px, RULER_HEIGHT - 4);
        ctx.lineTo(px, RULER_HEIGHT - 1);
        ctx.stroke();
      }
    }
  }

  // ==================================================================
  // Track headers (left column)
  // ==================================================================

  private renderTrackHeaders(): void {
    const ctx = this.ctx;
    const tracks = this.timeline!.tracks;

    for (let i = 0; i < tracks.length; i++) {
      const track = tracks[i];
      const trackH = track.height;
      const topY = RULER_HEIGHT + this.trackTops[i] - this.scrollOffsetY;
      const bottomY = topY + trackH;

      // Skip off-screen tracks
      if (bottomY < RULER_HEIGHT || topY > this.height) continue;

      // Background
      ctx.fillStyle = COLOR_HEADER_BG;
      ctx.fillRect(0, topY, TRACK_HEADER_WIDTH, trackH);

      // Right border
      ctx.strokeStyle = COLOR_TRACK_BORDER;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(TRACK_HEADER_WIDTH - 0.5, topY);
      ctx.lineTo(TRACK_HEADER_WIDTH - 0.5, bottomY);
      ctx.stroke();

      // Bottom border
      ctx.beginPath();
      ctx.moveTo(0, bottomY - 0.5);
      ctx.lineTo(TRACK_HEADER_WIDTH, bottomY - 0.5);
      ctx.stroke();

      // Color indicator bar (3px at top of header)
      ctx.fillStyle = track.color;
      ctx.fillRect(0, topY, TRACK_HEADER_WIDTH, 3);

      // Selected track header highlight (drawn after color bar so blue tint is visible)
      if (this.timeline!.selectedTrackIds.includes(track.id)) {
        ctx.fillStyle = 'rgba(37, 99, 235, 0.15)';
        ctx.fillRect(0, topY, TRACK_HEADER_WIDTH, trackH);
        // Blue accent bar at left edge
        ctx.fillStyle = COLOR_SELECTED_BORDER;
        ctx.fillRect(0, topY, 3, trackH);
      }

      // Track name (left column, clipped to 0-48px)
      ctx.fillStyle = track.mute ? '#555' : '#ccc';
      ctx.font = 'bold 10px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.textAlign = 'left';
      ctx.save();
      ctx.beginPath();
      ctx.rect(4, topY + 6, 44, 14);
      ctx.clip();
      ctx.fillText(track.name, 6, topY + 17);
      ctx.restore();

      // Channel badge (M, ST, Q, 5.1)
      const badges: Record<number, string> = { 1: 'M', 2: 'ST', 4: 'Q', 6: '5.1' };
      const badge = badges[track.channels] || `${track.channels}ch`;
      ctx.fillStyle = '#666';
      ctx.font = '8px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(badge, 6, topY + 28);

      // Insert rack (right column, 5 pill slots)
      this.renderInsertRack(track, topY);

      // Vertical meter strip (right of insert rack)
      this.renderTrackMeter(track, topY);

      // Mute / Solo buttons (left column bottom, clamped to track height)
      const btnY = topY + Math.min(60, trackH - MUTE_SOLO_BTN_SIZE - 4);
      const muteX = 6;
      const soloX = muteX + MUTE_SOLO_BTN_SIZE + MUTE_SOLO_BTN_GAP;

      // Mute button
      ctx.fillStyle = track.mute ? '#ef4444' : '#444';
      ctx.beginPath();
      ctx.roundRect(muteX, btnY, MUTE_SOLO_BTN_SIZE, MUTE_SOLO_BTN_SIZE, 2);
      ctx.fill();
      ctx.fillStyle = track.mute ? '#fff' : '#999';
      ctx.font = 'bold 9px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('M', muteX + MUTE_SOLO_BTN_SIZE / 2, btnY + MUTE_SOLO_BTN_SIZE - 3.5);

      // Solo button
      ctx.fillStyle = track.solo ? '#f59e0b' : '#444';
      ctx.beginPath();
      ctx.roundRect(soloX, btnY, MUTE_SOLO_BTN_SIZE, MUTE_SOLO_BTN_SIZE, 2);
      ctx.fill();
      ctx.fillStyle = track.solo ? '#fff' : '#999';
      ctx.fillText('S', soloX + MUTE_SOLO_BTN_SIZE / 2, btnY + MUTE_SOLO_BTN_SIZE - 3.5);
    }
  }

  // ==================================================================
  // Insert rack rendering
  // ==================================================================

  private renderInsertRack(track: Track, topY: number): void {
    const ctx = this.ctx;
    const rackStartY = topY + 6;

    const visibleInserts = track.inserts.slice(0, MAX_INSERT_PILLS);

    for (let i = 0; i < visibleInserts.length; i++) {
      const insert = visibleInserts[i];
      const pillY = rackStartY + i * (INSERT_PILL_HEIGHT + INSERT_PILL_GAP);

      // Pill background
      ctx.fillStyle = insert.bypassed ? '#2a2a2a' : '#333';
      ctx.beginPath();
      ctx.roundRect(INSERT_PILL_X, pillY, INSERT_PILL_WIDTH, INSERT_PILL_HEIGHT, 3);
      ctx.fill();

      // Plugin name (clipped to fit pill width minus bypass button)
      ctx.fillStyle = insert.bypassed ? '#555' : '#aaa';
      ctx.font = '9px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.textAlign = 'left';
      const displayName = this.getPluginShortName(insert.pluginId);
      ctx.save();
      ctx.beginPath();
      ctx.rect(INSERT_PILL_X + 3, pillY, INSERT_PILL_WIDTH - 18, INSERT_PILL_HEIGHT);
      ctx.clip();
      ctx.fillText(displayName, INSERT_PILL_X + 4, pillY + 9);
      ctx.restore();

      // Bypass button "B" (right edge of pill)
      const bx = INSERT_PILL_X + INSERT_PILL_WIDTH - 14;
      ctx.fillStyle = insert.bypassed ? '#666' : '#f59e0b';
      ctx.font = 'bold 8px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('B', bx + 7, pillY + 9);
    }

    // [+] add button (only if under limit)
    if (visibleInserts.length < MAX_INSERT_PILLS) {
      const addY = rackStartY + visibleInserts.length * (INSERT_PILL_HEIGHT + INSERT_PILL_GAP);
      ctx.fillStyle = '#333';
      ctx.beginPath();
      ctx.roundRect(INSERT_PILL_X, addY, 28, INSERT_ADD_HEIGHT, 3);
      ctx.fill();
      ctx.fillStyle = '#666';
      ctx.font = '9px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('+', INSERT_PILL_X + 14, addY + 8);
    }
  }

  private renderTrackMeter(track: Track, topY: number): void {
    const ctx = this.ctx;
    const db = this.trackMeterLevels.get(track.id) ?? -60;
    const meterTop = topY + 6;
    const meterHeight = Math.max(10, track.height - 12);  // adapt to track height

    // Meter background (dark well)
    ctx.fillStyle = '#111';
    ctx.beginPath();
    ctx.roundRect(METER_X, meterTop, METER_WIDTH, meterHeight, 2);
    ctx.fill();

    // Meter fill: map -60..+12 dB to 0..100%
    const percent = Math.max(0, Math.min(100, (db + 60) / 72 * 100));
    const fillHeight = meterHeight * percent / 100;

    if (fillHeight > 0) {
      // Color: green → yellow → red
      let color: string;
      if (db >= -1) color = '#ef4444';
      else if (db >= -6) color = '#f59e0b';
      else color = '#10b981';

      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.roundRect(METER_X, meterTop + meterHeight - fillHeight, METER_WIDTH, fillHeight, 2);
      ctx.fill();
    }
  }

  private getPluginShortName(pluginId: string): string {
    const names: Record<string, string> = {
      'builtin:eq7': 'EQ7',
      'builtin:compressor': 'Comp',
      'builtin:gain': 'Gain',
      'builtin:delay': 'Delay',
      'builtin:reverb': 'Reverb',
    };
    return names[pluginId] || pluginId.replace('builtin:', '');
  }

  // ==================================================================
  // Track lanes and clips
  // ==================================================================

  private renderTrackLanes(): void {
    const ctx = this.ctx;
    const w = this.width;
    const tracks = this.timeline!.tracks;

    for (let i = 0; i < tracks.length; i++) {
      const track = tracks[i];
      const trackH = track.height;
      const topY = RULER_HEIGHT + this.trackTops[i] - this.scrollOffsetY;
      const bottomY = topY + trackH;

      if (bottomY < RULER_HEIGHT || topY > this.height) continue;

      // Lane background (alternating colors, highlight drop target)
      if (this.dropTargetTrackIndex === i && this.drag.mode === 'clipMove') {
        ctx.fillStyle = '#1e2a3a';  // subtle blue highlight for drop target
      } else {
        ctx.fillStyle = i % 2 === 0 ? COLOR_TRACK_EVEN : COLOR_TRACK_ODD;
      }
      ctx.fillRect(TRACK_HEADER_WIDTH, topY, w - TRACK_HEADER_WIDTH, trackH);

      // Selected track lane tint
      if (this.timeline!.selectedTrackIds.includes(track.id)) {
        ctx.fillStyle = 'rgba(37, 99, 235, 0.06)';
        ctx.fillRect(TRACK_HEADER_WIDTH, topY, w - TRACK_HEADER_WIDTH, trackH);
      }

      // Sub-channel divider lines for multi-channel tracks
      if (track.channels > 1) {
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
        ctx.lineWidth = 1;
        const laneH = trackH / track.channels;
        for (let ch = 1; ch < track.channels; ch++) {
          const divY = topY + ch * laneH;
          ctx.beginPath();
          ctx.moveTo(TRACK_HEADER_WIDTH, divY);
          ctx.lineTo(w, divY);
          ctx.stroke();
        }
      }

      // Lane bottom border
      ctx.strokeStyle = COLOR_TRACK_BORDER;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(TRACK_HEADER_WIDTH, bottomY - 0.5);
      ctx.lineTo(w, bottomY - 0.5);
      ctx.stroke();

      // Render clips
      for (const clip of track.clips) {
        this.renderClip(clip, track, topY);
      }
    }
  }

  private renderClip(clip: Clip, track: Track, trackTopY: number): void {
    const ctx = this.ctx;
    const w = this.width;

    const clipStartPx = this.sampleToPixel(clip.timelineOffset);
    const clipEndPx = this.sampleToPixel(clip.timelineOffset + clip.duration);

    // Skip off-screen clips
    if (clipEndPx < TRACK_HEADER_WIDTH || clipStartPx > w) return;

    // Visible clip bounds (clamped to content area)
    const visLeft = Math.max(TRACK_HEADER_WIDTH, clipStartPx);
    const visRight = Math.min(w, clipEndPx);
    const visWidth = visRight - visLeft;
    if (visWidth <= 0) return;

    // If multi-channel track and clip has a subChannel, render in sub-lane
    const trackH = track.height;
    let clipY: number;
    let clipH: number;
    if (track.channels > 1 && clip.subChannel != null) {
      const laneH = trackH / track.channels;
      clipY = trackTopY + clip.subChannel * laneH + 2;
      clipH = laneH - 4;
    } else {
      clipY = trackTopY + 4;
      clipH = trackH - 8;
    }
    const isSelected = this.timeline!.selectedClipIds.includes(clip.id);
    const isMuted = clip.muted || track.mute;

    // -- Clip background (rounded rect, semi-transparent track color) --
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(visLeft, clipY, visWidth, clipH, CLIP_BORDER_RADIUS);
    ctx.clip();

    ctx.fillStyle = isMuted ? '#2a2a2a' : this.hexToRgba(track.color, 0.2);
    ctx.fillRect(visLeft, clipY, visWidth, clipH);

    // -- Waveform inside clip --
    this.renderClipWaveform(clip, track, clipY, clipH, clipStartPx, clipEndPx, visLeft, visRight, isMuted);

    // -- Fade overlays (inside clip region) --
    if (clip.fadeInSamples > 0) {
      const fadeInPx = clip.fadeInSamples / this.samplesPerPixel;
      const fadeStartPx = clipStartPx;
      const fadeEndPx = clipStartPx + fadeInPx;
      // Semi-transparent overlay
      ctx.fillStyle = this.hexToRgba(track.color, 0.25);
      ctx.beginPath();
      ctx.moveTo(Math.max(visLeft, fadeStartPx), clipY + clipH);
      ctx.lineTo(Math.max(visLeft, fadeStartPx), clipY);
      ctx.lineTo(Math.min(visRight, fadeEndPx), clipY);
      ctx.lineTo(Math.min(visRight, fadeEndPx), clipY + clipH);
      ctx.closePath();
      ctx.fill();
      // Fade curve line (sqrt)
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      const stepsIn = Math.max(2, Math.min(50, Math.round(fadeInPx)));
      let movedIn = false;
      for (let i = 0; i <= stepsIn; i++) {
        const t = i / stepsIn;
        const gain = Math.sqrt(t);
        const px = fadeStartPx + t * fadeInPx;
        if (px < visLeft || px > visRight) continue;
        const py = clipY + clipH - gain * clipH;
        if (!movedIn) { ctx.moveTo(px, py); movedIn = true; }
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
    }

    if (clip.fadeOutSamples > 0) {
      const fadeOutPx = clip.fadeOutSamples / this.samplesPerPixel;
      const fadeStartPx = clipEndPx - fadeOutPx;
      const fadeEndPx = clipEndPx;
      // Semi-transparent overlay
      ctx.fillStyle = this.hexToRgba(track.color, 0.25);
      ctx.beginPath();
      ctx.moveTo(Math.max(visLeft, fadeStartPx), clipY);
      ctx.lineTo(Math.max(visLeft, fadeStartPx), clipY + clipH);
      ctx.lineTo(Math.min(visRight, fadeEndPx), clipY + clipH);
      ctx.lineTo(Math.min(visRight, fadeEndPx), clipY);
      ctx.closePath();
      ctx.fill();
      // Fade curve line (sqrt(1-t))
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      const stepsOut = Math.max(2, Math.min(50, Math.round(fadeOutPx)));
      let movedOut = false;
      for (let i = 0; i <= stepsOut; i++) {
        const t = i / stepsOut;
        const gain = Math.sqrt(1 - t);
        const px = fadeStartPx + t * fadeOutPx;
        if (px < visLeft || px > visRight) continue;
        const py = clipY + clipH - gain * clipH;
        if (!movedOut) { ctx.moveTo(px, py); movedOut = true; }
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
    }

    ctx.restore(); // pop clip region

    // -- Clip border (rounded rect) --
    ctx.strokeStyle = isSelected ? COLOR_SELECTED_BORDER : track.color;
    ctx.lineWidth = isSelected ? 2 : 1;
    ctx.beginPath();
    ctx.roundRect(visLeft, clipY, visWidth, clipH, CLIP_BORDER_RADIUS);
    ctx.stroke();

    // -- Muted overlay --
    if (isMuted) {
      ctx.save();
      ctx.globalAlpha = 0.4;
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.roundRect(visLeft, clipY, visWidth, clipH, CLIP_BORDER_RADIUS);
      ctx.fill();
      ctx.restore();
    }

    // -- Clip name label --
    if (visWidth > 30) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(visLeft + 2, clipY, visWidth - 4, clipH);
      ctx.clip();
      ctx.fillStyle = '#ffffff';
      ctx.globalAlpha = 0.9;
      ctx.font = '10px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(clip.name, visLeft + 4, clipY + 12);
      ctx.restore();
    }

    // -- Trim handle indicators (subtle vertical lines at edges) --
    if (visWidth > 20) {
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
      ctx.lineWidth = 1;

      // Left handle
      const lhx = visLeft + 2.5;
      ctx.beginPath();
      ctx.moveTo(lhx, clipY + clipH * 0.3);
      ctx.lineTo(lhx, clipY + clipH * 0.7);
      ctx.stroke();

      // Right handle
      const rhx = visLeft + visWidth - 2.5;
      ctx.beginPath();
      ctx.moveTo(rhx, clipY + clipH * 0.3);
      ctx.lineTo(rhx, clipY + clipH * 0.7);
      ctx.stroke();
    }

    // -- Gain line across clip (dashed, only if gain != 0) --
    if (clip.gainDb !== 0) {
      const gainDbClamped = Math.max(-96, Math.min(12, clip.gainDb));
      const gainNorm = (gainDbClamped + 96) / 108; // 0..1 range
      const lineY = clipY + clipH - gainNorm * clipH;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(visLeft, lineY);
      ctx.lineTo(visRight, lineY);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // -- Gain handle square (bottom-left corner) --
    {
      const ghx = visLeft + 4;
      const ghy = clipY + clipH - GAIN_HANDLE_SIZE - 4;
      ctx.fillStyle = clip.gainDb !== 0 ? '#f59e0b' : '#555';
      ctx.fillRect(ghx, ghy, GAIN_HANDLE_SIZE, GAIN_HANDLE_SIZE);
      // dB label when gain is applied
      if (clip.gainDb !== 0) {
        ctx.fillStyle = '#fff';
        ctx.font = '9px -apple-system, BlinkMacSystemFont, sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(
          `${clip.gainDb > 0 ? '+' : ''}${clip.gainDb.toFixed(1)} dB`,
          ghx + GAIN_HANDLE_SIZE + 2, ghy + GAIN_HANDLE_SIZE - 1,
        );
      }
    }

    // -- Reversed indicator --
    if (clip.reversed) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
      ctx.font = 'bold 9px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText('R', visRight - 4, clipY + 12);
    }
  }

  private renderClipWaveform(
    clip: Clip,
    track: Track,
    clipY: number,
    clipH: number,
    fullClipStartPx: number,
    fullClipEndPx: number,
    visLeft: number,
    visRight: number,
    isMuted: boolean,
  ): void {
    const ctx = this.ctx;

    // Total pixel width of the full (unclipped) clip region
    const fullWidthPx = Math.max(1, Math.round(fullClipEndPx - fullClipStartPx));

    // Get cached peaks for the full clip
    const peaks = this.getClipPeaks(clip, fullWidthPx);

    // Waveform draw area (leave room for clip name at top, reduce padding for small lanes)
    const nameSpace = clipH > 30 ? 16 : 2;
    const waveTop = clipY + nameSpace;
    const waveHeight = clipH - nameSpace - 2;
    if (waveHeight <= 2) return;

    const centerY = waveTop + waveHeight / 2;
    const amplitude = waveHeight / 2;

    // Use sub-channel color if clip has a subChannel defined
    const waveColor = (clip.subChannel != null && clip.subChannel < CHANNEL_COLORS.length)
      ? CHANNEL_COLORS[clip.subChannel]
      : track.color;
    ctx.fillStyle = isMuted ? '#444' : waveColor;
    ctx.globalAlpha = isMuted ? 0.3 : 0.7;

    // Draw only the visible portion
    const pixelOffset = Math.round(visLeft - fullClipStartPx);
    const startIdx = Math.max(0, pixelOffset);
    const endIdx = Math.min(fullWidthPx, pixelOffset + Math.ceil(visRight - visLeft));

    for (let i = startIdx; i < endIdx; i++) {
      const min = peaks[i * 2];
      const max = peaks[i * 2 + 1];
      const drawX = fullClipStartPx + i;
      const y1 = centerY - max * amplitude;
      const y2 = centerY - min * amplitude;
      ctx.fillRect(drawX, y1, 1, Math.max(1, y2 - y1));
    }

    ctx.globalAlpha = 1;
  }

  // ==================================================================
  // Cue markers
  // ==================================================================

  private renderCueMarkers(): void {
    if (!this.cuePointManager || !this.timeline) return;
    const ctx = this.ctx;
    const cuePoints = this.cuePointManager.getAllCuePoints();

    for (const cue of cuePoints) {
      const px = this.sampleToPixel(cue.sample);
      if (px < TRACK_HEADER_WIDTH || px > this.width) continue;

      // Vertical dashed line from ruler to bottom
      ctx.strokeStyle = 'rgba(245, 158, 11, 0.3)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(px, RULER_HEIGHT);
      ctx.lineTo(px, this.height);
      ctx.stroke();
      ctx.setLineDash([]);

      // Flag triangle in ruler area
      ctx.fillStyle = '#f59e0b';
      ctx.beginPath();
      ctx.moveTo(px, RULER_HEIGHT - CUE_FLAG_HEIGHT);
      ctx.lineTo(px + CUE_FLAG_WIDTH, RULER_HEIGHT - CUE_FLAG_HEIGHT + CUE_FLAG_HEIGHT / 2);
      ctx.lineTo(px, RULER_HEIGHT);
      ctx.closePath();
      ctx.fill();

      // Cue number inside flag
      ctx.fillStyle = '#000';
      ctx.font = 'bold 8px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(cue.number.toString(), px + 1, RULER_HEIGHT - CUE_FLAG_HEIGHT / 2 + 3);

      // Cue name (if any)
      if (cue.name) {
        ctx.fillStyle = 'rgba(245, 158, 11, 0.7)';
        ctx.font = '9px -apple-system, BlinkMacSystemFont, sans-serif';
        ctx.fillText(cue.name, px + CUE_FLAG_WIDTH + 2, RULER_HEIGHT - CUE_FLAG_HEIGHT / 2 + 3);
      }
    }
  }

  // ==================================================================
  // Playhead
  // ==================================================================

  private renderPlayhead(): void {
    const ctx = this.ctx;
    const px = this.sampleToPixel(this.playheadSample);

    if (px < TRACK_HEADER_WIDTH || px > this.width) return;

    // Blink: when not playing, alternate between visible and dim
    const color = (!this.isPlaying && !this.blinkVisible) ? COLOR_PLAYHEAD_DIM : COLOR_PLAYHEAD;

    // White vertical line (1px crisp)
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(px) + 0.5, 0);
    ctx.lineTo(Math.round(px) + 0.5, this.height);
    ctx.stroke();

    // Triangle indicator at the top of the ruler
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(px - 4, 0);
    ctx.lineTo(px + 4, 0);
    ctx.lineTo(px, 6);
    ctx.closePath();
    ctx.fill();
  }

  // ==================================================================
  // Utility
  // ==================================================================

  private hexToRgba(hex: string, alpha: number): string {
    let r = 0, g = 0, b = 0;
    if (hex.length === 7) {
      r = parseInt(hex.slice(1, 3), 16);
      g = parseInt(hex.slice(3, 5), 16);
      b = parseInt(hex.slice(5, 7), 16);
    } else if (hex.length === 4) {
      r = parseInt(hex[1] + hex[1], 16);
      g = parseInt(hex[2] + hex[2], 16);
      b = parseInt(hex[3] + hex[3], 16);
    }
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
}
