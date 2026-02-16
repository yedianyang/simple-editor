# FieldCorder DAW — Audio Signal Flow & Architecture

## 概览

从音频文件到硬件输出的完整信号流路径，以及每个阶段对应的软件技术栈和开发架构。

---

## 信号流全景图

```
信号流 (左)                                          技术架构 (右)
═══════════════════════════════════════════════════════════════════════════════

┌──────────────┐                                    ┌─────────────────────────┐
│  音频文件     │                                    │ 文件层                   │
│  WAV/MP3/... │                                    │ 技术: 磁盘 I/O           │
│  (磁盘)      │                                    │ 格式: RIFF/WAV, MPEG...  │
└──────┬───────┘                                    └─────────────────────────┘
       │
       ▼
┌──────────────────────────────────┐                ┌─────────────────────────┐
│  文件读取 & 解码                  │                │ 后端层 (Rust / Tauri)    │
│                                  │                │                         │
│  WAV → Rust WAV Parser           │                │ 运行环境: Tauri 2.x      │
│        read_large_audio_file     │                │ 语言: Rust               │
│        RIFF→fmt→data→f32         │                │ 源码: src-tauri/src/lib.rs│
│                                  │                │ IPC: Tauri invoke (JSON) │
│  非WAV → localfile:// 协议       │                │ 协议: localfile:// 自定义 │
│          → decodeAudioData       │                │ 解码: WKWebView 内置     │
└──────────────┬───────────────────┘                └─────────────────────────┘
               │
               ▼
┌──────────────────────────────────┐                ┌─────────────────────────┐
│  AudioBuffer                     │                │ 前端适配层               │
│  (Web Audio 内存缓冲)             │                │                         │
│  N 通道 x M 采样点, Float32      │                │ 入口: TauriAPI.ts        │
│                                  │                │ 路由: FileHandler.ts     │
│  WAV:  loadFromParsedData()      │                │ 加载: AudioEngine.ts     │
│  其他: loadAudio() / parseWAV()  │                │ 接口: window.appAPI      │
└──────────────┬───────────────────┘                └─────────────────────────┘
               │
               ▼
┌──────────────────────────────────┐                ┌─────────────────────────┐
│  AudioBufferSourceNode           │                │ Web Audio API            │
│  .buffer = audioBuffer           │                │                         │
│  .start(0, offset)               │                │ 标准: W3C Web Audio      │
│                                  │                │ 实现: WebKit (WKWebView) │
│  单次使用，每次播放新建实例         │                │ 控制: AudioEngine.ts     │
└──────────────┬───────────────────┘                │ 方法: play() / stop()   │
               │                                    └─────────────────────────┘
    ┌──────────┴──────────┐
    │ 多通道 (>1ch)        │ ≤2ch
    ▼                     ▼
┌──────────────────────────────────┐                ┌─────────────────────────┐
│  ChannelSplitter (N ch)          │                │ 通道路由层               │
│  拆分为 N 条独立通道              │                │                         │
│                                  │                │ 节点: Web Audio API      │
│  ┌─ ch0 ──────────────────────┐  │                │ 控制: AudioEngine.ts     │
│  │  GainNode (fader)          │  │                │   setupChannelRouting()  │
│  │  ↓                         │  │                │   getDownmixOutput()     │
│  │  InsertIn ─[插件链]─ InsertOut│ │                │                         │
│  │  ↓                         │  │                │ UI:  Mixer.ts            │
│  │  AnalyserNode (FFT 1024)   │  │                │   fader/mute/solo 控制   │
│  └────────────────────────────┘  │                │   电平表读取             │
│  ┌─ ch1 ──── (同上) ──────────┐  │                │                         │
│  └────────────────────────────┘  │                │ 插件: PluginHost.ts      │
│  ...                             │                │   getChannelInsertPoint()│
│                                  │                │   (未来 AU/VST 接入)     │
│  Downmix → Stereo                │                │                         │
│  ChannelMerger (2ch out)         │                │ 规则: L/R 分配算法       │
└──────────────┬───────────────────┘                └─────────────────────────┘
               │
               ▼
┌──────────────────────────────────┐                ┌─────────────────────────┐
│  Master GainNode                 │                │ 主输出控制层             │
│  ↓                               │                │                         │
│  Master AnalyserNode (FFT 2048)  │                │ 音量: AudioEngine.ts     │
│  ↓                               │                │   setMasterVolume()      │
│  audioContext.destination         │                │                         │
│                                  │                │ 分析: Metering.ts        │
│                                  │                │   LUFS / Peak / RMS      │
│                                  │                │   SpectrogramRenderer.ts │
│                                  │                │   Radix-2 FFT O(NlogN)  │
└──────────────┬───────────────────┘                └─────────────────────────┘
               │
               ▼
┌──────────────────────────────────┐                ┌─────────────────────────┐
│  WKWebView Audio Output          │                │ Tauri 容器层             │
│  (Tauri WebView 进程)            │                │                         │
│                                  │                │ 引擎: macOS WKWebView    │
│                                  │                │ 配置: tauri.conf.json    │
│                                  │                │ 窗口: 1400x900           │
│                                  │                │ 进程: 独立 WebView 进程   │
└──────────────┬───────────────────┘                └─────────────────────────┘
               │
               ▼
┌──────────────────────────────────┐                ┌─────────────────────────┐
│  macOS CoreAudio                 │                │ 操作系统层               │
│  Audio Server (HAL)              │                │                         │
│                                  │                │ API: CoreAudio HAL       │
│                                  │                │ 混音: coreaudiod 守护进程 │
│                                  │                │ 延迟: ~10ms (默认)       │
│                                  │                │ 采样率: 跟随设备设置      │
└──────────────┬───────────────────┘                └─────────────────────────┘
               │
               ▼
┌──────────────────────────────────┐                ┌─────────────────────────┐
│  硬件 DAC                        │                │ 硬件层                   │
│  扬声器 / 耳机 / 音频接口         │                │                         │
│                                  │                │ 内置: MacBook 扬声器      │
│                                  │                │ 外接: USB/TB 音频接口     │
│                                  │                │ 格式: 立体声 (downmixed) │
└──────────────────────────────────┘                └─────────────────────────┘
```

---

## 每层详细说明

### Layer 1: 文件读取与解码 (Rust 后端)

| 项目 | 说明 |
|------|------|
| **技术** | Tauri 2.x Rust 后端 |
| **源码** | `src-tauri/src/lib.rs` |
| **WAV 路径** | `read_large_audio_file` Tauri command → RIFF 解析 → PCM to f32 → IPC 返回前端 |
| **非 WAV 路径** | `localfile://` 自定义协议 → 流式传输字节 → 前端 `decodeAudioData` |
| **支持格式** | PCM 16/24/32bit, IEEE Float 32bit |
| **内存策略** | Rust 侧解析避免 WebView 进程 OOM；非 WAV 大文件仍有风险 |
| **未来规划** | Rust 侧增加 FLAC/MP3/OGG 解码 (symphonia crate) |

### Layer 2: 前端适配 (TypeScript)

| 项目 | 说明 |
|------|------|
| **技术** | TypeScript + @tauri-apps/api |
| **适配层** | `TauriAPI.ts` — 统一 `AppAPI` 接口，挂载到 `window.appAPI` |
| **路由** | `FileHandler.ts` — WAV 走 Rust 解析，非 WAV 走 localfile:// + decodeAudioData |
| **加载** | `AudioEngine.loadFromParsedData()` — 直接 `createBuffer` + `copyToChannel` |
| **兼容** | 所有 `window.electronAPI` 已替换为 `window.appAPI` |

### Layer 3: Web Audio 节点图 (AudioEngine)

| 项目 | 说明 |
|------|------|
| **技术** | W3C Web Audio API (WebKit 实现) |
| **源码** | `src/core/AudioEngine.ts` |
| **播放** | `AudioBufferSourceNode` — 一次性节点，每次 play 新建 |
| **通道路由** | `ChannelSplitter` → per-channel chain → `ChannelMerger` |
| **每通道链** | `GainNode → InsertIn → [Plugins] → InsertOut → AnalyserNode` |
| **插件槽** | `InsertIn → InsertOut` 直连，未来断开插入 AU/VST 节点 |
| **Downmix** | 多通道 → 立体声，规则见下表 |
| **主输出** | `MasterGain → MasterAnalyser → audioContext.destination` |

### Layer 4: 混音台 UI (Mixer)

| 项目 | 说明 |
|------|------|
| **源码** | `src/mixer/Mixer.ts` |
| **功能** | 每通道 fader (音量)、mute、solo 控制 |
| **电平表** | 从 per-channel `AnalyserNode` 读取实时数据 |
| **插件管理** | `PluginHost.ts` 管理插件扫描/加载/参数 |
| **未来规划** | AU/VST 插件通过 Rust FFI 加载，音频处理在 Rust 侧或 Web Audio AudioWorklet |

### Layer 5: 分析与显示

| 项目 | 说明 |
|------|------|
| **电平表** | `Metering.ts` — 异步 LUFS/Peak/RMS 计算，分块 200K samples yield |
| **频谱图** | `SpectrogramRenderer.ts` — Radix-2 Cooley-Tukey FFT, O(N log N) |
| **波形** | `WaveformRenderer.ts` — 异步 Peak Cache (256 samples/block, yield 每 1000 块) |
| **数据源** | 均从 `AnalyserNode` (实时) 或 `AudioBuffer` (离线) 读取 |

### Layer 6: 系统输出

| 项目 | 说明 |
|------|------|
| **容器** | Tauri WKWebView (macOS 原生 WebView) |
| **系统** | macOS CoreAudio HAL (Hardware Abstraction Layer) |
| **混音** | coreaudiod 系统守护进程混合所有应用音频 |
| **输出** | 用户在系统偏好设置中选择的音频设备 |
| **延迟** | 默认约 10ms，取决于 buffer size 和设备 |

---

## Downmix 规则

| 源格式 | 左声道 (L) | 右声道 (R) |
|--------|-----------|-----------|
| Mono   | ch0       | —         |
| Stereo | ch0       | ch1       |
| Quad   | ch0 (FL) + ch2 (RL) | ch1 (FR) + ch3 (RR) |
| 5.1    | ch0 (L) + ch2 (C) + ch4 (Ls) | ch1 (R) + ch3 (LFE) + ch5 (Rs) |

---

## 一句话信号链

```
磁盘 → Rust WAV Parser → IPC → AudioBuffer → SourceNode → Splitter
→ [Gain → Insert → Analyser] x N → Merger → MasterGain → MasterAnalyser
→ destination → WKWebView → CoreAudio HAL → DAC → 扬声器
```

---

## 源码文件索引

| 信号流阶段 | 文件 | 职责 |
|-----------|------|------|
| 文件读取 | `src-tauri/src/lib.rs` | Rust WAV 解析, 文件 I/O, localfile:// 协议 |
| 前端适配 | `src/utils/TauriAPI.ts` | Tauri invoke/dialog/event 封装 |
| 文件路由 | `src/utils/FileHandler.ts` | WAV vs 非WAV 导入路径选择 |
| 音频引擎 | `src/core/AudioEngine.ts` | Web Audio 节点图、播放控制、通道路由 |
| 混音台 | `src/mixer/Mixer.ts` | 通道 fader/mute/solo + 电平表 UI |
| 插件系统 | `src/plugins/PluginHost.ts` | 插件管理 (未来 AU/VST) |
| 电平分析 | `src/ui/Metering.ts` | LUFS/Peak/RMS 异步计算 |
| 频谱分析 | `src/editor/SpectrogramRenderer.ts` | Radix-2 FFT 频谱渲染 |
| 波形显示 | `src/editor/WaveformRenderer.ts` | 异步 Peak Cache 波形渲染 |
| 主控制器 | `src/ui/App.ts` | 统筹所有模块、事件、UI 交互 |
| 类型定义 | `src/core/types.ts` | Window.appAPI, ChannelLayout, ParsedAudioData |

---

## 未来架构演进

```
当前:   Rust (文件I/O + WAV解析) → IPC → Web Audio API (全部音频处理)
                                         ↑ 瓶颈: WKWebView 内存限制

未来:   Rust (文件I/O + 全格式解码 + AU/VST 插件 + 混音引擎)
          → IPC (仅传输渲染数据 + 控制指令)
          → Web Audio API (仅播放最终立体声输出)

规划:
  - symphonia crate: Rust 侧 FLAC/MP3/OGG 解码
  - rack/vst-rs crate: Rust 侧 AU/VST 插件加载
  - cpal crate: 可选，绕过 Web Audio 直接输出到 CoreAudio
  - AudioWorklet: 可选，WebView 侧低延迟自定义 DSP
```

---

*最后更新: 2026-02-16*
