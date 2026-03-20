# FieldCorder DAW -- Manual Test Checklist

**Date:** 2026-02-22
**Branch:** `claude/lightweight-daw-vst-mac-EHViI`
**Tester:** _______________
**Build:** `npm run tauri:dev`

---

## Pre-Test Setup

1. Run `npm run tauri:dev` and confirm the app window opens without errors.
2. Prepare the following test files:
   - A small stereo WAV (16-bit, < 10 MB)
   - A 24-bit stereo WAV
   - A 32-bit float WAV
   - A multi-channel WAV (4ch or 6ch)
   - A non-WAV audio file (FLAC, MP3, or OGG)
   - A large WAV (> 100 MB, ideally > 300 MB) for OOM testing
   - An empty/corrupted WAV file (truncated header or 0 bytes)
   - A folder containing multiple audio files

---

## 1. File I/O (Import / Export)

### 1.1 WAV Import via Rust Parser (C1)

**Bug:** TauriAPI `readLargeAudioFile()` previously called the wrong IPC name. Now correctly calls `'read_audio_file'` matching the Rust `#[tauri::command] fn read_audio_file`.

| # | Step | Expected | Pass |
|---|------|----------|------|
| 1.1.1 | Open the app. Use File > Import (Cmd+O) and select a 16-bit stereo WAV file. | File loads successfully. Waveform displays. Console shows `[IMPORT] Step 2: Rust WAV parse complete (2ch, ...)`. No IPC error. | ☐ |
| 1.1.2 | Import a 24-bit stereo WAV. | File loads. Console shows `Rust WAV parse complete`. Waveform displays correctly. | ☐ |
| 1.1.3 | Import a 32-bit float WAV. | File loads without error. Waveform displays. | ☐ |
| 1.1.4 | Import a multi-channel WAV (4ch or 6ch). | File loads. Multiple channel lanes appear in the waveform view. Channel names display correctly (e.g., "Front L", "Front R", etc.). | ☐ |
| 1.1.5 | Drag and drop a WAV file onto the waveform area. | File loads via Rust WAV parser. No console errors about IPC name mismatch. | ☐ |

### 1.2 Non-WAV Import via localfile:// Protocol

| # | Step | Expected | Pass |
|---|------|----------|------|
| 1.2.1 | Import a FLAC or MP3 file via File > Import. | File loads via `readLargeFile()` (localfile:// protocol) followed by `decodeAudioData`. Console does NOT show "Rust WAV parse" message. Waveform displays. | ☐ |

### 1.3 File Export -- WAV Write (C2)

**Bug:** TauriAPI `writeFile()` previously called the wrong IPC name. Now correctly calls `'write_file'` matching Rust `#[tauri::command] fn write_file`.

| # | Step | Expected | Pass |
|---|------|----------|------|
| 1.3.1 | Load a WAV file. In the Export section (bottom panel), click "Choose Folder" and select a destination. Click "Export". | File is written to the selected folder. Console shows `[Export] Written to /path/to/file.wav`. No IPC error. | ☐ |
| 1.3.2 | Load a WAV. Use File > Export (Cmd+E). Fill in metadata. Choose WAV 16-bit. Confirm export. | A download prompt appears. The exported file opens correctly in another audio player. | ☐ |
| 1.3.3 | Repeat 1.3.2 but choose 24-bit WAV export. | Exported file plays correctly. Negative samples are not clipped or corrupted (see H4). | ☐ |
| 1.3.4 | Repeat 1.3.2 but choose 32-bit float WAV export. | File exports and plays back without distortion. | ☐ |
| 1.3.5 | Export as AIF format. | AIF file is created and plays correctly. | ☐ |

### 1.4 24-bit WAV Export Negative Sample Encoding (H4)

**Bug:** 24-bit WAV export previously had incorrect two's complement encoding for negative samples. The fix adds `if (intSample < 0) intSample += 0x1000000` before writing bytes.

| # | Step | Expected | Pass |
|---|------|----------|------|
| 1.4.1 | Load a WAV file that contains loud negative peaks (e.g., a drum hit, a sine wave). Export as 24-bit WAV. Re-import the exported file. | The re-imported waveform should look identical to the original. No clicks, pops, or inverted polarity artifacts at negative peaks. | ☐ |
| 1.4.2 | Generate a pure -1.0 to +1.0 sine wave, export as 24-bit WAV, re-import. Compare visually. | Waveform is symmetric. Negative half matches positive half in amplitude. | ☐ |

### 1.5 readFile @deprecated (M10)

| # | Step | Expected | Pass |
|---|------|----------|------|
| 1.5.1 | Verify in the source code (`TauriAPI.ts` line 91-92) that `readFile()` has a `@deprecated` JSDoc annotation. | The annotation exists, directing users to `readLargeFile()` or `readLargeAudioFile()` instead. | ☐ |

---

## 2. Audio Effects (Delay / Reverb / EQ3)

### 2.1 Delay Plugin Signal Routing (C3)

**Bug:** The Delay plugin previously had the input node connected directly to the delay line only, with no dry signal path. The fix creates an explicit fan-out: `input -> dry -> merger` AND `input -> delay -> wet -> merger`, with `_outputNode` set to the merger.

| # | Step | Expected | Pass |
|---|------|----------|------|
| 2.1.1 | Load a WAV file. Open the Mixer (Cmd+M). Click "+ Insert" on a channel. Select "Delay" from the plugin browser. Press Play. | Audio plays with an audible delay/echo effect AND the original dry signal is still present. The output is a mix of dry + delayed signal, not silence or only the delayed signal. | ☐ |
| 2.1.2 | While the Delay plugin is active, adjust the Mix parameter to 0.0 (fully dry). | Only the dry signal is heard -- no delay effect. | ☐ |
| 2.1.3 | Adjust the Mix parameter to 1.0 (fully wet). | Only the delayed signal is heard -- no dry signal. | ☐ |
| 2.1.4 | Set Mix to 0.5, increase Feedback to 0.8, set Time to 0.5s. Play audio. | Multiple repeating echoes are heard, each progressively quieter, mixed with the dry signal. No runaway feedback (feedback is capped at 0.95). | ☐ |

### 2.2 Reverb Plugin Signal Routing (H2)

**Bug:** Same issue as Delay -- the Reverb had no dry signal path. The fix creates: `input -> dry -> merger` AND `input -> convolver -> wet -> merger`.

| # | Step | Expected | Pass |
|---|------|----------|------|
| 2.2.1 | Load a WAV. Insert a "Reverb" plugin on a channel. Press Play. | Audio plays with reverb tail AND the original dry signal is present. Sound is not washed out or silent. | ☐ |
| 2.2.2 | Adjust Reverb Mix to 0.0. | Pure dry signal, no reverb tail. | ☐ |
| 2.2.3 | Adjust Reverb Mix to 1.0. | Only the reverb wet signal is heard. | ☐ |
| 2.2.4 | Change the Decay parameter from 2.0s to 5.0s. | Reverb tail becomes noticeably longer. The impulse response is regenerated. | ☐ |
| 2.2.5 | Change the Damping parameter from 0.5 to 0.9. | Reverb tail becomes darker/shorter (high frequencies decay faster). | ☐ |

### 2.3 EQ3 Mid/High Parameter Control (M8)

**Bug:** The mid and high band parameters of the 3-band EQ were inaccessible because `_midNode` was not stored on the audio node. The fix stores `_midNode` and `_outputNode` (high) on the low filter node.

| # | Step | Expected | Pass |
|---|------|----------|------|
| 2.3.1 | Insert a "3-Band EQ" plugin on a channel. Adjust the "Mid Gain" parameter to +12 dB. Play audio. | Mid frequencies are noticeably boosted. The change takes effect immediately. | ☐ |
| 2.3.2 | Adjust "Mid Freq" to 2000 Hz. | The center frequency of the mid band shifts audibly. | ☐ |
| 2.3.3 | Adjust "High Gain" to +12 dB. | High frequencies are boosted. | ☐ |
| 2.3.4 | Adjust "High Freq" to 8000 Hz. | The high shelf corner frequency shifts. | ☐ |
| 2.3.5 | Adjust "Low Gain" to -24 dB. | Low frequencies are significantly cut. | ☐ |

---

## 3. Playback and Transport Controls

### 3.1 Timeline Playback End Detection (M7)

**Bug:** Timeline playback had no way to detect when all scheduled sources finished playing. The fix adds an `activeSourceCount` tracker and `onended` callbacks on each `AudioBufferSourceNode`.

| # | Step | Expected | Pass |
|---|------|----------|------|
| 3.1.1 | Load a multi-channel WAV (this enters timeline mode). Press Play. Let the audio play to the end without stopping. | When the last clip finishes, the Play button returns to its non-playing state. `isPlaying` becomes `false`. The `onPlaybackEnd` callback fires (UI updates, realtime analysis stops). | ☐ |
| 3.1.2 | Load a short WAV (< 5 seconds). Press Play and wait for it to finish. Immediately press Play again. | Playback restarts from the beginning without errors. The transport state is correctly reset. | ☐ |
| 3.1.3 | During timeline playback, press Stop. Then press Play. | Playback stops cleanly. On re-play, starts from the beginning. No orphaned source nodes. | ☐ |

### 3.2 Playhead Behavior on Pause/Resume

| # | Step | Expected | Pass |
|---|------|----------|------|
| 3.2.1 | Load a file. Click at a midpoint in the waveform to set the playhead. Press Play. Press Pause. Click a different position in the waveform. Press Play. | Playback starts from the NEW clicked position, not from the paused position. The engine detects that the playhead moved and restarts rather than blindly resuming. | ☐ |
| 3.2.2 | Load a file. Press Play. Press Pause. Press Play (without moving playhead). | Playback resumes from the paused position. | ☐ |

---

## 4. Mixer

### 4.1 Mixer PluginHost Null Safety (H5)

**Bug:** The Mixer could call methods on `this.pluginHost` when it was null (before any audio file was loaded). The fix adds null checks (`if (!this.pluginHost) return;`).

| # | Step | Expected | Pass |
|---|------|----------|------|
| 4.1.1 | Open the app. Open the Mixer (Cmd+M) BEFORE loading any audio file. | The mixer displays "No audio loaded". No console errors about `pluginHost` being null. | ☐ |
| 4.1.2 | With the mixer open and no file loaded, attempt to use any mixer control (if visible). | No crash or TypeError. The app remains responsive. | ☐ |
| 4.1.3 | Now load an audio file. Open the mixer. Click "+ Insert" on a channel. | The plugin browser appears. Plugins are listed. The plugin host was initialized on file load. | ☐ |

### 4.2 Crossfader Independent GainNode (M6)

**Bug:** The crossfader previously shared the track's main GainNode, causing crossfader adjustments to overwrite the track volume setting. The fix introduces a separate `trackCrossfaderNodes` map with dedicated GainNodes.

| # | Step | Expected | Pass |
|---|------|----------|------|
| 4.2.1 | Load a multi-channel WAV (enters timeline mode with multiple tracks). Open the Mixer. Set Track 1 volume to -6 dB. Set Track 2 volume to -12 dB. | Volume values are displayed correctly in the mixer strips. | ☐ |
| 4.2.2 | Assign Track 1 as "A" and Track 2 as "B" in the crossfader selectors. Move the crossfader slider from center toward A. | Track A becomes louder relative to Track B. IMPORTANT: The track volume faders still show -6 dB and -12 dB respectively -- they are NOT overwritten by the crossfader. | ☐ |
| 4.2.3 | Move the crossfader back to center. Adjust Track 1's volume fader to 0 dB. | Track 1's gain changes correctly. The crossfader position and Track 2's volume remain unaffected. | ☐ |

### 4.3 Mixer innerHTML TODO (L7)

| # | Step | Expected | Pass |
|---|------|----------|------|
| 4.3.1 | Verify in `Mixer.ts` (line 313) that a TODO comment exists about replacing innerHTML-based rendering. | The comment `// TODO: Replace innerHTML-based rendering with DOM diffing or incremental updates` is present. | ☐ |

---

## 5. Waveform / Spectrogram Rendering

### 5.1 WaveformRenderer ResizeObserver Null Guard (H3)

**Bug:** `WaveformRenderer.setupResize()` and `resize()` did not guard against `this.canvas.parentElement` being null, causing crashes when the canvas was detached from the DOM.

| # | Step | Expected | Pass |
|---|------|----------|------|
| 5.1.1 | Load a file and confirm the waveform renders correctly. Resize the application window by dragging the corner. | The waveform re-renders at the new size. No console errors about `parentElement` being null. | ☐ |
| 5.1.2 | Rapidly resize the window (drag corner back and forth quickly). | No crashes. The waveform adapts smoothly. | ☐ |

### 5.2 SpectrogramRenderer ResizeObserver Null Guard (H3)

| # | Step | Expected | Pass |
|---|------|----------|------|
| 5.2.1 | Load a file. Observe the spectrogram panel. Resize the window. | Spectrogram re-renders without errors about null `parentElement`. | ☐ |

### 5.3 WaveformRenderer.destroy() Cleanup (M2)

**Bug:** `WaveformRenderer.destroy()` did not remove mouse/wheel event listeners or disconnect the ResizeObserver, causing memory leaks on reload.

| # | Step | Expected | Pass |
|---|------|----------|------|
| 5.3.1 | Verify in source code (`WaveformRenderer.ts` lines 93-105) that `destroy()` calls `resizeObserver?.disconnect()` and removes all five event listeners (`mousedown`, `mousemove`, `mouseup`, `mouseleave`, `dblclick`, `wheel`). | All six listeners are removed. ResizeObserver is disconnected and set to null. `audioBuffer`, `peakCache`, and `peaks` are cleared. | ☐ |
| 5.3.2 | Load a file, interact with the waveform (click, scroll, zoom). Close the app window (Cmd+W). Re-open. | No errors on close. No zombie event listeners (would manifest as errors in the next session). | ☐ |

### 5.4 SpectrogramRenderer.destroy() Cleanup (M3)

**Bug:** `SpectrogramRenderer.destroy()` did not disconnect the ResizeObserver.

| # | Step | Expected | Pass |
|---|------|----------|------|
| 5.4.1 | Verify in source code (`SpectrogramRenderer.ts` lines 38-45) that `destroy()` calls `stopRealtime()`, `resizeObserver?.disconnect()`, and nullifies `resizeObserver`, `audioBuffer`, `analyserNode`, and `smoothedSpectrum`. | All cleanup steps are present. | ☐ |

### 5.5 SpectrogramRenderer FFT Power-of-2 Validation (L3)

**Bug:** `setFFTSize()` did not validate that the size was a power of 2, which would cause the FFT computation to produce garbage results.

| # | Step | Expected | Pass |
|---|------|----------|------|
| 5.5.1 | Verify in source code (`SpectrogramRenderer.ts` lines 71-77) that `setFFTSize()` checks `(size & (size - 1)) !== 0` and throws an error if the size is not a power of 2. | The validation exists. Also check `computeFFT()` (line 347) for the same check. | ☐ |
| 5.5.2 | Load a file. Change the FFT size dropdown to each available option (512, 1024, 2048, 4096, 8192). | Each selection re-renders the spectrogram without errors. All options are powers of 2. | ☐ |

### 5.6 SonogramRenderer Worker URL and ResizeObserver Cleanup (L4)

**Bug:** The SonogramRenderer previously used an incorrect Worker URL pattern and did not clean up the ResizeObserver on destroy.

| # | Step | Expected | Pass |
|---|------|----------|------|
| 5.6.1 | Load a file. Observe whether the sonogram panel (if visible in the UI) shows a time-frequency heatmap. | The heatmap renders with color gradients (black/blue/cyan/yellow/white). No Worker instantiation errors in the console. | ☐ |
| 5.6.2 | Verify in source code (`SonogramRenderer.ts` lines 346-355) that `destroy()` terminates the worker, disconnects the ResizeObserver, and nullifies `stftData` and `audioBuffer`. | All cleanup steps are present. | ☐ |

### 5.7 Canvas getContext('2d') Null Checks (L6)

**Bug:** Three renderers (WaveformRenderer, SpectrogramRenderer, SonogramRenderer) did not check if `getContext('2d')` returned null, which can happen if the context has already been allocated with a different type.

| # | Step | Expected | Pass |
|---|------|----------|------|
| 5.7.1 | Verify in source code that all three renderers throw a descriptive error if `getContext('2d')` returns null: `WaveformRenderer.ts` line 49-51, `SpectrogramRenderer.ts` line 25-27, `SonogramRenderer.ts` line 42-43. | Each constructor checks `if (!ctx) throw new Error(...)` with a meaningful message. | ☐ |

---

## 6. Project Management

### 6.1 ProjectManager Base64 Chunked Processing (M5)

**Bug:** `arrayBufferToBase64()` previously used character-by-character string concatenation (`string += String.fromCharCode(byte)`), which is O(n^2) for large buffers. The fix uses 8192-byte chunks pushed to an array, then joined.

| # | Step | Expected | Pass |
|---|------|----------|------|
| 6.1.1 | Load a large stereo WAV file (> 50 MB). Click "Save Project". | The project saves without freezing the UI. Console does not show "Maximum call stack size exceeded" errors (which the old `String.fromCharCode.apply(null, entireArray)` could cause). | ☐ |
| 6.1.2 | Load the saved `.fcproj` file. | The audio buffer, cue points, and file name are correctly restored. The waveform matches the original. | ☐ |
| 6.1.3 | Verify in source code (`ProjectManager.ts` lines 73-82) that `arrayBufferToBase64()` uses a `chunkSize` of 8192 and builds an array of chunks before calling `btoa(chunks.join(''))`. | The chunked implementation is present. | ☐ |

---

## 7. Undo/Redo System

### 7.1 UndoManager audioContext Null Guard (H1)

**Bug:** `UndoManager.cloneBuffer()` would throw when `this.audioContext` was null (before any file was loaded or after the context was destroyed). The fix returns `null` instead of crashing.

| # | Step | Expected | Pass |
|---|------|----------|------|
| 7.1.1 | Open the app (no file loaded). Press Cmd+Z (Undo). | Nothing happens. No console error about `audioContext` being null. The Undo button should be disabled. | ☐ |
| 7.1.2 | Load a WAV file. Make an edit (e.g., select a region and apply Trim). Press Cmd+Z. | The trim is undone. The waveform reverts to the pre-trim state. | ☐ |
| 7.1.3 | After undoing, press Cmd+Shift+Z (Redo). | The trim is re-applied. | ☐ |
| 7.1.4 | Verify in source code (`UndoManager.ts` lines 56-59) that `cloneBuffer()` checks `if (!this.audioContext) return null`. Also verify `saveState()` (line 22) guards against a null clone result. | Both guards are present. | ☐ |

---

## 8. Resource Cleanup and Memory Management

### 8.1 App.destroy() Tauri Listener Cleanup (M1)

**Bug:** `App.destroy()` did not clean up Tauri event listeners (onImportFiles, onProjectLoad, onMenuAction, etc.) or cancel the meter animation frame, causing memory leaks on window close/reload.

| # | Step | Expected | Pass |
|---|------|----------|------|
| 8.1.1 | Verify in source code (`App.ts` lines 1739-1750) that `destroy()`: (a) calls `stopRealtimeAnalysis()`, (b) calls `cancelAnimationFrame(this.meterAnimationFrame)`, (c) removes the keydown listener, (d) iterates `this.unlistenFns` and calls each unlisten function, (e) clears the array, (f) calls `waveformRenderer.destroy()`, (g) calls `spectrogramRenderer.destroy()`, (h) calls `audioEngine.destroy()`. | All eight cleanup steps are present. | ☐ |
| 8.1.2 | Verify in `setupNativeListeners()` (App.ts line 466-468) that each `onImportFiles`, `onProjectLoad`, `onPluginsScanResult`, and `onMenuAction` call stores its unlisten function via the `collect()` helper. | All listener registrations go through `collect()` which pushes the unlisten fn to `this.unlistenFns`. | ☐ |

### 8.2 AudioContext.close() in Destroy (M9)

**Bug:** `AudioEngine.destroy()` did not call `AudioContext.close()`, leaving the audio context alive and holding system audio resources.

| # | Step | Expected | Pass |
|---|------|----------|------|
| 8.2.1 | Verify in source code (`AudioEngine.ts` lines 846-864) that `destroy()` calls `this.audioContext.close()` and then sets `this.audioContext = null`. Also verify it cleans up `analyserNode`, `masterGainNode`, channel nodes, and track nodes. | The close call is present along with comprehensive cleanup. `audioBuffer` is also set to null. | ☐ |
| 8.2.2 | Load a file, play audio, then close the app window. Re-open the app. | Audio plays correctly in the new session. No "AudioContext was not allowed to start" errors (old contexts are not lingering). | ☐ |

---

## 9. File Queue

### 9.1 FileQueue Incremental ID Counter (L1)

**Bug:** FileQueue used `Math.random()` or a similar non-deterministic method for IDs. The fix uses a simple incrementing counter (`this.nextId++`).

| # | Step | Expected | Pass |
|---|------|----------|------|
| 9.1.1 | Import 3 files into the queue. Check the file list. | Files appear in order. Each has a unique, incrementing numeric ID (1, 2, 3). No ID collisions. | ☐ |
| 9.1.2 | Remove file 2 from the queue. Add a new file. | The new file gets ID 4 (not 2 or 3). IDs never reuse. | ☐ |
| 9.1.3 | Verify in source code (`FileQueue.ts` line 9) that `private nextId = 1` is used, and `addFile()` (line 11) uses `this.nextId++`. | Incrementing counter implementation is present. | ☐ |

---

## 10. Type Safety and Code Quality

### 10.1 window.app Type Safety (L2)

**Bug:** `window.app` was typed as `any`, bypassing TypeScript strict mode. The fix uses explicit type casting.

| # | Step | Expected | Pass |
|---|------|----------|------|
| 10.1.1 | Verify in `main.ts` (line 30) that `window.app` assignment uses `(window as unknown as Record<string, unknown>).app = app` or similar typed pattern instead of `(window as any).app`. | A type-safe cast is used. No bare `any`. | ☐ |

### 10.2 Platform 'darwin' Comment (L5)

| # | Step | Expected | Pass |
|---|------|----------|------|
| 10.2.1 | Verify in `TauriAPI.ts` (lines 229-231) that the `platform: 'darwin'` value has a comment explaining it is hardcoded for macOS-only MAS distribution. | Comment exists explaining the rationale and suggesting `@tauri-apps/plugin-os` for cross-platform. | ☐ |

### 10.3 FileHandler buildIXMLChunk Dead Code Removal (M4)

**Bug:** The `buildIXMLChunk` method contained dead/duplicated code paths for XML construction. The fix consolidates into a clean `buildIXMLClean()` helper.

| # | Step | Expected | Pass |
|---|------|----------|------|
| 10.3.1 | Verify in `FileHandler.ts` that `buildIXMLChunk()` (lines 234-246) delegates to `buildIXMLClean()` (lines 251-309) for XML generation. There should be no inline XML string building in `buildIXMLChunk` itself. | `buildIXMLChunk` only calls `buildIXMLClean`, encodes, pads, and returns. | ☐ |

### 10.4 TypeScript Type Check

| # | Step | Expected | Pass |
|---|------|----------|------|
| 10.4.1 | Run `npx tsc --noEmit` from the project root. | Zero type errors. Exit code 0. | ☐ |

---

## 11. Integration / End-to-End Scenarios

### 11.1 Full Import-Edit-Export Workflow

| # | Step | Expected | Pass |
|---|------|----------|------|
| 11.1.1 | Import a stereo WAV via File > Import. Select a region. Apply Normalize to -3 dB. Undo. Redo. Apply Fade In. Export as 24-bit WAV. Re-import the exported file. | Each step succeeds. The exported file has a fade-in applied. The re-imported file matches expectations. | ☐ |

### 11.2 Multi-File Queue Workflow

| # | Step | Expected | Pass |
|---|------|----------|------|
| 11.2.1 | Import 3 files via drag-and-drop. Click each file in the queue to switch. Add a cue point to file 1. Switch to file 2. Switch back to file 1. | Cue points for file 1 are preserved across switches. File switching is smooth. | ☐ |

### 11.3 Folder Browser Workflow

| # | Step | Expected | Pass |
|---|------|----------|------|
| 11.3.1 | Click "Open Folder" in the file browser panel. Select a folder with audio files. | Files are listed with names and sizes. Status indicators show "pending" (circle). | ☐ |
| 11.3.2 | Click a file in the browser to load it. After reviewing, click the status button to cycle through pending -> done -> skip -> pending. | Status cycles correctly. The stats counter (e.g., "1/10 done") updates. | ☐ |
| 11.3.3 | Use the search filter in the file browser. | Only matching files are shown. Clearing the search restores all files. | ☐ |

### 11.4 Plugin Chain on Channel Insert

| # | Step | Expected | Pass |
|---|------|----------|------|
| 11.4.1 | Load a file. Open Mixer. Add a Compressor plugin to channel 1. Then add a Delay plugin to channel 1. Press Play. | Audio passes through both plugins in series (Compressor first, then Delay). Both effects are audible. | ☐ |
| 11.4.2 | Remove the Compressor from the insert chain. | Only the Delay effect remains audible. No audio dropout or error. | ☐ |

### 11.5 App Startup with No File Loaded

| # | Step | Expected | Pass |
|---|------|----------|------|
| 11.5.1 | Launch the app fresh. Observe the initial state. | The waveform area shows "Import audio files to begin editing". The spectrogram shows "Spectrum Analyzer". All edit/transport buttons are disabled. No console errors. No null pointer exceptions from UndoManager, PluginHost, or any renderer. | ☐ |

---

## Additional Fix: Rust-to-TypeScript Field Name Mismatch (C1-extra)

**Status:** FIXED (commit `f374e85`)

During review, a field name mismatch was found between Rust `AudioFileData` and TypeScript `TauriAPI.ts`:

| Field | Rust | TS (before fix) | TS (after fix) |
|-------|------|-----------------|----------------|
| Channel count | `num_channels: u16` | `result.channels` (undefined) | `result.num_channels` |
| Sample data | `channels: Vec<Vec<f32>>` | `result.samples` (undefined) | `result.channels` (2D → flat Float32Array) |

Fix: `readLargeAudioFile()` now reads `result.num_channels` for channel count, `result.channels` for per-channel 2D array, and flattens to `[ch0_all, ch1_all, ...]` Float32Array — matching `AudioEngine.loadFromParsedData()` expected layout.

---

## Summary

| Category | Total Tests | Critical | High | Medium | Low |
|----------|:-----------:|:--------:|:----:|:------:|:---:|
| File I/O | 12 | C1, C1-extra, C2 | H4 | M10 | -- |
| Audio Effects | 12 | C3 | H2 | M8 | -- |
| Playback/Transport | 5 | -- | -- | M7 | -- |
| Mixer | 6 | -- | H5 | M6 | L7 |
| Rendering | 9 | -- | H3 | M2, M3 | L3, L4, L6 |
| Project Management | 3 | -- | -- | M5 | -- |
| Undo/Redo | 4 | -- | H1 | -- | -- |
| Resource Cleanup | 4 | -- | -- | M1, M9 | -- |
| File Queue | 3 | -- | -- | -- | L1 |
| Type Safety/Quality | 4 | -- | -- | M4 | L2, L5 |
| Integration (E2E) | 7 | -- | -- | -- | -- |
| **Total** | **69** | **3** | **5** | **10** | **7** |

### Pass Rate

- Passed: ___ / 69
- Failed: ___ / 69
- Blocked: ___ / 69

### Sign-off

Tested by: _________________ Date: _______________
Approved by: _________________ Date: _______________

---

## Automated Test Report -- 2026-03-17

**Branch:** `claude/lightweight-daw-vst-mac-EHViI`
**Runner:** quality agent

### Summary

| Suite | Result | Tests |
|-------|--------|-------|
| TypeScript (vitest) | PASS | 395 / 395 (19 files) |
| TypeScript (tsc --noEmit) | PASS | 0 type errors |

### New Tests Added: OfflineRender -- Track Volume, Pan, Plugins

Added 5 new tests to `tests/unit/OfflineRender.test.ts` as part of the
`OfflineRender.ts` rewrite from synchronous sample-buffer rendering to
`OfflineAudioContext`-based rendering (export = playback parity).

All existing tests were updated from synchronous to `async/await` form and
precision loosened from `.toBeCloseTo(..., 5)` to `.toBeCloseTo(..., 2)`
to match `OfflineAudioContext` mock automation evaluation variance.

| Test | Assertion | Result |
|------|-----------|--------|
| applies track volume (fader law) | output = 10^(-6/20) per sample | PASS |
| applies track pan to stereo output | hard-right pan: leftRms < 0.1, rightRms > 0.5 | PASS |
| applies a Gain plugin insert to exported audio | gain -6 dB applied via insert chain | PASS |
| does not apply bypassed plugin inserts | bypassed insert = no gain change, output = 1.0 | PASS |
| renders correctly without pluginHost (backward compat) | no pluginHost = inserts ignored | PASS |
| applies Compressor plugin without crashing | smoke test, no throw | PASS |

### Mock Infrastructure Notes

The `MockOfflineAudioContext._walkChain()` in `tests/setup.ts` correctly
handles the extended node graph:

```
source -> clipGain -> trackGain -> insertIn -> [pluginGain] -> insertOut -> panner -> master
```

- All `MockGainNode` instances in the chain are accumulated and multiplied
- `MockStereoPannerNode` is detected and equal-power pan law applied
- `MockChannelMergerNode` input index routes sub-channel clips

No changes to mock infrastructure were required. All new tests pass with the
existing mock setup.

### Failures

None.
