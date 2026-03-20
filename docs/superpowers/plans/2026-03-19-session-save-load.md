# Session Save/Load Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `.fcs` session file save/load so users can persist and restore their entire timeline state with external audio file references.

**Architecture:** A `SessionManager` module handles serialization (timeline state → JSON) and deserialization (JSON → timeline rebuild). Audio files are referenced by relative+absolute paths, not embedded. The App tracks dirty state and prompts to save on destructive actions. Keyboard shortcuts are remapped: Cmd+S=save, Cmd+Shift+I=import audio.

**Tech Stack:** TypeScript, Vitest, Tauri dialog/fs APIs, JSON

**Spec:** `docs/specs/session-save-load.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/core/types.ts` | Modify | Add `SessionData`, `SessionAudioFile`, `SessionTrack`, `SessionClip` interfaces |
| `src/core/SessionManager.ts` | Create | `serializeSession()`, `deserializeSession()`, path resolution utilities |
| `tests/unit/SessionManager.test.ts` | Create | Tests for serialization, deserialization, path resolution |
| `src/ui/App.ts` | Modify | Keyboard shortcuts, save/load wiring, dirty state tracking, unsaved changes dialog |
| `src/utils/TauriAPI.ts` | Modify (minor) | Add `.fcs` filter constant if needed |

---

## Chunk 1: Data Types + Serialization

### Task 1: Define SessionData types

**Files:**
- Modify: `src/core/types.ts`

- [ ] **Step 1: Add session data interfaces after ProjectData (around line 100)**

```typescript
/* ─── Session File (.fcs) ─── */

export interface SessionAudioFile {
  id: string;
  relativePath: string;
  absolutePath: string;
  sampleRate: number;
  channels: number;
  numSamples: number;
}

export interface SessionClip {
  id: string;
  audioFileId: string;
  channelIndices: number[];   // which channels from the audio file (e.g. [0,1] for stereo)
  name: string;
  timelineOffset: number;
  sourceStart: number;
  sourceEnd: number;
  duration: number;
  gainDb: number;
  fadeInSamples: number;
  fadeOutSamples: number;
  fadeInCurve: number;
  fadeOutCurve: number;
  muted: boolean;
  reversed: boolean;
  crossfadeInSamples: number;
  crossfadeOutSamples: number;
  crossfadeType: 'equalPower' | 'equalGain';
}

export interface SessionTrack {
  id: string;
  name: string;
  color: string;
  channels: TrackChannelCount;
  volume: number;
  pan: number;
  mute: boolean;
  solo: boolean;
  channelIndex: number;
  height: number;
  clips: SessionClip[];
  inserts: SerializedTrackInsert[];
}

export interface SessionData {
  version: 1;
  app: 'FieldCorder';
  savedAt: string;
  sampleRate: number;
  playheadSample: number;
  fileBrowserPath: string | null;
  metadata: Record<string, unknown>;
  audioFiles: SessionAudioFile[];
  tracks: SessionTrack[];
}
```

- [ ] **Step 2: Run `npx tsc --noEmit`**

Expected: zero errors (types only, no implementation yet)

- [ ] **Step 3: Commit**

```bash
git add src/core/types.ts
git commit -m "feat: add SessionData types for .fcs session files"
```

---

### Task 2: Session serializer — tests (RED)

**Files:**
- Create: `tests/unit/SessionManager.test.ts`

- [ ] **Step 1: Write serialization tests**

```typescript
import { describe, it, expect } from 'vitest';
import {
  serializeSession,
  resolveAudioFilePaths,
  resolveRelativePath,
} from '../../src/core/SessionManager';
import type { Timeline, Track, Clip } from '../../src/core/types';

function makeClip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'c-1',
    bufferIds: ['buf-1'],
    name: 'test.wav',
    timelineOffset: 0,
    sourceStart: 0,
    sourceEnd: 48000,
    duration: 48000,
    gainDb: 0,
    fadeInSamples: 0,
    fadeOutSamples: 0,
    muted: false,
    ...overrides,
  };
}

function makeTrack(overrides: Partial<Track> = {}): Track {
  return {
    id: 't-1',
    name: 'Track 1',
    color: '#4A90D9',
    channels: 1 as const,
    clips: [makeClip()],
    volume: 0,
    pan: 0,
    mute: false,
    solo: false,
    channelIndex: 0,
    inserts: [],
    height: 80,
    ...overrides,
  };
}

function makeTimeline(overrides: Partial<Timeline> = {}): Timeline {
  return {
    sampleRate: 48000,
    totalLength: 48000,
    tracks: [makeTrack()],
    playheadSample: 0,
    selectionStart: null,
    selectionEnd: null,
    selectedClipIds: [],
    selectedTrackIds: [],
    samplesPerPixel: 100,
    scrollOffset: 0,
    ...overrides,
  };
}

describe('serializeSession', () => {
  it('serializes empty timeline', () => {
    const timeline = makeTimeline({ tracks: [] });
    const bufferSourceMap = new Map<string, { fileName: string; channelIndex: number }>();
    const result = serializeSession(timeline, bufferSourceMap, null, {}, null);
    expect(result.version).toBe(1);
    expect(result.app).toBe('FieldCorder');
    expect(result.sampleRate).toBe(48000);
    expect(result.tracks).toHaveLength(0);
    expect(result.audioFiles).toHaveLength(0);
  });

  it('serializes track with mono clip', () => {
    const timeline = makeTimeline();
    const bufferSourceMap = new Map([
      ['buf-1', { fileName: '/Users/x/audio.wav', channelIndex: 0 }],
    ]);
    const result = serializeSession(timeline, bufferSourceMap, null, {}, null);
    expect(result.audioFiles).toHaveLength(1);
    expect(result.audioFiles[0].absolutePath).toBe('/Users/x/audio.wav');
    expect(result.tracks).toHaveLength(1);
    expect(result.tracks[0].clips).toHaveLength(1);
    expect(result.tracks[0].clips[0].audioFileId).toBe(result.audioFiles[0].id);
    expect(result.tracks[0].clips[0].channelIndices).toEqual([0]);
  });

  it('serializes stereo clip with 2 bufferIds from same file', () => {
    const clip = makeClip({
      id: 'c-1',
      bufferIds: ['buf-L', 'buf-R'],
      name: 'stereo.wav',
    });
    const track = makeTrack({ channels: 2 as const, clips: [clip] });
    const timeline = makeTimeline({ tracks: [track] });
    const bufferSourceMap = new Map([
      ['buf-L', { fileName: '/Users/x/stereo.wav', channelIndex: 0 }],
      ['buf-R', { fileName: '/Users/x/stereo.wav', channelIndex: 1 }],
    ]);
    const result = serializeSession(timeline, bufferSourceMap, null, {}, null);
    // Same file → only 1 audioFile entry
    expect(result.audioFiles).toHaveLength(1);
    expect(result.tracks[0].clips[0].channelIndices).toEqual([0, 1]);
  });

  it('deduplicates audio files across tracks', () => {
    const clip1 = makeClip({ id: 'c-1', bufferIds: ['buf-1'] });
    const clip2 = makeClip({ id: 'c-2', bufferIds: ['buf-2'] });
    const track1 = makeTrack({ id: 't-1', clips: [clip1] });
    const track2 = makeTrack({ id: 't-2', clips: [clip2] });
    const timeline = makeTimeline({ tracks: [track1, track2] });
    const bufferSourceMap = new Map([
      ['buf-1', { fileName: '/Users/x/same.wav', channelIndex: 0 }],
      ['buf-2', { fileName: '/Users/x/same.wav', channelIndex: 0 }],
    ]);
    const result = serializeSession(timeline, bufferSourceMap, null, {}, null);
    expect(result.audioFiles).toHaveLength(1);
  });

  it('preserves track inserts', () => {
    const track = makeTrack({
      inserts: [{
        instanceId: 'inst-1',
        pluginId: 'builtin:eq7',
        parameters: [{ id: 0, name: 'band1Freq', value: 200, min: 20, max: 20000, defaultValue: 200 }],
        bypassed: false,
      }],
    });
    const timeline = makeTimeline({ tracks: [track] });
    const bufferSourceMap = new Map([
      ['buf-1', { fileName: '/Users/x/a.wav', channelIndex: 0 }],
    ]);
    const result = serializeSession(timeline, bufferSourceMap, null, {}, null);
    expect(result.tracks[0].inserts).toHaveLength(1);
    expect(result.tracks[0].inserts[0].pluginId).toBe('builtin:eq7');
  });

  it('preserves metadata', () => {
    const metadata = { project: 'MyProject', scene: '001' };
    const timeline = makeTimeline({ tracks: [] });
    const result = serializeSession(timeline, new Map(), null, metadata, null);
    expect(result.metadata).toEqual(metadata);
  });

  it('stores playhead position', () => {
    const timeline = makeTimeline({ playheadSample: 24000 });
    const result = serializeSession(timeline, new Map(), null, {}, null);
    expect(result.playheadSample).toBe(24000);
  });
});

describe('resolveRelativePath', () => {
  it('computes relative path from session dir to audio file', () => {
    const result = resolveRelativePath(
      '/Users/x/projects/session.fcs',
      '/Users/x/recordings/audio.wav'
    );
    expect(result).toBe('../recordings/audio.wav');
  });

  it('handles same directory', () => {
    const result = resolveRelativePath(
      '/Users/x/project/session.fcs',
      '/Users/x/project/audio.wav'
    );
    expect(result).toBe('audio.wav');
  });

  it('handles subdirectory', () => {
    const result = resolveRelativePath(
      '/Users/x/project/session.fcs',
      '/Users/x/project/audio/take1.wav'
    );
    expect(result).toBe('audio/take1.wav');
  });
});
```

- [ ] **Step 2: Run tests — confirm RED**

```bash
npm test -- --run tests/unit/SessionManager.test.ts
```
Expected: FAIL (module doesn't exist)

---

### Task 3: Session serializer — implementation (GREEN)

**Files:**
- Create: `src/core/SessionManager.ts`

- [ ] **Step 1: Implement serializeSession and path utilities**

```typescript
import type {
  Timeline, Clip, Track,
  SessionData, SessionAudioFile, SessionTrack, SessionClip,
  SerializedTrackInsert,
} from './types';

/**
 * Compute relative path from sessionFilePath's directory to targetPath.
 */
export function resolveRelativePath(sessionFilePath: string, targetPath: string): string {
  const sessionDir = sessionFilePath.substring(0, sessionFilePath.lastIndexOf('/'));
  const sessionParts = sessionDir.split('/');
  const targetParts = targetPath.split('/');

  // Find common prefix length
  let common = 0;
  while (common < sessionParts.length && common < targetParts.length
    && sessionParts[common] === targetParts[common]) {
    common++;
  }

  const ups = sessionParts.length - common;
  const rest = targetParts.slice(common);
  const parts = [...Array(ups).fill('..'), ...rest];
  return parts.join('/');
}

/**
 * Resolve a relative path against session file location.
 */
export function resolveAbsolutePath(sessionFilePath: string, relativePath: string): string {
  const sessionDir = sessionFilePath.substring(0, sessionFilePath.lastIndexOf('/'));
  const parts = sessionDir.split('/');
  for (const seg of relativePath.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

interface BufferSourceInfo {
  fileName: string;       // absolute path of source audio file
  channelIndex: number;   // which channel in that file
  sampleRate?: number;
  numSamples?: number;
  numChannels?: number;
}

/**
 * Serialize the current session state to a SessionData object.
 */
export function serializeSession(
  timeline: Timeline,
  bufferSourceMap: Map<string, BufferSourceInfo>,
  sessionFilePath: string | null,
  metadata: Record<string, unknown>,
  fileBrowserPath: string | null,
): SessionData {
  // 1. Collect unique audio files from all clips
  const audioFileMap = new Map<string, SessionAudioFile>(); // keyed by absolutePath
  let afIdCounter = 0;

  function getOrCreateAudioFile(absolutePath: string, info: BufferSourceInfo): SessionAudioFile {
    let af = audioFileMap.get(absolutePath);
    if (!af) {
      af = {
        id: `af-${++afIdCounter}`,
        relativePath: sessionFilePath
          ? resolveRelativePath(sessionFilePath, absolutePath)
          : absolutePath,
        absolutePath,
        sampleRate: info.sampleRate ?? timeline.sampleRate,
        channels: info.numChannels ?? 1,
        numSamples: info.numSamples ?? 0,
      };
      audioFileMap.set(absolutePath, af);
    }
    return af;
  }

  // 2. Serialize tracks
  const sessionTracks: SessionTrack[] = timeline.tracks.map(track => {
    const sessionClips: SessionClip[] = track.clips.map(clip => {
      // Find the audio file for this clip's buffers
      let audioFileId = '';
      const channelIndices: number[] = [];

      for (const bufferId of clip.bufferIds) {
        const info = bufferSourceMap.get(bufferId);
        if (info) {
          const af = getOrCreateAudioFile(info.fileName, info);
          audioFileId = af.id;
          channelIndices.push(info.channelIndex);
          // Update audio file channel count if needed
          if (info.channelIndex + 1 > af.channels) {
            af.channels = info.channelIndex + 1;
          }
        }
      }

      return {
        id: clip.id,
        audioFileId,
        channelIndices,
        name: clip.name,
        timelineOffset: clip.timelineOffset,
        sourceStart: clip.sourceStart,
        sourceEnd: clip.sourceEnd,
        duration: clip.duration,
        gainDb: clip.gainDb,
        fadeInSamples: clip.fadeInSamples,
        fadeOutSamples: clip.fadeOutSamples,
        fadeInCurve: clip.fadeInCurve ?? 0,
        fadeOutCurve: clip.fadeOutCurve ?? 0,
        muted: clip.muted,
        reversed: clip.reversed ?? false,
        crossfadeInSamples: clip.crossfadeInSamples ?? 0,
        crossfadeOutSamples: clip.crossfadeOutSamples ?? 0,
        crossfadeType: clip.crossfadeType ?? 'equalPower',
      };
    });

    // Serialize inserts (reuse existing SerializedTrackInsert format)
    const inserts: SerializedTrackInsert[] = track.inserts.map(ins => ({
      pluginId: ins.pluginId,
      parameters: ins.parameters.map(p => ({
        id: p.id,
        name: p.name,
        value: p.value,
        min: p.min,
        max: p.max,
        defaultValue: p.defaultValue,
        unit: p.unit,
      })),
      bypassed: ins.bypassed,
    }));

    return {
      id: track.id,
      name: track.name,
      color: track.color,
      channels: track.channels,
      volume: track.volume,
      pan: track.pan,
      mute: track.mute,
      solo: track.solo,
      channelIndex: track.channelIndex,
      height: track.height,
      clips: sessionClips,
      inserts,
    };
  });

  return {
    version: 1,
    app: 'FieldCorder',
    savedAt: new Date().toISOString(),
    sampleRate: timeline.sampleRate,
    playheadSample: timeline.playheadSample,
    fileBrowserPath,
    metadata,
    audioFiles: Array.from(audioFileMap.values()),
    tracks: sessionTracks,
  };
}
```

- [ ] **Step 2: Run tests — confirm GREEN**

```bash
npm test -- --run tests/unit/SessionManager.test.ts
```

- [ ] **Step 3: Run type check**

```bash
npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add src/core/SessionManager.ts src/core/types.ts tests/unit/SessionManager.test.ts
git commit -m "feat: session serializer with audio file deduplication and path resolution"
```

---

## Chunk 2: Deserialization + App Integration

### Task 4: Session deserializer — tests (RED)

**Files:**
- Modify: `tests/unit/SessionManager.test.ts`

- [ ] **Step 1: Add deserialization tests**

```typescript
import { deserializeSession } from '../../src/core/SessionManager';
import type { SessionData } from '../../src/core/types';

function makeSessionData(overrides: Partial<SessionData> = {}): SessionData {
  return {
    version: 1,
    app: 'FieldCorder',
    savedAt: '2026-03-19T12:00:00Z',
    sampleRate: 48000,
    playheadSample: 0,
    fileBrowserPath: null,
    metadata: {},
    audioFiles: [],
    tracks: [],
    ...overrides,
  };
}

describe('deserializeSession', () => {
  it('returns empty timeline for empty session', () => {
    const session = makeSessionData();
    const result = deserializeSession(session);
    expect(result.timeline.tracks).toHaveLength(0);
    expect(result.timeline.sampleRate).toBe(48000);
    expect(result.audioFilesToLoad).toHaveLength(0);
  });

  it('reconstructs track with clip referencing audio file', () => {
    const session = makeSessionData({
      audioFiles: [{
        id: 'af-1',
        relativePath: 'audio.wav',
        absolutePath: '/Users/x/audio.wav',
        sampleRate: 48000,
        channels: 1,
        numSamples: 48000,
      }],
      tracks: [{
        id: 't-1', name: 'Track 1', color: '#4A90D9',
        channels: 1, volume: 0, pan: 0, mute: false, solo: false,
        channelIndex: 0, height: 80, inserts: [],
        clips: [{
          id: 'c-1', audioFileId: 'af-1', channelIndices: [0],
          name: 'audio.wav', timelineOffset: 0,
          sourceStart: 0, sourceEnd: 48000, duration: 48000,
          gainDb: 0, fadeInSamples: 0, fadeOutSamples: 0,
          fadeInCurve: 0, fadeOutCurve: 0,
          muted: false, reversed: false,
          crossfadeInSamples: 0, crossfadeOutSamples: 0,
          crossfadeType: 'equalPower',
        }],
      }],
    });
    const result = deserializeSession(session);
    expect(result.timeline.tracks).toHaveLength(1);
    expect(result.timeline.tracks[0].clips).toHaveLength(1);
    // Clip gets placeholder bufferIds (resolved during audio load)
    expect(result.timeline.tracks[0].clips[0].bufferIds).toEqual(['af-1:0']);
    expect(result.audioFilesToLoad).toHaveLength(1);
    expect(result.audioFilesToLoad[0].absolutePath).toBe('/Users/x/audio.wav');
  });

  it('preserves plugin inserts', () => {
    const session = makeSessionData({
      tracks: [{
        id: 't-1', name: 'T', color: '#fff', channels: 1,
        volume: 0, pan: 0, mute: false, solo: false,
        channelIndex: 0, height: 80, clips: [],
        inserts: [{
          pluginId: 'builtin:eq7',
          parameters: [{ id: 0, name: 'band1Freq', value: 300, min: 20, max: 20000, defaultValue: 200 }],
          bypassed: true,
        }],
      }],
    });
    const result = deserializeSession(session);
    expect(result.timeline.tracks[0].inserts).toHaveLength(1);
    expect(result.timeline.tracks[0].inserts[0].pluginId).toBe('builtin:eq7');
    expect(result.timeline.tracks[0].inserts[0].bypassed).toBe(true);
  });

  it('restores playhead position', () => {
    const session = makeSessionData({ playheadSample: 24000 });
    const result = deserializeSession(session);
    expect(result.timeline.playheadSample).toBe(24000);
  });
});

describe('resolveAbsolutePath', () => {
  it('resolves relative path against session directory', () => {
    const result = resolveAbsolutePath(
      '/Users/x/projects/session.fcs',
      '../recordings/audio.wav'
    );
    expect(result).toBe('/Users/x/recordings/audio.wav');
  });

  it('resolves same-directory file', () => {
    const result = resolveAbsolutePath(
      '/Users/x/project/session.fcs',
      'audio.wav'
    );
    expect(result).toBe('/Users/x/project/audio.wav');
  });
});
```

- [ ] **Step 2: Run tests — confirm RED**

```bash
npm test -- --run tests/unit/SessionManager.test.ts
```

---

### Task 5: Session deserializer — implementation (GREEN)

**Files:**
- Modify: `src/core/SessionManager.ts`

- [ ] **Step 1: Implement deserializeSession**

```typescript
import type { Timeline, Track, Clip, TrackInsert, PluginParameter } from './types';

interface AudioFileToLoad {
  id: string;
  relativePath: string;
  absolutePath: string;
  sampleRate: number;
  channels: number;
  numSamples: number;
}

interface DeserializedSession {
  timeline: Timeline;
  metadata: Record<string, unknown>;
  fileBrowserPath: string | null;
  audioFilesToLoad: AudioFileToLoad[];
}

export function deserializeSession(session: SessionData): DeserializedSession {
  const audioFilesToLoad: AudioFileToLoad[] = session.audioFiles.map(af => ({
    id: af.id,
    relativePath: af.relativePath,
    absolutePath: af.absolutePath,
    sampleRate: af.sampleRate,
    channels: af.channels,
    numSamples: af.numSamples,
  }));

  const tracks: Track[] = session.tracks.map(st => {
    const clips: Clip[] = st.clips.map(sc => ({
      id: sc.id,
      // Placeholder bufferIds: "af-1:0", "af-1:1" etc.
      // Will be replaced with real buffer pool IDs after audio loading
      bufferIds: sc.channelIndices.map(ch => `${sc.audioFileId}:${ch}`),
      name: sc.name,
      timelineOffset: sc.timelineOffset,
      sourceStart: sc.sourceStart,
      sourceEnd: sc.sourceEnd,
      duration: sc.duration,
      gainDb: sc.gainDb,
      fadeInSamples: sc.fadeInSamples,
      fadeOutSamples: sc.fadeOutSamples,
      fadeInCurve: sc.fadeInCurve,
      fadeOutCurve: sc.fadeOutCurve,
      muted: sc.muted,
      reversed: sc.reversed,
      crossfadeInSamples: sc.crossfadeInSamples,
      crossfadeOutSamples: sc.crossfadeOutSamples,
      crossfadeType: sc.crossfadeType,
    }));

    const inserts: TrackInsert[] = st.inserts.map(si => ({
      instanceId: '',  // Will be assigned when plugins are created
      pluginId: si.pluginId,
      parameters: si.parameters.map(p => ({ ...p } as PluginParameter)),
      bypassed: si.bypassed,
    }));

    return {
      id: st.id,
      name: st.name,
      color: st.color,
      channels: st.channels,
      clips,
      volume: st.volume,
      pan: st.pan,
      mute: st.mute,
      solo: st.solo,
      channelIndex: st.channelIndex,
      inserts,
      height: st.height,
    };
  });

  const totalLength = tracks.reduce((max, t) => {
    for (const c of t.clips) {
      const end = c.timelineOffset + c.duration;
      if (end > max) max = end;
    }
    return max;
  }, 0);

  const timeline: Timeline = {
    sampleRate: session.sampleRate,
    totalLength,
    tracks,
    playheadSample: session.playheadSample,
    selectionStart: null,
    selectionEnd: null,
    selectedClipIds: [],
    selectedTrackIds: [],
    samplesPerPixel: 100,
    scrollOffset: 0,
  };

  return {
    timeline,
    metadata: session.metadata as Record<string, unknown>,
    fileBrowserPath: session.fileBrowserPath,
    audioFilesToLoad,
  };
}
```

- [ ] **Step 2: Run tests — confirm GREEN**

```bash
npm test -- --run tests/unit/SessionManager.test.ts
```

- [ ] **Step 3: Commit**

```bash
git add src/core/SessionManager.ts tests/unit/SessionManager.test.ts
git commit -m "feat: session deserializer with placeholder bufferIds and audio file list"
```

---

### Task 6: Keyboard shortcuts + dirty state + save/load in App.ts

**Files:**
- Modify: `src/ui/App.ts`

- [ ] **Step 1: Change Cmd+O to Cmd+Shift+I for audio import**

In `handleKeyboard()` (around line 1364-1513), find the `case 'o':` block and change it:

```typescript
// OLD:
case 'o':
  e.preventDefault();
  this.openImportDialog();
  return;

// NEW:
case 'i':
  if (e.shiftKey) {
    e.preventDefault();
    this.openImportDialog();
  }
  return;
```

- [ ] **Step 2: Add Cmd+S and Cmd+Shift+S**

```typescript
case 's':
  e.preventDefault();
  if (e.shiftKey) {
    this.saveSessionAs();
  } else {
    this.saveSession();
  }
  return;
```

- [ ] **Step 3: Update Cmd+N to use session-aware new project**

The existing `case 'n':` already calls `this.confirmNewProject()`. Verify it handles unsaved changes (it likely already does via `showConfirmDialog`). No change needed if it already prompts.

- [ ] **Step 4: Add dirty state tracking**

```typescript
// New properties on App class:
private _sessionFilePath: string | null = null;
private _sessionDirty: boolean = false;

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
    ? this._sessionFilePath.split('/').pop()!.replace('.fcs', '')
    : 'Untitled';
  const dirty = this._sessionDirty ? ' *' : '';
  document.title = `${name}${dirty} — FieldCorder`;
}
```

Call `this.markDirty()` after every undo-able action (easiest: hook into `timelineUndoManager.push()`).

- [ ] **Step 5: Implement saveSession / saveSessionAs**

```typescript
async saveSession(): Promise<void> {
  if (!this._sessionFilePath) {
    await this.saveSessionAs();
    return;
  }
  await this._writeSession(this._sessionFilePath);
}

async saveSessionAs(): Promise<void> {
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
    this._getFileBrowserPath(),
  );
  const json = JSON.stringify(sessionData, null, 2);
  await window.appAPI.writeFileText(path, json);
  this._sessionFilePath = path;
  this.markClean();
}

private _buildBufferSourceMap(): Map<string, BufferSourceInfo> {
  // Build map from bufferId → { fileName, channelIndex }
  // by iterating over bufferPool entries
  const map = new Map<string, { fileName: string; channelIndex: number }>();
  for (const [id, pooled] of this.bufferPool.entries()) {
    map.set(id, {
      fileName: pooled.sourceFileName,
      channelIndex: pooled.sourceChannelIndex,
    });
  }
  return map;
}
```

- [ ] **Step 6: Implement openSession**

```typescript
async openSession(): Promise<void> {
  // Check for unsaved changes
  if (this._sessionDirty) {
    const save = await this.showThreeWayDialog(
      'Save changes?',
      'Current session has unsaved changes.',
      'Save', "Don't Save", 'Cancel'
    );
    if (save === 'cancel') return;
    if (save === 'save') await this.saveSession();
  }

  const paths = await window.appAPI.showOpenDialog({
    title: 'Open Session',
    filters: [{ name: 'FieldCorder Session', extensions: ['fcs'] }],
    multiple: false,
  });
  if (!paths || paths.length === 0) return;
  await this._loadSession(paths[0]);
}

private async _loadSession(path: string): Promise<void> {
  const json = await window.appAPI.readFileText(path);
  const sessionData: SessionData = JSON.parse(json);

  // Validate
  if (sessionData.version !== 1 || sessionData.app !== 'FieldCorder') {
    throw new Error('Invalid session file');
  }

  // Deserialize
  const { timeline, metadata, fileBrowserPath, audioFilesToLoad } =
    deserializeSession(sessionData);

  // Clear current state
  this.newBlankProject();

  // Load audio files
  const bufferIdMapping = new Map<string, string>(); // placeholder → real ID
  for (const af of audioFilesToLoad) {
    // Try relative path first, then absolute
    let filePath = resolveAbsolutePath(path, af.relativePath);
    let loaded = false;
    try {
      const bufferIds = await this._loadAudioFile(filePath, af);
      this._mapBufferIds(af, bufferIds, bufferIdMapping);
      loaded = true;
    } catch {
      // Try absolute path
      try {
        const bufferIds = await this._loadAudioFile(af.absolutePath, af);
        this._mapBufferIds(af, bufferIds, bufferIdMapping);
        loaded = true;
      } catch { /* fall through to relink */ }
    }

    if (!loaded) {
      // Prompt user to locate the file
      const newPaths = await window.appAPI.showOpenDialog({
        title: `Locate missing file: ${af.relativePath}`,
        filters: [{ name: 'Audio Files', extensions: ['wav', 'aif', 'aiff', 'mp3'] }],
        multiple: false,
      });
      if (newPaths && newPaths.length > 0) {
        const bufferIds = await this._loadAudioFile(newPaths[0], af);
        this._mapBufferIds(af, bufferIds, bufferIdMapping);
      }
      // If user cancels, clip will have broken references
    }
  }

  // Replace placeholder bufferIds with real ones
  for (const track of timeline.tracks) {
    for (const clip of track.clips) {
      clip.bufferIds = clip.bufferIds.map(placeholder =>
        bufferIdMapping.get(placeholder) ?? placeholder
      );
    }
  }

  // Apply timeline
  this.timelineModel.timeline = timeline;
  this.timelineModel.timeline.sampleRate = sessionData.sampleRate;

  // Restore metadata
  this._setSessionMetadata(metadata);
  if (fileBrowserPath) this._setFileBrowserPath(fileBrowserPath);

  // Rebuild audio routing and plugins
  this.audioEngine.setupTrackRouting(timeline.tracks);
  await this._restorePluginInserts(timeline.tracks);
  this.mixer.setupTracks(timeline.tracks);

  // Update UI
  this._sessionFilePath = path;
  this.markClean();
  this.timelineUndoManager.clear();
  this.render();
}

private _mapBufferIds(
  af: AudioFileToLoad,
  realBufferIds: string[],
  mapping: Map<string, string>
): void {
  for (let ch = 0; ch < realBufferIds.length; ch++) {
    mapping.set(`${af.id}:${ch}`, realBufferIds[ch]);
  }
}
```

- [ ] **Step 7: Add File → Open Session menu item**

Wire `openSession()` to a menu button or menu item in the UI.

- [ ] **Step 8: Add .fcs double-click in file browser**

In the file browser click handler, detect `.fcs` extension and call `_loadSession(path)` instead of importing as audio.

- [ ] **Step 9: Run full validation**

```bash
npx tsc --noEmit
npm test -- --run
```

- [ ] **Step 10: Commit**

```bash
git commit -am "feat: session save/load with Cmd+S, Cmd+Shift+S, dirty tracking, file relinking"
```

---

### Task 7: Final verification

- [ ] **Step 1: Type check**

```bash
npx tsc --noEmit
```

- [ ] **Step 2: All tests**

```bash
npm test -- --run
```

- [ ] **Step 3: Build**

```bash
npm run build:frontend
```

- [ ] **Step 4: Manual verification 🔍**

```bash
npm run tauri:dev
```

Verify:
- Cmd+Shift+I opens import dialog (was Cmd+O)
- Cmd+S on empty project → Save As dialog → creates .fcs file
- Cmd+S again → overwrites silently
- Cmd+Shift+S → always shows Save As dialog
- Close and reopen → open .fcs → timeline restored
- Move .fcs to different folder → open → audio loads via absolute path fallback
- Delete source audio → open .fcs → prompted to locate file
- Title bar shows "filename *" when dirty, "filename" when clean
- Cmd+N with unsaved changes → Save/Don't Save/Cancel dialog
- File browser double-click on .fcs → opens session

- [ ] **Step 5: Commit**

```bash
git commit -am "verify: session save/load complete 🔍"
```
