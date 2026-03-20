# OfflineAudioContext Export Refactor

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace manual Float32Array rendering in OfflineRender.ts with OfflineAudioContext to guarantee export = playback parity (including track volume, pan, crossfader, and plugin effects).

**Architecture:** Create an OfflineAudioContext, mirror AudioEngine's routing chain (gain → crossfader → insertIn → plugins → insertOut → pan → master), schedule all clips from sample 0, call startRendering(). Add a new method to PluginHost for creating plugin instances on an arbitrary BaseAudioContext without modifying existing code.

**Tech Stack:** Web Audio API (OfflineAudioContext), TypeScript, Vitest

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/core/OfflineRender.ts` | Rewrite | Build OfflineAudioContext graph, schedule clips, render |
| `src/ui/App.ts:3583` | Modify (1 line) | Add `await` to `renderTimelineOffline()` call |
| `src/plugins/PluginHost.ts` | Add method | `createOfflineInstance(ctx, pluginId, params)` — new, additive |
| `tests/unit/OfflineRender.test.ts` | Update | Change tests from sync to async |

**What does NOT change:** AudioEngine.ts, TimelineModel.ts, Mixer.ts, any UI code, any other test file.

---

## Chunk 1: Core OfflineAudioContext Rendering

### Task 1: Update tests to async + add track volume/pan tests

**Files:**
- Modify: `tests/unit/OfflineRender.test.ts`

- [ ] **Step 1: Make renderTimelineOffline async in tests**

Change all test calls from:
```typescript
const result = renderTimelineOffline(tl, pool);
```
to:
```typescript
const result = await renderTimelineOffline(tl, pool);
```

Mark all `it()` callbacks as `async`. The function doesn't need PluginHost yet — pass `undefined`.

- [ ] **Step 2: Add test for track volume (fader)**

```typescript
it('applies track volume (fader law)', async () => {
  const bid = addConstBuffer(pool, 1.0, 100);
  const clip = makeClip(bid, { sourceEnd: 100, duration: 100 });
  // track.volume = -6 dB
  const track = makeTrack('t1', [clip], { volume: -6 });
  const tl = makeTimeline({ totalLength: 100, tracks: [track] });

  const result = await renderTimelineOffline(tl, pool);

  const expected = Math.pow(10, -6 / 20); // ~0.501
  for (let i = 0; i < 100; i++) {
    expect(result.channels[0][i]).toBeCloseTo(expected, 2);
  }
});
```

- [ ] **Step 3: Add test for track pan**

```typescript
it('applies track pan to stereo output', async () => {
  const bid = addConstBuffer(pool, 1.0, 100);
  const clip = makeClip(bid, { sourceEnd: 100, duration: 100 });
  // pan hard right on a stereo track
  const track = makeTrack('t1', [clip], { pan: 1, channels: 2 });
  const tl = makeTimeline({ totalLength: 100, tracks: [track] });

  const result = await renderTimelineOffline(tl, pool);

  expect(result.channels).toHaveLength(2);
  // Hard right pan: left channel should be near-silent, right should have signal
  const leftRms = Math.sqrt(result.channels[0].reduce((s, v) => s + v * v, 0) / 100);
  const rightRms = Math.sqrt(result.channels[1].reduce((s, v) => s + v * v, 0) / 100);
  expect(leftRms).toBeLessThan(0.1);
  expect(rightRms).toBeGreaterThan(0.5);
});
```

- [ ] **Step 4: Run tests — must FAIL (red)**

```bash
npm test -- --run tests/unit/OfflineRender.test.ts
```

Expected: FAIL — `renderTimelineOffline` is still sync, doesn't apply volume/pan.

---

### Task 2: Rewrite OfflineRender.ts with OfflineAudioContext

**Files:**
- Rewrite: `src/core/OfflineRender.ts`
- Modify: `src/ui/App.ts:3583` (add `await`)

- [ ] **Step 1: Rewrite OfflineRender.ts**

The new implementation:
1. Creates `OfflineAudioContext(outputChannels, totalLength, sampleRate)`
2. Builds per-track routing: `trackGain → crossfaderGain → insertIn → insertOut → pan → master`
   - trackGain: `applyFaderLaw(track.volume)` — use `Math.pow(10, dB/20)` (same as AudioEngine)
   - crossfaderGain: 1.0 (crossfader not applied offline — same position as real-time)
   - insertIn → insertOut: direct connection (plugins added in Task 3)
   - pan: `StereoPannerNode` with `track.pan`
3. For each clip on audible tracks: creates `AudioBufferSourceNode`, applies clip gain/fade via `GainNode` automation (same 8-point sqrt ramp as `playTimeline`), connects through merger for subChannel routing
4. `await offlineCtx.startRendering()` → extracts `Float32Array[]`

Key differences from `playTimeline`:
- `startSample` is always 0 (render entire timeline)
- `scheduledTime` is absolute from 0, not relative to `audioContext.currentTime`
- No `requestAnimationFrame` or transport state

```typescript
import { Timeline, Track, Clip, TrackInsert } from './types';
import { BufferPool } from './BufferPool';

export interface OfflineRenderResult {
  channels: Float32Array[];
  sampleRate: number;
  duration: number;
}

export async function renderTimelineOffline(
  timeline: Timeline,
  bufferPool: BufferPool,
): Promise<OfflineRenderResult> {
  const { sampleRate, tracks, totalLength } = timeline;

  if (totalLength === 0 || tracks.length === 0) {
    return { channels: [], sampleRate, duration: 0 };
  }

  // Determine output channel count
  let outputChannels = 1;
  for (const track of tracks) {
    if (track.channels > outputChannels) outputChannels = track.channels;
  }
  // StereoPannerNode requires at least 2 channels
  if (outputChannels < 2) outputChannels = 2;

  const offlineCtx = new OfflineAudioContext(outputChannels, totalLength, sampleRate);
  const master = offlineCtx.createGain();
  master.connect(offlineCtx.destination);

  // Solo state
  const soloTrackIds = new Set<string>();
  for (const t of tracks) { if (t.solo) soloTrackIds.add(t.id); }
  const hasSolo = soloTrackIds.size > 0;

  let hasAudibleContent = false;

  for (const track of tracks) {
    const shouldPlay = hasSolo
      ? soloTrackIds.has(track.id) && !track.mute
      : !track.mute;
    if (!shouldPlay) continue;

    const chCount = track.channels || 1;

    // Track gain (fader)
    const trackGain = offlineCtx.createGain();
    trackGain.gain.value = track.volume !== 0 ? Math.pow(10, track.volume / 20) : 1;
    trackGain.channelCount = chCount;
    trackGain.channelCountMode = 'explicit';

    // Insert chain placeholder (direct connection, plugins added in Task 3)
    const insertIn = offlineCtx.createGain();
    insertIn.channelCount = chCount;
    insertIn.channelCountMode = 'explicit';
    const insertOut = offlineCtx.createGain();
    insertOut.channelCount = chCount;
    insertOut.channelCountMode = 'explicit';
    insertIn.connect(insertOut);

    // Pan
    const pan = offlineCtx.createStereoPanner();
    pan.pan.value = track.pan;

    // Chain: trackGain → insertIn → insertOut → pan → master
    trackGain.connect(insertIn);
    insertOut.connect(pan);
    pan.connect(master);

    // Channel merger for multi-channel tracks
    let merger: ChannelMergerNode | null = null;
    if (chCount > 1) {
      merger = offlineCtx.createChannelMerger(chCount);
      merger.connect(trackGain);
    }

    for (const clip of track.clips) {
      if (clip.muted) continue;

      const pooled = bufferPool.getBuffer(clip.bufferId);
      if (!pooled) continue;
      hasAudibleContent = true;

      const source = offlineCtx.createBufferSource();
      source.buffer = pooled.buffer;

      const sr = sampleRate;
      const sourceOffset = clip.sourceStart;
      const playDuration = clip.duration;
      const scheduledTime = clip.timelineOffset / sr;
      const baseGain = clip.gainDb !== 0 ? Math.pow(10, clip.gainDb / 20) : 1;
      const hasFadeIn = clip.fadeInSamples > 0;
      const hasFadeOut = clip.fadeOutSamples > 0;

      if (baseGain !== 1 || hasFadeIn || hasFadeOut) {
        const clipGain = offlineCtx.createGain();

        // Schedule fade-in (sqrt curve, 8 ramp points)
        if (hasFadeIn) {
          const fadeInEnd = clip.fadeInSamples;
          const RAMP_POINTS = 8;
          clipGain.gain.setValueAtTime(0, scheduledTime);
          for (let p = 1; p <= RAMP_POINTS; p++) {
            const t = p / RAMP_POINTS;
            const fadeSample = Math.round(t * fadeInEnd);
            if (fadeSample > playDuration) break;
            clipGain.gain.linearRampToValueAtTime(
              Math.sqrt(t) * baseGain,
              scheduledTime + fadeSample / sr,
            );
          }
          const fadeEndTime = scheduledTime + fadeInEnd / sr;
          clipGain.gain.linearRampToValueAtTime(baseGain, fadeEndTime);
        } else {
          clipGain.gain.setValueAtTime(baseGain, scheduledTime);
        }

        // Schedule fade-out (sqrt(1-t) curve, 8 ramp points)
        if (hasFadeOut) {
          const fadeOutStart = clip.duration - clip.fadeOutSamples;
          const fadeOutStartTime = scheduledTime + fadeOutStart / sr;
          clipGain.gain.setValueAtTime(baseGain, fadeOutStartTime);
          const RAMP_POINTS = 8;
          for (let p = 1; p <= RAMP_POINTS; p++) {
            const t = p / RAMP_POINTS;
            const fadeSample = fadeOutStart + Math.round(t * clip.fadeOutSamples);
            if (fadeSample > playDuration) break;
            clipGain.gain.linearRampToValueAtTime(
              Math.sqrt(1 - t) * baseGain,
              scheduledTime + fadeSample / sr,
            );
          }
        }

        source.connect(clipGain);
        if (merger && clip.subChannel != null) {
          clipGain.connect(merger, 0, clip.subChannel);
        } else {
          clipGain.connect(trackGain);
        }
      } else {
        if (merger && clip.subChannel != null) {
          source.connect(merger, 0, clip.subChannel);
        } else {
          source.connect(trackGain);
        }
      }

      source.start(scheduledTime, sourceOffset / sr, playDuration / sr);
    }
  }

  if (!hasAudibleContent) {
    return { channels: [], sampleRate, duration: 0 };
  }

  const rendered = await offlineCtx.startRendering();

  const channels: Float32Array[] = [];
  for (let ch = 0; ch < rendered.numberOfChannels; ch++) {
    channels.push(rendered.getChannelData(ch));
  }

  return { channels, sampleRate, duration: totalLength };
}
```

- [ ] **Step 2: Update App.ts exportFile() — add await**

Change line ~3583:
```typescript
// Before
const rendered = renderTimelineOffline(this.timelineModel.timeline, this.bufferPool);
// After
const rendered = await renderTimelineOffline(this.timelineModel.timeline, this.bufferPool);
```

- [ ] **Step 3: Run tests — must PASS (green)**

```bash
npm test -- --run tests/unit/OfflineRender.test.ts
```

- [ ] **Step 4: Run full test suite + tsc**

```bash
npx tsc --noEmit && npm test -- --run
```

- [ ] **Step 5: Commit**

```bash
git add src/core/OfflineRender.ts src/ui/App.ts tests/unit/OfflineRender.test.ts
git commit -m "feat: rewrite offline render with OfflineAudioContext for export=playback parity"
```

---

## Chunk 2: Plugin Effects in Offline Render

### Task 3: Add PluginHost.createOfflineInstance()

**Files:**
- Modify: `src/plugins/PluginHost.ts` (add new method, no changes to existing methods)

- [ ] **Step 1: Add `createOfflineInstance` method to PluginHost**

This method creates a fresh plugin node on an arbitrary `BaseAudioContext`, copying parameter values from an existing instance. It's strictly additive — no existing method is modified.

```typescript
/**
 * Create a plugin instance on an arbitrary AudioContext (e.g. OfflineAudioContext).
 * Copies the current parameter values from an existing instance.
 * Returns the input AudioNode and output AudioNode for chain connection.
 * Returns null if the plugin type is not supported offline.
 */
createOfflineInstance(
  ctx: BaseAudioContext,
  existingInstance: PluginInstance,
): { input: AudioNode; output: AudioNode } | null {
  const pluginId = existingInstance.pluginInfo.id;
  const params = existingInstance.parameters;

  // Only built-in WebAudio plugins supported offline
  if (existingInstance.pluginInfo.format !== 'WebAudio') return null;

  // Recreate node graph on the provided context, applying current params
  // (mirror createBuiltinInstance logic for each plugin type)
  // ...
}
```

The method body mirrors the `switch` in `createBuiltinInstance` but uses `ctx` instead of `this.audioContext`, and applies parameter values from `existingInstance.parameters` instead of defaults.

- [ ] **Step 2: Run tests — existing tests still pass (no regression)**

```bash
npm test -- --run
```

---

### Task 4: Wire plugins into OfflineRender

**Files:**
- Modify: `src/core/OfflineRender.ts` (add optional `pluginHost` parameter)
- Modify: `src/ui/App.ts:3583` (pass `this.pluginHost` to render call)
- Add tests: `tests/unit/OfflineRender.test.ts`

- [ ] **Step 1: Add plugin test**

```typescript
it('applies track plugin effects (e.g. gain plugin)', async () => {
  // Setup: a clip with 1.0 amplitude, a gain plugin set to -6dB on the track
  // Expected: output amplitude ~= 0.501
});
```

- [ ] **Step 2: Run test — must FAIL**

- [ ] **Step 3: Update OfflineRender signature**

```typescript
export async function renderTimelineOffline(
  timeline: Timeline,
  bufferPool: BufferPool,
  pluginHost?: PluginHost,
): Promise<OfflineRenderResult>
```

In the per-track loop, after creating `insertIn`/`insertOut`, if `pluginHost` is provided and `track.inserts` has active (non-bypassed) inserts:

```typescript
if (pluginHost && track.inserts.length > 0) {
  const activeInserts = track.inserts.filter(ins => !ins.bypassed);
  let prev: AudioNode = insertIn;
  for (const ins of activeInserts) {
    const existing = pluginHost.getInstance(ins.instanceId);
    if (!existing) continue;
    const offline = pluginHost.createOfflineInstance(offlineCtx, existing);
    if (!offline) continue;
    prev.connect(offline.input);
    prev = offline.output;
  }
  prev.connect(insertOut);
  // Disconnect direct insertIn→insertOut
  insertIn.disconnect(insertOut);
}
```

- [ ] **Step 4: Update App.ts to pass pluginHost**

```typescript
const rendered = await renderTimelineOffline(
  this.timelineModel.timeline, this.bufferPool, this.pluginHost,
);
```

- [ ] **Step 5: Run tests — must PASS**

- [ ] **Step 6: Run full suite + tsc**

```bash
npx tsc --noEmit && npm test -- --run
```

- [ ] **Step 7: Commit**

```bash
git add src/core/OfflineRender.ts src/plugins/PluginHost.ts src/ui/App.ts tests/unit/OfflineRender.test.ts
git commit -m "feat: export renders plugin effects via OfflineAudioContext"
```

---

## Risk Mitigation

- **No AudioEngine.ts changes** — real-time playback completely untouched
- **No PluginHost existing method changes** — only a new additive method
- **App.ts change is 1 line** — `await` added to already-async function
- **Existing 17 tests updated to async** — same assertions, same expectations
- **OfflineAudioContext is standard Web Audio API** — supported in all browsers and WKWebView

## What changes in export behavior (intentional improvements)

| Feature | Before | After |
|---------|--------|-------|
| Track volume (fader) | ❌ Ignored | ✅ Applied |
| Track pan | ❌ Ignored | ✅ Applied |
| Plugin effects | ❌ Ignored | ✅ Applied (Task 3-4) |
| Clip gain + fade | ✅ Manual sqrt | ✅ Web Audio automation (identical curve) |
| Mute/Solo | ✅ Manual check | ✅ Same logic |
| subChannel routing | ✅ Manual write | ✅ ChannelMergerNode |
