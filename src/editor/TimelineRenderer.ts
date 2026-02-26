import { Timeline, Track, Clip, CHANNEL_COLORS, formatTime } from '../core/types';
import { BufferPool } from '../core/BufferPool';

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
const COLOR_PLAYHEAD = '#ef4444';
const COLOR_SELECTED_BORDER = '#2563eb';
const COLOR_TRACK_BORDER = '#2a2a2a';

// ---- Peak cache block size ----
const PEAK_BLOCK_SIZE = 256;

type DragMode = 'none' | 'selection' | 'clipMove' | 'trimStart' | 'trimEnd' | 'marquee';

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
 * inside track lanes, and a red playhead line -- all on a single canvas.
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

  private playheadSample = 0;

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

  /** Per-track meter levels in dB, updated externally from the animation loop. */
  trackMeterLevels: Map<string, number> = new Map();

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

  // Insert rack callbacks
  onInsertAdd: ((trackId: string) => void) | null = null;
  onInsertClick: ((trackId: string, instanceId: string, screenX: number, screenY: number) => void) | null = null;
  onInsertBypass: ((trackId: string, instanceId: string) => void) | null = null;
  onInsertRemove: ((trackId: string, instanceId: string) => void) | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.setupResize();
    this.setupInteraction();
  }

  // ==================================================================
  // Public API
  // ==================================================================

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
    const totalTrackHeight = this.timeline.tracks.length * TRACK_HEIGHT;
    const visibleHeight = this.height - RULER_HEIGHT;
    const maxScrollY = Math.max(0, totalTrackHeight - visibleHeight);
    this.scrollOffsetY = Math.max(0, Math.min(maxScrollY, this.scrollOffsetY));
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
    // Make canvas focusable for keyboard events
    this.canvas.tabIndex = 0;
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
    return Math.floor(localY / TRACK_HEIGHT);
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
    clip: Clip; track: Track; zone: 'trimStart' | 'trimEnd' | 'select' | 'move';
  } | null {
    if (!this.timeline || x < TRACK_HEADER_WIDTH) return null;
    const trackIndex = this.yToTrackIndex(y);
    if (trackIndex < 0 || trackIndex >= this.timeline.tracks.length) return null;
    const track = this.timeline.tracks[trackIndex];

    for (const clip of track.clips) {
      const clipStartPx = this.sampleToPixel(clip.timelineOffset);
      const clipEndPx = this.sampleToPixel(clip.timelineOffset + clip.duration);

      if (x >= clipStartPx && x <= clipEndPx) {
        // Edges take priority regardless of Y
        if (x - clipStartPx <= TRIM_HANDLE_WIDTH) return { clip, track, zone: 'trimStart' };
        if (clipEndPx - x <= TRIM_HANDLE_WIDTH) return { clip, track, zone: 'trimEnd' };

        // Split body by Y: upper half = select, lower half = move
        const trackTopY = RULER_HEIGHT + trackIndex * TRACK_HEIGHT - this.scrollOffsetY;
        const midY = trackTopY + TRACK_HEIGHT / 2;
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

    const trackTopY = RULER_HEIGHT + trackIndex * TRACK_HEIGHT - this.scrollOffsetY;
    const btnY = trackTopY + 60;
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

    const trackTopY = RULER_HEIGHT + trackIndex * TRACK_HEIGHT - this.scrollOffsetY;
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

    // 4. Ruler click → select all tracks, then fall through to playhead/selection
    if (y < RULER_HEIGHT) {
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
        this.canvas.style.cursor = 'pointer';
      } else if (x < TRACK_HEADER_WIDTH) {
        this.canvas.style.cursor = 'default';
      } else {
        const hit = this.hitTestClip(x, y);
        if (hit) {
          if (hit.zone === 'trimStart' || hit.zone === 'trimEnd') {
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

    // Convert y range to track indices
    const startTrackIdx = Math.max(0, Math.floor((minY - RULER_HEIGHT + this.scrollOffsetY) / TRACK_HEIGHT));
    const endTrackIdx = Math.min(tracks.length - 1, Math.floor((maxY - RULER_HEIGHT + this.scrollOffsetY) / TRACK_HEIGHT));

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

  private onKeyDown(e: KeyboardEvent): void {
    if (!this.timeline) return;

    // S = split selected clips at playhead
    if (e.key === 's' || e.key === 'S') {
      if (this.timeline.selectedClipIds.length === 0) return;
      // Collect all splits first, then execute in reverse to avoid index invalidation
      const toSplit: { trackId: string; clipId: string; sample: number }[] = [];
      for (const track of this.timeline.tracks) {
        for (const clip of track.clips) {
          if (this.timeline.selectedClipIds.includes(clip.id)) {
            toSplit.push({ trackId: track.id, clipId: clip.id, sample: this.timeline.playheadSample });
          }
        }
      }
      for (let i = toSplit.length - 1; i >= 0; i--) {
        const { trackId, clipId, sample } = toSplit[i];
        if (this.onClipSplit) {
          this.onClipSplit(trackId, clipId, sample);
        }
      }
      this.render();
    }

    // Delete / Backspace = delete selected clips
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (this.timeline.selectedClipIds.length === 0) return;
      const toDelete: { trackId: string; clipId: string }[] = [];
      for (const track of this.timeline.tracks) {
        for (const clip of track.clips) {
          if (this.timeline.selectedClipIds.includes(clip.id)) {
            toDelete.push({ trackId: track.id, clipId: clip.id });
          }
        }
      }
      for (const { trackId, clipId } of toDelete) {
        if (this.onClipDelete) this.onClipDelete(trackId, clipId);
      }
      this.timeline.selectedClipIds = [];
      this.render();
    }
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

    this.renderRuler();

    // Clip rendering to the area below the ruler
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, RULER_HEIGHT, w, h - RULER_HEIGHT);
    ctx.clip();
    this.renderTrackLanes();
    ctx.restore();

    // Time selection overlay (drawn above clips, below headers and playhead)
    if (this.selectionStartSample !== null && this.selectionEndSample !== null) {
      const selStart = Math.min(this.selectionStartSample, this.selectionEndSample);
      const selEnd = Math.max(this.selectionStartSample, this.selectionEndSample);
      const startPx = this.sampleToPixel(selStart);
      const endPx = this.sampleToPixel(selEnd);
      ctx.fillStyle = 'rgba(37, 99, 235, 0.2)';
      ctx.fillRect(
        Math.max(TRACK_HEADER_WIDTH, startPx), RULER_HEIGHT,
        Math.min(w, endPx) - Math.max(TRACK_HEADER_WIDTH, startPx), h - RULER_HEIGHT,
      );
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
      const topY = RULER_HEIGHT + i * TRACK_HEIGHT - this.scrollOffsetY;
      const bottomY = topY + TRACK_HEIGHT;

      // Skip off-screen tracks
      if (bottomY < RULER_HEIGHT || topY > this.height) continue;

      // Background
      ctx.fillStyle = COLOR_HEADER_BG;
      ctx.fillRect(0, topY, TRACK_HEADER_WIDTH, TRACK_HEIGHT);

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
        ctx.fillRect(0, topY, TRACK_HEADER_WIDTH, TRACK_HEIGHT);
        // Blue accent bar at left edge
        ctx.fillStyle = COLOR_SELECTED_BORDER;
        ctx.fillRect(0, topY, 3, TRACK_HEIGHT);
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

      // Insert rack (right column, 5 pill slots)
      this.renderInsertRack(track, topY);

      // Vertical meter strip (right of insert rack)
      this.renderTrackMeter(track, topY);

      // Mute / Solo buttons (left column bottom)
      const btnY = topY + 60;
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
    const meterHeight = 68;  // full meter height (almost full track)

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
      const topY = RULER_HEIGHT + i * TRACK_HEIGHT - this.scrollOffsetY;
      const bottomY = topY + TRACK_HEIGHT;

      if (bottomY < RULER_HEIGHT || topY > this.height) continue;

      // Lane background (alternating colors, highlight drop target)
      if (this.dropTargetTrackIndex === i && this.drag.mode === 'clipMove') {
        ctx.fillStyle = '#1e2a3a';  // subtle blue highlight for drop target
      } else {
        ctx.fillStyle = i % 2 === 0 ? COLOR_TRACK_EVEN : COLOR_TRACK_ODD;
      }
      ctx.fillRect(TRACK_HEADER_WIDTH, topY, w - TRACK_HEADER_WIDTH, TRACK_HEIGHT);

      // Selected track lane tint
      if (this.timeline!.selectedTrackIds.includes(track.id)) {
        ctx.fillStyle = 'rgba(37, 99, 235, 0.06)';
        ctx.fillRect(TRACK_HEADER_WIDTH, topY, w - TRACK_HEADER_WIDTH, TRACK_HEIGHT);
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

    const clipY = trackTopY + 4;
    const clipH = TRACK_HEIGHT - 8;
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

    // Waveform draw area (leave room for clip name at top)
    const waveTop = clipY + 16;
    const waveHeight = clipH - 18;
    if (waveHeight <= 2) return;

    const centerY = waveTop + waveHeight / 2;
    const amplitude = waveHeight / 2;

    ctx.fillStyle = isMuted ? '#444' : track.color;
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
  // Playhead
  // ==================================================================

  private renderPlayhead(): void {
    const ctx = this.ctx;
    const px = this.sampleToPixel(this.playheadSample);

    if (px < TRACK_HEADER_WIDTH || px > this.width) return;

    // Red vertical line
    ctx.strokeStyle = COLOR_PLAYHEAD;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, this.height);
    ctx.stroke();

    // Triangle indicator at the top of the ruler
    ctx.fillStyle = COLOR_PLAYHEAD;
    ctx.beginPath();
    ctx.moveTo(px - 5, 0);
    ctx.lineTo(px + 5, 0);
    ctx.lineTo(px, 7);
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
