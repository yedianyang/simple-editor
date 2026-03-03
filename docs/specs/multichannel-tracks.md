# Spec: Multi-channel Tracks (Phase 1 + 2)

> Date: 2026-03-03
> Status: Approved
> Scope: Phase 1 (core model + display) + Phase 2 (drag interactions + import)

---

## Overview

Add multi-channel track support to FieldCorder. A Track can be Mono (1ch), Stereo (2ch), Quad (4ch), or 5.1 (6ch). Clips are freely placed onto any track; mono clips dragged into a stereo track are assigned to a sub-channel based on Y position (Pro Tools style).

## Design Decisions (from interview)

| Question | Decision |
|----------|----------|
| Default import behavior | Poly WAV creates matching multi-channel track (B) |
| Mono clip → stereo track | Y position determines channel (Pro Tools style) |
| Track display | Fixed base height, sub-channels shown Audacity-style (stacked vertically) |
| Track height | Resizable via drag (independent feature, also benefits mono) |
| Split/Merge workflow | Split multichannel → mono tracks; drag clips back to merge (Phase 4, not this spec) |
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
export type TrackChannelCount = 1 | 2 | 4 | 6;

export interface Track {
  id: string;
  name: string;
  color: string;
  channels: TrackChannelCount;  // NEW — default 1
  clips: Clip[];
  volume: number;
  pan: number;                  // mono: position [-1,1]; stereo: balance [-1,1]
  mute: boolean;
  solo: boolean;
  channelIndex: number;
  inserts: TrackInsert[];
  height: number;               // NEW — per-track height in px, default 80
}
```

#### `types.ts` — Clip interface

```typescript
export interface Clip {
  id: string;
  bufferId: string;
  name: string;
  timelineOffset: number;
  sourceStart: number;
  sourceEnd: number;
  duration: number;
  gainDb: number;
  fadeInSamples: number;
  fadeOutSamples: number;
  muted: boolean;
  reversed?: boolean;
  subChannel?: number;          // NEW — which sub-channel within a multi-ch track (0-based)
                                // undefined = ch 0 for mono clips, or "all" for matching-ch clips
}
```

### 1.2 TimelineModel Changes

#### `addTrack()` — accept `channels` parameter

```typescript
addTrack(name: string, color: string, channelIndex: number, channels: TrackChannelCount = 1): Track
```

- Set `track.channels = channels`
- Set `track.height = 80` (default)

#### `addEmptyTrack()` → `addEmptyTrack(channels: TrackChannelCount = 1)`

Accept channel count parameter.

#### `importMultiChannelFile()` — update behavior

Currently creates N mono tracks from N-channel file. New behavior:
- Create 1 track with `channels = N` (for N = 1, 2, 4, 6)
- Create N clips each with `subChannel = i`, all using per-channel bufferIds
- For unsupported channel counts (3, 5, 7, 8+): fall back to N mono tracks

#### `importFileAtPosition()` — same update

When importing poly WAV at a position:
- If channel count is 1/2/4/6: create 1 multi-channel track
- Clips get `subChannel` assigned

### 1.3 TimelineRenderer Changes

#### Variable track height

Replace all `TRACK_HEIGHT` constant usage with `track.height`:

```typescript
// Before
const topY = RULER_HEIGHT + trackIndex * TRACK_HEIGHT;

// After — precompute cumulative heights
private trackTops: number[] = [];   // cached Y offset per track
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

Call `recomputeTrackLayout()` in `render()` (before drawing) and after any track height change.

#### `yToTrackIndex()` — binary search or linear scan

```typescript
private yToTrackIndex(y: number): number {
  if (y < RULER_HEIGHT) return -1;
  const localY = y - RULER_HEIGHT + this.scrollOffsetY;
  for (let i = 0; i < this.trackTops.length; i++) {
    const top = this.trackTops[i];
    const height = this.timeline!.tracks[i].height;
    if (localY >= top && localY < top + height) return i;
  }
  return this.trackTops.length; // below all tracks
}
```

#### Sub-channel Y detection within a multi-channel track

```typescript
/** Given a canvas-local Y inside a multi-ch track, return the sub-channel index (0-based). */
private yToSubChannel(y: number, trackIndex: number): number {
  const track = this.timeline!.tracks[trackIndex];
  if (track.channels <= 1) return 0;
  const trackTopY = RULER_HEIGHT + this.trackTops[trackIndex] - this.scrollOffsetY;
  const relativeY = y - trackTopY;
  const laneHeight = track.height / track.channels;
  return Math.min(track.channels - 1, Math.max(0, Math.floor(relativeY / laneHeight)));
}
```

#### Multi-channel waveform rendering

In `renderClipWaveform()`, for clips on a multi-channel track:
- Divide the track lane into N horizontal sub-lanes
- Each sub-lane renders the waveform of clips assigned to that sub-channel
- Sub-lanes separated by a thin 1px divider line (`rgba(255,255,255,0.1)`)
- Use `CHANNEL_COLORS[subChannel]` for waveform color

```
Stereo Track (120px height):
┌──────────────────────────────┐
│  L waveform (blue)      60px │
│──────────────────────────────│ ← 1px divider
│  R waveform (green)     60px │
└──────────────────────────────┘
```

#### Track height resize handle

- 3px hit zone at the bottom edge of each track header
- Cursor changes to `ns-resize`
- Drag to resize, minimum height: `channels * 24` px
- New DragMode: `'trackResize'`
- On drag end, update `track.height` and re-render

### 1.4 Track Header Display

For multi-channel tracks, show channel type badge:

```
┌─────────────────┐
│ ● Ambience       │
│ [ST] M S         │  ← [ST] badge, M/S buttons
│ ▍▍▍▍▍▍ meter     │  ← dual peak for stereo
└─────────────────┘
```

Badges: `[M]` mono, `[ST]` stereo, `[Q]` quad, `[5.1]` surround

### 1.5 Create Track Dialog

New track creation UI, triggered by:
- `Cmd+Shift+N` keyboard shortcut
- Right-click on track header area → "New Track..."

Dialog content:
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

---

## Phase 2: Drag Interactions + Import

### 2.1 File Browser Drag to Multi-channel Track

When dragging a file from the File Browser onto the timeline:

#### Poly WAV → empty area
- Create a new track with `channels` matching the file's channel count
- Create N clips (one per channel) with `subChannel = 0..N-1`

#### Mono file → existing stereo track
- Determine sub-channel from Y position (`yToSubChannel()`)
- Create clip with `subChannel = detected`

#### Stereo file → existing stereo track
- Create 2 clips: `subChannel = 0` (L) and `subChannel = 1` (R)

#### Poly WAV → existing track with mismatched channels
- If file channels > track channels: only import first `track.channels` channels, warn
- If file channels < track channels: import available channels, leave rest empty

### 2.2 Drop Preview Update

Current preview shows blue highlight per target track. Updated:
- For multi-channel drops onto empty area: show ghost multi-channel track (sub-lane preview)
- For drops onto existing multi-channel track: highlight the specific sub-channel lane
- Show sub-channel label in the highlight ("L", "R", etc.)

### 2.3 Internal Clip Drag (within timeline)

When dragging an existing clip:
- Moving a clip within the same multi-channel track: can change sub-channel via Y position
- Moving a clip from mono track to stereo track: assign sub-channel from Y
- Moving a clip from stereo track to mono track: keep audio, clear `subChannel`

### 2.4 Import from Double-click (File Browser)

Current behavior clears timeline and creates mono tracks. Updated:
- Poly WAV (2/4/6 ch): create 1 multi-channel track with correct type
- Mono WAV: create 1 mono track (unchanged)
- Unsupported channel count: fall back to N mono tracks

---

## Files to Modify

| File | Phase | Changes |
|------|-------|---------|
| `src/core/types.ts` | 1 | Add `TrackChannelCount`, `Track.channels`, `Track.height`, `Clip.subChannel` |
| `src/core/TimelineModel.ts` | 1 | Update `addTrack()`, `importMultiChannelFile()`, `importFileAtPosition()` |
| `src/editor/TimelineRenderer.ts` | 1 | Variable height layout, sub-channel waveform, resize handle, sub-channel Y detection |
| `src/ui/App.ts` | 1+2 | Create track dialog, updated import logic, drag sub-channel assignment |
| `src/utils/TimelineUndoManager.ts` | 1 | Update commands for new Track fields |
| `src/mixer/Mixer.ts` | 1 | Channel type badge in strip header (no routing changes in Phase 1) |

## Out of Scope (Phase 3+4)

- Dual Mono plugin processing
- Stereo balance pan behavior in AudioEngine
- Dual peak meter in Mixer
- Split multichannel track → mono tracks
- Merge mono tracks → multichannel track
- Project file serialization of channel info (currently not persisted beyond runtime)

---

## Verification

```bash
npx tsc --noEmit           # zero type errors
npm test -- --run           # all green
```

Manual testing (mark with commit emoji):
- Create stereo/quad/5.1 empty track via dialog
- Import poly WAV → creates correct multi-channel track type
- Sub-channel waveform display (L/R stacked, different colors)
- Drag mono clip onto stereo track → Y position assigns sub-channel
- Resize track height by dragging bottom edge
- Undo/redo works for all new operations
