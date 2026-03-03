# FieldCorder DAW

A lightweight Digital Audio Workstation designed for multi-channel environmental recording editing on macOS. Supports Mono, Stereo, Quad, and 5.1 Surround audio with VST3/AudioUnit plugin hosting.

## Key Features

- **Multi-channel tracks**: Mono (1ch), Stereo (2ch), Quad (4ch), and 5.1 Surround (6ch) track types with channel badge indicators
- **Per-channel waveform display**: Color-coded stacked sub-channel waveforms within each track lane
- **Poly WAV import**: Multi-channel WAV files create a single multi-channel track with sub-channel clips
- **Drag-and-drop to timeline**: Drop files from the file browser onto a specific track and time position
- **Resizable track heights**: Drag the bottom edge of any track header to resize
- **VST3/AudioUnit plugin support**: Load and use native macOS audio plugins
- **Built-in effects**: 3-Band EQ, HPF/LPF, Compressor, Reverb, Delay, Gain
- **Professional metering**: Real-time Peak, RMS, True Peak, LUFS (ITU-R BS.1770-4)
- **Channel mixer**: Per-channel volume, mute, solo, and plugin inserts
- **Multi-file workflow**: File queue with drag-and-drop support
- **Spectrum analyzer**: Real-time FFT with configurable window size
- **Non-destructive editing**: Full undo/redo history
- **Mac-native**: Tauri 2.x app with macOS menu bar, Rust WAV parser, and native performance

## Architecture

```
FieldCorder/
├── src-tauri/            # Tauri 2.x Rust backend
│   └── src/             # Commands, WAV parser, menu, localfile protocol
├── src/                  # Frontend (Web Audio + Canvas UI)
│   ├── core/            # Audio engine, types, timeline model
│   ├── editor/          # Waveform, spectrogram, cue points, timeline
│   ├── mixer/           # Channel strips, routing
│   ├── plugins/         # VST3/AU host, built-in effects
│   ├── ui/              # App controller, metering, file queue
│   ├── utils/           # TauriAPI adapter, undo manager
│   └── styles/          # CSS
└── resources/           # App icon, entitlements
```

### Technology Stack

- **Tauri 2.x** - Desktop app framework for macOS (Rust backend)
- **TypeScript** - Type-safe frontend codebase
- **Vite** - Fast build tooling
- **Web Audio API** - Audio playback, routing, and built-in effects
- **Canvas 2D** - Waveform and spectrum visualization
- **Rust** - WAV parser, file I/O, native commands

## Getting Started

### Prerequisites

- Node.js 18+
- npm or yarn
- Rust toolchain (for Tauri backend)
- macOS (for full VST/AU and Core Audio support)

### Installation

```bash
npm install
```

### Development

```bash
# Start Vite dev server only (browser mode)
npm run dev

# Start Tauri + Vite full development mode
npm run tauri:dev
```

### Building

```bash
# Build frontend only
npm run build:frontend

# Build Tauri production app (DMG)
npm run tauri:build
```

## Multi-Channel Workflow

FieldCorder is designed for environmental/field recording editing:

1. **Import** multi-channel WAV/AIF files (2-6 channels)
2. **View** per-channel waveforms with color-coded display
3. **Edit** all channels simultaneously (trim, fade, normalize, etc.)
4. **Mix** with per-channel volume, mute, solo controls
5. **Process** with VST3/AU plugins or built-in effects per channel
6. **Monitor** with professional LUFS metering (ITU-R BS.1770-4)
7. **Export** as multi-channel WAV/AIF with configurable bit depth

### Channel Layouts

| Layout | Badge | Channels | Use Case |
|--------|-------|----------|----------|
| Mono | [M] | Mono | Single-channel recording |
| Stereo | [ST] | L, R | Standard stereo recording |
| Quad | [Q] | FL, FR, RL, RR | Ambisonic/spatial recording |
| 5.1 | [5.1] | L, R, C, LFE, Ls, Rs | Surround field recording |

## Plugin System

### Built-in Effects (Web Audio)

Always available, no native addon required:
- **3-Band EQ** - Low shelf, parametric mid, high shelf
- **High Pass Filter** - Variable frequency and Q
- **Low Pass Filter** - Variable frequency and Q
- **Compressor** - Threshold, knee, ratio, attack, release
- **Gain** - Simple level adjustment
- **Delay** - Time, feedback, wet/dry mix
- **Reverb** - Convolution reverb with decay and damping

### VST3/AudioUnit Plugins

Requires building the native addon. Scans standard macOS paths:
- `~/Library/Audio/Plug-Ins/VST3/`
- `/Library/Audio/Plug-Ins/VST3/`
- `~/Library/Audio/Plug-Ins/Components/`
- `/Library/Audio/Plug-Ins/Components/`

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Space | Play/Pause |
| L | Toggle loop |
| R | Reverse |
| M | Add cue point |
| Arrow Left/Right | Move playhead ±1ms |
| +/= | Zoom in |
| - | Zoom out |
| Delete/Backspace | Delete selection |
| Cmd+A | Select all |
| Cmd+T | Trim to selection |
| Cmd+F | Fade in |
| Cmd+Shift+F | Fade out |
| Cmd+Shift+N | New Track |
| Cmd+G | Apply gain |
| Cmd+Z | Undo |
| Cmd+Shift+Z | Redo |
| Cmd+M | Toggle mixer |
| Cmd+B | Toggle plugin browser |
| Cmd+E | Export |
| Cmd+S | Save project |
| Cmd+O | Import audio |

## File Formats

### Import
- WAV (PCM 16/24/32-bit, Float 32-bit)
- AIFF/AIF
- FLAC, MP3, OGG (via Web Audio API decoding)

### Export
- WAV (16-bit, 24-bit, 32-bit float)
- AIF (16-bit, 24-bit, 32-bit)
- Optional dithering: TPDF or noise-shaped

### Project Files
- `.fcproj` - JSON-based project file with embedded audio data

## License

MIT License
