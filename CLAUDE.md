# CLAUDE.md — FieldCorder DAW

## 项目概述

FieldCorder 是一个轻量级 DAW（数字音频工作站），专为多通道环境录音编辑设计。

## 技术栈

- **前端**: TypeScript + Vite + Web Audio API
- **桌面**: Electron
- **音频**: Web Audio API (内置效果器)
- **构建**: Vite + TypeScript

## 项目结构

```
src/
├── core/          # 音频引擎、类型定义
│   ├── AudioEngine.ts
│   ├── types.ts
│   └── ucs-data.ts
├── editor/        # 波形编辑器
│   ├── AudioEditor.ts
│   ├── WaveformRenderer.ts
│   ├── SpectrogramRenderer.ts
│   └── CuePointManager.ts
├── mixer/         # 混音台
│   └── Mixer.ts
├── plugins/       # 效果器
│   └── PluginHost.ts
├── ui/            # UI 组件
│   ├── App.ts
│   ├── Metering.ts
│   ├── MetadataManager.ts
│   ├── ProjectManager.ts
│   └── FileQueue.ts
├── utils/         # 工具
│   ├── FileHandler.ts
│   └── UndoManager.ts
├── styles/        # CSS
└── main.ts        # 入口
electron/
├── main.ts        # Electron 主进程
└── preload.ts     # preload 脚本
```

## 开发命令

```bash
npm run dev            # Vite 开发服务器
npm run electron:dev   # Electron + Vite 开发模式
npm run build          # 生产构建
```

## 规范

- TypeScript strict mode
- 不使用 VST/AU 原生插件（Web Audio API 内置效果器）
- 深色主题
- 面向专业声音编辑师

## Agent 团队

| 角色 | 职责 |
|------|------|
| main (Team Lead) | 协调、分配、追踪 |
| generator | 核心开发（Electron、AudioEngine、文件处理）|
| template | 前端开发（编辑器 UI、波形、混音台）|
| designer | UI/UX 设计 |
| tester | 测试、Bug 报告 |
| researcher | 技术调研 |
| docs | 文档 |
| code-reviewer | 代码审查 |
