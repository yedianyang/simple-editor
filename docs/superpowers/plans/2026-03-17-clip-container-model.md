# Clip Container Model Refactor — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the N-clips-per-channel model (`bufferId` + `subChannel` + `groupId`) with a single multi-channel clip model (`bufferIds: string[]`) so that stereo/quad/5.1 clips behave as one atomic object.

**Architecture:** The `Clip` interface changes from holding a single `bufferId` with optional `subChannel`/`groupId` to holding an array `bufferIds[]` where `bufferIds.length` must equal `track.channels`. All operations (move, trim, delete, undo, crossfade, render, playback, export) naturally operate on the whole clip. Cross-track drag enforces strict channel matching; dragging stereo→mono triggers split into 2 mono clips on 2 mono tracks.

**Tech Stack:** TypeScript (strict mode), Vitest, Web Audio API, Tauri 2.x (Rust backend unchanged for this refactor)

**Spec:** `docs/specs/round5-interview-decisions.md` §1 (Clip Container Model)

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/core/types.ts` | Modify | `Clip.bufferId` → `Clip.bufferIds`, remove `subChannel`/`groupId` |
| `src/core/TimelineModel.ts` | Modify | Import methods create 1 clip with N bufferIds; remove `generateGroupId`, `getSiblingClips`, `getAllGroupClips` |
| `src/core/AudioEngine.ts` | Modify | `playTimeline()` creates N sources per clip for multi-channel tracks |
| `src/core/OfflineRender.ts` | Modify | Same routing change as AudioEngine for offline export |
| `src/core/CrossfadeUtils.ts` | Minor | No structural change (operates on Clip objects, not channels) |
| `src/editor/TimelineRenderer.ts` | Modify | Render N waveform lanes per clip; remove groupId-based selection; update drag logic |
| `src/utils/TimelineUndoManager.ts` | Modify | Update all commands for new Clip shape |
| `src/ui/App.ts` | Modify | Update wiring for new import return types; update cross-track drag |
| `tests/unit/ImportAudioToTimeline.test.ts` | Rewrite | Assert single clip with `bufferIds[]` instead of N clips |
| `tests/unit/CrossTrackChannel.test.ts` | Rewrite | Assert split/merge with new model |
| `tests/unit/OfflineRender.test.ts` | Modify | Update multi-channel test to use `bufferIds[]` |
| `tests/unit/Crossfade.test.ts` | Minor | Update clip fixtures to use `bufferIds` |
| `tests/unit/MuteSolo.test.ts` | Minor | Update clip fixtures |
| `tests/unit/FadeCurve.test.ts` | Minor | Update clip fixtures |

---

## Chunk 1: Data Model + TimelineModel

### Task 1: Update Clip interface in types.ts

**Files:**
- Modify: `src/core/types.ts:275-295`

- [ ] **Step 1: Change `bufferId` to `bufferIds`**

```typescript
// Old (line 277):
bufferId: string;

// New:
bufferIds: string[];
```

- [ ] **Step 2: Remove `subChannel` and `groupId`**

Remove these lines (290-291):
```typescript
// DELETE these:
subChannel?: number;
groupId?: string;
```

- [ ] **Step 3: Run `npx tsc --noEmit` to see all compilation errors**

Expected: ~50-100 type errors across the codebase. This is our migration checklist.
Save the error list — each error is a location that needs updating.

- [ ] **Step 4: Commit type change only**

```bash
git add src/core/types.ts
git commit -m "refactor: Clip.bufferId → Clip.bufferIds[], remove subChannel/groupId"
```

---

### Task 2: Update ImportAudioToTimeline tests (RED)

**Files:**
- Rewrite: `tests/unit/ImportAudioToTimeline.test.ts`

- [ ] **Step 1: Rewrite stereo import test to expect 1 clip with 2 bufferIds**

```typescript
it('stereo file → 1 track, 1 clip with 2 bufferIds', () => {
  const bufferIds = ['buf-L', 'buf-R'];
  const result = model.importAudioToNewTrack(
    bufferIds, 48000, 'stereo.wav', 2, ['Left', 'Right'], 0, -1
  );
  expect(model.timeline.tracks).toHaveLength(1);
  const track = model.timeline.tracks[0];
  expect(track.channels).toBe(2);
  expect(track.clips).toHaveLength(1); // ONE clip, not two
  const clip = track.clips[0];
  expect(clip.bufferIds).toEqual(['buf-L', 'buf-R']);
  expect(clip.name).toBe('stereo.wav');
  // No subChannel or groupId
  expect((clip as any).subChannel).toBeUndefined();
  expect((clip as any).groupId).toBeUndefined();
});
```

- [ ] **Step 2: Rewrite quad import test**

```typescript
it('quad file → 1 track, 1 clip with 4 bufferIds', () => {
  const bufferIds = ['buf-0', 'buf-1', 'buf-2', 'buf-3'];
  const result = model.importAudioToNewTrack(
    bufferIds, 48000, 'quad.wav', 4, ['FL', 'FR', 'RL', 'RR'], 0, -1
  );
  expect(model.timeline.tracks).toHaveLength(1);
  const track = model.timeline.tracks[0];
  expect(track.channels).toBe(4);
  expect(track.clips).toHaveLength(1);
  expect(track.clips[0].bufferIds).toEqual(bufferIds);
});
```

- [ ] **Step 3: Rewrite mono import test (1 bufferIds entry)**

```typescript
it('mono file → 1 track, 1 clip with 1 bufferId', () => {
  const result = model.importAudioToNewTrack(
    ['buf-mono'], 48000, 'mono.wav', 1, ['Mono'], 0, -1
  );
  const clip = model.timeline.tracks[0].clips[0];
  expect(clip.bufferIds).toEqual(['buf-mono']);
});
```

- [ ] **Step 4: Update 5ch/6ch and unsupported channel tests similarly**

For 5ch/6ch: same pattern — 1 clip, N bufferIds.
For unsupported (3ch): still falls back to N mono tracks, each with 1-element `bufferIds`.

- [ ] **Step 5: Run tests — confirm RED**

```bash
npm test -- --run tests/unit/ImportAudioToTimeline.test.ts
```
Expected: FAIL (model still creates N clips with old `bufferId`)

---

### Task 3: Update TimelineModel import methods (GREEN)

**Files:**
- Modify: `src/core/TimelineModel.ts:197-468`

- [ ] **Step 1: Remove `generateGroupId()` function (lines 13-15)**

- [ ] **Step 2: Rewrite `importMultiChannelFile()` (lines 197-265)**

Key change: instead of creating N clips with `bufferId: bufferIds[i]`, create 1 clip:

```typescript
importMultiChannelFile(
  bufferIds: string[], sampleRate: number, fileName: string,
  numChannels: number, channelNames: string[], numSamples: number
): void {
  // ... existing setup code ...

  if ([1, 2, 4, 5, 6].includes(numChannels)) {
    const channels = numChannels as TrackChannelCount;
    const track = this.addTrack(fileName, color, trackIndex, channels);

    const clip: Clip = {
      id: genClipId(),
      bufferIds: bufferIds,  // ALL channel buffers in one clip
      name: fileName,
      timelineOffset: 0,
      sourceStart: 0,
      sourceEnd: numSamples,
      duration: numSamples,
      gainDb: 0,
      fadeInSamples: 0,
      fadeOutSamples: 0,
      muted: false,
    };
    track.clips.push(clip);
  } else {
    // Unsupported: N mono tracks, each with 1-element bufferIds
    for (let i = 0; i < numChannels; i++) {
      const track = this.addTrack(`${fileName} — ${channelNames[i]}`, color, trackIndex + i, 1);
      const clip: Clip = {
        id: genClipId(),
        bufferIds: [bufferIds[i]],
        name: `${fileName} — ${channelNames[i]}`,
        timelineOffset: 0,
        sourceStart: 0,
        sourceEnd: numSamples,
        duration: numSamples,
        gainDb: 0,
        fadeInSamples: 0,
        fadeOutSamples: 0,
        muted: false,
      };
      track.clips.push(clip);
    }
  }
  // ... update totalLength ...
}
```

- [ ] **Step 3: Apply same pattern to `importFileAtPosition()` (lines 274-357)**

Same change: 1 clip with `bufferIds` instead of N clips.

- [ ] **Step 4: Apply same pattern to `importAudioToNewTrack()` (lines 367-468)**

Same change.

- [ ] **Step 5: Remove `getSiblingClips()` and `getAllGroupClips()` (lines 716-738)**

These relied on `groupId` which no longer exists.

- [ ] **Step 6: Update `resolveOverlaps()` — remove groupId sibling exclusion (line 547)**

The old code skipped overlaps between sibling clips (same groupId). Now there's only one clip per multi-channel entity, so this check is unnecessary. Remove:
```typescript
// DELETE: if (clip.groupId && c.groupId === moved.groupId) continue;
```

- [ ] **Step 7: Run import tests — confirm GREEN**

```bash
npm test -- --run tests/unit/ImportAudioToTimeline.test.ts
```
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/core/TimelineModel.ts tests/unit/ImportAudioToTimeline.test.ts
git commit -m "refactor: TimelineModel creates single multi-channel clips with bufferIds[]"
```

---

### Task 4: Fix remaining model-layer compilation errors

**Files:**
- Modify: `src/core/TimelineModel.ts` (any remaining references)

- [ ] **Step 1: Run `npx tsc --noEmit` and fix all TimelineModel errors**

Search for any remaining `clip.bufferId` (singular) references and change to `clip.bufferIds[0]` for mono contexts or the full array where appropriate.

- [ ] **Step 2: Run all tests**

```bash
npm test -- --run
```

- [ ] **Step 3: Commit**

```bash
git commit -am "fix: resolve TimelineModel compilation errors for bufferIds migration"
```

---

## Chunk 2: Audio Pipeline (Engine + OfflineRender)

### Task 5: Update AudioEngine playback (RED → GREEN)

**Files:**
- Modify: `src/core/AudioEngine.ts:404-595`
- Test: `tests/unit/Module3_Playback.test.ts`

- [ ] **Step 1: Update clip fixture in playback tests to use `bufferIds`**

All test clips that use `bufferId: 'xxx'` → `bufferIds: ['xxx']`.
For stereo test clips: `bufferIds: ['buf-L', 'buf-R']`.

- [ ] **Step 2: Run playback tests — confirm RED (compilation errors)**

```bash
npm test -- --run tests/unit/Module3_Playback.test.ts
```

- [ ] **Step 3: Update `playTimeline()` in AudioEngine.ts**

Key change in the clip loop (around lines 437-578):

**Old behavior:** Each clip has one `bufferId`, and for multi-channel tracks, multiple clips connect to different merger inputs via `subChannel`.

**New behavior:** Each clip has `bufferIds[]`. For multi-channel tracks, create one `AudioBufferSourceNode` per channel and connect each to the correct merger input:

```typescript
// For each clip on a multi-channel track:
for (let ch = 0; ch < clip.bufferIds.length; ch++) {
  const buffer = bufferPool.get(clip.bufferIds[ch]);
  if (!buffer) continue;
  const source = this.audioContext.createBufferSource();
  source.buffer = buffer;

  if (merger && clip.bufferIds.length > 1) {
    // Multi-channel: each buffer → its merger input
    if (clipGainNode) {
      // Create per-channel gain for fade envelope
      const chGain = this.audioContext.createGain();
      // Copy the same fade/crossfade envelope to each channel gain
      // ... (same scheduling as before)
      source.connect(chGain);
      chGain.connect(merger, 0, ch);
    } else {
      source.connect(merger, 0, ch);
    }
  } else {
    // Mono: single source → gain chain
    if (clipGainNode) {
      source.connect(clipGainNode);
    } else {
      source.connect(gainNode);
    }
  }

  source.start(scheduledTime, sourceOffsetSec, durationSec);
  this.activeSources.push(source);
}
```

**Important:** Fade/crossfade envelopes are shared across all channels of a clip (one gain automation, applied identically to all channels). The simplest approach is to use a single `clipGainNode` and connect all channel sources through it before the merger, OR to replicate the gain automation per channel.

Best approach: Connect all sources → single clipGainNode → then split to merger inputs:
```
source_L ─┐
           ├→ clipGainNode (fade/xfade) → splitter → merger[0]
source_R ─┘                                       → merger[1]
```

Actually simpler: create a stereo (or N-channel) buffer from the individual channel buffers, use a single source:

```typescript
// Create combined N-channel AudioBuffer
const combinedBuffer = this.audioContext.createBuffer(
  clip.bufferIds.length, numSamples, sampleRate
);
for (let ch = 0; ch < clip.bufferIds.length; ch++) {
  const mono = bufferPool.get(clip.bufferIds[ch]);
  if (mono) combinedBuffer.copyToChannel(mono.getChannelData(0), ch);
}
const source = this.audioContext.createBufferSource();
source.buffer = combinedBuffer;
// Then: source → clipGainNode → gainNode (no merger needed!)
```

This is cleaner — the `AudioBufferSourceNode` with a multi-channel buffer automatically outputs to multiple channels. The `ChannelMergerNode` may no longer be needed.

- [ ] **Step 4: Run playback tests — confirm GREEN**

```bash
npm test -- --run tests/unit/Module3_Playback.test.ts
```

- [ ] **Step 5: Commit**

```bash
git commit -am "refactor: AudioEngine plays multi-channel clips from bufferIds[]"
```

---

### Task 6: Update OfflineRender export (RED → GREEN)

**Files:**
- Modify: `src/core/OfflineRender.ts`
- Modify: `tests/unit/OfflineRender.test.ts`

- [ ] **Step 1: Update OfflineRender test fixtures to use `bufferIds`**

Change all `bufferId: 'xxx'` to `bufferIds: ['xxx']`.
Update multi-channel stereo test (lines ~387-402) to use one clip with `bufferIds: ['buf-L', 'buf-R']` instead of two clips with `subChannel`.

- [ ] **Step 2: Run offline render tests — confirm RED**

```bash
npm test -- --run tests/unit/OfflineRender.test.ts
```

- [ ] **Step 3: Apply same routing change as AudioEngine to `renderTimelineOffline()`**

Same pattern: create combined N-channel AudioBuffer from `clip.bufferIds`, use single source. Remove `subChannel`-based merger routing.

- [ ] **Step 4: Run offline render tests — confirm GREEN**

```bash
npm test -- --run tests/unit/OfflineRender.test.ts
```

- [ ] **Step 5: Commit**

```bash
git commit -am "refactor: OfflineRender uses bufferIds[] for multi-channel export"
```

---

### Task 7: Update Crossfade tests and utils

**Files:**
- Modify: `tests/unit/Crossfade.test.ts`
- Modify: `src/core/CrossfadeUtils.ts` (if needed)

- [ ] **Step 1: Update clip fixtures in Crossfade.test.ts**

Change `bufferId: 'x'` to `bufferIds: ['x']` in all test clip objects.

- [ ] **Step 2: Run crossfade tests**

```bash
npm test -- --run tests/unit/Crossfade.test.ts
```
Expected: PASS (crossfade logic operates on Clip properties, not directly on bufferId)

- [ ] **Step 3: Commit if changed**

```bash
git commit -am "test: update Crossfade tests for bufferIds migration"
```

---

## Chunk 3: Rendering + Interaction

### Task 8: Update TimelineRenderer clip rendering

**Files:**
- Modify: `src/editor/TimelineRenderer.ts`

- [ ] **Step 1: Update `renderClip()` to draw N waveform lanes for one clip**

Old behavior (lines 2320-2331): Uses `clip.subChannel` to determine Y position within track.

New behavior: One clip occupies the full track height. For multi-channel tracks, divide the clip area into N lanes and draw each channel's waveform:

```typescript
// In renderClip():
const track = this.timeline!.tracks[trackIndex];
const numChannels = clip.bufferIds.length;

if (numChannels > 1) {
  // Draw N waveform lanes within this single clip
  const laneH = clipH / numChannels;
  for (let ch = 0; ch < numChannels; ch++) {
    const laneY = clipY + ch * laneH;
    this.renderClipWaveform(clip.bufferIds[ch], laneY, laneH, ...);
    // Draw lane divider
    if (ch < numChannels - 1) {
      ctx.strokeStyle = 'rgba(255,255,255,0.1)';
      ctx.beginPath();
      ctx.moveTo(clipStartX, laneY + laneH);
      ctx.lineTo(clipEndX, laneY + laneH);
      ctx.stroke();
    }
  }
} else {
  // Mono: single waveform
  this.renderClipWaveform(clip.bufferIds[0], clipY, clipH, ...);
}
```

- [ ] **Step 2: Remove all `subChannel`-based Y offset calculations**

Delete the old lane calculation:
```typescript
// DELETE:
if (track.channels > 1 && clip.subChannel != null) {
  const laneH = trackH / track.channels;
  clipY = trackTopY + clip.subChannel * laneH + 2;
  clipH = laneH - 4;
}
```

- [ ] **Step 3: Update `renderClipWaveform()` to accept bufferId parameter**

The method currently gets the buffer from `clip.bufferId`. Update to accept a specific bufferId:

```typescript
private renderClipWaveform(bufferId: string, y: number, h: number, ...) {
  // Use provided bufferId instead of clip.bufferId
}
```

- [ ] **Step 4: Run `npx tsc --noEmit` — zero errors in renderer**

- [ ] **Step 5: Commit**

```bash
git commit -am "refactor: TimelineRenderer draws multi-channel waveforms from single clip"
```

---

### Task 9: Update selection and group logic in renderer

**Files:**
- Modify: `src/editor/TimelineRenderer.ts`

- [ ] **Step 1: Remove `getGroupClipIds()` method (lines 678-687)**

This returned all clips sharing a `groupId`. No longer needed — selecting a clip selects the whole multi-channel entity by definition.

- [ ] **Step 2: Update all selection code that used `getGroupClipIds()`**

Find all call sites and replace with simple single-clip selection. When a clip is clicked, just select that clip — it already represents all channels.

- [ ] **Step 3: Update crossfade hit detection**

The `findAdjacentClipPair()` method finds two adjacent clips on the same track. This should still work because now there's only 1 clip per multi-channel entity (not N clips per channel). But verify the adjacency check works correctly — it should compare clip boundaries, not subChannels.

- [ ] **Step 4: Run rendering tests**

```bash
npm test -- --run tests/unit/Module5_Rendering.test.ts
```

- [ ] **Step 5: Commit**

```bash
git commit -am "refactor: remove groupId-based selection from renderer"
```

---

### Task 10: Update drag-drop and channel enforcement

**Files:**
- Modify: `src/editor/TimelineRenderer.ts` (drag logic)
- Modify: `src/ui/App.ts` (drop handling)

- [ ] **Step 1: Add channel-count validation on drag**

When dragging a clip to a different track, check:
```typescript
if (clip.bufferIds.length !== targetTrack.channels) {
  // Reject or trigger split (see Task 14)
  return;
}
```

- [ ] **Step 2: Update drop preview to show rejection for mismatched channels**

Show red ghost/highlight when `clip.bufferIds.length !== targetTrack.channels`.

- [ ] **Step 3: Remove subChannel-based Y position drag assignment**

The old code assigned `clip.subChannel` based on mouse Y within a multi-channel track. Remove this entirely.

- [ ] **Step 4: Run `npx tsc --noEmit`**

- [ ] **Step 5: Commit**

```bash
git commit -am "refactor: enforce strict channel matching on drag-drop"
```

---

## Chunk 4: Undo System + Remaining Compilation Fixes

### Task 11: Update TimelineUndoManager commands

**Files:**
- Modify: `src/utils/TimelineUndoManager.ts`

- [ ] **Step 1: Update all command classes that snapshot Clip objects**

Commands that store clip snapshots (DeleteClipCommand, SplitClipCommand, ClipDragCommand, etc.) — their saved `Clip` objects now have `bufferIds` instead of `bufferId`. Since they store copies of the full Clip interface, they should automatically work IF the types are correct.

Review each command:
- `MoveClipCommand` — stores `prevOffset`, no Clip snapshot → OK
- `MoveClipToTrackCommand` — stores `prevTrackId`, `prevOffset` → OK
- `SplitClipCommand` — stores `originalClip` and `resultClips` as full Clip objects → update split logic to create clips with correct `bufferIds` (same bufferIds for both halves, different sourceStart/sourceEnd)
- `DeleteClipCommand` — stores full `deletedClip` → OK (automatic)
- `TrimClipCommand` — stores trim values → OK
- `ClipDragCommand` — stores `originalState`/`finalState` → OK (automatic)
- `CrossfadeCommand` — stores crossfade values → OK

- [ ] **Step 2: Update SplitClipCommand specifically**

When splitting a multi-channel clip, both resulting clips keep the same `bufferIds` array (all channels), just with different `sourceStart`/`sourceEnd`/`duration`:

```typescript
// Split at samplePosition:
const clipA: Clip = {
  ...originalClip,
  id: genClipId(),
  sourceEnd: samplePosition,
  duration: samplePosition - originalClip.sourceStart,
  // bufferIds: same as original (all channels)
};
const clipB: Clip = {
  ...originalClip,
  id: genClipId(),
  sourceStart: samplePosition,
  timelineOffset: originalClip.timelineOffset + (samplePosition - originalClip.sourceStart),
  duration: originalClip.sourceEnd - samplePosition,
  // bufferIds: same as original (all channels)
};
```

- [ ] **Step 3: Remove any groupId references in undo commands**

Search for `groupId` in TimelineUndoManager.ts and remove.

- [ ] **Step 4: Run `npx tsc --noEmit` — zero errors**

- [ ] **Step 5: Run all tests**

```bash
npm test -- --run
```

- [ ] **Step 6: Commit**

```bash
git commit -am "refactor: update undo commands for bufferIds[] clip model"
```

---

### Task 12: Fix all remaining compilation errors across codebase

**Files:**
- Modify: Any file still referencing `bufferId` (singular), `subChannel`, or `groupId`

- [ ] **Step 1: Run `npx tsc --noEmit` and list all remaining errors**

- [ ] **Step 2: Fix each error systematically**

Common patterns:
- `clip.bufferId` → `clip.bufferIds[0]` (for mono/single-buffer contexts)
- `clip.bufferId` → `clip.bufferIds` (when passing to BufferPool)
- `clip.subChannel` → remove
- `clip.groupId` → remove
- `getGroupClipIds()` → remove call, use clip.id directly

- [ ] **Step 3: Run full test suite**

```bash
npm test -- --run
```

- [ ] **Step 4: Commit**

```bash
git commit -am "fix: resolve all remaining bufferIds migration compilation errors"
```

---

### Task 13: Update remaining test files

**Files:**
- Modify: `tests/unit/MuteSolo.test.ts`
- Modify: `tests/unit/FadeCurve.test.ts`
- Modify: `tests/unit/PlaybackInvalidation.test.ts`
- Modify: `tests/unit/Module4_Mixer.test.ts`
- Modify: `tests/unit/Module5_Rendering.test.ts`
- Modify: `tests/unit/SampleRateMismatch.test.ts`
- Modify: `tests/unit/MetadataThreeLayer.test.ts`

- [ ] **Step 1: Find-and-replace `bufferId:` → `bufferIds:` in all test files**

For each test file, change clip fixtures:
```typescript
// Old:
bufferId: 'buf-1',
// New:
bufferIds: ['buf-1'],
```

For stereo fixtures:
```typescript
// Old: two clips with bufferId + subChannel + groupId
// New: one clip with bufferIds: ['buf-L', 'buf-R']
```

- [ ] **Step 2: Remove all `subChannel` and `groupId` references in test fixtures**

- [ ] **Step 3: Run full test suite — all green**

```bash
npm test -- --run
```

- [ ] **Step 4: Commit**

```bash
git commit -am "test: update all test fixtures for bufferIds migration"
```

---

## Chunk 5: Cross-Track Operations + Crossfade Visual

### Task 14: Rewrite CrossTrackChannel split logic

**Files:**
- Rewrite: `tests/unit/CrossTrackChannel.test.ts`
- Modify: Wherever `executeSplitAlgorithm` lives (likely `src/ui/App.ts` or TimelineRenderer)

- [ ] **Step 1: Write failing test for stereo→mono split**

```typescript
it('dragging stereo clip to mono track → splits into 2 mono clips on 2 mono tracks', () => {
  // Setup: stereo track with 1 clip (bufferIds: ['L', 'R'])
  const stereoTrack = model.timeline.tracks[0]; // channels: 2
  const clip = stereoTrack.clips[0]; // bufferIds: ['buf-L', 'buf-R']

  // Act: drag clip to monoTrack1
  const result = splitClipToMonoTracks(model, clip, stereoTrack.id, monoTrack1.id);

  // Assert: clip removed from stereo track
  expect(stereoTrack.clips).toHaveLength(0);

  // Assert: 2 mono tracks, each with 1 mono clip
  expect(monoTrack1.clips).toHaveLength(1);
  expect(monoTrack1.clips[0].bufferIds).toEqual(['buf-L']);

  // If only 1 mono track existed, a second was auto-created
  const monoTrack2 = model.timeline.tracks.find(t =>
    t.id !== monoTrack1.id && t.channels === 1 && t.clips.length === 1
  );
  expect(monoTrack2).toBeDefined();
  expect(monoTrack2!.clips[0].bufferIds).toEqual(['buf-R']);
});
```

- [ ] **Step 2: Run test — confirm RED**

- [ ] **Step 3: Implement `splitClipToMonoTracks()`**

```typescript
function splitClipToMonoTracks(
  model: TimelineModel,
  clip: Clip,
  sourceTrackId: string,
  targetTrackId: string
): void {
  const sourceTrack = model.getTrackById(sourceTrackId);
  const targetTrack = model.getTrackById(targetTrackId);
  if (!sourceTrack || !targetTrack || targetTrack.channels !== 1) return;

  // Remove clip from source track
  sourceTrack.clips = sourceTrack.clips.filter(c => c.id !== clip.id);

  // Create mono clip for first channel on target track
  const clip1: Clip = {
    ...clip,
    id: genClipId(),
    bufferIds: [clip.bufferIds[0]],
    name: `${clip.name} — L`,
  };
  targetTrack.clips.push(clip1);

  // Find or create second mono track
  let track2 = model.findNextMonoTrack(targetTrack);
  if (!track2) {
    track2 = model.addEmptyTrack(1);
    // Insert after target track
  }
  const clip2: Clip = {
    ...clip,
    id: genClipId(),
    bufferIds: [clip.bufferIds[1]],
    name: `${clip.name} — R`,
  };
  track2.clips.push(clip2);
}
```

- [ ] **Step 4: Run test — confirm GREEN**

- [ ] **Step 5: Commit**

```bash
git commit -am "feat: stereo clip splits into 2 mono clips when dragged to mono track"
```

---

### Task 15: Rewrite CrossTrackChannel merge logic

**Files:**
- Modify: `tests/unit/CrossTrackChannel.test.ts`
- Modify: App.ts or wherever merge logic lives

- [ ] **Step 1: Write failing test for mono→stereo merge via right-click**

```typescript
it('right-click 2 mono clips → "Merge to stereo" → 1 stereo clip on new stereo track', () => {
  // Setup: 2 mono tracks, each with 1 clip at same timelineOffset
  const monoClipL = monoTrack1.clips[0]; // bufferIds: ['buf-L']
  const monoClipR = monoTrack2.clips[0]; // bufferIds: ['buf-R']

  // Act: merge
  const result = mergeClipsToStereo(model, [monoClipL, monoClipR]);

  // Assert: new stereo track with 1 clip
  const stereoTrack = result.track;
  expect(stereoTrack.channels).toBe(2);
  expect(stereoTrack.clips).toHaveLength(1);
  expect(stereoTrack.clips[0].bufferIds).toEqual(['buf-L', 'buf-R']);

  // Assert: original clips removed from mono tracks
  expect(monoTrack1.clips).toHaveLength(0);
  expect(monoTrack2.clips).toHaveLength(0);
});
```

- [ ] **Step 2: Run test — confirm RED**

- [ ] **Step 3: Implement merge function**

- [ ] **Step 4: Run test — confirm GREEN**

- [ ] **Step 5: Commit**

```bash
git commit -am "feat: merge mono clips to stereo via right-click context menu"
```

---

### Task 16: Update crossfade visual — overlapping waveforms

**Files:**
- Modify: `src/editor/TimelineRenderer.ts` (crossfade rendering, lines ~2412-2463)

- [ ] **Step 1: Update crossfade rendering to show overlapping clips**

In the crossfade region, both clips should be visible (semi-transparent overlap). Currently, the renderer just draws an amber tint. New behavior:

```typescript
// In crossfade region:
// 1. Extend clipA's waveform rendering INTO the crossfade zone (past its visual end)
// 2. Extend clipB's waveform rendering INTO the crossfade zone (before its visual start)
// 3. Both rendered at reduced opacity (e.g. 0.5 each)
// 4. Keep the amber tint overlay on top
```

This requires:
- For clipA with `crossfadeOutSamples > 0`: render waveform extending `crossfadeOutSamples` past the clip's normal end boundary
- For clipB with `crossfadeInSamples > 0`: render waveform extending `crossfadeInSamples` before the clip's normal start boundary
- Both overlapping waveforms drawn at alpha 0.5

- [ ] **Step 2: Manual verification needed 🔍**

This is a visual change — commit with 🔍 and verify via `npm run tauri:dev`.

- [ ] **Step 3: Commit**

```bash
git commit -m "feat: crossfade renders overlapping waveforms (Pro Tools style) 🔍"
```

---

### Task 17: Full verification

- [ ] **Step 1: Run TypeScript type check**

```bash
npx tsc --noEmit
```
Expected: Zero errors

- [ ] **Step 2: Run full unit test suite**

```bash
npm test -- --run
```
Expected: All green

- [ ] **Step 3: Run Rust checks**

```bash
cd src-tauri && cargo check && cargo test && cargo clippy -- -D warnings
```
Expected: All pass (Rust code unchanged)

- [ ] **Step 4: Build frontend**

```bash
npm run build:frontend
```
Expected: Success

- [ ] **Step 5: Manual verification 🔍**

```bash
npm run tauri:dev
```

Verify:
- Import stereo WAV → 1 clip with L/R waveforms stacked
- Select clip → entire stereo clip selected (not individual channels)
- Move clip → all channels move together
- Delete clip → entire stereo clip deleted
- Cmd+Z → entire stereo clip restored (not channel by channel)
- Add crossfade → applies to entire clip, overlapping waveforms visible
- Split (S key) → both halves are stereo clips
- Export → correct stereo output

- [ ] **Step 6: Final commit**

```bash
git commit -am "verify: clip container model refactor complete"
```

---

## Risk Notes

1. **BufferPool changes**: The BufferPool stores individual mono buffers by ID. This doesn't change — `clip.bufferIds[0]`, `clip.bufferIds[1]` etc. still reference individual mono buffers. No BufferPool changes needed.

2. **Session serialization**: If sessions are persisted to disk, the save/load format needs updating for `bufferIds`. Check if there's a project file format.

3. **Performance**: Creating combined N-channel AudioBuffers from individual channel buffers adds a one-time cost at playback start. For large files, this could be noticeable. If so, cache the combined buffers.

4. **Crossfade rendering overlap**: Drawing two overlapping waveforms in the crossfade region doubles the rendering cost in that area. Should be negligible for typical crossfade lengths.
