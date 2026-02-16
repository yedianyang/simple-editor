# CLAUDE.md — FieldCorder DAW

## 项目概述

FieldCorder 是一个轻量级 DAW（数字音频工作站），专为多通道环境录音编辑设计。
目标平台为 macOS，计划上架 Mac App Store。

## 技术栈

- **前端**: TypeScript + Vite + Web Audio API
- **桌面**: Tauri 2.x (Rust 后端)
- **音频**: Web Audio API (内置效果器) + Rust WAV 解析器
- **构建**: Vite + Cargo (Tauri CLI)
- **原 Electron 版**: 已备份至 `electron-backup/`

## 项目结构

```
src/                    # 前端 (TypeScript)
├── core/               # 音频引擎、类型定义
│   ├── AudioEngine.ts  # Web Audio API 引擎 + loadFromParsedData()
│   ├── types.ts        # 全局类型（Window.appAPI 等）
│   └── ucs-data.ts     # UCS 命名数据
├── editor/             # 波形编辑器
│   ├── AudioEditor.ts  # 音频编辑操作
│   ├── WaveformRenderer.ts  # 波形渲染（异步 Peak Cache）
│   ├── SpectrogramRenderer.ts  # 频谱图（Radix-2 FFT）
│   ├── CuePointManager.ts
│   └── CuePointRenderer.ts
├── mixer/              # 混音台
│   └── Mixer.ts
├── plugins/            # 效果器
│   └── PluginHost.ts   # 插件管理（appAPI 接口）
├── ui/                 # UI 组件
│   ├── App.ts          # 主控制器
│   ├── Metering.ts     # 电平表（异步 LUFS 计算）
│   ├── MetadataManager.ts
│   ├── ProjectManager.ts
│   └── FileQueue.ts
├── utils/              # 工具
│   ├── FileHandler.ts  # 文件导入（Rust WAV 解析路径）
│   ├── TauriAPI.ts     # Tauri API 适配层（替代 electronAPI）
│   └── UndoManager.ts
├── styles/             # CSS
└── main.ts             # 入口（初始化 appAPI）

src-tauri/              # Rust 后端 (Tauri 2.x)
├── src/lib.rs          # 命令：文件 I/O、WAV 解析、菜单系统
├── Cargo.toml          # Rust 依赖
├── tauri.conf.json     # 窗口配置、构建设置
└── capabilities/       # 权限配置

electron-backup/        # Electron 旧代码备份
├── main.ts
└── preload.ts

docs/research/          # 技术调研报告
├── vst-au-plugin-loading.md
├── mac-app-store-distribution.md
└── tauri-vs-electron-memory.md
```

## 架构要点

### Rust 后端 (src-tauri/src/lib.rs)
- **文件 I/O 命令**: `read_file_bytes`, `read_file_text`, `write_file`, `file_info`
- **对话框**: `open_file_dialog`, `save_file_dialog`
- **WAV 解析**: `read_large_audio_file` — Rust 侧解析 RIFF/WAV，返回 Float32 PCM（支持 16/24/32bit PCM + 32bit float）
- **大文件协议**: `localfile://` 自定义协议，用于非 WAV 文件的流式加载
- **菜单系统**: 完整 macOS 原生菜单（File/Edit/Transport/View/Window/Help），事件通过 `menu:{action}` 传递到前端

### 前端 API 适配 (src/utils/TauriAPI.ts)
- `createTauriAPI()` 工厂函数返回 `AppAPI` 接口
- 所有 `window.electronAPI` 已替换为 `window.appAPI`
- WAV 文件走 Rust 解析路径，非 WAV 走 `localfile://` + `decodeAudioData`

### 性能优化
- **异步 Peak Cache**: 256 samples/block，每 1000 块 yield 一次避免阻塞
- **Radix-2 FFT**: O(N log N) 替代 O(N²) 朴素 DFT
- **异步 Metering**: LUFS/Stats 分块计算（每 200K samples yield）
- **Rust WAV 解析**: 绕过 decodeAudioData，避免 OOM（大文件安全）

## 开发命令

```bash
npm run dev            # Vite 开发服务器（仅前端）
npm run tauri:dev      # Tauri + Vite 开发模式（完整应用）
npm run tauri:build    # Tauri 生产构建（DMG）
npm run build:frontend # 仅构建前端
```

## 规范

- TypeScript strict mode
- 深色主题，遵循 macOS HIG
- 面向专业声音编辑师
- 多通道支持（1-6 通道）
- 计划双版本策略：MAS Lite (无原生插件) + DMG Pro (AU/VST 插件)

## Agent 团队

| 角色 | 模型 | 职责 |
|------|------|------|
| main (Team Lead) | Opus 4.6 | 协调、分配、追踪 |
| generator | Opus 4.6 | 核心开发（Tauri Rust、AudioEngine、文件处理）|
| template | Opus 4.6 | 前端开发（编辑器 UI、波形、混音台）|
| designer | Opus 4.6 | UI/UX 设计 |
| tester | Sonnet 4.5 | 测试、Bug 报告 |
| researcher | Sonnet 4.5 | 技术调研 |
| docs | Sonnet 4.5 | 文档 |
| code-reviewer | Sonnet 4.5 | 代码审查 |
