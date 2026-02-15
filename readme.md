# FieldCorder DAW

A lightweight Digital Audio Workstation designed for multi-channel environmental recording editing on macOS. Supports 2-6 channel audio with VST3/AudioUnit plugin hosting.

## Key Features

- **Multi-channel editing**: Native support for Stereo (2ch), Quad (4ch), and 5.1 Surround (6ch)
- **Per-channel waveform display**: Color-coded waveforms for each channel
- **VST3/AudioUnit plugin support**: Load and use native macOS audio plugins
- **Built-in effects**: 3-Band EQ, HPF/LPF, Compressor, Reverb, Delay, Gain
- **Professional metering**: Real-time Peak, RMS, True Peak, LUFS (ITU-R BS.1770-4)
- **Channel mixer**: Per-channel volume, mute, solo, and plugin inserts
- **Multi-file workflow**: File queue with drag-and-drop support
- **Spectrum analyzer**: Real-time FFT with configurable window size
- **Non-destructive editing**: Full undo/redo history
- **Mac-native**: Electron app with macOS menu bar, titlebar, and Core Audio integration

## Architecture

```
FieldCorder/
├── electron/             # Electron main process
│   ├── main.ts          # App shell, native menus, IPC
│   └── preload.ts       # Context bridge for renderer
├── src/                  # Renderer (Web Audio + Canvas UI)
│   ├── core/            # Audio engine, types
│   ├── editor/          # Waveform, spectrogram, cue points
│   ├── mixer/           # Channel strips, routing
│   ├── plugins/         # VST3/AU host, built-in effects
│   ├── ui/              # App controller, metering, file queue
│   └── utils/           # File I/O, undo manager
├── native/              # C++ native addon (optional)
│   └── src/             # VST3/AU hosting, Core Audio devices
└── resources/           # App icon, entitlements
```

### Technology Stack

- **Electron** - Desktop app framework for macOS
- **TypeScript** - Type-safe codebase
- **Vite** - Fast build tooling
- **Web Audio API** - Audio playback, routing, and built-in effects
- **Canvas 2D** - Waveform and spectrum visualization
- **N-API (C++)** - Native VST3/AudioUnit plugin hosting
- **Core Audio** - macOS audio device enumeration

## Getting Started

### Prerequisites

- Node.js 18+
- npm or yarn
- macOS (for full VST/AU and Core Audio support)

### Installation

```bash
npm install
```

### Development

```bash
# Start Vite dev server + Electron
npm run electron:dev

# Or just the web UI (browser mode)
npm run dev
```

### Building

```bash
# Build the app
npm run electron:build

# Build native addon (optional, for VST3/AU support)
chmod +x scripts/build-native.sh
./scripts/build-native.sh

# With VST3 SDK
VST3_SDK_PATH=/path/to/vst3sdk ./scripts/build-native.sh
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

| Layout | Channels | Use Case |
|--------|----------|----------|
| Stereo | L, R | Standard stereo recording |
| Quad | FL, FR, RL, RR | Ambisonic/spatial recording |
| 5.1 | L, R, C, LFE, Ls, Rs | Surround field recording |

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
| Cmd+Shift+N | Normalize |
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
