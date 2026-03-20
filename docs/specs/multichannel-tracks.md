# Spec: Multi-channel Tracks

> Date: 2026-03-03 (original) — Updated: 2026-03-17
> Status: Approved (Phase 1 + 2 implemented; data model superseded by Round 5 decisions)
> Scope: Phase 1 (core model + display) + Phase 2 (drag interactions + import)

---

## Data Model (Current — as of 2026-03-17)

> The Phase 1 + 2 spec below was implemented but the Clip interface changed after the
> **Round 5 interview** (`round5-interview-decisions.md` §1). The authoritative types are in
> `src/core/types.ts`. Key differences from the original spec:
>
> - `Clip.subChannel` — **removed**. Sub-channel assignment via Y position is no longer allowed.
> - `Clip.groupId` — **removed** (was in `clip-group.md`). The concept is replaced by `bufferIds[]`.
> - `Clip.bufferIds: string[]` — **replaces** the old `Clip.bufferId: string`. One buffer ID per
>   channel; `bufferIds.length` always equals the track's `channels` count.
> - **Strict channel matching** — a clip can only be placed on a track whose `channels` value equals
>   `clip.bufferIds.length`. No mono clip on a stereo track. No stereo clip on a mono track.

### Current `Clip` interface (from `src/core/types.ts`)

```typescript
export interface Clip {
  id: string;
  /** One buffer ID per channel. Length must equal the track's channel count. */
  bufferIds: string[];
  name: string;
  timelineOffset: number;
  sourceStart: number;
  sourceEnd: number;
  duration: number;
  gainDb: number;
  fadeInSamples: number;
  fadeOutSamples: number;
  fadeInCurve?: number;          // -1 to 1, default 0 (linear)
  fadeOutCurve?: number;         // -1 to 1, default 0 (linear)
  muted: boolean;
  reversed?: boolean;
  crossfadeInSamples?: number;
  crossfadeOutSamples?: number;
  crossfadeType?: 'equalPower' | 'equalGain';
}
```

### Current `Track` interface (from `src/core/types.ts`)

```typescript
export interface Track {
  id: string;
  name: string;
  color: string;
  channels: TrackChannelCount;   // 1 | 2 | 4 | 5 | 6
  clips: Clip[];
  volume: number;
  pan: number;
  mute: boolean;
  solo: boolean;
  channelIndex: number;
  inserts: TrackInsert[];
  height: number;                // per-track height in px, default 80
}
```

---

## Cross-track Split / Merge (Current Behavior)

### Split: stereo clip → mono tracks

When a stereo clip is dragged onto a mono track:

- If there are 2 mono tracks available: `bufferIds[0]` → Track A, `bufferIds[1]` → Track B.
- If only 1 mono track exists: create a second mono track automatically at the bottom, then split.
- The original stereo clip is removed.

### Split: quad (4ch) clip → stereo tracks or mono tracks

- Quad → 2x stereo: `bufferIds[0,1]` → new stereo clip on Track A, `bufferIds[2,3]` → new stereo
  clip on Track B.
- Quad → 4x mono: each `bufferIds[i]` → one mono clip on a separate mono track.

### Merge: 2 mono clips → stereo clip

- Select 2 mono clips → right-click → "Merge to stereo track".
- A new stereo clip is created with `bufferIds = [monoClip1.bufferIds[0], monoClip2.bufferIds[0]]`.
- The two source mono clips are removed.
- Undo restores both source clips and removes the stereo clip.

### Incompatible drag (channel mismatch)

- Mono clip dragged onto stereo track: **rejected**. Red overlay shown over the ghost clip.
- Stereo clip dragged onto mono track: triggers the split flow above.
- Any other channel-count mismatch that cannot be handled by split/merge: **rejected**.

---

## Overview

Add multi-channel track support to FieldCorder. A Track can be Mono (1ch), Stereo (2ch), Quad (4ch),
or 5.1 (6ch). The channel count is fixed per track; clips must match the track's channel count.

## Design Decisions (from interview)

| Question | Decision |
|----------|----------|
| Default import behavior | Poly WAV creates matching multi-channel track |
| Mono clip → stereo track | Rejected (red overlay) — strict channel matching |
| Track display | Fixed base height, sub-channels shown Audacity-style (stacked vertically) |
| Track height | Resizable via drag (independent feature) |
| Split/Merge workflow | Stereo drag → mono track triggers split; right-click 2 mono clips → merge |
| Mixer volume | Single fader per track |
| Mixer pan | Mono = position, Stereo = balance |
| Mixer meter | Stereo = dual peak bars |
| Mono plugin on stereo track | Dual Mono (Phase 3, not this spec) |
| Supported types | Mono, Stereo, Quad, 5.1 |

---

## Phase 1: Core Model + Display

### 1.1 Type Changes

#### `types.ts` — Track interface

```typescript
export type TrackChannelCount = 1 | 2 | 4 | 5 | 6;

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
  height: number;               // per-track height in px, default 80
}
```

#### `types.ts` — Clip interface

See the **Current** section above. The old `subChannel` and `groupId` fields are not present.

### 1.2 TimelineModel Changes

#### `addTrack()` — accept `channels` parameter

```typescript
addTrack(name: string, color: string, channelIndex: number, channels: TrackChannelCount = 1): Track
```

#### `importMultiChannelFile()` — behavior

- Creates 1 track with `channels = N` (for N = 1, 2, 4, 6).
- Creates 1 clip with `bufferIds` of length N (one buffer ID per channel).
- For unsupported channel counts (3, 5, 7, 8+): fall back to N mono tracks, each with a
  single-element `bufferIds` array.

### 1.3 TimelineRenderer Changes

#### Variable track height

```typescript
// Precompute cumulative heights
private trackTops: number[] = [];
private totalTrackHeight = 0;

private recomputeTrackLayout(): void {
  if (!this.timeline) return;
  this.trackTops = [];
  let y = 0;
  for (const track of this.timeline.tracks) {
    this.trackTops.push(y);
    y += track.height;
  }
  this.totalTrackHeight = y;
}
```

#### `yToTrackIndex()`

```typescript
private yToTrackIndex(y: number): number {
  if (y < RULER_HEIGHT) return -1;
  const localY = y - RULER_HEIGHT + this.scrollOffsetY;
  for (let i = 0; i < this.trackTops.length; i++) {
    const top = this.trackTops[i];
    const height = this.timeline!.tracks[i].height;
    if (localY >= top && localY < top + height) return i;
  }
  return this.trackTops.length;
}
```

#### Multi-channel waveform rendering

Each sub-lane renders the waveform for `bufferIds[i]`:

```
Stereo Track (120px height):
┌──────────────────────────────┐
│  L waveform (blue)      60px │
│──────────────────────────────│ ← 1px divider
│  R waveform (green)     60px │
└──────────────────────────────┘
```

#### Crossfade rendering (Pro Tools style)

In the crossfade zone both clips' waveforms are drawn overlapping with semi-transparency.
The outgoing clip's waveform extends rightward into the crossfade region; the incoming clip's
waveform extends leftward. Each is rendered at reduced opacity so both are visible simultaneously.

#### Track height resize handle

- 3px hit zone at the bottom edge of each track header.
- Cursor: `ns-resize`.
- Minimum height: `channels * 24` px.
- DragMode: `'trackResize'`.

### 1.4 Track Header Display

```
┌─────────────────┐
│ ● Ambience       │
│ [ST] M S         │  ← [ST] badge, M/S buttons
│ ▍▍▍▍▍▍ meter     │  ← dual peak for stereo
└─────────────────┘
```

Badges: `[M]` mono, `[ST]` stereo, `[Q]` quad, `[5.1]` surround

### 1.5 Create Track Dialog

```
┌──────────────────────────────────┐
│  New Track                       │
│                                  │
│  Name: [Track N+1         ]      │
│  Type: [Mono ▾]                  │
│        Mono / Stereo / Quad / 5.1│
│                                  │
│  [Cancel]  [Create]              │
└──────────────────────────────────┘
```

Triggered by: `Cmd+Shift+N` or right-click track header → "New Track..."

---

## Phase 2: Drag Interactions + Import

### 2.1 File Browser Drag to Multi-channel Track

#### Poly WAV → empty area
- Create 1 track with `channels` matching the file's channel count.
- Create 1 clip with `bufferIds` of length N.

#### Stereo file → existing stereo track
- Create 1 clip with `bufferIds = [leftBufferId, rightBufferId]`.

#### Poly WAV → existing track with mismatched channels
- If the clip channel count ≠ track channel count: trigger split flow or reject (see
  Cross-track Split / Merge above).

### 2.2 Drop Preview Update

- For incompatible channel-count drops: red overlay on the ghost clip.
- For compatible drops: blue highlight on target track.

### 2.3 Internal Clip Drag (within timeline)

- Dragging within the same multi-channel track: time position changes, channel count is unchanged.
- Dragging stereo clip to mono track: triggers split (see Cross-track Split / Merge).
- Dragging mono clip to stereo track: rejected with red overlay.

### 2.4 Import from Double-click (File Browser)

- Poly WAV (2/4/6 ch): create 1 multi-channel track with correct type.
- Mono WAV: create 1 mono track.
- Unsupported channel count: fall back to N mono tracks.

---

## Files Modified

| File | Changes |
|------|---------|
| `src/core/types.ts` | `TrackChannelCount`, `Track.channels`, `Track.height`, `Clip.bufferIds` (replaced `bufferId`) |
| `src/core/TimelineModel.ts` | Updated `addTrack()`, `importMultiChannelFile()`, `importFileAtPosition()` |
| `src/editor/TimelineRenderer.ts` | Variable height layout, multi-channel waveform, resize handle, crossfade overlap rendering |
| `src/ui/App.ts` | Create track dialog, drag channel enforcement, red overlay on mismatch |
| `src/utils/TimelineUndoManager.ts` | Commands updated for new Clip fields |

## Out of Scope (Phase 3+4)

- Dual Mono plugin processing
- Stereo balance pan behavior in AudioEngine
- Dual peak meter in Mixer
- Project file serialization of channel info

---

## Verification

```bash
npx tsc --noEmit           # zero type errors
npm test -- --run           # all green
```

Manual testing:
- Create stereo/quad/5.1 empty track via dialog
- Import poly WAV → creates correct multi-channel track (1 clip, bufferIds.length = N)
- Drag stereo clip to mono track → split into 2 mono clips
- Drag mono clip to stereo track → red overlay, drop rejected
- Right-click 2 mono clips → "Merge to stereo track"
- Crossfade zone shows both waveforms overlapping
- Resize track height by dragging bottom edge
- Undo/redo works for split, merge, import
